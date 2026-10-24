import { z } from "zod";
import type { ResearchContract } from "../../core/contract.ts";
import {
  ANSWERED,
  measurementIn,
  questionLabel,
  questionName,
  REQUIRED_HYPOTHESES,
  RESEARCH_REVIEW,
} from "../../core/research-check.ts";
import type { Ledger } from "../ledger.ts";
import { checkCited } from "./checks.ts";
import { registrableDomain } from "./fetcher.ts";

/**
 * A research run ends when its questions are answered (goal 112). After the run's minimum running
 * time, at a digest, code checks the evidence: every question has a verified claim (and the run
 * has the campaign's floor of verified claims, when it sets one), no review of the run waits, and
 * the evidence changed since the last review. Then the supervisor's review panel is asked, with a
 * package of the run's verified claims, findings and hypotheses, and nothing about which lane or
 * model wrote what. Each reviewer answers each question with claims it cites, and gives each
 * hypothesis a verdict; code checks every answer as it checks a finding. The review passes only
 * when every reviewer, at least two, answered every question and gave every hypothesis a valid
 * verdict.
 *
 * A research review is a row of the review table with the reserved goal name `research` (a
 * research contract has no goals) and, in place of a commit, a marker of the evidence it saw: the
 * table's unique index then keeps the run from being asked twice on the same evidence.
 */

type Row = Record<string, unknown>;

export { ANSWERED, RESEARCH_REVIEW };

/** The most characters of a research review's package (the reviewers read the rest with tools). */
export const RESEARCH_PACKAGE_MAX = 200_000;

/** What every reviewer is asked to check, the same for every research run. */
export const RESEARCH_CRITERIA = [
  "A question is answered when the verified claims, together, give a direct answer to it. The answer cites those claims by their ids.",
  "An answer uses only what the claims it cites say. Every number in an answer must be in those claims, in their text or in their quotes.",
  "When the claims do not answer a question, it is not answered: say what is missing, such as which facts and which kind of source could give them.",
  "A hypothesis is supported or refuted only by the claims a verdict cites. When the claims do not decide it, it is undecided: say why.",
  "A claim from fewer independent domains than the run asks for is weaker evidence. Say so when an answer rests on such claims alone.",
  "A research run measures nothing. A question is answered when its claims give the best answer that sources allow. What only a measurement could settle, such as a test on the hardware the question is about or a benchmark, is named in the answer as a next experiment, never counted as missing.",
];

export interface PackageClaim {
  id: string;
  text: string;
  /** The registrable domains its quotes' sources come from (docs.example.com: example.com). */
  domains: string[];
  /** From at least the contract's number of independent domains. */
  corroborated: boolean;
}

/** What the review panel gets for a research review: the run's evidence, with no lane or model. */
export interface ResearchPackage {
  kind: "research";
  title: string;
  topic: string;
  questions: {
    index: number;
    text: string;
    verified_claims: number;
    claims: PackageClaim[];
    /** Verified claims of the question left out to keep the package short. */
    not_shown?: number;
  }[];
  /** Verified claims that name no question of the run. */
  other_claims: PackageClaim[];
  findings: { id: string; text: string; summary: string; supporting: string[] }[];
  findings_not_shown?: number;
  hypotheses: { id: string; text: string; supporting: string[] }[];
  corpus: {
    sources: number;
    domains: number;
    verified_claims: number;
    corroborated_claims: number;
    findings: number;
    min_independent_domains: number;
  };
  criteria: string[];
  /** Said when claims or findings were left out to fit. */
  shortened?: string;
}

/** A reviewer's answers to a research package, as the supervisor posts them. */
export const ResearchVerdicts = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        index: z.number().int().min(0),
        answered: z.boolean(),
        answer: z.string().max(8000).default(""),
        claims: z.array(z.string().max(200)).max(100).default([]),
        missing: z.string().max(4000).default(""),
      }),
    )
    .max(2000)
    .default([]),
  hypotheses: z
    .array(
      z.strictObject({
        id: z.string().max(200),
        verdict: z.enum(["supported", "refuted", "undecided"]),
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
  /** Counts as answered: the reviewer said so and the answer passed the check. */
  answered: boolean;
  said_answered: boolean;
  answer: string;
  claims: string[];
  missing: string;
  /** Why the answer does not count, when it does not. */
  problems: string[];
}

/** One reviewer's verdict on a hypothesis, with the harness's check. */
export interface CheckedHypothesis {
  id: string;
  verdict: "supported" | "refuted" | "undecided" | null;
  why: string;
  claims: string[];
  valid: boolean;
  problems: string[];
}

/** One reviewer's research review, as the harness checked and keeps it. */
export interface CheckedReviewer {
  reviewer: string;
  /** Counts as a pass: the reviewer passed it, and every answer and verdict holds. */
  pass: boolean;
  said_pass: boolean;
  reasons: string;
  questions: CheckedQuestion[];
  hypotheses: CheckedHypothesis[];
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const count = (ledger: Ledger, sql: string, ...p: (string | number)[]) =>
  Number((ledger.db.prepare(sql).get(...p) as { n: number } | undefined)?.n ?? 0);

/**
 * The evidence a review saw, as a marker: the run's verified claims and supported findings, and
 * its newest verified claim. A review is never asked twice with the same marker.
 */
export function corpusMarker(ledger: Ledger, run: string): string {
  const newest = ledger.db
    .prepare(
      "select id from claim where run = ? and verified = 1 order by created_at desc, rowid desc limit 1",
    )
    .get(run) as { id: string } | undefined;
  return `corpus:${count(ledger, "select count(*) as n from claim where run = ? and verified = 1", run)}:${count(ledger, "select count(*) as n from finding where run = ? and supported = 1", run)}:${newest?.id ?? "none"}`;
}

/** A run's research reviews, newest first. */
export function researchReviews(ledger: Ledger, run: string): Row[] {
  return ledger.db
    .prepare("select * from review where run = ? and goal = ? order by id desc")
    .all(run, RESEARCH_REVIEW) as Row[];
}

/** The review whose pass was accepted (hands-off or by the owner): the questions are answered. */
export function acceptedReview(ledger: Ledger, run: string): Row | undefined {
  return researchReviews(ledger, run).find((r) => r.owner_decision === "accepted");
}

/** A review that waits: for the review panel, or, passed, for the owner's acceptance. */
function waitingReview(ledger: Ledger, run: string): Row | undefined {
  return researchReviews(ledger, run).find(
    (r) =>
      r.panel_result === null || (r.panel_result === "review_passed" && r.owner_decision === null),
  );
}

/** Why the review panel is not asked now, or the marker of the evidence it would see. */
export function researchReviewDue(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  clock: { elapsed_ms: number; min_ms: number },
): { due: true; marker: string } | { due: false; why: string } {
  if (acceptedReview(ledger, run))
    return { due: false, why: "the review panel found every question answered" };
  if (clock.elapsed_ms < clock.min_ms)
    return { due: false, why: "the run has not run for its minimum duration yet" };
  const bare = contract.questions
    .map((_, i) => i)
    .filter(
      (i) =>
        count(
          ledger,
          "select count(*) as n from claim where run = ? and question = ? and verified = 1",
          run,
          i,
        ) === 0,
    );
  if (bare.length)
    return {
      due: false,
      why: `${bare.length === 1 ? "question" : "questions"} ${bare.map((i) => i + 1).join(", ")} ${bare.length === 1 ? "has" : "have"} no verified claim yet`,
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
  const marker = corpusMarker(ledger, run);
  const seen = researchReviews(ledger, run).find((r) => r.commit_sha === marker);
  if (seen)
    return {
      due: false,
      why: `review ${String(seen.id)} saw this evidence: it needs new evidence`,
    };
  return { due: true, marker };
}

/** Distinct registrable domains of a claim's quotes' sources (goal 117). */
function claimDomains(ledger: Ledger, run: string, quotes: string): string[] {
  const ids = (JSON.parse(quotes) as { source: string }[]).map((q) => q.source);
  const out = new Set<string>();
  for (const id of ids) {
    const d = (
      ledger.db.prepare("select domain from source where run = ? and id = ?").get(run, id) as
        | { domain: string }
        | undefined
    )?.domain;
    if (d) out.add(registrableDomain(d));
  }
  return [...out];
}

/**
 * The package of a research review: the topic, each question with its verified claims (their
 * text, their sources' domains and whether they are corroborated), the supported findings, and
 * each hypothesis that needs a verdict (the author's and promoted ones) with the claims cited for
 * it, and the criteria. Nothing about which lane or
 * model wrote what. When it would be longer than RESEARCH_PACKAGE_MAX characters, each question
 * shows fewer claims (corroborated first, then the newest), and then fewer findings; it says so.
 */
export function researchPackage(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
): ResearchPackage {
  const min = contract.quality.min_independent_sources;
  const claims = (
    ledger.db
      .prepare(
        "select id, question, text, quotes from claim where run = ? and verified = 1 order by created_at desc, rowid desc",
      )
      .all(run) as Row[]
  ).map((cl) => {
    const domains = claimDomains(ledger, run, String(cl.quotes));
    return {
      question: cl.question === null ? null : Number(cl.question),
      claim: {
        id: String(cl.id),
        text: String(cl.text),
        domains,
        corroborated: domains.length >= min,
      } satisfies PackageClaim,
    };
  });
  // Corroborated first, then the newest (the query's order).
  const ranked = (xs: PackageClaim[]) => [
    ...xs.filter((c) => c.corroborated),
    ...xs.filter((c) => !c.corroborated),
  ];
  const byQuestion = contract.questions.map((_, i) =>
    ranked(claims.filter((c) => c.question === i).map((c) => c.claim)),
  );
  const other = ranked(
    claims
      .filter(
        (c) => c.question === null || c.question < 0 || c.question >= contract.questions.length,
      )
      .map((c) => c.claim),
  );
  const findings = (
    ledger.db
      .prepare(
        "select id, text, summary, supporting from finding where run = ? and supported = 1 order by created_at desc, rowid desc",
      )
      .all(run) as Row[]
  ).map((f) => ({
    id: String(f.id),
    text: String(f.text),
    summary: String(f.summary),
    supporting: JSON.parse(String(f.supporting)) as string[],
  }));
  // Only the hypotheses that need a verdict (goal 117): the author's and promoted ones. The
  // workers' pool is listed in the report as proposed by the run, and never makes a review fail.
  const hypotheses = (
    ledger.db
      .prepare(
        `select id, text, supporting from hypothesis where run = ? and status in (${REQUIRED_HYPOTHESES.map(() => "?").join(", ")}) order by created_at, rowid`,
      )
      .all(run, ...REQUIRED_HYPOTHESES) as Row[]
  ).map((h) => ({
    id: String(h.id),
    text: String(h.text),
    supporting: JSON.parse(String(h.supporting)) as string[],
  }));
  const corpus = {
    sources: count(ledger, "select count(*) as n from source where run = ?", run),
    domains: new Set(
      (
        ledger.db.prepare("select distinct domain from source where run = ?").all(run) as {
          domain: string;
        }[]
      ).map((r) => registrableDomain(r.domain)),
    ).size,
    verified_claims: claims.length,
    corroborated_claims: claims.filter((c) => c.claim.corroborated).length,
    findings: findings.length,
    min_independent_domains: min,
  };
  const build = (perQuestion: number, findingsShown: number): ResearchPackage => {
    const cut = perQuestion < Number.POSITIVE_INFINITY || findingsShown < findings.length;
    return {
      kind: "research",
      title: contract.title,
      topic: contract.topic,
      questions: contract.questions.map((text, index) => {
        const all = byQuestion[index] ?? [];
        const shown = all.slice(0, perQuestion);
        return {
          index,
          text,
          verified_claims: all.length,
          claims: shown,
          ...(shown.length < all.length ? { not_shown: all.length - shown.length } : {}),
        };
      }),
      other_claims: other.slice(0, perQuestion),
      findings: findings.slice(0, findingsShown),
      ...(findingsShown < findings.length
        ? { findings_not_shown: findings.length - findingsShown }
        : {}),
      hypotheses,
      corpus,
      criteria: RESEARCH_CRITERIA,
      ...(cut
        ? {
            shortened:
              "Some verified claims or findings are not shown, to keep this package short: each question shows its corroborated claims first, then the newest. When you have the tools, read the rest of the run's claims and findings with them.",
          }
        : {}),
    };
  };
  let perQuestion = Number.POSITIVE_INFINITY;
  let findingsShown = findings.length;
  let pkg = build(perQuestion, findingsShown);
  const most = Math.max(1, other.length, ...byQuestion.map((x) => x.length));
  while (JSON.stringify(pkg).length > RESEARCH_PACKAGE_MAX) {
    if (perQuestion > 1) perQuestion = Math.max(1, Math.ceil(Math.min(perQuestion, most) / 2));
    else if (findingsShown > 0) findingsShown = Math.floor(findingsShown / 2);
    else break;
    pkg = build(perQuestion, findingsShown);
  }
  return pkg;
}

/**
 * Each reviewer's answers, checked by code. An answer counts only when the reviewer said the
 * question is answered, the answer has words and cites at least one claim, every cited id is a
 * verified claim of the run, and every number in the answer is in those claims. A supported or
 * refuted verdict needs at least one cited claim and the same check of its why; an undecided one
 * needs its why. A reviewer passes only when it passed the review and every question it answered
 * and every verdict it gave holds.
 */
export function checkResearchPanel(
  ledger: Ledger,
  run: string,
  pkg: Pick<ResearchPackage, "questions" | "hypotheses">,
  results: {
    reviewer: string;
    pass: boolean;
    reasons: string;
    research?: ResearchVerdicts | undefined;
  }[],
): CheckedReviewer[] {
  return results.map((r) => {
    const said = r.research ?? { questions: [], hypotheses: [] };
    const questions = pkg.questions.map((q): CheckedQuestion => {
      const a = said.questions.find((x) => x.index === q.index);
      if (!a)
        return {
          index: q.index,
          answered: false,
          said_answered: false,
          answer: "",
          claims: [],
          missing: "",
          problems: ["the reviewer gave no answer to this question"],
        };
      const problems: string[] = [];
      if (a.answered) {
        if (!a.answer.trim()) problems.push("the answer is empty");
        if (!a.claims.length) problems.push("the answer cites no claim");
        problems.push(...checkCited(ledger, run, a.claims, [a.answer]).problems);
      }
      return {
        index: q.index,
        answered: a.answered && problems.length === 0,
        said_answered: a.answered,
        answer: a.answer.slice(0, 8000),
        claims: [...new Set(a.claims)],
        missing: a.missing.slice(0, 4000),
        problems,
      };
    });
    const hypotheses = pkg.hypotheses.map((h): CheckedHypothesis => {
      const v = said.hypotheses.find((x) => x.id === h.id);
      if (!v)
        return {
          id: h.id,
          verdict: null,
          why: "",
          claims: [],
          valid: false,
          problems: ["the reviewer gave no verdict on this hypothesis"],
        };
      const problems: string[] = [];
      if (v.verdict === "undecided") {
        if (!v.why.trim()) problems.push("an undecided verdict needs its why");
        // Claims it names must still be the run's verified claims; its why is not a claim.
        problems.push(...checkCited(ledger, run, v.claims, []).problems);
      } else {
        if (!v.claims.length) problems.push(`a ${v.verdict} verdict cites no claim`);
        problems.push(...checkCited(ledger, run, v.claims, [v.why]).problems);
      }
      return {
        id: h.id,
        verdict: v.verdict,
        why: v.why.slice(0, 4000),
        claims: [...new Set(v.claims)],
        valid: problems.length === 0,
        problems,
      };
    });
    return {
      reviewer: r.reviewer,
      pass: r.pass && questions.every((q) => q.answered) && hypotheses.every((h) => h.valid),
      said_pass: r.pass,
      reasons: r.reasons.slice(0, 4000),
      questions,
      hypotheses,
    };
  });
}

/**
 * What one reviewer found missing, a line each, in plain words. Questions are named for people,
 * "Question 1" (the journal, the dashboard), or with `questionLabel` where agents read it too
 * ("Question 1 (index 0)": the digest's line in REPORT.md).
 */
export function reviewerGaps(
  r: CheckedReviewer,
  n = 300,
  name: (index: number) => string = questionName,
): string[] {
  const out: string[] = [];
  for (const q of r.questions) {
    if (q.answered) continue;
    const parts = [
      q.missing.trim() ? `missing: ${clip(q.missing, n)}` : "",
      q.said_answered && q.problems.length
        ? `the answer did not pass the check (${clip(q.problems.join("; "), n)})`
        : "",
      !q.said_answered && !q.missing.trim() && q.problems.length
        ? clip(q.problems.join("; "), n)
        : "",
    ].filter(Boolean);
    out.push(`${name(q.index)}: ${parts.join("; ") || "not answered"}`);
  }
  for (const h of r.hypotheses) {
    if (h.valid) continue;
    out.push(
      `Hypothesis ${h.id}: ${h.verdict ? `the ${h.verdict} verdict did not pass the check (${clip(h.problems.join("; "), n)})` : "no verdict"}`,
    );
  }
  if (!r.said_pass && !out.length) out.push(`the reviewer did not pass it: ${clip(r.reasons, n)}`);
  return out;
}

/** A review's checked results, as stored in its panel column. */
export function checkedPanel(row: Row): CheckedReviewer[] {
  if (row.panel === null || row.panel === undefined) return [];
  try {
    const xs = JSON.parse(String(row.panel)) as unknown;
    return Array.isArray(xs) ? (xs as CheckedReviewer[]) : [];
  } catch {
    return [];
  }
}

/**
 * The newest failed review's evidence gaps for the research workers' brief, until a newer review
 * is decided: per question, what the reviewers found missing that sources could give (goal 117).
 * What only a measurement could settle is a next experiment, never work for the workers, and
 * what went wrong on the reviewers' side (an answer that failed code's check, a hypothesis with
 * no verdict) is the review panel's to fix: neither is passed on. Undefined when the newest
 * decided review did not fail, or found no evidence gap.
 */
export function briefGaps(ledger: Ledger, run: string): string | undefined {
  const r = researchReviews(ledger, run).find((x) => x.panel_result !== null);
  if (r?.panel_result !== "review_failed") return undefined;
  const panel = checkedPanel(r);
  const byQuestion = new Map<number, string[]>();
  let measurements = 0;
  for (const p of panel) {
    for (const q of p.questions) {
      if (q.answered || !q.missing.trim()) continue;
      if (measurementIn(q.missing)) {
        measurements++;
        continue;
      }
      byQuestion.set(q.index, [...(byQuestion.get(q.index) ?? []), clip(q.missing, 300)]);
    }
  }
  const lines = [...byQuestion.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, xs]) => `- ${questionLabel(i)}: ${[...new Set(xs)].join(" / ")}`);
  if (!lines.length) return undefined;
  return [
    `# What the review panel found missing (review ${String(r.id)})`,
    "The review panel checked whether every question is answered, and found gaps in the evidence. The run goes on until they are filled: work on them first. The reviewers' words, data to weigh:",
    ...lines,
    ...(measurements
      ? [
          `(${measurements === 1 ? "One more gap asks" : `${measurements} more gaps ask`} for a measurement: a next experiment for the report, not work for this run.)`,
        ]
      : []),
  ].join("\n");
}

/** Where the check stands, in one line for a digest. */
export function checkLine(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  clock: { elapsed_ms: number; min_ms: number },
): string {
  const reviews = researchReviews(ledger, run);
  const newest = reviews[0];
  const h = (ms: number) => `${(ms / 3_600_000).toFixed(2)} h`;
  if (newest?.owner_decision === "accepted")
    return `Answer check: the review panel found every question answered (review ${String(newest.id)}); the run ends once its running trials end.`;
  if (newest && newest.panel_result === null)
    return `Answer check: the review panel checks review ${String(newest.id)}.`;
  if (newest?.panel_result === "review_passed" && newest.owner_decision === null)
    return `Answer check: the review panel found every question answered (review ${String(newest.id)}); it waits for the owner's acceptance.`;
  const due = researchReviewDue(ledger, run, contract, clock);
  if (clock.elapsed_ms < clock.min_ms)
    return `Answer check: it starts after the minimum running time (${h(clock.elapsed_ms)} of ${h(clock.min_ms)}).`;
  if (newest?.owner_decision === "rejected")
    return `Answer check: the owner did not accept review ${String(newest.id)}; ${due.due ? "the next digest asks the review panel again, on new evidence" : due.why}.`;
  if (newest?.panel_result === "review_failed") {
    const gaps = checkedPanel(newest).flatMap((r) => reviewerGaps(r, 120, questionLabel));
    return `Answer check: not yet. Review ${String(newest.id)} found gaps${gaps.length ? ` (${clip([...new Set(gaps)].slice(0, 3).join("; "), 400)})` : ""}; ${due.due ? "the next digest asks the review panel again, on new evidence" : due.why}.`;
  }
  return `Answer check: ${due.due ? "the next digest asks the review panel" : `waiting: ${due.why}`}.`;
}

/**
 * The final report's sections on the answers (goal 112): each question's answer from the first
 * reviewer whose answer passed the check, with the claims it cites and how many reviewers found
 * it answered; each hypothesis's verdict, and how the reviewers differ. Without a passed review,
 * it says the questions were not checked as answered, and why.
 */
export function answerSections(
  ledger: Ledger,
  run: string,
  contract: ResearchContract,
  fence: (s: string) => string,
): string[] {
  const reviews = researchReviews(ledger, run);
  const passed = reviews.find(
    (r) => r.panel_result === "review_passed" && r.owner_decision !== "rejected",
  );
  if (!passed) {
    const newest = reviews[0];
    const why = !newest
      ? "the review panel was never asked"
      : newest.panel_result === null
        ? `review ${String(newest.id)} still waited for the review panel`
        : newest.owner_decision === "rejected"
          ? `the owner did not accept review ${String(newest.id)}`
          : `review ${String(newest.id)} found gaps`;
    return ["## Answers", `The questions were not checked as answered: ${why}.`, ""];
  }
  const panel = checkedPanel(passed);
  const n = panel.length;
  const head =
    passed.owner_decision === "accepted"
      ? `The review panel found every question answered (review ${String(passed.id)}, ${n} reviewers)${String(passed.owner_note ?? "").startsWith("hands-off") ? "" : ", and the owner accepted it"}. Each answer is the first that passed the harness's check: its cited claims are verified claims of this run, and its numbers are in them.`
      : `The review panel found every question answered (review ${String(passed.id)}, ${n} reviewers), but the owner had not accepted it when the run ended. Each answer is the first that passed the harness's check.`;
  const lines = ["## Answers", head, ""];
  contract.questions.forEach((text, i) => {
    const answers = panel
      .map((r) => r.questions.find((q) => q.index === i))
      .filter((q): q is CheckedQuestion => q?.answered === true);
    const first = answers[0];
    lines.push(`### ${i + 1}. ${fence(text).replace(/\n+/g, " ")}`, "");
    if (first) {
      lines.push(
        fence(first.answer),
        "",
        `Cites: ${first.claims.join(", ")}. Found answered by ${answers.length} of ${n} reviewers.`,
        "",
      );
    } else lines.push("No answer passed the check.", "");
  });
  const hypotheses = (
    ledger.db
      .prepare("select id, text from hypothesis where run = ? order by created_at, rowid")
      .all(run) as { id: string; text: string }[]
  ).filter((h) => panel.some((r) => r.hypotheses.some((x) => x.id === h.id)));
  lines.push("## Hypotheses: the review panel's verdicts");
  if (!hypotheses.length) lines.push("The run had no hypotheses when the review panel checked it.");
  for (const h of hypotheses) {
    const verdicts = panel
      .map((r) => r.hypotheses.find((x) => x.id === h.id))
      .filter((v): v is CheckedHypothesis => v?.valid === true && v.verdict !== null);
    const first = verdicts[0];
    const counts = new Map<string, number>();
    for (const v of verdicts)
      counts.set(String(v.verdict), (counts.get(String(v.verdict)) ?? 0) + 1);
    const word =
      counts.size > 1
        ? `the reviewers differ: ${[...counts.entries()].map(([k, c]) => `${c} ${k}`).join(", ")}`
        : first
          ? `${first.verdict} (${verdicts.length} of ${n} reviewers)`
          : "no verdict passed the check";
    lines.push(
      `- ${fence(h.text).replace(/\n+/g, " ")} (${h.id}): ${word}.${first ? ` Why: ${fence(first.why).replace(/\n+/g, " ")}${first.claims.length ? ` Cites: ${first.claims.join(", ")}.` : ""}` : ""}`,
    );
  }
  lines.push("");
  return lines;
}
