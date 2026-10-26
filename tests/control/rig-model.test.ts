import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createControlApi } from "../../src/control/api.ts";
import {
  advisorsFileOf,
  agentModelsOf,
  rigModelShapeRefusal,
} from "../../src/control/rig-model.ts";
import { SecretBox } from "../../src/control/secrets.ts";
import { ControlStore } from "../../src/control/store.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";

/**
 * Each agent's model over REST and MCP (goal 029): POST /v1/rigs/<rig>/model and set_rig_model
 * set one agent's model, or clear it, as its row on Edit rig does; GET /v1/rigs/<rig>/model and
 * rig_models read them all. The rig takes the planner's model with its model route and the
 * advisors' with its advisor routes.
 */

const TOKENS = {
  admin: "admin-token-abcdef",
  operator: "operator-token-abcdef",
  read: "read-token-abcdef",
  rigs: { "rig-a": "rig-token-abcdef" },
};

/**
 * Control with rig-a reporting. Providers: "lab" (an OpenAI-compatible key) with wide-model and
 * strong-model, "sub" (a signed-in ChatGPT subscription) with gpt-sol, OpenCode's own "zen", and
 * "claude-sub" (a Claude subscription) with opus-5.5.
 */
async function stack() {
  const secrets = SecretBox.ephemeral();
  const store = new ControlStore(":memory:");
  const api = createControlApi(store, TOKENS, generateSigningKeys().privateKeyPem, {
    staleAfterMs: 600_000,
    secrets,
  });
  store.ingest({
    rig: "rig-a",
    ledger_id: "ledger-rig-a",
    cursor: 0,
    next: 0,
    generated_at: new Date().toISOString(),
    events: [],
    summary: {},
  });
  store.putProvider({
    name: "lab",
    type: "openai",
    base_url: "https://models.example.com/v1",
    key: { sealed: secrets.seal("lab-key-for-tests"), hint: "…ests" },
  });
  store.setProviderModels("lab", [
    { id: "wide-model", context_window: 204_800 },
    { id: "strong-model", context_window: 400_000 },
  ]);
  // A ChatGPT login whose access token lasts another hour: control sends it as it is.
  const login = {
    access: "chatgpt-access-for-tests",
    refresh: "chatgpt-refresh-for-tests",
    expires: Date.now() + 3_600_000,
    earliest_refresh: null,
    client_id: "client-for-tests",
    host_id: "host-for-tests",
  };
  store.putProvider({
    name: "sub",
    type: "chatgpt",
    base_url: "",
    key: { sealed: secrets.seal(JSON.stringify(login)), hint: "ChatGPT" },
  });
  store.setProviderModels("sub", [{ id: "gpt-sol", context_window: 272_000 }]);
  store.putProvider({ name: "zen", type: "opencode", base_url: "https://opencode.ai/zen/v1" });
  store.setProviderModels("zen", [{ id: "big-pickle" }]);
  store.putProvider({
    name: "claude-sub",
    type: "claude",
    base_url: "",
    key: { sealed: secrets.seal("claude-subscription-for-tests"), hint: "…ests" },
  });
  store.setProviderModels("claude-sub", [{ id: "opus-5.5", context_window: 200_000 }]);
  const as =
    (token: string) =>
    (method: "GET" | "POST", body?: Record<string, unknown>, rig = "rig-a") =>
      api.request(`/v1/rigs/${rig}/model`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
  const owner = as(TOKENS.admin);
  const give = async (body: Record<string, unknown>) => {
    const r = await owner("POST", body);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const asRig = async (path: string) =>
    (await (
      await api.request(path, { headers: { authorization: "Bearer rig-token-abcdef" } })
    ).json()) as Record<string, Record<string, unknown> | null>;
  return { store, api, as, owner, give, asRig };
}

async function connect(api: ReturnType<typeof createControlApi>, token: string) {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
  };
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: fetchImpl }),
  );
  return client;
}

const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;

describe("each agent's model over REST and MCP", () => {
  test("a request's fields for its agent", () => {
    assert.equal(rigModelShapeRefusal({ provider: "lab", model: "m" }), undefined);
    assert.equal(rigModelShapeRefusal({ agent: "auditor", clear: true }), undefined);
    assert.equal(
      rigModelShapeRefusal({ agent: "auditor" }),
      "Give a provider and a model, or clear: true.",
    );
    assert.equal(
      rigModelShapeRefusal({ clear: true, provider: "lab", model: "m" }),
      "Give clear alone, or a provider and a model.",
    );
    assert.equal(
      rigModelShapeRefusal({ clear: true, effort: "high" }),
      "Give clear alone, or a provider and a model.",
    );
    // Every agent takes a harness (goal 073).
    assert.equal(
      rigModelShapeRefusal({ agent: "planner", provider: "lab", model: "m", harness: "opencode" }),
      undefined,
    );
    assert.equal(
      rigModelShapeRefusal({ clear: true, agent: "auditor", harness: "codex" }),
      "Give clear alone, or a provider and a model.",
    );
    // Every agent takes its own cap and compaction point (goal 070).
    assert.equal(
      rigModelShapeRefusal({
        agent: "review_panel",
        provider: "lab",
        model: "m",
        contextWindow: 8192,
        compactAt: 70,
      }),
      undefined,
    );
    assert.equal(
      rigModelShapeRefusal({ agent: "planner", provider: "lab", model: "m", compactAt: 99 }),
      "The compaction point is a whole percent of the context window, from 50 to 95.",
    );
    assert.equal(
      rigModelShapeRefusal({ provider: "lab", model: "m", harness: "codex", contextWindow: 8192 }),
      undefined,
    );
  });

  test("REST: each agent set and cleared, the others kept, the routes the rig takes", async () => {
    const s = await stack();
    const workers = await s.give({ provider: "lab", model: "wide-model", effort: "low" });
    assert.equal(workers.status, 200);
    assert.equal(workers.body.agent, "workers");
    assert.equal(workers.body.context_window, 204_800);

    const kinds = [
      ["planner", "lab", "strong-model", 400_000],
      ["teachers", "sub", "gpt-sol", 272_000],
      ["auditor", "sub", "gpt-sol", 272_000],
      ["review_panel", "lab", "wide-model", 204_800],
    ] as const;
    for (const [agent, provider, model, window] of kinds) {
      const r = await s.give({ agent, provider, model, effort: "high" });
      assert.equal(r.status, 200, agent);
      assert.deepEqual(
        { agent: r.body.agent, model: r.body.model, context_window: r.body.context_window },
        { agent, model, context_window: window },
      );
      // Edit rig's words for the row.
      assert.equal(
        r.body.said,
        `Control sent a model for the ${agent.replace("_", " ")} to rig-a. The rig takes the change in less than one minute.`,
      );
    }
    // The teachers' merged by model, alone: the first teacher keeps its model.
    const merged = await s.give({
      agent: "teachers",
      merged_by: { provider: "lab", model: "strong-model", effort: "high" },
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(
      merged.body.said,
      "Control sent a merged by model for the teachers to rig-a. The rig takes the change in less than one minute.",
    );
    assert.equal(merged.body.model, null, "the call gave the first teacher no model");
    assert.equal(merged.body.context_window, null);
    const read = await s.owner("GET");
    assert.equal(read.status, 200);
    // Each agent's model with its harness, and its own cap and point (none set here: null).
    const roleOf = (provider: string, model: string) => ({
      provider,
      model,
      effort: "high",
      harness: "pi",
      context_cap: null,
      compact_at: null,
    });
    assert.deepEqual(await read.json(), {
      rig: "rig-a",
      agents: {
        workers: {
          provider: "lab",
          model: "wide-model",
          effort: "low",
          harness: "pi",
          context_cap: null,
          compact_at: null,
        },
        planner: roleOf("lab", "strong-model"),
        teachers: {
          models: [roleOf("sub", "gpt-sol")],
          merged_by: roleOf("lab", "strong-model"),
        },
        auditor: roleOf("sub", "gpt-sol"),
        review_panel: roleOf("lab", "wide-model"),
      },
      // The rig's supervisor has not reported its advisors file.
      advisors_file: null,
    });

    // The rig takes them: the planner with its model route, the advisors with theirs. The
    // ChatGPT subscription's advisors get its access token, and run in the supervisor.
    const mr = await s.asRig("/v1/rigs/rig-a/model-route");
    assert.equal(mr.route?.model, "wide-model");
    assert.equal(mr.planner?.model, "strong-model");
    assert.equal(mr.planner?.reasoning, "high");
    const adv = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as Record<string, unknown>;
    const route = (k: string) => adv[k] as Record<string, unknown> | null;
    // One teacher: one model in teacher_models.
    const teachers = adv.teacher_models as Record<string, unknown>[];
    assert.deepEqual(
      teachers.map((t) => [t.type, t.model, t.api_key]),
      [["chatgpt", "gpt-sol", "chatgpt-access-for-tests"]],
    );
    assert.equal(route("auditor")?.type, "chatgpt");
    assert.equal(route("merged_by")?.type, "openai");
    assert.equal(route("review_panel")?.model, "wide-model");
    // A supervisor of an earlier version reads the old names: the first teacher, combiner, panel.
    assert.equal(route("teachers")?.model, "gpt-sol");
    assert.equal(route("combiner")?.model, "strong-model");
    assert.equal(route("panel")?.model, "wide-model");

    // Cleared one at a time: that agent goes back to its default, the others keep theirs.
    const planner = await s.give({ agent: "planner", clear: true });
    assert.equal(planner.status, 200);
    assert.equal(planner.body.model, null);
    assert.equal(planner.body.context_window, null);
    assert.equal(
      planner.body.said,
      "Control sent the planner back to the workers' model to rig-a. The rig takes the change in less than one minute.",
    );
    assert.equal((planner.body.agents as Record<string, unknown>).planner, null);
    assert.equal((await s.asRig("/v1/rigs/rig-a/model-route")).planner, null);
    const auditor = await s.give({ agent: "auditor", clear: true });
    assert.match(String(auditor.body.said), /the auditor back to the rig's advisors file/);
    const after = auditor.body.agents as {
      auditor: unknown;
      teachers: { models: { model: string }[]; merged_by: { model: string } | null };
      review_panel: { model: string } | null;
      workers: { model: string } | null;
    };
    assert.equal(after.auditor, null);
    assert.equal(after.teachers.models[0]?.model, "gpt-sol");
    assert.equal(after.teachers.merged_by?.model, "strong-model");
    assert.equal(after.review_panel?.model, "wide-model");
    assert.equal(after.workers?.model, "wide-model");
    assert.equal((await s.asRig("/v1/rigs/rig-a/advisor-routes")).auditor, null);

    // The workers back to the rig's own settings, as Providers says it.
    const own = await s.give({ clear: true });
    assert.equal(own.body.said, "rig-a goes back to its own settings within a minute.");
    assert.equal(s.store.rigModels()["rig-a"], undefined);
    assert.equal(
      s.store.roleModels("rig-a").teachers?.model,
      "gpt-sol",
      "the advisors keep theirs",
    );

    const audit = s.store.listAudit(50, { action: "agent_model_given" }).reverse();
    assert.deepEqual(
      audit.map((e) => [e.actor, (e.body as { role: string }).role]),
      [
        ["owner:api", "planner"],
        ["owner:api", "teachers"],
        ["owner:api", "auditor"],
        ["owner:api", "review_panel"],
        ["owner:api", "merged_by"],
        ["owner:api", "planner"],
        ["owner:api", "auditor"],
      ],
    );
    assert.deepEqual(audit.at(-1)?.body, {
      rig: "rig-a",
      role: "auditor",
      provider: null,
      model: null,
    });
  });

  test("REST: the teachers take one or two models and a merged by model, all checked first", async () => {
    const s = await stack();
    const teachers = () =>
      agentModelsOf(s.store, "rig-a").teachers as {
        models: { provider: string; model: string; harness: string; context_cap: number | null }[];
        merged_by: { model: string; compact_at: number | null } | null;
      };
    // Two teachers on two providers, merged by a third model, in one call: each model with its
    // own harness, cap and point.
    const both = await s.give({
      agent: "teachers",
      provider: "claude-sub",
      model: "opus-5.5",
      second_model: { provider: "sub", model: "gpt-sol", harness: "codex", context_window: 65_536 },
      merged_by: { provider: "lab", model: "strong-model", compact_at: 70 },
    });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.equal(both.body.model, "opus-5.5");
    assert.equal(both.body.context_window, 200_000, "the first teacher's window");
    assert.equal(
      both.body.said,
      "Control sent a model for the teachers, a model for a second teacher and a merged by model for the teachers to rig-a. The rig takes the change in less than one minute. The second teacher's context window: 65,536 tokens (capped; the provider allows 272,000). The merged by model's conversations are compacted at 70% of the window.",
    );
    assert.deepEqual(
      teachers().models.map((m) => [m.provider, m.model, m.harness, m.context_cap]),
      [
        ["claude-sub", "opus-5.5", "claude-code", null],
        ["sub", "gpt-sol", "codex", 65_536],
      ],
    );
    assert.equal(teachers().merged_by?.compact_at, 70);
    const adv = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as Record<string, unknown>;
    assert.deepEqual(
      (adv.teacher_models as { type: string; harness: string }[]).map((t) => [t.type, t.harness]),
      [
        ["claude", "claude-code"],
        ["chatgpt", "codex"],
      ],
    );
    assert.equal((adv.merged_by as { model: string } | null)?.model, "strong-model");

    // A refusal of any model in the call changes nothing, the others included.
    const refused = await s.give({
      agent: "teachers",
      provider: "lab",
      model: "wide-model",
      merged_by: { provider: "zen", model: "big-pickle", harness: "pi" },
    });
    assert.equal(refused.status, 400);
    assert.equal(
      refused.body.error,
      "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the teachers' merged by model, or another model.",
    );
    assert.equal(teachers().models[0]?.model, "opus-5.5", "the first teacher kept");
    const badSecond = await s.give({
      agent: "teachers",
      second_model: { provider: "lab", model: "no-such" },
    });
    assert.equal(badSecond.body.error, "That provider does not list that model (second teacher).");

    // One teacher only: the second model goes, the merged by model stays (for the advisors file's
    // two teachers, or the next second one).
    const one = await s.give({ agent: "teachers", second_model: null });
    assert.equal(one.status, 200);
    assert.match(
      String(one.body.said),
      /^Control sent the teachers back to one teacher to rig-a\./,
    );
    assert.deepEqual(
      teachers().models.map((m) => m.model),
      ["opus-5.5"],
    );
    assert.equal(teachers().merged_by?.model, "strong-model");
    const oneRoute = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as Record<string, unknown>;
    assert.equal((oneRoute.teacher_models as unknown[]).length, 1);

    // Clearing the teachers clears all three; a second teacher then needs a first.
    const cleared = await s.give({ agent: "teachers", clear: true });
    assert.equal(
      cleared.body.said,
      "Control sent the teachers back to the rig's advisors file to rig-a. The rig takes the change in less than one minute.",
    );
    assert.deepEqual(teachers(), { models: [], merged_by: null });
    const noFirst = await s.give({
      agent: "teachers",
      second_model: { provider: "lab", model: "wide-model" },
    });
    assert.equal(noFirst.status, 400);
    assert.equal(
      noFirst.body.error,
      "The teachers have no model of their own yet: give a provider and a model for the first teacher too.",
    );
    const empty = (await s.asRig("/v1/rigs/rig-a/advisor-routes")) as Record<string, unknown>;
    assert.deepEqual(
      [empty.teacher_models, empty.merged_by, empty.teachers, empty.combiner],
      [[], null, null, null],
    );

    // The shape: second_model and merged_by only for the teachers, and never with clear.
    for (const [body, error] of [
      [
        { agent: "auditor", provider: "lab", model: "wide-model", merged_by: null },
        "second_model and merged_by are for the teachers only: give agent teachers.",
      ],
      [
        { agent: "teachers", clear: true, merged_by: null },
        "Give clear alone, or a provider and a model.",
      ],
      [
        { agent: "teachers" },
        "Give a provider and a model, second_model or merged_by, or clear: true.",
      ],
      [
        {
          agent: "teachers",
          effort: "high",
          second_model: { provider: "lab", model: "wide-model" },
        },
        "Give a provider and a model, second_model or merged_by, or clear: true.",
      ],
      [
        { agent: "teachers", merged_by: { provider: "lab", model: "wide-model", compact_at: 99 } },
        "The compaction point is a whole percent of the context window, from 50 to 95.",
      ],
    ] as const) {
      const r = await s.give(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error);
    }
    const unknownField = await s.give({
      agent: "teachers",
      merged_by: { provider: "lab", model: "wide-model", role: "x" },
    });
    assert.equal(unknownField.status, 400);
    assert.match(String(unknownField.body.error), /^bad request: merged_by/);
  });

  test("REST: the old names combiner and panel are still taken, and say what they are now", async () => {
    const s = await stack();
    await s.give({ agent: "teachers", provider: "sub", model: "gpt-sol" });
    const combiner = await s.give({ agent: "combiner", provider: "lab", model: "strong-model" });
    assert.equal(combiner.status, 200, JSON.stringify(combiner.body));
    assert.equal(combiner.body.agent, "combiner");
    assert.equal(combiner.body.model, "strong-model");
    assert.equal(combiner.body.context_window, 400_000);
    assert.equal(
      combiner.body.said,
      "The name combiner is now the teachers' merged by model: agent teachers, with merged_by. Control sent a merged by model for the teachers to rig-a. The rig takes the change in less than one minute.",
    );
    const panel = await s.give({ agent: "panel", provider: "lab", model: "wide-model" });
    assert.equal(
      panel.body.said,
      "The name panel is now review_panel. Control sent a model for the review panel to rig-a. The rig takes the change in less than one minute.",
    );
    const agents = panel.body.agents as {
      teachers: { models: { model: string }[]; merged_by: { model: string } | null };
      review_panel: { model: string } | null;
    };
    assert.equal(agents.teachers.merged_by?.model, "strong-model");
    assert.deepEqual(
      agents.teachers.models.map((m) => m.model),
      ["gpt-sol"],
      "the first teacher kept",
    );
    assert.equal(agents.review_panel?.model, "wide-model");
    assert.equal(Object.hasOwn(agents, "combiner"), false, "rig_models shows the new shape");
    // Cleared by an old name: its place goes back to the rig's advisors file.
    const cleared = await s.give({ agent: "combiner", clear: true });
    assert.match(
      String(cleared.body.said),
      /^The name combiner is now .*Control sent the teachers' merged by model back to the rig's advisors file to rig-a\./,
    );
    assert.equal(s.store.roleModels("rig-a").merged_by, undefined);
    assert.equal(s.store.roleModels("rig-a").teachers?.model, "gpt-sol");
    // An old name takes no second_model or merged_by.
    const mixed = await s.give({
      agent: "combiner",
      provider: "lab",
      model: "wide-model",
      merged_by: { provider: "lab", model: "wide-model" },
    });
    assert.equal(mixed.status, 400);
    assert.equal(
      mixed.body.error,
      "second_model and merged_by are for the teachers only: give agent teachers.",
    );
  });
  test("REST: Edit rig's refusals in its words, and a refusal changes nothing", async () => {
    const s = await stack();
    await s.give({ agent: "auditor", provider: "lab", model: "wide-model" });
    const refused = async (body: Record<string, unknown>, error: RegExp | string) => {
      const r = await s.give(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      if (typeof error === "string") assert.equal(r.body.error, error);
      else assert.match(String(r.body.error), error);
    };
    await refused({ agent: "judge", provider: "lab", model: "wide-model" }, /^bad request: agent/);
    await refused(
      { agent: "auditor", provider: "lab", model: "no-such" },
      "That provider does not list that model (auditor).",
    );
    await refused(
      { agent: "auditor", provider: "zen", model: "big-pickle", harness: "pi" },
      "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the auditor, or another model.",
    );
    // An advisor's own cap is checked as the workers' is (goal 070).
    await refused(
      { agent: "auditor", provider: "lab", model: "strong-model", context_window: 500_000 },
      "strong-model takes at most 400,000 tokens.",
    );
    await refused(
      { agent: "planner", provider: "lab", model: "strong-model", harness: "claude-code" },
      "Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider.",
    );
    await refused(
      { agent: "auditor", clear: true, model: "wide-model" },
      "Give clear alone, or a provider and a model.",
    );
    await refused({ agent: "auditor" }, "Give a provider and a model, or clear: true.");
    assert.equal(s.store.roleModels("rig-a").auditor?.model, "wide-model");
    // OpenCode's own models suit any agent, which runs in OpenCode then.
    assert.equal(
      (await s.give({ agent: "planner", provider: "zen", model: "big-pickle" })).status,
      200,
    );
    const refusals = s.store.listAudit(50, { action: "refused" });
    assert.equal(refusals.length, 7);
    assert.ok(refusals.every((e) => (e.body as { path: string }).path === "/v1/rigs/rig-a/model"));

    const noRig = await s.owner("POST", { agent: "auditor", clear: true }, "rig-z");
    assert.equal(noRig.status, 404);
    assert.equal(((await noRig.json()) as { error: string }).error, "no rig rig-z");
    assert.equal((await s.owner("GET", undefined, "rig-z")).status, 404);
    for (const token of [TOKENS.read, TOKENS.operator]) {
      const post = await s.as(token)("POST", { agent: "auditor", clear: true });
      assert.ok(post.status === 401 || post.status === 403, "REST takes the owner's token");
      const get = await s.as(token)("GET");
      assert.ok(get.status === 401 || get.status === 403, "REST takes the owner's token");
    }
    assert.equal(s.store.roleModels("rig-a").auditor?.model, "wide-model");
  });

  test("each agent runs in the harness it is given, refused in words where its model can't run", async () => {
    const s = await stack();
    await s.give({ provider: "lab", model: "wide-model" });
    const given = [
      // [agent, provider, model, harness asked, harness kept]
      ["planner", "lab", "strong-model", "opencode", "opencode"],
      ["teachers", "sub", "gpt-sol", "codex", "codex"],
      ["auditor", "zen", "big-pickle", undefined, "opencode"],
      ["review_panel", "claude-sub", "opus-5.5", undefined, "claude-code"],
    ] as const;
    for (const [agent, provider, model, harness, kept] of given) {
      const r = await s.give({ agent, provider, model, ...(harness ? { harness } : {}) });
      assert.equal(r.status, 200, `${agent}: ${JSON.stringify(r.body)}`);
      const agents = r.body.agents as Record<string, { harness: string } | null> & {
        teachers: { models: { harness: string }[] };
      };
      assert.equal(
        agent === "teachers" ? agents.teachers.models[0]?.harness : agents[agent]?.harness,
        kept,
        agent,
      );
    }
    // The teachers' merged by model in its own harness.
    const merged = await s.give({
      agent: "teachers",
      merged_by: { provider: "lab", model: "strong-model", harness: "codex" },
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    const audit = s.store.listAudit(10, { action: "agent_model_given" });
    assert.deepEqual(
      audit.slice(0, 2).map((e) => {
        const b = e.body as { role?: string; harness?: string };
        return [b.role, b.harness];
      }),
      [
        ["merged_by", "codex"],
        ["review_panel", "claude-code"],
      ],
    );
    // The rig's routes carry each agent's harness: the planner's in its model route, the
    // advisors' in their advisor routes. OpenCode's own models go with no key.
    const mr = await s.asRig("/v1/rigs/rig-a/model-route");
    assert.equal(mr.planner?.harness, "opencode");
    assert.equal(mr.planner?.type, "openai");
    const adv = await s.asRig("/v1/rigs/rig-a/advisor-routes");
    assert.deepEqual(
      [adv.teachers?.harness, adv.teachers?.type],
      ["codex", "chatgpt"],
      "a ChatGPT sign-in in Codex",
    );
    assert.deepEqual([adv.merged_by?.harness, adv.merged_by?.type], ["codex", "openai"]);
    assert.deepEqual(
      [adv.auditor?.harness, adv.auditor?.type, adv.auditor?.api_key],
      ["opencode", "opencode", ""],
    );
    assert.deepEqual(
      [adv.review_panel?.harness, adv.review_panel?.type],
      ["claude-code", "claude"],
    );

    // Refused in words, for every kind of agent, and nothing changes.
    const refusals = [
      [
        { agent: "auditor", provider: "claude-sub", model: "opus-5.5", harness: "pi" },
        "A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model.",
      ],
      [
        { agent: "planner", provider: "zen", model: "big-pickle", harness: "codex" },
        "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.",
      ],
      [
        { agent: "teachers", provider: "zen", model: "big-pickle", harness: "pi" },
        "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the teachers, or another model.",
      ],
      [
        {
          agent: "teachers",
          merged_by: { provider: "sub", model: "gpt-sol", harness: "claude-code" },
        },
        "Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider.",
      ],
      [
        {
          agent: "teachers",
          second_model: { provider: "claude-sub", model: "opus-5.5", harness: "opencode" },
        },
        "A Claude subscription runs only in Claude Code: choose Claude Code for the second teacher, or another model.",
      ],
      [
        { provider: "claude-sub", model: "opus-5.5", harness: "codex" },
        "A Claude subscription runs only in Claude Code: choose Claude Code for the workers, or another model.",
      ],
      [
        { provider: "zen", model: "big-pickle", harness: "pi" },
        "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the workers, or another model.",
      ],
    ] as const;
    for (const [body, error] of refusals) {
      const r = await s.give(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error);
    }
    const after = agentModelsOf(s.store, "rig-a");
    assert.deepEqual(
      [
        after.workers?.harness,
        after.planner?.harness,
        after.teachers.models[0]?.harness,
        after.teachers.merged_by?.harness,
        after.auditor?.harness,
      ],
      ["pi", "opencode", "codex", "codex", "opencode"],
    );
    // Without a harness, the same model again goes back to what it needs: MCP and REST set what
    // they are asked.
    const back = await s.give({
      agent: "teachers",
      merged_by: { provider: "lab", model: "strong-model" },
    });
    assert.equal(
      (back.body.agents as { teachers: { merged_by: { harness: string } } }).teachers.merged_by
        .harness,
      "pi",
    );
    // A Claude subscription named with claude-code for the workers runs there.
    const w = await s.give({ provider: "claude-sub", model: "opus-5.5", harness: "claude-code" });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(s.store.rigModels()["rig-a"]?.harness, "claude-code");
  });

  test("MCP: an operator sets and clears an advisor's model; a reader reads them only", async () => {
    const s = await stack();
    const operator = await connect(s.api, TOKENS.operator);
    await operator.callTool({
      name: "set_rig_model",
      arguments: { rig: "rig-a", provider: "lab", model: "wide-model" },
    });
    const teachers = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: { rig: "rig-a", agent: "teachers", provider: "sub", model: "gpt-sol" },
      }),
    );
    assert.equal(teachers.agent, "teachers");
    assert.equal(teachers.context_window, 272_000);
    assert.match(String(teachers.said), /^Control sent a model for the teachers to rig-a\./);
    const agents = teachers.agents as Record<string, { model: string } | null> & {
      teachers: { models: { model: string }[] };
    };
    assert.equal(agents.teachers.models[0]?.model, "gpt-sol");
    assert.equal(agents.workers?.model, "wide-model", "the workers keep theirs");
    assert.equal(agents.planner, null);
    const audit = s.store.listAudit(5, { action: "agent_model_given" })[0];
    assert.equal(audit?.actor, "owner:operator");

    // An advisor's own cap and point (goal 070); one above the provider's window is refused.
    const capped = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: {
          rig: "rig-a",
          agent: "teachers",
          provider: "lab",
          model: "strong-model",
          context_window: 65_536,
          compact_at: 75,
        },
      }),
    );
    assert.equal(capped.context_window, 65_536);
    assert.equal(capped.compact_at, 75);
    assert.match(
      String(capped.said),
      /Its context window: 65,536 tokens \(capped; the provider allows 400,000\)\. Its conversations are compacted at 75% of the window\./,
    );
    const over = await operator.callTool({
      name: "set_rig_model",
      arguments: {
        rig: "rig-a",
        agent: "teachers",
        second_model: { provider: "lab", model: "strong-model", context_window: 500_000 },
      },
    });
    assert.equal(over.isError, true);
    assert.match(JSON.stringify(over), /strong-model takes at most 400,000 tokens\./);
    const unknown = await operator.callTool({
      name: "set_rig_model",
      arguments: { rig: "rig-a", agent: "judge", provider: "lab", model: "wide-model" },
    });
    assert.equal(unknown.isError, true);
    assert.equal(s.store.roleModels("rig-a").teachers?.contextCap, 65_536, "kept, not refused");
    assert.equal(s.store.roleModels("rig-a").second_teacher, undefined);
    // Two teachers and a merged by model over MCP, as over REST.
    const two = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: {
          rig: "rig-a",
          agent: "teachers",
          second_model: { provider: "sub", model: "gpt-sol" },
          merged_by: { provider: "lab", model: "wide-model" },
        },
      }),
    );
    const twoAgents = two.agents as {
      teachers: { models: { model: string }[]; merged_by: { model: string } | null };
    };
    assert.deepEqual(
      twoAgents.teachers.models.map((m) => m.model),
      ["strong-model", "gpt-sol"],
    );
    assert.equal(twoAgents.teachers.merged_by?.model, "wide-model");

    const cleared = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: { rig: "rig-a", agent: "teachers", clear: true },
      }),
    );
    assert.equal(cleared.model, null);
    assert.match(String(cleared.said), /the teachers back to the rig's advisors file/);
    const read = text(await operator.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.deepEqual((read.agents as Record<string, unknown>).teachers, {
      models: [],
      merged_by: null,
    });
    assert.equal((read.agents as Record<string, { model: string }>).workers?.model, "wide-model");
    await operator.close();

    const reader = await connect(s.api, TOKENS.read);
    const tools = (await reader.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("rig_models"));
    assert.ok(!tools.includes("set_rig_model"));
    const seen = text(await reader.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.equal((seen.agents as Record<string, { model: string }>).workers?.model, "wide-model");
    const none = await reader.callTool({ name: "rig_models", arguments: { rig: "rig-z" } });
    assert.equal(none.isError, true);
    assert.match(JSON.stringify(none), /no rig rig-z/);
    await reader.close();
  });
});

describe("a store from before goal 074", () => {
  test("its combiner and panel take their new names, and its teachers' model stays two teachers", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-roles-")), "control.db");
    const old = new DatabaseSync(path);
    old.exec(`create table rig_role_model (
        rig text not null,
        role text not null check (role in ('planner', 'teachers', 'combiner', 'auditor', 'panel')),
        provider text not null, model text not null, effort text, assigned_at text not null,
        primary key (rig, role));
      insert into rig_role_model values ('rig-a', 'teachers', 'lab', 'wide-model', 'high', '2026-10-20');
      insert into rig_role_model values ('rig-a', 'combiner', 'lab', 'strong-model', null, '2026-10-20');
      insert into rig_role_model values ('rig-a', 'panel', 'lab', 'wide-model', null, '2026-10-20');
      insert into rig_role_model values ('rig-a', 'auditor', 'lab', 'strong-model', null, '2026-10-20');
      insert into rig_role_model values ('rig-b', 'combiner', 'lab', 'strong-model', null, '2026-10-20');`);
    old.close();
    const store = new ControlStore(path);
    const roles = store.roleModels("rig-a");
    assert.deepEqual(Object.keys(roles).sort(), [
      "auditor",
      "merged_by",
      "review_panel",
      "second_teacher",
      "teachers",
    ]);
    assert.deepEqual(
      [roles.teachers?.model, roles.second_teacher?.model, roles.second_teacher?.effort],
      ["wide-model", "wide-model", "high"],
    );
    assert.equal(roles.merged_by?.model, "strong-model");
    assert.equal(roles.review_panel?.model, "wide-model");
    assert.deepEqual(Object.keys(store.roleModels("rig-b")), ["merged_by"]);
    // The new roles are taken, the old ones refused, and the columns of goals 070 and 073 kept.
    store.putProvider({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: "sealed-for-tests", hint: "…ests" },
    });
    store.assignRoleModel("rig-b", "second_teacher", {
      provider: "lab",
      model: "wide-model",
      harness: "codex",
      contextCap: 8192,
      compactAt: 70,
    });
    assert.deepEqual(store.roleModels("rig-b").second_teacher, {
      provider: "lab",
      model: "wide-model",
      effort: null,
      harness: "codex",
      contextCap: 8192,
      compactAt: 70,
    });
    assert.throws(() =>
      store.db
        .prepare(
          "insert into rig_role_model (rig, role, provider, model, assigned_at) values ('rig-c', 'combiner', 'lab', 'm', 'now')",
        )
        .run(),
    );
    // Opened again: nothing changes twice.
    store.db.close();
    const again = new ControlStore(path);
    assert.deepEqual(again.roleModels("rig-a"), roles);
  });
});

/**
 * The rig's advisors file, as its supervisor reports it (goal 074): control reads the new field,
 * treats it as absent from an older supervisor, and gives it in rig_models and its REST twin.
 */
describe("the advisors file, as control reads it from the supervisor", () => {
  const STATS = {
    teacher_runs: 0,
    directive_sets: 0,
    directives: 0,
    audits: 0,
    reviews: 0,
    errors: 0,
    tokens_in: 0,
    tokens_out: 0,
    usd: 0,
  };
  const ROLES = { teachers: 1, combiner: false, auditor: true, panel: 0 };
  const AUDITOR = {
    harness: "claude-code",
    model: "opus-5.5",
    provider: null,
    api: "claude",
    context_window: 200_000,
    compact_at: null,
  };
  const FILE = {
    teachers: [{ ...AUDITOR, harness: "pi", model: "model-a", api: "openai", compact_at: 70 }],
    merged_by: null,
    auditor: AUDITOR,
    review_panel: [],
  };

  test("old supervisor and new: the field, none (null advisors), or not reported", () => {
    assert.equal(advisorsFileOf(null), undefined, "no report yet");
    assert.equal(advisorsFileOf({ at: "now" }), undefined, "a report with no advisors field");
    assert.equal(
      advisorsFileOf({ advisors: { ...STATS, roles: ROLES } }),
      undefined,
      "an older supervisor: roles only",
    );
    assert.deepEqual(
      advisorsFileOf({ advisors: null }),
      { teachers: [], merged_by: null, auditor: null, review_panel: [] },
      "no advisors at all: none in the file",
    );
    assert.deepEqual(advisorsFileOf({ advisors: { ...STATS, roles: ROLES, file: FILE } }), FILE);
    // A field this control does not know is dropped; a malformed file is not reported.
    const newer = { ...FILE, auditor: { ...AUDITOR, later: "a newer field" }, later: 1 };
    assert.deepEqual(advisorsFileOf({ advisors: { file: newer } }), FILE);
    assert.equal(advisorsFileOf({ advisors: { file: { teachers: "x" } } }), undefined);
  });

  test("the supervisor's report keeps it; rig_models and GET /v1/rigs/<rig>/model give it", async () => {
    const s = await stack();
    const report = (advisors: unknown) =>
      s.api.request("/v1/rigs/rig-a/supervisor", {
        method: "POST",
        headers: { authorization: "Bearer rig-token-abcdef", "content-type": "application/json" },
        body: JSON.stringify({ at: new Date().toISOString(), advisors }),
      });
    const read = async () => (await (await s.owner("GET")).json()) as Record<string, unknown>;
    // Not reported yet.
    assert.equal((await read()).advisors_file, null);
    // An older supervisor: its roles, and no file.
    assert.equal((await report({ ...STATS, roles: ROLES })).status, 200);
    assert.equal((await read()).advisors_file, null);
    // A new one.
    assert.equal((await report({ ...STATS, roles: ROLES, file: FILE })).status, 200);
    assert.deepEqual((await read()).advisors_file, FILE);
    const mcp = await connect(s.api, TOKENS.read);
    const seen = text(await mcp.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.deepEqual(seen.advisors_file, FILE);
    await mcp.close();
    // A malformed file drops the file, not the report: the other figures are kept.
    const bad = await report({ ...STATS, audits: 3, roles: ROLES, file: { teachers: "x" } });
    assert.equal(bad.status, 200);
    assert.equal((await read()).advisors_file, null);
    assert.equal(
      (s.store.supervisor("rig-a")?.advisors as { audits?: number } | undefined)?.audits,
      3,
    );
    // No advisors at all.
    assert.equal((await report(null)).status, 200);
    assert.deepEqual((await read()).advisors_file, {
      teachers: [],
      merged_by: null,
      auditor: null,
      review_panel: [],
    });
  });
});
