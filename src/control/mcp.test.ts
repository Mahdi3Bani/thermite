import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHarnessApi } from "../harness/api.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { createControlApi } from "./api.ts";
import { Credential } from "./credential.ts";
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
  test("an agent lists rigs and pauses a run; a reader can only read", async () => {
    const env = makeJudgeEnv();
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      {
        admin: "admin-token-abcdef",
        read: "read-token-abcdef",
        rigs: { "rig-a": "rig-token-abcdef" },
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
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: "s-token-abcdef",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      fetchImpl,
    };
    await env.service.applyCommand(env.assign);
    let state = await relayOnce(cfg, { cursor: 0 });

    const agent = await connect(control, "admin-token-abcdef");
    const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
    assert.ok(tools.includes("issue_command"));
    const rigs = text(await agent.callTool({ name: "list_rigs", arguments: {} }));
    assert.equal(rigs[0].rig, "rig-a");
    assert.equal(rigs[0].runs[0].run, "js-1");
    const issued = text(
      await agent.callTool({
        name: "issue_command",
        arguments: {
          rig: "rig-a",
          kind: "pause_run",
          payload: { run: "js-1", reason: "an agent paused it" },
        },
      }),
    );
    state = await relayOnce(cfg, state);
    assert.equal(env.ledger.getRun("js-1")?.status, "paused");
    const status = text(
      await agent.callTool({ name: "command_status", arguments: { id: issued.id } }),
    );
    assert.equal(status.status, "delivered");

    const reader = await connect(control, "read-token-abcdef");
    const readerTools = (await reader.listTools()).tools.map((t) => t.name);
    assert.ok(!readerTools.includes("issue_command"));
    assert.ok(readerTools.includes("list_rigs"));
    const audit = store.listAudit(100).map((a) => a.action);
    assert.ok(audit.includes("mcp:issue_command"));
    const denied = await control.request("/mcp", { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);
    await agent.close();
    await reader.close();
  });

  test("an operator messages a run's agents for the owner, never approves; an agent never messages", async () => {
    const env = makeJudgeEnv();
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      {
        // Deployed as a hash: control holds nothing that signs in as the owner.
        admin: Credential.ofHash(createHash("sha256").update("admin-token-abcdef").digest("hex")),
        operator: "operator-token-abcdef",
        agent: "agent-token-abcdef",
        rigs: { "rig-a": "rig-token-abcdef" },
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
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: "s-token-abcdef",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      fetchImpl,
    };
    await env.service.applyCommand(env.assign);
    let state = await relayOnce(cfg, { cursor: 0 });
    const issue = async (client: Client, kind: string, payload: Record<string, unknown>) => {
      try {
        const r = (await client.callTool({
          name: "issue_command",
          arguments: { rig: "rig-a", kind, payload },
        })) as { isError?: boolean };
        return r.isError ? undefined : text(r);
      } catch {
        return undefined;
      }
    };
    const operator = await connect(control, "operator-token-abcdef");
    const sent = await issue(operator, "message_agent", {
      run: "js-1",
      to: "planner",
      text: "work on the unmet goals first",
    });
    assert.ok(sent?.id, "the operator may message agents");
    state = await relayOnce(cfg, state);
    assert.deepEqual(env.service.takePlannerMessages("js-1"), ["work on the unmet goals first"]);
    assert.equal(
      text(await operator.callTool({ name: "command_status", arguments: { id: sent.id } })).status,
      "delivered",
    );
    assert.equal(
      await issue(operator, "approve_promotion", { run: "js-1", attempt: "a-1" }),
      undefined,
      "approvals stay the owner's",
    );
    const agent = await connect(control, "agent-token-abcdef");
    assert.equal(
      await issue(agent, "message_agent", { run: "js-1", to: "planner", text: "x" }),
      undefined,
      "an agent may not speak for the owner",
    );
    // The owner signs in with the token whose hash control holds.
    const owner = await connect(control, "admin-token-abcdef");
    assert.ok((await owner.listTools()).tools.some((t) => t.name === "issue_command"));
    const wrong = await control.request("/v1/rigs", {
      headers: {
        authorization: `Bearer ${createHash("sha256").update("admin-token-abcdef").digest("hex")}`,
      },
    });
    assert.equal(wrong.status, 401, "the hash itself is not a credential");
    await Promise.all([operator.close(), agent.close(), owner.close()]);
  });

  test("metrics are bounded series with the admin token", async () => {
    const env = makeJudgeEnv();
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      { admin: "admin-token-abcdef", rigs: {} },
      env.keys.privateKeyPem,
    );
    assert.equal((await control.request("/metrics")).status, 401);
    const r = await control.request("/metrics", {
      headers: { authorization: "Bearer admin-token-abcdef" },
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /# TYPE thermite_rig_up gauge/);
  });
});
