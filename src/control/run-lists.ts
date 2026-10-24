import { z } from "zod";

/**
 * A run's detail of a size an agent can read (goal 128), for MCP's get_run and REST's
 * GET /v1/rigs/<rig>/runs/<run>. A run's view holds lists that grow with the run, such as its
 * journal and timeline: a research run of a day gave 3.2 million characters. Each list is cut to
 * its newest entries (the views keep them oldest first), and the research report to its first
 * characters. Nothing is cut without a word: `cut` says what was left out and how to read it, and
 * `list` with `offset` pages through one list.
 */

/** Entries of each list given by default. */
export const RUN_LIST_LIMIT = 10;
/** Characters of the research report given by default. */
export const REPORT_CHARS = 4000;

/** The arguments, as MCP's schema; REST reads the same from its query. */
export const RUN_DETAIL_INPUT = {
  rig: z.string().min(1),
  run: z.string().min(1),
  attempts: z.number().int().min(1).max(500).default(50),
  limit: z.number().int().min(1).max(500).default(RUN_LIST_LIMIT),
  list: z.string().min(1).max(40).optional(),
  offset: z.number().int().min(0).default(0),
  full_report: z.boolean().default(false),
};

/** The arguments' words, for the tool's description. */
export const RUN_DETAIL_WORDS = `Each list that grows with the run (journal, timeline, queue, hypotheses, trials, reviews and the others) gives its newest ${RUN_LIST_LIMIT} entries by default (limit sets how many), and the research report its first ${REPORT_CHARS} characters (full_report: true gives it whole); cut says what was left out. list names one list and gives only it, its newest entries first skipped by offset, to page back through it`;

export interface RunDetailArgs {
  attempts: number;
  limit: number;
  list?: string | undefined;
  offset: number;
  full_report: boolean;
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * A run's view cut to a readable size, or one of its lists. Attempts, the newest first, are cut
 * by `attempts`, as before; every other list by `limit`.
 */
export function runDetail(
  view: { id: string; attempts: unknown[] },
  o: RunDetailArgs,
): Record<string, unknown> {
  const run = view as Record<string, unknown> & typeof view;
  const lists = Object.keys(run).filter((k) => k !== "attempts" && Array.isArray(run[k]));
  if (o.list !== undefined) {
    const all = run[o.list];
    if (!Array.isArray(all))
      throw new Error(
        `the run has no list ${o.list}: its lists are ${["attempts", ...lists].join(", ")}`,
      );
    const to = Math.max(0, all.length - o.offset);
    const from = Math.max(0, to - o.limit);
    return { id: run.id, list: o.list, total: all.length, from, to, entries: all.slice(from, to) };
  }
  const out: Record<string, unknown> = { ...run };
  const cut: string[] = [];
  out.attempts = run.attempts.slice(-o.attempts).reverse();
  if (run.attempts.length > o.attempts)
    cut.push(
      `attempts: the newest ${count(o.attempts)} of ${count(run.attempts.length)} (attempts gives more)`,
    );
  for (const k of lists) {
    const all = run[k] as unknown[];
    if (all.length <= o.limit) continue;
    out[k] = all.slice(-o.limit);
    cut.push(
      `${k}: the newest ${count(o.limit)} of ${count(all.length)} entries (list "${k}" with offset reads older ones)`,
    );
  }
  const research = run.research as { report?: unknown } | null | undefined;
  if (
    !o.full_report &&
    typeof research?.report === "string" &&
    research.report.length > REPORT_CHARS
  ) {
    out.research = { ...research, report: `${research.report.slice(0, REPORT_CHARS)}…` };
    cut.push(
      `research.report: its first ${count(REPORT_CHARS)} of ${count(research.report.length)} characters (full_report: true gives it whole)`,
    );
  }
  if (cut.length) out.cut = cut;
  return out;
}
