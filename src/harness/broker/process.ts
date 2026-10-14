import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Supervised child processes: wall time measured here (outside the child), memory and disk
 * watchdogs, a hard timeout, and cleanup of everything the child left behind.
 *
 * With `uid` set (inside the harness container, where the broker is root) the child runs as that
 * user and cleanup kills every process of that user, which is safe because each role has a
 * dedicated user. Without it (local development) cleanup kills the child's process group.
 */

export interface SupervisedRun {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  uid?: number | undefined;
  gid?: number | undefined;
  /** Kill when the role's resident memory exceeds this. */
  rssLimitBytes?: number | undefined;
  /** Kill when this directory grows beyond this many bytes or entries (inodes) on disk. */
  disk?: { path: string; limitBytes: number; maxEntries?: number | undefined } | undefined;
  /** RLIMIT_NPROC for the role (only with uid; needs prlimit). */
  nproc?: number | undefined;
  /** Written to the child's stdin, then closed. */
  stdin?: string | undefined;
  /** Bytes of stdout and stderr kept (the tail). */
  captureBytes?: number | undefined;
}

export type KilledFor = "timeout" | "memory" | "disk" | null;

export interface SupervisedResult {
  exitCode: number | null;
  signal: string | null;
  killedFor: KilledFor;
  /** From spawn to the child's exit, measured by this process. */
  wallMs: number;
  peakRssBytes: number;
  peakDiskBytes: number;
  peakEntries: number;
  /** Processes still alive when the main process exited (killed then). */
  leftovers: number;
  /** What the role left in shared places, removed after the run. */
  swept: string[];
  stdout: string;
  stderr: string;
}

interface Proc {
  pid: number;
  pgid: number;
  uid: number;
  rssBytes: number;
}

/** All processes, from /proc on Linux or `ps` elsewhere (development machines). */
export function listProcesses(): Proc[] {
  if (existsSync("/proc/self/stat")) {
    const out: Proc[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // Fields after the command name, which is in parentheses and may contain spaces.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const status = readFileSync(`/proc/${name}/status`, "utf8");
        const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
        const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
        out.push({ pid: Number(name), pgid: Number(rest[2]), uid, rssBytes: rssKb * 1024 });
      } catch {
        // the process exited while we looked
      }
    }
    return out;
  }
  const text = execFileSync("ps", ["-A", "-o", "pid=,pgid=,uid=,rss="], { encoding: "utf8" });
  return text
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((f) => f.length === 4 && f.every(Number.isFinite))
    .map(([pid, pgid, uid, rss]) => ({
      pid: pid as number,
      pgid: pgid as number,
      uid: uid as number,
      rssBytes: (rss as number) * 1024,
    }));
}

export interface DiskUsage {
  bytes: number;
  /** Files, directories and links counted (inodes). */
  entries: number;
  /** True when the walk stopped at its depth or entry cap: treat as over any budget. */
  truncated: boolean;
}

/**
 * What a directory tree occupies on disk. Symlinks are not followed. The walk is capped in
 * depth and entries, so a hostile tree (very deep, or millions of empty files) cannot stall it.
 */
export function diskUsage(path: string, maxEntries = 200_000, maxDepth = 128): DiskUsage {
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const stack: [string, number][] = [[path, 0]];
  while (stack.length) {
    const [p, depth] = stack.pop() as [string, number];
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    entries++;
    bytes += Number(st.blocks ?? 0) * 512 || Number(st.size);
    if (entries >= maxEntries) return { bytes, entries, truncated: true };
    if (st.isDirectory()) {
      if (depth >= maxDepth) {
        truncated = true;
        continue;
      }
      try {
        for (const e of readdirSync(p)) stack.push([join(p, e), depth + 1]);
      } catch {
        // unreadable or vanished directory: counted as its own size only
      }
    }
  }
  return { bytes, entries, truncated };
}

function members(scope: { uid?: number | undefined; pgid: number }, procs: Proc[]): Proc[] {
  return scope.uid !== undefined
    ? procs.filter((p) => p.uid === scope.uid)
    : procs.filter((p) => p.pgid === scope.pgid);
}

/**
 * Kills every process of a user (or a process group). For a user it runs kill(-1, SIGKILL) as
 * that user, which the kernel applies to all of the user's processes at once, so a fork bomb
 * cannot outrun it; it repeats until none are left.
 */
export function killScope(scope: { uid?: number | undefined; pgid?: number | undefined }): number {
  if (scope.uid === undefined) {
    if (scope.pgid === undefined) return 0;
    let n = 0;
    for (let round = 0; round < 20; round++) {
      try {
        process.kill(-scope.pgid, "SIGKILL");
        n++;
      } catch {
        return n;
      }
    }
    return n;
  }
  let killed = 0;
  for (let round = 0; round < 10; round++) {
    const victims = listProcesses().filter((p) => p.uid === scope.uid);
    if (!victims.length) return killed;
    killed += victims.length;
    spawnSync(process.execPath, ["-e", "try { process.kill(-1, 'SIGKILL') } catch {}"], {
      uid: scope.uid,
      gid: scope.uid,
      stdio: "ignore",
      timeout: 5000,
    });
  }
  return killed;
}

/**
 * Removes what a role left in the shared places it could reach anyway: files it owns at the top
 * of /tmp, /var/tmp and /dev/shm, and its SysV shared memory, semaphores and message queues.
 * (The broker also closes those directories to roles; this is the second line.)
 */
export function sweepRole(uid: number): string[] {
  const swept: string[] = [];
  for (const dir of ["/tmp", "/var/tmp", "/dev/shm"]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (lstatSync(p).uid === uid) {
          rmSync(p, { recursive: true, force: true });
          swept.push(p);
        }
      } catch {
        // gone already
      }
    }
  }
  for (const [kind, flag] of [
    ["shm", "-m"],
    ["sem", "-s"],
    ["msg", "-q"],
  ] as const) {
    const table = `/proc/sysvipc/${kind}`;
    if (!existsSync(table)) continue;
    const [header, ...rows] = readFileSync(table, "utf8").trim().split("\n");
    const cols = (header ?? "").trim().split(/\s+/);
    const idCol = cols.indexOf(kind === "shm" ? "shmid" : kind === "sem" ? "semid" : "msqid");
    const uidCol = cols.indexOf("uid");
    for (const row of rows) {
      const f = row.trim().split(/\s+/);
      if (Number(f[uidCol]) !== uid) continue;
      try {
        execFileSync("ipcrm", [flag, String(f[idCol])], { stdio: "ignore" });
        swept.push(`sysv ${kind} ${f[idCol]}`);
      } catch {
        // removed already
      }
    }
  }
  return swept;
}

const PRLIMIT = ["/usr/bin/prlimit", "/bin/prlimit"].find((p) => existsSync(p));

export function runSupervised(spec: SupervisedRun): Promise<SupervisedResult> {
  if (spec.uid === 0) throw new Error("refusing to run supervised work as root");
  const cap = spec.captureBytes ?? 64 * 1024;
  // A process limit for the role (a fork bomb stays small), set by prlimit before exec.
  const argv =
    spec.uid !== undefined && spec.nproc !== undefined && PRLIMIT
      ? [PRLIMIT, `--nproc=${spec.nproc}`, "--", ...spec.argv]
      : [...spec.argv];
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: [spec.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      ...(spec.uid !== undefined ? { uid: spec.uid } : {}),
      ...(spec.gid !== undefined ? { gid: spec.gid } : {}),
    });
    const pgid = child.pid ?? -1;
    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined); // the child may exit without reading
      child.stdin.end(spec.stdin);
    }
    let stdout = "";
    let stderr = "";
    const keep = (prev: string, d: Buffer) => {
      const next = prev + d.toString("utf8");
      return next.length > cap ? next.slice(next.length - cap) : next;
    };
    child.stdout?.on("data", (d: Buffer) => {
      stdout = keep(stdout, d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = keep(stderr, d);
    });

    let killedFor: KilledFor = null;
    let peakRss = 0;
    let peakDisk = 0;
    let peakEntries = 0;
    let leftovers = 0;
    let exitWallMs: number | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const scope = { uid: spec.uid, pgid };
    const killAll = () => killScope(spec.uid !== undefined ? { uid: spec.uid } : { pgid });
    const kill = (why: KilledFor) => {
      if (killedFor === null && exitWallMs === undefined) killedFor = why;
      killAll();
    };
    const sampleDisk = () => {
      if (!spec.disk) return;
      const d = diskUsage(spec.disk.path, spec.disk.maxEntries ?? 50_000);
      peakDisk = Math.max(peakDisk, d.bytes);
      peakEntries = Math.max(peakEntries, d.entries);
      if (d.bytes > spec.disk.limitBytes || d.truncated) kill("disk");
    };

    const timer = setTimeout(() => kill("timeout"), spec.timeoutMs);
    let ticks = 0;
    const watch = setInterval(() => {
      ticks++;
      if (spec.rssLimitBytes !== undefined || ticks % 5 === 0) {
        try {
          const rss = members(scope, listProcesses()).reduce((s, p) => s + p.rssBytes, 0);
          peakRss = Math.max(peakRss, rss);
          if (spec.rssLimitBytes !== undefined && rss > spec.rssLimitBytes) kill("memory");
        } catch {
          // process listing failed this tick; try again on the next
        }
      }
      if (ticks % 5 === 0) sampleDisk();
    }, 100);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      clearInterval(watch);
      // Nothing a run started may outlive it.
      killAll();
      const swept = spec.uid !== undefined ? sweepRole(spec.uid) : [];
      sampleDisk();
      // A breach between two samples still counts, even if the child finished first.
      if (killedFor === null && spec.disk && peakDisk > spec.disk.limitBytes) killedFor = "disk";
      if (killedFor === null && spec.rssLimitBytes !== undefined && peakRss > spec.rssLimitBytes) {
        killedFor = "memory";
      }
      resolve({
        exitCode,
        signal: exitSignal,
        killedFor,
        wallMs: exitWallMs ?? Number(process.hrtime.bigint() - started) / 1e6,
        peakRssBytes: peakRss,
        peakDiskBytes: peakDisk,
        peakEntries,
        leftovers,
        swept,
        stdout,
        stderr,
      });
    };
    // Even if the pipes never close (a process stuck in a driver, a survivor holding them), the
    // run ends: timeout plus a grace period.
    const deadline = setTimeout(() => {
      if (killedFor === null) killedFor = "timeout";
      finish();
    }, spec.timeoutMs + 15_000);
    child.on("exit", (code, signal) => {
      exitWallMs = Number(process.hrtime.bigint() - started) / 1e6;
      exitCode = code;
      exitSignal = signal;
      // Background children may hold the pipes open; kill them so "close" follows promptly.
      leftovers = members(scope, listProcesses()).length;
      killAll();
    });
    child.on("error", (err) => {
      stderr += String(err);
      exitWallMs ??= Number(process.hrtime.bigint() - started) / 1e6;
      finish();
    });
    child.on("close", finish);
  });
}
