import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHarnessApi } from "../harness/api.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { createControlApi } from "./api.ts";
import type { Progress } from "./command-progress.ts";
import { ControlStore } from "./store.ts";

/**
 * The owner closes a run by hand (goal 087): Close run in the ⋯ of a run's page sends close_run,
 * and the page then shows the run closed with the owner's reason. REST takes it with the owner's
 * token; over MCP, only the owner's token issues it. Control here has one rig whose harness is
 * real; the supervisor's relay is called by hand.
 */

const ADMIN = "admin-token-abcdef";
const OPERATOR = "operator-token-abcdef";
const AGENT = "agent-token-abcdef";
type Answer = Progress & { follow?: string };

async function stack() {
  const env = makeJudgeEnv();
  const store = new ControlStore(":memory:");
  const control = createControlApi(
    store,
    { admin: ADMIN, operator: OPERATOR, agent: AGENT, rigs: { "rig-a": "rig-token-abcdef" } },
    env.keys.privateKeyPem,
    { staleAfterMs: 180_000 },
  );
  const harness = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
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
    harnessToken: "sup-token-abcdef",
    controlUrl: "http://control",
    controlToken: "rig-token-abcdef",
    fetchImpl,
  };
  let state = { cursor: 0 } as Awaited<ReturnType<typeof relayOnce>>;
  /** One round of the supervisor: the rig's report, then control's pending commands. */
  const relay = async () => {
    state = await relayOnce(cfg, state);
  };
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: ADMIN }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = async (path: string) =>
    (await control.request(path, { headers: { cookie } })).text();
  await env.service.applyCommand(env.assign);
  await relay();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/rigs/rig-a"))?.[1] ?? "";
  /** A form as a browser posts it without the page's script. */
  const post = (form: Record<string, string>) =>
    control.request("/ui/commands", {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
  /** A form as the page's script sends it: with fetch, asking for JSON. */
  const send = async (form: Record<string, string>) => {
    const r = await control.request("/ui/commands", {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: {
        cookie,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    return { status: r.status, answer: JSON.parse(await r.text()) as Answer };
  };
  const follow = async (url: string) => JSON.parse(await page(url)) as Answer;
  return { env, store, control, relay, page, post, send, follow };
}

const RUN_PAGE = "/ui/campaigns/js-sum?run=rig-a%2Fjs-1";
/** The run page's header: the title bar with its buttons. */
const headerOf = (html: string) =>
  /<header class="topbar">[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
const closeFormOf = (html: string) =>
  /<form method="post" action="\/ui\/commands" class="stack close-run">[\s\S]*?<\/form>/.exec(
    html,
  )?.[0] ?? "";

/** An MCP client talking to control in-process, as an agent would over HTTP. */
async function connect(control: ReturnType<typeof createControlApi>, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
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

describe("Close run on a run's page (goal 087)", () => {
  test("⋯ has Close run with a reason and a typed confirmation; the page then shows the run closed with the reason", async () => {
    const s = await stack();
    const before = await s.page(RUN_PAGE);
    const form = closeFormOf(headerOf(before));
    assert.ok(form, "Close run is in the run's header, under ⋯");
    assert.match(
      form,
      /<b>Close run\.<\/b> <span class="muted">The run ends for good: nothing more starts, and it can't be resumed\. Its results stay\.<\/span>/,
    );
    assert.match(form, /<input type="hidden" name="kind" value="close_run">/);
    assert.match(form, /<input type="hidden" name="run" value="js-1">/);
    assert.match(form, /<span class="lb">Why<i class="ii" tabindex="0" data-tip="Why you close/);
    assert.match(form, /<input name="reason" required maxlength="500"/);
    assert.match(form, /data-confirm="close js-1"/);
    assert.match(form, /<button class="danger">Close the run<\/button>/);
    // Restart the lanes stays first in the same menu.
    assert.match(headerOf(before), /Restart the lanes[\s\S]*Close run\./);

    // Control refuses it without a reason or the typed words, in words, and signs nothing.
    const noWhy = await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      confirm: "close js-1",
    });
    assert.equal(noWhy.status, 400);
    assert.equal(noWhy.answer.said, "Not sent: Write why you close the run first.");
    const noWords = await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      reason: "done",
      confirm: "close js-2",
    });
    assert.equal(noWords.answer.said, "Not sent: Type close js-1 to confirm.");
    const plain = await s.post({ rig: "rig-a", kind: "close_run", run: "js-1", reason: "done" });
    assert.equal(plain.status, 400);
    assert.equal(await plain.text(), "refused: type close js-1 to confirm");
    assert.equal(s.store.listCommands(10).filter((c) => c.kind === "close_run").length, 0);

    // Sent, taken by the rig, then done once its report came, as every command's button.
    const why = "another run finished the work";
    const sent = await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      reason: ` ${why} `,
      confirm: "close js-1",
      back: RUN_PAGE,
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.answer.state, "sent");
    assert.match(sent.answer.follow ?? "", /^\/ui\/commands\/[0-9a-f-]+\.json$/);
    const cmd = s.store.listCommands(10).find((c) => c.kind === "close_run");
    assert.equal(cmd?.issued_by, "owner:ui");
    await s.relay();
    assert.equal(s.env.ledger.getRun("js-1")?.status, "closed");
    assert.equal(s.env.ledger.getRun("js-1")?.pause_reason, why, "the reason, trimmed");
    await s.relay();
    const done = await s.follow(sent.answer.follow ?? "");
    assert.deepEqual([done.state, done.final, done.tone], ["done", true, "ok"]);

    // The page now shows the run closed with the reason: no Pause, Resume or Close run.
    const after = await s.page(RUN_PAGE);
    assert.match(headerOf(after), /Finished/);
    assert.doesNotMatch(headerOf(after), /Pause|Resume|Close run|title="More"/);
    assert.match(after, new RegExp(`This run is <b>closed: ${why}</b>\\. It is finished\\.`));
    const history = await s.page(`${RUN_PAGE}&view=history`);
    assert.match(history, new RegExp(`Run js-1 closed: ${why}\\.`));
  });

  test("a paused run has Close run beside Resume; a run already closed is refused in words", async () => {
    const s = await stack();
    await s.env.service.applyCommand(
      s.env.sign("pause_run", { run: "js-1", reason: "seen enough" }),
    );
    await s.relay();
    const head = headerOf(await s.page(RUN_PAGE));
    assert.match(head, />Resume<\/button>/);
    assert.ok(closeFormOf(head), "Close run on a paused run");
    assert.doesNotMatch(head, /Restart the lanes/, "a paused run has no lanes to restart");
    // The rig closed it meanwhile (the page was older): the rig refuses the second close.
    await s.env.service.applyCommand(s.env.sign("close_run", { run: "js-1", reason: "first" }));
    const sent = await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      reason: "second",
      confirm: "close js-1",
    });
    await s.relay();
    await s.relay();
    const out = await s.follow(sent.answer.follow ?? "");
    assert.equal(out.final, true);
    assert.equal(out.tone, "bad");
    assert.match(out.said, /run js-1 is already closed \(first\): there is nothing to close/);
    assert.equal(s.env.ledger.getRun("js-1")?.pause_reason, "first");
  });
});

describe("close_run over REST and MCP (goal 087)", () => {
  test("POST /v1/commands takes it with the owner's token; over MCP only the owner's token issues it", async () => {
    const s = await stack();
    const rest = (token: string, payload: unknown) =>
      s.control.request("/v1/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ rig: "rig-a", kind: "close_run", payload }),
      });
    // Not the operator's or an agent's token: REST commands are the owner's.
    for (const t of [OPERATOR, AGENT])
      assert.equal((await rest(t, { run: "js-1", reason: "x" })).status, 401);
    const bad = await rest(ADMIN, { run: "js-1", reason: "  " });
    assert.equal(bad.status, 400);
    assert.match(
      ((await bad.json()) as { error: string }).error,
      /^bad close_run payload: reason: /,
    );

    // MCP: the operator's and an agent's issue_command don't take close_run.
    const issue = async (client: Client, payload: Record<string, unknown>) => {
      try {
        const r = (await client.callTool({
          name: "issue_command",
          arguments: { rig: "rig-a", kind: "close_run", payload },
        })) as { isError?: boolean; content: { text: string }[] };
        return r.isError ? undefined : (JSON.parse(r.content[0]?.text ?? "{}") as { id?: string });
      } catch {
        return undefined;
      }
    };
    for (const token of [OPERATOR, AGENT]) {
      const client = await connect(s.control, token);
      const tool = (await client.listTools()).tools.find((t) => t.name === "issue_command");
      assert.doesNotMatch(String(tool?.description), /close_run/, token);
      assert.equal(await issue(client, { run: "js-1", reason: "x" }), undefined, token);
      await client.close();
    }
    assert.equal(s.store.listCommands(10).filter((c) => c.kind === "close_run").length, 0);
    const owner = await connect(s.control, ADMIN);
    const tool = (await owner.listTools()).tools.find((t) => t.name === "issue_command");
    assert.match(String(tool?.description), /close_run \{run, reason\} \(the owner's token only/);
    const viaMcp = await issue(owner, { run: "js-1", reason: "closed over MCP" });
    assert.ok(viaMcp?.id, "the owner's MCP token closes a run");
    await owner.close();
    await s.relay();
    assert.deepEqual(
      [s.env.ledger.getRun("js-1")?.status, s.env.ledger.getRun("js-1")?.pause_reason],
      ["closed", "closed over MCP"],
    );
    const ev = s.env.ledger.db
      .prepare("select actor from event where kind = 'run_status' order by id desc limit 1")
      .get() as { actor: string };
    assert.equal(ev.actor, "control:owner:mcp");

    // REST: the owner's token issues it; the rig refuses a second close in words.
    const again = await rest(ADMIN, { run: "js-1", reason: "twice" });
    assert.equal(again.status, 201);
    const { id } = (await again.json()) as { id: string };
    await s.relay();
    const c = s.store.command(id) as { status: string; outcome?: { result?: unknown } };
    assert.equal(c.status, "failed");
    assert.match(JSON.stringify(c), /run js-1 is already closed \(closed over MCP\)/);
  });
});
