import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import { parseContract } from "../core/contract.ts";
import { researchFixture } from "../testing/fixtures.ts";
import { fillResearch, makeResearchRun, RESEARCH_QUESTIONS } from "../testing/research-run.ts";
import type { ResearchTrialSpec } from "./agents/research-worker.ts";
import { Scheduler } from "./agents/scheduler.ts";
import { createHarnessApi } from "./api.ts";
import { LocalRunner } from "./broker/runner.ts";
import type { Research } from "./research/research.ts";
import {
  ANSWERED,
  type CheckedReviewer,
  RESEARCH_PACKAGE_MAX,
  RESEARCH_REVIEW,
  type ResearchPackage,
  researchPackage,
  researchReviewDue,
} from "./research/review.ts";
import { Reviews } from "./reviews.ts";

/**
 * Goal 112: a research run ends when the review panel finds its questions answered. After the
 * minimum running time, at a digest, code checks the evidence and asks the review panel; code
 * checks each reviewer's answers; a pass closes the run with its final report, hands-off or after
 * the owner's acceptance; gaps reach the run's journal and the workers' briefs, and the run goes
 * on until new evidence is checked again.
 */

const RUN = "r-1";
const tokens = { supervisor: "sup-token", proposer: "prop-token" };

type Env = Awaited<ReturnType<typeof makeResearchRun>>;
type Ids = Awaited<ReturnType<typeof fillResearch>>;

const done = {
  stopped: "no_submission" as const,
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
};

async function setup(
  t: TestContext,
  o: { contract?: Record<string, unknown>; assign?: Record<string, unknown>; fill?: boolean } = {},
) {
  const r = await makeResearchRun(RUN, o);
  t.after(() => r.close());
  const ids = o.fill === false ? undefined : await fillResearch(r);
  const ledger = r.env.service.ledger;
  /** The run has run for this many hours (its clock counts from its creation). */
  const ranFor = (hours: number) =>
    ledger.db
      .prepare("update run set created_at = ? where id = ?")
      .run(new Date(Date.now() - hours * 3_600_000).toISOString(), RUN);
  /** The newest report is old, so the next step writes a digest. */
  const digestDue = () =>
    ledger.db.prepare("update report_version set created_at = '2000-01-01T00:00:00.000Z'").run();
  const due = () =>
    researchReviewDue(
      ledger,
      RUN,
      r.env.service.contractFor(RUN) as Parameters<typeof researchReviewDue>[2],
      r.research.clock(RUN),
    );
  /** Asks the review panel as the scheduler does at a digest. Returns the review's id. */
  const ask = () => {
    const d = due();
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    return new Reviews(ledger).requestResearch({
      run: RUN,
      marker: d.marker,
      pkg: researchPackage(
        ledger,
        RUN,
        r.env.service.contractFor(RUN) as Parameters<typeof researchPackage>[2],
      ),
      by: "s",
    });
  };
  const reviews = () =>
    ledger.db
      .prepare("select * from review where run = ? and goal = ? order by id")
      .all(RUN, RESEARCH_REVIEW) as Record<string, unknown>[];
  return { ...r, ids, ledger, ranFor, digestDue, due, ask, reviews };
}

/** A scheduler for the run, its research trials run by `trial`, `concurrent` at once. */
function scheduler(
  env: Env,
  trial: (spec: ResearchTrialSpec, signal: AbortSignal) => Promise<typeof done> = async () => done,
  concurrent = 1,
) {
  return new Scheduler({
    service: env.env.service,
    runner: new LocalRunner(env.env.service.paths.scratchDir),
    model: {
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 1,
      maxTokens: 1,
    },
    owner: "s",
    research: env.research as Research,
    runTrial: async () => done,
    runResearchTrial: trial,
    maxConcurrent: concurrent,
  });
}

/** A reviewer who answers both questions from the fixture's verified claims, and the hypothesis. */
function goodReviewer(name: string, ids: Ids) {
  return {
    reviewer: name,
    pass: true,
    reasons: "Both questions are answered by verified claims.",
    research: {
      questions: [
        {
          index: 0,
          answered: true,
          answer: "The first run archived 42 pages.",
          claims: [ids.claims.verified],
          missing: "",
        },
        {
          index: 1,
          answered: true,
          answer: "A clock the workers cannot stop keeps a long campaign honest.",
          claims: [ids.claims.clock],
          missing: "",
        },
      ],
      hypotheses: [
        {
          id: ids.hypothesis,
          verdict: "supported" as const,
          why: "The archive kept every page the workers read.",
          claims: [ids.claims.verified],
        },
      ],
    },
  };
}

const lastFinal = (s: { ledger: Env["env"]["service"]["ledger"] }) =>
  String(
    (
      s.ledger.db
        .prepare("select body from report_version where kind = 'final' order by id desc limit 1")
        .get() as { body: string } | undefined
    )?.body ?? "",
  );

const notes = (s: { ledger: Env["env"]["service"]["ledger"] }) =>
  s.ledger.db.prepare("select by, kind, text from journal_note order by id").all() as {
    by: string;
    kind: string;
    text: string;
  }[];

describe("the review panel is asked whether a research run's questions are answered (goal 112)", () => {
  test("only after the minimum, at a digest, with a verified claim for each question, and never twice on the same evidence", async (t) => {
    const s = await setup(t);
    const sch = scheduler(s);
    // Before the minimum (2h): a digest asks nothing, and says when the check starts.
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 0, "no review before the minimum");
    const early = String(
      (
        s.ledger.db
          .prepare("select body from report_version where kind = 'digest' order by id desc limit 1")
          .get() as { body: string }
      ).body,
    );
    assert.match(early, /Answer check: it starts after the minimum running time/);
    // After it: the next digest asks once, and says so.
    s.ranFor(3);
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 1, "one review at the digest after the minimum");
    const digest = String(
      (
        s.ledger.db
          .prepare("select body from report_version where kind = 'digest' order by id desc limit 1")
          .get() as { body: string }
      ).body,
    );
    assert.match(digest, /Answer check: the review panel checks review \d+\./);
    // The next digest, the review still waiting: none more.
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 1, "none while one waits");
    // Gaps on this evidence: not asked again on it.
    const ids = s.ids as Ids;
    const first = Number(s.reviews()[0]?.id);
    const fail = {
      ...goodReviewer("reviewer-2", ids),
      pass: false,
      research: {
        ...goodReviewer("reviewer-2", ids).research,
        questions: [
          goodReviewer("reviewer-2", ids).research.questions[0] as never,
          { index: 1, answered: false, answer: "", claims: [], missing: "a second site" },
        ],
      },
    };
    assert.deepEqual(
      s.env.service.recordReviewPanel(first, [goodReviewer("reviewer-1", ids), fail], "supervisor"),
      { result: "review_failed" },
    );
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 1, "the same evidence is not asked again");
    const again = s.due();
    assert.match("why" in again ? again.why : "", /saw this evidence/);
    // New evidence: a new review at the next digest.
    const b = (await s.research.fetch(RUN, "lane-1", `${s.base}/b.html`)) as { source: string };
    s.research.addClaim(RUN, "lane-1", {
      text: "Long research campaigns need a clock.",
      quotes: [
        {
          source: b.source,
          quote: "Long research campaigns need a clock the workers cannot stop.",
        },
      ],
      question: 1,
    });
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 2, "new evidence: a new review");
    assert.notEqual(s.reviews()[0]?.commit_sha, s.reviews()[1]?.commit_sha);
  });

  test("a question without a verified claim, or fewer verified claims than the campaign's floor, holds the check", async (t) => {
    const s = await setup(t, { fill: false, contract: { min_verified_claims: 2 } });
    s.ranFor(3);
    const a = (await s.research.fetch(RUN, "lane-1", `${s.base}/a.html`)) as { source: string };
    s.research.addClaim(RUN, "lane-1", {
      text: "The first run archived 42 pages.",
      quotes: [{ source: a.source, quote: "The harness archived 42 pages in its first run." }],
      question: 0,
    });
    let d = s.due();
    assert.equal(d.due, false);
    assert.match("why" in d ? d.why : "", /^question 2 has no verified claim yet$/);
    const b = (await s.research.fetch(RUN, "lane-1", `${s.base}/b.html`)) as { source: string };
    s.research.addClaim(RUN, "lane-1", {
      text: "Long campaigns need a clock the workers cannot stop.",
      quotes: [
        {
          source: b.source,
          quote: "Long research campaigns need a clock the workers cannot stop.",
        },
      ],
      question: 1,
    });
    // Both questions covered, and the floor of 2 met.
    assert.equal(s.due().due, true);
    // A floor of 3: held until a third verified claim.
    const t3 = await setup(t, { fill: false, contract: { min_verified_claims: 3 } });
    t3.ranFor(3);
    const a3 = (await t3.research.fetch(RUN, "lane-1", `${t3.base}/a.html`)) as { source: string };
    const b3 = (await t3.research.fetch(RUN, "lane-1", `${t3.base}/b.html`)) as { source: string };
    t3.research.addClaim(RUN, "lane-1", {
      text: "The first run archived 42 pages.",
      quotes: [{ source: a3.source, quote: "The harness archived 42 pages in its first run." }],
      question: 0,
    });
    t3.research.addClaim(RUN, "lane-1", {
      text: "Long campaigns need a clock the workers cannot stop.",
      quotes: [
        {
          source: b3.source,
          quote: "Long research campaigns need a clock the workers cannot stop.",
        },
      ],
      question: 1,
    });
    d = t3.due();
    assert.equal(d.due, false);
    assert.match(
      "why" in d ? d.why : "",
      /the run has 2 verified claims of the 3 the campaign asks for/,
    );
    t3.research.addClaim(RUN, "lane-1", {
      text: "Stateless workers lose nothing when they crash.",
      quotes: [{ source: a3.source, quote: "Stateless workers lose nothing when they crash." }],
      question: 1,
    });
    assert.equal(t3.due().due, true);
  });

  test("while a review waits for the review panel or for the owner, new evidence asks nothing more", async (t) => {
    const s = await setup(t, { assign: { ask_owner: { reviews: true } } });
    const ids = s.ids as Ids;
    s.ranFor(3);
    const first = s.ask();
    const more = async (text: string) => {
      const b = (await s.research.fetch(RUN, "lane-1", `${s.base}/b.html`)) as { source: string };
      s.research.addClaim(RUN, "lane-1", {
        text,
        quotes: [
          {
            source: b.source,
            quote: "Long research campaigns need a clock the workers cannot stop.",
          },
        ],
        question: 1,
      });
    };
    await more("Long research campaigns need a clock.");
    let d = s.due();
    assert.equal(d.due, false);
    assert.equal("why" in d ? d.why : "", `review ${first} waits`);
    // Passed, and waiting for the owner's acceptance: still none.
    s.env.service.recordReviewPanel(
      first,
      [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
      "supervisor",
    );
    await more("Research campaigns need a clock the workers cannot stop.");
    d = s.due();
    assert.equal("why" in d ? d.why : "", `review ${first} waits`);
  });

  test("min_verified_claims is a whole number from 1, and a contract without it keeps its hash", () => {
    const base = { ...researchFixture };
    const without = parseContract(base);
    assert.ok(without.ok);
    assert.equal("min_verified_claims" in without.contract, false, "no default");
    const withIt = parseContract({ ...base, min_verified_claims: 5 });
    assert.ok(withIt.ok);
    assert.notEqual(withIt.sha, without.sha);
    assert.equal(parseContract({ ...base, min_verified_claims: 0 }).ok, false);
    assert.equal(parseContract({ ...base, min_verified_claims: 2.5 }).ok, false);
  });
});

describe("the research review's package (goal 112)", () => {
  test("the topic, each question with its verified claims, the supported findings and the hypotheses; no lane or model", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const pkg = new Reviews(s.ledger).pending(["research"])[0] as ResearchPackage & {
      id: number;
    };
    assert.equal(pkg.id, id);
    assert.equal(pkg.kind, "research");
    assert.equal(pkg.topic, researchFixture.topic);
    assert.deepEqual(
      pkg.questions.map((q) => [q.index, q.text, q.claims.map((c) => c.id)]),
      [
        [0, RESEARCH_QUESTIONS[0], [ids.claims.verified]],
        [1, RESEARCH_QUESTIONS[1], [ids.claims.clock]],
      ],
      "verified claims only, by their question",
    );
    assert.deepEqual(pkg.questions[0]?.claims[0], {
      id: ids.claims.verified,
      text: "The first run archived 42 pages.",
      domains: ["127.0.0.1"],
      corroborated: false,
    });
    assert.deepEqual(
      pkg.findings.map((f) => f.id),
      [ids.findings.supported],
      "supported findings only",
    );
    assert.deepEqual(pkg.hypotheses, [
      {
        id: ids.hypothesis,
        text: "Stateless workers make long runs safe.",
        supporting: [ids.claims.verified],
      },
    ]);
    assert.ok(pkg.criteria.length > 0);
    // Nothing about which lane, trial or model wrote what.
    const text = JSON.stringify(pkg);
    assert.ok(!/lane|trial|model/i.test(text), text);
  });

  test("a large corpus is shortened to fit: corroborated and newest claims first, and it says so", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    const insert = s.ledger.db.prepare(
      "insert into claim (id, run, lane, question, text, quotes, verified, problems, created_at) values (?, ?, ?, ?, ?, ?, 1, '[]', ?)",
    );
    const quotes = JSON.stringify([{ source: ids.sources[0], quote: "x" }]);
    for (let i = 0; i < 400; i++)
      insert.run(
        `c-bulk${i}`,
        RUN,
        "lane-1",
        0,
        `Claim ${"w".repeat(900)} ${i}`,
        quotes,
        new Date(Date.now() + i).toISOString(),
      );
    const pkg = researchPackage(
      s.ledger,
      RUN,
      s.env.service.contractFor(RUN) as Parameters<typeof researchPackage>[2],
    );
    assert.ok(JSON.stringify(pkg).length <= RESEARCH_PACKAGE_MAX);
    const q0 = pkg.questions[0];
    assert.ok(q0?.not_shown && q0.not_shown > 0);
    assert.equal(q0?.verified_claims, 401);
    assert.equal(q0?.claims[0]?.id, "c-bulk399", "the newest first");
    assert.match(String(pkg.shortened), /not shown/);
  });

  test("a supervisor that does not ask for research reviews never gets one", async (t) => {
    const s = await setup(t);
    s.ranFor(3);
    s.ask();
    assert.deepEqual(new Reviews(s.ledger).pending(), [], "pending() alone: goal reviews only");
    const api = createHarnessApi(s.env.service, tokens);
    const get = async (path: string) =>
      (
        (await (
          await api.request(path, { headers: { authorization: `Bearer ${tokens.supervisor}` } })
        ).json()) as { reviews: { kind?: string }[] }
      ).reviews;
    assert.deepEqual(
      await get("/v1/reviews/pending"),
      [],
      "an older supervisor asks with no kinds",
    );
    assert.deepEqual(
      (await get("/v1/reviews/pending?kinds=goal,research")).map((r) => r.kind),
      ["research"],
    );
    assert.deepEqual(
      (await get("/v1/reviews/pending?kinds=research")).map((r) => r.kind),
      ["research"],
    );
    assert.deepEqual(await get("/v1/reviews/pending?kinds=goal"), []);
  });
});

describe("code checks the review panel's answers (goal 112)", () => {
  test("a bad citation, a draft, a number not in the cited claims, a missing verdict and too few reviewers fail it", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const good = goodReviewer("reviewer-1", ids);
    assert.throws(
      () => s.env.service.recordReviewPanel(id, [good], "supervisor"),
      /at least 2 reviewers/,
    );
    const bad = {
      reviewer: "reviewer-2",
      pass: true,
      reasons: "All answered.",
      research: {
        questions: [
          // A number its claims do not have, and a claim that does not exist.
          {
            index: 0,
            answered: true,
            answer: "The first run archived 43 pages.",
            claims: [ids.claims.verified, "c-nope"],
            missing: "",
          },
          // A draft claim.
          {
            index: 1,
            answered: true,
            answer: "A clock keeps it honest.",
            claims: [ids.claims.draft],
            missing: "",
          },
        ],
        // No verdict on the hypothesis.
        hypotheses: [],
      },
    };
    assert.deepEqual(s.env.service.recordReviewPanel(id, [good, bad], "supervisor"), {
      result: "review_failed",
    });
    const row = new Reviews(s.ledger).byId(id) as { panel: string; panel_result: string };
    const panel = JSON.parse(row.panel) as CheckedReviewer[];
    assert.equal(panel[0]?.pass, true);
    const r2 = panel[1] as CheckedReviewer;
    assert.deepEqual([r2.pass, r2.said_pass], [false, true]);
    assert.deepEqual(r2.questions[0]?.problems, [
      "no claim c-nope",
      "the number 43 is not in the claims it cites",
    ]);
    assert.equal(r2.questions[0]?.answered, false);
    assert.deepEqual(r2.questions[1]?.problems, [
      `claim ${ids.claims.draft} is a draft, not verified`,
    ]);
    assert.deepEqual(r2.hypotheses[0]?.problems, [
      "the reviewer gave no verdict on this hypothesis",
    ]);
    // Each reviewer's findings in the run's journal, by the review panel; the run goes on.
    const panelNotes = notes(s).filter((n) => n.by.startsWith("panel:"));
    assert.deepEqual(
      panelNotes.map((n) => n.by),
      ["panel:reviewer-1", "panel:reviewer-2"],
    );
    assert.match(
      panelNotes[1]?.text ?? "",
      /Question 1: the answer did not pass the check \(no claim c-nope; the number 43 is not in the claims it cites\)/,
    );
    assert.match(panelNotes[1]?.text ?? "", /Hypothesis h-[0-9a-f]+: no verdict/);
    assert.equal(s.env.service.ledger.getRun(RUN)?.status, "running");
  });

  test("a verdict needs its claims (supported or refuted) or its why (undecided); the reviewer's own fail counts", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const g = goodReviewer("reviewer-1", ids);
    const noClaims = {
      ...goodReviewer("reviewer-2", ids),
      research: {
        ...g.research,
        hypotheses: [{ id: ids.hypothesis, verdict: "supported" as const, why: "yes", claims: [] }],
      },
    };
    const noWhy = {
      ...goodReviewer("reviewer-3", ids),
      research: {
        ...g.research,
        hypotheses: [{ id: ids.hypothesis, verdict: "undecided" as const, why: " ", claims: [] }],
      },
    };
    const saysFail = { ...goodReviewer("reviewer-4", ids), pass: false };
    s.env.service.recordReviewPanel(id, [g, noClaims, noWhy, saysFail], "supervisor");
    const panel = JSON.parse(
      String((new Reviews(s.ledger).byId(id) as { panel: string }).panel),
    ) as CheckedReviewer[];
    assert.deepEqual(
      panel.map((r) => r.pass),
      [true, false, false, false],
    );
    assert.deepEqual(panel[1]?.hypotheses[0]?.problems, ["a supported verdict cites no claim"]);
    assert.deepEqual(panel[2]?.hypotheses[0]?.problems, ["an undecided verdict needs its why"]);
    assert.equal(panel[3]?.said_pass, false);
  });
});

describe("a passed review closes the run with its answers (goal 112)", () => {
  test("hands-off: running trials end first, then the final report holds the answers and verdicts, and the run closes", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    // Trials that run until they are let go, on two lanes; one of them ends at once, so a lane
    // is free when the review is accepted.
    const releases: (() => void)[] = [];
    let started = 0;
    const held = () =>
      new Promise<typeof done>((resolve) => {
        started++;
        if (started === 1) resolve(done);
        else releases.push(() => resolve(done));
      });
    const sch = scheduler(s, held, 2);
    await sch.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(started, 2, "two trials started; one of them still runs");
    const release = () => {
      for (const r of releases.splice(0)) r();
    };
    s.ranFor(3);
    const id = s.ask();
    assert.deepEqual(
      s.env.service.recordReviewPanel(
        id,
        [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
        "supervisor",
      ),
      { result: "review_passed", accepted: true },
    );
    // Hands-off, said in its event and in the journal.
    const decided = s.ledger.latestEventBody("review_decided", RUN) as Record<string, unknown>;
    assert.equal(decided.decision, "accepted");
    assert.equal(
      decided.note,
      "hands-off: the review panel passed it, and the run does not ask the owner",
    );
    assert.ok(
      notes(s).some(
        (n) =>
          n.by === "harness" &&
          n.text.includes(
            "hands-off: the review panel passed it, and the run does not ask the owner",
          ),
      ),
    );
    // Its running trial ends first: no new trial starts on the free lane, and the run stays open.
    await sch.tick();
    assert.equal(started, 2, "no new trial");
    assert.equal(s.env.service.ledger.getRun(RUN)?.status, "running");
    release();
    await sch.idle();
    // Until the supervisor says whether it has a final writer, the run waits (goal 112).
    await sch.tick();
    assert.equal(
      s.env.service.ledger.getRun(RUN)?.status,
      "running",
      "it waits for the supervisor",
    );
    // A rig with no final writer: the run closes with the review panel's answers, and says why it
    // has no research paper.
    await s.env.service.setAdvisors({ auditor: false, panel: 2, writer: false }, "supervisor");
    await sch.tick();
    const run = s.env.service.ledger.getRun(RUN);
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", ANSWERED]);
    const final = lastFinal(s);
    assert.match(final, /Research paper: none, no final writer on this rig\./);
    assert.equal(
      s.ledger.latestEventBody("research_final", RUN)?.no_paper,
      "no final writer on this rig",
    );
    assert.equal(
      s.ledger.db
        .prepare("select count(*) as n from event where kind like 'research_paper_%'")
        .get()?.n,
      0,
      "no paper is asked for",
    );
    assert.match(
      final,
      /## Answers\nThe review panel found every question answered \(review \d+, 2 reviewers\)\./,
    );
    assert.match(
      final,
      new RegExp(
        `### 1\\. ${RESEARCH_QUESTIONS[0]?.replace(/\?/g, "\\?")}\\n\\nThe first run archived 42 pages\\.\\n\\nCites: ${ids.claims.verified}\\. Found answered by 2 of 2 reviewers\\.`,
      ),
    );
    assert.match(
      final,
      new RegExp(
        `## Hypotheses: the review panel's verdicts\\n- Stateless workers make long runs safe\\. \\(${ids.hypothesis}\\): supported \\(2 of 2 reviewers\\)\\.`,
      ),
    );
    // Once.
    await sch.tick();
    assert.equal(
      Number(
        (
          s.ledger.db
            .prepare("select count(*) as n from event where kind = 'research_final'")
            .get() as { n: number }
        ).n,
      ),
      1,
    );
  });

  test("a run that asks the owner about reviews waits for accept_review; a rejection goes on and needs new evidence", async (t) => {
    const s = await setup(t, { assign: { ask_owner: { reviews: true } } });
    const ids = s.ids as Ids;
    const sch = scheduler(s);
    s.ranFor(3);
    const pass = [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)];
    // Rejected: the run goes on, the owner's note in its journal, and no new review on the
    // same evidence.
    const first = s.ask();
    assert.deepEqual(s.env.service.recordReviewPanel(first, pass, "supervisor"), {
      result: "review_passed",
    });
    assert.equal(new Reviews(s.ledger).byId(first)?.owner_decision, null);
    await sch.tick();
    await sch.idle();
    assert.equal(s.env.service.ledger.getRun(RUN)?.status, "running", "it waits for the owner");
    const no = await s.env.service.applyCommand(
      s.env.sign("accept_review", {
        run: RUN,
        review: first,
        accept: false,
        note: "question 2 needs a primary source",
      }),
    );
    assert.ok(no.status === "applied" && no.accepted, JSON.stringify(no));
    await sch.tick();
    await sch.idle();
    assert.equal(s.env.service.ledger.getRun(RUN)?.status, "running", "a rejection goes on");
    assert.ok(
      notes(s).some(
        (n) =>
          n.by === "owner" &&
          n.text.includes(`did not accept review ${first}`) &&
          n.text.includes("question 2 needs a primary source"),
      ),
    );
    assert.equal(s.due().due, false, "not asked again on the same evidence");
    // New evidence: asked again; this time the owner accepts, and the run closes.
    const b = (await s.research.fetch(RUN, "lane-1", `${s.base}/b.html`)) as { source: string };
    s.research.addClaim(RUN, "lane-2", {
      text: "Long research campaigns need a clock.",
      quotes: [
        {
          source: b.source,
          quote: "Long research campaigns need a clock the workers cannot stop.",
        },
      ],
      question: 1,
    });
    const second = s.ask();
    s.env.service.recordReviewPanel(second, pass, "supervisor");
    const yes = await s.env.service.applyCommand(
      s.env.sign("accept_review", { run: RUN, review: second, accept: true }),
    );
    assert.ok(yes.status === "applied" && yes.accepted, JSON.stringify(yes));
    // This rig's supervisor has no final writer (goal 112).
    await s.env.service.setAdvisors({ auditor: false, panel: 2 }, "supervisor");
    await sch.tick();
    await sch.idle();
    await sch.tick();
    const run = s.env.service.ledger.getRun(RUN);
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", ANSWERED]);
    assert.match(lastFinal(s), /review \d+, 2 reviewers\), and the owner accepted it\./);
  });

  test("gaps reach the next workers' brief; a final report with no passed review says the questions were not checked as answered", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    const briefs: string[] = [];
    const sch = scheduler(s, async (spec) => {
      briefs.push(spec.brief);
      return done;
    });
    s.ranFor(3);
    const id = s.ask();
    const gap = {
      ...goodReviewer("reviewer-2", ids),
      pass: false,
      research: {
        ...goodReviewer("reviewer-2", ids).research,
        questions: [
          goodReviewer("reviewer-2", ids).research.questions[0] as never,
          {
            index: 1,
            answered: false,
            answer: "",
            claims: [],
            missing: "a second, independent site on what keeps campaigns honest",
          },
        ],
      },
    };
    s.env.service.recordReviewPanel(id, [goodReviewer("reviewer-1", ids), gap], "supervisor");
    await sch.tick();
    await sch.idle();
    const brief = briefs.at(-1) ?? "";
    assert.match(brief, new RegExp(`# What the review panel found missing \\(review ${id}\\)`));
    assert.match(
      brief,
      /- Question 2 \(index 1\): a second, independent site on what keeps campaigns honest/,
      "numbered as the brief numbers its questions",
    );
    // The owner closes it before new evidence is checked: its final report says so.
    s.research.report(RUN, "final");
    assert.match(
      lastFinal(s),
      new RegExp(
        `## Answers\\nThe questions were not checked as answered: review ${id} found gaps\\.`,
      ),
    );
  });
});
