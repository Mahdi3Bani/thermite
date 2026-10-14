import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHarnessApi } from "../harness/api.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";

/** An MCP client talking to control in-process (no network), as an agent would over HTTP. */
async function connect(control: ReturnType<typeof createControlApi>, token: string) {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return control.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
  };
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: fetchImpl }),
  );
  return client;
}

const text = (r: unknown) =>
  JSON.parse(((r as { content: { text: string }[] }).content[0] as { text: string }).text);

describe("control over MCP", () => {
  test("an agent lists units and pauses an instance; a reader can only read", async () => {
    const env = makeJudgeEnv();
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      {
        admin: "admin-token-abcdef",
        read: "read-token-abcdef",
        units: { "unit-a": "unit-token-abcdef" },
      },
      env.keys.privateKeyPem,
    );
    const harness = createHarnessApi(env.service, { supervisor: "s-token-abcdef" });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      return (url.host === "harness" ? harness : control).request(
        `${url.pathname}${url.search}`,
        init as RequestInit,
      );
    };
    const cfg = {
      unit: "unit-a",
      harnessUrl: "http://harness",
      harnessToken: "s-token-abcdef",
      controlUrl: "http://control",
      controlToken: "unit-token-abcdef",
      fetchImpl,
    };
    await env.service.applyCommand(env.assign);
    let state = await relayOnce(cfg, { cursor: 0 });

    const agent = await connect(control, "admin-token-abcdef");
    const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
    assert.ok(tools.includes("issue_command"));
    const units = text(await agent.callTool({ name: "list_units", arguments: {} }));
    assert.equal(units[0].unit, "unit-a");
    assert.equal(units[0].instances[0].instance, "js-1");
    const issued = text(
      await agent.callTool({
        name: "issue_command",
        arguments: {
          unit: "unit-a",
          kind: "pause_instance",
          payload: { instance: "js-1", reason: "an agent paused it" },
        },
      }),
    );
    state = await relayOnce(cfg, state);
    assert.equal(env.ledger.getInstance("js-1")?.status, "paused");
    const status = text(
      await agent.callTool({ name: "command_status", arguments: { id: issued.id } }),
    );
    assert.equal(status.status, "delivered");

    const reader = await connect(control, "read-token-abcdef");
    const readerTools = (await reader.listTools()).tools.map((t) => t.name);
    assert.ok(!readerTools.includes("issue_command"));
    assert.ok(readerTools.includes("list_units"));
    const audit = store.listAudit(100).map((a) => a.action);
    assert.ok(audit.includes("mcp:issue_command"));
    const denied = await control.request("/mcp", { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);
    await agent.close();
    await reader.close();
  });

  test("metrics are bounded series with the admin token", async () => {
    const env = makeJudgeEnv();
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      { admin: "admin-token-abcdef", units: {} },
      env.keys.privateKeyPem,
    );
    assert.equal((await control.request("/metrics")).status, 401);
    const r = await control.request("/metrics", {
      headers: { authorization: "Bearer admin-token-abcdef" },
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /# TYPE thermite_unit_up gauge/);
  });
});
