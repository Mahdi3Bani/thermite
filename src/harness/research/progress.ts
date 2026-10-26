import type { Ledger } from "../ledger.ts";
import type { TaskYield } from "../queue.ts";

/**
 * Where a research run stands with its items (goal 117): the panel's standing decision on each
 * question and each required hypothesis, whether each question is saturated, and when the run
 * last improved. The review (part B2), the plan (part B1) and the end rules read these; nothing
 * here writes.
 */

/** A question's decision: answered at a certainty, the best that sources allow, or still open. */
export const QUESTION_DECISIONS = ["answered", "insufficient", "open"] as const;
export type QuestionDecision = (typeof QUESTION_DECISIONS)[number];
/** The certainty of an answered question. */
export const ANSWER_CERTAINTIES = ["high", "moderate", "low"] as const;
export type AnswerCertainty = (typeof ANSWER_CERTAINTIES)[number];
/** A required hypothesis's verdict. */
export const HYPOTHESIS_DECISIONS = ["supported", "refuted", "undecided"] as const;
export type HypothesisDecision = (typeof HYPOTHESIS_DECISIONS)[number];

/** A question's last tasks that show it saturated: this many in a row that added nothing new. */
export const SATURATION_TASKS = 4;

/** The progress rule (the owner, 2026-10-24): no improvement for this share of the running time. */
export const PROGRESS_SHARE = 0.25;

/**
 * How good a decision is, to tell an improvement: for a question, open 0, insufficient 1,
 * answered at low 2, moderate 3, high 4; for a hypothesis, undecided 0, supported or refuted 1.
 */
export function decisionRank(
  kind: "question" | "hypothesis",
  decision: string,
  certainty?: string | null,
): number {
  if (kind === "hypothesis") return decision === "supported" || decision === "refuted" ? 1 : 0;
  if (decision === "insufficient") return 1;
  if (decision !== "answered") return 0;
  return certainty === "high" ? 4 : certainty === "moderate" ? 3 : 2;
}

/** A card's certainty as a rank, to tell an improvement: none 0 … high 4. */
export function certaintyRank(certainty: string): number {
  return { none: 0, insufficient: 1, low: 2, moderate: 3, high: 4 }[certainty] ?? 0;
}

export interface StandingDecision {
  kind: "question" | "hypothesis";
  key: string;
  decision: string;
  certainty: string | null;
  review: number;
  card_version: number | null;
  decided_at: string;
}

/** The newest card version of each question of a run, by question index. */
function newestCards(ledger: Ledger, run: string): Map<number, number> {
  return new Map(
    (
      ledger.db
        .prepare(
          "select question, max(version) as v from question_card where run = ? group by question",
        )
        .all(run) as { question: number; v: number }[]
    ).map((r) => [Number(r.question), Number(r.v)]),
  );
}

/**
 * The panel's decisions that still stand, by `kind:key`: the newest decision of each item, unless
 * it is a question's and the question has a newer card than the one it decided on. A question
 * with a newer card is an item to review again.
 */
export function standingDecisions(ledger: Ledger, run: string): Map<string, StandingDecision> {
  const cards = newestCards(ledger, run);
  const rows = ledger.db
    .prepare(
      `select d.* from item_decision d
         join (select kind, key, max(id) as id from item_decision where run = ? group by kind, key) n
           on n.id = d.id`,
    )
    .all(run) as Record<string, unknown>[];
  const out = new Map<string, StandingDecision>();
  for (const r of rows) {
    const kind = String(r.kind) as "question" | "hypothesis";
    const key = String(r.key);
    const version = r.card_version === null ? null : Number(r.card_version);
    if (kind === "question" && (cards.get(Number(key)) ?? 0) > (version ?? 0)) continue;
    out.set(`${kind}:${key}`, {
      kind,
      key,
      decision: String(r.decision),
      certainty: r.certainty === null ? null : String(r.certainty),
      review: Number(r.review),
      card_version: version,
      decided_at: String(r.decided_at),
    });
  }
  return out;
}

/** Whether a question has an end: a standing decision of answered or insufficient. */
export function questionEnded(d: StandingDecision | undefined): boolean {
  return d !== undefined && (d.decision === "answered" || d.decision === "insufficient");
}

/**
 * Whether a question is saturated: its last SATURATION_TASKS finished tasks added no verified
 * claim from a new registrable domain, and its card's certainty did not rise while they ran. A
 * card rewritten at the same certainty is no progress, as for the last improvement: the
 * synthesizer rewrites a card each round its claims change, so a card that only changed would
 * keep a question from saturating, and its run from ending, for good. Fewer tasks than that:
 * not saturated.
 */
export function questionSaturated(ledger: Ledger, run: string, question: number): boolean {
  const tasks = ledger.db
    .prepare(
      `select yield, created_at from experiment
         where run = ? and question = ? and state = 'done' and yield is not null
         order by updated_at desc, rowid desc limit ?`,
    )
    .all(run, question, SATURATION_TASKS) as { yield: string; created_at: string }[];
  if (tasks.length < SATURATION_TASKS) return false;
  for (const t of tasks) {
    let y: TaskYield | undefined;
    try {
      y = JSON.parse(t.yield) as TaskYield;
    } catch {
      return false;
    }
    if ((y.by_question ?? []).some((b) => b.question === question && b.new_domain_claims > 0))
      return false;
  }
  const since = tasks.reduce(
    (a, t) => (t.created_at < a ? t.created_at : a),
    tasks[0]?.created_at ?? "",
  );
  const cards = ledger.db
    .prepare(
      "select certainty, created_at from question_card where run = ? and question = ? order by version",
    )
    .all(run, question) as { certainty: string; created_at: string }[];
  let before = 0;
  for (const c of cards) {
    const rank = certaintyRank(c.certainty);
    if (c.created_at >= since && rank > before) return false;
    before = rank;
  }
  return true;
}

/**
 * When the run last improved: the newest decision that ranked above the item's decision before
 * it (an item's first decision counts when it is better than nothing), or the newest card whose
 * certainty ranked above the question's previous card. Null: never.
 */
export function lastImprovement(ledger: Ledger, run: string): string | null {
  let last: string | null = null;
  const later = (at: string) => {
    if (last === null || at > last) last = at;
  };
  const decisions = ledger.db
    .prepare(
      "select kind, key, decision, certainty, decided_at from item_decision where run = ? order by id",
    )
    .all(run) as {
    kind: "question" | "hypothesis";
    key: string;
    decision: string;
    certainty: string | null;
    decided_at: string;
  }[];
  const before = new Map<string, number>();
  for (const d of decisions) {
    const k = `${d.kind}:${d.key}`;
    const rank = decisionRank(d.kind, d.decision, d.certainty);
    if (rank > (before.get(k) ?? 0)) later(d.decided_at);
    before.set(k, rank);
  }
  const cards = ledger.db
    .prepare(
      "select question, certainty, created_at from question_card where run = ? order by question, version",
    )
    .all(run) as { question: number; certainty: string; created_at: string }[];
  const card = new Map<number, number>();
  for (const c of cards) {
    const rank = certaintyRank(c.certainty);
    if (rank > (card.get(c.question) ?? 0)) later(c.created_at);
    card.set(c.question, rank);
  }
  return last;
}

/**
 * The progress rule (goal 117, the owner's words): a run whose open questions are all saturated,
 * and which has improved no item for a quarter of its running time (and for at least a quarter of
 * its minimum), has stopped adding. `clock` is the run's research clock, read now and as it stood
 * at a moment. Open: the questions with no end.
 */
export function progressStopped(
  ledger: Ledger,
  run: string,
  questions: number,
  clock: (at?: number) => { elapsed_ms: number; min_ms: number },
): { stopped: boolean; open: number[]; since_ms: number; needed_ms: number } {
  const standing = standingDecisions(ledger, run);
  const open = Array.from({ length: questions }, (_, i) => i).filter(
    (i) => !questionEnded(standing.get(`question:${i}`)),
  );
  const now = clock();
  const last = lastImprovement(ledger, run);
  const at = last === null ? 0 : now.elapsed_ms - clock(Date.parse(last)).elapsed_ms;
  const since = last === null ? now.elapsed_ms : at;
  const needed = Math.max(PROGRESS_SHARE * now.elapsed_ms, PROGRESS_SHARE * now.min_ms);
  const stopped =
    now.elapsed_ms >= now.min_ms &&
    open.every((q) => questionSaturated(ledger, run, q)) &&
    since >= needed;
  return { stopped, open, since_ms: since, needed_ms: needed };
}
