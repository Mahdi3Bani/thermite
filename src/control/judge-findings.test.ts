import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateSigningKeys } from "../core/commands.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";

/**
 * Goal 082 on control's side: what the judge found about an attempt, from the rig's events, on
 * the attempt's page, in History, over REST and over MCP.
 */

const ADMIN = "admin-token-abcdef";

async function control() {
  const store = new ControlStore(":memory:");
  const api = createControlApi(
    store,
    { admin: ADMIN, rigs: { "rig-a": "t-a-abcdef" } },
    generateSigningKeys().privateKeyPem,
  );
  const login = await api.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: ADMIN }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = async (path: string) => (await api.request(path, { headers: { cookie } })).text();
  const rest = async (path: string) =>
    (await api.request(path, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
  const mcp = async (tool: string, args: Record<string, unknown>) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${ADMIN}`);
      return api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
    };
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: fetchImpl }),
    );
    const r = (await client.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
    };
    await client.close();
    return JSON.parse(r.content[0]?.text ?? "null");
  };
  let id = 0;
  const ingest = (events: { kind: string; subject: string; body: Record<string, unknown> }[]) =>
    store.ingest({
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({
        id: ++id,
        at: new Date().toISOString(),
        actor: "harness",
        ...e,
      })),
      summary: {},
    });
  return { store, page, rest, mcp, ingest };
}

const runCreated = {
  kind: "run_created",
  subject: "sum-1",
  body: {
    campaign: "sum-speed",
    version: 1,
    mode: "hill_climb",
    seed: { repo: "proj", commit: "a".repeat(40) },
  },
};

describe("a refused change's violations on control (goal 082)", () => {
  test("the attempt's page, History, REST and get_run say why the static checks refused it", async () => {
    const c = await control();
    const violations = [
      "binary change: assets/table.bin",
      ...Array.from({ length: 19 }, (_, i) => `path not editable: bench/file-${i}.c`),
    ];
    c.ingest([
      runCreated,
      {
        kind: "attempt_recorded",
        subject: "a-0000000000000001",
        body: {
          run: "sum-1",
          lane: "lane-2",
          lifecycle: "rejected_v0",
          commit: "b".repeat(40),
          parent: "a".repeat(40),
          hypothesis: "precomputed table",
          known_flaws: [],
          violations,
          violations_total: 23,
        },
      },
    ]);
    const page = await c.page("/ui/rigs/rig-a/attempts/a-0000000000000001");
    assert.match(page, /<h2>Refused before building<\/h2><span class="n">23<\/span>/);
    assert.match(page, /<div class="fw">binary change: assets\/table\.bin<\/div>/);
    assert.match(page, /and 3 more: the rig's record of the attempt keeps them all/);
    const history = await c.page("/ui/campaigns/sum-speed?run=rig-a%2Fsum-1&view=history");
    assert.match(
      history,
      /The static checks refused it: binary change: assets\/table\.bin, and 22 more\./,
    );
    const view = (await c.rest("/v1/rigs/rig-a/view")) as {
      runs: { attempts: { violations: string[]; violations_total: number }[] }[];
    };
    assert.deepEqual(view.runs[0]?.attempts[0]?.violations, violations);
    assert.equal(view.runs[0]?.attempts[0]?.violations_total, 23);
    const run = await c.mcp("get_run", { rig: "rig-a", run: "sum-1" });
    assert.deepEqual(run.attempts[0].violations, violations);
    assert.equal(run.attempts[0].violations_total, 23);
  });

  test("an attempt from an older harness, with no violations in its event, shows none", async () => {
    const c = await control();
    c.ingest([
      runCreated,
      {
        kind: "attempt_recorded",
        subject: "a-0000000000000002",
        body: { run: "sum-1", lane: "lane-1", lifecycle: "rejected_v0", hypothesis: "old" },
      },
    ]);
    const page = await c.page("/ui/rigs/rig-a/attempts/a-0000000000000002");
    assert.doesNotMatch(page, /Refused before building/);
    const run = await c.mcp("get_run", { rig: "rig-a", run: "sum-1" });
    assert.deepEqual(run.attempts[0].violations, []);
    assert.equal(run.attempts[0].violations_total, 0);
  });
});
