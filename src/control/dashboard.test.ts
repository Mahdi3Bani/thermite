import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHarnessApi } from "../harness/api.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../testing/judge-env.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";

/** Control with one unit whose harness runs the Node test kit; the relay is called directly. */
async function stack(promotion: "auto" | "owner_approval" = "owner_approval") {
  const env = makeJudgeEnv({ promotion });
  const store = new ControlStore(":memory:");
  const admin = "admin-token-abcdef";
  const control = createControlApi(
    store,
    { admin, units: { "unit-a": "unit-token-abcdef" } },
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
    unit: "unit-a",
    harnessUrl: "http://harness",
    harnessToken: "sup-token-abcdef",
    controlUrl: "http://control",
    controlToken: "unit-token-abcdef",
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
      s.control.request("/v1/units/unit-a/supervisor", {
        method: "POST",
        headers: { authorization: "Bearer unit-token-abcdef", "content-type": "application/json" },
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
    const page = await s.get("/ui/units/unit-a");
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
          instance: "js-1",
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
    assert.match(home, /Promotions waiting for approval/);
    assert.match(home, new RegExp(id));
    // A form without the session's token is refused.
    const forged = await s.post("/ui/commands", {
      unit: "unit-a",
      kind: "approve_promotion",
      instance: "js-1",
      attempt: id,
      csrf: "0".repeat(64),
    });
    assert.equal(forged.status, 403);
    const ok = await s.post("/ui/commands", {
      unit: "unit-a",
      kind: "approve_promotion",
      instance: "js-1",
      attempt: id,
      csrf: s.csrfFrom(home),
    });
    assert.equal(ok.status, 303);
    await s.relay(); // delivers the signed command to the harness
    assert.equal(s.env.ledger.currentChampion("js-1").seq, 2);
    await s.relay(); // reports the promotion back
    const unit = await (await s.get("/ui/units/unit-a")).text();
    assert.match(unit, /<svg/);
    assert.match(unit, /drop the waste/);
    assert.doesNotMatch(await (await s.get("/ui")).text(), /Promotions waiting for approval/);
    const audit = await (await s.get("/ui/audit")).text();
    assert.match(audit, /command_issued/);
  });

  test("pause from the dashboard reaches the harness", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    const page = await (await s.get("/ui/units/unit-a")).text();
    const r = await s.post("/ui/commands", {
      unit: "unit-a",
      kind: "pause_instance",
      instance: "js-1",
      reason: "owner looked",
      csrf: s.csrfFrom(page),
    });
    assert.equal(r.status, 303);
    await s.relay();
    assert.equal(s.env.ledger.getInstance("js-1")?.status, "paused");
  });
});
