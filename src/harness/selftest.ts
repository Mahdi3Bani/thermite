import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keySha256 } from "../core/tunnel.ts";
import { BrokerClient } from "./broker/client.ts";
import {
  cardsOf,
  type GpuLayout,
  judgeCardOf,
  LAYOUT_FILE,
  type LayoutRecord,
  readLayout,
  runRole,
} from "./broker/devices.ts";
import {
  oneContainer,
  SUPERVISOR_RECORD,
  type SupervisorRecord,
  supervisorPaths,
} from "./broker/one-container.ts";
import { listProcesses, type Proc } from "./broker/process.ts";
import { IDS, type Role, roleIds, walk } from "./broker/runner.ts";
import { copyForRun } from "./judge/measure.ts";

/**
 * Isolation self-test, run as root inside the harness container (`thermite selftest
 * isolation`). For each role it asks the broker to run a probe as that role's user, which tries
 * to read, list or write what the role must not reach. Every probe must be refused, except a
 * `readable` or `reachable` probe, which must succeed. In the one-container rig image it also
 * checks the container as a whole (containerChecks): the supervisor's user, its GPU access,
 * set-id files, RunPod's variables, the enrollment code and, in pull mode, control's key.
 */

export interface Probe {
  name: string;
  op:
    | "read"
    | "list"
    | "write"
    | "access"
    | "open"
    | "create"
    | "readable"
    | "reachable"
    | "gpus"
    | "runpod";
  path: string;
  /** For `gpus`: the only card UUIDs nvidia-smi may list, comma-separated. */
  expect?: string;
}

export interface IsolationReport {
  ok: boolean;
  /** "shared", or "dedicated" with the judge's and the development card's nodes. */
  devices: string;
  roles: Record<string, Record<string, string>>;
  /** The one-container rig image: checks of the container as a whole (containerChecks). */
  container?: Record<string, string>;
  skipped: string[];
}

const FAILURES = [
  "ALLOWED",
  "UNREADABLE",
  "UNREACHABLE",
  "WRONG",
  "FOUND",
  "OPENED",
  "MISSING",
  "failed",
];

/**
 * A result that fails the selftest: a probe that must be refused got through (ALLOWED), one that
 * must succeed did not (UNREADABLE, UNREACHABLE), the wrong cards or user (WRONG ...), something
 * found that must not be there (FOUND, OPENED), something missing (MISSING), or a probe that
 * failed to run.
 */
export function isFailure(result: string): boolean {
  return FAILURES.some((m) => result.startsWith(m));
}

/**
 * The probe script each role runs (node -e, the probes as JSON in argv[1]). `runpod` lists /proc
 * (the probe's `path`): RunPod's variables must be in neither the role's own environment nor any
 * process environment it can read.
 */
export const PROBE = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const probes = JSON.parse(process.argv[1]);
const out = {};
for (const p of probes) {
  if (p.op === "runpod") {
    const found = Object.keys(process.env).filter((k) => k.startsWith("RUNPOD_")).map((k) => k + " (own)");
    try {
      for (const pid of fs.readdirSync(p.path).filter((d) => /^\\d+$/.test(d))) {
        let text;
        try {
          text = fs.readFileSync(p.path + "/" + pid + "/environ", "latin1");
        } catch {
          continue;
        }
        for (const kv of text.split("\\0"))
          if (kv.startsWith("RUNPOD_")) found.push(kv.split("=")[0] + " (pid " + pid + ")");
      }
      out[p.name] = found.length ? "FOUND " + found.slice(0, 8).join(", ") : "none";
    } catch (e) {
      out[p.name] = "failed: " + (e.code || String(e));
    }
    continue;
  }
  if (p.op === "gpus") {
    // A card whose node is refused is silently left out, so check exactly which cards show.
    let ids = "";
    try {
      const listed = execFileSync("nvidia-smi", ["-L"], { encoding: "utf8" });
      ids = [...listed.matchAll(/UUID: (GPU-[0-9a-fA-F-]+)/g)].map((m) => m[1]).join(",");
    } catch (e) {
      ids = "none (" + (e.code || e.status) + ")";
    }
    out[p.name] = ids === p.expect ? "sees " + ids : "WRONG GPUS " + ids;
    continue;
  }
  try {
    if (p.op === "read" || p.op === "readable") fs.readFileSync(p.path);
    else if (p.op === "list") fs.readdirSync(p.path);
    else if (p.op === "write") fs.writeFileSync(p.path, "tampered", { flag: "r+" });
    else if (p.op === "create") fs.writeFileSync(p.path + "/probe-" + process.getuid(), "x");
    // A device node is opened for real (and closed): file modes and the Landlock fence both
    // act on opening, while access() sees only the modes.
    else if (p.op === "reachable" || p.op === "open") fs.closeSync(fs.openSync(p.path, "r+"));
    else fs.accessSync(p.path, fs.constants.W_OK);
    out[p.name] = p.op === "readable" || p.op === "reachable" ? p.op : "ALLOWED";
  } catch (e) {
    const must = { readable: "UNREADABLE ", reachable: "UNREACHABLE " }[p.op] || "";
    out[p.name] = must + (e.code || String(e));
  }
}
process.stdout.write(JSON.stringify(out));
`;

/** Who a role is to the device: the run user, a development run, or neither. */
function deviceSide(role: Role, gpu: boolean): "judge" | "dev" | "other" {
  if (judgeCardOf(role) !== undefined) return "judge";
  return gpu || role.endsWith("-dev") ? "dev" : "other";
}

/**
 * The device-node probes for one side. In shared mode the run user and development runs reach
 * every node and are not probed; everyone else is refused every node. With dedicated cards each
 * judge identity and each development card must reach its own card and the shared nodes, and be
 * refused every other card, and nvidia-smi must list exactly its own card.
 */
export function deviceProbes(
  nodes: string[],
  side: "judge" | "dev" | "other",
  layout?: GpuLayout | undefined,
  card = 0,
): Probe[] {
  const refuse = (p: string): Probe => ({ name: `device:${p.slice(5)}`, op: "open", path: p });
  const reach = (p: string): Probe => ({ name: `device:${p.slice(5)}`, op: "reachable", path: p });
  if (side === "other") return nodes.map(refuse);
  if (!layout) return [];
  const { judges, devs } = cardsOf(layout);
  const own = (side === "judge" ? judges : devs)[card];
  if (!own) throw new Error(`no ${side === "judge" ? "judge" : "development"} card ${card + 1}`);
  const others = [...judges, ...devs].filter((c) => c.node !== own.node);
  return [
    reach(own.node),
    ...layout.control.map(reach),
    ...others.map((c) => refuse(c.node)),
    { name: "visible-gpus", op: "gpus", path: "nvidia-smi", expect: own.uuid },
  ];
}

/** The processes running a script of Thermite's (`node <...>/<script>`), other than this one. */
export function pidsRunning(script: string, procDir = "/proc"): number[] {
  const pids: number[] = [];
  for (const name of existsSync(procDir) ? readdirSync(procDir) : []) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(join(procDir, name, "cmdline"), "utf8").split("\0");
      if (Number(name) !== process.pid && (argv[1] ?? "").endsWith(script)) pids.push(Number(name));
    } catch {
      // gone
    }
  }
  return pids;
}

function controllerPid(): number | undefined {
  return pidsRunning("dist/harness/main.js")[0];
}

const SUPERVISOR_SCRIPT = "dist/supervisor/main.js";

/** The one-container rig image: the supervisor's places, which no role may reach. */
export interface OneContainerTargets {
  supervisorHome: string;
  /** Its copy of the token it uses on the harness API. */
  supervisorToken: string;
  /** The inbox it writes and the controller reads. */
  inboxDir: string;
  /**
   * Pull mode: the harness's copy of control's key (root's), and the SHA-256 the launch named
   * (THERMITE_TUNNEL_CONTROL_KEY_SHA256, which the broker passes the controller).
   */
  controlKey?: { file: string; sha256: string } | undefined;
}

/** What the selftest probes of the supervisor in the one-container image; none elsewhere. */
export function oneContainerTargets(
  env: Record<string, string | undefined>,
): OneContainerTargets | undefined {
  if (!oneContainer(env)) return undefined;
  const p = supervisorPaths(env);
  const file = env.THERMITE_CONTROL_PUBKEY_FILE;
  const sha256 = env.THERMITE_TUNNEL_CONTROL_KEY_SHA256;
  return {
    supervisorHome: p.home,
    supervisorToken: p.tokenFile,
    inboxDir: p.inbox,
    ...(file && sha256 ? { controlKey: { file, sha256 } } : {}),
  };
}

/** A process's real, effective, saved and file ids, and no_new_privs (/proc/<pid>/status). */
function statusOf(
  procDir: string,
  pid: number,
): { uids: number[]; gids: number[]; nnp: boolean } | undefined {
  try {
    const text = readFileSync(join(procDir, String(pid), "status"), "utf8");
    const ids = (field: string) =>
      (new RegExp(`^${field}:\\s*(.*)$`, "m").exec(text)?.[1] ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    return { uids: ids("Uid"), gids: ids("Gid"), nnp: /^NoNewPrivs:\s*1\s*$/m.test(text) };
  } catch {
    return undefined;
  }
}

/**
 * The supervisor runs as its own user and group, with no_new_privs: "uid 10001, gid 10001,
 * no_new_privs", or a failure. It may still be starting: waits up to `waitMs` for it.
 */
export async function supervisorUserCheck(
  procDir = "/proc",
  waitMs = 10_000,
  expect = IDS.supervisor,
): Promise<string> {
  const deadline = Date.now() + waitMs;
  let pids = pidsRunning(SUPERVISOR_SCRIPT, procDir);
  while (!pids.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    pids = pidsRunning(SUPERVISOR_SCRIPT, procDir);
  }
  if (!pids.length) return "MISSING: no supervisor process";
  for (const pid of pids) {
    const st = statusOf(procDir, pid);
    if (!st) continue;
    const wrong =
      st.uids.length !== 4 ||
      st.uids.some((u) => u !== expect.uid) ||
      st.gids.length !== 4 ||
      st.gids.some((g) => g !== expect.gid);
    if (wrong)
      return `WRONG USER: pid ${pid} has uids ${st.uids.join(" ")}, gids ${st.gids.join(" ")}`;
    if (!st.nnp) return `WRONG: pid ${pid} may gain privileges (no_new_privs is off)`;
  }
  return `uid ${expect.uid}, gid ${expect.gid}, no_new_privs`;
}

/**
 * What the supervisor's user met opening the GPU's device nodes when the broker started it (the
 * broker's record next to its socket): "refused" or "no GPU node", with the fence; or a failure.
 */
export function supervisorGpuCheck(brokerDir: string): string {
  let r: SupervisorRecord;
  try {
    r = JSON.parse(readFileSync(join(brokerDir, SUPERVISOR_RECORD), "utf8")) as SupervisorRecord;
  } catch (err) {
    return `MISSING: no record from the broker (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
  return isFailure(r.gpu) ? r.gpu : `${r.gpu} (fence: ${r.fence})`;
}

/**
 * Set-id files on the container's own filesystem (from `root`, not crossing into other mounts):
 * the one-container image has none, since its host does not stop a process gaining privileges
 * through one. "none", or "FOUND <files>". Folders this process cannot read are counted. `skip`
 * leaves folders out: the scratch folder, where roles work (a role's own set-id file gives only
 * itself, and the broker clears set-id bits after every lane run).
 */
export function setIdCheck(root = "/", skip: string[] = []): string {
  const found: string[] = [];
  let unreadable = 0;
  const dev = lstatSync(root).dev;
  const skipped = new Set(skip);
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      unreadable++;
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.dev !== dev || skipped.has(p)) continue;
      if (st.isDirectory()) visit(p);
      else if (st.isFile() && st.mode & 0o6000) found.push(p);
    }
  };
  visit(root);
  if (found.length)
    return `FOUND ${found.length} set-id files: ${found.slice(0, 10).join(", ")}${found.length > 10 ? ", ..." : ""}`;
  return unreadable ? `none (${unreadable} folders not readable)` : "none";
}

/**
 * The rig's processes, PID 1 and everything started under it, with their uid and their
 * environment's entries where this process may read it (all of them as root with ptrace's
 * capability, otherwise its own user's). A process started from outside (a shell opened with
 * `exec`) is not part of the rig and is left out.
 */
function rigProcesses(procDir: string): { pid: number; uid: number; environ?: string[] }[] {
  const parent = new Map<number, number>();
  const uid = new Map<number, number>();
  for (const name of existsSync(procDir) ? readdirSync(procDir) : []) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(join(procDir, name, "status"), "utf8");
      const ppid = /^PPid:\s*(\d+)/m.exec(status);
      if (ppid) parent.set(Number(name), Number(ppid[1]));
      uid.set(Number(name), Number(/^Uid:\s*(\d+)/m.exec(status)?.[1] ?? -1));
    } catch {
      // gone
    }
  }
  const underInit = (pid: number) => {
    for (let p = pid, hops = 0; hops < 4096; hops++) {
      if (p === 1) return true;
      const up = parent.get(p);
      if (up === undefined || up === 0) return false;
      p = up;
    }
    return false;
  };
  const pids = [...parent.keys()].filter(underInit).sort((a, b) => a - b);
  return pids.map((pid) => {
    try {
      const text = readFileSync(join(procDir, String(pid), "environ"), "latin1");
      return { pid, uid: uid.get(pid) ?? -1, environ: text.split("\0") };
    } catch {
      return { pid, uid: uid.get(pid) ?? -1 };
    }
  });
}

/**
 * RunPod's variables in the rig's processes (rigProcesses), as far as this process may read
 * their environments. "none (read N of M processes)" or "FOUND".
 */
export function runpodCheck(procDir = "/proc"): string {
  const procs = rigProcesses(procDir);
  const found = procs.flatMap((p) =>
    (p.environ ?? [])
      .filter((kv) => kv.startsWith("RUNPOD_"))
      .map((kv) => `${kv.split("=")[0]} (pid ${p.pid})`),
  );
  if (found.length) return `FOUND ${found.slice(0, 8).join(", ")}`;
  return `none (read ${procs.filter((p) => p.environ).length} of ${procs.length} processes)`;
}

/**
 * Pull mode's enrollment code in the rig's processes: only root's and the supervisor's own first
 * process may have started with it (the supervisor takes it out of its environment at start, so
 * nothing it starts has it; the controller never gets it). "none (read N of M processes)" or
 * "FOUND".
 */
export function enrollCodeCheck(procDir = "/proc"): string {
  const procs = rigProcesses(procDir);
  const supervisor = new Set(pidsRunning(SUPERVISOR_SCRIPT, procDir));
  const found = procs
    .filter(
      (p) =>
        p.uid !== 0 &&
        !supervisor.has(p.pid) &&
        (p.environ ?? []).some((kv) => kv.startsWith("THERMITE_TUNNEL_ENROLL_CODE=")),
    )
    .map((p) => `pid ${p.pid} (uid ${p.uid})`);
  if (found.length) return `FOUND THERMITE_TUNNEL_ENROLL_CODE in ${found.slice(0, 8).join(", ")}`;
  return `none (read ${procs.filter((p) => p.environ).length} of ${procs.length} processes)`;
}

/**
 * The key the harness trusts for control's commands, in pull mode: root's copy, which neither
 * the supervisor nor a role can change (the file and each folder above it, up to `top`, are
 * `rootUid`'s and writable by no one else), and the key the launch named by its SHA-256.
 */
export function controlKeyCheck(
  file: string,
  sha256: string,
  opts: { rootUid?: number; top?: string } = {},
): string {
  const rootUid = opts.rootUid ?? 0;
  const top = opts.top ?? "/";
  let pem: string;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return `WRONG: ${file} is not a plain file`;
    const wrong = (p: string, s: Stats) =>
      s.uid !== rootUid || s.mode & 0o022
        ? `WRONG: ${p} is uid ${s.uid}, mode ${(s.mode & 0o777).toString(8)}: another user could change it`
        : undefined;
    const bad = wrong(file, st);
    if (bad) return bad;
    for (let d = dirname(file); ; d = dirname(d)) {
      const s = lstatSync(d);
      if (!s.isDirectory()) return `WRONG: ${d} is not a folder`;
      const badDir = wrong(d, s);
      if (badDir) return badDir;
      if (d === top || d === dirname(d)) break;
    }
    pem = readFileSync(file, "utf8");
  } catch (err) {
    return `MISSING: ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
  try {
    if (keySha256(pem) !== sha256.toLowerCase())
      return "WRONG: it is not the key the launch named by its SHA-256";
  } catch {
    return "WRONG: it is not a public key";
  }
  return "root's, the key the launch named";
}

/**
 * The one-container image's checks of the container as a whole: the supervisor's user, its GPU
 * access, set-id files, RunPod's variables and the enrollment code; in pull mode, also the key
 * the harness trusts.
 */
export async function containerChecks(opts: {
  brokerDir: string;
  /** Folders the set-id check leaves out (setIdCheck). */
  skip?: string[];
  procDir?: string;
  rootDir?: string;
  waitMs?: number;
  controlKey?: { file: string; sha256: string } | undefined;
}): Promise<Record<string, string>> {
  return {
    "supervisor-user": await supervisorUserCheck(opts.procDir, opts.waitMs),
    "supervisor-gpu": supervisorGpuCheck(opts.brokerDir),
    "setid-files": setIdCheck(opts.rootDir, opts.skip),
    "runpod-variables": runpodCheck(opts.procDir),
    "enroll-code": enrollCodeCheck(opts.procDir),
    ...(opts.controlKey
      ? { "control-key": controlKeyCheck(opts.controlKey.file, opts.controlKey.sha256) }
      : {}),
  };
}

/** The shared-mode record the broker wrote, if any (its fence, or why it could not be set up). */
function sharedRecord(socketPath: string): LayoutRecord | undefined {
  try {
    const r = JSON.parse(
      readFileSync(join(dirname(socketPath), LAYOUT_FILE), "utf8"),
    ) as LayoutRecord;
    return "mode" in r && r.mode === "shared" ? r : undefined;
  } catch {
    return undefined;
  }
}

function firstKitFile(kitsDir: string): string | undefined {
  if (!existsSync(kitsDir)) return undefined;
  for (const commit of readdirSync(kitsDir)) {
    const f = join(kitsDir, commit, "kit.json");
    if (existsSync(f)) return f;
  }
  return undefined;
}

function firstBuildFile(buildsDir: string): string | undefined {
  if (!existsSync(buildsDir)) return undefined;
  for (const key of readdirSync(buildsDir)) {
    const manifest = join(buildsDir, key, "manifest.json");
    if (!existsSync(manifest)) continue;
    const files = Object.keys(
      (JSON.parse(readFileSync(manifest, "utf8")) as { files: Record<string, string> }).files,
    );
    if (files[0]) return join(buildsDir, key, files[0]);
  }
  return undefined;
}

/**
 * Why the rig is too busy for the selftest, if it is. Each probe ends by killing every process
 * of its role's user (as every run does), so probing while a worker, a dev run or a timed run is
 * live would kill it.
 */
export function busyReason(stateDir: string): string | undefined {
  const path = join(stateDir, "ledger", "ledger.db");
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    const trials = n("select count(*) as n from trial where ended_at is null");
    const jobs = n("select count(*) as n from job where state in ('queued', 'leased')");
    if (trials || jobs) {
      return `${trials} open trial(s) and ${jobs} judge job(s): pause the rig's runs and let the judge finish first (each probe kills its role's processes)`;
    }
    return undefined;
  } finally {
    db.close();
  }
}

/** The users of agent calls outside trials, which the ledger does not show as open. */
const CALL_ROLES: { role: Role; what: string }[] = [
  { role: "planner", what: "a planner call" },
  { role: "model-check", what: "a model check" },
];

/**
 * Why probing now would kill a planner call or a model check, if it would: a process of its user
 * is running. Each probe kills its role's processes, as every run does.
 */
export function callsBusy(procs: Pick<Proc, "uid">[]): string | undefined {
  const live = CALL_ROLES.filter(({ role }) => procs.some((p) => p.uid === roleIds(role).uid));
  if (!live.length) return undefined;
  return `${live.map((c) => c.what).join(" and ")} ${live.length > 1 ? "are" : "is"} running: wait for ${live.length > 1 ? "them" : "it"} to end (each probe kills its role's processes)`;
}

/** Why the isolation selftest should not probe now: open trials or judge jobs, or a live call. */
export function isolationBusy(
  stateDir: string,
  procs: () => Pick<Proc, "uid">[] = listProcesses,
): string | undefined {
  return busyReason(stateDir) ?? callsBusy(procs());
}

/**
 * The roles probed by default: the builder, each judge card's timing user, the planner's and the
 * model check's users, and lane 1's users (every lane's are made the same way).
 */
export function probedRoles(judgeCards = 1): Role[] {
  return [
    "builder",
    "run",
    // Each further judge card's timing user.
    ...Array.from({ length: Math.max(0, judgeCards - 1) }, (_, i) => runRole(i + 1)),
    "planner",
    "model-check",
    "lane-1",
    "lane-1-dev",
    "agent-1",
  ] as Role[];
}

export async function isolationSelftest(opts: {
  socketPath: string;
  stateDir: string;
  scratchDir: string;
  outboxDir: string;
  secretFiles: string[];
  roles?: Role[];
  /** The rig is configured for a dedicated development card (THERMITE_DEV_GPU_INDEX). */
  dedicated?: boolean;
  /** Probe even while trials or judge jobs are live (they may be killed). */
  force?: boolean;
  /** The controller's pid, when the controller itself runs the selftest (a rig check). */
  controllerPid?: number;
  /** The one-container rig image (oneContainerTargets): the supervisor shares the container. */
  oneContainer?: OneContainerTargets | undefined;
}): Promise<IsolationReport> {
  const busy = opts.force ? undefined : isolationBusy(opts.stateDir);
  if (busy) throw new Error(`the rig is busy: ${busy}; rerun with --force to probe anyway`);
  const skipped: string[] = [];
  // First, as it waits for a supervisor that is still starting.
  const container = opts.oneContainer
    ? await containerChecks({
        brokerDir: dirname(opts.socketPath),
        skip: [opts.scratchDir],
        controlKey: opts.oneContainer.controlKey,
      })
    : undefined;
  const probes: Probe[] = [
    { name: "ledger", op: "read", path: join(opts.stateDir, "ledger", "ledger.db") },
    { name: "state-list", op: "list", path: opts.stateDir },
    { name: "kits", op: "list", path: join(opts.stateDir, "kits") },
    { name: "git-mirrors", op: "list", path: join(opts.stateDir, "git") },
    { name: "models-list", op: "list", path: join(opts.stateDir, "models") },
    { name: "builds-list", op: "list", path: join(opts.stateDir, "builds") },
    { name: "broker-socket", op: "access", path: opts.socketPath },
    { name: "outbox-write", op: "access", path: opts.outboxDir },
    { name: "outbox-read", op: "list", path: opts.outboxDir },
    { name: "runs-list", op: "list", path: join(opts.scratchDir, "thermite", "runs") },
    { name: "tmp-create", op: "create", path: "/tmp" },
    { name: "var-tmp-create", op: "create", path: "/var/tmp" },
    { name: "shm-create", op: "create", path: "/dev/shm" },
    // The container's first process holds what the container was started with (on RunPod, its
    // API key among it); nor may any process a role can read hold one of RunPod's variables.
    { name: "pid1-environ", op: "read", path: "/proc/1/environ" },
    { name: "runpod-variables", op: "runpod", path: "/proc" },
  ];
  const pod = opts.oneContainer;
  if (pod) {
    probes.push(
      { name: "supervisor-home", op: "list", path: pod.supervisorHome },
      { name: "supervisor-token", op: "read", path: pod.supervisorToken },
      { name: "inbox-list", op: "list", path: pod.inboxDir },
    );
    const sup = pidsRunning(SUPERVISOR_SCRIPT)[0];
    if (sup) probes.push({ name: "supervisor-environ", op: "read", path: `/proc/${sup}/environ` });
    else skipped.push("supervisor-environ (supervisor not found)");
    // Pull mode: the key the harness trusts for control's commands.
    if (pod.controlKey)
      probes.push({ name: "control-key-write", op: "access", path: pod.controlKey.file });
  }
  const kitFile = firstKitFile(join(opts.stateDir, "kits"));
  if (kitFile) probes.push({ name: "kit-by-path", op: "read", path: kitFile });
  else skipped.push("kit-by-path (no kit checked out yet)");
  for (const f of opts.secretFiles) probes.push({ name: `secret:${f}`, op: "read", path: f });
  const build = firstBuildFile(join(opts.stateDir, "builds"));
  if (build) probes.push({ name: "build-overwrite", op: "write", path: build });
  else skipped.push("build-overwrite (no build yet)");
  // A run's copy of the kit's run.copy paths, made as the judge makes it and owned by the
  // controller's user: the run user reads it, and no role may change or add to it.
  const runKit = join(opts.scratchDir, "thermite", "selftest-run-kit");
  removeOwnTree(runKit);
  mkdirSync(join(runKit, "src", "run"), { recursive: true });
  writeFileSync(join(runKit, "src", "run", "driver.sh"), "#!/bin/sh\n", { mode: 0o755 });
  copyForRun(join(runKit, "src"), ["run"], join(runKit, "kit"));
  walk(join(runKit, "kit"), (p) => chownSync(p, IDS.thermite.uid, IDS.thermite.gid));
  const driver = join(runKit, "kit", "run", "driver.sh");
  probes.push(
    { name: "run-kit-write", op: "write", path: driver },
    { name: "run-kit-create", op: "create", path: join(runKit, "kit", "run") },
  );
  const pid = opts.controllerPid ?? controllerPid();
  if (pid) probes.push({ name: "controller-environ", op: "read", path: `/proc/${pid}/environ` });
  else skipped.push("controller-environ (controller not found)");
  const nodes = (existsSync("/dev") ? readdirSync("/dev") : [])
    .filter((d) => d.startsWith("nvidia") && !statSync(join("/dev", d)).isDirectory())
    .map((d) => join("/dev", d));
  // A dedicated development card is probed as the broker set it up; a failed setup fails here.
  const card = opts.dedicated ? readLayout(opts.socketPath) : {};
  const cards = card.layout ? cardsOf(card.layout) : undefined;
  // Shared mode: how the broker keeps roles off the nodes, or why it could not.
  const shared = opts.dedicated ? undefined : sharedRecord(opts.socketPath);
  const sharedError = shared && !shared.ok ? shared.error : undefined;
  const devices = cards
    ? `dedicated: judge ${cards.judges.map((c) => c.node).join(", ")}, development ${cards.devs.map((c) => c.node).join(", ")}`
    : card.error
      ? `dedicated, NOT SET UP: ${card.error}`
      : sharedError
        ? `shared, NOT SET UP: ${sharedError}`
        : shared?.ok && shared.fence
          ? `shared (fence: ${shared.fence})`
          : "shared";

  const client = new BrokerClient(opts.socketPath);
  const roles = opts.roles ?? probedRoles(cards?.judges.length ?? 1);
  // A lane's development run is the lane's user with the device group: probed as itself too,
  // once on each development card.
  const subjects = roles.flatMap((role) =>
    role === "lane-1"
      ? [
          { key: role, role, gpu: false, card: 0 },
          ...(cards?.devs ?? [undefined]).map((_, k) => ({
            key: k ? `lane-1+gpu@${k + 1}` : "lane-1+gpu",
            role,
            gpu: true,
            card: k,
          })),
        ]
      : [{ key: role as string, role, gpu: false, card: judgeCardOf(role) ?? 0 }],
  );
  const report: IsolationReport = {
    ok:
      card.error === undefined &&
      sharedError === undefined &&
      !Object.values(container ?? {}).some(isFailure),
    devices,
    roles: {},
    ...(container ? { container } : {}),
    skipped,
  };
  try {
    for (const { key, role, gpu, card: n } of subjects) {
      const cwd = join(opts.scratchDir, "thermite", `selftest-${key}`);
      mkdirSync(cwd, { recursive: true });
      await client.handOver(cwd, role);
      const mine = [...probes, ...deviceProbes(nodes, deviceSide(role, gpu), card.layout, n)];
      if (judgeCardOf(role) !== undefined)
        mine.push({ name: "run-kit-read", op: "readable", path: driver });
      const r = await client.run({
        role,
        argv: [process.execPath, "-e", PROBE, JSON.stringify(mine)],
        cwd,
        timeoutMs: 30_000,
        ...(gpu ? { gpu: true, ...(n ? { devCard: n } : {}) } : {}),
      });
      await client.remove(cwd);
      let results: Record<string, string>;
      try {
        results = JSON.parse(r.stdout) as Record<string, string>;
      } catch {
        results = { probe: `failed: exit ${r.exitCode} ${r.stderr.slice(-200)}` };
      }
      report.roles[key] = results;
      if (Object.values(results).some(isFailure)) report.ok = false;
    }
  } finally {
    client.close();
    removeOwnTree(runKit);
  }
  return report;
}

/** A selftest's outcome in a sentence: what passed, or which probes a role got through. */
export function isolationSummary(report: IsolationReport): string {
  const bad = [
    ...Object.entries(report.container ?? {})
      .filter(([, v]) => isFailure(v))
      .map(([check, v]) => `container ${check}: ${v}`),
    ...Object.entries(report.roles).flatMap(([role, results]) =>
      Object.entries(results)
        .filter(([, v]) => isFailure(v))
        .map(([probe, v]) => `${role} ${probe}: ${v}`),
    ),
  ];
  const roles = Object.keys(report.roles).length;
  if (report.ok)
    return `isolation holds: every probe of ${roles} roles came out as it must (devices: ${report.devices})`;
  return `isolation does NOT hold (devices: ${report.devices}): ${bad.slice(0, 12).join("; ") || "the device setup failed"}`;
}

/**
 * Removes a tree the controller made read-only (a run's kit copy): its directories are opened
 * again first, since only root may remove entries from a directory without write permission.
 */
function removeOwnTree(path: string): void {
  if (!existsSync(path)) return;
  walk(path, (p, isDir) => {
    if (isDir) chmodSync(p, 0o755);
  });
  rmSync(path, { recursive: true, force: true });
}
