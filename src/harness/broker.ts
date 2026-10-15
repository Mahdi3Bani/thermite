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
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../common/env.ts";
import {
  expectedNodeGroups,
  type GpuLayout,
  LAYOUT_FILE,
  type LayoutRecord,
  nodeGroups,
  planDedicated,
  procBusDir,
  runCpus,
} from "./broker/devices.ts";
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
 *   the device; with a dedicated development card (THERMITE_DEV_GPU_INDEX), gives each card
 *   and the shared nodes their own groups instead (broker/devices.ts);
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
const WIPE_MARKER = "WIPE_REQUESTED";
const NOT_BEFORE_FILE = "NOT_BEFORE";
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
  prepareOutbox();
}

/** The broker's socket directory, and a clean socket path to listen on (at broker start only). */
function prepareSocket(): void {
  mkdirSync(socketDir, { recursive: true });
  chownSync(socketDir, 0, TG);
  chmodSync(socketDir, 0o750);
  rmSync(socketPath, { force: true });
}

/**
 * Exports: written by thermite, readable by the supervisor's group only (setgid keeps the group
 * on new files and directories). Re-asserted every minute too: a container engine may hand a
 * shared, still-empty volume to the user of whichever container mounted it first.
 */
function prepareOutbox(): void {
  tryDo("prepare the outbox", () => {
    const st = statSync(outboxDir);
    if (st.uid !== TU || st.gid !== outboxGid) chownSync(outboxDir, TU, outboxGid);
    if ((st.mode & 0o7777) !== 0o2750) chmodSync(outboxDir, 0o2750);
  });
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

function deviceNodes(): string[] {
  if (!existsSync("/dev")) return [];
  return readdirSync("/dev")
    .filter((name) => name.startsWith("nvidia"))
    .map((name) => join("/dev", name))
    .filter((p) => !lstatSync(p).isDirectory());
}

/**
 * Puts every device node back to root, its expected group and 0660 if anything changed it. The
 * NVIDIA driver resets a node it opens for root (nvidia-uvm to 0666, for example), so any CUDA
 * process run as root in this container would otherwise open it to every role.
 */
function assertDevices(layout: GpuLayout | undefined): void {
  for (const { node, gid } of expectedNodeGroups(deviceNodes(), layout)) {
    tryDo(`keep the group of ${node}`, () => {
      const st = statSync(node);
      if (st.uid === 0 && st.gid === gid && (st.mode & 0o777) === 0o660) return;
      chownSync(node, 0, gid);
      chmodSync(node, 0o660);
      log("broker", "a device node had changed; restored it", {
        node,
        was: `${st.uid}:${st.gid} ${(st.mode & 0o777).toString(8)}`,
        now: `0:${gid} 660`,
      });
    });
  }
}

/**
 * The CPUs timed runs are pinned to. THERMITE_RUN_CPUS is "auto" (the default on a GPU rig: the
 * judge's card's local CPUs this container may use), "off", or an explicit CPU list.
 */
function chooseRunCpus(layout: GpuLayout | undefined): string | undefined {
  const want = env.THERMITE_RUN_CPUS ?? (env.THERMITE_TARGET === "cuda-gpu" ? "auto" : "off");
  if (want === "off") return undefined;
  if (want !== "auto") return want;
  try {
    const bus =
      layout?.judge.bus ??
      execFileSync(
        "nvidia-smi",
        ["--query-gpu=pci.bus_id", "--format=csv,noheader", "-i", env.THERMITE_GPU_INDEX ?? "0"],
        { encoding: "utf8" },
      ).trim();
    const local = readFileSync(`/sys/bus/pci/devices/${procBusDir(bus)}/local_cpulist`, "utf8");
    const allowed = /^Cpus_allowed_list:\s*(\S+)$/m.exec(
      readFileSync("/proc/self/status", "utf8"),
    )?.[1];
    const cpus = allowed ? runCpus(local, allowed) : "";
    if (!cpus) {
      log("broker", "timed runs are not pinned: the card's local CPUs are not in this container", {
        local: local.trim(),
        allowed,
      });
      return undefined;
    }
    log("broker", "timed runs pinned to the judge card's local CPUs", { bus, cpus });
    return cpus;
  } catch (err) {
    log("broker", "timed runs are not pinned", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function prepareDevices(): GpuLayout | undefined {
  const nodes = deviceNodes();
  for (const p of nodes) {
    tryDo(`set the gpu group on ${p}`, () => {
      chownSync(p, 0, IDS.gpuGroup);
      chmodSync(p, 0o660);
    });
  }
  const layoutPath = join(socketDir, LAYOUT_FILE);
  rmSync(layoutPath, { force: true });
  if (env.THERMITE_DEV_GPU_INDEX === undefined) return undefined;
  // A dedicated development card. Anything that fails leaves the record saying why, and the
  // controller then neither times nor allows development runs (it does not fall back to
  // sharing, since both cards are visible).
  let record: LayoutRecord;
  let layout: GpuLayout | undefined;
  try {
    layout = planDedicated({
      smiCsv: execFileSync(
        "nvidia-smi",
        ["--query-gpu=index,uuid,pci.bus_id", "--format=csv,noheader"],
        { encoding: "utf8" },
      ),
      information: (bus, index) => {
        try {
          return readFileSync(`/proc/driver/nvidia/gpus/${bus}/information`, "utf8");
        } catch {
          return execFileSync("nvidia-smi", ["-q", "-i", String(index)], { encoding: "utf8" });
        }
      },
      nodes,
      judgeIndex: Number(env.THERMITE_GPU_INDEX ?? "0"),
      devIndex: Number(env.THERMITE_DEV_GPU_INDEX),
    });
    for (const { node, gid } of nodeGroups(layout)) {
      chownSync(node, 0, gid);
      chmodSync(node, 0o660);
      const st = statSync(node);
      if (st.gid !== gid || (st.mode & 0o777) !== 0o660) {
        throw new Error(`${node} kept group ${st.gid}, mode ${(st.mode & 0o777).toString(8)}`);
      }
    }
    record = { ok: true, ...layout };
    log("broker", "dedicated development card", {
      judge: layout.judge.node,
      dev: layout.dev.node,
      control: layout.control,
    });
  } catch (err) {
    layout = undefined;
    const error = err instanceof Error ? err.message : String(err);
    record = { ok: false, mode: "dedicated", error };
    log("broker", "could not set up the dedicated development card", { error });
  }
  writeFileSync(layoutPath, `${JSON.stringify(record)}\n`, { mode: 0o644 });
  chmodSync(layoutPath, 0o644);
  return layout;
}

function killRoles(): number {
  let n = 0;
  for (const role of ALL_ROLES) n += killScope({ uid: roleIds(role).uid });
  return n;
}

let child: ChildProcess | undefined;
let stopping = false;
let restarts = 0;

/**
 * A full reset's wipe, requested by the controller (a marker in the state directory): done here,
 * as root, before the controller starts, so files other users own or locked build trees cannot
 * stop it. The rig's identity key stays; the wipe time is left for the new ledger, which then
 * refuses commands issued before it (they belonged to the wiped ledger).
 */
function wipeIfMarked(): boolean {
  const marker = join(stateDir, WIPE_MARKER);
  if (!existsSync(marker)) return false;
  const keep = new Set([
    "rig-signing.key",
    "rig-signing.key.pub",
    "unit-signing.key",
    "unit-signing.key.pub",
  ]);
  const rm = (p: string) =>
    execFileSync("rm", ["-rf", "--one-file-system", "--", p], { stdio: "ignore" });
  for (const name of readdirSync(stateDir)) {
    if (name === WIPE_MARKER) continue;
    if (name === "ledger") {
      for (const f of readdirSync(join(stateDir, name)))
        if (!keep.has(f)) rm(join(stateDir, name, f));
      continue;
    }
    rm(join(stateDir, name));
  }
  for (const dir of [scratchDir, outboxDir]) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) rm(join(dir, name));
  }
  mkdirSync(join(stateDir, "ledger"), { recursive: true });
  // The wipe command's issue time (control's clock), recorded in the marker by the controller.
  let notBefore = new Date().toISOString();
  try {
    const at = (JSON.parse(readFileSync(marker, "utf8")) as { not_before?: string }).not_before;
    if (at && Number.isFinite(Date.parse(at))) notBefore = at;
  } catch {
    // an unreadable marker: now
  }
  writeFileSync(join(stateDir, "ledger", NOT_BEFORE_FILE), notBefore);
  chownSync(join(stateDir, "ledger", NOT_BEFORE_FILE), TU, TG);
  rmSync(marker, { force: true });
  log("broker", "wiped the rig's state (full reset)");
  return true;
}

function startController(extraEnv: Record<string, string>): void {
  if (isRoot) {
    try {
      // Directories are prepared again only after a wipe (never the socket: it is in use).
      if (wipeIfMarked()) prepareDirectories();
    } catch (err) {
      log("broker", "wipe failed; will retry at the next start", { error: String(err) });
    }
  }
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
  prepareSocket();
  setInterval(prepareOutbox, 60_000).unref();
  const secrets = readSecrets();
  const gpuLayout = prepareDevices();
  const pinnedCpus = chooseRunCpus(gpuLayout);
  setInterval(() => assertDevices(gpuLayout), 60_000).unref();
  const killed = killRoles();
  if (killed) log("broker", "killed leftover role processes at start", { killed });
  const server = startBrokerServer({
    socketPath,
    scratchDir,
    baseEnv: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    gpuLayout,
    assertDevices: () => assertDevices(gpuLayout),
    runCpus: pinnedCpus,
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
