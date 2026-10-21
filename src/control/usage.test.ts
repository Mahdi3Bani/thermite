import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateSigningKeys } from "../core/commands.ts";
import { callUsage } from "../core/usage.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";
import { modelUsage } from "./usage.ts";
import { rigView } from "./views.ts";

/**
 * Model usage on control (goal 075): the rigs' model_call events become rows the sums read, for a
 * run, a campaign (all its runs on every rig) or the whole system, over a period; REST and MCP
 * give the same report. The pages built from every event leave the calls out.
 */

const TOKENS = {
  admin: "admin-token-abcdef",
  operator: "operator-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** A model_call event's body: the record's context and its measure. */
const call = (o: {
  agent?: string;
  harness?: string;
  model?: string;
  at: string;
  tokensIn: number;
  cachedIn?: number | null;
  tokensOut: number;
  callMs?: number | null;
  calls?: number | null;
  trial?: string | null;
}) => ({
  trial: o.trial ?? null,
  round: null,
  agent: o.agent ?? "workers",
  harness: o.harness ?? "pi",
  provider: "lab",
  model: o.model ?? "wide-model",
  ...callUsage({
    at: o.at,
    calls: o.calls === undefined ? 1 : o.calls,
    tokensIn: o.tokensIn,
    cachedIn: o.cachedIn ?? null,
    tokensOut: o.tokensOut,
    callMs: o.callMs ?? null,
  }),
});

function ingest(
  store: ControlStore,
  rig: string,
  ledger: string,
  events: [string, string, Record<string, unknown>][],
) {
  store.ingest({
    rig,
    ledger_id: ledger,
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([kind, subject, body], i) => ({
      id: i + 1,
      at: new Date(NOW).toISOString(),
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

/** rig-a ran r-1 of matmul; rig-b ran r-2 of matmul and r-3 of gemv. */
function stack() {
  const store = new ControlStore(":memory:");
  ingest(store, "rig-a", "ledger-a", [
    ["run_created", "r-1", { campaign: "matmul", mode: "hill_climb", version: 1, agents: true }],
    [
      "model_call",
      "r-1",
      call({
        trial: "t-1",
        at: ago(1),
        tokensIn: 1000,
        cachedIn: 600,
        tokensOut: 100,
        callMs: 1000,
      }),
    ],
    [
      "model_call",
      "r-1",
      call({ trial: "t-1", at: ago(2), tokensIn: 1000, cachedIn: 0, tokensOut: 100, callMs: 4000 }),
    ],
    [
      "model_call",
      "r-1",
      call({ agent: "planner", model: "small-model", at: ago(30), tokensIn: 500, tokensOut: 50 }),
    ],
    // A body that does not read as a record stays an event, and no sum counts it.
    ["model_call", "r-1", { agent: "workers", tokens_in: "lots" }],
  ]);
  ingest(store, "rig-b", "ledger-b", [
    ["run_created", "r-2", { campaign: "matmul", mode: "hill_climb", version: 1, agents: true }],
    ["run_created", "r-3", { campaign: "gemv", mode: "goal", version: 1, agents: true }],
    [
      "model_call",
      "r-2",
      call({ harness: "codex", at: ago(3), tokensIn: 7000, tokensOut: 300, calls: null }),
    ],
    [
      "model_call",
      "r-3",
      call({
        agent: "auditor",
        harness: "claude-code",
        at: ago(24 * 9),
        tokensIn: 400,
        tokensOut: 100,
      }),
    ],
  ]);
  const api = createControlApi(store, TOKENS, generateSigningKeys().privateKeyPem, {
    staleAfterMs: 600_000,
  });
  const get = (q: string, token = TOKENS.admin) =>
    api.request(`/v1/usage${q}`, { headers: { authorization: `Bearer ${token}` } });
  return { store, api, get };
}

describe("model usage on control (goal 075)", () => {
  test("a run's usage: its records only, by agent and by model; a figure none reports is null", () => {
    const s = stack();
    const r = modelUsage(s.store, { run: "r-1" });
    assert.deepEqual(r.scope, { kind: "run", run: "r-1", rig: null });
    assert.equal(r.total.records, 3);
    assert.equal(r.total.calls, 3);
    assert.equal(r.total.tokens_in, 2500);
    assert.equal(r.total.cached_in, 600);
    assert.equal(r.total.cached_share, 0.3);
    assert.equal(r.total.tokens_out, 250);
    assert.equal(r.total.reasoning, null);
    assert.equal(r.total.call_ms, 5000);
    assert.deepEqual(r.total.out_per_s, { median: 62.5, p10: 32.5, p90: 92.5 });
    assert.deepEqual(r.total.not_reported, { cached: 1, reasoning: 3, time: 1, first_token: 3 });
    assert.deepEqual(
      r.by_agent.map((a) => [a.agent, a.name, a.records]),
      [
        ["workers", "Workers", 2],
        ["planner", "Planner", 1],
      ],
    );
    assert.deepEqual(
      r.by_model.map((m) => [m.harness, m.provider, m.model]),
      [
        ["pi", "lab", "wide-model"],
        ["pi", "lab", "small-model"],
      ],
    );
    assert.equal(r.by_run, undefined);
    // Today, and the last 7 days.
    assert.equal(modelUsage(s.store, { run: "r-1", period: "7d" }).total.records, 3);
    const week = modelUsage(s.store, { run: "r-1", period: "today" });
    assert.ok(week.since?.endsWith("T00:00:00.000Z"));
    assert.ok(week.total.records <= 2);
  });

  test("a campaign's usage sums all its runs on every rig, with each run's share; the system's, each campaign's", () => {
    const s = stack();
    const c = modelUsage(s.store, { campaign: "matmul" });
    assert.equal(c.total.records, 4);
    assert.equal(c.total.calls, 3);
    assert.equal(c.total.calls_not_reported, 1, "a Codex turn says no count of calls");
    assert.deepEqual(
      c.by_run?.map((x) => [x.rig, x.run, x.share]),
      [
        ["rig-b", "r-2", 0.7264],
        ["rig-a", "r-1", 0.2736],
      ],
    );
    const all = modelUsage(s.store, {});
    assert.equal(all.total.records, 5);
    assert.deepEqual(
      all.by_campaign?.map((x) => x.campaign),
      ["matmul", "gemv"],
    );
    // The last 7 days leave out the audit nine days ago.
    assert.equal(modelUsage(s.store, { period: "7d" }).total.records, 4);
    assert.equal(modelUsage(s.store, { campaign: "nope" }).total.records, 0);
  });

  test("a rig's records stay when it leaves its ledger: the calls were made", () => {
    const s = stack();
    ingest(s.store, "rig-a", "ledger-a2", [
      ["run_created", "r-9", { campaign: "matmul", mode: "hill_climb", version: 1, agents: true }],
      ["model_call", "r-9", call({ at: ago(1), tokensIn: 10, tokensOut: 1 })],
    ]);
    assert.equal(modelUsage(s.store, { campaign: "matmul" }).total.records, 5);
    assert.equal(modelUsage(s.store, { run: "r-1", rig: "rig-a" }).total.records, 3);
    assert.equal(modelUsage(s.store, { run: "r-1", rig: "rig-b" }).total.records, 0);
  });

  test("the pages built from every event leave the calls out; the rig's event list keeps them", () => {
    const s = stack();
    const v = rigView(s.store, "rig-a", { staleAfterMs: 600_000 });
    assert.ok(v);
    assert.ok(v.recent.every((e) => e.kind !== "model_call"));
    assert.equal(
      s.store.events("rig-a", 0, 100).filter((e) => (e as { kind: string }).kind === "model_call")
        .length,
      4,
    );
    assert.equal(
      s.store
        .events("rig-a", 0, 100, null, { lean: true })
        .filter((e) => (e as { kind: string }).kind === "model_call").length,
      0,
    );
  });

  test("REST: the owner's or the reader's token; a query that does not read is refused in words", async () => {
    const s = stack();
    const r = await s.get("?campaign=matmul&period=all", TOKENS.read);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { total: { records: number }; by_run: unknown[] };
    assert.equal(body.total.records, 4);
    assert.equal(body.by_run.length, 2);
    // An empty field is no field.
    assert.equal((await s.get("?run=&campaign=gemv")).status, 200);
    const refused = async (q: string, words: RegExp) => {
      const x = await s.get(q);
      assert.equal(x.status, 400, q);
      assert.match(String(((await x.json()) as { error: string }).error), words, q);
    };
    await refused("?run=r-1&campaign=matmul", /^Give a run or a campaign, not both\.$/);
    await refused("?period=month", /^The period is today, 7d or all\.$/);
    await refused("?rig=rig-a", /^A rig goes with a run/);
    await refused("?model=x", /^It takes run, rig, campaign and period, not model\.$/);
    await refused(`?run=${"x".repeat(101)}`, /^A run is 1 to 100 characters\.$/);
    assert.equal((await s.api.request("/v1/usage")).status, 401);
  });

  test("MCP: model_usage gives the same report", async () => {
    const s = stack();
    const client = new Client({ name: "test", version: "1.0.0" });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${TOKENS.operator}`);
      return s.api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
    };
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: fetchImpl }),
    );
    const out = (await client.callTool({
      name: "model_usage",
      arguments: { run: "r-1", period: "7d" },
    })) as { content: { text: string }[]; isError?: boolean };
    const { since, ...report } = JSON.parse(out.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    const { since: _, ...expected } = JSON.parse(
      JSON.stringify(modelUsage(s.store, { run: "r-1", period: "7d" })),
    ) as Record<string, unknown>;
    assert.deepEqual(report, expected);
    assert.ok(Date.parse(String(since)) < NOW - 6 * 86_400_000);
    const bad = (await client.callTool({
      name: "model_usage",
      arguments: { run: "r-1", campaign: "matmul" },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]?.text ?? "", /Give a run or a campaign, not both/);
    await client.close();
  });
});
