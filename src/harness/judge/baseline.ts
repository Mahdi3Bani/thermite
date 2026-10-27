import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../ledger.ts";
import { statusEvents } from "../run-status.ts";

/**
 * A hill climb's baseline (goal 115): the judge's first job for a run measures its starting point
 * on every cell, and everything after is held against those values. This module holds what the
 * judge, the scheduler and the service all read: where a run starts, whether the judge has
 * measured it, and the judge-only folder the kit's check may keep files in.
 *
 * The record is the ledger's events: `baseline` (the values), `baseline_failed` (why the starting
 * point can't be measured yet: the run is in setup) and the champion rows. A starting point is the
 * seed (champion #1) or a champion a setup change became (its `promoted_by` ends in SETUP_MARK).
 * No ledger table is needed, so a ledger from before needs no migration.
 */

/** The blocks of the baseline: each runs every cell `acceptance.runs_per_cell` times. */
export const BASELINE_BLOCKS = 3;
/**
 * The baseline job's priority: ahead of every other judge job (validate 40 or 60, confirm 50,
 * evaluate 100, calibrate 200; the lowest number goes first).
 */
export const BASELINE_PRIORITY = 10;
/** What the kit's check may keep in the baseline's folder: bytes in all, and files. */
export const BASELINE_DIR_BYTES = 64 * 1024 * 1024;
export const BASELINE_DIR_FILES = 1000;
/**
 * After a baseline job failed in the judge (not the starting point's fault), it is tried again at
 * once, as a candidate's `crash_infra` is; after a second such failure, each next try waits.
 */
export const BASELINE_RETRY_MS = 10 * 60_000;
/** The direction of a setup round's experiments. */
export const SETUP_FAMILY = "setup";
/** The end of `promoted_by` on a champion a setup change became: a new starting point. */
export const SETUP_MARK = ":setup";

/** One metric on one cell of the starting point: over the baseline's blocks. */
export interface BaselineValue {
  /** The median of the blocks' values (each block's value is the median of its runs). */
  median: number;
  /** The median absolute deviation of the blocks' values from their median. */
  mad: number;
  /** How many blocks gave a value. */
  n: number;
}

export interface BaselineFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** The body of a `baseline` event. */
export interface Baseline {
  run: string;
  job: number;
  /** The starting point the values are of: its champion number and commit. */
  champion_seq: number;
  commit: string;
  /** The setup change that became the starting point; null for the seed. */
  attempt: string | null;
  blocks: number;
  runs_per_cell: number;
  /** The contract's main metric and guards, so a reader knows which values are which. */
  primary: { metric: string; direction: "max" | "min" };
  guards: { metric: string; direction: "max" | "min"; max_total_regression: number }[];
  /** Each kit metric's unit. */
  units: Record<string, string>;
  /** cell -> metric -> value: every kit metric on every measured cell (never a held-out one). */
  cells: Record<string, Record<string, BaselineValue>>;
  /** What the kit's check kept in the baseline's folder, sorted by path. */
  files: BaselineFile[];
  bytes: number;
  summary: string;
}

/** The body of a `baseline_failed` event: the starting point can't be measured yet. */
export interface BaselineFailure {
  run: string;
  job: number;
  champion_seq: number;
  commit: string;
  reasons: string;
  summary: string;
}

export interface StartingPoint {
  seq: number;
  commit: string;
  attempt: string | null;
}

/**
 * Where a run starts: its newest starting point that no invalidation reopened, the seed or a
 * setup change's champion. Before a baseline exists it is the champion: nothing is promoted
 * until then.
 */
export function startingPoint(ledger: Ledger, run: string): StartingPoint {
  const r = ledger.db
    .prepare(
      `select seq, commit_sha, attempt from champion where run = ? and reopened = 0
         and (seq = 1 or promoted_by like ?) order by seq desc limit 1`,
    )
    .get(run, `%${SETUP_MARK}`) as
    | { seq: number; commit_sha: string; attempt: string | null }
    | undefined;
  if (!r) {
    const c = ledger.champions.current(run);
    return { seq: c.seq, commit: c.commit_sha, attempt: c.attempt };
  }
  return { seq: Number(r.seq), commit: String(r.commit_sha), attempt: r.attempt ?? null };
}

function newest<T>(
  ledger: Ledger,
  kind: "baseline" | "baseline_failed",
  run: string,
  seq: number,
): (T & { id: number; at: string }) | undefined {
  const e = ledger.events.newest(kind, { subject: run, body: { champion_seq: seq } });
  return e && { ...(e.body as T), id: e.id, at: e.at };
}

/** The run's baseline: the judge's values of its starting point, if it measured them. */
export function baselineOf(
  ledger: Ledger,
  run: string,
  start: StartingPoint = startingPoint(ledger, run),
): (Baseline & { id: number; at: string }) | undefined {
  return newest<Baseline>(ledger, "baseline", run, start.seq);
}

/** Why the judge could not measure the run's starting point, if it tried and could not. */
export function baselineFailure(
  ledger: Ledger,
  run: string,
  start: StartingPoint = startingPoint(ledger, run),
): (BaselineFailure & { id: number; at: string }) | undefined {
  return newest<BaselineFailure>(ledger, "baseline_failed", run, start.seq);
}

export type BaselineState =
  | { state: "measured"; start: StartingPoint; baseline: Baseline & { id: number; at: string } }
  /** The starting point can't be measured yet: the lanes work to make it build and run. */
  | {
      state: "setup";
      start: StartingPoint;
      failure: BaselineFailure & { id: number; at: string };
    }
  /** The judge has not measured it yet; `infra`: its last try failed in the judge itself. */
  | { state: "waiting"; start: StartingPoint; infra?: { error: string; at: string } | undefined };

/** A hill climb's baseline state; undefined for a run in another mode. */
export function baselineState(ledger: Ledger, run: string): BaselineState | undefined {
  if (ledger.runs.get(run)?.mode !== "hill_climb") return undefined;
  const start = startingPoint(ledger, run);
  const baseline = baselineOf(ledger, run, start);
  if (baseline) return { state: "measured", start, baseline };
  const failure = baselineFailure(ledger, run, start);
  if (failure) return { state: "setup", start, failure };
  const last = lastStartJob(ledger, run, start.seq);
  return {
    state: "waiting",
    start,
    ...(last?.state === "failed"
      ? { infra: { error: String(last.error ?? "the judge failed"), at: last.updated_at } }
      : {}),
  };
}

/** How many baseline jobs of a run's starting point failed in the judge itself. */
function failedStartJobs(ledger: Ledger, run: string, seq: number): number {
  return Number(
    (
      ledger.db
        .prepare(
          `select count(*) as n from job
             where kind = 'baseline' and attempt is null and state = 'failed'
               and json_extract(spec, '$.run') = ? and json_extract(spec, '$.champion_seq') = ?`,
        )
        .get(run, seq) as { n: number }
    ).n,
  );
}

/** The newest baseline job of a run's starting point (not a setup change's). */
function lastStartJob(
  ledger: Ledger,
  run: string,
  seq: number,
): { id: number; state: string; updated_at: string; error: string | null } | undefined {
  return ledger.db
    .prepare(
      `select id, state, updated_at, json_extract(result, '$.error') as error from job
         where kind = 'baseline' and attempt is null and json_extract(spec, '$.run') = ?
           and json_extract(spec, '$.champion_seq') = ? order by id desc limit 1`,
    )
    .get(run, seq) as
    | { id: number; state: string; updated_at: string; error: string | null }
    | undefined;
}

/**
 * Whether the judge should queue a baseline job for the run's starting point now: it has no
 * baseline and none is queued or running; not when it failed (the run is in setup) unless the run
 * was resumed since, which tries it again; and, after two tries that failed in the judge itself,
 * not within BASELINE_RETRY_MS of the newest (the first such failure is tried again at once).
 */
export function baselineDue(ledger: Ledger, run: string, now = Date.now()): StartingPoint | false {
  const s = baselineState(ledger, run);
  if (!s || s.state === "measured") return false;
  const last = lastStartJob(ledger, run, s.start.seq);
  if (last && (last.state === "queued" || last.state === "leased")) return false;
  // In setup, only a resume since the failure tries the starting point again: a try that fails
  // again records a newer failure, so each resume gives one try.
  if (
    s.state === "setup" &&
    !statusEvents(ledger, run, s.failure.id).some((e) => e.status === "running")
  )
    return false;
  if (
    last?.state === "failed" &&
    failedStartJobs(ledger, run, s.start.seq) > 1 &&
    now - Date.parse(last.updated_at) < BASELINE_RETRY_MS
  )
    return false;
  return s.start;
}

/** The judge-only folder of one baseline job: `<state>/baselines/<run>/job-<id>`. */
export function baselineDir(stateDir: string, run: string, job: number): string {
  return join(stateDir, "baselines", run, `job-${job}`);
}

/**
 * A fresh, empty folder for a baseline job, mode 0700 and owned by the judge, as are the folders
 * above it: no run user can reach it. An earlier try of the same job's folder is removed first.
 */
export function prepareBaselineDir(stateDir: string, run: string, job: number): string {
  const top = join(stateDir, "baselines");
  for (const d of [top, join(top, run)]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  const dir = baselineDir(stateDir, run, job);
  removeBaselineDir(dir);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Removes a baseline folder, read-only or not. */
export function removeBaselineDir(dir: string): void {
  if (!existsSync(dir)) return;
  const open = (p: string) => {
    chmodSync(p, 0o700);
    for (const e of readdirSync(p)) {
      const q = join(p, e);
      if (lstatSync(q).isDirectory()) open(q);
    }
  };
  open(dir);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Seals a baseline job's folder once its check has written to it: regular files and folders only
 * (a link could point a later check at other files), at most BASELINE_DIR_FILES files and
 * BASELINE_DIR_BYTES in all. Each file is hashed; then files become 0400 and folders 0500, so
 * later jobs' checks read them and cannot change them. Returns the files, or why it refused.
 */
export function sealBaselineDir(
  dir: string,
  limits: { bytes: number; files: number } = {
    bytes: BASELINE_DIR_BYTES,
    files: BASELINE_DIR_FILES,
  },
): { ok: true; files: BaselineFile[]; bytes: number } | { ok: false; reason: string } {
  const files: BaselineFile[] = [];
  const dirs: string[] = [];
  let bytes = 0;
  const walk = (p: string, rel: string, depth: number): string | undefined => {
    const st = lstatSync(p);
    if (st.isDirectory()) {
      if (depth > 32) return `the folder is deeper than 32 levels at ${rel}`;
      dirs.push(p);
      for (const e of readdirSync(p).sort()) {
        const why = walk(join(p, e), rel ? `${rel}/${e}` : e, depth + 1);
        if (why) return why;
      }
      return undefined;
    }
    if (!st.isFile()) return `${rel} is not a regular file`;
    if (st.nlink > 1) return `${rel} is a hard link`;
    bytes += st.size;
    if (files.length >= limits.files)
      return `it holds more than ${limits.files} files, the most it may keep`;
    if (bytes > limits.bytes)
      return `it holds more than ${mib(limits.bytes)}, the most it may keep`;
    files.push({
      path: rel,
      bytes: st.size,
      sha256: createHash("sha256").update(readFileSync(p)).digest("hex"),
    });
    return undefined;
  };
  const why = walk(dir, "", 0);
  if (why) return { ok: false, reason: `the kit's check wrote to the baseline's folder: ${why}` };
  for (const f of files) chmodSync(join(dir, f.path), 0o400);
  for (const d of dirs.reverse()) chmodSync(d, 0o500);
  return { ok: true, files, bytes };
}

const mib = (n: number) => `${Math.round(n / (1024 * 1024))} MiB`;

/** The median of some numbers (the mean of the two middle ones for an even count). */
export function median(xs: readonly number[]): number {
  const v = [...xs].sort((p, q) => p - q);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
}

/** One metric's value over the blocks: their median, median absolute deviation and count. */
export function baselineValue(xs: readonly number[]): BaselineValue {
  const m = median(xs);
  return { median: m, mad: median(xs.map((x) => Math.abs(x - m))), n: xs.length };
}

/**
 * Sum of guard effects (log ratios) of the promoted steps since the run's starting point: the
 * seed, or the champion a setup change became (goal 115).
 */
export function guardTotals(ledger: Ledger, run: string): Record<string, number> {
  const totals: Record<string, number> = {};
  const rows = ledger.db
    .prepare(
      "select attempt from champion where run = ? and reopened = 0 and attempt is not null and seq > ?",
    )
    .all(run, startingPoint(ledger, run).seq) as { attempt: string }[];
  for (const r of rows) {
    const v = ledger.db
      .prepare(
        "select guards from verdict where attempt = ? and verdict = 'win_confirmed' order by id desc limit 1",
      )
      .get(r.attempt) as { guards: string } | undefined;
    for (const g of JSON.parse(v?.guards ?? "[]") as { metric: string; estimate: number }[]) {
      totals[g.metric] = (totals[g.metric] ?? 0) + g.estimate;
    }
  }
  return totals;
}
