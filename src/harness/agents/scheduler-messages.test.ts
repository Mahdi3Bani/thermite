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
import { Research } from "../research/research.ts";
import { Scheduler } from "./scheduler.ts";

type Env = ReturnType<typeof makeJudgeEnv>;

async function command(env: Env, kind: CommandKind, payload: unknown) {
  const out = await env.service.applyCommand(
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind,
        issued_by: "owner",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload,
      },
      env.keys.privateKeyPem,
    ),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
}

const reads = (env: { service: { ledger: Env["ledger"] } }) =>
  env.service.ledger
    .eventsAfter(0, 5000)
    .events.filter((e) => e.kind === "agent_message_read")
    .map((e) => {
      const b = e.body as { message: number; by: string };
      return `${b.message}:${b.by}`;
    });

/** A hill climb with one lane, a planner that records its prompt and trials that record their brief. */
async function setup(t: TestContext, o: { plannerOn?: () => boolean } = {}) {
  const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
  await env.service.applyCommand(env.assign);
  const planned: string[] = [];
  const fake = await startFakeModel(({ messages, tools }) => {
    if (!tools.some((t) => t.function.name === "submit_plan")) return { text: "done" };
    planned.push(JSON.stringify(messages));
    return {
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            new_families: [{ id: "speed", description: "make the sum faster" }],
            assignments: [
              { lane: "lane-1", family: "speed", focus: "go faster", parent: "champion" },
            ],
          },
        },
      ],
    };
  });
  t.after(() => fake.close());
  const briefs: string[] = [];
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
    owner: "scheduler-test",
    plannerOn: o.plannerOn,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    runTrial: async (spec) => {
      briefs.push(spec.brief);
      return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
    },
  });
  /** One epoch: planned, its one trial run to the end. */
  const epoch = async () => {
    assert.ok(await scheduler.tick(), "a trial started");
    await scheduler.idle();
    await scheduler.tick(); // the epoch ends
  };
  return { env, planned, briefs, epoch };
}

describe("the owner's messages in plans and briefs", () => {
  test("the planner reads everyone-working and planner messages once; a brief carries messages in force every time and the rest once", async (t) => {
    const { env, planned, briefs, epoch } = await setup(t);
    await command(env, "message_agent", {
      run: "js-1",
      to: "all",
      text: "keep every change small",
      keep: true,
    });
    await command(env, "message_agent", { run: "js-1", to: "lane-1", text: "try unrolling" });
    await command(env, "message_agent", { run: "js-1", to: "planner", text: "spread wider" });
    await epoch();
    assert.match(
      String(planned[0]),
      /\\"owner_messages\\":\[\{\\"id\\":1,\\"text\\":\\"keep every change small\\"\},\{\\"id\\":3,\\"text\\":\\"spread wider\\"\}\]/,
    );
    assert.doesNotMatch(
      String(planned[0]),
      /try unrolling/,
      "a lane's message is not the planner's",
    );
    assert.match(
      String(briefs[0]),
      /# Messages from the campaign's owner, in force\n- keep every change small\n\n# Messages from the campaign's owner\n- try unrolling$/,
    );
    await epoch();
    assert.doesNotMatch(String(planned[1]), /\\"owner_messages\\":/, "each read once");
    assert.match(
      String(briefs[1]),
      /# Messages from the campaign's owner, in force\n- keep every change small$/,
    );
    await command(env, "unkeep_message", { run: "js-1", message: 1 });
    await epoch();
    assert.doesNotMatch(String(briefs[2]), /Messages from the campaign's owner/);
    // The first read by each reader is an event; later in-force briefs are not.
    assert.deepEqual(reads(env), ["1:planner", "3:planner", "1:lane-1", "2:lane-1"]);
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from agent_message_read where message = 1").get()
        ?.n,
      3,
      "the planner, then lane-1's first and second trials",
    );
  });

  test("with the planner off, everyone-working messages wait for it", async (t) => {
    let on = true;
    const { env, planned, epoch } = await setup(t, { plannerOn: () => on });
    await command(env, "message_agent", { run: "js-1", to: "all", text: "careful now" });
    on = false;
    await epoch();
    assert.equal(planned.length, 0, "the fixed plan");
    assert.deepEqual(reads(env), ["1:lane-1"]);
    assert.deepEqual(
      env.service.messages.waitingForPlanner("js-1").map((m) => m.id),
      [1],
    );
  });
});

describe("a research run's rounds", () => {
  test("its epoch says it was planned by the research plan, and its trials read everyone-working messages", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract({
      ...researchFixture,
      lanes: { count: 1, trials_per_epoch: 1 },
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    await env.service.applyCommand(
      env.sign("message_agent", { run: "r-1", to: "all", text: "prefer primary sources" }),
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
    const started = env.service.ledger
      .eventsAfter(0, 5000)
      .events.find((e) => e.kind === "epoch_started")?.body as Record<string, unknown>;
    assert.equal(started.plan, "research");
    assert.equal(started.notes, "research plan (deterministic in v1)");
    assert.equal(started.source, "fallback");
    assert.match(
      String(briefs[0]),
      /# Messages from the campaign's owner\n- prefer primary sources$/,
    );
    assert.deepEqual(reads(env), ["1:lane-1"]);
  });
});
