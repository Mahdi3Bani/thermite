import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ControlOptions,
  type ControlTokens,
  createControlApi,
} from "../../src/control/api.ts";
import { ControlStore } from "../../src/control/store.ts";
import { createHarnessApi } from "../../src/harness/api.ts";
import type { HarnessService } from "../../src/harness/service.ts";
import { type RelayState, relayOnce } from "../../src/supervisor/relay.ts";
import { makeJudgeEnv } from "./judge-env.ts";

/**
 * Control's tests' one stack (goal 125, T10): control, a rig's harness and the supervisor's relay
 * between them, all in this process; a dashboard session; and an MCP client. A test asks for what
 * it needs, and a change to how control is made changes this file, not every test.
 */

/** The owner's token, and the rig's and the supervisor's, as the tests use them. */
export const ADMIN = "admin-token-abcdef";
export const RIG_TOKEN = "rig-token-abcdef";
export const SUPERVISOR_TOKEN = "sup-token-abcdef";

const FORM = "application/x-www-form-urlencoded";

/** Control's or the harness's API, answering requests in this process. */
export interface Requester {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/**
 * A dashboard session signed in with `token`: its cookie, a page's response or text, the CSRF
 * token a page carries, and a form posted as a browser posts it without the page's script.
 */
export async function signIn(control: Requester, token = ADMIN) {
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token }),
    headers: { "content-type": FORM },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = async (path: string) => await control.request(path, { headers: { cookie } });
  const page = async (path: string) => (await get(path)).text();
  const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
  const post = async (path: string, form: Record<string, string>) =>
    await control.request(path, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { cookie, "content-type": FORM },
    });
  return { cookie, get, page, csrfOf, post };
}

/** An MCP client of control's, in this process, calling with `token`. */
export async function mcpClient(control: Requester, token = ADMIN): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return await control.request(`${url.pathname}${url.search}`, { ...init, headers });
  };
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: fetchImpl }),
  );
  return client;
}

/** A rig's harness for the stack: its service and the key that signs its commands. */
interface RigEnv {
  service: HarnessService;
  keys: { privateKeyPem: string };
}

/**
 * Control with one rig, `rig-a`, whose harness is `env`'s (a judge env unless given), and the
 * supervisor's relay between them. `relay()` runs rounds of it: the rig's report, then control's
 * pending commands. `api()` calls control's REST API with the owner's token unless given another.
 */
export function controlStack<E extends RigEnv = ReturnType<typeof makeJudgeEnv>>(
  o: { env?: E; tokens?: Partial<ControlTokens>; options?: Partial<ControlOptions> } = {},
) {
  const env = (o.env ?? makeJudgeEnv()) as E;
  const store = new ControlStore(":memory:");
  const tokens: ControlTokens = { admin: ADMIN, rigs: { "rig-a": RIG_TOKEN }, ...o.tokens };
  const control = createControlApi(store, tokens, env.keys.privateKeyPem, {
    staleAfterMs: 180_000,
    ...o.options,
  });
  const harness = createHarnessApi(env.service, { supervisor: SUPERVISOR_TOKEN });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    return await (url.host === "harness" ? harness : control).request(
      `${url.pathname}${url.search}`,
      init as RequestInit,
    );
  };
  const cfg = {
    rig: "rig-a",
    harnessUrl: "http://harness",
    harnessToken: SUPERVISOR_TOKEN,
    controlUrl: "http://control",
    controlToken: RIG_TOKEN,
    fetchImpl,
  };
  let state: RelayState = { cursor: 0 };
  const relay = async (rounds = 1): Promise<RelayState> => {
    for (let i = 0; i < rounds; i++) state = await relayOnce(cfg, state);
    return state;
  };
  const owner = typeof tokens.admin === "string" ? tokens.admin : ADMIN;
  const api = async (method: string, path: string, body?: unknown, token = owner) =>
    await control.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { env, store, tokens, control, harness, fetchImpl, cfg, relay, api };
}
