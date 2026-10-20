import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, type TestContext, test } from "node:test";
import { type CommandKind, signEnvelope } from "../../core/commands.ts";
import { parseContract } from "../../core/contract.ts";
import { startFakeModel } from "../../testing/fake-model.ts";
import { researchFixture } from "../../testing/fixtures.ts";
import { makeHarnessEnv } from "../../testing/harness-env.ts";
import { makeJudgeEnv } from "../../testing/judge-env.ts";
import { LocalRunner } from "../broker/runner.ts";
import type { LedgerEvent } from "../ledger.ts";
import { Research } from "../research/research.ts";
import { Scheduler } from "./scheduler.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";

type Env = ReturnType<typeof makeJudgeEnv>;
const RUN = "js-1";

async function command(env: Env, kind: CommandKind, payload: unknown) {
  const out = await env.service.applyCommand(
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind,
        issued_by: "owner:ui",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload,
      },
      env.keys.privateKeyPem,
    ),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  return (out as { result: Record<string, unknown> }).result;
}

const events = (env: { service: { ledger: Env["ledger"] } }, kind: string): LedgerEvent[] =>
  env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => e.kind === kind);
const body = (e: LedgerEvent | undefined) => (e?.body ?? {}) as Record<string, unknown>;

/**
 * A hill climb with `lanes` lanes, one trial each per round, run side by side. The planner is
 * off unless `planner` answers (its answer for each call); trials record their brief and end
 * without a submission, or wait to be stopped.
 */
async function setup(
  t: TestContext,
  o: {
    lanes?: number;
    perEpoch?: number;
    planner?: ((prompt: string, call: number) => unknown) | undefined;
    trial?: ((spec: TrialSpec, signal: AbortSignal) => Promise<TrialResult>) | undefined;
  } = {},
) {
  const env = makeJudgeEnv({ lanes: { count: o.lanes ?? 2, trials_per_epoch: o.perEpoch ?? 1 } });
  await env.service.applyCommand(env.assign);
  const prompts: string[] = [];
  const fake = await startFakeModel(({ messages, tools }) => {
    if (!tools.some((x) => x.function.name === "submit_plan")) return { text: "done" };
    const prompt = JSON.stringify(messages);
    prompts.push(prompt);
    return { toolCalls: [{ name: "submit_plan", args: o.planner?.(prompt, prompts.length) }] };
  });
  t.after(() => fake.close());
  const briefs: Record<string, string[]> = {};
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
    owner: "scheduler-test",
    plannerOn: () => o.planner !== undefined,
    maxConcurrent: o.lanes ?? 2,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    runTrial:
      o.trial ??
      (async (spec) => {
        briefs[spec.lane] = [...(briefs[spec.lane] ?? []), spec.brief];
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      }),
  });
  /** One round: planned, its trials run to their end, and the round ended. */
  const round = async () => {
    assert.ok(await scheduler.tick(), "trials started");
    await scheduler.idle();
    await scheduler.tick();
  };
  const add = async (title: string, more: Record<string, unknown> = {}) =>
    String((await command(env, "queue_add", { run: RUN, title, ...more })).experiment);
  /** Each lane's experiment, by title, as the assignments recorded it. */
  const given = () =>
    events(env, "experiment_assigned").map((e) => {
      const b = body(e);
      return `${b.lane}:${env.service.queue.get(String(b.id))?.title}`;
    });
  return { env, scheduler, prompts, briefs, round, add, given, q: env.service.queue };
}

describe("the planner as the queue's coordinator", () => {
  test("without a planner, lanes take queued experiments in order; the fixed plan only fills an empty queue", async (t) => {
    const s = await setup(t);
    await s.add("first", { why: "it is cheapest", details: "start with the inner loop" });
    await s.add("second");
    await s.add("third");
    await s.round();
    assert.deepEqual(s.given(), ["lane-1:first", "lane-2:second"]);
    // The brief carries the experiment's title, details and why as its focus.
    assert.match(
      String(s.briefs["lane-1"]?.[0]),
      /Focus: first\nDetails: start with the inner loop\nWhy it is worth trying: it is cheapest/,
    );
    const h = body(events(s.env, "planner_handout")[0]);
    assert.equal(h.round, 1);
    assert.deepEqual(
      (h.assignments as { lane: string }[]).map((a) => a.lane),
      ["lane-1", "lane-2"],
    );
    assert.match(String(h.notes), /lanes took queued experiments in order/);
    // Each trial's end finishes its experiment.
    assert.deepEqual(
      events(s.env, "experiment_finished").map((e) => body(e).result),
      ["no_attempt", "no_attempt"],
    );
    await s.round();
    // The queue had one left: lane-2 got an experiment the fixed plan added, by the planner.
    assert.deepEqual(s.given().slice(2), ["lane-1:third", `lane-2:${s.q.all(RUN).at(-1)?.title}`]);
    const filled = s.q.all(RUN).at(-1);
    assert.equal(filled?.added_by, "planner");
    assert.match(String(filled?.why), /the queue was empty/);
    assert.equal(s.q.queued(RUN).length, 0);
    // Every experiment assigned went to one trial only.
    const ids = events(s.env, "experiment_assigned").map((e) => body(e).id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("the fixed rules skip AVOID families and put MANDATE families first", async (t) => {
    const s = await setup(t);
    await s.add("unroll it", { family: "unroll" });
    await s.add("tile it", { family: "Tiling" });
    await s.add("vectorize it", { family: "simd" });
    await command(s.env, "redirect", {
      run: RUN,
      directives: [
        { kind: "avoid", family: "unroll", rationale: "flat twice", citations: [] },
        {
          kind: "mandate",
          family: "simd",
          rationale: "the target has wide vectors",
          citations: [],
        },
      ],
    });
    await s.round();
    assert.deepEqual(s.given(), ["lane-1:vectorize it", "lane-2:tile it"]);
    assert.equal(s.q.queued(RUN)[0]?.title, "unroll it", "avoided, never given out");
    const why = body(events(s.env, "experiment_assigned")[0]).why;
    assert.match(String(why), /MANDATE rule \(\d+\) names its direction, simd/);
    // A family's words map to the registry's direction: "Tiling" is tiling.
    const trials = s.env.ledger.db.prepare("select lane, family from trial order by lane").all();
    assert.deepEqual(
      trials.map((r) => r.family),
      ["simd", "tiling"],
    );
  });

  test("a lane prefers the next experiment in its last direction, so it builds on what it learned", async (t) => {
    const s = await setup(t);
    await s.add("loops one", { family: "loops" });
    await s.add("simd one", { family: "simd" });
    await s.round();
    await s.add("simd two", { family: "simd" });
    await s.add("loops two", { family: "loops" });
    await s.round();
    assert.deepEqual(s.given(), [
      "lane-1:loops one",
      "lane-2:simd one",
      "lane-1:loops two",
      "lane-2:simd two",
    ]);
    assert.match(
      String(body(events(s.env, "experiment_assigned")[2]).why),
      /lane-1's last direction \(loops\)/,
    );
  });

  test("a lane's next trial in the round takes the next queued experiment, as a hand-out of its own", async (t) => {
    const s = await setup(t, { lanes: 1, perEpoch: 2 });
    await s.add("one");
    await s.add("two");
    assert.ok(await s.scheduler.tick());
    await s.scheduler.idle();
    assert.ok(await s.scheduler.tick(), "the second trial of the round");
    await s.scheduler.idle();
    assert.deepEqual(s.given(), ["lane-1:one", "lane-1:two"]);
    const h = events(s.env, "planner_handout");
    assert.equal(h.length, 2);
    assert.match(String(body(h[1]).notes), /lane-1's trial 2 of 2 in round 1/);
  });

  test("no two lanes get the same experiment: such a plan is refused, and lanes take the queue in order", async (t) => {
    let x1 = "";
    const s = await setup(t, {
      planner: () => ({
        assignments: [
          { lane: "lane-1", experiment: x1, why: "first" },
          { lane: "lane-2", experiment: x1, why: "also first" },
        ],
      }),
    });
    x1 = await s.add("first");
    await s.add("second");
    await s.round();
    assert.deepEqual(s.given(), ["lane-1:first", "lane-2:second"]);
    const epoch = body(events(s.env, "epoch_started")[0]);
    assert.equal(epoch.source, "fallback");
    assert.match(JSON.stringify(epoch.refused), /given to another lane too/);
    assert.match(String(body(events(s.env, "planner_handout")[0]).notes), /refused/);
  });

  test("the planner's queue changes, hand-out and a rule the owner's message asked for", async (t) => {
    const ids: Record<string, string> = {};
    const s = await setup(t, {
      planner: () => ({
        accept: [{ id: ids.idea, why: "cheap to check", position: "top" }],
        drop: [{ id: ids.stale, why: "the champion already does it" }],
        add: [{ ref: "n1", title: "wider loads", family: "memory", why: "reads dominate" }],
        move: [{ id: ids.later, position: "end", why: "after the loads" }],
        rules: [
          {
            kind: "avoid",
            match: "anything that touches the timer",
            rationale: "the owner asked",
            from_message: 1,
          },
        ],
        assignments: [
          { lane: "lane-1", experiment: ids.idea, why: "lane-1 proposed it" },
          { lane: "lane-2", experiment: "n1", parent: "champion", why: "fresh direction" },
        ],
        notes: "loads first",
      }),
    });
    ids.later = await s.add("later");
    ids.stale = await s.add("stale");
    ids.idea = s.q.add(RUN, { title: "lane idea", by: "lane-1", state: "proposed" }, "lane-1").id;
    await command(s.env, "message_agent", {
      run: RUN,
      to: "planner",
      text: "never touch the timer code",
    });
    await s.round();
    // What the planner read: the queue, and the owner's message with its id.
    assert.match(String(s.prompts[0]), /\\"up_next\\":\[\{\\"by\\":\\"owner\\",\\"id\\":\\"x-/);
    assert.match(String(s.prompts[0]), /\\"proposed\\":\[\{\\"by\\":\\"lane-1\\"/);
    assert.match(
      String(s.prompts[0]),
      /\{\\"id\\":1,\\"text\\":\\"never touch the timer code\\"\}/,
    );
    // Its changes, each by the planner, with why.
    const by = (kind: string) => events(s.env, kind).filter((e) => e.actor === "planner");
    assert.deepEqual(body(by("experiment_accepted")[0]), {
      id: ids.idea,
      by: "planner",
      position: "top",
      why: "cheap to check",
    });
    assert.deepEqual(body(by("experiment_dropped")[0]), {
      id: ids.stale,
      by: "planner",
      why: "the champion already does it",
    });
    const added = by("experiment_added").find((e) => body(e).title === "wider loads");
    assert.equal(body(added).by, "planner");
    assert.deepEqual(body(by("experiment_moved")[0]), {
      id: ids.later,
      by: "planner",
      position: "end",
      why: "after the loads",
    });
    assert.deepEqual(s.given(), ["lane-1:lane idea", "lane-2:wider loads"]);
    const h = body(events(s.env, "planner_handout")[0]);
    assert.deepEqual(h.assignments, [
      { lane: "lane-1", experiment: ids.idea, why: "lane-1 proposed it" },
      { lane: "lane-2", experiment: body(added).id, why: "fresh direction" },
    ]);
    assert.equal(h.notes, "loads first");
    // The rule: a directive by the planner that records the owner's message it came from.
    const rule = events(s.env, "directive").find((e) => e.actor === "planner");
    assert.deepEqual(body(rule).body, {
      kind: "avoid",
      match: "anything that touches the timer",
      rationale: "the owner asked",
      citations: [],
      from_message: 1,
    });
    assert.equal(body(events(s.env, "epoch_started")[0]).source, "planner");
    // The message was read by the planner that answered it.
    assert.deepEqual(
      events(s.env, "agent_message_read").map((e) => body(e).by),
      ["planner"],
    );
  });

  test("a rule from a message the planner was not given, or a dropped experiment given out, is refused", async (t) => {
    let x = "";
    const s = await setup(t, {
      planner: (_p, call) =>
        call === 1
          ? {
              rules: [{ kind: "avoid", family: "unroll", rationale: "r", from_message: 9 }],
              assignments: [
                { lane: "lane-1", experiment: x, why: "w" },
                { lane: "lane-2", title: "inline one", family: "misc", why: "w" },
              ],
            }
          : {
              drop: [{ id: x, why: "no" }],
              assignments: [
                { lane: "lane-1", experiment: x, why: "w" },
                { lane: "lane-2", title: "inline one", family: "misc", why: "w" },
              ],
            },
    });
    x = await s.add("only");
    await s.round();
    const refused = JSON.stringify(body(events(s.env, "epoch_started")[0]).refused);
    assert.match(refused, /message 9 is not one of the owner's messages given to you/);
    assert.match(refused, /is dropped in this same answer/);
    assert.equal(events(s.env, "directive").length, 0);
  });

  test("rules given by match words reach the planner's prompt", async (t) => {
    const s = await setup(t, {
      planner: () => ({
        assignments: [
          { lane: "lane-1", title: "a", focus: "something new", family: "misc", why: "w" },
          { lane: "lane-2", title: "b", focus: "something else", family: "misc", why: "w" },
        ],
      }),
    });
    await command(s.env, "redirect", {
      run: RUN,
      directives: [
        {
          kind: "try",
          match: "anything with vector loads",
          rationale: "the guide says so",
          citations: [],
        },
      ],
    });
    await s.round();
    assert.match(String(s.prompts[0]), /\\"match\\":\\"anything with vector loads\\"/);
    assert.match(String(s.prompts[0]), /A directive with match words names a direction/);
  });

  test("an interrupted trial's experiment goes back to the top of the queue", async (t) => {
    const s = await setup(t, {
      lanes: 1,
      trial: (_spec, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () =>
            resolve({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
          ),
        ),
    });
    const x = await s.add("long one", { why: "big win if it works" });
    await s.add("next one");
    assert.ok(await s.scheduler.tick());
    await command(s.env, "pause_run", { run: RUN, reason: "test" });
    await s.scheduler.idle();
    assert.equal(s.q.get(x)?.state, "done");
    assert.equal(s.q.get(x)?.result, "interrupted");
    const again = s.q.queued(RUN)[0];
    assert.equal(again?.title, "long one");
    assert.equal(again?.added_by, "owner");
    assert.match(String(again?.why), /tried again: its trial on lane-1 was interrupted \(x-/);
  });

  test("after a restart, an experiment whose trial a dead controller left open goes back to the queue", async (t) => {
    const s = await setup(t, { lanes: 1 });
    const x = await s.add("half done");
    s.scheduler.registry.startTrial({
      id: "t-dead00000000000",
      run: RUN,
      lane: "lane-1",
      epoch: 1,
      family: "general",
      parent: "p",
    });
    s.q.assign(RUN, x, { lane: "lane-1", trial: "t-dead00000000000", by: "planner" }, "planner");
    new Scheduler({
      service: s.env.service,
      runner: new LocalRunner(s.env.paths.scratchDir),
      owner: "restarted",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    assert.equal(s.q.get(x)?.result, "interrupted");
    assert.deepEqual(
      s.q.queued(RUN).map((e) => e.title),
      ["half done"],
    );
  });
});

describe("research runs use the queue", () => {
  test("the research plan fills the queue with tasks; rounds take them in order", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract({ ...researchFixture, lanes: { count: 2, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    // The owner's own task goes first.
    await env.service.applyCommand(
      env.sign("queue_add", {
        run: "r-1",
        title: "Check the vendor's own benchmark",
        family: "primary",
        details: "Question 0",
      }),
    );
    const research = new Research(env.service.ledger, env.service.paths.stateDir, {
      allowPrivate: true,
    });
    const briefs: string[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "research-test",
      research,
      maxConcurrent: 2,
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      runResearchTrial: async (spec) => {
        briefs.push(spec.brief);
        return { stopped: "finished", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    const q = env.service.queue;
    const tasks = q.all("r-1");
    assert.equal(tasks.length, 2, "the plan added one task: the owner's was there");
    const planned = tasks.find((x) => x.added_by === "planner");
    assert.ok(planned);
    assert.ok(["explore", "primary", "contradict", "consolidate"].includes(planned.family));
    assert.match(planned.details, /^Question \d+: /);
    assert.deepEqual(
      events(env, "experiment_assigned").map((e) => body(e).lane),
      ["lane-1", "lane-2"],
    );
    assert.equal(body(events(env, "experiment_assigned")[0]).id, tasks[0]?.id, "the owner's first");
    assert.match(String(briefs[0]), /Your focus: Check the vendor's own benchmark\nQuestion 0/);
    assert.deepEqual(
      events(env, "experiment_finished").map((e) => body(e).result),
      ["finished", "finished"],
    );
    const h = body(events(env, "planner_handout")[0]);
    assert.equal((h.assignments as unknown[]).length, 2);
  });
});
