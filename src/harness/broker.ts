import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fchmodSync,
  fchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../common/env.ts";
import {
  effectiveGpuLists,
  expectedNodeGroups,
  formatCpuList,
  type GpuLayout,
  LAYOUT_FILE,
  type LayoutRecord,
  nodeGroups,
  parseCpuList,
  parseIndexList,
  planDedicated,
  procBusDir,
  runCpus,
  runRole,
  savedJudgeGpus,
  shareCpus,
} from "./broker/devices.ts";
import {
  controlKeyPem,
  isRunpodVariable,
  oneContainer,
  restartAfter,
  SUPERVISOR_RECORD,
  type SupervisorPaths,
  type SupervisorRecord,
  supervisorArgv,
  supervisorEnv,
  supervisorGpu,
  supervisorPaths,
} from "./broker/one-container.ts";
import { killScope, SETPRIV } from "./broker/process.ts";
import { IDS, roleIds } from "./broker/runner.ts";
import { ALL_ROLES, startBrokerServer } from "./broker/server.ts";

/**
 * The harness broker: the container's long-running root process (under tini as PID 1). It
 *
 * - prepares the state, scratch and outbox directories for the `thermite` user;
 * - reads the harness's secret files and passes their values only to the controller, then
 *   closes the secrets directory to every other user;
 * - gives the device nodes to the `gpu` group (mode 0660), so only roles in that group reach
 *   the device; with dedicated cards (THERMITE_GPU_INDEX and THERMITE_DEV_GPU_INDEX, each a
 *   card or a list), gives each card and the shared nodes their own groups instead
 *   (broker/devices.ts);
 * - serves the broker socket, through which the controller runs work as separate users;
 * - runs the controller as `thermite` and restarts it if it exits, after killing anything a
 *   role left running;
 * - in the one-container rig image (THERMITE_ONE_CONTAINER=1, broker/one-container.ts), also
 *   prepares the supervisor's places and its token, writes control's key from the launch, and
 *   runs the supervisor as its own user, restarting it if it exits.
 *
 * No process it starts gets RunPod's variables (RUNPOD_*). On SIGTERM or SIGINT it passes the
 * signal on and exits when every part it started has ended.
 *
 * Run as a non-root user (local development), it only starts the controller.
 */

const controller = fileURLToPath(new URL("./main.js", import.meta.url));
const supervisorMain = fileURLToPath(new URL("../supervisor/main.js", import.meta.url));
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
const { uid: SU, gid: SG } = IDS.supervisor;
const withSupervisor = oneContainer(env);

/** Secret files whose values the controller needs. The *_FILE variables never reach it. */
const SECRET_VARS: Record<string, string> = {
  THERMITE_SUPERVISOR_TOKEN_FILE: "THERMITE_SUPERVISOR_TOKEN",
  THERMITE_PROPOSER_TOKEN_FILE: "THERMITE_PROPOSER_TOKEN",
  THERMITE_MODEL_API_KEY_FILE: "THERMITE_MODEL_API_KEY",
  // The old name, still read (see MODEL_SETTINGS).
  QWEN_API_KEY_FILE: "QWEN_API_KEY",
};

function tryDo(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log("broker", `could not ${what}`, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The GPU fence (containers/harness/devfence.c): every role's command runs in a Landlock rule set
 * that leaves out the device nodes the role may not open. Used wherever the kernel has Landlock;
 * where the nodes keep the owner and mode they came with (a user namespace), it is the only fence.
 */
const FENCE = "/usr/local/bin/thermite-devfence";
const fenceAbi = (() => {
  try {
    return Number(execFileSync(FENCE, ["--abi"], { encoding: "utf8" }).trim()) || 0;
  } catch {
    return 0;
  }
})();
/** False when the device nodes kept another owner or mode: then only the fence holds. */
let groupsHold = true;

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
  // Nodes this container can't regroup stay as they are; the fence keeps roles off them.
  if (!groupsHold) return;
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
 * The CPUs timed runs are pinned to, by timing user (run, run-1, ...). THERMITE_RUN_CPUS is
 * "auto" (the default on a GPU rig: each judge card's local CPUs this container may use), "off",
 * or an explicit CPU list. With several judge cards the sets are made disjoint (shareCpus).
 */
function chooseRunCpus(
  layout: GpuLayout | undefined,
  lists: GpuLists,
): Record<string, string> | undefined {
  const want = env.THERMITE_RUN_CPUS ?? (env.THERMITE_TARGET === "cuda-gpu" ? "auto" : "off");
  if (want === "off") return undefined;
  const judges = layout?.judges ?? [];
  const count = Math.max(1, judges.length);
  const byRole = (lists: number[][]) =>
    Object.fromEntries(
      shareCpus(lists)
        .map((cpus, i) => [runRole(i), formatCpuList(cpus)] as const)
        .filter(([, cpus]) => cpus),
    );
  if (want !== "auto") return byRole(Array.from({ length: count }, () => parseCpuList(want)));
  try {
    const buses = judges.length
      ? judges.map((c) => c.bus)
      : [
          execFileSync(
            "nvidia-smi",
            [
              "--query-gpu=pci.bus_id",
              "--format=csv,noheader",
              "-i",
              String(parseIndexList(lists.judge, "THERMITE_GPU_INDEX")[0]),
            ],
            { encoding: "utf8" },
          ).trim(),
        ];
    const allowed = /^Cpus_allowed_list:\s*(\S+)$/m.exec(
      readFileSync("/proc/self/status", "utf8"),
    )?.[1];
    const perCard = buses.map((bus) => {
      const local = readFileSync(`/sys/bus/pci/devices/${procBusDir(bus)}/local_cpulist`, "utf8");
      return allowed ? parseCpuList(runCpus(local, allowed)) : [];
    });
    const pinned = byRole(perCard);
    if (!Object.keys(pinned).length) {
      log("broker", "timed runs are not pinned: the cards' local CPUs are not in this container", {
        allowed,
      });
      return undefined;
    }
    log("broker", "timed runs pinned to their judge card's local CPUs", { buses, pinned });
    return pinned;
  } catch (err) {
    log("broker", "timed runs are not pinned", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** The judge's and the agents' cards this start uses (explicit lists, or the rig's GPU set split). */
type GpuLists = ReturnType<typeof effectiveGpuLists>;
const currentLists = (): GpuLists => effectiveGpuLists(env, savedJudgeGpus(stateDir));

function prepareDevices(lists: GpuLists): GpuLayout | undefined {
  const nodes = deviceNodes();
  for (const p of nodes) {
    tryDo(`set the gpu group on ${p}`, () => {
      chownSync(p, 0, IDS.gpuGroup);
      chmodSync(p, 0o660);
    });
  }
  const layoutPath = join(socketDir, LAYOUT_FILE);
  rmSync(layoutPath, { force: true });
  if (lists.dev === undefined) {
    // Shared mode: every node must now belong to root and the gpu group with mode 0660. If one
    // does not, the record says so and the controller neither times nor runs dev runs, rather
    // than leave the device open to roles that must not reach it.
    const wrong = nodes.filter((p) => {
      try {
        const st = statSync(p);
        return st.uid !== 0 || st.gid !== IDS.gpuGroup || (st.mode & 0o777) !== 0o660;
      } catch {
        return true;
      }
    });
    groupsHold = wrong.length === 0;
    const shared: LayoutRecord = !wrong.length
      ? { ok: true, mode: "shared", nodes, fence: fenceAbi ? "groups+landlock" : "groups" }
      : fenceAbi
        ? { ok: true, mode: "shared", nodes, fence: "landlock" }
        : { ok: false, mode: "shared", error: `${wrong.join(", ")} kept another owner or mode` };
    if (wrong.length)
      log(
        "broker",
        fenceAbi
          ? "the GPU's device nodes kept their owner and mode: only the Landlock fence keeps roles off them"
          : "could not restrict the GPU's device nodes",
        { nodes: wrong, landlock_abi: fenceAbi },
      );
    writeFileSync(layoutPath, `${JSON.stringify(shared)}\n`, { mode: 0o644 });
    chmodSync(layoutPath, 0o644);
    return undefined;
  }
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
      judgeIndices: parseIndexList(lists.judge, "THERMITE_GPU_INDEX"),
      devIndices: parseIndexList(lists.dev, "THERMITE_DEV_GPU_INDEX"),
    });
    const kept: string[] = [];
    for (const { node, gid } of nodeGroups(layout)) {
      try {
        chownSync(node, 0, gid);
        chmodSync(node, 0o660);
      } catch {}
      const st = statSync(node);
      if (st.gid !== gid || (st.mode & 0o777) !== 0o660) {
        const why = `${node} kept group ${st.gid}, mode ${(st.mode & 0o777).toString(8)}`;
        if (!fenceAbi) throw new Error(why);
        kept.push(why);
      }
    }
    groupsHold = kept.length === 0;
    if (kept.length)
      log(
        "broker",
        "device nodes kept their owner and mode: only the Landlock fence keeps roles off them",
        {
          nodes: kept,
        },
      );
    record = {
      ok: true,
      ...layout,
      fence: kept.length ? "landlock" : fenceAbi ? "groups+landlock" : "groups",
    };
    log("broker", "dedicated cards", {
      judges: layout.judges.map((c) => c.node),
      devs: layout.devs.map((c) => c.node),
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
let supervisor: ChildProcess | undefined;
let stopping = false;
let restarts = 0;
let supervisorRestarts = 0;
/** The controller's exit code when it ended on a stop: the broker exits with it. */
let stopCode = 0;

const running = (c: ChildProcess | undefined): c is ChildProcess =>
  c !== undefined && c.exitCode === null && c.signalCode === null;

/** On a stop: exit once every part has ended, leaving no role process behind. */
function finishIfStopped(): void {
  if (running(child) || running(supervisor)) return;
  if (isRoot) killRoles();
  log("broker", "stopped", { code: stopCode });
  process.exit(stopCode);
}

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

/**
 * Before each start of the controller: the cards it uses. A rig configured with its GPU set may
 * have a new split in its settings (Edit rig, or a campaign's deployment); the controller exited
 * to apply it, its role processes are gone, and the cards are regrouped here.
 */
let beforeStart: (() => Record<string, string | undefined>) | undefined;

function startController(extraEnv: Record<string, string>): void {
  // A restart that falls due during a stop does not happen.
  if (stopping) {
    finishIfStopped();
    return;
  }
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
    if (v !== undefined && !(k in SECRET_VARS) && !isRunpodVariable(k)) childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(beforeStart?.() ?? {})) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
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
  const proc = child;
  proc.on("exit", (code, signal) => {
    // Worker processes of a dead controller must not live on (they would keep calling the model
    // and the API while new trials run): kill the controller's whole process group.
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
    if (stopping) {
      stopCode = code ?? 0;
      finishIfStopped();
      return;
    }
    if (isRoot) {
      const killed = killRoles();
      if (killed) log("broker", "killed role processes left by the controller", { killed });
    }
    const next = restartAfter(Date.now() - startedAt, restarts);
    restarts = next.restarts;
    log("broker", "controller exited; restarting", { code, signal, delay_ms: next.delayMs });
    setTimeout(() => startController(extraEnv), next.delayMs);
  });
}

/**
 * The one-container rig image: the supervisor's state and temporary directory (its own, closed
 * to every other user), the inbox it shares with the controller, the token it uses on the harness
 * API (made once and kept by root; the supervisor gets a copy in its home at every start), and
 * control's key from the launch. Runs at start, before the secrets are read and before anything
 * else runs, so nothing can swap a path in the supervisor's home for a link meanwhile.
 */
function prepareOneContainer(): SupervisorPaths {
  const paths = supervisorPaths(env);
  mkdirSync(paths.home, { recursive: true });
  if (statSync(paths.home).uid !== SU) {
    execFileSync("chown", ["-R", "-P", `${SU}:${SG}`, paths.home], { stdio: "ignore" });
  }
  chmodSync(paths.home, 0o700);
  rmSync(paths.tmp, { recursive: true, force: true });
  mkdirSync(paths.tmp, { mode: 0o700 });
  chownSync(paths.tmp, SU, SG);
  // The inbox: the supervisor writes, the controller's group reads (setgid keeps the group on
  // what is added); roles are in neither.
  mkdirSync(paths.inbox, { recursive: true });
  const inbox = statSync(paths.inbox);
  if (inbox.uid !== SU || inbox.gid !== TG) {
    execFileSync("chown", ["-R", "-P", `${SU}:${TG}`, paths.inbox], { stdio: "ignore" });
  }
  chmodSync(paths.inbox, 0o2750);
  // The token the supervisor uses on the harness API: root's copy is the harness's secret file.
  const rootToken = env.THERMITE_SUPERVISOR_TOKEN_FILE;
  if (!rootToken) {
    log("broker", "fatal: the one-container image needs THERMITE_SUPERVISOR_TOKEN_FILE");
    process.exit(1);
  }
  if (!existsSync(rootToken)) {
    mkdirSync(dirname(rootToken), { recursive: true, mode: 0o700 });
    chmodSync(dirname(rootToken), 0o700);
    writeFileSync(rootToken, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    log("broker", "made the token between the supervisor and the harness", { file: rootToken });
  }
  const token = readFileSync(rootToken, "utf8").trim();
  // The supervisor's copy: a new file (whatever was at the path goes), owned by it, 0600.
  rmSync(paths.tokenFile, { recursive: true, force: true });
  const fd = openSync(paths.tokenFile, "wx", 0o600);
  try {
    fchownSync(fd, SU, SG);
    fchmodSync(fd, 0o600);
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  // Control's command-signing key, public, from the launch. Without it the harness waits.
  const keyFile = env.THERMITE_CONTROL_PUBKEY_FILE;
  if (env.THERMITE_CONTROL_PUBKEY && keyFile) {
    try {
      const pem = controlKeyPem(env.THERMITE_CONTROL_PUBKEY);
      mkdirSync(dirname(keyFile), { recursive: true });
      rmSync(keyFile, { force: true });
      writeFileSync(keyFile, pem, { mode: 0o644, flag: "wx" });
      log("broker", "wrote control's public key from the launch", { file: keyFile });
    } catch (err) {
      log("broker", "control's public key from the launch is not usable; the harness waits", {
        file: keyFile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (!keyFile || !existsSync(keyFile)) {
    log("broker", "no control key yet: the harness waits for it", { file: keyFile ?? null });
  }
  return paths;
}

/** The supervisor's command, once it runs as its user (one-container.ts: supervisorArgv). */
const supervisorCommand = (command: string[]): string[] =>
  supervisorArgv(command, { setpriv: SETPRIV, fence: fenceAbi ? FENCE : undefined });

/**
 * Records how the supervisor runs, for the isolation selftest: its user, the fence, and what its
 * user meets opening the GPU's device nodes, tried now as it is started. Again after the cards
 * are regrouped.
 */
function recordSupervisor(paths: SupervisorPaths): void {
  const gpu = supervisorGpu(deviceNodes(), process.execPath, (command) => {
    const argv = supervisorCommand(command);
    const r = spawnSync(argv[0] as string, argv.slice(1), {
      uid: SU,
      gid: SG,
      cwd: paths.tmp,
      env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || String(r.error ?? "") };
  });
  const record: SupervisorRecord = {
    uid: SU,
    gid: SG,
    fence: fenceAbi ? "landlock" : "none",
    gpu,
    home: paths.home,
    at: new Date().toISOString(),
  };
  const path = join(socketDir, SUPERVISOR_RECORD);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
  log("broker", "the supervisor's user and the GPU", { fence: record.fence, gpu });
}

/**
 * The supervisor, as its own user (one-container image only), in its own process group. When it
 * exits, whatever it started (an advisor's program) ends too, and it starts again.
 */
function startSupervisor(paths: SupervisorPaths): void {
  if (stopping) {
    finishIfStopped();
    return;
  }
  const startedAt = Date.now();
  const argv = supervisorCommand([process.execPath, supervisorMain]);
  const proc = spawn(argv[0] as string, argv.slice(1), {
    stdio: "inherit",
    cwd: paths.home,
    env: supervisorEnv(env, paths, Object.keys(SECRET_VARS)),
    uid: SU,
    gid: SG,
    detached: true,
  });
  supervisor = proc;
  let ended = false;
  const end = (code: number | null, signal: string | null, error?: string) => {
    if (ended) return;
    ended = true;
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
    killScope({ uid: SU });
    if (stopping) {
      finishIfStopped();
      return;
    }
    const next = restartAfter(Date.now() - startedAt, supervisorRestarts);
    supervisorRestarts = next.restarts;
    log("broker", "supervisor exited; restarting", {
      code,
      signal,
      ...(error ? { error } : {}),
      delay_ms: next.delayMs,
    });
    setTimeout(() => startSupervisor(paths), next.delayMs);
  };
  proc.on("exit", (code, signal) => end(code, signal));
  proc.on("error", (err) => end(null, null, err.message));
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
    log("broker", "stopping", { signal: sig });
    const parts = [child, supervisor].filter(running);
    for (const part of parts) part.kill(sig);
    if (!parts.length) finishIfStopped();
  });
}

if (withSupervisor && !isRoot) {
  log("broker", "fatal: the one-container image must run as root", {
    hint: "the broker starts the supervisor and each role as users of their own",
  });
  process.exit(1);
}

if (isRoot) {
  prepareDirectories();
  prepareSocket();
  // Before the secrets are read: a token it makes is read with them.
  const pod = withSupervisor ? prepareOneContainer() : undefined;
  setInterval(prepareOutbox, 60_000).unref();
  const secrets = readSecrets();
  let lists = currentLists();
  let gpuLayout = prepareDevices(lists);
  // The server reads the layout and the CPU sets from here, so a new split reaches it.
  const serverOpts = {
    socketPath,
    scratchDir,
    baseEnv: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    gpuLayout,
    assertDevices: () => assertDevices(gpuLayout),
    runCpus: chooseRunCpus(gpuLayout, lists),
    fence: fenceAbi ? FENCE : undefined,
  };
  log("broker", "GPU fence", { landlock_abi: fenceAbi, used: fenceAbi > 0 });
  // nvidia-smi as root (the bus query above) resets nvidia-uvm to 0666: put it back now.
  assertDevices(gpuLayout);
  setInterval(() => assertDevices(gpuLayout), 60_000).unref();
  const killed = killRoles();
  if (killed) log("broker", "killed leftover role processes at start", { killed });
  if (pod) recordSupervisor(pod);
  beforeStart = () => {
    const next = currentLists();
    if (next.judge !== lists.judge || next.dev !== lists.dev) {
      log("broker", "the rig's GPU split changed: regrouping the cards", {
        judge: next.judge,
        dev: next.dev ?? null,
      });
      lists = next;
      gpuLayout = prepareDevices(lists);
      serverOpts.gpuLayout = gpuLayout;
      serverOpts.runCpus = chooseRunCpus(gpuLayout, lists);
      assertDevices(gpuLayout);
      if (pod) recordSupervisor(pod);
    }
    // The controller reads the lists as if configured so.
    return { THERMITE_GPU_INDEX: lists.judge, THERMITE_DEV_GPU_INDEX: lists.dev };
  };
  const server = startBrokerServer(serverOpts);
  server.on("listening", () => {
    chownSync(socketPath, 0, TG);
    chmodSync(socketPath, 0o660);
    log("broker", "serving", { socket: socketPath, separated: true });
    // The supervisor first: the controller's isolation check at start looks for it.
    if (pod) startSupervisor(pod);
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
