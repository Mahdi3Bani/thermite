import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createControlApi } from "../../src/control/api.ts";
import { ControlStore } from "../../src/control/store.ts";
import { Registry } from "../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../src/harness/api.ts";
import { relayOnce } from "../../src/supervisor/relay.ts";
import { makeJudgeEnv } from "./judge-env.ts";

/**
 * The setup shared by the held-out tests (goals 082 and 086): a judge environment with a hidden
 * held-out case, and the views of it each reader gets. Moved out of
 * tests/harness/judge/held-out.test.ts when its champion check moved to a file of its own.
 */

/** A held-out case whose name, parameter and error output must never reach an agent. */
export const HIDDEN = "zz-hidden-9";
export const HIDDEN_PARAM = "HIDDEN-PARAM-7731";
export const HIDDEN_STDERR = "HIDDEN-STDERR-MARKER";
/** Control's agent and reader tokens: the agent reads held-out checks as kinds alone. */
export const AGENT_TOKEN = "agent-token-abcdef";
export const READ_TOKEN = "read-token-abcdef";

export const CELLS = {
  small: { n: 20000000, work: 20000000 },
  big: { n: 100000000, work: 100000000 },
  [HIDDEN]: { n: 15000000, work: 15000000, salt: HIDDEN_PARAM },
};

/** Fast and correct on every case but the hidden one, where it prints a marker and exits 4. */
export const CRASHES_HIDDEN = `import { writeSync } from "node:fs";
export function work(n) {
  if (n === 15000000) {
    writeSync(2, "${HIDDEN_STDERR}: the input was ${HIDDEN_PARAM}\\n");
    process.exit(4);
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

/** Fast and correct everywhere, but it idles a long time on the hidden case. */
export const SLOW_ON_HIDDEN = `export function work(n) {
  if (n === 15000000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

export async function setup(opts: Parameters<typeof makeJudgeEnv>[0]) {
  const env = makeJudgeEnv({ realRuns: true, ...opts });
  const out = await env.service.applyCommand(env.assign);
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
        "proposer",
      )
    ).attempt;
  // Control, reached through the supervisor's relay as on a rig.
  const store = new ControlStore(":memory:");
  const ADMIN = "admin-token-abcdef";
  const control = createControlApi(
    store,
    {
      admin: ADMIN,
      agent: AGENT_TOKEN,
      read: READ_TOKEN,
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
  const relay = () =>
    relayOnce(
      {
        rig: "rig-a",
        harnessUrl: "http://harness",
        harnessToken: "s-token-abcdef",
        controlUrl: "http://control",
        controlToken: "rig-token-abcdef",
        fetchImpl,
      },
      { cursor: 0 },
    );
  const rest = async (path: string) =>
    (await control.request(path, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: ADMIN }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = async (path: string) =>
    (await control.request(path, { headers: { cookie } })).text();
  const mcp = async (tool: string, args: Record<string, unknown>, token = ADMIN) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const f: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return control.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
    };
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: f }),
    );
    const r = (await client.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
    };
    await client.close();
    return r.content[0]?.text ?? "";
  };
  /** Every event the harness wrote, as text. */
  const events = () => JSON.stringify(env.ledger.eventsAfter(0, 100_000).events);
  const reasons = (id: string) =>
    (
      env.ledger.db
        .prepare("select reasons from verdict where attempt = ? order by id desc limit 1")
        .get(id) as { reasons: string }
    ).reasons;
  /** What the agents get: the planner's and the teachers' evidence, a worker's status. */
  const agentViews = (id: string) => ({
    evidence: JSON.stringify(new Registry(env.ledger).evidence("js-1")),
    teachers: JSON.stringify(env.service.brief("js-1")),
    status: JSON.stringify(env.service.attemptStatus(id)),
  });
  return { ...env, submit, relay, rest, page, mcp, events, reasons, agentViews };
}

/** Nothing of the hidden case's inputs or outputs anywhere in `text`. */
export function noContent(text: string, where: string) {
  assert.ok(!text.includes(HIDDEN_PARAM), `${where} holds the hidden case's input`);
  assert.ok(!text.includes(HIDDEN_STDERR), `${where} holds the hidden case's output`);
}
