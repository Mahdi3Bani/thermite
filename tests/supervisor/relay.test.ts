import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { createControlApi } from "../../src/control/api.ts";
import { issueCommand } from "../../src/control/issue.ts";
import { ControlStore, fingerprint } from "../../src/control/store.ts";
import { generateSigningKeys, signEnvelope } from "../../src/core/commands.ts";
import { createHarnessApi } from "../../src/harness/api.ts";
import { relayOnce } from "../../src/supervisor/relay.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { otherKind } from "../helpers/kinds.ts";

describe("supervisor relay between control and harness", () => {
  test("commands flow control -> supervisor -> harness and events flow back exactly once", async () => {
    const env = makeHarnessEnv("rig-a");
    const harnessTokens = { supervisor: "sup-token-abcdef", proposer: "prop-token-abcdef" };
    const harness = createHarnessApi(env.service, harnessTokens);
    const store = new ControlStore(":memory:");
    const controlTokens = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };
    const control = createControlApi(store, controlTokens, env.keys.privateKeyPem);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const app = url.host === "harness" ? harness : control;
      return app.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    const cfg = {
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: harnessTokens.supervisor,
      controlUrl: "http://control",
      controlToken: controlTokens.rigs["rig-a"],
      fetchImpl,
    };
    const adminHeaders = {
      authorization: `Bearer ${controlTokens.admin}`,
      "content-type": "application/json",
    };

    const issued = await control.request("/v1/commands", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        rig: "rig-a",
        kind: "assign_campaign",
        payload: env.assignPayload(),
      }),
    });
    assert.equal(issued.status, 201);
    const { id } = (await issued.json()) as { id: string };

    // With its commands left to their own loop, a report round does not deliver them.
    let state = await relayOnce({ ...cfg, skipCommands: true }, { cursor: 0 });
    assert.equal(store.command(id)?.status, "pending");
    state = await relayOnce(cfg, state);
    assert.equal(store.command(id)?.status, "delivered");
    assert.equal(env.service.ledger.getRun("smoke-1")?.status, "running");

    state = await relayOnce(cfg, state);
    const events = store.events("rig-a", 0, 10_000) as { id: number; kind: string }[];
    assert.equal(events.length, env.service.ledger.latestEventId());
    assert.ok(events.some((e) => e.kind === "run_created"));
    assert.equal(
      store.ingest({
        rig: "rig-a",
        ledger_id: env.service.ledger.ledgerId(),
        cursor: 0,
        next: 1,
        events: [events[0] as never],
        summary: {},
      }),
      0,
    );

    const foreign = generateSigningKeys();
    store.enqueueCommand(
      signEnvelope(
        {
          v: 1,
          id: randomUUID(),
          rig: "rig-a",
          kind: "pause_run",
          issued_by: "someone",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          payload: { run: "smoke-1", reason: "forged" },
        },
        foreign.privateKeyPem,
      ),
    );
    await relayOnce(cfg, state);
    const statuses = store.db
      .prepare("select kind, status from command order by issued_at")
      .all() as { kind: string; status: string }[];
    assert.deepEqual(
      statuses.map((s) => s.status),
      ["delivered", "rejected"],
    );
    assert.equal(env.service.ledger.getRun("smoke-1")?.status, "running");
  });

  test("a command whose content could not be fetched fails with the reason, and never reaches the harness", async () => {
    const env = makeHarnessEnv("rig-a");
    const harness = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } },
      env.keys.privateKeyPem,
    );
    let harnessCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "harness" && url.pathname === "/v1/commands") harnessCalls++;
      const app = url.host === "harness" ? harness : control;
      return app.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    const issued = await control.request("/v1/commands", {
      method: "POST",
      headers: { authorization: "Bearer admin-token-abcdef", "content-type": "application/json" },
      body: JSON.stringify({ rig: "rig-a", kind: "assign_campaign", payload: env.assignPayload() }),
    });
    const { id } = (await issued.json()) as { id: string };
    let asked = 0;
    const cfg = {
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: "sup-token-abcdef",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      fetchImpl,
      stage: async () =>
        ++asked === 1 ? ("wait" as const) : { failed: "staging: the repository has no commit" },
    };
    const state = await relayOnce(cfg, { cursor: 0 });
    assert.equal(store.command(id)?.status, "pending", "it waits while its content is fetched");
    await relayOnce(cfg, state);
    const cmd = store.command(id) as { status: string; outcome: unknown };
    assert.equal(cmd.status, "failed");
    assert.match(JSON.stringify(cmd.outcome), /staging: the repository has no commit/);
    assert.equal(harnessCalls, 0);
    assert.equal(env.service.ledger.getRun("smoke-1"), undefined);
  });

  test("a command that waits for its sources is fetched whole once, then by its id (goal 171)", async () => {
    const env = makeHarnessEnv("rig-a");
    const harness = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } },
      env.keys.privateKeyPem,
    );
    // What each fetch of the pending commands carried, in bytes.
    const sizes: number[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const app = url.host === "harness" ? harness : control;
      const res = await app.request(`${url.pathname}${url.search}`, init as RequestInit);
      if (!url.pathname.endsWith("/commands/pending")) return res;
      const body = await res.text();
      sizes.push(body.length);
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const issued = await control.request("/v1/commands", {
      method: "POST",
      headers: { authorization: "Bearer admin-token-abcdef", "content-type": "application/json" },
      body: JSON.stringify({ rig: "rig-a", kind: "assign_campaign", payload: env.assignPayload() }),
    });
    const { id } = (await issued.json()) as { id: string };
    let ready = false;
    const cfg = {
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: "sup-token-abcdef",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      fetchImpl,
      held: new Map(),
      stage: async () => (ready ? ("ready" as const) : ("wait" as const)),
    };
    let state = await relayOnce(cfg, { cursor: 0 });
    state = await relayOnce(cfg, state);
    state = await relayOnce(cfg, state);
    assert.equal(store.command(id)?.status, "pending", "it waits for its sources");
    const [whole = 0, ...ids] = sizes;
    assert.ok(whole > 1000, `the first fetch carries the command (${whole} bytes)`);
    assert.deepEqual(ids, [ids[0], ids[0]]);
    assert.ok((ids[0] ?? 0) < 100, `then only its id (${ids[0]} bytes)`);
    // Its sources arrive: the command it holds is delivered, and leaves what it holds.
    ready = true;
    state = await relayOnce(cfg, state);
    assert.equal(store.command(id)?.status, "delivered");
    assert.equal(env.service.ledger.getRun("smoke-1")?.status, "running");
    await relayOnce(cfg, state);
    assert.equal(cfg.held.size, 0);
  });

  test("an assignment whose sources take longer than its life stays alive while they stage (goal 171)", async () => {
    const env = makeHarnessEnv("rig-a");
    const harness = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } },
      env.keys.privateKeyPem,
    );
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const app = url.host === "harness" ? harness : control;
      return app.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    // A life of under two seconds stands in for an hour, and a slow model download for longer.
    const { id } = issueCommand(store, env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: env.assignPayload(),
      ttlMinutes: 0.03,
      issuedBy: "owner:test",
    });
    let ready = false;
    const cfg = {
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: "sup-token-abcdef",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      fetchImpl,
      held: new Map(),
      staging: new Set<string>(),
      stage: async () => (ready ? ("ready" as const) : ("wait" as const)),
    };
    let state = await relayOnce(cfg, { cursor: 0 });
    state = await relayOnce(cfg, state);
    await new Promise((r) => setTimeout(r, 2000));
    state = await relayOnce(cfg, state);
    assert.equal(store.command(id)?.status, "pending", "alive while its sources stage");
    assert.ok(
      store.listAudit(20).some((a) => a.action === "command_renewed"),
      "the renewal is in the audit log",
    );
    ready = true;
    await relayOnce(cfg, state);
    assert.equal(store.command(id)?.status, "delivered");
    assert.equal(env.service.ledger.getRun("smoke-1")?.status, "running");
  });

  test("a reset harness ledger restarts the cursor, and control keeps both ledgers' events", async () => {
    const store = new ControlStore(":memory:");
    const controlTokens = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };
    const control = createControlApi(store, controlTokens, generateSigningKeys().privateKeyPem);
    const harnessTokens = { supervisor: "sup-token-abcdef" };
    let harness = createHarnessApi(makeHarnessEnv("rig-a").service, harnessTokens);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const app = url.host === "harness" ? harness : control;
      return app.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    const cfg = {
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: harnessTokens.supervisor,
      controlUrl: "http://control",
      controlToken: controlTokens.rigs["rig-a"],
      fetchImpl,
    };
    const first = makeHarnessEnv("rig-a");
    harness = createHarnessApi(first.service, harnessTokens);
    for (let i = 0; i < 5; i++)
      first.service.ledger.appendEvent("t", otherKind("old"), null, { i });
    const state = await relayOnce(cfg, { cursor: 0 });
    assert.equal(state.cursor, 5);

    const wiped = makeHarnessEnv("rig-a"); // a fresh ledger: event ids start at 1 again
    harness = createHarnessApi(wiped.service, harnessTokens);
    for (let i = 0; i < 3; i++)
      wiped.service.ledger.appendEvent("t", otherKind("new"), null, { i });
    // A wiped harness also has a new signing key: control holds it until the owner accepts.
    await assert.rejects(relayOnce(cfg, state), /409/);
    // The owner accepts the key whose fingerprint they checked.
    const pending = fingerprint(String(store.rigKey("rig-a").pending));
    const accept = await control.request(`/v1/rigs/rig-a/key/accept?fingerprint=${pending}`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlTokens.admin}` },
    });
    assert.equal(accept.status, 200);
    const after = await relayOnce(cfg, state);
    assert.equal(after.cursor, 3);
    assert.equal(after.ledgerId, wiped.service.ledger.ledgerId());
    const kinds = (store.events("rig-a", 0, 100) as { kind: string }[]).map((e) => e.kind);
    assert.deepEqual(kinds, ["old", "old", "old", "old", "old", "new", "new", "new"]);
  });

  test("a supervisor cannot forge or alter a harness report", async () => {
    const env = makeHarnessEnv("rig-a");
    const store = new ControlStore(":memory:");
    const tokens = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };
    const control = createControlApi(store, tokens, env.keys.privateKeyPem);
    env.service.ledger.appendEvent("t", otherKind("real"), null, {});
    const snap = env.service.snapshot(0, 100) as Record<string, unknown>;
    const post = (body: unknown) =>
      control.request("/v1/rigs/rig-a/ingest", {
        method: "POST",
        headers: { authorization: "Bearer rig-token-abcdef", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post(snap)).status, 200);
    const events = snap.events as { id: number; kind: string }[];
    const forged = {
      ...snap,
      next: Number(snap.next) + 1,
      events: [
        ...events,
        {
          id: Number(snap.next) + 1,
          at: new Date().toISOString(),
          actor: "judge",
          kind: "champion_promoted",
          subject: "smoke-1",
          body: { seq: 99 },
        },
      ],
    };
    assert.equal((await post(forged)).status, 403);
    const { signature: _s, ...unsigned } = snap;
    assert.equal((await post(unsigned)).status, 400);
    const kinds = (store.events("rig-a", 0, 100) as { kind: string }[]).map((e) => e.kind);
    assert.ok(!kinds.includes("champion_promoted"));
  });

  test("a rig token cannot report for another rig or read admin views", async () => {
    const store = new ControlStore(":memory:");
    const tokens = {
      admin: "admin-token-abcdef",
      rigs: { "rig-a": "rig-token-aaaaaa", "rig-b": "rig-token-bbbbbb" },
    };
    const control = createControlApi(store, tokens, generateSigningKeys().privateKeyPem);
    const asA = { authorization: "Bearer rig-token-aaaaaa", "content-type": "application/json" };
    const body = JSON.stringify({
      rig: "rig-b",
      ledger_id: "l",
      cursor: 0,
      next: 0,
      events: [],
      summary: {},
      generated_at: new Date().toISOString(),
      latest_event: 0,
    });
    assert.equal(
      (await control.request("/v1/rigs/rig-b/ingest", { method: "POST", headers: asA, body }))
        .status,
      401,
    );
    assert.equal(
      (await control.request("/v1/rigs/rig-a/ingest", { method: "POST", headers: asA, body }))
        .status,
      403,
    );
    assert.equal((await control.request("/v1/rigs", { headers: asA })).status, 401);
  });
});
