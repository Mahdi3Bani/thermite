import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { answeredResearchRun, goodPaper, NO_STE } from "../testing/research-paper.ts";
import type { ResearchTrialSpec } from "./agents/research-worker.ts";
import { Scheduler } from "./agents/scheduler.ts";
import { createHarnessApi } from "./api.ts";
import { LocalRunner } from "./broker/runner.ts";
import { knowledgePart } from "./kb-part.ts";
import { NEXT_EXPERIMENTS_FILE, PAPER_FILE } from "./research/folder.ts";
import { PAPER_PACKAGE_MAX, type PaperProblem, paperSha } from "./research/paper.ts";
import type { Research } from "./research/research.ts";
import { ANSWERED } from "./research/review.ts";

/**
 * Goal 112, the final paper: once a research run's review is accepted, the run waits for its
 * research paper from the supervisor's final writer. The harness lists the runs that wait, checks
 * a draft or a posted paper in code (claims, numbers, a section for each question, a verdict the
 * review panel gave for each hypothesis, the STE checker's errors), and refuses one that fails.
 * An accepted paper is the run's paper.md and leads its final report; its next experiments go to
 * the campaign's knowledge-base folder; then the run closes once its trials end.
 */

const RUN = "r-1";
const tokens = { supervisor: "sup-token", proposer: "prop-token" };

const done = {
  stopped: "no_submission" as const,
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
};

/** A research run whose review the review panel passed, accepted hands-off. */
async function answered(t: TestContext) {
  const r = await answeredResearchRun(RUN);
  t.after(() => r.close());
  const { ledger } = r;
  const api = createHarnessApi(r.env.service, tokens);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: { authorization: `Bearer ${tokens.supervisor}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const events = (kind: string) =>
    ledger.db
      .prepare("select body from event where kind = ? and subject = ? order by id")
      .all(kind, RUN)
      .map((e) => JSON.parse(String((e as { body: string }).body)) as Record<string, unknown>);
  return { ...r, call, events };
}

/** A scheduler for the run, its research trials run by `trial`, `concurrent` at once. */
function scheduler(
  s: Awaited<ReturnType<typeof answered>>,
  trial: (spec: ResearchTrialSpec, signal: AbortSignal) => Promise<typeof done> = async () => done,
  concurrent = 1,
) {
  return new Scheduler({
    service: s.env.service,
    runner: new LocalRunner(s.env.service.paths.scratchDir),
    model: {
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 1,
      maxTokens: 1,
    },
    owner: "s",
    research: s.research as Research,
    runTrial: async () => done,
    runResearchTrial: trial,
    maxConcurrent: concurrent,
  });
}

const problemsOf = (b: Record<string, unknown>) => (b.problems ?? []) as PaperProblem[];

describe("a research run whose questions are answered waits for its paper (goal 112)", () => {
  test("the final writer is asked once; no trial starts; the pending list gives the writer's package", async (t) => {
    const s = await answered(t);
    let started = 0;
    const sch = scheduler(s, async () => {
      started++;
      return done;
    });
    // Until the supervisor says it has a final writer: nothing is asked.
    await sch.tick();
    assert.equal(s.events("research_paper_requested").length, 0);
    assert.deepEqual((await s.call("GET", "/v1/research/papers/pending")).body, { papers: [] });
    await s.env.service.setAdvisors({ auditor: false, panel: 2, writer: true }, "supervisor");
    await sch.tick();
    await sch.idle();
    await sch.tick();
    const asked = s.events("research_paper_requested");
    assert.equal(asked.length, 1, "asked once");
    assert.equal(asked[0]?.review, s.review);
    assert.equal(started, 0, "no trial starts while the run waits for its paper");
    assert.equal(s.ledger.getRun(RUN)?.status, "running", "it waits for its paper");
    // The writer's package: the review panel's checked answers and verdicts, the figures, the rules.
    const { status, body } = await s.call("GET", "/v1/research/papers/pending");
    assert.equal(status, 200);
    const papers = body.papers as Record<string, unknown>[];
    assert.equal(papers.length, 1);
    const pkg = papers[0] as Record<string, unknown>;
    assert.equal(pkg.kind, "paper");
    assert.equal(pkg.run, RUN);
    assert.equal(pkg.review, s.review);
    const qs = pkg.questions as { number: number; answered_by: number; answers: unknown[] }[];
    assert.deepEqual(
      qs.map((q) => [q.number, q.answered_by, q.answers.length]),
      [
        [1, 2, 2],
        [2, 2, 2],
      ],
    );
    const hs = pkg.hypotheses as {
      id: string;
      verdicts: { verdict: string; reviewers: number }[];
    }[];
    assert.deepEqual(
      hs[0]?.verdicts.map((v) => [v.verdict, v.reviewers]),
      [["supported", 2]],
    );
    assert.deepEqual(pkg.figures, {
      sources: 2,
      domains: 1,
      verified_claims: 2,
      corroborated_claims: 0,
      draft_claims: 1,
      findings: 1,
      draft_findings: 1,
      questions: 2,
      hypotheses: 1,
      min_independent_domains: 2,
      review: s.review,
      reviewers: 2,
    });
    assert.ok((pkg.rules as string[]).some((r) => r.includes("## Results")));
    assert.equal(pkg.last_refusal, undefined);
  });

  test("the package is written from the cards: each question's card, its own claims and certainty line; the hypotheses proposed are listed and get no verdict", async (t) => {
    const s = await answered(t);
    const pool = (id: string, question: number | null, text: string) =>
      s.ledger.db
        .prepare(
          "insert into hypothesis (id, run, lane, text, supporting, status, question, created_at, updated_at) values (?, ?, 'lane-1', ?, '[]', 'pool', ?, ?, ?)",
        )
        .run(id, RUN, text, question, new Date().toISOString(), new Date().toISOString());
    pool("h-pool0001", 1, "A clock of 8 hours is enough.");
    await s.env.service.setAdvisors({ auditor: false, panel: 2, writer: true }, "supervisor");
    await scheduler(s).tick();
    const pkg = (
      (await s.call("GET", "/v1/research/papers/pending")).body.papers as unknown[]
    )[0] as {
      questions: {
        number: number;
        certainty_line: string;
        card: { version: number; answer: string } | null;
        claims: { id: string; quotes: string[] }[];
        verified_claims: number;
      }[];
      hypotheses: { id: string; status: string; question: number | null }[];
      proposed: { id: string; question: number | null }[];
      shortened?: string;
    };
    assert.deepEqual(
      pkg.questions.map((q) => [
        q.number,
        q.certainty_line,
        q.card?.answer,
        q.claims.map((c) => c.id),
        q.verified_claims,
      ]),
      [
        [1, "Certainty: moderate", "The first run archived 42 pages.", [s.ids.claims.verified], 1],
        [
          2,
          "Certainty: high",
          "A long campaign needs a clock the workers cannot stop.",
          [s.ids.claims.clock],
          1,
        ],
      ],
    );
    assert.ok((pkg.questions[0]?.claims[0]?.quotes.length ?? 0) > 0, "with its quotes");
    assert.deepEqual(
      pkg.hypotheses.map((h) => [h.id, h.status, h.question]),
      [[s.ids.hypothesis, "author", null]],
    );
    assert.deepEqual(pkg.proposed, [
      { id: "h-pool0001", text: "A clock of 8 hours is enough.", question: 2 },
    ]);
    assert.equal(pkg.shortened, undefined);
    // A proposed hypothesis given a verdict is refused; listed with no verdict, it holds, and the
    // number in its text is not refused.
    const check = async (paper: string) =>
      problemsOf((await s.call("POST", `/v1/research/papers/${RUN}/check`, { paper })).body);
    const judged = goodPaper(s.ids).replace(
      "\n\n### Proposed by the run",
      "\n| h-pool0001 | supported | It held. |\n\n### Proposed by the run",
    );
    assert.deepEqual(
      (await check(judged)).map((p) => p.problem),
      [
        'hypothesis h-pool0001 was proposed by the run, and the review panel did not judge it: list it under "### Proposed by the run" with no verdict',
      ],
    );
    const listed = goodPaper(s.ids, {
      hypotheses: `## Hypotheses\n\n| Hypothesis | Verdict | Evidence |\n| --- | --- | --- |\n| ${s.ids.hypothesis} | supported | The archive kept every page [${s.ids.claims.verified}]. |\n\n### Proposed by the run\n\n- h-pool0001: a clock of 8 hours is enough (question 2).`,
    });
    assert.deepEqual(await check(listed), []);
  });

  test("at the scale of a long run, the package stays within its limit and says what it left out", async (t) => {
    const s = await answered(t);
    const now = new Date().toISOString();
    // A thousand verified claims with long quotes, each card citing 60 of them, and 300 proposed hypotheses.
    const quote = "The archive kept the page and its text. ".repeat(12);
    const claim = s.ledger.db.prepare(
      "insert into claim (id, run, lane, question, text, quotes, verified, problems, created_at) values (?, ?, 'lane-1', ?, ?, ?, 1, '[]', ?)",
    );
    const ids: [string[], string[]] = [[], []];
    for (let k = 0; k < 1000; k++) {
      const id = `c-scale${String(k).padStart(5, "0")}`;
      claim.run(
        id,
        RUN,
        k % 2,
        `Claim ${k} says what one source shows about the archive and the clock.`,
        JSON.stringify(
          [1, 2, 3].map((n) => ({ source: s.ids.sources[0], quote: `${n} ${quote}` })),
        ),
        now,
      );
      const of = ids[k % 2 === 0 ? 0 : 1];
      if (of.length < 60) of.push(id);
    }
    // A new card of each question citing 60 claims, and the review panel's decision on it as before
    // (both tables are append-only).
    for (const [q, certainty] of [
      [0, "moderate"],
      [1, "high"],
    ] as const) {
      s.ledger.db
        .prepare(
          "insert into question_card (run, question, version, answer, certainty, claims, gaps, by, created_at) values (?, ?, 2, 'The archive kept its pages.', ?, ?, '[]', 'synthesizer', ?)",
        )
        .run(RUN, q, certainty, JSON.stringify(ids[q]), now);
      s.ledger.db
        .prepare(
          "insert into item_decision (run, kind, key, review, card_version, decision, certainty, dissent, decided_at) values (?, 'question', ?, ?, 2, 'answered', ?, '[]', ?)",
        )
        .run(RUN, String(q), s.review, certainty, now);
    }
    const pool = s.ledger.db.prepare(
      "insert into hypothesis (id, run, lane, text, supporting, status, question, created_at, updated_at) values (?, ?, 'lane-2', ?, '[]', 'pool', ?, ?, ?)",
    );
    for (let k = 0; k < 300; k++)
      pool.run(
        `h-scale${k}`,
        RUN,
        `Hypothesis ${k}: ${"a long proposal ".repeat(40)}`,
        k % 2,
        now,
        now,
      );
    await s.env.service.setAdvisors({ auditor: false, panel: 2, writer: true }, "supervisor");
    await scheduler(s).tick();
    const pkg = (
      (await s.call("GET", "/v1/research/papers/pending")).body.papers as unknown[]
    )[0] as {
      questions: { claims: { quotes: string[] }[]; claims_not_shown?: number }[];
      proposed: unknown[];
      proposed_not_shown?: number;
      shortened?: string;
    };
    assert.ok(JSON.stringify(pkg).length <= PAPER_PACKAGE_MAX, "within its limit");
    assert.match(String(pkg.shortened), /^To keep this package short: /);
    assert.match(String(pkg.shortened), /the claims are shown without their quotes/);
    assert.match(
      String(pkg.shortened),
      /Read every claim, quote and source of the run with the tools\.$/,
    );
    assert.equal(pkg.questions[0]?.claims[0]?.quotes.length, 0);
    // What is left out is counted, never dropped without a word.
    const q1 = pkg.questions[0];
    assert.equal((q1?.claims.length ?? 0) + (q1?.claims_not_shown ?? 0), 60);
    assert.equal(pkg.proposed.length + (pkg.proposed_not_shown ?? 0), 300);
    // The checks still hold for every claim of the question, shown or not.
    const check = async (paper: string) =>
      problemsOf((await s.call("POST", `/v1/research/papers/${RUN}/check`, { paper })).body);
    assert.deepEqual(
      await check(goodPaper(s.ids).replace("cannot stop [", `cannot stop [${ids[1][59]}, `)),
      [],
    );
  });

  test("check_paper finds an unknown or draft claim, a number not in the cited claims, a missing question section and a missing verdict", async (t) => {
    const s = await answered(t);
    await s.env.service.setAdvisors({ auditor: false, panel: 2, writer: true }, "supervisor");
    await scheduler(s).tick();
    const check = async (paper: string) =>
      problemsOf((await s.call("POST", `/v1/research/papers/${RUN}/check`, { paper })).body);
    const lineOf = (paper: string, words: string) =>
      paper.split("\n").findIndex((l) => l.includes(words)) + 1;
    // A paper that holds; the figures (2 sources, 1 site) and question numbers are not refused.
    assert.deepEqual(await check(goodPaper(s.ids)), []);
    // An unknown claim and a draft claim.
    const unknown = goodPaper(s.ids, {
      next: "## Next experiments\n\nFind a second site [c-000000000000].",
    });
    assert.deepEqual(await check(unknown), [
      { line: lineOf(unknown, "c-000000000000"), problem: "no claim c-000000000000" },
    ]);
    const draft = goodPaper(s.ids, {
      next: `## Next experiments\n\nCheck the larger count [${s.ids.claims.draft}].`,
    });
    assert.deepEqual(await check(draft), [
      {
        line: lineOf(draft, s.ids.claims.draft),
        problem: `claim ${s.ids.claims.draft} is a draft, not verified`,
      },
    ]);
    // A number not in the claims its paragraph cites, and one with no claim cited.
    const number = goodPaper(s.ids, {
      summary: `## Summary\n\nThe first run archived 43 pages [${s.ids.claims.verified}].\n\nIt took 7 days.`,
    });
    assert.deepEqual(await check(number), [
      {
        line: lineOf(number, "43 pages"),
        problem: `the number 43 is not in the claims this paragraph cites (${s.ids.claims.verified}) or in the figures`,
      },
      {
        line: lineOf(number, "7 days"),
        problem:
          "the number 7 has no claim cited beside it: cite the claims it comes from in this paragraph, as [c-…]",
      },
    ]);
    // A missing question section, and a hypothesis with no verdict.
    const noQ2 = goodPaper(s.ids, {
      results: `## Results\n\n### Question 1\n\nCertainty: moderate\n\nThe first run archived 42 pages [${s.ids.claims.verified}].`,
    });
    assert.deepEqual(
      (await check(noQ2)).map((p) => p.problem),
      [`Results has no "### Question 2" section (What keeps a long campaign honest?)`],
    );
    const noVerdict = goodPaper(s.ids, {
      hypotheses: `## Hypotheses\n\n### Hypothesis ${s.ids.hypothesis}\n\nThe archive kept every page [${s.ids.claims.verified}].`,
    });
    assert.deepEqual(await check(noVerdict), [
      {
        line: lineOf(noVerdict, `### Hypothesis ${s.ids.hypothesis}`),
        problem: `hypothesis ${s.ids.hypothesis} has no verdict: write supported, refuted or undecided in its Verdict cell (or a line "Verdict: …" in its section)`,
      },
    ]);
    // A section with a verdict line still holds (goal 112's form).
    const section = goodPaper(s.ids, {
      hypotheses: `## Hypotheses\n\n### Hypothesis ${s.ids.hypothesis}\n\nVerdict: supported\n\nThe archive kept every page [${s.ids.claims.verified}].`,
    });
    assert.deepEqual(await check(section), []);
    // No row for the hypothesis; a row with no verdict.
    const noRow = goodPaper(s.ids, {
      hypotheses: "## Hypotheses\n\n| Hypothesis | Verdict |\n| --- | --- |",
    });
    assert.deepEqual(
      (await check(noRow)).map((p) => p.problem),
      [
        `Hypotheses has no row for hypothesis ${s.ids.hypothesis} in its table of verdicts (Stateless workers make long runs safe.)`,
      ],
    );
    // A verdict the review panel did not give; a References part; a part out of order.
    const refuted = goodPaper(s.ids).replace("| supported |", "| refuted |");
    assert.deepEqual(
      (await check(refuted)).map((p) => p.problem),
      [
        `the verdict "refuted" on hypothesis ${s.ids.hypothesis} is not one the review panel gave: it gave supported`,
      ],
    );
    const refs = `${goodPaper(s.ids)}\n## References\n\n- a list\n`;
    assert.deepEqual(
      (await check(refs)).map((p) => p.problem),
      ["leave out the References part: code appends it from the claims the paper cites"],
    );
    const panel = `${goodPaper(s.ids)}\n## Review panel\n\n- a list\n`;
    assert.deepEqual(
      (await check(panel)).map((p) => p.problem),
      [
        "leave out the Review panel part: code appends the review panel's decisions and each dissent",
      ],
    );
    // A certainty line missing, and one that is not the review panel's decision (goal 117).
    const noCertainty = goodPaper(s.ids).replace("Certainty: moderate\n\n", "");
    assert.deepEqual(await check(noCertainty), [
      {
        line: lineOf(noCertainty, "### Question 1"),
        problem: `"### Question 1" has no certainty line: write "Certainty: moderate" under its heading (the review panel's decision)`,
      },
    ]);
    const higher = goodPaper(s.ids).replace("Certainty: moderate", "Certainty: high");
    assert.deepEqual(await check(higher), [
      {
        line: lineOf(higher, "Certainty: high"),
        problem: `the certainty "high" of question 1 is not the review panel's decision: write "Certainty: moderate"`,
      },
    ]);
    // A section that cites another question's evidence.
    const borrowed = goodPaper(s.ids).replace(
      "cannot stop [",
      `cannot stop [${s.ids.claims.verified}, `,
    );
    assert.deepEqual(await check(borrowed), [
      {
        line: lineOf(borrowed, "cannot stop ["),
        problem: `"### Question 2" cites ${s.ids.claims.verified}, which is not evidence for question 2: cite the claims of its card or other verified claims of question 2`,
      },
    ]);
    // Method and Limits of the evidence swapped.
    const order = goodPaper(s.ids, {
      method: "## Limits of the evidence\n\nAll the claims come from 1 site.",
      limits: "## Method\n\nThe harness archived 2 sources.",
    });
    const inOrder =
      "the parts go in this order: Summary, Questions, Method, Results, Hypotheses, Limits of the evidence, Next experiments";
    assert.deepEqual(await check(order), [
      {
        line: lineOf(order, "## Results"),
        problem: `"## Results" comes after "## Limits of the evidence": ${inOrder}`,
      },
      {
        line: lineOf(order, "## Method"),
        problem: `"## Method" comes after "## Hypotheses": ${inOrder}`,
      },
    ]);
    // A part missing.
    assert.deepEqual(
      (await check(goodPaper(s.ids, { limits: "" }))).map((p) => p.problem),
      ['the paper has no "## Limits of the evidence" part'],
    );
    // Nothing is recorded by a check.
    assert.equal(s.events("research_paper_refused").length, 0);
    // A run that does not wait for a paper is refused.
    const other = await s.call("POST", "/v1/research/papers/r-9/check", { paper: "# x" });
    assert.equal(other.status, 404);
  });

  test("a paper the STE checker found errors in is refused, and the writer's next package carries the problems", async (t) => {
    const s = await answered(t);
    await s.env.service.setAdvisors({ auditor: false, panel: 2, writer: true }, "supervisor");
    await scheduler(s).tick();
    const paper = goodPaper(s.ids);
    const ste = {
      checked: true,
      sha256: paperSha(paper),
      version: "1.0.0",
      issue: "9",
      counts: { error: 1, warning: 2, info: 0 },
      findings: [
        {
          line: 3,
          column: 1,
          severity: "error",
          rule: "4.1",
          message: "The sentence has more than 25 words.",
          text: "The first run archived",
        },
      ],
    };
    const r = await s.call("POST", `/v1/research/papers/${RUN}`, {
      writer: "teacher-1",
      paper,
      experiments: [],
      ste,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, false);
    assert.deepEqual(problemsOf(r.body), [
      { line: null, problem: "the STE checker found 1 error" },
      {
        line: 3,
        problem: 'STE 4.1: The sentence has more than 25 words. ("The first run archived")',
      },
    ]);
    // A result of another text is refused too.
    const other = await s.call("POST", `/v1/research/papers/${RUN}`, {
      writer: "teacher-1",
      paper,
      ste: {
        ...ste,
        counts: { error: 0, warning: 0, info: 0 },
        findings: [],
        sha256: "0".repeat(64),
      },
    });
    assert.deepEqual(problemsOf(other.body), [
      { line: null, problem: "the STE checker's result is not of this paper's text" },
    ]);
    const refused = s.events("research_paper_refused");
    assert.equal(refused.length, 2);
    assert.deepEqual(refused[0], {
      review: s.review,
      writer: "teacher-1",
      count: 2,
      problems: [
        "the STE checker found 1 error",
        'line 3: STE 4.1: The sentence has more than 25 words. ("The first run archived")',
      ],
      ste_checked: true,
    });
    const pkg = (
      (await s.call("GET", "/v1/research/papers/pending")).body.papers as {
        last_refusal?: { problems: string[] };
      }[]
    )[0];
    assert.deepEqual(pkg?.last_refusal?.problems, [
      "the STE checker's result is not of this paper's text",
    ]);
    assert.equal(s.ledger.getRun(RUN)?.status, "running", "it still waits for its paper");
  });

  test("accepted: paper.md, the final report with the paper first, the next experiments in the knowledge base, and the close once trials end", async (t) => {
    const s = await answered(t);
    await s.env.service.setAdvisors({ auditor: false, panel: 2, writer: true }, "supervisor");
    const sch = scheduler(s);
    await sch.tick();
    const paper = goodPaper(s.ids);
    // An experiment that rests on a draft finding is refused with the paper.
    const bad = await s.call("POST", `/v1/research/papers/${RUN}`, {
      writer: "teacher-1",
      paper,
      experiments: [
        {
          title: "Count again",
          why: "To be sure.",
          kind: "hill_climb",
          measure: "pages archived a minute, higher",
          findings: [s.ids.findings.draft],
        },
        { title: "Nothing under it", why: "A hunch.", kind: "goal", measure: "x" },
        // Goal 119: no kind; a kind that is not one; a kind with no measure.
        { title: "No kind", why: "W.", claims: [s.ids.claims.verified] },
        {
          title: "Odd kind",
          why: "W.",
          kind: "survey",
          measure: "m",
          claims: [s.ids.claims.verified],
        },
        { title: "No measure", why: "W.", kind: "Goal campaign", claims: [s.ids.claims.verified] },
      ],
      ste: NO_STE,
    });
    assert.deepEqual(problemsOf(bad.body), [
      {
        line: null,
        problem: `next experiment 1 ("Count again"): finding ${s.ids.findings.draft} is a draft, not supported`,
      },
      {
        line: null,
        problem:
          'next experiment 2 ("Nothing under it") rests on no finding or claim: give the ids of the supported findings or verified claims it builds on',
      },
      {
        line: null,
        problem:
          'next experiment 3 ("No kind") has no kind: give hill_climb (an improvement a hill climb measures against its champion) or goal (an outcome a goal campaign proves)',
      },
      {
        line: null,
        problem:
          'next experiment 4 ("Odd kind") has the kind "survey", which is not one: give hill_climb (an improvement a hill climb measures against its champion) or goal (an outcome a goal campaign proves)',
      },
      {
        line: null,
        problem:
          'next experiment 5 ("No measure") has no measure: give how a check would know the goal is reached',
      },
      // The paper has no "### For a goal campaign" section for its goal experiments.
      {
        line: null,
        problem:
          'Next experiments has no "### For a goal campaign" section, and 2 of its next experiments are for a goal campaign',
      },
    ]);
    const good = await s.call("POST", `/v1/research/papers/${RUN}`, {
      writer: "teacher-1",
      paper,
      experiments: [
        {
          title: "Measure the archive on a second site",
          why: "Every claim comes from one site.",
          details: "Run the same fetch on a second site and compare the page counts.",
          kind: "Hill climb",
          measure: "pages archived a minute, higher",
          findings: [s.ids.findings.supported],
          claims: [s.ids.claims.verified],
        },
      ],
      ste: NO_STE,
    });
    assert.equal(good.body.accepted, true, JSON.stringify(good.body));
    // Goal 119: the kind is read whatever its case, and kept with the measure.
    const kept = (s.events("research_paper_accepted")[0]?.experiments ?? []) as Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      kept.map((x) => [x.kind, x.measure]),
      [["hill_climb", "pages archived a minute, higher"]],
    );
    assert.equal(good.body.cited, 2);
    // Its event keeps the paper whole, with the references code appended.
    const accepted = s.events("research_paper_accepted")[0] as Record<string, unknown>;
    assert.equal(accepted.writer, "teacher-1");
    assert.deepEqual(accepted.ste, { checked: false, why: "the rig has no STE checker" });
    const whole = String(accepted.paper);
    assert.ok(whole.startsWith(paper.trimEnd()));
    assert.match(
      whole,
      new RegExp(
        `## References\\n\\nThe harness added this list: each claim the paper cites, and the archived sources its quotes come from\\.\\n\\n- \\[${s.ids.claims.verified}\\] Harness notes \\(127\\.0\\.0\\.1\\), ${s.base.replace(/[.]/g, "\\.")}/a\\.html\\n- \\[${s.ids.claims.clock}\\] Long campaigns \\(127\\.0\\.0\\.1\\), `,
      ),
    );
    // The review panel's decisions and dissent, appended by code before the references (goal 117).
    assert.ok(whole.indexOf("## Review panel") > paper.trimEnd().length);
    assert.ok(whole.indexOf("## Review panel") < whole.indexOf("## References"));
    assert.match(
      whole,
      new RegExp(
        `\\| Question 1 \\| answered, certainty moderate \\(review ${s.review}\\) \\| 2 \\| none \\|\n\\| Question 2 \\| answered, certainty high \\(review ${s.review}\\) \\| 2 \\| none \\|\n\\| Hypothesis ${s.ids.hypothesis} \\| supported \\(review ${s.review}\\) \\| 2 \\| none \\|`,
      ),
    );
    // paper.md in the run's research folder at once.
    const folderPaper = join(s.folder.root(RUN), PAPER_FILE);
    assert.ok(existsSync(folderPaper));
    assert.equal(readFileSync(folderPaper, "utf8"), whole);
    // Its next experiments beside it, each with its kind (goal 119), for the next campaign.
    const nextFile = JSON.parse(
      readFileSync(join(s.folder.root(RUN), NEXT_EXPERIMENTS_FILE), "utf8"),
    ) as { run: string; experiments: Record<string, unknown>[] };
    assert.equal(nextFile.run, RUN);
    assert.deepEqual(
      nextFile.experiments.map((x) => [x.title, x.kind, x.measure]),
      [["Measure the archive on a second site", "hill_climb", "pages archived a minute, higher"]],
    );
    // A second paper is refused.
    const again = await s.call("POST", `/v1/research/papers/${RUN}`, {
      writer: "teacher-1",
      paper,
      ste: NO_STE,
    });
    assert.equal(again.status, 409);
    // The next experiment: an experiment of the campaign's folder, from the run and the writer.
    const part = knowledgePart(s.ledger, "rig-r", 0, s.ledger.latestEventId()).filter(
      (x) => x.kind === "experiment",
    );
    assert.equal(part.length, 1);
    assert.equal(part[0]?.title, "Measure the archive on a second site");
    assert.equal(part[0]?.by, "writer:teacher-1");
    assert.equal(part[0]?.run, RUN);
    assert.match(String(part[0]?.body), /Why: Every claim comes from one site\./);
    // Tagged with the run it is for (goal 119): in words, and as the item's sub, which the export keeps.
    assert.match(
      String(part[0]?.body),
      /^For: a hill climb, an improvement to measure against its champion\.\nMeasure: pages archived a minute, higher\n/,
    );
    assert.equal(part[0]?.sub, "for a hill climb");
    assert.match(
      String(part[0]?.body),
      new RegExp(
        `It rests on, from the research paper of run ${RUN}:\\n- finding ${s.ids.findings.supported}: The harness kept its first run's pages\\.`,
      ),
    );
    // The run closes once its trials end: the final report starts with the paper.
    await sch.tick();
    const run = s.ledger.getRun(RUN);
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", ANSWERED]);
    const final = String(
      (
        s.ledger.db
          .prepare("select body from report_version where kind = 'final' order by id desc limit 1")
          .get() as { body: string }
      ).body,
    );
    assert.ok(final.startsWith("# What the first runs of the harness show\n\n## Summary"));
    const at = (words: string) => final.indexOf(words);
    assert.ok(at("## References") > 0);
    assert.ok(
      at("# Appendix: the review panel's decisions and the corpus of") > at("## References"),
    );
    assert.ok(at("## Answers") > at("# Appendix"));
    // The answer cards first (goal 117), then the review panel's decisions.
    assert.ok(at("## The review panel's decisions") > at("## Answers"));
    assert.ok(
      at("## Verified claims from a single domain") > at("## The review panel's decisions"),
    );
    assert.equal(s.ledger.latestEventBody("research_final", RUN)?.paper, true);
    // The run's next export carries the folder with its paper (main.ts gives the export the folder).
    s.env.service.researchFolder = (run) => s.folder.exportFiles(run);
    const ex = await s.env.service.export("test");
    assert.ok(
      existsSync(join(ex.dir, "research", RUN, "folder", PAPER_FILE)),
      "the export holds paper.md",
    );
  });
});
