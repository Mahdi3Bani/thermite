import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResearchContract } from "../../core/contract.ts";
import { newExperimentId } from "../../core/ids.ts";
import {
  PAPER_ACCEPTED,
  PAPER_PARTS,
  PAPER_REFUSED,
  PAPER_REQUESTED,
} from "../../core/research-check.ts";
import { type Ledger, LedgerError } from "../ledger.ts";
import { type CardGap, cardsOf } from "./cards.ts";
import { checkCited, numbersIn, withoutReferences } from "./checks.ts";
import {
  claimsAppendix,
  numberCitations,
  type PaperItems,
  panelAppendix,
  referencesPart,
} from "./paper/appended.ts";
import { CITE, clip, FENCE, HEADING, LIST_ITEM, TABLE_ROW } from "./paper/markdown.ts";
import { questionEnded, standingDecisions } from "./progress.ts";
import {
  ANSWERED,
  type CheckedHypothesis,
  type CheckedQuestion,
  type CheckedReviewer,
  type ClaimRow,
  checkedPanel,
  type Dissent,
  PACKAGE_QUOTE_MAX,
  PACKAGE_QUOTES,
  type PackageClaim,
  type ResearchEnd,
  requiredHypotheses,
  researchEnd,
  researchPackage,
  verifiedClaims,
} from "./review.ts";

/**
 * A research run's final paper (goal 112). Once a research run ends (goal 117: the review panel's
 * pass is accepted, or the progress rule stops it), the run does not close at once: the harness
 * asks the supervisor's final writer for the run's research paper, one whole paper in Simplified
 * Technical English. The writer works from the run's research (read only) and the review panel's
 * standing decisions, with the questions that stayed open.
 *
 * The paper is written from the answer cards (goal 117), as a normal research paper that a person
 * reads from start to end (owner, 2026-10-24): an abstract, an introduction, the method, the
 * results, a discussion, the limitations and the future work, with the parts the writer chooses.
 * Code checks the paper before it is accepted, here, in code the writer cannot change: every
 * question with a verified claim is answered somewhere (the paper cites its evidence), every cited
 * claim is a verified claim of the run, every number in a paragraph is in the claims that
 * paragraph cites (or is one of the corpus figures the harness gave the writer), a verdict the
 * paper gives a hypothesis is the one the review panel gave, a hypothesis the panel did not judge
 * is given no verdict, and the STE checker the supervisor ran on the text found no error, when the
 * rig has one. A paper that fails is refused with its problems.
 *
 * An accepted paper gets what the writer does not write: each citation becomes the numbers of its
 * claim's sources, such as [1], and code appends the References and two appendices, the review
 * panel's decisions (each question's certainty, each hypothesis's verdict, each dissent) and the
 * claims cited. It is kept whole in its event; it leads the run's final report and is `paper.md`
 * in the run's research folder. Its next experiments become experiments in the campaign's
 * knowledge-base folder, for a goal or hill-climb run to take into its queue.
 */

type Row = Record<string, unknown>;

/** The parts code appends to an accepted paper: the writer writes none of them. */
const APPENDED = ["references", "bibliography", "appendix", "review panel"];

/** The most characters of a paper as the writer writes it (code appends the references). */
export const PAPER_MAX = 100_000;

/**
 * The most characters of the final writer's package (as JSON). A longer one is shortened in steps
 * the package states (`shortened`), never cut without a word: the writer reads the rest with its
 * tools.
 */
export const PAPER_PACKAGE_MAX = 200_000;
/** A reviewer's answer in the package, once the package is shortened: its first characters. */
export const PAPER_ANSWER_CHARS = 1500;
/** The most hypotheses proposed by the run that the package lists (goal 117). */
export const PROPOSED_MAX = 100;

/**
 * The kinds of next experiment (goal 119), by the run that takes one: an improvement a hill climb
 * measures against its champion, or an outcome a goal campaign proves.
 */
export const NEXT_KINDS = ["hill_climb", "goal"] as const;
export type NextKind = (typeof NEXT_KINDS)[number];
/** Each kind in words. */
export const NEXT_KIND_WORDS: Record<NextKind, string> = {
  hill_climb: "an improvement a hill climb measures against its champion",
  goal: "an outcome a goal campaign proves",
};
/** Each kind's section heading in the paper's part on future work. */
export const NEXT_HEADINGS: Record<NextKind, string> = {
  hill_climb: "For a hill climb",
  goal: "For a goal campaign",
};
/** What a kind's measure says. */
const MEASURE_WORDS: Record<NextKind, string> = {
  hill_climb: "the metric it should move, and which way",
  goal: "how a check would know the goal is reached",
};
export const isNextKind = (k: string): k is NextKind =>
  (NEXT_KINDS as readonly string[]).includes(k);

/** The rules a paper is written to and checked against, in words: the writer's package carries them. */
export const PAPER_RULES = [
  "The paper is Markdown in Simplified Technical English (descriptive text). Write it as a research paper that a person reads from start to end, such as a paper for arXiv: paragraphs that explain, not lists of records. Use a list or a table only where it helps the reader.",
  "Its first line is its title, a level-1 heading (# Title). No other level-1 heading.",
  `Then its parts, each a level-2 heading (##). A usual paper has these parts, in this order: ${PAPER_PARTS.map((p) => `${p.part} (${p.what})`).join("; ")}. Choose the parts and their words that fit the topic, and put other headings at level 3 (###) under a part. Code does not check the parts.`,
  "Do not write a References part or an appendix: code appends them. References lists the sources of the claims that the paper cites. Appendix A gives the review panel's decision and certainty on each question, its verdict on each hypothesis, each dissent, and the hypotheses that the run proposed. Appendix B lists each claim that the paper cites, with its sources.",
  "Answer every question of the run, with the claims that are its evidence: the claims of its card (questions[].claims) or other verified claims of that question. Code checks that the paper cites evidence for each question that has a verified claim. Give each answer's certainty in words, as the review panel decided it (questions[].certainty). For a question that stayed open (questions[].stayed_open), write what the evidence shows and what is missing. When reviewers dissent (questions[].dissent), say so, with the reason.",
  "Cite a claim as [c-ID] in each sentence that states a fact, such as [c-0a1b2c3d4e5f]; several as [c-…, c-…]. Each cited id must be a verified claim of the run. Code changes each citation to the numbers of its claims' sources in References, such as [1] or [1, 3].",
  "Every number in a paragraph, a list item or a table row must be in the claims it cites (their text or quotes), or be one of the figures in the package. Numbers in headings, record ids, question numbers (question 2) and the numbers in the run's questions and hypotheses are not checked.",
  "Discuss each hypothesis in the package's hypotheses, with the verdict that the review panel gave: supported, refuted or undecided (undecided when it gave none). Name a hypothesis by its words. The hypotheses in proposed were not judged: give them no verdict. A table row whose first cell names a hypothesis's id (h-…), or a line \"Verdict: …\" under a heading that names it, is checked: its verdict must be the review panel's.",
  `Put the next experiments in the part on future work: the measurement gaps of the cards and the next experiments that the review panel named (questions[].next_experiments), then what else to try, each with why. Give it a ### section for each kind of next experiment it has: ${NEXT_KINDS.map((k) => `### ${NEXT_HEADINGS[k]} (${NEXT_KIND_WORDS[k]})`).join(", and ")}. Give each next experiment the same kind in experiments.`,
];

/** The fields of one of the paper's next experiments (the supervisor reads a model's answer with them). */
export const PAPER_EXPERIMENT_FIELDS = {
  title: z.string().trim().min(1).max(200),
  why: z.string().trim().min(1).max(2000),
  details: z.string().max(4000).default(""),
  /**
   * The run it is for (goal 119): `hill_climb` or `goal`. Read whatever its case and spacing
   * ("Hill climb", "goal campaign"); checked in code, with words, when it is neither.
   */
  kind: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_")
            .replace(/^goal_campaign$/, "goal")
        : v,
    z.string().max(40).default(""),
  ),
  /** For a hill climb, the metric it should move and which way; for a goal, how a check knows it is reached. */
  measure: z.string().trim().max(2000).default(""),
  findings: z.array(z.string().min(1).max(100)).max(50).default([]),
  claims: z.array(z.string().min(1).max(100)).max(50).default([]),
};

/** One of the paper's next experiments, as the writer gives it beside the paper. */
export const PaperExperiment = z.strictObject(PAPER_EXPERIMENT_FIELDS);
export type PaperExperiment = z.infer<typeof PaperExperiment>;

/** One finding of the STE checker, as the supervisor posts it. */
const SteFinding = z.object({
  line: z.number().int().min(0),
  column: z.number().int().min(0).optional(),
  severity: z.string().max(20),
  rule: z.string().max(100),
  message: z.string().max(1000),
  text: z.string().max(500).default(""),
});

/**
 * The STE checker's result on the paper's text, as the supervisor ran it (never the model): its
 * counts and findings, and the SHA-256 of the text it checked. Or why it did not run.
 */
export const SteResult = z.discriminatedUnion("checked", [
  z.strictObject({
    checked: z.literal(true),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.string().max(100).nullable().default(null),
    issue: z.string().max(100).nullable().default(null),
    counts: z.strictObject({
      error: z.number().int().min(0),
      warning: z.number().int().min(0),
      info: z.number().int().min(0),
    }),
    findings: z.array(SteFinding).max(200).default([]),
  }),
  z.strictObject({ checked: z.literal(false), why: z.string().min(1).max(500) }),
]);
export type SteResult = z.infer<typeof SteResult>;

/** What the supervisor posts for a run's paper. */
export const PaperSubmission = z.strictObject({
  writer: z.string().trim().min(1).max(100),
  paper: z.string().min(1).max(PAPER_MAX),
  experiments: z.array(PaperExperiment).max(50).default([]),
  ste: SteResult,
});
export type PaperSubmission = z.infer<typeof PaperSubmission>;

/** A problem code found in a paper, at its line (1 first), or for the whole paper (null). */
export interface PaperProblem {
  line: number | null;
  problem: string;
}

/**
 * The corpus figures the writer is given, frozen when the paper is requested: the Method part may
 * state them, and a number equal to one is never refused.
 */
export interface PaperFigures {
  sources: number;
  domains: number;
  verified_claims: number;
  corroborated_claims: number;
  draft_claims: number;
  findings: number;
  draft_findings: number;
  questions: number;
  hypotheses: number;
  min_independent_domains: number;
  review: number;
  reviewers: number;
}

/** The final writer's package: the review panel's decisions and the run's brief and figures. */
export interface PaperPackage {
  kind: "paper";
  run: string;
  /** The accepted review, or for a run the progress rule stopped, its newest decided review (0: none). */
  review: number;
  requested_at: string;
  title: string;
  topic: string;
  /**
   * How the run ended (goal 117): `every question is answered`, or the progress rule's reason;
   * `open` the questions (numbered from 1) that stayed open, and the required hypotheses with no
   * verdict.
   */
  end: { reason: string; open: number[]; open_hypotheses: string[] };
  questions: {
    number: number;
    text: string;
    /** The standing decision: answered, insufficient or open; null: none on its newest card. */
    decision: string | null;
    certainty: string | null;
    /** It has no end: the paper says what is missing. */
    stayed_open: boolean;
    /** The question's answer card (goal 117): what its answer is written from. Null: none. */
    card: {
      version: number;
      answer: string;
      certainty: string;
      gaps: CardGap[];
      created_at: string;
    } | null;
    /** The claims the card cites, with their quotes: the answer's evidence. */
    claims: PackageClaim[];
    /** The card's claims left out here to keep the package short (read them with the tools). */
    claims_not_shown?: number | undefined;
    /** All the question's verified claims: its answer may cite any of them. */
    verified_claims: number;
    /** What only a measurement could settle: the card's measurement gaps and the reviewers' next experiments. */
    next_experiments: string[];
    /** How many reviewers gave the decision with an answer that passed the check, and those answers. */
    answered_by: number;
    answers: { answer: string; claims: string[]; gaps: string; next_experiments: string }[];
    /** Answers of `answered_by` left out here to keep the package short. */
    answers_not_shown?: number | undefined;
    dissent: Dissent[];
  }[];
  /** The hypotheses that need a verdict: the author's and those promoted (goal 117). */
  hypotheses: {
    id: string;
    text: string;
    status: string;
    /** Its question, numbered from 1; null: about the whole run. */
    question: number | null;
    /** The standing verdict, with how many reviewers gave it (empty: no verdict yet). */
    verdicts: { verdict: string; reviewers: number; why: string; claims: string[] }[];
    dissent: Dissent[];
  }[];
  /** The hypotheses the run proposed that need no verdict (status pool): listed, never judged. */
  proposed: { id: string; text: string; question: number | null }[];
  /** Hypotheses proposed by the run left out of `proposed` (more than PROPOSED_MAX, or to keep the package short). */
  proposed_not_shown?: number | undefined;
  reviewers: number;
  figures: PaperFigures;
  rules: string[];
  /** Said when the package was shortened to keep it within PAPER_PACKAGE_MAX: what was left out. */
  shortened?: string | undefined;
  /** The newest refusal of a paper for this run, when there is one: fix these first. */
  last_refusal?: { at: string; problems: string[] } | undefined;
}

const VERDICT = /^\s*(?:[-*+]\s*)?[*_]*verdict[*_]*\s*:\s*[*_]*(supported|refuted|undecided)\b/i;
const VERDICT_WORD = /^[*_\s]*(supported|refuted|undecided)[*_.\s]*$/i;

/** A table row's cells, without the outer pipes; a separator row (|---|) has none. */
function cellsOf(row: string): string[] {
  const t = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = t.split(/(?<!\\)\|/).map((c) => c.trim());
  return cells.every((c) => /^:?-{3,}:?$/.test(c)) ? [] : cells;
}

/** Whether a text names a record id as a whole word: h-a1 is not in h-a12. */
const names = (text: string, id: string) =>
  new RegExp(
    `(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
  ).test(text);

/** Words of a heading, folded for matching: "## Appendix A: Data" -> "appendix a data". */
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The claim ids a text cites, in order, each once. */
export function citationsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITE))
    for (const id of (m[1] as string).split(/[,;]/).map((x) => x.trim()))
      if (id && !out.includes(id)) out.push(id);
  return out;
}

/**
 * A paragraph's text with what is not a stated number taken out: its citations, record ids
 * (c-…, h-…, f-…), question numbers ("question 2", "Q2") and a list item's own number.
 */
function forNumbers(text: string): string {
  return withoutReferences(text.replace(CITE, " "));
}

/** Whether an id is a verified claim of the run. */
const verifiedClaim = (ledger: Ledger, run: string, id: string) =>
  ledger.claims.get(run, id)?.verified === true;

/** A number as it may be written: 1200 and 1,200. */
const spellings = (n: number) => [String(n), n.toLocaleString("en-US")];

/** What a paper is checked against: the run's questions, required hypotheses and standing verdicts. */
export interface PaperBasis {
  review: number;
  questions: string[];
  /** Questions (indexes) with no verified claim: the paper need not cite evidence for them. */
  bare?: number[] | undefined;
  hypotheses: { id: string; text: string }[];
  /** Each hypothesis's standing verdict (goal 117). */
  verdicts: Map<string, Set<string>>;
  figures: PaperFigures;
  /**
   * Each question's evidence, by index (goal 117): its card's claims and the verified claims of the
   * question. The paper answers a question when it cites one of them. Without it, not checked.
   */
  evidence?: Set<string>[] | undefined;
  /** The hypotheses the run proposed that need no verdict, and get none (goal 117). */
  proposed?: { id: string; text: string }[] | undefined;
}

interface Line {
  n: number;
  text: string;
  fence: boolean;
  heading?: { level: number; text: string } | undefined;
}

interface Unit {
  line: number;
  text: string;
  heading: boolean;
}

/**
 * Code's checks of a paper (goal 112), with each problem at its line: its title, no part that code
 * appends, every question with a verified claim answered somewhere (the paper cites its evidence),
 * every cited id a verified claim of the run, every number in a paragraph in the claims it cites or
 * among the figures, and every verdict it gives a hypothesis one the review panel gave. The writer
 * chooses the paper's parts (owner, 2026-10-24); code does not check them. No problem: the paper
 * holds.
 */
export function checkPaper(
  ledger: Ledger,
  run: string,
  basis: PaperBasis,
  markdown: string,
): { problems: PaperProblem[]; cited: string[] } {
  const problems: PaperProblem[] = [];
  const say = (line: number | null, problem: string) => problems.push({ line, problem });
  let inFence = false;
  const lines: Line[] = markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text, i) => {
      if (FENCE.test(text)) {
        inFence = !inFence;
        return { n: i + 1, text, fence: true };
      }
      if (inFence) return { n: i + 1, text, fence: true };
      const h = HEADING.exec(text);
      return {
        n: i + 1,
        text,
        fence: false,
        ...(h ? { heading: { level: (h[1] as string).length, text: h[2] as string } } : {}),
      };
    });

  // The title, and no part that code appends.
  const first = lines.find((l) => l.text.trim());
  if (first?.heading?.level !== 1)
    say(first?.n ?? 1, "the paper starts with its title, as a level-1 heading: # Title");
  for (const l of lines.filter((x) => x.heading?.level === 1 && x !== first))
    say(l.n, "only the title is a level-1 heading (#): use ## for a part, ### under it");
  for (const l of lines) {
    if (l.heading?.level !== 2) continue;
    const words = fold(l.heading.text);
    if (APPENDED.some((a) => words.startsWith(a)))
      say(
        l.n,
        `leave out the "## ${clip(l.heading.text, 80)}" part: code appends the References and the appendices (the review panel's decisions, and the claims the paper cites)`,
      );
  }

  // Its paragraphs (a list item or a table row each its own).
  const units: Unit[] = [];
  let cur: Unit | undefined;
  const flush = () => {
    if (cur) units.push(cur);
    cur = undefined;
  };
  for (const l of lines) {
    if (l.heading) {
      flush();
      units.push({ line: l.n, text: l.text, heading: true });
      continue;
    }
    if (!l.text.trim()) {
      flush();
      continue;
    }
    if (!l.fence && (LIST_ITEM.test(l.text) || TABLE_ROW.test(l.text))) flush();
    if (cur) cur.text += `\n${l.text}`;
    else cur = { line: l.n, text: l.text, heading: false };
  }
  flush();

  // Citations and numbers, paragraph by paragraph. The numbers of the run's own questions and
  // hypotheses may be written anywhere: they are its words, not facts the paper states.
  const figures = Object.values(basis.figures).flatMap(spellings);
  const own = [
    ...basis.questions.flatMap(numbersIn),
    ...[...basis.hypotheses, ...(basis.proposed ?? [])].flatMap((h) => numbersIn(h.text)),
  ];
  const cited: string[] = [];
  const idSaid = new Set<string>();
  for (const u of units) {
    const ids = citationsIn(u.text);
    for (const id of ids) if (!cited.includes(id)) cited.push(id);
    const r = checkCited(ledger, run, ids, u.heading ? [] : [forNumbers(u.text)], [
      ...figures,
      ...own,
    ]);
    for (const p of r.problems) {
      const num = /^the number (\S+) is not in the claims it cites$/.exec(p);
      if (!num) {
        // A bad id once, at its first line.
        if (!idSaid.has(p)) say(u.line, p);
        idSaid.add(p);
        continue;
      }
      say(
        u.line,
        ids.length
          ? `the number ${num[1]} is not in the claims this paragraph cites (${ids.join(", ")}) or in the figures`
          : `the number ${num[1]} has no claim cited beside it: cite the claims it comes from in this paragraph, as [c-…]`,
      );
    }
  }
  if (!cited.length) say(null, "the paper cites no claim");

  // Every question answered somewhere: the paper cites some of its evidence (goal 117).
  basis.questions.forEach((text, i) => {
    const evidence = basis.evidence?.[i];
    if (basis.bare?.includes(i) || !evidence?.size || cited.some((id) => evidence.has(id))) return;
    const ids = [...evidence];
    say(
      null,
      `question ${i + 1} is not answered: the paper cites none of its evidence (${clip(text, 120)}). Answer it, and cite the claims of its card or other verified claims of question ${i + 1}: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? `, and ${ids.length - 8} more` : ""}`,
    );
  });

  // Hypotheses: a verdict the paper gives (a table row whose first cell names the hypothesis, or
  // a "Verdict: …" line under a heading that names it) is one the review panel gave (goal 117).
  const rows = lines
    .filter((l) => !l.fence && TABLE_ROW.test(l.text))
    .map((l) => ({ l, cells: cellsOf(l.text) }))
    .filter((r) => r.cells.length > 0);
  const verdictOf = (id: string): { line: number; said: string } | undefined => {
    for (const row of rows.filter((r) => names(r.cells[0] ?? "", id))) {
      const cell = row.cells.slice(1).find((c) => VERDICT_WORD.test(c));
      const m = cell ? VERDICT_WORD.exec(cell) : null;
      if (m) return { line: row.l.n, said: (m[1] as string).toLowerCase() };
    }
    for (const [i, l] of lines.entries()) {
      if (!l.heading || l.heading.level < 3 || !names(l.heading.text, id)) continue;
      const level = l.heading.level;
      for (const x of lines.slice(i + 1)) {
        if (x.heading && x.heading.level <= level) break;
        const m = x.fence ? null : VERDICT.exec(x.text);
        if (m) return { line: x.n, said: (m[1] as string).toLowerCase() };
      }
    }
    return undefined;
  };
  for (const h of basis.hypotheses) {
    const v = verdictOf(h.id);
    if (!v) continue;
    const gave = basis.verdicts.get(h.id) ?? new Set<string>();
    const allowed = gave.size ? gave : new Set(["undecided"]);
    if (!allowed.has(v.said))
      say(
        v.line,
        gave.size
          ? `the verdict "${v.said}" on hypothesis ${h.id} is not one the review panel gave: it gave ${[...gave].join(" or ")}`
          : `the review panel has no verdict on hypothesis ${h.id}: write "undecided"`,
      );
  }
  // A hypothesis the run proposed has no verdict: the review panel did not judge it.
  for (const h of basis.proposed ?? []) {
    const v = verdictOf(h.id);
    if (v?.said === "supported" || v?.said === "refuted")
      say(
        v.line,
        `hypothesis ${h.id} was proposed by the run, and the review panel did not judge it: give it no verdict`,
      );
  }

  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { problems, cited };
}

/**
 * Each next experiment checked: its kind and measure (goal 119), and that it rests on supported
 * findings or verified claims of the run.
 */
export function checkExperiments(ledger: Ledger, run: string, xs: PaperExperiment[]): string[] {
  const out: string[] = [];
  xs.forEach((x, i) => {
    const which = `next experiment ${i + 1} ("${clip(x.title, 80)}")`;
    if (!isNextKind(x.kind))
      out.push(
        `${which} ${x.kind ? `has the kind "${clip(x.kind, 40)}", which is not one` : "has no kind"}: give hill_climb (${NEXT_KIND_WORDS.hill_climb}) or goal (${NEXT_KIND_WORDS.goal})`,
      );
    else if (!x.measure) out.push(`${which} has no measure: give ${MEASURE_WORDS[x.kind]}`);
    if (!x.findings.length && !x.claims.length)
      out.push(
        `${which} rests on no finding or claim: give the ids of the supported findings or verified claims it builds on`,
      );
    for (const f of [...new Set(x.findings)]) {
      const row = ledger.claims.finding(run, f);
      if (!row) out.push(`${which}: no finding ${f}`);
      else if (!row.supported) out.push(`${which}: finding ${f} is a draft, not supported`);
    }
    for (const p of checkCited(ledger, run, x.claims, []).problems) out.push(`${which}: ${p}`);
  });
  return out;
}

/**
 * The paper has a ### section for each kind its next experiments have (goal 119), headed as
 * NEXT_HEADINGS says, in the part on future work or wherever the writer puts its next experiments.
 * Problems in words, or none.
 */
export function nextSectionProblems(markdown: string, xs: PaperExperiment[]): PaperProblem[] {
  const kinds = [...new Set(xs.map((x) => x.kind).filter(isNextKind))];
  if (!kinds.length) return [];
  const headings: string[] = [];
  let fence = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h && (h[1] as string).length >= 3) headings.push(fold(h[2] as string));
  }
  return kinds
    .filter((k) => !headings.some((x) => x.startsWith(fold(NEXT_HEADINGS[k]))))
    .map((k) => {
      const n = xs.filter((x) => x.kind === k).length;
      return {
        line: null,
        problem: `the paper has no "### ${NEXT_HEADINGS[k]}" section, and ${n} of its next experiments ${n === 1 ? "is" : "are"} for ${k === "goal" ? "a goal campaign" : "a hill climb"}: put ${n === 1 ? "it" : "them"} under that heading, in the part on future work`,
      };
    });
}

/** The SHA-256 of a paper's text, as the supervisor names the text its STE checker read. */
export const paperSha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The STE checker's result held to the paper: it is of this text, and it found no error. A paper
 * the rig had no checker for is not refused here; it is accepted as not checked, and says so.
 */
export function steProblems(ste: SteResult, paper: string): PaperProblem[] {
  if (!ste.checked) return [];
  if (ste.sha256 !== paperSha(paper))
    return [{ line: null, problem: "the STE checker's result is not of this paper's text" }];
  if (ste.counts.error === 0) return [];
  const errors = ste.findings.filter((f) => f.severity === "error");
  return [
    {
      line: null,
      problem: `the STE checker found ${ste.counts.error} ${ste.counts.error === 1 ? "error" : "errors"}`,
    },
    ...errors.slice(0, 20).map((f) => ({
      line: f.line || null,
      problem: `STE ${f.rule}: ${clip(f.message, 300)}${f.text ? ` ("${clip(f.text, 80)}")` : ""}`,
    })),
    ...(errors.length > 20
      ? [{ line: null, problem: `and ${errors.length - 20} more STE errors` }]
      : []),
  ];
}

/** The figures of a run's corpus now, for its paper's request. */
function figuresNow(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  review: Row | undefined,
): PaperFigures {
  const corpus = researchPackage(ledger, run, contract).corpus;
  return {
    sources: corpus.sources,
    domains: corpus.domains,
    verified_claims: corpus.verified_claims,
    corroborated_claims: corpus.corroborated_claims,
    draft_claims: ledger.claims.count(run, { verified: false }),
    findings: corpus.findings,
    draft_findings: ledger.claims.countFindings(run, false),
    questions: contract.questions.length,
    hypotheses: ledger.hypotheses.count(run),
    min_independent_domains: corpus.min_independent_domains,
    review: review ? Number(review.id) : 0,
    reviewers: review ? checkedPanel(review).length : 0,
  };
}

/** The event body of a paper's request, as the harness keeps it. */
interface PaperRequest {
  review: number;
  figures: PaperFigures;
  /** How the run ended; a request from before goal 117 has none: answered. */
  end?: string;
}

/** Whether a request is for the run's end: the same end, and for an answered run the same review. */
const forEnd = (b: PaperRequest, end: ResearchEnd) =>
  (b.end ?? ANSWERED) === end.reason &&
  (end.reason !== ANSWERED || Number(b.review) === Number(end.review?.id));

/**
 * A run's research papers: asked for once its review's pass is accepted, listed for the final
 * writer while it waits, checked, and accepted or refused. Every step is an event of the run.
 */
export class Papers {
  private readonly ledger: Ledger;
  private readonly contractFor: (run: string) => unknown;

  constructor(ledger: Ledger, contractFor: (run: string) => unknown) {
    this.ledger = ledger;
    this.contractFor = contractFor;
  }

  private contract(run: string): ResearchContract {
    const c = this.contractFor(run) as ResearchContract | undefined;
    if (c?.mode !== "research") throw new LedgerError("invalid", `${run} is not a research run`);
    return c;
  }

  /** The run's accepted paper, as its event keeps it: the paper whole, with its references and appendices. */
  accepted(run: string): Row | undefined {
    return this.ledger.latestEventBody(PAPER_ACCEPTED, run);
  }

  /** The request for the paper of the run's end, when the harness made it. */
  requested(run: string): { review: number; figures: PaperFigures; at: string } | undefined {
    const end = researchEnd(this.ledger, run);
    if (!end) return undefined;
    const row = this.ledger.events.newest(PAPER_REQUESTED, { subject: run });
    if (!row) return undefined;
    const b = row.body as PaperRequest;
    return forEnd(b, end) ? { review: b.review, figures: b.figures, at: row.at } : undefined;
  }

  /**
   * Asks the final writer for the paper of a run that ended (its review's pass accepted, or the
   * progress rule's stop), once: the figures of its corpus are frozen in the request. False when
   * there is nothing to ask.
   */
  request(run: string, by: string): boolean {
    const end = researchEnd(this.ledger, run);
    if (!end || this.requested(run) || this.accepted(run)) return false;
    const figures = figuresNow(this.ledger, run, this.contract(run), end.review);
    this.ledger.appendEvent(by, PAPER_REQUESTED, run, {
      review: figures.review,
      figures,
      end: end.reason,
    });
    return true;
  }

  /**
   * Where each item of a run stands, for its paper (goal 117): each question's standing decision,
   * the checked answers behind it and its dissent; the same for each required hypothesis.
   */
  private items(run: string): PaperItems {
    const standing = standingDecisions(this.ledger, run);
    const panels = new Map<number, CheckedReviewer[]>();
    const panelOf = (review: number) => {
      if (!panels.has(review)) {
        const row = this.ledger.reviews.get(review);
        panels.set(review, row ? checkedPanel(row) : []);
      }
      return panels.get(review) ?? [];
    };
    const dissentOf = (kind: string, key: string, review: number): Dissent[] => {
      const row = this.ledger.reviews.decision(run, kind, key, review);
      try {
        return row ? (JSON.parse(row.dissent) as Dissent[]) : [];
      } catch {
        return [];
      }
    };
    return {
      questions: this.contract(run).questions.map((text, index) => {
        const d = standing.get(`question:${index}`);
        return {
          index,
          text,
          decision: d,
          answers: d
            ? panelOf(d.review)
                .map((r) => r.questions.find((q) => q.index === index))
                .filter((q): q is CheckedQuestion => q?.valid === true && q.verdict === d.decision)
            : [],
          dissent: d ? dissentOf("question", String(index), d.review) : [],
        };
      }),
      hypotheses: requiredHypotheses(this.ledger, run).map((h) => {
        const d = standing.get(`hypothesis:${h.id}`);
        return {
          ...h,
          decision: d,
          given: d
            ? panelOf(d.review)
                .map((r) => r.hypotheses.find((x) => x.id === h.id))
                .filter(
                  (x): x is CheckedHypothesis => x?.valid === true && x.verdict === d.decision,
                )
            : [],
          dissent: d ? dissentOf("hypothesis", h.id, d.review) : [],
        };
      }),
    };
  }

  /** The hypotheses the run proposed that need no verdict (status pool), the oldest first. */
  private proposed(run: string): { id: string; text: string; question: number | null }[] {
    return this.ledger.hypotheses
      .withStatus(run, ["pool"])
      .map((h) => ({ id: h.id, text: h.text, question: h.question }));
  }

  /** What a run's paper is checked against; it must wait for its paper. */
  basis(run: string): PaperBasis {
    const inst = this.ledger.runs.get(run);
    if (!inst) throw new LedgerError("not_found", `no run ${run}`);
    if (inst.status !== "running") throw new LedgerError("invalid", `run ${run} is ${inst.status}`);
    if (this.accepted(run))
      throw new LedgerError("conflict", `run ${run} already has its research paper`);
    const asked = this.requested(run);
    if (!asked) throw new LedgerError("invalid", `run ${run} does not wait for a research paper`);
    const questions = this.contract(run).questions;
    const items = this.items(run);
    const verdicts = new Map<string, Set<string>>();
    for (const h of items.hypotheses)
      if (h.decision) verdicts.set(h.id, new Set([h.decision.decision]));
    const counts = this.ledger.claims.verifiedByQuestion(run);
    const cards = new Map(cardsOf(this.ledger, run).map((c) => [c.question, c]));
    const ofQuestion = new Map<number, string[]>();
    for (const c of this.ledger.claims.verifiedWithQuestion(run))
      ofQuestion.set(Number(c.question), [...(ofQuestion.get(Number(c.question)) ?? []), c.id]);
    return {
      review: asked.review,
      questions,
      bare: questions.map((_, i) => i).filter((i) => !counts.get(i)),
      hypotheses: items.hypotheses.map((h) => ({ id: h.id, text: h.text })),
      verdicts,
      figures: asked.figures,
      evidence: questions.map(
        (_, i) =>
          new Set([
            ...(cards.get(i)?.claims ?? []).filter((c) => verifiedClaim(this.ledger, run, c)),
            ...(ofQuestion.get(i) ?? []),
          ]),
      ),
      proposed: this.proposed(run).map((h) => ({ id: h.id, text: h.text })),
    };
  }

  /**
   * A draft checked, as the writer's check_paper tool asks: each problem with its line; with its
   * next experiments when it gives them (goal 119).
   */
  check(
    run: string,
    markdown: string,
    experiments?: PaperExperiment[],
  ): { ok: boolean; problems: PaperProblem[] } {
    const { problems } = checkPaper(this.ledger, run, this.basis(run), markdown);
    if (experiments)
      problems.push(
        ...checkExperiments(this.ledger, run, experiments).map((problem) => ({
          line: null,
          problem,
        })),
        ...nextSectionProblems(markdown, experiments),
      );
    return { ok: problems.length === 0, problems };
  }

  /** The runs waiting for their paper, each as the final writer's package. */
  pending(): PaperPackage[] {
    return this.ledger.runs.ids("research", "running").flatMap((id) => {
      const asked = this.requested(id);
      const end = researchEnd(this.ledger, id);
      if (!asked || !end || this.accepted(id)) return [];
      return [this.package(id, asked, end)];
    });
  }

  /**
   * The final writer's package for a run (goal 117): each question with its card and the card's
   * claims, the review panel's decision with the answers behind it and the dissent, and what only
   * a measurement could settle; the required hypotheses with their verdicts; the hypotheses the
   * run proposed. One longer than PAPER_PACKAGE_MAX is shortened in steps it states.
   */
  private package(
    id: string,
    asked: { review: number; figures: PaperFigures; at: string },
    end: ResearchEnd,
  ): PaperPackage {
    const contract = this.contract(id);
    const items = this.items(id);
    const claims = verifiedClaims(this.ledger, id, contract.quality.min_independent_sources);
    const cards = new Map(cardsOf(this.ledger, id).map((c) => [c.question, c]));
    const counts = this.ledger.claims.verifiedByQuestion(id);
    const proposed = this.proposed(id);
    // The newest refusal since the newest request, if there is one.
    const request = this.ledger.events.lastId(PAPER_REQUESTED, { subject: id });
    const refused = request
      ? this.ledger.events.newest(PAPER_REFUSED, { subject: id, after: request })
      : undefined;
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
    interface Form {
      chars: number | null;
      quotes: boolean;
      answers: number | null;
      claims: number | null;
      proposed: number;
    }
    const cut = (s: string, f: Form) => (f.chars === null ? s : clip(s, f.chars));
    const build = (f: Form, shortened: string | undefined): PaperPackage => {
      const questions = items.questions.map((q) => {
        const card = cards.get(q.index);
        const all = [...new Set(card?.claims ?? [])].flatMap((c) => {
          const row = claims.get(c);
          return row ? [row] : [];
        });
        const shown = f.claims === null ? all : all.slice(0, f.claims);
        const answers = f.answers === null ? q.answers : q.answers.slice(0, f.answers);
        const next = [
          ...(card?.gaps ?? []).filter((g) => g.kind === "measurement").map((g) => g.text),
          ...q.answers.map((a) => a.next_experiments.trim()).filter(Boolean),
        ];
        return {
          number: q.index + 1,
          text: q.text,
          decision: q.decision?.decision ?? null,
          certainty: q.decision?.certainty ?? null,
          stayed_open: !questionEnded(q.decision),
          card: card
            ? {
                version: card.version,
                answer: card.answer,
                certainty: card.certainty,
                gaps: card.gaps,
                created_at: card.created_at,
              }
            : null,
          claims: shown.map((c) => toClaim(c, f.quotes)),
          ...(shown.length < all.length ? { claims_not_shown: all.length - shown.length } : {}),
          verified_claims: counts.get(q.index) ?? 0,
          next_experiments: [...new Set(next)].map((x) => cut(x, f)),
          answered_by: q.answers.length,
          answers: answers.map((a) => ({
            answer: cut(a.answer, f),
            claims: a.claims,
            gaps: cut(a.gaps, f),
            next_experiments: cut(a.next_experiments, f),
          })),
          ...(answers.length < q.answers.length
            ? { answers_not_shown: q.answers.length - answers.length }
            : {}),
          dissent: q.dissent,
        };
      });
      const listed = proposed.slice(0, f.proposed);
      return {
        kind: "paper" as const,
        run: id,
        review: asked.review,
        requested_at: asked.at,
        title: contract.title,
        topic: contract.topic,
        end: {
          reason: end.reason,
          open: questions.filter((q) => q.stayed_open).map((q) => q.number),
          open_hypotheses: end.open.hypotheses,
        },
        questions,
        hypotheses: items.hypotheses.map((h) => ({
          id: h.id,
          text: h.text,
          status: h.status,
          question: h.question === null ? null : h.question + 1,
          verdicts: h.decision
            ? [
                {
                  verdict: h.decision.decision,
                  reviewers: h.given.length,
                  why: cut(h.given[0]?.why ?? "", f),
                  claims: h.given[0]?.claims ?? [],
                },
              ]
            : [],
          dissent: h.dissent,
        })),
        proposed: listed.map((h) => ({
          id: h.id,
          text: h.text,
          question: h.question === null ? null : h.question + 1,
        })),
        ...(listed.length < proposed.length
          ? { proposed_not_shown: proposed.length - listed.length }
          : {}),
        reviewers: asked.figures.reviewers,
        figures: asked.figures,
        rules: PAPER_RULES,
        ...(shortened ? { shortened } : {}),
        ...(refused
          ? {
              last_refusal: {
                at: refused.at,
                problems: refused.body.problems ?? [],
              },
            }
          : {}),
      };
    };
    const most = Math.max(1, ...[...cards.values()].map((c) => c.claims.length));
    const steps: { f: Form; said: string }[] = [
      {
        f: {
          chars: PAPER_ANSWER_CHARS,
          quotes: true,
          answers: null,
          claims: null,
          proposed: PROPOSED_MAX,
        },
        said: `each reviewer's answer and each next experiment is cut to its first ${PAPER_ANSWER_CHARS} characters (a cut ends with "…")`,
      },
      {
        f: {
          chars: PAPER_ANSWER_CHARS,
          quotes: false,
          answers: null,
          claims: null,
          proposed: PROPOSED_MAX,
        },
        said: "the claims are shown without their quotes",
      },
      {
        f: {
          chars: PAPER_ANSWER_CHARS,
          quotes: false,
          answers: 1,
          claims: null,
          proposed: PROPOSED_MAX,
        },
        said: "each question shows one of the answers behind its decision (answers_not_shown counts the others)",
      },
      {
        f: { chars: PAPER_ANSWER_CHARS, quotes: false, answers: 1, claims: null, proposed: 30 },
        said: "proposed lists the first 30 hypotheses that the run proposed (proposed_not_shown counts the others)",
      },
    ];
    for (let k = Math.ceil(most / 2); k >= 1; k = k === 1 ? 0 : Math.ceil(k / 2))
      steps.push({
        f: { chars: PAPER_ANSWER_CHARS, quotes: false, answers: 1, claims: k, proposed: 30 },
        said: `each question shows the first ${k} ${k === 1 ? "claim" : "claims"} of its card (claims_not_shown counts the others)`,
      });
    let pkg = build(
      { chars: null, quotes: true, answers: null, claims: null, proposed: PROPOSED_MAX },
      undefined,
    );
    const said: string[] = [];
    for (const step of steps) {
      if (JSON.stringify(pkg).length <= PAPER_PACKAGE_MAX) break;
      // Each step keeps the cuts of the steps before it; a shorter claims step replaces the last.
      const claimsStep = (x: string | undefined) => x?.startsWith("each question shows the first");
      if (claimsStep(step.said) && claimsStep(said.at(-1))) said[said.length - 1] = step.said;
      else said.push(step.said);
      pkg = build(
        step.f,
        `To keep this package short: ${said.join("; ")}. Read every claim, quote and source of the run with the tools.`,
      );
    }
    return pkg;
  }

  /**
   * A paper the supervisor posts for a run that waits for one: checked by code, then accepted or
   * refused with its problems. Accepted, its citations become numbered references, and it is kept
   * whole with the References and the appendices that code appends; each next experiment becomes
   * an experiment of the campaign's knowledge-base folder.
   */
  submit(
    run: string,
    input: PaperSubmission,
    by: string,
  ):
    | { accepted: true; chars: number; cited: number; experiments: string[]; ste_checked: boolean }
    | { accepted: false; problems: PaperProblem[] } {
    const basis = this.basis(run);
    const checked = checkPaper(this.ledger, run, basis, input.paper);
    const problems: PaperProblem[] = [
      ...checked.problems,
      ...checkExperiments(this.ledger, run, input.experiments).map((problem) => ({
        line: null,
        problem,
      })),
      ...nextSectionProblems(input.paper, input.experiments),
      ...steProblems(input.ste, input.paper),
    ];
    if (problems.length) {
      this.ledger.appendEvent(by, PAPER_REFUSED, run, {
        review: basis.review,
        writer: input.writer,
        count: problems.length,
        problems: problems
          .slice(0, 20)
          .map((p) => clip(`${p.line ? `line ${p.line}: ` : ""}${p.problem}`, 300)),
        ste_checked: input.ste.checked,
      });
      return { accepted: false, problems };
    }
    // What readers get: numbered references, then the parts code writes (owner, 2026-10-24).
    const numbered = numberCitations(
      this.ledger,
      run,
      input.paper.replace(/\s+$/, ""),
      checked.cited,
    );
    const paper = [
      numbered.text,
      "",
      ...referencesPart(numbered.references),
      "",
      ...panelAppendix(
        this.items(run),
        researchEnd(this.ledger, run)?.reason ?? ANSWERED,
        this.proposed(run),
        PROPOSED_MAX,
      ),
      "",
      ...claimsAppendix(this.ledger, run, checked.cited, numbered.numbers),
      "",
    ].join("\n");
    const finding = (id: string) => this.ledger.claims.finding(run, id);
    const claim = (id: string) => this.ledger.claims.get(run, id);
    const experiments = input.experiments.map((x) => ({
      id: newExperimentId(),
      title: x.title,
      why: x.why,
      details: x.details,
      kind: x.kind,
      measure: x.measure,
      findings: [...new Set(x.findings)],
      claims: [...new Set(x.claims)],
      // What it rests on, in words: a run that takes it cannot read this run's records.
      rests_on: [
        ...[...new Set(x.findings)].map(
          (f) => `finding ${f}: ${clip(finding(f)?.text ?? "", 300)}`,
        ),
        ...[...new Set(x.claims)].map((c) => `claim ${c}: ${clip(claim(c)?.text ?? "", 300)}`),
      ],
    }));
    const ste = input.ste.checked
      ? {
          checked: true,
          version: input.ste.version,
          issue: input.ste.issue,
          counts: input.ste.counts,
        }
      : { checked: false, why: input.ste.why };
    this.ledger.appendEvent(by, PAPER_ACCEPTED, run, {
      review: basis.review,
      writer: input.writer,
      ste,
      cited_claims: checked.cited.length,
      // Each cited claim's reference numbers: what each [n] of the paper stands for.
      citations: Object.fromEntries(numbered.numbers),
      references: numbered.references.length,
      experiments,
      chars: paper.length,
      paper,
    });
    return {
      accepted: true,
      chars: paper.length,
      cited: checked.cited.length,
      experiments: experiments.map((x) => x.id),
      ste_checked: input.ste.checked,
    };
  }
}
