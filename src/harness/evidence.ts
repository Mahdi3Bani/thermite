import { GitError, readableDiff, treeFile, treeFiles } from "./git.ts";
import { clipReason } from "./judge/reasons.ts";
import { type Ledger, LedgerError } from "./ledger.ts";
import type { ExperimentQueue } from "./queue.ts";

/**
 * What the teachers may read of a run's code and evidence (goal 081), read only: the champion's
 * tree, each attempt's diff, the judge's public findings on each attempt, and what became of each
 * experiment tried, with its cause.
 *
 * Held-out content stays out, by what is read and what is not:
 * - The code is the champion's commit in the run's project repository: the tree every worker
 *   starts from, and the diffs workers wrote. The kit (its cases, checks and references) is in
 *   another repository, which nothing here reads.
 * - The judge's findings are its verdict, its change and its reasons, and the checks that refused
 *   an attempt before it was built (v0). The judge writes held-out results only to its held_out
 *   table, never into a verdict's reasons, a measurement or an event, and a failed confirmation
 *   with held-out cells carries no figures. Nothing here reads the held_out table, measurements
 *   or the judge's jobs.
 */

/** The most entries one listing returns: narrow the folder for the rest. */
export const LIST_MAX = 2000;
/** The most lines one read of a file returns, and the default. */
export const READ_LINES_MAX = 2000;
export const READ_LINES_DEFAULT = 400;
/** The largest file read at all, in bytes. */
export const FILE_BYTES_MAX = 8 * 1024 * 1024;
/** The most characters of a diff one read returns. */
export const DIFF_CHARS = 40_000;

/** A path in a tree: from its top, no `..` part, no leading slash, nothing hidden by a NUL. */
export function treePath(path: string): string {
  const p = path
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (
    p.length > 500 ||
    p.startsWith("/") ||
    p.includes("\0") ||
    p.split("/").some((part) => part === ".." || part === ".")
  )
    throw new LedgerError("invalid", `not a path in the tree: ${path.slice(0, 120)}`);
  return p;
}

/** The judge's public findings on one attempt, and the worker's own words about it. */
export interface AttemptEvidence {
  attempt: string;
  lane: string | null;
  family: string | null;
  /** The queue's experiment the attempt came from, when it had one. */
  experiment: { id: string; title: string } | null;
  hypothesis: string | null;
  lifecycle: string;
  verdict: string | null;
  delta: number | null;
  /** The judge's reasons for its verdict (public: never a held-out result). */
  reasons: string | null;
  /** Why the change was refused before it was built (the v0 checks), when it was. */
  refused_before_building: string[];
  /** Only in one attempt's full evidence: its claim and its declared flaws. */
  claim?: string | null;
  known_flaws?: string[];
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function evidenceOf(
  ledger: Ledger,
  a: Row,
  o: { reasonChars: number; hypothesisChars: number; full: boolean },
): AttemptEvidence {
  const id = String(a.id);
  const v = ledger.currentVerdict(id);
  const row = v
    ? (ledger.db.prepare("select delta, reasons from verdict where id = ?").get(v.id) as
        | { delta: number | null; reasons: string }
        | undefined)
    : undefined;
  const x = ledger.db
    .prepare("select id, title from experiment where attempt = ? order by updated_at desc limit 1")
    .get(id) as { id: string; title: string } | undefined;
  let violations: string[] = [];
  try {
    violations = a.v0
      ? ((JSON.parse(String(a.v0)) as { violations?: string[] }).violations ?? [])
      : [];
  } catch {
    violations = [];
  }
  const hyp = str(a.hypothesis);
  return {
    attempt: id,
    lane: str(a.lane),
    family: str(a.family),
    experiment: x ? { id: x.id, title: x.title } : null,
    hypothesis: hyp === null ? null : clipReason(hyp, o.hypothesisChars),
    lifecycle: String(a.lifecycle),
    verdict: v?.verdict ?? null,
    delta: typeof row?.delta === "number" ? row.delta : null,
    reasons: row?.reasons ? clipReason(row.reasons, o.reasonChars) : null,
    refused_before_building: violations.map((s) => clipReason(String(s), o.reasonChars)),
    ...(o.full
      ? {
          claim: str(a.claim),
          known_flaws: (() => {
            try {
              return JSON.parse(String(a.known_flaws ?? "[]")) as string[];
            } catch {
              return [];
            }
          })(),
        }
      : {}),
  };
}

/** The run's newest attempts with the judge's public findings, newest first. */
export function recentAttempts(
  ledger: Ledger,
  run: string,
  o: { limit: number; reasonChars: number; hypothesisChars: number },
): AttemptEvidence[] {
  const rows = ledger.db
    .prepare("select * from attempt where run = ? order by created_at desc limit ?")
    .all(run, o.limit) as Row[];
  return rows.map((a) => evidenceOf(ledger, a, { ...o, full: false }));
}

/** One attempt of the run, in full (its reasons as the judge kept them). */
export function oneAttempt(ledger: Ledger, run: string, attempt: string): AttemptEvidence {
  const a = ledger.getAttempt(attempt);
  if (!a || String(a.run) !== run)
    throw new LedgerError("not_found", `no attempt ${attempt} in run ${run}`);
  return evidenceOf(ledger, a, { reasonChars: 8000, hypothesisChars: 8000, full: true });
}

/** An experiment tried (done or dropped), with what became of it and why. */
export interface TriedCause {
  id: string;
  title: string;
  family?: string;
  by: string;
  lane?: string;
  /** done: how its trial ended; dropped: dropped. */
  result: string;
  attempt?: string;
  verdict?: string;
  delta?: number;
  /** Why it ended as it did, in words: the judge's reasons, the trial's error, or who dropped it. */
  cause: string;
}

/** The run's newest tried experiments, each with its cause, newest first. */
export function triedCauses(
  ledger: Ledger,
  queue: ExperimentQueue,
  run: string,
  o: { limit: number; causeChars: number },
): TriedCause[] {
  return queue.tried(run, o.limit).map((x) => {
    const base = {
      id: x.id,
      title: x.title,
      ...(x.family ? { family: x.family } : {}),
      by: x.added_by,
      ...(x.lane ? { lane: x.lane } : {}),
    };
    if (x.state === "dropped")
      return {
        ...base,
        result: "dropped",
        cause: clipReason(
          `dropped by ${x.dropped_by ?? "?"}: ${x.dropped_why ?? ""}`.trim(),
          o.causeChars,
        ),
      };
    if (x.attempt) {
      const e = evidenceOf(
        ledger,
        (ledger.getAttempt(x.attempt) ?? { id: x.attempt, lifecycle: "unknown" }) as Row,
        { reasonChars: o.causeChars, hypothesisChars: 200, full: false },
      );
      const said = e.refused_before_building.length
        ? `refused before building: ${e.refused_before_building.join("; ")}`
        : e.reasons
          ? `the judge: ${e.reasons}`
          : `the attempt is ${e.lifecycle}`;
      return {
        ...base,
        result: x.result ?? "submitted",
        attempt: x.attempt,
        ...(e.verdict ? { verdict: e.verdict } : {}),
        ...(e.delta !== null ? { delta: e.delta } : {}),
        cause: clipReason(`${e.verdict ?? e.lifecycle}: ${said}`, o.causeChars),
      };
    }
    const t = x.trial
      ? (ledger.db.prepare("select stopped, error from trial where id = ?").get(x.trial) as
          | { stopped: string | null; error: string | null }
          | undefined)
      : undefined;
    const how = x.result ?? t?.stopped ?? "ended";
    return {
      ...base,
      result: how,
      cause: clipReason(
        `no attempt: the trial ended ${how.replace(/_/g, " ")}${t?.error ? ` (${t.error})` : ""}`,
        o.causeChars,
      ),
    };
  });
}

/** The champion's tree: its files under a folder, with their sizes. */
export async function listChampionFiles(
  mirror: string,
  commit: string,
  folder: string,
): Promise<{ commit: string; folder: string; files: string[]; more: number; note?: string }> {
  const f = treePath(folder);
  const all = await treeFiles(mirror, commit, f);
  const files = all.slice(0, LIST_MAX).map((x) => `${x.path} (${x.size} bytes)`);
  return {
    commit,
    folder: f || ".",
    files,
    more: Math.max(0, all.length - LIST_MAX),
    ...(all.length
      ? all.length > LIST_MAX
        ? { note: `${all.length - LIST_MAX} more files: list a folder to see them` }
        : {}
      : { note: f ? `the champion has no folder or file ${f}` : "the champion's tree is empty" }),
  };
}

/** One file of the champion's tree, with line numbers, `limit` lines from line `offset`. */
export async function readChampionFile(
  mirror: string,
  commit: string,
  path: string,
  offset = 1,
  limit = READ_LINES_DEFAULT,
): Promise<{
  commit: string;
  path: string;
  size: number;
  total_lines?: number;
  from?: number;
  to?: number;
  content?: string;
  note?: string;
}> {
  const p = treePath(path);
  if (!p) throw new LedgerError("invalid", "name a file of the champion's tree");
  let got: Awaited<ReturnType<typeof treeFile>>;
  try {
    got = await treeFile(mirror, commit, p, FILE_BYTES_MAX);
  } catch (err) {
    if (err instanceof GitError) throw new LedgerError("not_found", err.message);
    throw err;
  }
  if (!got) throw new LedgerError("not_found", `the champion has no file ${p}`);
  if (!got.bytes)
    return {
      commit,
      path: p,
      size: got.size,
      note: `too large to read (${got.size} bytes, more than ${FILE_BYTES_MAX})`,
    };
  if (got.bytes.subarray(0, 8000).includes(0))
    return { commit, path: p, size: got.size, note: "a binary file: not shown" };
  const lines = got.bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const from = Math.max(1, Math.floor(offset));
  const n = Math.max(1, Math.min(READ_LINES_MAX, Math.floor(limit)));
  const slice = lines.slice(from - 1, from - 1 + n);
  return {
    commit,
    path: p,
    size: got.size,
    total_lines: lines.length,
    from,
    to: from - 1 + slice.length,
    content: slice.map((l, i) => `${from + i}\t${l}`).join("\n"),
  };
}

/** An attempt's diff from the commit it was built on, `DIFF_CHARS` characters from `offset`. */
export async function readAttemptDiff(
  ledger: Ledger,
  mirror: string,
  run: string,
  attempt: string,
  offset = 0,
): Promise<{
  attempt: string;
  total_chars: number;
  from: number;
  next: number | null;
  diff: string;
}> {
  const a = ledger.getAttempt(attempt);
  if (!a || String(a.run) !== run)
    throw new LedgerError("not_found", `no attempt ${attempt} in run ${run}`);
  let text: string;
  try {
    text = await readableDiff(mirror, String(a.parent_commit), String(a.commit_sha));
  } catch (err) {
    if (err instanceof GitError) throw new LedgerError("not_found", err.message);
    throw err;
  }
  const from = Math.max(0, Math.min(text.length, Math.floor(offset)));
  const to = Math.min(text.length, from + DIFF_CHARS);
  return {
    attempt,
    total_chars: text.length,
    from,
    next: to < text.length ? to : null,
    diff: text.slice(from, to),
  };
}
