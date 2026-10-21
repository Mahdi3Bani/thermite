import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateSigningKeys } from "../core/commands.ts";
import { createControlApi } from "./api.ts";
import { agentModelsOf, rigModelShapeRefusal } from "./rig-model.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";

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
        agent: "panel",
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
      ["combiner", "lab", "strong-model", 400_000],
      ["auditor", "sub", "gpt-sol", 272_000],
      ["panel", "lab", "wide-model", 204_800],
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
        `Control sent a model for the ${agent} to rig-a. The rig takes the change in less than one minute.`,
      );
    }
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
        teachers: roleOf("sub", "gpt-sol"),
        combiner: roleOf("lab", "strong-model"),
        auditor: roleOf("sub", "gpt-sol"),
        panel: roleOf("lab", "wide-model"),
      },
    });

    // The rig takes them: the planner with its model route, the advisors with theirs. The
    // ChatGPT subscription's advisors get its access token, and run in the supervisor.
    const mr = await s.asRig("/v1/rigs/rig-a/model-route");
    assert.equal(mr.route?.model, "wide-model");
    assert.equal(mr.planner?.model, "strong-model");
    assert.equal(mr.planner?.reasoning, "high");
    const adv = await s.asRig("/v1/rigs/rig-a/advisor-routes");
    assert.equal(adv.teachers?.type, "chatgpt");
    assert.equal(adv.teachers?.model, "gpt-sol");
    assert.equal(adv.teachers?.api_key, "chatgpt-access-for-tests");
    assert.equal(adv.auditor?.type, "chatgpt");
    assert.equal(adv.combiner?.type, "openai");
    assert.equal(adv.panel?.model, "wide-model");

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
    const after = auditor.body.agents as Record<string, { model: string } | null>;
    assert.equal(after.auditor, null);
    assert.equal(after.teachers?.model, "gpt-sol");
    assert.equal(after.combiner?.model, "strong-model");
    assert.equal(after.panel?.model, "wide-model");
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
        ["owner:api", "combiner"],
        ["owner:api", "auditor"],
        ["owner:api", "panel"],
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
      ["combiner", "lab", "strong-model", "codex", "codex"],
      ["auditor", "zen", "big-pickle", undefined, "opencode"],
      ["panel", "claude-sub", "opus-5.5", undefined, "claude-code"],
    ] as const;
    for (const [agent, provider, model, harness, kept] of given) {
      const r = await s.give({ agent, provider, model, ...(harness ? { harness } : {}) });
      assert.equal(r.status, 200, `${agent}: ${JSON.stringify(r.body)}`);
      const agents = r.body.agents as Record<string, { harness: string } | null>;
      assert.equal(agents[agent]?.harness, kept, agent);
    }
    const audit = s.store.listAudit(10, { action: "agent_model_given" });
    assert.equal((audit[0]?.body as { harness?: string } | undefined)?.harness, "claude-code");
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
    assert.deepEqual([adv.combiner?.harness, adv.combiner?.type], ["codex", "openai"]);
    assert.deepEqual(
      [adv.auditor?.harness, adv.auditor?.type, adv.auditor?.api_key],
      ["opencode", "opencode", ""],
    );
    assert.deepEqual([adv.panel?.harness, adv.panel?.type], ["claude-code", "claude"]);

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
        { agent: "combiner", provider: "sub", model: "gpt-sol", harness: "claude-code" },
        "Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider.",
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
        after.teachers?.harness,
        after.combiner?.harness,
        after.auditor?.harness,
      ],
      ["pi", "opencode", "codex", "codex", "opencode"],
    );
    // Without a harness, the same model again goes back to what it needs: MCP and REST set what
    // they are asked.
    const back = await s.give({ agent: "combiner", provider: "lab", model: "strong-model" });
    assert.equal((back.body.agents as Record<string, { harness: string }>).combiner?.harness, "pi");
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
    const agents = teachers.agents as Record<string, { model: string } | null>;
    assert.equal(agents.teachers?.model, "gpt-sol");
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
          agent: "combiner",
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
        agent: "combiner",
        provider: "lab",
        model: "strong-model",
        context_window: 500_000,
      },
    });
    assert.equal(over.isError, true);
    assert.match(JSON.stringify(over), /strong-model takes at most 400,000 tokens\./);
    const unknown = await operator.callTool({
      name: "set_rig_model",
      arguments: { rig: "rig-a", agent: "judge", provider: "lab", model: "wide-model" },
    });
    assert.equal(unknown.isError, true);
    assert.equal(s.store.roleModels("rig-a").combiner?.contextCap, 65_536, "kept, not refused");

    const cleared = text(
      await operator.callTool({
        name: "set_rig_model",
        arguments: { rig: "rig-a", agent: "teachers", clear: true },
      }),
    );
    assert.equal(cleared.model, null);
    assert.match(String(cleared.said), /the teachers back to the rig's advisors file/);
    const read = text(await operator.callTool({ name: "rig_models", arguments: { rig: "rig-a" } }));
    assert.equal((read.agents as Record<string, unknown>).teachers, null);
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
