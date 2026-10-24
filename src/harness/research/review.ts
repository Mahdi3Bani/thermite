import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResearchContract } from "../../core/contract.ts";
import {
  ANSWERED,
  MEASURES_NOTHING,
  measurementIn,
  PROGRESS_STOPPED,
  questionLabel,
  questionName,
  REQUIRED_HYPOTHESES,
  RESEARCH_REVIEW,
  RESEARCH_STOPPED,
} from "../../core/research-check.ts";
import type { Ledger } from "../ledger.ts";
import { type CardGap, cardsOf, rubricOf } from "./cards.ts";
import { checkCited } from "./checks.ts";
import { registrableDomain } from "./fetcher.ts";
import {
  ANSWER_CERTAINTIES,
  type AnswerCertainty,
  HYPOTHESIS_DECISIONS,
  type HypothesisDecision,
  hypothesisDecided,
  QUESTION_DECISIONS,
  type QuestionDecision,
  questionEnded,
  type StandingDecision,
  standingDecisions,
} from "./progress.ts";

/**
 * A research run's reviews (goals 112 and 117). The run's items are its questions, each with its
 * answer card, and its required hypotheses (the author's and promoted ones). After the run's
 * minimum running time, at a digest, code asks the supervisor's review panel when every question
 * has an answer card, no review of the run waits, and some item has no standing decision: a
 * question whose newest card is newer than its decision, or a required hypothesis with no
 * decision. The package has every question's newest card with the claims it cites, every required
 * hypothesis with its supporting claims, each item's standing decision, which items to decide,
 * and the run's figures; nothing about which lane or model wrote what.
 *
 * Each reviewer answers each item to decide: a question `answered` (certainty high, moderate or
 * low), `insufficient` (the best answer sources allow; what is missing only a measurement could
 * settle, named as next experiments) or `open` (evidence gaps, named); a hypothesis `supported`,
 * `refuted` or `undecided`. Code checks each answer as it checks a finding. Each item's decision is
 * the verdict that more of the reviewers whose answer passed the check gave than any other (a
 * question's certainty: the median of theirs); a tie, or no answer that passed, is `open` (a
 * hypothesis: `undecided`). The others' verdicts are kept as the decision's dissent. A decision
 * stands until the question's card has a newer version (progress.ts). The review passes when,
 * after it, every question has an end (answered or insufficient) and every required hypothesis a
 * standing decision.
 *
 * A research review is a row of the review table with the reserved goal name `research` (a
 * research contract has no goals) and, in place of a commit, a marker of the items it saw (each
 * question's card version and the required hypotheses): the table's unique index then keeps the
 * run from being asked twice on the same items.
 */

type Row = Record<string, unknown>;

export { ANSWERED, PROGRESS_STOPPED, RESEARCH_REVIEW };

/** The most characters of a research review's package (the reviewers read the rest with tools). */
export const RESEARCH_PACKAGE_MAX = 200_000;
/** The most characters of each quote a package shows, and the most quotes of each claim. */
export const PACKAGE_QUOTE_MAX = 400;
export const PACKAGE_QUOTES = 3;
/** The most characters of each reviewer's reasons for an item in its event; the table keeps more. */
export const ITEM_REASONS_EVENT = 1000;
export const ITEM_REASONS_MAX = 12_000;
/** The most characters of a dissent's reasons. */
export const DISSENT_REASONS = 300;

/** What every reviewer is asked to check, the same for every research run. */
export const RESEARCH_CRITERIA = [
  "Decide only the items in decide: each question there, by its index, and each hypothesis there, by its id. The other items have a decision of the review panel that stands; they are shown for context.",
  "A question is answered when the verified claims, together, give a direct answer to it, judged against its rubric. Give its certainty: high when verified claims from independent domains agree and answer it directly; moderate when they answer it from one domain, or leave small gaps; low when they answer it only in part, or disagree. An answered question cites the claims its answer rests on.",
  "A question is insufficient when its claims give the best answer that sources allow and what is still missing could come only from a measurement: give that best answer, and name what is missing in next_experiments.",
  "A question is open when a source could still close a gap in its evidence: name each such gap in gaps, with the kind of source that could close it.",
  "An answer uses only what the claims it cites say. Every number in an answer must be in those claims, in their text or in their quotes.",
  "A hypothesis is supported or refuted only by the claims a verdict cites. When the claims do not decide it, it is undecided: say why.",
  "A claim from fewer independent domains than the run asks for is weaker evidence. Say so when an answer rests on such claims alone.",
  `${MEASURES_NOTHING} So what only a measurement could settle, such as a test on the hardware the question is about or a benchmark, is a next experiment, never an evidence gap: a question whose only gaps are measurements is insufficient, not open.`,
  "Each item is decided by the verdict most of the reviewers give whose answer passes the harness's check; a tie is open (a hypothesis: undecided), and the other reviewers' verdicts are kept as dissent. A decision stands until the question's answer card changes.",
];

export interface PackageClaim {
  id: string;
  text: string;
  /** Its quotes, each cut to PACKAGE_QUOTE_MAX characters (a cut ends with "…"). */
  quotes: string[];
  /** Quotes of the claim left out (more than PACKAGE_QUOTES, or to keep the package short). */
  quotes_not_shown?: number;
  /** The registrable domains its quotes' sources come from (docs.example.com: example.com). */
  domains: string[];
  /** From at least the contract's number of independent domains. */
  corroborated: boolean;
}

/** An item's decision that stands, as a package shows it. */
export interface PackageStanding {
  decision: string;
  certainty: string | null;
  review: number;
  card_version: number | null;
  decided_at: string;
}

/** One question in a research review's package: its newest card, with the claims it cites. */
export interface PackageQuestion {
  index: number;
  /** "Question 1 (index 0)". */
  label: string;
  text: string;
  /** What an answer must cover: the contract's rubric, else the question. */
  rubric: string;
  /** To decide in this review: it has no standing decision. */
  decide: boolean;
  /** The newest answer card; null: none (a package asked before every question had one). */
  card: {
    version: number;
    answer: string;
    certainty: string;
    gaps: CardGap[];
    created_at: string;
  } | null;
  /** The verified claims the card cites. */
  claims: PackageClaim[];
  /** Claims the card cites left out to keep the package short. */
  claims_not_shown?: number;
  /** All the question's verified claims (read the others with the tools). */
  verified_claims: number;
  /** The decision that stands, when the question has one. */
  standing?: PackageStanding;
}

/** One required hypothesis in a research review's package. */
export interface PackageHypothesis {
  id: string;
  text: string;
  status: string;
  /** The question it is about, an index from 0; null: the whole run. */
  question: number | null;
  /** To decide in this review: it has no standing decision. */
  decide: boolean;
  supporting: PackageClaim[];
  supporting_not_shown?: number;
  standing?: PackageStanding;
}

/** What the review panel gets for a research review: the run's items, with no lane or model. */
export interface ResearchPackage {
  kind: "research";
  title: string;
  topic: string;
  criteria: string[];
  /** The items to decide: those with no standing decision. The others stand. */
  decide: { questions: number[]; hypotheses: string[] };
  corpus: {
    sources: number;
    domains: number;
    verified_claims: number;
    corroborated_claims: number;
    findings: number;
    min_independent_domains: number;
  };
  /** Said when claims or quotes were left out to fit. */
  shortened?: string;
  /** Every question, in order. */
  questions: PackageQuestion[];
  /** The required hypotheses (the author's and promoted ones), those to decide first. */
  hypotheses: PackageHypothesis[];
}

/** A reviewer's answers to a research package, as the supervisor posts them (goal 117). */
export const ResearchVerdicts = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        index: z.number().int().min(0),
        verdict: z.enum(QUESTION_DECISIONS),
        certainty: z.enum(ANSWER_CERTAINTIES).nullable().default(null),
        answer: z.string().max(8000).default(""),
        claims: z.array(z.string().max(200)).max(100).default([]),
        gaps: z.string().max(4000).default(""),
        next_experiments: z.string().max(4000).default(""),
      }),
    )
    .max(2000)
    .default([]),
  hypotheses: z
    .array(
      z.strictObject({
        id: z.string().max(200),
        verdict: z.enum(HYPOTHESIS_DECISIONS),
        why: z.string().max(4000).default(""),
        claims: z.array(z.string().max(200)).max(100).default([]),
      }),
    )
    .max(5000)
    .default([]),
});
export type ResearchVerdicts = z.infer<typeof ResearchVerdicts>;

/** One reviewer's answer to a question, with the harness's check. */
export interface CheckedQuestion {
  index: number;
  /** The card version it decided on; null when the package showed no card. */
  card_version: number | null;
  /** What the reviewer said; null: no answer. */
  verdict: QuestionDecision | null;
  /** For answered only. */
  certainty: AnswerCertainty | null;
  answer: string;
  claims: string[];
  /** The evidence gaps it names (open). */
  gaps: string;
  /** What only a measurement could settle (insufficient, and answered when it names some). */
  next_experiments: string;
  /** The answer passed the check: it counts in the decision. */
  valid: boolean;
  problems: string[];
}

/** One reviewer's verdict on a hypothesis, with the harness's check. */
export interface CheckedHypothesis {
  id: string;
  verdict: HypothesisDecision | null;
  why: string;
  claims: string[];
  valid: boolean;
  problems: string[];
}

/** One reviewer's research review, as the harness checked and keeps it. */
export interface CheckedReviewer {
  reviewer: string;
  /** The reviewer's own pass or fail: kept, it decides nothing (the items' decisions do). */
  said_pass: boolean;
  reasons: string;
  /** Its answers to the questions to decide, as checked. */
  questions: CheckedQuestion[];
  /** Its verdicts on the hypotheses to decide, as checked. */
  hypotheses: CheckedHypothesis[];
}

/** A dissent from an item's decision: a reviewer whose answer passed the check, with another verdict. */
export interface Dissent {
  reviewer: string;
  verdict: string;
  certainty: string | null;
  reasons: string;
}

/** The panel's decision on one item. */
export interface ItemDecision {
  kind: "question" | "hypothesis";
  key: string;
  card_version: number | null;
  decision: QuestionDecision | HypothesisDecision;
  certainty: AnswerCertainty | null;
  /**
   * The reviewers who gave the decision's verdict with an answer that passed the check (on a tie
   * decided as open or undecided, those who said so, if any).
   */
  majority: string[];
  /** How many reviewers' answers passed the check. */
  counted: number;
  /** Why it is open or undecided when no verdict won: a tie, or no answer that passed. */
  why?: "tie" | "no answer passed the check";
  dissent: Dissent[];
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const count = (ledger: Ledger, sql: string, ...p: (string | number)[]) =>
  Number((ledger.db.prepare(sql).get(...p) as { n: number } | undefined)?.n ?? 0);

const listOf = <T>(json: unknown): T[] => {
  try {
    const v = JSON.parse(String(json ?? "[]")) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

/** Question indexes in words for people: "question 2", "questions 2, 5". */
const questionsWords = (xs: number[]) =>
  `${xs.length === 1 ? "question" : "questions"} ${xs.map((i) => i + 1).join(", ")}`;

/** A run's research reviews, newest first. */
export function researchReviews(ledger: Ledger, run: string): Row[] {
  return ledger.db
    .prepare("select * from review where run = ? and goal = ? order by id desc")
    .all(run, RESEARCH_REVIEW) as Row[];
}

/** The review whose pass was accepted (hands-off or by the owner): the run's items have ends. */
export function acceptedReview(ledger: Ledger, run: string): Row | undefined {
  return researchReviews(ledger, run).find((r) => r.owner_decision === "accepted");
}

/** A review that waits: for the review panel, or, passed, for the owner's acceptance. */
export function waitingReview(ledger: Ledger, run: string): Row | undefined {
  return researchReviews(ledger, run).find(
    (r) =>
      r.panel_result === null || (r.panel_result === "review_passed" && r.owner_decision === null),
  );
}

/** A run's required hypotheses (the author's and promoted ones), the oldest first. */
export function requiredHypotheses(
  ledger: Ledger,
  run: string,
): { id: string; text: string; status: string; question: number | null; supporting: string[] }[] {
  return (
    ledger.db
      .prepare(
        `select id, text, status, question, supporting from hypothesis where run = ? and status in (${REQUIRED_HYPOTHESES.map(() => "?").join(", ")}) order by created_at, rowid`,
      )
      .all(run, ...REQUIRED_HYPOTHESES) as Row[]
  ).map((h) => ({
    id: String(h.id),
    text: String(h.text),
    status: String(h.status),
    question: h.question === null || h.question === undefined ? null : Number(h.question),
    supporting: listOf<string>(h.supporting).map(String),
  }));
}

/**
 * Where a run's items stand: the panel's standing decisions; the questions with no end (no
 * standing decision of answered or insufficient) and the required hypotheses with no standing
 * decision; and the items to decide, those with no standing decision at all.
 */
export function itemsState(
  ledger: Ledger,
  run: string,
  questions: number,
): {
  standing: Map<string, StandingDecision>;
  open: { questions: number[]; hypotheses: string[] };
  decide: { questions: number[]; hypotheses: string[] };
} {
  const standing = standingDecisions(ledger, run);
  const all = Array.from({ length: questions }, (_, i) => i);
  const hypotheses = requiredHypotheses(ledger, run).map((h) => h.id);
  const undecidedHypotheses = hypotheses.filter(
    (id) => !hypothesisDecided(standing.get(`hypothesis:${id}`)),
  );
  return {
    standing,
    open: {
      questions: all.filter((i) => !questionEnded(standing.get(`question:${i}`))),
      hypotheses: undecidedHypotheses,
    },
    decide: {
      questions: all.filter((i) => !standing.has(`question:${i}`)),
      hypotheses: undecidedHypotheses,
    },
  };
}

/**
 * The items a review sees, as a marker: each question's newest card version and the required
 * hypotheses. A review is never asked twice with the same marker.
 */
export function itemsMarker(ledger: Ledger, run: string, questions: number): string {
  const versions = new Map(cardsOf(ledger, run).map((c) => [c.question, c.version]));
  const cards = Array.from({ length: questions }, (_, i) => `${i}v${versions.get(i) ?? 0}`).join(
    ".",
  );
  const ids = requiredHypotheses(ledger, run)
    .map((h) => h.id)
    .sort();
  const hash = createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 12);
  return `items:${cards}:h${ids.length}-${hash}`;
}

/** How a research run ended, when it did: answered (an accepted review) or stopped by the progress rule. */
export interface ResearchEnd {
  reason: typeof ANSWERED | typeof PROGRESS_STOPPED;
  /** The accepted review, for an answered run; the newest decided review, if any, for a stopped one. */
  review: Row | undefined;
  at: string;
  /** The questions with no end and the required hypotheses with no verdict when it ended. */
  open: { questions: number[]; hypotheses: string[] };
}

/**
 * A research run's end, when it has one: a review whose pass was accepted, or the progress rule's
 * stop (a `research_stopped` event). Either way no new trial starts, the final writer writes the
 * paper, and the run closes with the end's reason once its paper is in and its trials end.
 */
export function researchEnd(ledger: Ledger, run: string): ResearchEnd | undefined {
  const accepted = acceptedReview(ledger, run);
  if (accepted)
    return {
      reason: ANSWERED,
      review: accepted,
      at: String(accepted.owner_at ?? accepted.panel_at ?? ""),
      open: { questions: [], hypotheses: [] },
    };
  const stopped = ledger.db
    .prepare("select at, body from event where kind = ? and subject = ? order by id desc limit 1")
    .get(RESEARCH_STOPPED, run) as { at: string; body: string } | undefined;
  if (!stopped) return undefined;
  const b = JSON.parse(stopped.body) as {
    open?: { questions?: unknown[]; hypotheses?: unknown[] };
  };
  return {
    reason: PROGRESS_STOPPED,
    review: researchReviews(ledger, run).find((r) => r.panel_result !== null),
    at: stopped.at,
    open: {
      questions: (b.open?.questions ?? []).map(Number).filter(Number.isInteger),
      hypotheses: (b.open?.hypotheses ?? []).map(String),
    },
  };
}

/** Why the review panel is not asked now, or the marker of the items it would see. */
export function researchReviewDue(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  clock: { elapsed_ms: number; min_ms: number },
):
  | { due: true; marker: string; questions: number[]; hypotheses: string[] }
  | { due: false; why: string } {
  const end = researchEnd(ledger, run);
  if (end)
    return {
      due: false,
      why:
        end.reason === ANSWERED
          ? "the review panel's decisions gave every item an end"
          : "the progress rule ended the run",
    };
  if (clock.elapsed_ms < clock.min_ms)
    return { due: false, why: "the run has not run for its minimum duration yet" };
  const n = contract.questions.length;
  const carded = new Set(cardsOf(ledger, run).map((c) => c.question));
  const bare = Array.from({ length: n }, (_, i) => i).filter((i) => !carded.has(i));
  if (bare.length)
    return {
      due: false,
      why: `${questionsWords(bare)} ${bare.length === 1 ? "has" : "have"} no answer card yet`,
    };
  const floor = contract.min_verified_claims;
  const verified = count(
    ledger,
    "select count(*) as n from claim where run = ? and verified = 1",
    run,
  );
  if (floor !== undefined && verified < floor)
    return {
      due: false,
      why: `the run has ${verified} verified claims of the ${floor} the campaign asks for`,
    };
  const waiting = waitingReview(ledger, run);
  if (waiting) return { due: false, why: `review ${String(waiting.id)} waits` };
  const { decide } = itemsState(ledger, run, n);
  if (!decide.questions.length && !decide.hypotheses.length)
    return {
      due: false,
      why: "every item has a decision that stands: a question is reviewed again when its answer card changes",
    };
  const marker = itemsMarker(ledger, run, n);
  const seen = researchReviews(ledger, run).find((r) => r.commit_sha === marker);
  if (seen)
    return { due: false, why: `review ${String(seen.id)} saw these items: it needs a new card` };
  return { due: true, marker, questions: decide.questions, hypotheses: decide.hypotheses };
}

/** Each source's registrable domain in a run, by its id. */
function sourceDomains(ledger: Ledger, run: string): Map<string, string> {
  return new Map(
    (
      ledger.db.prepare("select id, domain from source where run = ?").all(run) as {
        id: string;
        domain: string | null;
      }[]
    ).map((s) => [String(s.id), s.domain ? registrableDomain(String(s.domain)) : ""]),
  );
}

interface ClaimRow {
  id: string;
  question: number | null;
  text: string;
  quotes: { source: string; quote: string }[];
  domains: string[];
  corroborated: boolean;
}

/** A run's verified claims, by id, with their sources' registrable domains. */
function verifiedClaims(ledger: Ledger, run: string, min: number): Map<string, ClaimRow> {
  const domains = sourceDomains(ledger, run);
  return new Map(
    (
      ledger.db
        .prepare(
          "select id, question, text, quotes from claim where run = ? and verified = 1 order by created_at, rowid",
        )
        .all(run) as Row[]
    ).map((c) => {
      const quotes = listOf<{ source: string; quote: string }>(c.quotes);
      const ds = [...new Set(quotes.map((q) => domains.get(String(q.source)) ?? ""))].filter(
        Boolean,
      );
      return [
        String(c.id),
        {
          id: String(c.id),
          question: c.question === null ? null : Number(c.question),
          text: String(c.text),
          quotes,
          domains: ds,
          corroborated: ds.length >= min,
        },
      ];
    }),
  );
}

/** How much of each claim a package shows (the shorter forms keep it within RESEARCH_PACKAGE_MAX). */
interface Shown {
  /** Quotes of the claims of items whose decision stands. */
  standingQuotes: boolean;
  /** Claims of items whose decision stands. */
  standingClaims: boolean;
  /** Quotes of the claims of items to decide. */
  quotes: boolean;
  /** The most claims each item to decide shows. */
  perItem: number;
}

/**
 * The package of a research review (goal 117): the topic, the criteria, which items to decide,
 * the run's figures, every question with its newest card, the claims the card cites (their text,
 * quotes cut to PACKAGE_QUOTE_MAX characters, their sources' domains and whether they are
 * corroborated), its rubric and its standing decision, and every required hypothesis with its
 * supporting claims and standing decision, those to decide first. Nothing about which lane or
 * model wrote what. When it would be longer than RESEARCH_PACKAGE_MAX characters, the claims of
 * the items that stand lose their quotes and then go, then every claim loses its quotes, and then
 * each item shows fewer claims; `shortened` says so, and each item says how many it left out.
 */
export function researchPackage(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
): ResearchPackage {
  const min = contract.quality.min_independent_sources;
  const n = contract.questions.length;
  const claims = verifiedClaims(ledger, run, min);
  const { standing, decide } = itemsState(ledger, run, n);
  const cards = new Map(cardsOf(ledger, run).map((c) => [c.question, c]));
  const hypotheses = requiredHypotheses(ledger, run);
  const standingOf = (key: string): PackageStanding | undefined => {
    const d = standing.get(key);
    return d
      ? {
          decision: d.decision,
          certainty: d.certainty,
          review: d.review,
          card_version: d.card_version,
          decided_at: d.decided_at,
        }
      : undefined;
  };
  const verifiedCount = new Map<number, number>();
  for (const c of claims.values())
    if (c.question !== null)
      verifiedCount.set(c.question, (verifiedCount.get(c.question) ?? 0) + 1);
  const toClaim = (c: ClaimRow, quotes: boolean): PackageClaim => {
    const shown = quotes ? c.quotes.slice(0, PACKAGE_QUOTES) : [];
    return {
      id: c.id,
      text: c.text,
      quotes: shown.map((q) => clip(q.quote, PACKAGE_QUOTE_MAX)),
      ...(shown.length < c.quotes.length
        ? { quotes_not_shown: c.quotes.length - shown.length }
        : {}),
      domains: c.domains,
      corroborated: c.corroborated,
    };
  };
  /** The claims of an item, as much as `s` shows; and how many of them it left out. */
  const claimsOf = (ids: string[], stands: boolean, s: Shown) => {
    const all = [...new Set(ids)].flatMap((id) => {
      const c = claims.get(id);
      return c ? [c] : [];
    });
    if (stands && !s.standingClaims) return { shown: [], not: all.length };
    const quotes = stands ? s.standingQuotes : s.quotes;
    const cut = stands ? all : all.slice(0, s.perItem);
    return { shown: cut.map((c) => toClaim(c, quotes)), not: all.length - cut.length };
  };
  const corpus = {
    sources: count(ledger, "select count(*) as n from source where run = ?", run),
    domains: new Set([...sourceDomains(ledger, run).values()].filter(Boolean)).size,
    verified_claims: claims.size,
    corroborated_claims: [...claims.values()].filter((c) => c.corroborated).length,
    findings: count(
      ledger,
      "select count(*) as n from finding where run = ? and supported = 1",
      run,
    ),
    min_independent_domains: min,
  };
  const build = (s: Shown, shortened: string | undefined): ResearchPackage => ({
    kind: "research",
    title: contract.title,
    topic: contract.topic,
    criteria: RESEARCH_CRITERIA,
    decide,
    corpus,
    ...(shortened ? { shortened } : {}),
    questions: contract.questions.map((text, index): PackageQuestion => {
      const card = cards.get(index);
      const st = standingOf(`question:${index}`);
      const toDecide = decide.questions.includes(index);
      const cl = claimsOf(card?.claims ?? [], !toDecide, s);
      return {
        index,
        label: questionLabel(index),
        text,
        rubric: rubricOf(contract, index),
        decide: toDecide,
        card: card
          ? {
              version: card.version,
              answer: card.answer,
              certainty: card.certainty,
              gaps: card.gaps,
              created_at: card.created_at,
            }
          : null,
        claims: cl.shown,
        ...(cl.not ? { claims_not_shown: cl.not } : {}),
        verified_claims: verifiedCount.get(index) ?? 0,
        ...(st ? { standing: st } : {}),
      };
    }),
    hypotheses: [
      ...hypotheses.filter((h) => decide.hypotheses.includes(h.id)),
      ...hypotheses.filter((h) => !decide.hypotheses.includes(h.id)),
    ].map((h): PackageHypothesis => {
      const st = standingOf(`hypothesis:${h.id}`);
      const toDecide = decide.hypotheses.includes(h.id);
      const cl = claimsOf(h.supporting, !toDecide, s);
      return {
        id: h.id,
        text: h.text,
        status: h.status,
        question: h.question,
        decide: toDecide,
        supporting: cl.shown,
        ...(cl.not ? { supporting_not_shown: cl.not } : {}),
        ...(st ? { standing: st } : {}),
      };
    }),
  });
  const most = Math.max(
    1,
    ...[...cards.values()].map((c) => c.claims.length),
    ...hypotheses.map((h) => h.supporting.length),
  );
  const steps: { s: Shown; said: string }[] = [
    {
      s: { standingQuotes: false, standingClaims: true, quotes: true, perItem: most },
      said: "the claims of the items whose decision stands are shown without their quotes",
    },
    {
      s: { standingQuotes: false, standingClaims: false, quotes: true, perItem: most },
      said: "the claims of the items whose decision stands are not shown (claims_not_shown and supporting_not_shown count them)",
    },
    {
      s: { standingQuotes: false, standingClaims: false, quotes: false, perItem: most },
      said: "the claims of the items whose decision stands are not shown, and the other claims are shown without their quotes",
    },
  ];
  for (let k = Math.ceil(most / 2); k >= 1; k = k === 1 ? 0 : Math.ceil(k / 2))
    steps.push({
      s: { standingQuotes: false, standingClaims: false, quotes: false, perItem: k },
      said: `the claims of the items whose decision stands are not shown, and each item to decide shows its first ${k} cited ${k === 1 ? "claim" : "claims"}, without quotes (claims_not_shown and supporting_not_shown count the rest)`,
    });
  let pkg = build(
    { standingQuotes: true, standingClaims: true, quotes: true, perItem: most },
    undefined,
  );
  for (const step of steps) {
    if (JSON.stringify(pkg).length <= RESEARCH_PACKAGE_MAX) break;
    pkg = build(
      step.s,
      `To keep this package short, ${step.said}. When you have the tools, read every claim, quote and source of the run with them.`,
    );
  }
  return pkg;
}

/** A question to decide in a package (one asked before goal 117 has no `decide`: all of them). */
function toDecide(
  pkg: Partial<Pick<ResearchPackage, "decide">> & {
    questions?: { index: number }[];
    hypotheses?: { id: string }[];
  },
): { questions: number[]; hypotheses: string[] } {
  if (pkg.decide) return pkg.decide;
  return {
    questions: (pkg.questions ?? []).map((q) => q.index),
    hypotheses: (pkg.hypotheses ?? []).map((h) => h.id),
  };
}

/**
 * Each reviewer's answers to the items to decide, checked by code. A question's answer counts
 * only when it passes: answered needs its certainty (high, moderate or low), words and at least
 * one cited claim; insufficient needs its best answer and what is missing in next_experiments;
 * open needs the evidence gaps it names. Every cited id must be a verified claim of the run, and
 * every number in an answered or insufficient answer must be in the claims it cites. A supported
 * or refuted verdict needs at least one cited claim and the same check of its why; an undecided
 * one needs its why. An item a reviewer gave no answer counts as no answer.
 */
export function checkResearchPanel(
  ledger: Ledger,
  run: string,
  pkg: Partial<Pick<ResearchPackage, "decide">> & {
    questions?: { index: number; card?: { version: number } | null }[];
    hypotheses?: { id: string }[];
  },
  results: {
    reviewer: string;
    pass: boolean;
    reasons: string;
    research?: ResearchVerdicts | undefined;
  }[],
): CheckedReviewer[] {
  const items = toDecide(pkg);
  const version = (i: number) => pkg.questions?.find((q) => q.index === i)?.card?.version ?? null;
  return results.map((r) => {
    const said = r.research ?? { questions: [], hypotheses: [] };
    const questions = items.questions.map((index): CheckedQuestion => {
      const a = said.questions.find((x) => x.index === index);
      const base = { index, card_version: version(index) };
      if (!a)
        return {
          ...base,
          verdict: null,
          certainty: null,
          answer: "",
          claims: [],
          gaps: "",
          next_experiments: "",
          valid: false,
          problems: ["the reviewer gave no answer to this question"],
        };
      const problems: string[] = [];
      const claims = [...new Set(a.claims)];
      if (a.verdict === "answered") {
        if (!a.certainty)
          problems.push("an answered verdict needs its certainty: high, moderate or low");
        if (!a.answer.trim()) problems.push("the answer is empty");
        if (!claims.length) problems.push("the answer cites no claim");
        problems.push(...checkCited(ledger, run, claims, [a.answer]).problems);
      } else if (a.verdict === "insufficient") {
        if (!a.answer.trim()) problems.push("an insufficient verdict needs the best answer");
        if (!a.next_experiments.trim())
          problems.push(
            "an insufficient verdict names what is missing, which only a measurement could settle, in next_experiments",
          );
        problems.push(...checkCited(ledger, run, claims, [a.answer]).problems);
      } else {
        if (!a.gaps.trim()) problems.push("an open verdict names the evidence gaps");
        // Claims it names must still be the run's verified claims; its words are not an answer.
        problems.push(...checkCited(ledger, run, claims, []).problems);
      }
      return {
        ...base,
        verdict: a.verdict,
        certainty: a.verdict === "answered" ? a.certainty : null,
        answer: a.answer.slice(0, 8000),
        claims,
        gaps: a.gaps.slice(0, 4000),
        next_experiments: a.next_experiments.slice(0, 4000),
        valid: problems.length === 0,
        problems,
      };
    });
    const hypotheses = items.hypotheses.map((id): CheckedHypothesis => {
      const v = said.hypotheses.find((x) => x.id === id);
      if (!v)
        return {
          id,
          verdict: null,
          why: "",
          claims: [],
          valid: false,
          problems: ["the reviewer gave no verdict on this hypothesis"],
        };
      const problems: string[] = [];
      if (v.verdict === "undecided") {
        if (!v.why.trim()) problems.push("an undecided verdict needs its why");
        problems.push(...checkCited(ledger, run, v.claims, []).problems);
      } else {
        if (!v.claims.length) problems.push(`a ${v.verdict} verdict cites no claim`);
        problems.push(...checkCited(ledger, run, v.claims, [v.why]).problems);
      }
      return {
        id,
        verdict: v.verdict,
        why: v.why.slice(0, 4000),
        claims: [...new Set(v.claims)],
        valid: problems.length === 0,
        problems,
      };
    });
    return {
      reviewer: r.reviewer,
      said_pass: r.pass,
      reasons: r.reasons.slice(0, 4000),
      questions,
      hypotheses,
    };
  });
}

/** A question's answer as one text: the answer, then its evidence gaps and next experiments. */
export function questionReasons(q: Pick<CheckedQuestion, "answer" | "gaps" | "next_experiments">) {
  return [
    q.answer.trim(),
    q.gaps.trim() ? `Evidence gaps: ${q.gaps.trim()}` : "",
    q.next_experiments.trim() ? `Next experiments: ${q.next_experiments.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const CERTAINTY_ORDER: AnswerCertainty[] = ["low", "moderate", "high"];

/** The median of certainties: the middle one, or the lower of the two middle ones. */
export function medianCertainty(xs: AnswerCertainty[]): AnswerCertainty | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => CERTAINTY_ORDER.indexOf(a) - CERTAINTY_ORDER.indexOf(b));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** The verdict more voters gave than any other; undefined on a tie or with no voter. */
function winner(verdicts: string[]): string | undefined {
  const tally = new Map<string, number>();
  for (const v of verdicts) tally.set(v, (tally.get(v) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first) return undefined;
  return second && second[1] === first[1] ? undefined : first[0];
}

/**
 * The panel's decision on each item it was asked to decide, from the reviewers' checked answers:
 * the verdict that more of the reviewers whose answer passed the check gave than any other; for
 * an answered question, the median of their certainties. A tie, or no answer that passed, is open
 * (a hypothesis: undecided). Every reviewer whose answer passed with another verdict than the
 * decision is a dissent, with its verdict, certainty and short reasons.
 */
export function decideItems(
  pkg: Partial<Pick<ResearchPackage, "decide">> & {
    questions?: { index: number; card?: { version: number } | null }[];
    hypotheses?: { id: string }[];
  },
  checked: CheckedReviewer[],
): ItemDecision[] {
  const items = toDecide(pkg);
  const version = (i: number) => pkg.questions?.find((q) => q.index === i)?.card?.version ?? null;
  const out: ItemDecision[] = [];
  for (const index of items.questions) {
    const votes = checked.flatMap((r) => {
      const q = r.questions.find((x) => x.index === index);
      return q?.valid && q.verdict ? [{ reviewer: r.reviewer, q }] : [];
    });
    const won = winner(votes.map((v) => String(v.q.verdict))) as QuestionDecision | undefined;
    const decision: QuestionDecision = won ?? "open";
    const majority = votes.filter((v) => v.q.verdict === decision);
    out.push({
      kind: "question",
      key: String(index),
      card_version: version(index),
      decision,
      certainty:
        decision === "answered"
          ? medianCertainty(majority.flatMap((v) => (v.q.certainty ? [v.q.certainty] : [])))
          : null,
      majority: majority.map((v) => v.reviewer),
      counted: votes.length,
      ...(won
        ? {}
        : { why: votes.length ? ("tie" as const) : ("no answer passed the check" as const) }),
      dissent: votes
        .filter((v) => v.q.verdict !== decision)
        .map((v) => ({
          reviewer: v.reviewer,
          verdict: String(v.q.verdict),
          certainty: v.q.certainty,
          reasons: clip(questionReasons(v.q), DISSENT_REASONS),
        })),
    });
  }
  for (const id of items.hypotheses) {
    const votes = checked.flatMap((r) => {
      const h = r.hypotheses.find((x) => x.id === id);
      return h?.valid && h.verdict ? [{ reviewer: r.reviewer, h }] : [];
    });
    const won = winner(votes.map((v) => String(v.h.verdict))) as HypothesisDecision | undefined;
    const decision: HypothesisDecision = won ?? "undecided";
    out.push({
      kind: "hypothesis",
      key: id,
      card_version: null,
      decision,
      certainty: null,
      majority: votes.filter((v) => v.h.verdict === decision).map((v) => v.reviewer),
      counted: votes.length,
      ...(won
        ? {}
        : { why: votes.length ? ("tie" as const) : ("no answer passed the check" as const) }),
      dissent: votes
        .filter((v) => v.h.verdict !== decision)
        .map((v) => ({
          reviewer: v.reviewer,
          verdict: String(v.h.verdict),
          certainty: null,
          reasons: clip(v.h.why, DISSENT_REASONS),
        })),
    });
  }
  return out;
}

/** A decision in words, for people: "answered, certainty high", "insufficient", "open". */
export function decisionWords(d: { decision: string; certainty: string | null }): string {
  if (d.decision === "answered") return `answered, certainty ${d.certainty ?? "unknown"}`;
  if (d.decision === "insufficient") return "insufficient (the best answer sources allow)";
  return d.decision;
}

/**
 * What one reviewer found open or could not get past the check, a line each, in plain words.
 * Questions are named for people, "Question 1" (the journal), or with `questionLabel` where agents
 * read it too ("Question 1 (index 0)": the digest's line in REPORT.md).
 */
export function reviewerGaps(
  r: CheckedReviewer,
  n = 300,
  name: (index: number) => string = questionName,
): string[] {
  const out: string[] = [];
  for (const q of r.questions) {
    if (q.valid && q.verdict !== "open") continue;
    if (q.valid) out.push(`${name(q.index)}: open: ${clip(q.gaps, n)}`);
    else if (q.verdict)
      out.push(
        `${name(q.index)}: the ${q.verdict} verdict did not pass the check (${clip(q.problems.join("; "), n)})`,
      );
    else out.push(`${name(q.index)}: no answer`);
  }
  for (const h of r.hypotheses) {
    if (h.valid) continue;
    out.push(
      `Hypothesis ${h.id}: ${h.verdict ? `the ${h.verdict} verdict did not pass the check (${clip(h.problems.join("; "), n)})` : "no verdict"}`,
    );
  }
  return out;
}

/** A review's checked results, as stored in its panel column. */
export function checkedPanel(row: Row): CheckedReviewer[] {
  if (row.panel === null || row.panel === undefined) return [];
  try {
    const xs = JSON.parse(String(row.panel)) as unknown;
    return Array.isArray(xs)
      ? (xs as Partial<CheckedReviewer>[]).map((r) => ({
          reviewer: String(r.reviewer ?? ""),
          said_pass: r.said_pass === true,
          reasons: String(r.reasons ?? ""),
          questions: Array.isArray(r.questions) ? r.questions : [],
          hypotheses: Array.isArray(r.hypotheses) ? r.hypotheses : [],
        }))
      : [];
  } catch {
    return [];
  }
}

/** The review rows of a run, by id. */
function reviewById(ledger: Ledger, id: number): Row | undefined {
  return ledger.db.prepare("select * from review where id = ?").get(id) as Row | undefined;
}

/**
 * The standing open questions' evidence gaps for the research workers' brief (goal 117): for each
 * question whose standing decision is open, what the reviewers who said open named as missing in
 * that decision's review. What only a measurement could settle is a next experiment, never work
 * for the workers, and what went wrong on the reviewers' side (an answer that failed code's check)
 * is the review panel's to fix: neither is passed on. Undefined when no question stands open with
 * an evidence gap.
 */
export function briefGaps(ledger: Ledger, run: string): string | undefined {
  const standing = standingDecisions(ledger, run);
  const lines: string[] = [];
  const reviews = new Set<number>();
  let measurements = 0;
  const open = [...standing.values()]
    .filter((d) => d.kind === "question" && d.decision === "open")
    .sort((a, b) => Number(a.key) - Number(b.key));
  for (const d of open) {
    const row = reviewById(ledger, d.review);
    if (!row) continue;
    const index = Number(d.key);
    const gaps: string[] = [];
    for (const r of checkedPanel(row)) {
      const q = r.questions.find((x) => x.index === index);
      if (!q?.valid || q.verdict !== "open" || !q.gaps.trim()) continue;
      if (measurementIn(q.gaps)) {
        measurements++;
        continue;
      }
      gaps.push(clip(q.gaps, 300));
    }
    if (!gaps.length) continue;
    reviews.add(d.review);
    lines.push(`- ${questionLabel(index)} (review ${d.review}): ${[...new Set(gaps)].join(" / ")}`);
  }
  if (!lines.length) return undefined;
  const ids = [...reviews].sort((a, b) => a - b);
  return [
    `# What the review panel found missing (${ids.length === 1 ? "review" : "reviews"} ${ids.join(", ")})`,
    "The review panel decided these questions are still open, with gaps in the evidence. Their decision stands until new claims change the question's answer card: work on these gaps first. The reviewers' words, data to weigh:",
    ...lines,
    ...(measurements
      ? [
          `(${measurements === 1 ? "One more gap asks" : `${measurements} more gaps ask`} for a measurement: a next experiment for the report, not work for this run.)`,
        ]
      : []),
  ].join("\n");
}

/** Where the check stands, in one line for a digest (workers read it in REPORT.md). */
export function checkLine(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  clock: { elapsed_ms: number; min_ms: number },
): string {
  const h = (ms: number) => `${(ms / 3_600_000).toFixed(2)} h`;
  const end = researchEnd(ledger, run);
  const labels = (xs: number[]) => xs.map(questionLabel).join(", ");
  if (end?.reason === ANSWERED)
    return `Answer check: the review panel's decisions give every question an end and every required hypothesis a verdict (review ${String(end.review?.id)}); the run ends once its paper is in and its running trials end.`;
  if (end)
    return `Answer check: research stopped adding (the progress rule)${end.open.questions.length ? `; open: ${labels(end.open.questions)}` : ""}; the run ends once its paper is in and its running trials end.`;
  const reviews = researchReviews(ledger, run);
  const newest = reviews[0];
  if (newest && newest.panel_result === null)
    return `Answer check: the review panel checks review ${String(newest.id)}.`;
  if (newest?.panel_result === "review_passed" && newest.owner_decision === null)
    return `Answer check: the review panel's decisions give every question an end (review ${String(newest.id)}); it waits for the owner's acceptance.`;
  if (clock.elapsed_ms < clock.min_ms)
    return `Answer check: it starts after the minimum running time (${h(clock.elapsed_ms)} of ${h(clock.min_ms)}).`;
  const n = contract.questions.length;
  const { standing, open } = itemsState(ledger, run, n);
  const due = researchReviewDue(ledger, run, contract, clock);
  const next = due.due ? "the next digest asks the review panel" : due.why;
  if (newest?.owner_decision === "rejected")
    return `Answer check: the owner did not accept review ${String(newest.id)}; ${next}.`;
  if (!reviews.length) return `Answer check: ${due.due ? next : `waiting: ${next}`}.`;
  const ended = n - open.questions.length;
  const required = requiredHypotheses(ledger, run).length;
  const openWords = open.questions.map((i) => {
    const d = standing.get(`question:${i}`);
    return `${questionLabel(i)} (${d ? `open in review ${d.review}` : "no decision on its newest card"})`;
  });
  return `Answer check: not yet. ${ended} of ${n} questions have an end, and ${required - open.hypotheses.length} of ${required} required hypotheses a verdict${openWords.length ? `; open: ${clip(openWords.join(", "), 500)}` : ""}; ${next}.`;
}

/**
 * The final report's sections on the decisions (goals 112 and 117): how the run ended, then each
 * question's standing decision with the first answer of its majority, the claims it cites, how
 * many reviewers gave it and the dissent; then each required hypothesis's verdict, with why and
 * the dissent.
 */
export function answerSections(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  fence: (s: string) => string,
): string[] {
  const n = contract.questions.length;
  const end = researchEnd(ledger, run);
  const { standing, open } = itemsState(ledger, run, n);
  const one = (s: string) => fence(s).replace(/\n+/g, " ");
  const decisionRow = (d: StandingDecision) =>
    ledger.db
      .prepare(
        "select * from item_decision where run = ? and kind = ? and key = ? and review = ? order by id desc limit 1",
      )
      .get(run, d.kind, d.key, d.review) as Row | undefined;
  const panels = new Map<number, CheckedReviewer[]>();
  const panelOf = (review: number) => {
    if (!panels.has(review)) {
      const row = reviewById(ledger, review);
      panels.set(review, row ? checkedPanel(row) : []);
    }
    return panels.get(review) ?? [];
  };
  const dissentLines = (d: StandingDecision) =>
    listOf<Dissent>(decisionRow(d)?.dissent).map(
      (x) =>
        `- Dissent: ${x.reviewer}: ${decisionWords({ decision: x.verdict, certainty: x.certainty })}${x.reasons ? `: ${one(x.reasons)}` : ""}`,
    );
  const head = !standing.size
    ? "The review panel decided no item of this run."
    : end?.reason === ANSWERED
      ? `The review panel's decisions give every question an end and every required hypothesis a verdict (review ${String(end.review?.id)})${String(end.review?.owner_note ?? "").startsWith("hands-off") ? "" : ", and the owner accepted them"}. Each decision is the verdict most reviewers gave whose answer passed the harness's check: its cited claims are verified claims of this run, and its numbers are in them.`
      : end?.reason === PROGRESS_STOPPED
        ? `Research stopped adding (the progress rule): ${end.open.questions.length ? `${questionsWords(end.open.questions)} stayed open` : "no question stayed open"}${end.open.hypotheses.length ? `, and ${end.open.hypotheses.length} required ${end.open.hypotheses.length === 1 ? "hypothesis has" : "hypotheses have"} no verdict` : ""}. Each decision below is the review panel's that still stands.`
        : `The run ended before the review panel's decisions gave every question an end: ${open.questions.length ? `${questionsWords(open.questions)} stayed open` : "every question has an end"}. Each decision below is the review panel's that still stands.`;
  const lines = ["## The review panel's decisions", head, ""];
  contract.questions.forEach((text, i) => {
    lines.push(`### ${i + 1}. ${one(text)}`, "");
    const d = standing.get(`question:${i}`);
    if (!d) {
      lines.push("No decision stands: the review panel did not decide it on its newest card.", "");
      return;
    }
    const row = decisionRow(d);
    const panel = panelOf(d.review);
    const answers = panel
      .map((r) => r.questions.find((q) => q.index === i))
      .filter((q): q is CheckedQuestion => q?.valid === true && q.verdict === d.decision);
    const first = answers[0];
    lines.push(
      `Decision: ${decisionWords(d)} (review ${d.review}, card version ${d.card_version ?? "none"}; ${answers.length} of ${panel.length} reviewers).`,
      "",
    );
    if (first && d.decision !== "open") {
      lines.push(fence(first.answer), "");
      if (first.claims.length) lines.push(`Cites: ${first.claims.join(", ")}.`, "");
      if (first.next_experiments.trim())
        lines.push(`Next experiments: ${one(first.next_experiments)}`, "");
    } else if (d.decision === "open") {
      const gaps = [...new Set(answers.map((q) => clip(q.gaps, 400)).filter(Boolean))];
      lines.push(
        gaps.length
          ? `Evidence gaps: ${one(gaps.join(" / "))}`
          : `Open: ${listOf<Dissent>(row?.dissent).length ? "the reviewers' verdicts tied" : "no answer passed the check"}.`,
        "",
      );
    }
    const dissent = dissentLines(d);
    if (dissent.length) lines.push(...dissent, "");
  });
  const hypotheses = requiredHypotheses(ledger, run);
  lines.push("## Hypotheses: the review panel's verdicts");
  if (!hypotheses.length) lines.push("The run has no hypothesis that needs a verdict.");
  for (const h of hypotheses) {
    const d = standing.get(`hypothesis:${h.id}`);
    if (!d) {
      lines.push(`- ${one(h.text)} (${h.id}): no verdict yet.`);
      continue;
    }
    const panel = panelOf(d.review);
    const verdicts = panel
      .map((r) => r.hypotheses.find((x) => x.id === h.id))
      .filter((v): v is CheckedHypothesis => v?.valid === true && v.verdict === d.decision);
    const first = verdicts[0];
    lines.push(
      `- ${one(h.text)} (${h.id}): ${d.decision} (review ${d.review}; ${verdicts.length} of ${panel.length} reviewers).${first ? ` Why: ${one(first.why)}${first.claims.length ? ` Cites: ${first.claims.join(", ")}.` : ""}` : ""}`,
      ...dissentLines(d).map((x) => `  ${x}`),
    );
  }
  lines.push("");
  return lines;
}
