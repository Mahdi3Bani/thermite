import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ModelSource } from "../harness/agents/model-source.ts";
import { createHarnessApi } from "../harness/api.ts";
import { syncModelRoute } from "../supervisor/model-route.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { seedDemo } from "../testing/control-demo.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../testing/judge-env.ts";
import { createControlApi } from "./api.ts";
import { Credential } from "./credential.ts";
import { ControlStore } from "./store.ts";

/** Control with one rig whose harness runs the Node test kit; the relay is called directly. */
const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

async function stack(
  promotion: "auto" | "owner_approval" = "owner_approval",
  opts: { providerFetch?: typeof fetch } = {},
) {
  const env = makeJudgeEnv({ promotion });
  const store = new ControlStore(":memory:");
  const admin = "admin-token-abcdef";
  const control = createControlApi(
    store,
    { admin, rigs: { "rig-a": "rig-token-abcdef" } },
    env.keys.privateKeyPem,
    { staleAfterMs: 180_000, providerFetch: opts.providerFetch },
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
  return { env, store, control, relay, get, post, csrfFrom, login, fetchImpl };
}

describe("control dashboard", () => {
  test("a provider's key goes in once on the settings page, sealed; its models are listed; only its rig's harness gets the key", async () => {
    // A fake provider: an OpenAI-compatible one that takes only its key, and Anthropic's API.
    const key = "test-key-never-shown-0001";
    const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      if (url === "https://models.example/v1/models")
        return h.get("authorization") === `Bearer ${key}`
          ? Response.json({
              data: [{ id: "deepseek-v4.1-flash-free", context_length: 262144 }, { id: "other" }],
            })
          : new Response("no", { status: 401 });
      // OpenCode's own list (it needs no key).
      if (url === "https://opencode.ai/zen/v1/models")
        return Response.json({ data: [{ id: "free-model-free" }, { id: "paid-model" }] });
      if (
        url.startsWith("https://api.anthropic.com/v1/models") &&
        h.get("x-api-key") === "sk-ant-x"
      )
        return Response.json({ data: [{ id: "claude-test" }], has_more: false });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const s = await stack("owner_approval", { providerFetch });
    const dir = mkdtempSync(join(tmpdir(), "thermite-route-"));
    s.env.service.models = new ModelSource(join(dir, "model-route.json"), undefined);
    await s.relay();
    let page = await (await s.get("/ui/settings")).text();
    assert.match(page, /No provider yet/);
    const csrf = s.csrfFrom(page);
    // A form without the session's token is refused.
    assert.equal((await s.post("/ui/settings/providers", { csrf: "0", name: "x" })).status, 403);
    const where = (r: Response) => decodeURIComponent(r.headers.get("location") ?? "");
    const added = await s.post("/ui/settings/providers", {
      csrf,
      name: "opencode",
      type: "openai",
      base_url: "https://models.example/v1/",
      api_key: key,
    });
    assert.match(where(added), /ok="opencode" is saved and lists 2 models/);
    // A wrong key is saved, and the page says why its models could not be listed.
    const wrong = await s.post("/ui/settings/providers", {
      csrf,
      name: "wrong",
      type: "openai",
      base_url: "https://models.example/v1",
      api_key: "sk-wrong-9999",
    });
    assert.match(where(wrong), /HTTP 401 \(is the key right\?\)/);
    // A new provider needs its key; a change without one keeps the sealed key and lists again.
    const keyless = await s.post("/ui/settings/providers", {
      csrf,
      name: "other",
      type: "openai",
      base_url: "https://models.example/v1",
    });
    assert.match(where(keyless), /needs its API key/);
    await s.post("/ui/settings/providers", {
      csrf,
      name: "opencode",
      type: "openai",
      base_url: "https://models.example/v1",
    });
    assert.equal(s.store.provider("opencode")?.version, 2);
    assert.equal(s.store.provider("opencode")?.models.length, 2);
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /key …0001/);
    assert.match(page, /deepseek-v4\.1-flash-free <span class="muted">· 262k<\/span>/);
    // The key is in no page, row or audit entry: only sealed, and as its last four characters.
    const everything = JSON.stringify([
      page,
      s.store.db.prepare("select * from model_provider").all(),
      s.store.db.prepare("select * from audit").all(),
    ]);
    assert.ok(!everything.includes(key));
    // Only the rig given one of its models, with its own token, receives the key.
    const routeOf = (token: string) =>
      s.control.request("/v1/rigs/rig-a/model-route", {
        headers: { authorization: `Bearer ${token}` },
      });
    assert.deepEqual(await (await routeOf("rig-token-abcdef")).json(), { route: null });
    const unlisted = await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "opencode|nope",
    });
    assert.match(where(unlisted), /does not list that model/);
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "opencode|deepseek-v4.1-flash-free",
    });
    assert.equal((await routeOf("admin-token-abcdef")).status, 401);
    const given = (await (await routeOf("rig-token-abcdef")).json()) as {
      route: { api_key: string; type: string; context_window: number; base_url: string };
    };
    assert.equal(given.route.api_key, key);
    assert.equal(given.route.type, "openai");
    assert.equal(given.route.context_window, 262144);
    // A model the provider does not list can be added by its name.
    await s.post("/ui/settings/providers/opencode/models", { csrf, model: "custom-model" });
    assert.ok(s.store.provider("opencode")?.models.some((m) => m.id === "custom-model" && m.added));
    // The supervisor hands it to its harness once; its agents use it from then on.
    const sync = {
      rig: "rig-a",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      harnessUrl: "http://harness",
      harnessToken: "sup-token-abcdef",
      fetchImpl: s.fetchImpl,
    };
    assert.equal(await syncModelRoute(sync), "set");
    assert.equal(await syncModelRoute(sync), "unchanged");
    const current = s.env.service.models.current();
    assert.equal(current?.apiKey, key);
    assert.equal(current?.model, "deepseek-v4.1-flash-free");
    assert.equal(current?.contextWindow, 262144);
    assert.equal(statSync(join(dir, "model-route.json")).mode & 0o777, 0o600);
    await s.relay();
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /Its agents run under Pi with deepseek-v4\.1-flash-free from opencode\./);
    const rig = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(rig, /The agents now use model route &quot;opencode&quot;/);
    // Nothing the rig reports or records carries the key.
    assert.ok(
      !JSON.stringify([
        s.store.db.prepare("select * from rig").all(),
        s.store.db.prepare("select * from rig_event").all(),
        s.env.service.ledger.db.prepare("select * from event").all(),
      ]).includes(key),
    );
    // An Anthropic provider: its base URL may be left empty, and its route says its API.
    const ant = await s.post("/ui/settings/providers", {
      csrf,
      name: "anthropic",
      type: "anthropic",
      base_url: "",
      api_key: "sk-ant-x",
    });
    assert.match(where(ant), /lists 1 model/);
    assert.equal(s.store.provider("anthropic")?.base_url, "https://api.anthropic.com");
    await s.post("/ui/settings/rigs", { csrf, rig: "rig-a", choice: "anthropic|claude-test" });
    assert.equal(await syncModelRoute(sync), "set");
    assert.equal(s.env.service.models.current()?.api, "anthropic");
    assert.equal(s.env.service.models.current()?.baseUrl, "https://api.anthropic.com");
    // OpenCode's own provider needs no key, and its models run only in the OpenCode harness.
    const oc = await s.post("/ui/settings/providers", {
      csrf,
      name: "zen",
      type: "opencode",
      base_url: "",
    });
    assert.match(where(oc), /lists 2 models/);
    assert.equal(s.store.provider("zen")?.key_sealed, "");
    const underPi = await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "zen|free-model-free",
      harness: "pi",
    });
    assert.match(where(underPi), /run only in the OpenCode harness/);
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "zen|free-model-free",
      harness: "opencode",
    });
    assert.equal(await syncModelRoute(sync), "set");
    const zen = s.env.service.models.current();
    assert.equal(zen?.harness, "opencode");
    assert.equal(zen?.api, "opencode");
    assert.equal(zen?.apiKey, "");
    await s.relay();
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /Its agents run under OpenCode v2 with free-model-free from zen\./);
    // A provider added as OpenAI-compatible at OpenCode's own endpoint, with its key, is OpenCode's
    // own too: under OpenCode it runs through OpenCode's built-in provider (no key sent); under Pi,
    // its key serves its paid models, and its free models are refused there.
    await s.post("/ui/settings/providers", {
      csrf,
      name: "oc-key",
      type: "openai",
      base_url: "https://opencode.ai/zen/v1/models",
      api_key: "test-oc-key-0002",
    });
    assert.equal(s.store.provider("oc-key")?.base_url, "https://opencode.ai/zen/v1");
    const freeUnderPi = await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "oc-key|free-model-free",
      harness: "pi",
    });
    assert.match(where(freeUnderPi), /free models run only in the OpenCode harness/);
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "oc-key|free-model-free",
      harness: "opencode",
    });
    const own = (await (await routeOf("rig-token-abcdef")).json()) as {
      route: { type: string; api_key: string; harness: string };
    };
    assert.deepEqual(
      [own.route.type, own.route.api_key, own.route.harness],
      ["opencode", "", "opencode"],
    );
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "oc-key|paid-model",
      harness: "pi",
    });
    const paid = (await (await routeOf("rig-token-abcdef")).json()) as {
      route: { type: string; api_key: string };
    };
    assert.deepEqual([paid.route.type, paid.route.api_key], ["openai", "test-oc-key-0002"]);
    // Any other provider works under OpenCode too (through the harness's key-adding proxy).
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "opencode|deepseek-v4.1-flash-free",
      harness: "opencode",
    });
    assert.equal(await syncModelRoute(sync), "set");
    assert.equal(s.env.service.models.current()?.harness, "opencode");
    assert.equal(s.env.service.models.current()?.api, undefined);
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "anthropic|claude-test",
      harness: "pi",
    });
    assert.equal(await syncModelRoute(sync), "set");
    await s.post("/ui/settings/providers/zen/delete", { csrf });
    // Back to the rig's own settings; a provider in use cannot be deleted meanwhile.
    const busy = await s.post("/ui/settings/providers/anthropic/delete", { csrf });
    assert.match(where(busy), /still in use/);
    await s.post("/ui/settings/rigs", { csrf, rig: "rig-a", choice: "" });
    assert.equal(await syncModelRoute(sync), "cleared");
    assert.equal(s.env.service.models.current(), undefined);
    await s.post("/ui/settings/providers/anthropic/delete", { csrf });
    assert.equal(s.store.provider("anthropic"), undefined);
  });

  test("a rig check runs from the rig page, and its result shows there in words", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    s.env.service.rigChecks.model = {
      run: async () => ({
        ok: false,
        summary: "m failed the tool-call check: no tool call (stop: stop)",
      }),
    };
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(page, /<h2>Checks<\/h2>/);
    assert.match(
      page,
      /<span class="chip">not run yet<\/span><\/span><span class="ck-main"><span><b>Model route<\/b>/,
    );
    const r = await s.post("/ui/commands", {
      csrf: s.csrfFrom(page),
      rig: "rig-a",
      kind: "rig_check",
      check: "model",
      back: "/ui/rigs/rig-a",
    });
    assert.equal(r.status, 303);
    await s.relay(); // delivered: the harness starts the check
    await new Promise((res) => setTimeout(res, 20));
    await s.relay(); // its result reaches control
    const after = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(
      after,
      /<span class="chip bad">failed<\/span><\/span><span class="ck-main"><span><b>Model route<\/b> <span class="muted small">[^<]* ago<\/span><\/span><span class="ck-sum bad">m failed the tool-call check: no tool call/,
    );
    // The page's opening sentence says so, and so does its history.
    assert.match(after, /<b class="bad">Its model route check failed\.<\/b>/);
    assert.match(after, /The model route check FAILED/);
  });

  test("the supervisor's figures, advisor roles included, are accepted and say whether an auditor will decide", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    // The shape the supervisor sends (src/supervisor/main.ts): its stats and its configured roles.
    const r = await s.control.request("/v1/rigs/rig-a/supervisor", {
      method: "POST",
      headers: { authorization: "Bearer rig-token-abcdef", "content-type": "application/json" },
      body: JSON.stringify({
        at: new Date().toISOString(),
        relay: { cursor: 3 },
        export: { remote: false, exports: 1, pushed: [], last_push_at: null, last_error: null },
        advisors: {
          teacher_runs: 2,
          directive_sets: 1,
          directives: 3,
          audits: 0,
          reviews: 0,
          errors: 0,
          tokens_in: 100,
          tokens_out: 20,
          usd: 0,
          roles: { teachers: 2, combiner: true, auditor: false, panel: 0 },
        },
      }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    const sup = s.store.supervisor("rig-a") as { advisors?: { roles?: { auditor?: boolean } } };
    assert.equal(sup.advisors?.roles?.auditor, false);
  });

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
      cpu: { model: "Example CPU", host: 48, usable: 48, quota: 6 },
      memory: { host_mib: 192_000, limit_mib: 12_288 },
      disks: [{ name: "state", total_gib: 200, free_gib: 150 }],
      os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
      toolchain: { cc: "cc 12", nvcc: null },
      errors: [],
    };
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(page, /Tesla P100-PCIE-16GB/);
    assert.match(page, /one for the judge, one for agents' dev runs/);
    assert.match(page, /quota 6 CPU of the host's 48/);
    assert.match(page, /12 GiB limit/);
    // The short version comes first.
    assert.match(page, /<h2>What it runs on<\/h2>/);
    assert.match(page, /<dt>CPU<\/dt><dd>6 of the host/);
    assert.ok(!page.includes("<b>Evil card</b>"));
    assert.match(page, /&lt;b&gt;Evil card/);
    const list = await (await s.get("/ui/rigs")).text();
    assert.match(list, /Tesla P100-PCIE-16GB · &lt;b&gt;Evil card&lt;\/b&gt; · 6 CPU · 12 GiB RAM/);
  });

  test("with only the token's hash, the owner signs in with the token, and the hash signs in no one", async () => {
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      { admin: Credential.ofHash(sha256("admin-token-abcdef")), rigs: {} },
      makeJudgeEnv().keys.privateKeyPem,
    );
    const signIn = (token: string) =>
      control.request("/ui/login", {
        method: "POST",
        body: new URLSearchParams({ token }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    const ok = await signIn("admin-token-abcdef");
    assert.equal(ok.headers.get("location"), "/ui");
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.equal((await control.request("/ui", { headers: { cookie } })).status, 200);
    const hash = await signIn(sha256("admin-token-abcdef"));
    assert.equal(hash.headers.get("location"), "/ui/login");
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
    // Deployed with only the token's hash, control knows the same session.
    const hashed = createControlApi(
      store,
      { admin: Credential.ofHash(sha256("admin-token-abcdef")), rigs: {} },
      keys.privateKeyPem,
    );
    assert.equal(await formToken(hashed), before);
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
    const judged = s.env.explain(id);
    assert.ok(home.includes("Make this change the new champion?"), judged);
    assert.ok(home.includes(id), judged);
    // The decision says, in plain words, what it is about, what the judge found, why it waits and
    // what each choice does.
    assert.match(home, /drop the waste/);
    assert.match(
      home,
      /The judge measured the change again on new runs: \+\d+\.\d% compared with the champion\./,
    );
    assert.match(home, /This rig changes its champion only after you agree/);
    assert.match(home, /The change becomes <b>champion #2<\/b>/);
    assert.match(home, /The champion is the version of the project that the agents start from/);
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
    // The page says the command went, and the decision shows as sent, without its buttons.
    const back = String(ok.headers.get("location"));
    assert.match(back, /sent=Control%20sent%20the%20command%20to%20rig-a/);
    const sent = await (await s.get(back)).text();
    assert.match(
      sent,
      /Control sent the command to rig-a\. The rig does it in less than 10 seconds/,
    );
    const home2 = await (await s.get("/ui")).text();
    assert.match(
      home2,
      /You selected <b>Make it the champion<\/b> [^<]* ago\. Control sent it to the rig\./,
    );
    assert.doesNotMatch(home2, /name="kind" value="approve_promotion"/);
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
    const after = await (await s.get("/ui")).text();
    assert.doesNotMatch(after, /Make this change the new champion\?/);
    assert.match(after, /became champion #2/);
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

  test("Edit rig: the rig's reported settings, and Save sends only what changed", async () => {
    const s = await stack();
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a/edit")).text();
    assert.match(
      page,
      /<input type="checkbox" name="judge" value="1" data-part data-name="Judge" checked>/,
    );
    assert.match(page, /<b>Supervisor<\/b> <span class="pt-state on">on<\/span>/);
    assert.match(page, /<script src="\/ui\/assets\/edit-rig.js" defer>/);
    const labels = page.match(/class="lb"/g)?.length ?? 0;
    const tips = page.match(/class="ii" tabindex="0" data-tip="[^"]+"/g)?.length ?? 0;
    assert.ok(labels > 0 && tips === labels, `${labels} labels, ${tips} with descriptions`);
    // The form as the page sends it: every switch on but the planner, two workers at a time.
    const form: Record<string, string> = { csrf: s.csrfFrom(page), choice: "", harness: "pi" };
    for (const k of ["judge", "workers", "auditor", "teachers", "review", "exports"]) form[k] = "1";
    Object.assign(form, { lanes: "2", trial_minutes: "20", max_turns: "", promotion: "auto" });
    const r = await s.post("/ui/rigs/rig-a/edit", form);
    assert.match(
      decodeURIComponent(String(r.headers.get("location"))),
      /Control sent \d settings to rig-a/,
    );
    const cmd = s.store.listCommands(5).find((c) => c.kind === "rig_settings");
    assert.ok(cmd);
    await s.relay();
    assert.equal(s.env.service.settings.get().planner, false);
    assert.equal(s.env.service.settings.get().lanes, 2);
    await s.relay();
    assert.match(
      await (await s.get("/ui/rigs/rig-a/edit")).text(),
      /name="planner" value="1" data-part data-name="Planner">/,
    );
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

/** Control over the demo seed (no harness): three rigs with decisions waiting and runs at work. */
async function demo() {
  const store = new ControlStore(":memory:");
  seedDemo(store);
  const admin = "admin-token-abcdef";
  const control = createControlApi(
    store,
    { admin, rigs: { "rig-a": "t-a-abcdef", "rig-b": "t-b-abcdef", "rig-c": "t-c-abcdef" } },
    makeJudgeEnv().keys.privateKeyPem,
  );
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: admin }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = async (path: string) => (await control.request(path, { headers: { cookie } })).text();
  const post = (path: string, form: Record<string, string>) =>
    control.request(path, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
  return { store, get, post };
}

describe("control dashboard for an operator", () => {
  test("a waiting promotion and a held audit can each be declined from their card", async () => {
    const { store, get, post } = await demo();
    const home = await get("/ui");
    const forms = [
      ...home.matchAll(
        /<form[^>]*action="\/ui\/commands">(?:(?!<\/form>).)*name="kind" value="decline_promotion"(?:(?!<\/form>).)*<\/form>/gs,
      ),
    ].map((m) => m[0]);
    assert.ok(forms.length >= 2, `decline forms: ${forms.length}`);
    assert.match(
      home,
      /The change does not become the champion\. The record shows that you rejected it\./,
    );
    const field = (form: string, name: string) =>
      new RegExp(`name="${name}" value="([^"]*)"`).exec(form)?.[1] ?? "";
    const form = forms[0] as string;
    const r = await post("/ui/commands", {
      csrf: field(form, "csrf"),
      rig: field(form, "rig"),
      kind: "decline_promotion",
      run: field(form, "run"),
      attempt: field(form, "attempt"),
    });
    assert.equal(r.status, 303);
    const cmd = store
      .pendingCommands(field(form, "rig"))
      .find((c) => c.envelope.kind === "decline_promotion");
    assert.equal(cmd?.envelope.issued_by, "owner:ui");
    assert.deepEqual(cmd?.envelope.payload, {
      run: field(form, "run"),
      attempt: field(form, "attempt"),
    });
  });

  test("every decision shows what it is about, the evidence, why it waits and what each choice does", async () => {
    const { get } = await demo();
    const home = await get("/ui");
    // A goal-campaign attempt held for an audit, on a rig with no auditor.
    assert.match(home, /Make this change the new champion\?/);
    assert.match(home, /Add a dispatch table that picks SIMD routines/);
    assert.match(home, /The filter bank still runs the scalar code\./);
    assert.match(
      home,
      /With this change, the project gets these goals that the champion does not get: vectors, recordings and simd\. It keeps all the goals that the champion gets\./,
    );
    // What changed and why the judge decided, from the record.
    assert.match(
      home,
      /3 files: <code>src\/dispatch\.c<\/code> <span class="muted">\+120 −4<\/span>/,
    );
    assert.match(home, /<code>tests\/vectors\.bin<\/code> <span class="muted">binary<\/span>/);
    assert.match(home, /The judge: newly meets vectors, recordings and simd; loses none/);
    // A confirmed win's interval; a lane at work, with its focus, from trial_started.
    assert.match(
      home,
      /The judge measured the change again on new runs: \+14\.2% compared with the champion\. The correct value is between \+9\.1% and \+19\.6%\./,
    );
    assert.match(home, /vectorize the filter bank so a frame fits its time budget/);
    // Each decision's row leads with what the change does in plain words, then why it waits,
    // then the facts as chips.
    assert.match(
      home,
      /<span class="dq-head">lane-1 changed 3 files\. With this change, the project gets 3 more goals: vectors, recordings and simd\./,
    );
    assert.match(
      home,
      /<span class="dq-why">The agent that made the change wrote 2 problems with it\. This rig has no auditor, thus you must make the decision\.<\/span>/,
    );
    assert.match(home, /<b>\+3 goals<\/b>.*2 problems from the agent.*3 files/s);
    assert.match(home, /<b>\+14\.2%<\/b><\/span><span class="chip">\+9\.1% to \+19\.6%<\/span>/);
    assert.match(
      home,
      /The auditor stopped this change\. Its cause: The change caches the result between calls/,
    );
    assert.match(home, /Problems that the agent wrote/);
    assert.match(
      home,
      /This rig has no auditor\.<\/b> Thus, no one other than you will make the decision\./,
    );
    assert.match(home, /Make it the champion/);
    assert.match(
      home,
      /You make the decision, not an auditor\. The record shows your name\. The change becomes <b>champion #2<\/b>/,
    );
    // Its run was moved to another rig: a promotion there changes only that run.
    assert.match(
      home,
      /This run is <b>paused: moved to rig-b as dec-2<\/b>\. A new champion changes this run only\./,
    );
    // A held audit can be declined; leaving it held is said plainly too.
    assert.match(
      home,
      /The change stays in this list\. No auditor will make the decision for you\./,
    );
    assert.doesNotMatch(home, />Reject</);
    // The auditor's block shows the auditor's reasons, not just the trigger.
    assert.match(home, /Overrule the auditor and make this change the champion\?/);
    assert.match(home, /the benchmark measures a cache hit/);
    assert.match(home, /The audit started because Gain 240\.0% above 100%\./);
    // A confirmed win on a rig that asks for approval.
    assert.match(
      home,
      /\+14\.2% compared with the champion\. The correct value is between \+9\.1% and \+19\.6%\. The first test measured \+15\.2%\./,
    );
    assert.match(home, /The change becomes <b>champion #5<\/b>/);
    // Every decision button is a signed-command form with the session's token: approve (or
    // overrule) and decline, for each of the three decisions.
    const forms = home.match(/<form class="inline" method="post" action="\/ui\/commands">/g) ?? [];
    assert.equal(forms.length, 6);
  });

  test("the overview says what each run is doing now, and what happened, in words", async () => {
    const { get } = await demo();
    const home = await get("/ui");
    // The few numbers first, then one line per lane and for the judge, with how long.
    assert.match(home, /<b>3<\/b><span>need you<\/span>/);
    assert.match(home, /<h2>At work<\/h2>/);
    assert.match(
      home,
      /measuring the rig's own noise \(the champion against itself\)<\/span><span class="br-when">8 min</,
    );
    assert.match(
      home,
      /vectorize the filter bank so a frame fits its time budget <a class="small" href="\/ui\/rigs\/rig-b\/live\?source=trial%3At-0a1b2c3d4e5f6071">watch<\/a><\/span><span class="br-when">1 h 3 min</,
    );
    assert.match(home, /4\/8 goals/);
    // The lists say each campaign and rig in a sentence, then their runs as rows.
    const campaigns = await get("/ui/campaigns");
    assert.match(campaigns, /Its best run meets 4 of 8 goals\. 1 run is at work\./);
    assert.match(
      campaigns,
      /<b>dec-1 <span class="muted small">on rig-a<\/span><\/b><span class="muted small">moved to rig-b as dec-2<\/span>/,
    );
    const rigsList = await get("/ui/rigs");
    assert.match(
      rigsList,
      /The judge is measuring the rig's own noise \(the champion against itself\)\./,
    );
    assert.match(rigsList, /<span class="chip " title="not run yet">· model route<\/span>/);
    // The run's page adds each lane's last step.
    const run = await get("/ui/campaigns/opus-simd?run=rig-b%2Fdec-2");
    assert.match(run, /last: <code>run timeout 270 make -C build bench-decode/);
    // What happened is sentences, not event kinds and IDs.
    assert.match(home, /Run dec-1 paused: moved to rig-b as dec-2\./);
    assert.match(home, /The judge checked champion #1: 4 of 8 goals met\./);
    for (const raw of ["job leased", "attempt lifecycle", "job queued", "promotion blocked"])
      assert.doesNotMatch(home, new RegExp(raw));
  });

  test("an attempt has a page with the change, the judge's findings and its history", async () => {
    const { get } = await demo();
    const page = await get("/ui/rigs/rig-a/attempts/a-7e1a0001");
    assert.match(page, /3c0ffee100112233445566778899aabbccddeeff/);
    assert.match(page, /Only x86 SIMD is covered/);
    assert.match(page, /looked like goal progress; being confirmed on fresh runs/);
    assert.match(page, /confirmed: it meets more goals and loses none/);
    // The history names the change by what it does, linked; its id is the link's title.
    assert.match(
      page,
      /The judge started screening <a href="[^"]+" title="a-7e1a0001">“Add a dispatch table/,
    );
    assert.match(
      page,
      /lane-1 submitted <a href="\/ui\/rigs\/rig-a\/attempts\/a-7e1a0001" title="a-7e1a0001">“Add a dispatch/,
    );
    // It opens with what it does and where it stands, in a sentence.
    assert.match(page, /<h1 class="att-title">Add a dispatch table that picks SIMD routines/);
    assert.match(
      page,
      /lane-1 submitted it [^<]* ago, on champion #1\. The judge did the goal checks again on new runs\. With this change, the project gets these goals that the champion does not get: vectors, recordings and simd/,
    );
    assert.match(page, /It waits for your decision\./);
    // What happened to it, step by step; the goals it moves; its files as bars.
    assert.match(
      page,
      /<span class="st">Held for an audit: the agent that made the change wrote problems with it<\/span>/,
    );
    assert.match(page, /<b>vectors<\/b> <span class="chip ok">newly met<\/span>/);
    assert.match(page, /<code>src\/dispatch\.c<\/code><span class="fl-bar">/);
    // Its decision is on its page too, as a box, without a link back to itself.
    assert.match(page, /<div class="decide decide-warn">/);
    assert.match(page, /Make it the champion/);
    assert.doesNotMatch(page, /Everything about this change/);
    assert.match(await get("/ui/rigs/rig-a/attempts/a-nope"), /No such attempt on this rig/);
  });

  test("a run's views: overview, history in words, and steering that says what each control does", async () => {
    const { get } = await demo();
    const run = await get("/ui/campaigns/opus-simd");
    // The running run is shown first, not the paused one with decisions.
    assert.match(run, /id="rig-b\/dec-2"/);
    assert.match(run, /the judge's check of champion #1/);
    assert.match(run, /waiting on another goal/);
    const history = await get("/ui/campaigns/opus-simd?run=rig-b%2Fdec-2&view=history");
    assert.match(
      history,
      /The planner planned epoch 1: lane-1 on filter-bank; lane-2 on range-decoder\./,
    );
    const steering = await get("/ui/campaigns/sum-speed?run=rig-c%2Fsum-1&view=steering");
    assert.match(steering, /The lanes' running trials stop and no new ones start/);
    assert.match(steering, /every lane starts again from the champion/);
    assert.match(steering, /blocked by the auditor/);
    const attempts = await get("/ui/campaigns/sum-speed?run=rig-c%2Fsum-1&view=attempts");
    assert.match(attempts, /waiting for your approval/);
    assert.match(attempts, /href="\/ui\/rigs\/rig-c\/attempts\/a-5b5b0001"/);
  });

  test("agent-written text in decisions, timelines and attempt pages is escaped", async () => {
    const { store, get } = await demo();
    const at = new Date().toISOString();
    store.ingest({
      rig: "rig-a",
      ledger_id: "ledger-rig-a",
      cursor: 0,
      next: 1000,
      events: [
        {
          id: 900,
          at,
          actor: "harness",
          kind: "attempt_recorded",
          subject: "a-evil0001",
          body: {
            run: "dec-1",
            lane: "lane-1",
            lifecycle: "queued",
            commit: "e".repeat(40),
            parent: "f".repeat(40),
            hypothesis: "<img src=x onerror=alert(1)> faster",
            known_flaws: ["<script>alert(2)</script>"],
          },
        },
        {
          id: 901,
          at,
          actor: "harness",
          kind: "audit_requested",
          subject: "a-evil0001",
          body: { audit: 9, run: "dec-1", reason: "declared flaws", expected_seq: 1 },
        },
      ],
      summary: {},
    });
    for (const path of ["/ui", "/ui/rigs/rig-a/attempts/a-evil0001", "/ui/rigs/rig-a"]) {
      const html = await get(path);
      assert.ok(!html.includes("<img src=x"), path);
      assert.ok(!html.includes("<script>alert(2)"), path);
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; faster/, path);
    }
  });
});
