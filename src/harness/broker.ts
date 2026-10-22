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
import { podTunnelDirs } from "../core/tunnel.ts";
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
import { emptyScratchKeepingCaches, restoreLaneCaches } from "./broker/lane-caches.ts";
import {
  isRootOnly,
  isRunpodVariable,
  isSupervisorOnly,
  oneContainer,
  pullMode,
  readEnrollment,
  restartAfter,
  SUPERVISOR_RECORD,
  type SupervisorPaths,
  type SupervisorRecord,
  supervisorArgv,
  supervisorEnv,
  supervisorGpu,
  supervisorPaths,
  writeControlKey,
} from "./broker/one-container.ts";
import { killScope, SETPRIV } from "./broker/process.ts";
import { IDS, type Role, roleIds } from "./broker/runner.ts";
import { deriveKeys, SnapshotRefused, takeSnapshotKey } from "./broker/seal.ts";
import { ALL_ROLES, startBrokerServer, timedRunsAtWork } from "./broker/server.ts";
import {
  CLOSED_PROBE_JS,
  closedTo,
  layoutProblem,
  liveHolds,
  prepareSnapshotDir,
  removeUnsealed,
  restoreSnapshot,
  SNAPSHOT_RECORD,
  type SnapshotJob,
  type SnapshotRecord,
  Snapshotter,
  snapshotAreas,
  snapshotDir,
  snapshotEveryMs,
  stopBudgetMs,
  type TakeJob,
} from "./broker/snapshot.ts";

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
 *   prepares the supervisor's places and its token, and runs the supervisor as its own user,
 *   restarting it if it exits. In pull mode it starts the controller only once the supervisor's
 *   enrollment has brought control's key: it checks the key against the launch's SHA-256 and
 *   gives the harness a copy of its own, and takes the rig's settings from control as data;
 * - with THERMITE_STATE_SNAPSHOT_DIR (the one-container rig image sets it) and the launch's
 *   snapshot key, keeps the rig's state over a stop that empties the container's disk: the live
 *   state stays on that disk, and a sealed snapshot of it on the host's volume is restored at a
 *   start on an empty disk, and taken every few minutes, after each export, after enrollment and
 *   at a stop (broker/snapshot.ts, broker/seal.ts).
 *
 * No process it starts gets RunPod's variables (RUNPOD_*), and only the supervisor gets pull
 * mode's launch values. On SIGTERM or SIGINT it passes the signal on and exits when every part
 * it started has ended.
 *
 * Run as a non-root user (local development), it only starts the controller.
 */

const controller = fileURLToPath(new URL("./main.js", import.meta.url));
const supervisorMain = fileURLToPath(new URL("../supervisor/main.js", import.meta.url));
const snapshotMain = fileURLToPath(new URL("./broker/snapshot-main.js", import.meta.url));
const env = process.env;
/**
 * The state snapshot's key (THERMITE_STATE_SNAPSHOT_KEY, a launch value), taken out of the
 * broker's own environment before it starts anything: no part, no role and no program the broker
 * runs ever has it. Only root's snapshot helper gets it, on its standard input.
 */
const snapshotKey = takeSnapshotKey(env);
/**
 * A fatal error at start: the broker exits, after THERMITE_FATAL_HOLD_SECONDS when it is set (the
 * rig image sets 60). A host that starts a stopped container again at once, such as RunPod, then
 * keeps the error in the pod's log, and the container does not restart every few seconds.
 */
function fatalExit(): never {
  const hold = Number(env.THERMITE_FATAL_HOLD_SECONDS ?? 0);
  if (Number.isFinite(hold) && hold > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(hold, 600) * 1000);
  process.exit(1);
}
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
/** THERMITE_STATE_SNAPSHOT_DIR: the state is kept on the host's volume as a snapshot. */
const snapDir = snapshotDir(env);

/** Secret files whose values the controller needs. The *_FILE variables never reach it. */
const SECRET_VARS: Record<string, string> = {
  THERMITE_SUPERVISOR_TOKEN_FILE: "THERMITE_SUPERVISOR_TOKEN",
  THERMITE_PROPOSER_TOKEN_FILE: "THERMITE_PROPOSER_TOKEN",
  THERMITE_MODEL_API_KEY_FILE: "THERMITE_MODEL_API_KEY",
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
  // Scratch is disposable: whatever an earlier run left (including hostile trees) goes now. The
  // lanes' cache folders are kept (goal 079): each a real folder its own lane's user owns.
  chownSync(scratchDir, 0, 0);
  chmodSync(scratchDir, 0o755);
  const kept = emptyScratchKeepingCaches(scratchDir, {
    keep: (lane, st) => st.uid === roleIds(lane as Role).uid,
    remove: (path) =>
      tryDo(`clear scratch ${path}`, () =>
        execFileSync("rm", ["-rf", "--one-file-system", path], { stdio: "ignore" }),
      ),
  });
  const ctl = join(scratchDir, "thermite");
  mkdirSync(join(ctl, "tmp"), { recursive: true });
  execFileSync("chown", ["-R", "-P", `${TU}:${TG}`, ctl], { stdio: "ignore" });
  chmodSync(ctl, 0o711);
  chmodSync(join(ctl, "tmp"), 0o700);
  // Put back after the controller's folder is its own: each cache stays its lane's.
  tryDo("keep the lanes' caches", () =>
    restoreLaneCaches(scratchDir, kept, (dir) => chownSync(dir, TU, TG)),
  );
  if (kept.length) log("broker", "kept the lanes' caches over the start", { lanes: kept });
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
      fatalExit();
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
/** The state snapshot's schedule, once it runs (THERMITE_STATE_SNAPSHOT_DIR). */
let snapshots: Snapshotter | undefined;
/** A stop's snapshot is being taken: the broker does not exit before it ends. */
let holdExit = false;

const running = (c: ChildProcess | undefined): c is ChildProcess =>
  c !== undefined && c.exitCode === null && c.signalCode === null;

/** On a stop: exit once every part has ended, leaving no role process behind. */
function finishIfStopped(): void {
  if (holdExit || running(child) || running(supervisor)) return;
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
    if (
      v !== undefined &&
      !(k in SECRET_VARS) &&
      !isRunpodVariable(k) &&
      !isSupervisorOnly(k) &&
      !isRootOnly(k)
    )
      childEnv[k] = v;
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
 * to every other user), the inbox it shares with the controller, and the token it uses on the
 * harness API (made once and kept by root; the supervisor gets a copy in its home at every
 * start). In pull mode, the harness's copy of control's key from an earlier start goes: it is
 * made again from this start's enrollment. Runs at start, before the secrets are read and before
 * anything else runs, so nothing can swap a path in the supervisor's home for a link meanwhile.
 */
function prepareOneContainer(): SupervisorPaths {
  const paths = supervisorPaths(env);
  if (pullMode(env)) {
    const missing = [
      "THERMITE_RIG_ID",
      "THERMITE_CONTROL_PUBKEY_FILE",
      "THERMITE_TUNNEL_CONTROL_KEY_SHA256",
    ].filter((k) => !env[k]);
    if (missing.length || !/^[0-9a-fA-F]{64}$/.test(env.THERMITE_TUNNEL_CONTROL_KEY_SHA256 ?? "")) {
      log("broker", "fatal: pull mode needs the launch's values", {
        missing,
        hint: "THERMITE_TUNNEL_CONTROL_KEY_SHA256 is 64 hexadecimal characters",
      });
      fatalExit();
    }
    rmSync(env.THERMITE_CONTROL_PUBKEY_FILE as string, { force: true });
  }
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
    fatalExit();
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
  return paths;
}

/** While the controller waits for enrollment, the broker says so at once and this often. */
const SAY_EVERY_MS = 10 * 60_000;

/**
 * Pull mode in the one-container image: the controller starts once the pod is enrolled. Root
 * reads what the supervisor's enrollment left (one-container.ts: readEnrollment), checks
 * control's key against the SHA-256 the launch named, and gives the harness a copy of its own,
 * so the supervisor never chooses the key the harness trusts. It takes the rig's settings from
 * control by name, as data, into the environment the controller starts with. Resolves false
 * when the broker is stopped first.
 */
async function awaitEnrollment(paths: SupervisorPaths): Promise<boolean> {
  const dir = podTunnelDirs(env, paths.home).enrolledDir;
  const keyFile = env.THERMITE_CONTROL_PUBKEY_FILE as string;
  const started = Date.now();
  let said = -Infinity;
  let lastWhy = "";
  while (!stopping) {
    const e = readEnrollment({
      dir,
      rig: env.THERMITE_RIG_ID as string,
      controlKeySha256: env.THERMITE_TUNNEL_CONTROL_KEY_SHA256 as string,
      owner: SU,
    });
    if (e.state === "ready") {
      writeControlKey(keyFile, e.controlKeyPem);
      for (const [k, v] of Object.entries(e.settings)) env[k] = v;
      log("broker", "enrolled: the harness starts with control's key from enrollment", {
        file: keyFile,
        settings: Object.keys(e.settings),
      });
      // The pod's keys and its enrollment, kept at once: a stop no longer loses them.
      snapshots?.request("after enrollment");
      return true;
    }
    const waited = Date.now() - started;
    const why = e.state === "refused" ? e.why : "";
    if (why !== lastWhy || waited - said >= SAY_EVERY_MS) {
      said = waited;
      lastWhy = why;
      if (why)
        log("broker", "refused what enrollment left: the harness waits", {
          why,
          waited_s: Math.round(waited / 1000),
        });
      else
        log(
          "broker",
          "waiting for enrollment: the harness starts once control has enrolled the pod",
          {
            dir,
            waited_s: Math.round(waited / 1000),
          },
        );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
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

/**
 * THERMITE_STATE_SNAPSHOT_DIR (the one-container rig image sets it; broker/snapshot.ts): the live
 * state stays on the container's disk, and a sealed snapshot of it on the host's volume outlives
 * a stop that empties that disk. At a start, before anything else: root makes the snapshot
 * folder, its own with mode 0700, and records whether the controller's user, the supervisor's and
 * a role can open it (a volume may ignore the mode: RunPod's does). Without the launch's snapshot
 * key no snapshot is taken or restored. With it, when the live state is empty (a fresh disk), the
 * newest snapshot is restored, with the owners and modes the live folders need, once its manifest
 * and every file verify; one that does not is refused whole and the rig starts empty. Returns the
 * record the isolation selftest reads, or nothing without the setting.
 */
let snapshotEvery = 0;
let snapshotStopMs = 0;
const rigId = (): string | null => env.THERMITE_RIG_ID || null;
function prepareSnapshots(): SnapshotRecord | undefined {
  if (!snapDir) return undefined;
  const areas = snapshotAreas(env);
  const at = new Date().toISOString();
  const keyWhy = "why" in snapshotKey ? snapshotKey.why : undefined;
  try {
    snapshotEvery = snapshotEveryMs(env);
    snapshotStopMs = stopBudgetMs(env);
  } catch (err) {
    log("broker", "fatal: a snapshot setting is not valid", { error: String(err) });
    fatalExit();
  }
  const problem = layoutProblem(snapDir, areas);
  if (problem) {
    log("broker", "fatal: the state snapshot can't be set up", { problem });
    fatalExit();
  }
  let shown: ReturnType<typeof prepareSnapshotDir>;
  try {
    shown = prepareSnapshotDir(snapDir);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log("broker", "could not make the snapshot folder: no snapshot is taken or restored", {
      dir: snapDir,
      error,
    });
    return {
      dir: snapDir,
      owner: "",
      mode: "",
      users: { root: `failed: ${error}` },
      closed: false,
      sealed: false,
      off: `could not make the snapshot folder: ${error}`,
      at,
    };
  }
  // Whatever owner the volume gives root's files, no part and no role may open the folder.
  const users: Record<string, { uid: number; gid: number }> = {
    thermite: IDS.thermite,
    ...(withSupervisor ? { supervisor: IDS.supervisor } : {}),
    "agent-1": roleIds("agent-1"),
  };
  const seen = closedTo(Object.keys(users), (name) => {
    const u = users[name] as { uid: number; gid: number };
    const r = spawnSync(process.execPath, ["-e", CLOSED_PROBE_JS, snapDir], {
      uid: u.uid,
      gid: u.gid,
      cwd: "/",
      env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || String(r.error ?? "") };
  });
  const closed = Object.values(seen).every((v) => v.startsWith("refused"));
  const record: SnapshotRecord = {
    dir: snapDir,
    owner: `${shown.uid}:${shown.gid}`,
    mode: shown.mode.toString(8),
    users: seen,
    closed,
    sealed: !keyWhy,
    ...(keyWhy ? { off: keyWhy } : {}),
    at,
  };
  // An image before sealing kept its snapshot unsealed: it is never restored.
  try {
    const old = removeUnsealed(snapDir, closed);
    if (old.removed.length)
      log("broker", "removed an unsealed snapshot an older image left: it is not restored", {
        dir: snapDir,
        removed: old.removed,
      });
    if (old.left.length)
      log(
        "broker",
        "an unsealed snapshot an older image left is in the snapshot folder, which other users may open: it is not restored, and it stays for the owner to remove",
        { dir: snapDir, left: old.left },
      );
  } catch (err) {
    log("broker", "could not remove an unsealed snapshot an older image left", {
      dir: snapDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if ("why" in snapshotKey) {
    log("broker", "no snapshot key: no snapshot is taken or restored", {
      dir: snapDir,
      why: snapshotKey.why,
      hint: "control gives a pod its key at launch; a pod launched by an older control has none, and its state does not outlive a stop",
    });
    return record;
  }
  log(
    "broker",
    closed
      ? "the snapshot folder is closed to the parts and the roles"
      : "the snapshot folder is open to other users: its snapshot is sealed",
    {
      dir: snapDir,
      owner: record.owner,
      mode: record.mode,
      ...(closed ? {} : { users: seen }),
      every_minutes: snapshotEvery / 60_000,
    },
  );
  const holds = liveHolds(areas);
  if (holds.length) {
    log("broker", "the live state is on this disk: nothing is restored", { holds });
    return record;
  }
  try {
    const r = restoreSnapshot({
      dir: snapDir,
      areas,
      keys: deriveKeys(snapshotKey.key),
      rig: rigId(),
    });
    if (!r) log("broker", "no snapshot yet: the rig starts with a fresh state", { dir: snapDir });
    else
      log("broker", "restored the rig's state from its snapshot", {
        dir: snapDir,
        snapshot: r.from,
        seq: r.seq,
        taken_at: r.taken_at,
        taken: r.reason,
        parts: r.areas,
        ...(r.refused.length
          ? { refused: r.refused.length, refused_first: r.refused.slice(0, 10) }
          : {}),
      });
  } catch (err) {
    if (err instanceof SnapshotRefused) {
      // Refused whole: nothing of it is restored, and the rig starts with an empty state. The
      // next snapshot takes its place.
      log("broker", `the snapshot did not verify: ${err.message}`, {
        dir: snapDir,
        restored: "nothing: the rig starts with an empty state",
      });
      return record;
    }
    log("broker", "fatal: could not restore the rig's state from its snapshot", {
      dir: snapDir,
      error: err instanceof Error ? err.message : String(err),
    });
    fatalExit();
  }
  return record;
}

/** The broker's record of the snapshot folder, next to its socket, for the isolation selftest. */
function writeSnapshotRecord(record: SnapshotRecord): void {
  const path = join(socketDir, SNAPSHOT_RECORD);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
}

/** A snapshot taken by the broker's helper, at a low priority but at a stop. */
const NICE = existsSync("/usr/bin/nice") ? ["/usr/bin/nice", "-n", "19"] : [];
const IONICE = existsSync("/usr/bin/ionice") ? ["/usr/bin/ionice", "-t", "-c", "2", "-n", "7"] : [];
function snapshotJob(reason: string): SnapshotJob {
  const job: TakeJob = {
    dir: snapDir as string,
    reason,
    areas: snapshotAreas(env),
    stage: join(scratchDir, ".snapshot-ledger"),
    owner: IDS.thermite,
    rig: rigId(),
    key: "key" in snapshotKey ? snapshotKey.key.toString("base64url") : "",
  };
  const gentle = reason === "at the stop" ? [] : [...IONICE, ...NICE];
  const argv = [...gentle, process.execPath, ...process.execArgv, snapshotMain, "take"];
  // The job, with the key, on its standard input: a process's arguments are any user's to read.
  const proc = spawn(argv[0] as string, argv.slice(1), {
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...(env.NODE_OPTIONS ? { NODE_OPTIONS: env.NODE_OPTIONS } : {}),
    },
    detached: true,
  });
  proc.stdin?.on("error", () => {
    // it ended before it read its job: its exit says so
  });
  proc.stdin?.end(JSON.stringify(job));
  const done = new Promise<boolean>((resolve) => {
    proc.on("exit", (code, signal) => {
      if (code !== 0)
        log("broker", "the snapshot failed: the last one stays, and it is tried again", {
          reason,
          code,
          signal,
        });
      resolve(code === 0);
    });
    proc.on("error", (err) => {
      log("broker", "could not start the snapshot", { reason, error: err.message });
      resolve(false);
    });
  });
  return {
    done,
    abort: () => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        // it has ended
      }
    },
  };
}

/** A snapshot after each export the harness writes: a new name in the outbox, looked for often. */
function watchOutbox(onNew: () => void): void {
  let seen: Set<string> | undefined;
  const look = () => {
    let names: string[];
    try {
      names = readdirSync(outboxDir).filter((n) => !n.startsWith("."));
    } catch {
      return;
    }
    const fresh = seen !== undefined && names.some((n) => !seen?.has(n));
    seen = new Set(names);
    if (fresh) onNew();
  };
  look();
  setInterval(look, 10_000).unref();
}

/** Snapshots from now on: every few minutes, after each export, after enrollment and at a stop. */
function startSnapshots(record: SnapshotRecord | undefined): void {
  if (!record?.sealed) return;
  snapshots = new Snapshotter({
    take: snapshotJob,
    everyMs: snapshotEvery,
    busy: () => timedRunsAtWork() > 0,
  });
  snapshots.start();
  watchOutbox(() => snapshots?.request("after an export"));
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    const again = stopping;
    stopping = true;
    log("broker", "stopping", { signal: sig });
    const stopParts = () => {
      holdExit = false;
      const parts = [child, supervisor].filter(running);
      for (const part of parts) part.kill(sig);
      if (!parts.length) finishIfStopped();
    };
    // The state snapshot first, while both parts still run, within the time a stop allows. A
    // second signal ends it at once.
    if (snapshots && holdExit) {
      snapshots.abort();
      return;
    }
    if (snapshots && !again) {
      holdExit = true;
      const budget = snapshotStopMs;
      snapshots.stop(budget).then(
        (r) => {
          if (r !== "taken")
            log("broker", "no snapshot at the stop: the last complete one stays", {
              why: r === "out of time" ? `not done within ${budget / 1000} s` : "it failed",
            });
          stopParts();
        },
        () => stopParts(),
      );
      return;
    }
    stopParts();
  });
}

if (withSupervisor && !isRoot) {
  log("broker", "fatal: the one-container image must run as root", {
    hint: "the broker starts the supervisor and each role as users of their own",
  });
  fatalExit();
}

if (isRoot) {
  // Before anything is made in the live folders: on a fresh disk they are restored first.
  const snapshotRecord = prepareSnapshots();
  prepareDirectories();
  prepareSocket();
  if (snapshotRecord) writeSnapshotRecord(snapshotRecord);
  // Before the secrets are read: a token it makes is read with them. A throw here (a volume that
  // refuses ownership, say) is logged as fatal and held, as the other start errors are.
  let pod: ReturnType<typeof prepareOneContainer> | undefined;
  try {
    pod = withSupervisor ? prepareOneContainer() : undefined;
  } catch (err) {
    log("broker", "fatal: could not prepare the rig's folders", {
      error: err instanceof Error ? err.message : String(err),
    });
    fatalExit();
  }
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
  let target = env.THERMITE_TARGET;
  beforeStart = () => {
    const next = currentLists();
    const regroup = next.judge !== lists.judge || next.dev !== lists.dev;
    if (regroup) {
      log("broker", "the rig's GPU split changed: regrouping the cards", {
        judge: next.judge,
        dev: next.dev ?? null,
      });
      lists = next;
      gpuLayout = prepareDevices(lists);
      serverOpts.gpuLayout = gpuLayout;
      assertDevices(gpuLayout);
      if (pod) recordSupervisor(pod);
    }
    // A target from enrollment's settings (pull mode) may pin timed runs where none were.
    if (regroup || env.THERMITE_TARGET !== target) {
      target = env.THERMITE_TARGET;
      serverOpts.runCpus = chooseRunCpus(gpuLayout, lists);
    }
    // The controller reads the lists as if configured so.
    return { THERMITE_GPU_INDEX: lists.judge, THERMITE_DEV_GPU_INDEX: lists.dev };
  };
  const server = startBrokerServer(serverOpts);
  server.on("listening", () => {
    chownSync(socketPath, 0, TG);
    chmodSync(socketPath, 0o660);
    log("broker", "serving", { socket: socketPath, separated: true });
    const start = () => startController({ ...secrets, THERMITE_BROKER_SOCKET: socketPath });
    startSnapshots(snapshotRecord);
    // The supervisor first: in pull mode its enrollment brings control's key; and the
    // controller's isolation check at start looks for it.
    if (pod) startSupervisor(pod);
    if (pod && pullMode(env))
      awaitEnrollment(pod).then(
        (enrolled) => {
          if (enrolled) start();
        },
        (err) => {
          log("broker", "fatal: could not give the harness control's key from enrollment", {
            error: err instanceof Error ? err.message : String(err),
          });
          fatalExit();
        },
      );
    else start();
  });
} else if (env.THERMITE_ALLOW_UNSEPARATED === "1") {
  log("broker", "not root: starting the controller WITHOUT user separation (explicitly allowed)");
  if (snapDir) log("broker", "not root: no state snapshot is taken or restored", { dir: snapDir });
  startController({});
} else {
  log("broker", "fatal: not root, so roles cannot be separated", {
    hint: "run the harness container as root (the broker drops to role users), or set THERMITE_ALLOW_UNSEPARATED=1 for development only",
  });
  fatalExit();
}
