import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import { parseContract, type ResearchContract } from "../../core/contract.ts";
import { startFakeModel } from "../../testing/fake-model.ts";
import { researchFixture } from "../../testing/fixtures.ts";
import { makeHarnessEnv } from "../../testing/harness-env.ts";
import { LocalRunner } from "../broker/runner.ts";
import type { LedgerEvent } from "../ledger.ts";
import { Research } from "../research/research.ts";
import { GAP_LINE } from "../research/shares.ts";
import { Scheduler } from "./scheduler.ts";

/**
 * Goal 117's planning of a research run, at the scale of a long run: six questions, hundreds of
 * verified claims, cards at every certainty, a decided question and a saturated one, and a queue
 * the teachers filled with tasks for one question. Without a planner, the gap-driven plan gives
 * out the work; with one, the model plans each round from the cards, and code checks it.
 */

const RUN = "r-1";
export const QUESTIONS = [
  "Which memory spaces does the architecture expose?",
  "How are warps scheduled?",
  "What limits occupancy?",
  "How does the cache hierarchy behave under contention?",
  "Which instructions changed between generations?",
  "How do the vendor's tools report stalls?",
];
const T0 = Date.parse("2026-10-24T00:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const events = (
  env: {
    service: { ledger: { eventsAfter: (a: number, b: number) => { events: LedgerEvent[] } } };
  },
  kind: string,
) => env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => e.kind === kind);
const body = (e: LedgerEvent | undefined) => (e?.body ?? {}) as Record<string, unknown>;

/**
 * A research run of six questions on two lanes, one trial each a round, with cards, claims, a
 * decided question (index 3) and a saturated one (index 4), and 40 teachers' tasks for question
 * index 0. `planner`, when given, answers each planner call (its tool's arguments); else the
 * planner is off on the rig.
 */
export async function researchScene(
  t: TestContext,
  o: {
    lanes?: number;
    planner?: ((prompt: string, call: number) => unknown) | undefined;
    hypotheses?: string[];
    /** Each trial records a verified claim from a site new to its task's question (default). */
    adds?: boolean;
  } = {},
) {
  const env = makeHarnessEnv("rig-r");
  const lanes = o.lanes ?? 2;
  const parsed = parseContract({
    ...researchFixture,
    questions: QUESTIONS,
    lanes: { count: lanes, trials_per_epoch: 1 },
    ...(o.hypotheses ? { hypotheses: o.hypotheses } : {}),
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", {
      run: RUN,
      contract: parsed.contract,
      contract_sha: parsed.sha,
      imports: [],
    }),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const contract = parsed.contract as ResearchContract;
  const db = env.service.ledger.db;
  // 330 verified claims and 40 drafts.
  let c = 0;
  for (const [q, n] of [
    [0, 120],
    [1, 90],
    [2, 0],
    [3, 60],
    [4, 40],
    [5, 20],
  ] as const)
    for (let i = 0; i < n + (i < 7 ? 0 : 0); i++)
      db.prepare(
        "insert into claim (id, run, lane, question, text, quotes, verified, created_at) values (?, ?, 'lane-1', ?, ?, '[]', 1, ?)",
      ).run(`c-${++c}`, RUN, q, `Claim ${c}.`, at(c % 600));
  for (let i = 0; i < 40; i++)
    db.prepare(
      "insert into claim (id, run, lane, question, text, quotes, verified, created_at) values (?, ?, 'lane-2', ?, ?, '[]', 0, ?)",
    ).run(`c-${++c}`, RUN, i % 6, `Draft ${c}.`, at(c % 600));
  const card = (question: number, certainty: string, evidence: number, measurement = 0) =>
    db
      .prepare(
        "insert into question_card (run, question, version, answer, certainty, claims, gaps, by, created_at) values (?, ?, 1, ?, ?, '[]', ?, 'synth', ?)",
      )
      .run(
        RUN,
        question,
        `The answer to question ${question + 1} so far.`,
        certainty,
        JSON.stringify([
          ...Array.from({ length: evidence }, (_, i) => ({
            kind: "evidence",
            text: `Q${question} gap ${i + 1}: the vendor's documentation of it`,
          })),
          ...Array.from({ length: measurement }, (_, i) => ({
            kind: "measurement",
            text: `Q${question} measure ${i + 1}: time it on the card`,
          })),
        ]),
        at(100),
      );
  card(0, "low", 3, 1);
  card(1, "high", 0);
  card(3, "moderate", 2);
  card(4, "none", 1);
  card(5, "low", 6);
  const review = Number(
    (
      db
        .prepare(
          "insert into review (run, goal, commit_sha, package, requested_at) values (?, 'research', 'corpus:1', '{}', ?) returning id",
        )
        .get(RUN, at(200)) as { id: number }
    ).id,
  );
  db.prepare(
    "insert into item_decision (run, kind, key, review, card_version, decision, certainty, decided_at) values (?, 'question', '3', ?, 1, 'answered', 'moderate', ?)",
  ).run(RUN, review, at(210));
  for (let i = 0; i < 4; i++)
    db.prepare(
      "insert into experiment (id, run, title, added_by, state, question, yield, created_at, updated_at) values (?, ?, 't', 'planner', 'done', 4, ?, ?, ?)",
    ).run(
      `x-sat${i}0000000`,
      RUN,
      JSON.stringify({
        verified_claims: 1,
        by_question: [{ question: 4, verified_claims: 1, new_domain_claims: 0 }],
        no_question: 0,
        new_domains: 0,
        domains: [],
        findings: 0,
        card_changes: 0,
      }),
      at(300 + i),
      at(301 + i),
    );
  // The teachers' 40 tasks, all for question index 0, as one long round of theirs once queued.
  for (let k = 0; k < 2; k++) {
    const r = env.service.advisorQueue({
      run: RUN,
      role: "teacher",
      add: Array.from({ length: 20 }, (_, i) => ({
        title: `Read source ${k * 20 + i + 1} on the architecture's memory spaces`,
        why: "a teacher's lead",
        question: 0,
      })),
      move: [],
    });
    assert.equal(r.added.length, 20, JSON.stringify(r.refused));
  }
  const research = new Research(env.service.ledger, env.service.paths.stateDir, {
    allowPrivate: true,
  });
  const prompts: string[] = [];
  const fake = o.planner
    ? await startFakeModel(({ messages, tools }) => {
        if (!tools.some((x) => x.function.name === "submit_plan")) return { text: "done" };
        const prompt = JSON.stringify(messages);
        prompts.push(prompt);
        return {
          toolCalls: [{ name: "submit_plan", args: o.planner?.(prompt, prompts.length) }],
        };
      })
    : undefined;
  if (fake) t.after(() => fake.close());
  const briefs: string[] = [];
  let fetched = 0;
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.service.paths.scratchDir),
    model: {
      baseUrl: fake?.url ?? "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 64_000,
      maxTokens: 2000,
    },
    owner: "research-test",
    research,
    plannerOn: () => o.planner !== undefined,
    maxConcurrent: lanes,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    runTrial: async () => ({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
    runResearchTrial: async (spec) => {
      briefs.push(spec.brief);
      const x = env.service.queue.forTrial(spec.trialId);
      if (o.adds !== false && typeof x?.question === "number") {
        // A page from a site new to the question, and a verified claim that quotes it.
        const k = ++fetched;
        const now = new Date().toISOString();
        db.prepare(
          `insert into source (id, run, url, final_url, domain, fetched_at, http_status, bytes, sha256, raw_path, text_path, fetched_by)
             values (?, ?, ?, ?, ?, ?, 200, 10, 'x', 'r', 't', ?)`,
        ).run(
          `s-${k}`,
          RUN,
          `https://site-${k}.org/a`,
          `https://site-${k}.org/a`,
          `site-${k}.org`,
          now,
          spec.lane,
        );
        db.prepare(
          "insert into claim (id, run, lane, question, text, quotes, verified, created_at) values (?, ?, ?, ?, ?, ?, 1, ?)",
        ).run(
          `c-t${k}`,
          RUN,
          spec.lane,
          x.question,
          `Found ${k}.`,
          JSON.stringify([{ source: `s-${k}`, quote: "q" }]),
          now,
        );
      }
      return { stopped: "finished", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
    },
  });
  /** One round: planned, its trials run to their end, and the round ended. */
  const round = async () => {
    assert.ok(await scheduler.tick(), "trials started");
    await scheduler.idle();
    await scheduler.tick();
  };
  const q = env.service.queue;
  /** Each task given to a trial, in order: its question, who added it, its title, its details. */
  const given = () =>
    events(env, "experiment_assigned").map((e) => {
      const x = q.get(String(body(e).id));
      return {
        id: x?.id ?? "",
        question: x?.question ?? null,
        by: x?.added_by ?? "",
        title: x?.title ?? "",
        details: x?.details ?? "",
        family: x?.family ?? "",
      };
    });
  return { env, contract, research, scheduler, round, given, prompts, briefs, q, db };
}

describe("the gap-driven plan gives out a research run's work (goal 117)", () => {
  test("ten rounds on two lanes: the owner's task first; then by the cards' gaps, under the ceiling, never a decided or saturated question", async (t) => {
    const s = await researchScene(t);
    // The owner's own task, about the decided question, goes first as before.
    await s.env.service.applyCommand(
      s.env.sign("queue_add", {
        run: RUN,
        title: "Question 4 (index 3): read the vendor's errata",
        position: "top",
      }),
    );
    for (let r = 0; r < 10; r++) await s.round();
    const g = s.given();
    assert.equal(g.length, 20);
    assert.deepEqual(
      [g[0]?.by, g[0]?.question],
      ["owner", 3],
      "the owner's task first, whatever its question",
    );
    const rest = g.slice(1);
    // Never a decided or a saturated question but the owner's.
    assert.ok(
      rest.every((x) => x.question !== 3 && x.question !== 4),
      JSON.stringify(rest.map((x) => x.question)),
    );
    // The ceiling: the teachers' 40 tasks for index 0 never take more than half of 4 in a row.
    const order = g.map((x) => x.question);
    for (let i = 0; i + 4 <= order.length; i++) {
      const w = order.slice(i, i + 4);
      for (const v of new Set(w))
        assert.ok(w.filter((x) => x === v).length <= 2, `tasks ${i}..${i + 3}: ${w.join(",")}`);
    }
    // Every question with open gaps or no card got work; the teachers' tasks served index 0.
    for (const v of [0, 2, 5]) assert.ok(order.includes(v), `question index ${v}`);
    assert.ok(rest.filter((x) => x.question === 0).every((x) => x.by === "teacher"));
    assert.ok(s.q.queued(RUN).filter((x) => x.added_by === "teacher").length >= 30, "most wait");
    // The plan's own tasks name their question in the title and their gap in the details.
    const own = rest.filter((x) => x.by === "planner");
    assert.ok(own.length >= 8);
    for (const x of own) {
      assert.match(
        x.title,
        new RegExp(`^Question ${Number(x.question) + 1} \\(index ${x.question}\\): `),
      );
      assert.ok(x.details.startsWith(GAP_LINE), x.details);
    }
    assert.ok(
      own.some((x) => x.question === 2 && x.details.includes("No answer card yet")),
      "the question with no card",
    );
    assert.ok(
      own.some((x) => x.question === 5 && x.details.includes("Q5 gap ")),
      "a card's own gap",
    );
    // The round's record: the code plan, with where each question stands.
    const e = body(events(s.env, "epoch_started")[0]);
    assert.equal(e.plan, "research");
    assert.match(
      String(e.notes),
      /^research plan, gap-driven: Question 1 \(index 0\): certainty low, 3 evidence gaps; Question 2 \(index 1\): certainty high, 0 evidence gaps; Question 3 \(index 2\): no card; Question 4 \(index 3\): certainty moderate, 2 evidence gaps, decided answered; Question 5 \(index 4\): certainty none, 1 evidence gap, saturated; /,
    );
    // A worker's brief has its task's gap.
    assert.match(
      String(s.briefs.find((b) => b.includes("Your focus: Question 6 (index 5)"))),
      /Your focus: Question 6 \(index 5\): [^\n]+\nEvidence gap to close: Q5 gap \d: the vendor's documentation of it/,
    );
    // What each task added is kept with it: these found one claim from a new site each.
    const done = s.q.tried(RUN, 100).filter((x) => x.added_by === "planner" && x.trial && x.yield);
    assert.ok(done.length >= 8);
    for (const x of done) {
      const y = JSON.parse(String(x.yield)) as {
        by_question: { question: number; new_domain_claims: number }[];
      };
      assert.deepEqual(
        y.by_question.map((b) => [b.question, b.new_domain_claims]),
        [[x.question, 1]],
      );
    }
  });

  test("a question whose last four tasks added nothing saturates and gets no more; when every open question is saturated, they are weighed again", async (t) => {
    const s = await researchScene(t, { adds: false });
    for (let r = 0; r < 14; r++) await s.round();
    // Each round's record says where each question stands; the first round in which every
    // question still open is saturated weighs them all again.
    const rounds = events(s.env, "epoch_started").map((e) => String(body(e).notes));
    const saturated = (n: string, q: number) =>
      new RegExp(`Question ${q + 1} \\(index ${q}\\): [^;]*saturated`).test(n);
    const all = rounds.findIndex((n) => [0, 1, 2, 5].every((q) => saturated(n, q)));
    assert.ok(all > 0, rounds.join("\n"));
    // Tasks given in the rounds before it: each question's tasks stop once it is saturated.
    const before = events(s.env, "planner_handout")
      .filter((e) => Number(body(e).round) <= all)
      .flatMap((e) =>
        (body(e).assignments as { experiment: string }[]).map(
          (a) => s.q.get(a.experiment)?.question,
        ),
      );
    for (const q of [2, 5, 0]) {
      const n = before.filter((x) => x === q).length;
      assert.ok(
        n >= 4 && n <= 5,
        `question index ${q}: ${n} tasks before every open question saturated`,
      );
      const r = rounds.findIndex((x) => saturated(x, q));
      const after = events(s.env, "planner_handout")
        .filter((e) => Number(body(e).round) > r + 1 && Number(body(e).round) <= all)
        .flatMap((e) =>
          (body(e).assignments as { experiment: string }[]).map(
            (a) => s.q.get(a.experiment)?.question,
          ),
        );
      assert.ok(!after.includes(q), `no task for index ${q} once it saturated`);
    }
    assert.ok(
      before.includes(1),
      "the question with no evidence gap gets work once the others saturate",
    );
    // Then all are weighed again: the next rounds give out work, never to the decided question.
    const later = events(s.env, "planner_handout")
      .filter((e) => Number(body(e).round) > all + 1)
      .flatMap((e) =>
        (body(e).assignments as { experiment: string }[]).map(
          (a) => s.q.get(a.experiment)?.question,
        ),
      );
    assert.ok(later.length > 0);
    assert.ok(!s.given().some((x) => x.question === 3), "never the decided question");
  });
});
