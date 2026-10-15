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

  test("a rig's hardware shows on its page and in the rigs list, escaped", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    s.env.service.hardware = {
      collected_at: new Date().toISOString(),
      target: { type: "cuda-gpu", class: "p100-pcie-16g", id: "GPU-a" },
      device_mode: "dedicated",
      devices: ["judge", "dev"].map((role, i) => ({
        role: role as "judge" | "dev",
        name: i ? "<b>Evil card</b>" : "Tesla P100-PCIE-16GB",
        uuid: `GPU-${i}`,
        bus: `00000000:0${1 + i}:00.0`,
        memory_mib: 16384,
        driver: "550.00.00",
        cuda: "12.4",
        power_limit_w: 250,
        max_sm_mhz: 1328,
        max_mem_mhz: 715,
        pcie: "gen3 x16",
        vbios: null,
      })),
      cpu: { model: "Example CPU", host: 56, usable: 56, quota: 4 },
      memory: { host_mib: 257_000, limit_mib: 10_240 },
      disks: [{ name: "state", total_gib: 200, free_gib: 150 }],
      os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
      toolchain: { cc: "cc 12", nvcc: null },
      errors: [],
    };
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(page, /Tesla P100-PCIE-16GB/);
    assert.match(page, /one for the judge, one for agents' dev runs/);
    assert.match(page, /quota 4 CPU of the host's 56/);
    assert.match(page, /10 GiB limit/);
    assert.ok(!page.includes("<b>Evil card</b>"));
    assert.match(page, /&lt;b&gt;Evil card/);
    const list = await (await s.get("/ui/rigs")).text();
    assert.match(list, /Tesla P100-PCIE-16GB · &lt;b&gt;Evil card&lt;\/b&gt; · 4 CPU · 10 GiB RAM/);
  });

  test("a session survives a restart of control, renews in use, and ends with a new token", async () => {
    const store = new ControlStore(":memory:");
    const keys = makeJudgeEnv().keys;
    const control = (admin: string) =>
      createControlApi(store, { admin, rigs: { "rig-a": "rig-token-abcdef" } }, keys.privateKeyPem);
    const first = control("admin-token-abcdef");
    const login = await first.request("/ui/login", {
      method: "POST",
      body: new URLSearchParams({ token: "admin-token-abcdef" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const set = login.headers.get("set-cookie") ?? "";
    assert.match(set, /Max-Age=2592000/);
    const cookie = set.split(";")[0] ?? "";
    // Only a hash of the session id is stored.
    const rows = store.db.prepare("select id_hash from ui_session").all() as { id_hash: string }[];
    assert.equal(rows.length, 1);
    assert.ok(!cookie.includes(rows[0]?.id_hash ?? "x"));
    // A new control process over the same store: still signed in, with the same form token.
    const formToken = async (app: ReturnType<typeof control>) => {
      const r = await app.request("/ui", { headers: { cookie } });
      assert.equal(r.status, 200);
      return /name="csrf" value="([0-9a-f]+)"/.exec(await r.text())?.[1];
    };
    const before = await formToken(first);
    const restarted = control("admin-token-abcdef");
    assert.equal(await formToken(restarted), before);
    // A session older than a day is renewed when used.
    store.db.prepare("update ui_session set expires_at = ?").run(Date.now() + 3_600_000);
    const used = await restarted.request("/ui", { headers: { cookie } });
    assert.match(used.headers.get("set-cookie") ?? "", /Max-Age=2592000/);
    const row = store.db.prepare("select expires_at from ui_session").get() as {
      expires_at: number;
    };
    assert.ok(row.expires_at > Date.now() + 29 * 24 * 3_600_000);
    // A new admin token ends every session.
    const rotated = control("another-admin-token-0123");
    const out = await rotated.request("/ui", { headers: { cookie } });
    assert.equal(out.status, 303);
    // Signing out removes it.
    await restarted.request("/ui/logout", { method: "POST", headers: { cookie } });
    assert.equal((await restarted.request("/ui", { headers: { cookie } })).status, 303);
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
