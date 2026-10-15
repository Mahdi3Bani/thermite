import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHarnessApi } from "../harness/api.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../testing/judge-env.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";

/** Control with one rig whose harness runs the Node test kit; the relay is called directly. */
async function stack(promotion: "auto" | "owner_approval" = "owner_approval") {
  const env = makeJudgeEnv({ promotion });
  const store = new ControlStore(":memory:");
  const admin = "admin-token-abcdef";
  const control = createControlApi(
    store,
    { admin, rigs: { "rig-a": "rig-token-abcdef" } },
    env.keys.privateKeyPem,
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
  const relay = async () => {
    state = await relayOnce(cfg, state);
  };
  // Sign in through the form, keeping the session cookie.
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: admin }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = (path: string) => control.request(path, { headers: { cookie } });
  const post = (path: string, form: Record<string, string>) =>
    control.request(path, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
  const csrfFrom = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
  return { env, store, control, relay, get, post, csrfFrom, login };
}

describe("control dashboard", () => {
  test("a supervisor's self-report cannot carry markup, and pages forbid scripts", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    const post = (body: unknown) =>
      s.control.request("/v1/rigs/rig-a/supervisor", {
        method: "POST",
        headers: { authorization: "Bearer rig-token-abcdef", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const evil = await post({
      at: "now",
      export: {
        remote: true,
        exports: "<img src=x onerror=alert(1)>",
        pushed: [],
        last_push_at: null,
        last_error: null,
      },
    });
    assert.equal(evil.status, 400);
    const ok = await post({
      at: "now",
      export: {
        remote: true,
        exports: 3,
        pushed: [],
        last_push_at: "<script>x</script>",
        last_error: null,
      },
    });
    assert.equal(ok.status, 200);
    const page = await s.get("/ui/rigs/rig-a");
    const html = await page.text();
    assert.ok(!html.includes("<script>x</script>"));
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  });

  test("sign-in is required, and a wrong token gets nowhere", async () => {
    const s = await stack();
    assert.equal(s.login.status, 303);
    const anon = await s.control.request("/ui");
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get("location"), "/ui/login");
    const bad = await s.control.request("/ui/login", {
      method: "POST",
      body: new URLSearchParams({ token: "wrong" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(bad.headers.get("set-cookie"), null);
  });

  test("a confirmed win waits for approval, shows on the dashboard and is promoted from it", async () => {
    const s = await stack("owner_approval");
    await s.env.service.applyCommand(s.env.assign);
    const id = (
      await s.env.service.submitAttempt(
        {
          run: "js-1",
          patch_base64: s.env.patch(FAST_KERNEL),
          hypothesis: "drop the waste",
          known_flaws: [],
        },
        "proposer",
      )
    ).attempt;
    await s.env.drain();
    await s.relay();
    const home = await (await s.get("/ui")).text();
    assert.match(home, /Promotion waiting for approval/);
    assert.match(home, new RegExp(id));
    // A form without the session's token is refused.
    const forged = await s.post("/ui/commands", {
      rig: "rig-a",
      kind: "approve_promotion",
      run: "js-1",
      attempt: id,
      csrf: "0".repeat(64),
    });
    assert.equal(forged.status, 403);
    const ok = await s.post("/ui/commands", {
      rig: "rig-a",
      kind: "approve_promotion",
      run: "js-1",
      attempt: id,
      csrf: s.csrfFrom(home),
    });
    assert.equal(ok.status, 303);
    await s.relay(); // delivers the signed command to the harness
    assert.equal(s.env.ledger.currentChampion("js-1").seq, 2);
    await s.relay(); // reports the promotion back
    // Campaigns first: the run's chart and attempts are on its campaign's page, linked from the rig.
    const rig = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(rig, /href="\/ui\/campaigns\/js-sum\?run=rig-a%2Fjs-1"/);
    const campaign = await (await s.get("/ui/campaigns/js-sum?run=rig-a%2Fjs-1")).text();
    assert.match(campaign, /<svg class="chart"/);
    assert.match(campaign, /drop the waste/);
    assert.match(campaign, /id="rig-a\/js-1"/);
    // One run's views: its attempts, and its steering.
    const all = await (await s.get("/ui/campaigns/js-sum?run=rig-a%2Fjs-1&view=attempts")).text();
    assert.match(all, /drop the waste/);
    assert.doesNotMatch(all, /<svg class="chart"/);
    assert.match(
      await (await s.get("/ui/campaigns/js-sum?run=rig-a%2Fjs-1&view=steering")).text(),
      /Reset workers/,
    );
    assert.match(await (await s.get("/ui/campaigns")).text(), /js-sum/);
    assert.doesNotMatch(await (await s.get("/ui")).text(), /Promotion waiting for approval/);
    const audit = await (await s.get("/ui/audit")).text();
    assert.match(audit, /command_issued/);
  });

  test("pause from the dashboard reaches the harness", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a")).text();
    const r = await s.post("/ui/commands", {
      rig: "rig-a",
      kind: "pause_run",
      run: "js-1",
      reason: "owner looked",
      csrf: s.csrfFrom(page),
    });
    assert.equal(r.status, 303);
    await s.relay();
    assert.equal(s.env.ledger.getRun("js-1")?.status, "paused");
  });

  test("the live view: lines are escaped, only control's own script runs, and the composer messages an agent", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    s.store.addLive(
      "rig-a",
      "log-1",
      [
        {
          seq: 1,
          at: new Date().toISOString(),
          source: "trial:t-0123456789abcdef",
          kind: "text",
          text: "<img src=x onerror=alert(1)> plan",
          lane: "lane-1",
          run: "js-1",
        },
        {
          seq: 2,
          at: new Date().toISOString(),
          source: "judge",
          kind: "log",
          text: "evaluate a-1: started",
          run: "js-1",
        },
      ],
      true,
    );
    const page = await s.get("/ui/rigs/rig-a/live?source=trial%3At-0123456789abcdef");
    const html = await page.text();
    assert.ok(!html.includes("<img src=x"));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; plan/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.doesNotMatch(html, /<script>/);
    const js = await s.get("/ui/assets/app.js");
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const json = (await (await s.get("/ui/rigs/rig-a/live.json?after=0")).json()) as {
      entries: unknown[];
    };
    assert.equal(json.entries.length, 2);
    // The judge takes no messages; a worker does, through a signed owner command.
    assert.match(
      await (await s.get("/ui/rigs/rig-a/live?source=judge")).text(),
      /takes no messages/,
    );
    const sent = await s.post("/ui/rigs/rig-a/message", {
      csrf: s.csrfFrom(html),
      run: "js-1",
      to: "lane-1",
      text: "try the closed form",
      source: "trial:t-0123456789abcdef",
    });
    assert.equal(sent.status, 303);
    await s.relay();
    assert.deepEqual(
      s.env.service.takeMessages({ id: "t-0123456789abcdef", run: "js-1", lane: "lane-1" }),
      ["try the closed form"],
    );
    const cmd = s.store.listCommands(5).find((c) => c.kind === "message_agent");
    assert.equal(cmd?.issued_by, "owner:ui");
  });
});
