import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import { parseContract } from "../../src/core/contract.ts";
import { MEASURES_NOTHING } from "../../src/core/research-check.ts";
import type { ResearchTrialSpec } from "../../src/harness/agents/research-worker.ts";
import { Scheduler } from "../../src/harness/agents/scheduler.ts";
import { createHarnessApi } from "../../src/harness/api.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import type { Research } from "../../src/harness/research/research.ts";
import {
  ANSWERED,
  briefGaps,
  type CheckedReviewer,
  RESEARCH_REVIEW,
  type ResearchPackage,
  type ResearchVerdicts,
  researchPackage,
  researchReviewDue,
} from "../../src/harness/research/review.ts";
import { Reviews } from "../../src/harness/reviews.ts";
import { researchFixture } from "../helpers/fixtures.ts";
import { goodReviewer } from "../helpers/research-paper.ts";
import {
  fillResearch,
  makeResearchRun,
  RESEARCH_QUESTIONS,
  writeCards,
} from "../helpers/research-run.ts";

/**
 * Goals 112 and 117: a research run's items are its questions, each with its answer card, and its
 * required hypotheses. After the minimum running time, at a digest, code asks the review panel
 * about the items with no standing decision, once every question has a card; code checks each
 * reviewer's answers; each item is decided by the majority, and the decision stands until the
 * question's card changes. A review that leaves every question at an end and every required
 * hypothesis with a verdict passes, and closes the run with its final report, hands-off or after
 * the owner's acceptance; open questions' evidence gaps reach the workers' briefs.
 */

const RUN = "r-1";
const tokens = { supervisor: "sup-token", proposer: "prop-token" };

type Env = Awaited<ReturnType<typeof makeResearchRun>>;
type Ids = Awaited<ReturnType<typeof fillResearch>>;
type Q = ResearchVerdicts["questions"][number];
type H = ResearchVerdicts["hypotheses"][number];

const done = {
  stopped: "no_submission" as const,
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
};

const answered = (
  index: number,
  claims: string[],
  answer: string,
  certainty: "high" | "moderate" | "low" = "high",
): Q => ({ index, verdict: "answered", certainty, answer, claims, gaps: "", next_experiments: "" });
const open = (index: number, gaps: string): Q => ({
  index,
  verdict: "open",
  certainty: null,
  answer: "",
  claims: [],
  gaps,
  next_experiments: "",
});
const reviewer = (name: string, questions: Q[], hypotheses: H[] = []) => ({
  reviewer: name,
  pass: questions.every((q) => q.verdict !== "open"),
  reasons: "Checked against the criteria.",
  research: { questions, hypotheses },
});

async function setup(
  t: TestContext,
  o: {
    contract?: Record<string, unknown>;
    assign?: Record<string, unknown>;
    fill?: boolean;
    cards?: boolean;
  } = {},
) {
  const r = await makeResearchRun(RUN, o);
  t.after(() => r.close());
  const ids = o.fill === false ? undefined : await fillResearch(r);
  if (ids && o.cards !== false) writeCards(r, ids);
  const ledger = r.env.service.ledger;
  /** The run has run for this many hours (its clock counts from its creation). */
  const ranFor = (hours: number) =>
    ledger.db
      .prepare("update run set created_at = ? where id = ?")
      .run(new Date(Date.now() - hours * 3_600_000).toISOString(), RUN);
  /** The newest report is old, so the next step writes a digest. */
  const digestDue = () =>
    ledger.db.prepare("update report_version set created_at = '2000-01-01T00:00:00.000Z'").run();
  const contract = () => r.env.service.contractFor(RUN) as Parameters<typeof researchReviewDue>[2];
  const due = () => researchReviewDue(ledger, RUN, contract(), r.research.clock(RUN));
  /** Asks the review panel as the scheduler does at a digest. Returns the review's id. */
  const ask = () => {
    const d = due();
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    return new Reviews(ledger).requestResearch({
      run: RUN,
      marker: d.marker,
      pkg: researchPackage(ledger, RUN, contract()),
      by: "s",
    });
  };
  const reviews = () =>
    ledger.db
      .prepare("select * from review where run = ? and goal = ? order by id")
      .all(RUN, RESEARCH_REVIEW) as Record<string, unknown>[];
  /** A new card for a question, as the synthesizer writes one: its version. */
  const card = (question: number, answer: string, claims: string[], certainty = "moderate") => {
    const out = r.env.service.submitCards(
      RUN,
      {
        synthesizer: "synthesizer",
        cards: [{ question, answer, certainty, claims, borrowed: [], gaps: [], through: null }],
      },
      "supervisor",
    ).results[0];
    assert.ok(out?.accepted, JSON.stringify(out));
    return out.version;
  };
  const pending = () =>
    new Reviews(ledger).pending(["research"]).at(-1) as ResearchPackage & { id: number };
  return { ...r, ids, ledger, ranFor, digestDue, due, ask, reviews, card, pending, contract };
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

const lastFinal = (s: { ledger: Env["env"]["service"]["ledger"] }) =>
  String(
    (
      s.ledger.db
        .prepare("select body from report_version where kind = 'final' order by id desc limit 1")
        .get() as { body: string } | undefined
    )?.body ?? "",
  );

const lastDigest = (s: { ledger: Env["env"]["service"]["ledger"] }) =>
  String(
    (
      s.ledger.db
        .prepare("select body from report_version where kind = 'digest' order by id desc limit 1")
        .get() as { body: string } | undefined
    )?.body ?? "",
  );

const notes = (s: { ledger: Env["env"]["service"]["ledger"] }) =>
  s.ledger.db.prepare("select by, kind, text from journal_note order by id").all() as {
    by: string;
    kind: string;
    text: string;
  }[];

describe("when the review panel is asked about a research run's items (goals 112 and 117)", () => {
  test("only after the minimum, at a digest, once every question has an answer card; never again on items that did not change", async (t) => {
    const s = await setup(t, { cards: false });
    const ids = s.ids as Ids;
    const sch = scheduler(s);
    // Before the minimum (2h): a digest asks nothing, and says when the check starts.
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 0, "no review before the minimum");
    assert.match(lastDigest(s), /Answer check: it starts after the minimum running time/);
    // After it, but no answer card yet: none.
    s.ranFor(3);
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 0);
    const bare = s.due();
    assert.equal("why" in bare ? bare.why : "", "questions 1, 2 have no answer card yet");
    // Both cards: the next digest asks once, about every item.
    writeCards(s, ids);
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 1, "one review at the digest after the cards");
    assert.match(lastDigest(s), /Answer check: the review panel checks review \d+\./);
    const first = Number(s.reviews()[0]?.id);
    assert.deepEqual(s.pending().decide, { questions: [0, 1], hypotheses: [ids.hypothesis] });
    assert.match(String(s.reviews()[0]?.commit_sha), /^items:0v1\.1v1:h1-[0-9a-f]{12}$/);
    // The next digest, the review still waiting: none more.
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 1, "none while one waits");
    // Question 1 answered, question 2 open, the hypothesis supported: decisions that stand.
    const good = goodReviewer("reviewer-1", ids).research;
    const r = (name: string) =>
      reviewer(
        name,
        [
          good.questions[0] as Q,
          open(1, "a second, independent site on what keeps campaigns honest"),
        ],
        good.hypotheses,
      );
    assert.deepEqual(
      s.env.service.recordReviewPanel(first, [r("reviewer-1"), r("reviewer-2")], "supervisor"),
      { result: "review_failed" },
    );
    // Nothing changed: no review is asked, at this digest or the next.
    for (let k = 0; k < 2; k++) {
      s.digestDue();
      await sch.tick();
      await sch.idle();
    }
    assert.equal(s.reviews().length, 1, "no item changed: no review");
    const again = s.due();
    assert.equal(
      "why" in again ? again.why : "",
      "every item has a decision that stands: a question is reviewed again when its answer card changes",
    );
    assert.match(
      lastDigest(s),
      /Answer check: not yet\. 1 of 2 questions have an end, and 1 of 1 required hypotheses a verdict; open: Question 2 \(index 1\) \(open in review \d+\); every item has a decision that stands/,
    );
    // A new card for question 2: the next digest asks about it alone, question 1 standing.
    const b = (await s.research.fetch(RUN, "lane-1", `${s.base}/b.html`)) as { source: string };
    const more = s.research.addClaim(RUN, "lane-1", {
      text: "Long research campaigns need a clock.",
      quotes: [
        {
          source: b.source,
          quote: "Long research campaigns need a clock the workers cannot stop.",
        },
      ],
      question: 1,
    });
    assert.equal(s.card(1, "A long campaign needs a clock.", [ids.claims.clock, more.claim]), 2);
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 2, "a new card: a new review");
    assert.notEqual(s.reviews()[0]?.commit_sha, s.reviews()[1]?.commit_sha);
    const pkg = s.pending();
    assert.deepEqual(pkg.decide, { questions: [1], hypotheses: [] });
    assert.equal(pkg.questions[0]?.decide, false);
    assert.equal(pkg.questions[0]?.standing?.decision, "answered");
    assert.equal(pkg.questions[1]?.card?.version, 2);
    assert.equal(pkg.hypotheses[0]?.standing?.decision, "supported");
  });

  test("a campaign's floor of verified claims holds the check", async (t) => {
    const s = await setup(t, { contract: { min_verified_claims: 3 } });
    const ids = s.ids as Ids;
    s.ranFor(3);
    let d = s.due();
    assert.equal(d.due, false);
    assert.match(
      "why" in d ? d.why : "",
      /the run has 2 verified claims of the 3 the campaign asks for/,
    );
    const a = (await s.research.fetch(RUN, "lane-1", `${s.base}/a.html`)) as { source: string };
    s.research.addClaim(RUN, "lane-1", {
      text: "Stateless workers lose nothing when they crash.",
      quotes: [{ source: a.source, quote: "Stateless workers lose nothing when they crash." }],
      question: 1,
    });
    d = s.due();
    assert.equal(d.due, true, JSON.stringify(d));
    assert.ok(ids);
  });

  test("while a review waits for the review panel or for the owner, a new card asks nothing more", async (t) => {
    const s = await setup(t, { assign: { ask_owner: { reviews: true } } });
    const ids = s.ids as Ids;
    s.ranFor(3);
    const first = s.ask();
    s.card(0, "The first run archived 42 pages, as its archive shows.", [ids.claims.verified]);
    let d = s.due();
    assert.equal("why" in d ? d.why : "", `review ${first} waits`);
    // Passed, and waiting for the owner's acceptance: still none.
    assert.deepEqual(
      s.env.service.recordReviewPanel(
        first,
        [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
        "supervisor",
      ),
      { result: "review_failed" },
      "question 1's card changed while the panel reviewed it: its decision does not stand",
    );
    d = s.due();
    assert.equal(d.due, true, "question 1's newer card is to decide");
    const second = s.ask();
    assert.deepEqual(s.pending().decide, { questions: [0], hypotheses: [] });
    assert.deepEqual(
      s.env.service.recordReviewPanel(
        second,
        [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
        "supervisor",
      ),
      { result: "review_passed" },
    );
    s.card(1, "A long campaign needs a clock the workers cannot stop.", [ids.claims.clock], "high");
    d = s.due();
    assert.equal("why" in d ? d.why : "", `review ${second} waits`);
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

describe("the research review's package (goal 117)", () => {
  test("each question's newest card with the claims it cites and its rubric, the required hypotheses, the items to decide; no lane or model", async (t) => {
    const s = await setup(t, {
      contract: { rubrics: ["How many pages, and when.", "What keeps it honest, and why."] },
    });
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const pkg = s.pending();
    assert.equal(pkg.id, id);
    assert.equal(pkg.kind, "research");
    assert.equal(pkg.topic, researchFixture.topic);
    assert.deepEqual(pkg.decide, { questions: [0, 1], hypotheses: [ids.hypothesis] });
    assert.deepEqual(
      pkg.questions.map((q) => [q.index, q.label, q.text, q.rubric, q.decide, q.card?.version]),
      [
        [0, "Question 1 (index 0)", RESEARCH_QUESTIONS[0], "How many pages, and when.", true, 1],
        [
          1,
          "Question 2 (index 1)",
          RESEARCH_QUESTIONS[1],
          "What keeps it honest, and why.",
          true,
          1,
        ],
      ],
    );
    assert.deepEqual(pkg.questions[0]?.claims, [
      {
        id: ids.claims.verified,
        text: "The first run archived 42 pages.",
        quotes: ["The harness archived 42 pages in its first run."],
        domains: ["127.0.0.1"],
        corroborated: false,
      },
    ]);
    assert.deepEqual(pkg.questions[1]?.card?.gaps, [
      { kind: "evidence", text: "a second, independent site" },
    ]);
    assert.deepEqual(
      pkg.hypotheses.map((h) => [h.id, h.text, h.status, h.decide]),
      [[ids.hypothesis, "Stateless workers make long runs safe.", "author", true]],
    );
    assert.ok(pkg.criteria.some((c) => c.includes(MEASURES_NOTHING)));
    assert.equal(pkg.corpus.verified_claims, 2);
    // Nothing about which lane, trial or model wrote what.
    const text = JSON.stringify(pkg);
    assert.ok(!/lane|trial|model/i.test(text), text);
  });

  test("a large package is shortened to fit: the items that stand lose their claims first, and it says so", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    const insert = s.ledger.db.prepare(
      "insert into claim (id, run, lane, question, text, quotes, verified, problems, created_at) values (?, ?, ?, ?, ?, ?, 1, '[]', ?)",
    );
    const quotes = JSON.stringify(
      Array.from({ length: 5 }, () => ({ source: ids.sources[0], quote: "q".repeat(1500) })),
    );
    const bulk = (q: number, k: number) =>
      Array.from({ length: 50 }, (_, i) => {
        const id = `c-bulk${q}x${k}x${String(i).padStart(3, "0")}`;
        insert.run(
          id,
          RUN,
          "lane-1",
          q,
          `Claim ${"w".repeat(3000)}`,
          quotes,
          new Date().toISOString(),
        );
        return id;
      });
    s.card(0, "The first run archived 42 pages.", [ids.claims.verified, ...bulk(0, 1)]);
    s.card(1, "A long campaign needs a clock.", [ids.claims.clock, ...bulk(1, 1)]);
    s.ranFor(3);
    const full = researchPackage(s.ledger, RUN, s.contract());
    assert.ok(JSON.stringify(full).length <= 200_000);
    assert.match(
      String(full.shortened),
      /^To keep this package short, the claims of the items whose decision stands are not shown, and each item to decide shows its first 26 cited claims, without quotes/,
    );
    const q0 = full.questions[0];
    assert.deepEqual(
      [q0?.claims.length, q0?.claims_not_shown],
      [26, 25],
      "every cited claim is counted",
    );
    assert.deepEqual([q0?.claims[0]?.quotes, q0?.claims[0]?.quotes_not_shown], [[], 1]);
    // Question 1 decided (it stands): its claims go before question 2's.
    const id = s.ask();
    s.env.service.recordReviewPanel(
      id,
      [
        reviewer("reviewer-1", [
          answered(0, [ids.claims.verified], "The first run archived 42 pages."),
          open(1, "a second site"),
        ]),
        reviewer("reviewer-2", [
          answered(0, [ids.claims.verified], "The first run archived 42 pages."),
          open(1, "a second site"),
        ]),
      ],
      "supervisor",
    );
    s.card(1, "A long campaign needs a clock.", [ids.claims.clock, ...bulk(1, 2)]);
    const next = researchPackage(s.ledger, RUN, s.contract());
    assert.ok(JSON.stringify(next).length <= 200_000);
    assert.deepEqual(next.decide.questions, [1]);
    assert.equal(next.questions[0]?.claims.length, 0, "the question that stands shows no claims");
    assert.equal(next.questions[0]?.claims_not_shown, 51);
    assert.equal(next.questions[1]?.claims.length, 51, "the question to decide keeps them all");
    assert.match(
      String(next.shortened),
      /the claims of the items whose decision stands are not shown, and the other claims are shown without their quotes\. When you have the tools/,
    );
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
    assert.deepEqual(await get("/v1/reviews/pending?kinds=goal"), []);
  });
});

describe("code checks the review panel's answers (goal 117)", () => {
  test("a bad citation, a draft, a number not in the cited claims, a missing certainty, gaps or next experiments, a missing verdict and too few reviewers", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const good = goodReviewer("reviewer-1", ids);
    assert.throws(
      () => s.env.service.recordReviewPanel(id, [good], "supervisor"),
      /at least 2 reviewers/,
    );
    const bad = reviewer("reviewer-2", [
      // A number its claims do not have, and a claim that does not exist.
      answered(0, [ids.claims.verified, "c-nope"], "The first run archived 43 pages."),
      // A draft claim, and no certainty.
      { ...answered(1, [ids.claims.draft], "A clock keeps it honest."), certainty: null },
    ]);
    const thin = reviewer("reviewer-3", [
      {
        index: 0,
        verdict: "insufficient",
        certainty: null,
        answer: "42 pages.",
        claims: [ids.claims.verified],
        gaps: "",
        next_experiments: "",
      },
      open(1, " "),
    ]);
    assert.deepEqual(s.env.service.recordReviewPanel(id, [good, bad, thin], "supervisor"), {
      result: "review_passed",
      accepted: true,
    });
    const row = new Reviews(s.ledger).byId(id) as { panel: string };
    const panel = JSON.parse(row.panel) as CheckedReviewer[];
    assert.deepEqual(
      panel[0]?.questions.map((q) => q.valid),
      [true, true],
    );
    const r2 = panel[1] as CheckedReviewer;
    assert.deepEqual(r2.questions[0]?.problems, [
      "no claim c-nope",
      "the number 43 is not in the claims it cites",
    ]);
    assert.deepEqual(r2.questions[1]?.problems, [
      "an answered verdict needs its certainty: high, moderate or low",
      `claim ${ids.claims.draft} is a draft, not verified`,
    ]);
    assert.deepEqual(r2.hypotheses[0]?.problems, [
      "the reviewer gave no verdict on this hypothesis",
    ]);
    const r3 = panel[2] as CheckedReviewer;
    assert.deepEqual(r3.questions[0]?.problems, [
      "an insufficient verdict names what is missing, which only a measurement could settle, in next_experiments",
    ]);
    assert.deepEqual(r3.questions[1]?.problems, ["an open verdict names the evidence gaps"]);
    // Every reviewer's answer per item is kept, as checked.
    const items = s.ledger.db
      .prepare(
        "select reviewer, kind, key, verdict, problems from review_item where review = ? order by id",
      )
      .all(id) as {
      reviewer: string;
      kind: string;
      key: string;
      verdict: string;
      problems: string;
    }[];
    assert.equal(items.length, 9, "3 reviewers × (2 questions + 1 hypothesis)");
    assert.deepEqual(
      items.filter((x) => x.reviewer === "reviewer-2").map((x) => [x.kind, x.key, x.verdict]),
      [
        ["question", "0", "answered"],
        ["question", "1", "answered"],
        ["hypothesis", ids.hypothesis, "none"],
      ],
    );
    // A failed check does not count: reviewer-1's answers alone decide each item.
    const decided = s.ledger.db
      .prepare(
        "select key, decision, certainty, dissent from item_decision where review = ? order by id",
      )
      .all(id) as { key: string; decision: string; certainty: string | null; dissent: string }[];
    assert.deepEqual(
      decided.map((d) => [d.key, d.decision, d.certainty, JSON.parse(d.dissent)]),
      [
        ["0", "answered", "moderate", []],
        ["1", "answered", "high", []],
        [ids.hypothesis, "supported", null, []],
      ],
    );
  });

  test("a verdict needs its claims (supported or refuted) or its why (undecided); a tie of what passes is undecided", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const g = goodReviewer("reviewer-1", ids).research;
    const with_ = (name: string, h: H) => reviewer(name, g.questions, [h]);
    s.env.service.recordReviewPanel(
      id,
      [
        with_("reviewer-1", {
          id: ids.hypothesis,
          verdict: "supported",
          why: "It shows.",
          claims: [ids.claims.verified],
        }),
        with_("reviewer-2", { id: ids.hypothesis, verdict: "supported", why: "yes", claims: [] }),
        with_("reviewer-3", { id: ids.hypothesis, verdict: "undecided", why: " ", claims: [] }),
        with_("reviewer-4", {
          id: ids.hypothesis,
          verdict: "refuted",
          why: "No.",
          claims: [ids.claims.clock],
        }),
      ],
      "supervisor",
    );
    const panel = JSON.parse(
      String((new Reviews(s.ledger).byId(id) as { panel: string }).panel),
    ) as CheckedReviewer[];
    assert.deepEqual(panel[1]?.hypotheses[0]?.problems, ["a supported verdict cites no claim"]);
    assert.deepEqual(panel[2]?.hypotheses[0]?.problems, ["an undecided verdict needs its why"]);
    const d = s.ledger.latestEventBody("item_decided", RUN) as Record<string, unknown>;
    assert.deepEqual(
      [d.kind, d.key, d.decision],
      ["hypothesis", ids.hypothesis, "undecided"],
      "one supported and one refuted passed: a tie",
    );
    assert.deepEqual(
      (d.dissent as { reviewer: string; verdict: string }[]).map((x) => [x.reviewer, x.verdict]),
      [
        ["reviewer-1", "supported"],
        ["reviewer-4", "refuted"],
      ],
    );
  });
});

describe("a passed review closes the run with its decisions (goals 112 and 117)", () => {
  test("hands-off: running trials end first, then the final report holds the decisions, and the run closes", async (t) => {
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
    // Hands-off, said in its event and in the journal, with the decisions.
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
          n.text ===
            `Review ${id} decided 3 items by the majority of 2 reviewers: Question 1 answered, certainty moderate (2 of 2); Question 2 answered, certainty high (2 of 2); Hypothesis ${ids.hypothesis} supported (2 of 2).`,
      ),
      JSON.stringify(notes(s)),
    );
    const panelEvent = s.ledger.latestEventBody("review_panel", RUN) as Record<string, unknown>;
    assert.deepEqual(
      [panelEvent.result, panelEvent.decided, panelEvent.open],
      ["review_passed", 3, []],
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
    // A rig with no final writer: the run closes with the decisions, and says why it has no paper.
    await s.env.service.setAdvisors({ auditor: false, review_panel: 2 }, "supervisor");
    await sch.tick();
    const run = s.env.service.ledger.getRun(RUN);
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", ANSWERED]);
    const final = lastFinal(s);
    assert.match(final, /Research paper: none, no final writer on this rig\./);
    assert.match(
      final,
      new RegExp(
        `## The review panel's decisions\\nThe review panel's decisions give every question an end and every required hypothesis a verdict \\(review ${id}\\)\\. Each decision`,
      ),
    );
    assert.match(
      final,
      new RegExp(
        `### 1\\. ${RESEARCH_QUESTIONS[0]?.replace(/\?/g, "\\?")}\\n\\nDecision: answered, certainty moderate \\(review ${id}, card version 1; 2 of 2 reviewers\\)\\.\\n\\nThe first run archived 42 pages\\.\\n\\nCites: ${ids.claims.verified}\\.`,
      ),
    );
    assert.match(
      final,
      new RegExp(
        `## Hypotheses: the review panel's verdicts\\n- Stateless workers make long runs safe\\. \\(${ids.hypothesis}\\): supported \\(review ${id}; 2 of 2 reviewers\\)\\.`,
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

  test("a run that asks the owner about reviews waits for accept_review; a rejection goes on until a card changes", async (t) => {
    const s = await setup(t, { assign: { ask_owner: { reviews: true } } });
    const ids = s.ids as Ids;
    const sch = scheduler(s);
    s.ranFor(3);
    const pass = [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)];
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
    assert.equal(s.due().due, false, "not asked again while its items' decisions stand");
    // A new card for question 2: asked again about it; the owner accepts, and the run closes.
    s.card(1, "A long campaign needs a clock the workers cannot stop.", [ids.claims.clock], "high");
    const second = s.ask();
    assert.deepEqual(s.pending().decide, { questions: [1], hypotheses: [] });
    s.env.service.recordReviewPanel(second, pass, "supervisor");
    const yes = await s.env.service.applyCommand(
      s.env.sign("accept_review", { run: RUN, review: second, accept: true }),
    );
    assert.ok(yes.status === "applied" && yes.accepted, JSON.stringify(yes));
    // This rig's supervisor has no final writer (goal 112).
    await s.env.service.setAdvisors({ auditor: false, review_panel: 2 }, "supervisor");
    await sch.tick();
    await sch.idle();
    await sch.tick();
    const run = s.env.service.ledger.getRun(RUN);
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", ANSWERED]);
    assert.match(
      lastFinal(s),
      new RegExp(`verdict \\(review ${second}\\), and the owner accepted them\\.`),
    );
  });

  test("open questions' evidence gaps reach the next workers' brief; measurements and failed answers stay out", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    const briefs: string[] = [];
    const sch = scheduler(s, async (spec) => {
      briefs.push(spec.brief);
      return done;
    });
    s.ranFor(3);
    const id = s.ask();
    const g = goodReviewer("reviewer-1", ids).research;
    s.env.service.recordReviewPanel(
      id,
      [
        reviewer(
          "reviewer-1",
          [
            g.questions[0] as Q,
            open(1, "a second, independent site on what keeps campaigns honest"),
          ],
          g.hypotheses,
        ),
        reviewer(
          "reviewer-2",
          [g.questions[0] as Q, open(1, "Benchmark the clock on the target box")],
          g.hypotheses,
        ),
        // An answer that fails code's check: the reviewer's problem, not the workers'.
        reviewer(
          "reviewer-3",
          [g.questions[0] as Q, answered(1, ["c-nope"], "It is 43.")],
          g.hypotheses,
        ),
      ],
      "supervisor",
    );
    const gaps = briefGaps(s.ledger, RUN) ?? "";
    assert.match(gaps, new RegExp(`^# What the review panel found missing \\(review ${id}\\)`));
    assert.match(
      gaps,
      new RegExp(
        `- Question 2 \\(index 1\\) \\(review ${id}\\): a second, independent site on what keeps campaigns honest`,
      ),
    );
    assert.doesNotMatch(gaps, /Benchmark|Question 1 \(index 0\)|c-nope|43/);
    assert.match(
      gaps,
      /\(One more gap asks for a measurement: a next experiment for the report, not work for this run\.\)/,
    );
    // Each reviewer that found an item open or failed the check has a note in the journal.
    assert.deepEqual(
      notes(s)
        .filter((n) => n.by.startsWith("review_panel:"))
        .map((n) => n.by),
      ["review_panel:reviewer-1", "review_panel:reviewer-2", "review_panel:reviewer-3"],
    );
    assert.match(
      notes(s).find((n) => n.by === "review_panel:reviewer-3")?.text ?? "",
      /Question 2: the answered verdict did not pass the check \(no claim c-nope; the number 43 is not in the claims it cites\)/,
    );
    await sch.tick();
    await sch.idle();
    assert.match(briefs.at(-1) ?? "", /# What the review panel found missing/);
    // A new card for question 2: its open decision no longer stands, and the gap leaves the brief.
    s.card(1, "A long campaign needs a clock the workers cannot stop.", [ids.claims.clock]);
    assert.equal(briefGaps(s.ledger, RUN), undefined);
    // The owner closes the run before it ends: its final report says so.
    s.research.report(RUN, "final");
    assert.match(
      lastFinal(s),
      /## The review panel's decisions\nThe run ended before the review panel's decisions gave every question an end: question 2 stayed open\./,
    );
    assert.match(
      lastFinal(s),
      /### 2\. .*\n\nNo decision stands: the review panel did not decide it on its newest card\./,
    );
  });
});
