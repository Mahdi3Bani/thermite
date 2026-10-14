import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../common/env.ts";
import { killScope } from "./broker/process.ts";
import { IDS, roleIds } from "./broker/runner.ts";
import { ALL_ROLES, startBrokerServer } from "./broker/server.ts";

/**
 * The harness broker: the container's long-running root process (under tini as PID 1). It
 *
 * - prepares the state, scratch and outbox directories for the `thermite` user;
 * - reads the harness's secret files and passes their values only to the controller, then
 *   closes the secrets directory to every other user;
 * - gives the device nodes to the `gpu` group (mode 0660), so only roles in that group reach
 *   the device;
 * - serves the broker socket, through which the controller runs work as separate users;
 * - runs the controller as `thermite` and restarts it if it exits, after killing anything a
 *   role left running.
 *
 * Run as a non-root user (local development), it only starts the controller.
 */

const controller = fileURLToPath(new URL("./main.js", import.meta.url));
const env = process.env;
const stateDir = env.THERMITE_STATE_DIR ?? "/var/lib/thermite";
const scratchDir = env.THERMITE_SCRATCH_DIR ?? "/scratch";
const outboxDir = env.THERMITE_OUTBOX_DIR ?? "/outbox";
const socketDir = env.THERMITE_BROKER_DIR ?? "/run/thermite";
const socketPath = join(socketDir, "broker.sock");
const isRoot = process.getuid?.() === 0;
const { uid: TU, gid: TG } = IDS.thermite;

/** Secret files whose values the controller needs. The *_FILE variables never reach it. */
const SECRET_VARS: Record<string, string> = {
  THERMITE_SUPERVISOR_TOKEN_FILE: "THERMITE_SUPERVISOR_TOKEN",
  THERMITE_PROPOSER_TOKEN_FILE: "THERMITE_PROPOSER_TOKEN",
  QWEN_API_KEY_FILE: "QWEN_API_KEY",
};

function tryDo(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log("broker", `could not ${what}`, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The supervisor's group: it reads exports from the shared outbox; roles may not. */
const outboxGid = Number(env.THERMITE_OUTBOX_GID ?? "10001");

function prepareDirectories(): void {
  for (const d of [stateDir, scratchDir, outboxDir, socketDir]) mkdirSync(d, { recursive: true });
  // State: owned by thermite; others may only traverse to the build store and models.
  if (statSync(stateDir).uid !== TU) {
    log("broker", "taking ownership of the state volume for thermite");
    tryDo("chown the state volume", () =>
      execFileSync("chown", ["-R", "-P", `${TU}:${TG}`, stateDir], { stdio: "ignore" }),
    );
  }
  chmodSync(stateDir, 0o711);
  // Scratch is disposable: whatever an earlier run left (including hostile trees) goes now.
  chownSync(scratchDir, 0, 0);
  chmodSync(scratchDir, 0o755);
  for (const name of readdirSync(scratchDir)) {
    tryDo(`clear scratch ${name}`, () =>
      execFileSync("rm", ["-rf", "--one-file-system", join(scratchDir, name)], { stdio: "ignore" }),
    );
  }
  const ctl = join(scratchDir, "thermite");
  mkdirSync(join(ctl, "tmp"), { recursive: true });
  execFileSync("chown", ["-R", "-P", `${TU}:${TG}`, ctl], { stdio: "ignore" });
  chmodSync(ctl, 0o711);
  chmodSync(join(ctl, "tmp"), 0o700);
  // Shared temporary places are closed to every role (each gets a TMPDIR of its own); the
  // controller and the judge's kit scripts may still use them (sticky, group thermite).
  for (const d of ["/tmp", "/var/tmp", "/dev/shm"]) {
    if (!existsSync(d)) continue;
    tryDo(`close ${d}`, () => {
      chownSync(d, 0, TG);
      chmodSync(d, 0o1770);
    });
  }
  // Exports: written by thermite, readable by the supervisor's group only (setgid keeps the
  // group on new files and directories).
  tryDo("prepare the outbox", () => {
    chownSync(outboxDir, TU, outboxGid);
    chmodSync(outboxDir, 0o2750);
  });
  chownSync(socketDir, 0, TG);
  chmodSync(socketDir, 0o750);
  rmSync(socketPath, { force: true });
}

function readSecrets(): Record<string, string> {
  const values: Record<string, string> = {};
  const dirs = new Set<string>();
  for (const [fileVar, valueVar] of Object.entries(SECRET_VARS)) {
    const path = env[fileVar];
    if (!path || !existsSync(path)) continue;
    values[valueVar] = readFileSync(path, "utf8").trim();
    dirs.add(dirname(path));
  }
  // Nobody but root may open the secret files from here on, whatever their own modes are.
  for (const d of dirs) tryDo(`close ${d}`, () => chmodSync(d, 0o700));
  // Fail closed: a secret another user could still read is a reason not to start.
  for (const fileVar of Object.keys(SECRET_VARS)) {
    const path = env[fileVar];
    if (!path || !existsSync(path)) continue;
    const dirOpen = (statSync(dirname(path)).mode & 0o055) !== 0;
    const fileOpen = (statSync(path).mode & 0o044) !== 0;
    if (dirOpen && fileOpen) {
      log("broker", "fatal: a secret file stays readable by other users", { file: fileVar });
      process.exit(1);
    }
  }
  return values;
}

function prepareDevices(): void {
  if (!existsSync("/dev")) return;
  for (const name of readdirSync("/dev")) {
    if (!name.startsWith("nvidia")) continue;
    const p = join("/dev", name);
    if (lstatSync(p).isDirectory()) continue;
    tryDo(`set the gpu group on ${p}`, () => {
      chownSync(p, 0, IDS.gpuGroup);
      chmodSync(p, 0o660);
    });
  }
}

function killRoles(): number {
  let n = 0;
  for (const role of ALL_ROLES) n += killScope({ uid: roleIds(role).uid });
  return n;
}

let child: ChildProcess | undefined;
let stopping = false;
let restarts = 0;

function startController(extraEnv: Record<string, string>): void {
  const startedAt = Date.now();
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !(k in SECRET_VARS)) childEnv[k] = v;
  }
  child = spawn(process.execPath, [...process.execArgv, controller], {
    stdio: "inherit",
    env: {
      ...childEnv,
      ...(isRoot ? { TMPDIR: join(scratchDir, "thermite", "tmp") } : {}),
      ...extraEnv,
    },
    ...(isRoot ? { uid: TU, gid: TG } : {}),
    // Its own process group: worker processes it starts join it, so they end with it.
    detached: true,
  });
  child.on("exit", (code, signal) => {
    // Worker processes of a dead controller must not live on (they would keep calling the model
    // and the API while new trials run): kill the controller's whole process group.
    try {
      if (child?.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
    if (stopping) process.exit(code ?? 0);
    if (isRoot) {
      const killed = killRoles();
      if (killed) log("broker", "killed role processes left by the controller", { killed });
    }
    const ranMs = Date.now() - startedAt;
    restarts = ranMs > 60_000 ? 0 : restarts + 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(restarts, 5));
    log("broker", "controller exited; restarting", { code, signal, delay_ms: delay });
    setTimeout(() => startController(extraEnv), delay);
  });
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
    if (child?.exitCode === null) child.kill(sig);
    else process.exit(0);
  });
}

if (isRoot) {
  prepareDirectories();
  const secrets = readSecrets();
  prepareDevices();
  const killed = killRoles();
  if (killed) log("broker", "killed leftover role processes at start", { killed });
  const server = startBrokerServer({
    socketPath,
    scratchDir,
    baseEnv: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  server.on("listening", () => {
    chownSync(socketPath, 0, TG);
    chmodSync(socketPath, 0o660);
    log("broker", "serving", { socket: socketPath, separated: true });
    startController({ ...secrets, THERMITE_BROKER_SOCKET: socketPath });
  });
} else if (env.THERMITE_ALLOW_UNSEPARATED === "1") {
  log("broker", "not root: starting the controller WITHOUT user separation (explicitly allowed)");
  startController({});
} else {
  log("broker", "fatal: not root, so roles cannot be separated", {
    hint: "run the harness container as root (the broker drops to role users), or set THERMITE_ALLOW_UNSEPARATED=1 for development only",
  });
  process.exit(1);
}
