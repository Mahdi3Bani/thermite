import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { callUsage } from "../../core/usage.ts";
import { startFakeModel } from "../../testing/fake-model.ts";
import { makeJudgeEnv } from "../../testing/judge-env.ts";
import { createHarnessApi } from "../api.ts";
import { LocalRunner } from "../broker/runner.ts";
import type { ModelConfig } from "./model.ts";
import { ModelSource } from "./model-source.ts";
import { plannerHarness, Scheduler } from "./scheduler.ts";

/**
 * The planner with a model of its own runs in the harness its route names (goal 073): Pi,
 * OpenCode, Claude Code or Codex, and its plan is checked as before. Following the workers, it
 * plans as it did: in OpenCode for OpenCode's own models, in Codex when the workers run there,
 * else in Pi. Through OpenCode or Codex, its calls reach its own provider through the harness's
 * proxy, with a credential minted for that route.
 */

const keyed = (o: Partial<ModelConfig> = {}): ModelConfig => ({
  baseUrl: "http://127.0.0.1:9/v1",
  model: "planner-model",
  apiKey: "planner-key",
  contextWindow: 0,
  maxTokens: 0,
  ...o,
});

const PLAN = JSON.stringify({
  new_families: [{ id: "tidy", description: "Small tidy-ups." }],
  assignments: [{ lane: "lane-1", family: "tidy", focus: "tidy the kernel", parent: "champion" }],
  notes: "planned",
});

/** One planning round with the planner's own model and the workers'; which harness was asked. */
async function planWith(
  planner: ModelConfig | undefined,
  workers: ModelConfig,
): Promise<{ asked: string[]; source: string; models: string[] }> {
  const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
  await env.service.applyCommand(env.assign);
  const asked: string[] = [];
  const models: string[] = [];
  const ask = (name: string) => async (m: ModelConfig) => {
    asked.push(name);
    models.push(m.model);
    return PLAN;
  };
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: workers,
    plannerModel: () => planner,
    owner: "planner-harness-test",
    askOpencode: ask("opencode"),
    askClaude: ask("claude-code"),
    askCodex: ask("codex"),
    runTrial: async () => ({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
  });
  await scheduler.tick();
  await scheduler.idle();
  const epoch = env.ledger.db.prepare("select source from epoch where n = 1").get() as {
    source: string;
  };
  return { asked, source: epoch.source, models };
}

describe("the planner's own harness", () => {
  test("which harness a planner call runs in", () => {
    // Its own model: the harness its route names.
    assert.equal(plannerHarness(keyed({ harness: "opencode" }), true), "opencode");
    assert.equal(plannerHarness(keyed({ harness: "codex" }), true), "codex");
    assert.equal(
      plannerHarness(keyed({ api: "claude", harness: "claude-code" }), true),
      "claude-code",
    );
    assert.equal(plannerHarness(keyed(), true), "pi");
    assert.equal(plannerHarness(keyed({ api: "opencode", harness: "opencode" }), true), "opencode");
    // Following the workers: OpenCode only for OpenCode's own models, Codex with them.
    assert.equal(plannerHarness(keyed({ harness: "opencode" }), false), "pi");
    assert.equal(plannerHarness(keyed({ harness: "codex" }), false), "codex");
    assert.equal(
      plannerHarness(keyed({ api: "opencode", harness: "opencode" }), false),
      "opencode",
    );
    assert.equal(
      plannerHarness(keyed({ api: "claude", harness: "claude-code" }), false),
      "claude-code",
    );
    assert.equal(plannerHarness(undefined, false), "pi");
  });

  test("a planner with its own model plans in its own harness, whatever the workers run in", async () => {
    const workersInCodex = keyed({ api: "chatgpt", harness: "codex", model: "workers-model" });
    for (const [harness, extra] of [
      ["opencode", {}],
      ["codex", {}],
      ["claude-code", { api: "claude" as const }],
    ] as const) {
      const r = await planWith(keyed({ harness, ...extra }), workersInCodex);
      assert.deepEqual(r.asked, [harness], harness);
      assert.deepEqual(r.models, ["planner-model"], harness);
      assert.equal(r.source, "planner", `${harness}: the plan was checked and used`);
    }
    // Its own model in Pi: not Codex, though the workers run there (its model is unreachable
    // here, so the fixed rules plan).
    const pi = await planWith(keyed({ harness: "pi" }), workersInCodex);
    assert.deepEqual(pi.asked, []);
    assert.equal(pi.source, "fallback");
  });

  test("a planner that follows the workers plans as before: Codex with them, Pi beside OpenCode on a key", async () => {
    const codex = await planWith(undefined, keyed({ harness: "codex", model: "workers-model" }));
    assert.deepEqual(codex.asked, ["codex"]);
    assert.deepEqual(codex.models, ["workers-model"]);
    const opencode = await planWith(undefined, keyed({ harness: "opencode" }));
    assert.deepEqual(opencode.asked, []);
    const own = await planWith(undefined, keyed({ api: "opencode", harness: "opencode" }));
    assert.deepEqual(own.asked, ["opencode"]);
  });

  test("each planner call's model usage is in the run's records, with its round, its harness and its provider", async () => {
    // Through another harness: what its output reported, handed back with the answer.
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: keyed({ api: "chatgpt", harness: "codex", model: "workers-model", provider: "sub" }),
      owner: "planner-usage-test",
      askCodex: async (_m, _prompt, _signal, o) => {
        o?.usage?.(callUsage({ at: 0, tokensIn: 900, cachedIn: 300, tokensOut: 40 }));
        return PLAN;
      },
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await scheduler.tick();
    await scheduler.idle();
    const calls = env.ledger.eventsAfter(0, 10_000).events.filter((e) => e.kind === "model_call");
    assert.equal(calls.length, 1);
    const b = calls[0]?.body as Record<string, unknown>;
    assert.deepEqual(
      [b.agent, b.round, b.trial, b.harness, b.provider, b.model, b.tokens_in, b.cached_in],
      ["planner", "epoch 1", null, "codex", "sub", "workers-model", 900, 300],
    );
    // In Pi: each model call, as the meter reads it.
    const fake = await startFakeModel(() => ({
      toolCalls: [{ name: "submit_plan", args: JSON.parse(PLAN) }],
      usage: { prompt: 1200, completion: 80 },
    }));
    try {
      const pi = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
      await pi.service.applyCommand(pi.assign);
      const s = new Scheduler({
        service: pi.service,
        runner: new LocalRunner(pi.paths.scratchDir),
        model: keyed({ baseUrl: fake.url, contextWindow: 32_000, maxTokens: 2000 }),
        owner: "planner-usage-test",
        runTrial: async () => ({
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
        }),
      });
      await s.tick();
      await s.idle();
      const piCalls = pi.ledger
        .eventsAfter(0, 10_000)
        .events.filter((e) => e.kind === "model_call")
        .map((e) => e.body as Record<string, unknown>);
      assert.equal(piCalls.length, fake.requests);
      assert.ok(piCalls.length >= 1);
      assert.deepEqual(
        [piCalls[0]?.agent, piCalls[0]?.harness, piCalls[0]?.provider, piCalls[0]?.tokens_in],
        ["planner", "pi", null, 1200],
      );
      assert.equal(piCalls[0]?.cached_in, null, "the fake provider names no cache");
    } finally {
      await fake.close();
    }
  });

  test("the proxy takes a planner's call to the planner's own provider, with its key", async (t: TestContext) => {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({ url: String(req.url), headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = makeJudgeEnv();
    const file = join(mkdtempSync(join(tmpdir(), "thermite-planner-proxy-")), "model-route.json");
    env.service.models = new ModelSource(file, {
      baseUrl: `${base}/workers/v1`,
      model: "workers-model",
      apiKey: "workers-key",
      contextWindow: 0,
      maxTokens: 8192,
    });
    const api = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
    const call = (token: string) =>
      api.request("/v1/model-proxy/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
    const planner = keyed({ baseUrl: `${base}/planner/v1`, apiKey: "planner-key" });
    assert.equal((await call(env.service.mintProxyToken(planner))).status, 200);
    assert.equal((await call(env.service.mintProxyToken())).status, 200);
    assert.deepEqual(
      seen.map((s) => [s.url, s.headers.authorization]),
      [
        ["/planner/v1/chat/completions", "Bearer planner-key"],
        ["/workers/v1/chat/completions", "Bearer workers-key"],
      ],
    );
    // A credential minted for a route OpenCode reaches on its own needs no proxy.
    const own = env.service.mintProxyToken(keyed({ api: "opencode" }));
    assert.equal((await call(own)).status, 404);
    assert.equal(seen.length, 2);
  });
});
