import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResearchContract } from "../../core/contract.ts";
import { PAPER_ACCEPTED, PAPER_REFUSED, PAPER_REQUESTED } from "../../core/research-check.ts";
import { type Ledger, LedgerError } from "../ledger.ts";
import { newExperimentId } from "../queue.ts";
import { checkCited, numbersIn, withoutReferences } from "./checks.ts";
import {
  acceptedReview,
  type CheckedReviewer,
  checkedPanel,
  type ResearchPackage,
  researchPackage,
} from "./review.ts";

/**
 * A research run's final paper (goal 112). Once the review panel's pass of a research run is
 * accepted, the run does not close at once: the harness asks the supervisor's final writer for
 * the run's research paper, one whole paper in Simplified Technical English. The writer works
 * from the run's research (read only) and the review panel's checked answers and verdicts.
 *
 * Code checks the paper before it is accepted, here, in code the writer cannot change: every
 * cited claim is a verified claim of the run, every number in a paragraph is in the claims that
 * paragraph cites (or is one of the corpus figures the harness gave the writer), every question
 * has its results section, every hypothesis has a verdict the review panel gave, and the STE
 * checker the supervisor ran on the text found no error, when the rig has one. A paper that fails
 * is refused with its problems. An accepted paper is kept whole in its event, with the
 * references code appends; it leads the run's final report and is `paper.md` in the run's
 * research folder. Its next experiments become experiments in the campaign's knowledge-base
 * folder, for a goal or hill-climb run to take into its queue.
 */

type Row = Record<string, unknown>;

/** The paper's parts after its title, each a level-2 heading, in this order. */
export const PAPER_PARTS = [
  "Summary",
  "Questions",
  "Method",
  "Results",
  "Hypotheses",
  "Limits of the evidence",
  "Next experiments",
] as const;

/** The most characters of a paper as the writer writes it (code appends the references). */
export const PAPER_MAX = 100_000;

/** The rules a paper is checked against, in words: the writer's package carries them. */
export const PAPER_RULES = [
  "The paper is Markdown in Simplified Technical English (descriptive text).",
  "Its first line is its title, a level-1 heading (# Title). No other level-1 heading.",
  `Then these parts, each a level-2 heading with these words, in this order: ${PAPER_PARTS.map((p) => `## ${p}`).join(", ")}. Put other headings at level 3 (###) under one of them. Do not write a References part: code appends it from the claims the paper cites.`,
  "Cite a claim as [c-ID] in each sentence that states a fact, such as [c-0a1b2c3d4e5f]; several as [c-…, c-…]. Each cited id must be a verified claim of the run.",
  "Every number in a paragraph, a list item or a table row must be in the claims it cites (their text or quotes), or be one of the figures in the package. Numbers in headings, record ids and question numbers (question 2) are not checked.",
  "Results: one ### Question N section for each question, N from 1, with the answer and its evidence. Each cites at least one claim.",
  "Hypotheses: one ### section for each hypothesis, with its id in the heading (### Hypothesis h-…), and a line Verdict: supported, Verdict: refuted or Verdict: undecided. The verdict is one the review panel gave; when it gave none that passed the check, undecided.",
  "Method: how the sources were found, archived and checked, with the figures. Limits of the evidence: claims from a single domain, open gaps, and draft findings that stay unverified. Next experiments: what to try next, and why.",
];

/** The fields of one of the paper's next experiments (the supervisor reads a model's answer with them). */
export const PAPER_EXPERIMENT_FIELDS = {
  title: z.string().trim().min(1).max(200),
  why: z.string().trim().min(1).max(2000),
  details: z.string().max(4000).default(""),
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

/** The final writer's package: the review panel's checked work and the run's brief and figures. */
export interface PaperPackage {
  kind: "paper";
  run: string;
  review: number;
  requested_at: string;
  title: string;
  topic: string;
  questions: {
    number: number;
    text: string;
    /** How many reviewers found it answered, and each answer that passed the check. */
    answered_by: number;
    answers: { answer: string; claims: string[] }[];
  }[];
  hypotheses: {
    id: string;
    text: string;
    /** Each verdict that passed the check, with how many reviewers gave it. */
    verdicts: { verdict: string; reviewers: number; why: string; claims: string[] }[];
  }[];
  reviewers: number;
  figures: PaperFigures;
  rules: string[];
  /** The newest refusal of a paper for this run, when there is one: fix these first. */
  last_refusal?: { at: string; problems: string[] } | undefined;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
/** A citation: [c-…], or several in one pair of brackets, [c-…, c-…]. */
const CITE = /\[\s*(c-[A-Za-z0-9_-]+(?:\s*[,;]\s*c-[A-Za-z0-9_-]+)*)\s*\]/g;
const VERDICT = /^\s*(?:[-*+]\s*)?[*_]*verdict[*_]*\s*:\s*[*_]*(supported|refuted|undecided)\b/i;

/** Words of a heading, folded for matching: "## Limits of the evidence" -> "limits of the evidence". */
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

/** A number as it may be written: 1200 and 1,200. */
const spellings = (n: number) => [String(n), n.toLocaleString("en-US")];

/** What a paper is checked against: the accepted review's questions, hypotheses and verdicts. */
export interface PaperBasis {
  review: number;
  questions: string[];
  hypotheses: { id: string; text: string }[];
  /** Each hypothesis's verdicts that passed the check (by any reviewer). */
  verdicts: Map<string, Set<string>>;
  figures: PaperFigures;
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
  part: string | undefined;
}

/**
 * Code's checks of a paper (goal 112), with each problem at its line: the paper's parts and their
 * order, every cited id a verified claim of the run, every number in a paragraph in the claims it
 * cites or among the figures, a results section that cites a claim for every question, and a
 * verdict the review panel gave for every hypothesis. No problem: the paper holds.
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

  // The title, then the parts in order.
  const first = lines.find((l) => l.text.trim());
  if (first?.heading?.level !== 1)
    say(first?.n ?? 1, "the paper starts with its title, as a level-1 heading: # Title");
  for (const l of lines.filter((x) => x.heading?.level === 1 && x !== first))
    say(l.n, "only the title is a level-1 heading (#): use ## for a part, ### under it");
  const parts: { part: string; line: number }[] = [];
  const partAt = new Map<number, string>();
  for (const l of lines) {
    if (l.heading?.level !== 2) continue;
    const words = fold(l.heading.text);
    if (words.startsWith("references")) {
      say(l.n, "leave out the References part: code appends it from the claims the paper cites");
      continue;
    }
    const part = PAPER_PARTS.find((p) => words.startsWith(fold(p)));
    if (!part) {
      say(
        l.n,
        `"## ${clip(l.heading.text, 80)}" is not a part of the paper. The parts are, in order: ${PAPER_PARTS.join(", ")}. Put other headings at level 3 (###) under one of them`,
      );
      continue;
    }
    if (parts.some((p) => p.part === part)) {
      say(l.n, `the paper has a second "## ${part}" part`);
      continue;
    }
    const prev = parts.at(-1);
    if (prev && PAPER_PARTS.indexOf(part) < PAPER_PARTS.indexOf(prev.part as never))
      say(
        l.n,
        `"## ${part}" comes after "## ${prev.part}": the parts go in this order: ${PAPER_PARTS.join(", ")}`,
      );
    parts.push({ part, line: l.n });
    partAt.set(l.n, part);
  }
  for (const p of PAPER_PARTS)
    if (!parts.some((x) => x.part === p)) say(null, `the paper has no "## ${p}" part`);

  // Each line's part, and its paragraphs (a list item or a table row each its own).
  const units: Unit[] = [];
  let part: string | undefined;
  let cur: Unit | undefined;
  const flush = () => {
    if (cur) units.push(cur);
    cur = undefined;
  };
  const lineParts = new Map<number, string | undefined>();
  for (const l of lines) {
    if (l.heading) {
      flush();
      if (l.heading.level <= 2) part = partAt.get(l.n);
      lineParts.set(l.n, part);
      units.push({ line: l.n, text: l.text, heading: true, part });
      continue;
    }
    lineParts.set(l.n, part);
    if (!l.text.trim()) {
      flush();
      continue;
    }
    if (!l.fence && (LIST_ITEM.test(l.text) || TABLE_ROW.test(l.text))) flush();
    if (cur) cur.text += `\n${l.text}`;
    else cur = { line: l.n, text: l.text, heading: false, part };
  }
  flush();

  // A level-3 section: its heading, and its lines up to the next heading of level 3 or above.
  const sections = (inPart: string) =>
    lines.flatMap((l, i) => {
      if (l.heading?.level !== 3 || lineParts.get(l.n) !== inPart) return [];
      const end = lines.findIndex(
        (x, j) => j > i && x.heading !== undefined && x.heading.level <= 3,
      );
      return [
        { line: l.n, text: l.heading.text, body: lines.slice(i + 1, end < 0 ? undefined : end) },
      ];
    });
  const partLine = (p: string) => parts.find((x) => x.part === p)?.line ?? null;

  // Results: a section for each question, each citing a claim.
  const results = sections("Results");
  basis.questions.forEach((text, i) => {
    const n = i + 1;
    const s = results.find((r) => new RegExp(`^question\\s+${n}\\b`, "i").test(r.text.trim()));
    if (!s) {
      say(partLine("Results"), `Results has no "### Question ${n}" section (${clip(text, 120)})`);
      return;
    }
    if (!s.body.some((l) => citationsIn(l.text).length))
      say(
        s.line,
        `"### Question ${n}" cites no claim: its answer needs the claims it rests on, as [c-…]`,
      );
  });
  for (const r of results) {
    const m = /^question\s+(\d+)\b/i.exec(r.text.trim());
    if (m && (Number(m[1]) < 1 || Number(m[1]) > basis.questions.length))
      say(r.line, `there is no question ${m[1]}: the run has ${basis.questions.length}`);
  }

  // Hypotheses: a section for each, with a verdict the review panel gave.
  const hyps = sections("Hypotheses");
  for (const h of basis.hypotheses) {
    const s = hyps.find((x) => x.text.includes(h.id));
    if (!s) {
      say(
        partLine("Hypotheses"),
        `Hypotheses has no "### Hypothesis ${h.id}" section (${clip(h.text, 120)})`,
      );
      continue;
    }
    const v = s.body.map((l) => ({ l, m: VERDICT.exec(l.text) })).find((x) => x.m);
    if (!v?.m) {
      say(
        s.line,
        `hypothesis ${h.id} has no verdict line: write "Verdict: supported", "Verdict: refuted" or "Verdict: undecided"`,
      );
      continue;
    }
    const said = (v.m[1] as string).toLowerCase();
    const gave = basis.verdicts.get(h.id) ?? new Set<string>();
    const allowed = gave.size ? gave : new Set(["undecided"]);
    if (!allowed.has(said))
      say(
        v.l.n,
        gave.size
          ? `the verdict "${said}" on hypothesis ${h.id} is not one the review panel gave: it gave ${[...gave].join(" or ")}`
          : `the review panel gave hypothesis ${h.id} no verdict that passed the check: write "Verdict: undecided"`,
      );
  }

  // Citations and numbers, paragraph by paragraph.
  const figures = Object.values(basis.figures).flatMap(spellings);
  const questionNumbers = basis.questions.flatMap(numbersIn);
  const hypothesisNumbers = basis.hypotheses.flatMap((h) => numbersIn(h.text));
  const cited: string[] = [];
  const idSaid = new Set<string>();
  for (const u of units) {
    const ids = citationsIn(u.text);
    for (const id of ids) if (!cited.includes(id)) cited.push(id);
    const also = [
      ...figures,
      ...(u.part === "Questions" ? questionNumbers : []),
      ...(u.part === "Hypotheses" ? hypothesisNumbers : []),
    ];
    const r = checkCited(ledger, run, ids, u.heading ? [] : [forNumbers(u.text)], also);
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
  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { problems, cited };
}

/** Each next experiment checked: it rests on supported findings or verified claims of the run. */
export function checkExperiments(ledger: Ledger, run: string, xs: PaperExperiment[]): string[] {
  const out: string[] = [];
  xs.forEach((x, i) => {
    const which = `next experiment ${i + 1} ("${clip(x.title, 80)}")`;
    if (!x.findings.length && !x.claims.length)
      out.push(
        `${which} rests on no finding or claim: give the ids of the supported findings or verified claims it builds on`,
      );
    for (const f of [...new Set(x.findings)]) {
      const row = ledger.db
        .prepare("select supported from finding where run = ? and id = ?")
        .get(run, f) as { supported: number } | undefined;
      if (!row) out.push(`${which}: no finding ${f}`);
      else if (Number(row.supported) !== 1)
        out.push(`${which}: finding ${f} is a draft, not supported`);
    }
    for (const p of checkCited(ledger, run, x.claims, []).problems) out.push(`${which}: ${p}`);
  });
  return out;
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

/**
 * The References part code appends (goal 112): each claim the paper cites, in the order it is
 * first cited, with the sources its quotes come from: title (or address), site and address.
 */
export function paperReferences(ledger: Ledger, run: string, cited: string[]): string[] {
  const lines = [
    "## References",
    "",
    "The harness added this list: each claim the paper cites, and the archived sources its quotes come from.",
    "",
  ];
  for (const id of cited) {
    const cl = ledger.db
      .prepare("select quotes from claim where run = ? and id = ? and verified = 1")
      .get(run, id) as { quotes: string } | undefined;
    if (!cl) continue;
    const ids = [...new Set((JSON.parse(cl.quotes) as { source: string }[]).map((q) => q.source))];
    const sources = ids.flatMap((s) => {
      const row = ledger.db
        .prepare("select url, title, domain from source where run = ? and id = ?")
        .get(run, s) as { url: string; title: string | null; domain: string } | undefined;
      if (!row) return [];
      const title = row.title?.trim() ? clip(row.title, 200) : "";
      return [`${title || row.url} (${row.domain})${title ? `, ${row.url}` : ""}`];
    });
    lines.push(`- [${id}] ${sources.join("; ") || "no archived source"}`);
  }
  return lines;
}

/** The figures of a run's corpus now, for its paper's request. */
function figuresNow(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  review: Row,
): PaperFigures {
  const n = (sql: string) =>
    Number((ledger.db.prepare(sql).get(run) as { n: number } | undefined)?.n ?? 0);
  const corpus = researchPackage(ledger, run, contract).corpus;
  return {
    sources: corpus.sources,
    domains: corpus.domains,
    verified_claims: corpus.verified_claims,
    corroborated_claims: corpus.corroborated_claims,
    draft_claims: n("select count(*) as n from claim where run = ? and verified = 0"),
    findings: corpus.findings,
    draft_findings: n("select count(*) as n from finding where run = ? and supported = 0"),
    questions: contract.questions.length,
    hypotheses: n("select count(*) as n from hypothesis where run = ?"),
    min_independent_domains: corpus.min_independent_domains,
    review: Number(review.id),
    reviewers: checkedPanel(review).length,
  };
}

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

  /** The run's accepted paper, as its event keeps it: the paper whole, with its references. */
  accepted(run: string): Row | undefined {
    return this.ledger.latestEventBody(PAPER_ACCEPTED, run);
  }

  /** The request for the paper of the run's accepted review, when the harness made it. */
  requested(run: string): { review: number; figures: PaperFigures; at: string } | undefined {
    const review = acceptedReview(this.ledger, run);
    if (!review) return undefined;
    const row = this.ledger.db
      .prepare("select at, body from event where kind = ? and subject = ? order by id desc limit 1")
      .get(PAPER_REQUESTED, run) as { at: string; body: string } | undefined;
    if (!row) return undefined;
    const b = JSON.parse(row.body) as { review: number; figures: PaperFigures };
    return Number(b.review) === Number(review.id) ? { ...b, at: row.at } : undefined;
  }

  /**
   * Asks the final writer for the paper of a run whose review's pass was accepted, once: the
   * figures of its corpus are frozen in the request. False when there is nothing to ask.
   */
  request(run: string, by: string): boolean {
    const review = acceptedReview(this.ledger, run);
    if (!review || this.requested(run) || this.accepted(run)) return false;
    const figures = figuresNow(this.ledger, run, this.contract(run), review);
    this.ledger.appendEvent(by, PAPER_REQUESTED, run, { review: Number(review.id), figures });
    return true;
  }

  /** What a run's paper is checked against; it must wait for its paper. */
  basis(run: string): PaperBasis {
    const inst = this.ledger.getRun(run);
    if (!inst) throw new LedgerError("not_found", `no run ${run}`);
    if (inst.status !== "running") throw new LedgerError("invalid", `run ${run} is ${inst.status}`);
    if (this.accepted(run))
      throw new LedgerError("conflict", `run ${run} already has its research paper`);
    const asked = this.requested(run);
    const review = acceptedReview(this.ledger, run);
    if (!asked || !review)
      throw new LedgerError("invalid", `run ${run} does not wait for a research paper`);
    const pkg = JSON.parse(String(review.package)) as Pick<ResearchPackage, "hypotheses">;
    const verdicts = new Map<string, Set<string>>();
    for (const r of checkedPanel(review))
      for (const h of r.hypotheses)
        if (h.valid && h.verdict)
          verdicts.set(h.id, new Set([...(verdicts.get(h.id) ?? []), h.verdict]));
    return {
      review: Number(review.id),
      questions: this.contract(run).questions,
      hypotheses: pkg.hypotheses.map((h) => ({ id: h.id, text: h.text })),
      verdicts,
      figures: asked.figures,
    };
  }

  /** A draft checked, as the writer's check_paper tool asks: each problem with its line. */
  check(run: string, markdown: string): { ok: boolean; problems: PaperProblem[] } {
    const { problems } = checkPaper(this.ledger, run, this.basis(run), markdown);
    return { ok: problems.length === 0, problems };
  }

  /** The runs waiting for their paper, each as the final writer's package. */
  pending(): PaperPackage[] {
    const runs = this.ledger.db
      .prepare("select id from run where mode = 'research' and status = 'running' order by id")
      .all() as { id: string }[];
    return runs.flatMap(({ id }) => {
      const asked = this.requested(id);
      const review = acceptedReview(this.ledger, id);
      if (!asked || !review || this.accepted(id)) return [];
      const contract = this.contract(id);
      const panel: CheckedReviewer[] = checkedPanel(review);
      const pkg = JSON.parse(String(review.package)) as Pick<ResearchPackage, "hypotheses">;
      const refused = this.ledger.db
        .prepare(
          "select at, body from event where kind = ? and subject = ? and id > (select max(id) from event where kind = ? and subject = ?) order by id desc limit 1",
        )
        .get(PAPER_REFUSED, id, PAPER_REQUESTED, id) as { at: string; body: string } | undefined;
      return [
        {
          kind: "paper" as const,
          run: id,
          review: Number(review.id),
          requested_at: asked.at,
          title: contract.title,
          topic: contract.topic,
          questions: contract.questions.map((text, i) => {
            const answers = panel
              .map((r) => r.questions.find((q) => q.index === i && q.answered))
              .filter((q) => q !== undefined);
            return {
              number: i + 1,
              text,
              answered_by: answers.length,
              answers: answers.map((q) => ({ answer: q.answer, claims: q.claims })),
            };
          }),
          hypotheses: pkg.hypotheses.map((h) => {
            const given = panel
              .map((r) => r.hypotheses.find((x) => x.id === h.id && x.valid && x.verdict))
              .filter((x) => x !== undefined);
            const by = new Map<string, typeof given>();
            for (const v of given)
              by.set(String(v.verdict), [...(by.get(String(v.verdict)) ?? []), v]);
            return {
              id: h.id,
              text: h.text,
              verdicts: [...by.entries()].map(([verdict, vs]) => ({
                verdict,
                reviewers: vs.length,
                why: vs[0]?.why ?? "",
                claims: vs[0]?.claims ?? [],
              })),
            };
          }),
          reviewers: panel.length,
          figures: asked.figures,
          rules: PAPER_RULES,
          ...(refused
            ? {
                last_refusal: {
                  at: refused.at,
                  problems: (JSON.parse(refused.body) as { problems?: string[] }).problems ?? [],
                },
              }
            : {}),
        },
      ];
    });
  }

  /**
   * A paper the supervisor posts for a run that waits for one: checked by code, then accepted or
   * refused with its problems. Accepted, it is kept whole with the references code appends, and
   * each next experiment becomes an experiment of the campaign's knowledge-base folder.
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
    const paper = [
      input.paper.replace(/\s+$/, ""),
      "",
      ...paperReferences(this.ledger, run, checked.cited),
      "",
    ].join("\n");
    const finding = (id: string) =>
      this.ledger.db.prepare("select text from finding where run = ? and id = ?").get(run, id) as
        | { text: string }
        | undefined;
    const claim = (id: string) =>
      this.ledger.db.prepare("select text from claim where run = ? and id = ?").get(run, id) as
        | { text: string }
        | undefined;
    const experiments = input.experiments.map((x) => ({
      id: newExperimentId(),
      title: x.title,
      why: x.why,
      details: x.details,
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
