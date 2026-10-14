import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { createControlApi } from "../control/api.ts";
import { ControlStore } from "../control/store.ts";
import { generateSigningKeys, signEnvelope } from "../core/commands.ts";
import { createHarnessApi } from "../harness/api.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { relayOnce } from "./relay.ts";

describe("supervisor relay between control and harness", () => {
  test("commands flow control -> supervisor -> harness and events flow back exactly once", async () => {
    const env = makeHarnessEnv("unit-a");
    const harnessTokens = { supervisor: "sup-token-abcdef", proposer: "prop-token-abcdef" };
    const harness = createHarnessApi(env.service, harnessTokens);
    const store = new ControlStore(":memory:");
    const controlTokens = { admin: "admin-token-abcdef", units: { "unit-a": "unit-token-abcdef" } };
    const control = createControlApi(store, controlTokens, env.keys.privateKeyPem);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const app = url.host === "harness" ? harness : control;
      return app.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    const cfg = {
      unit: "unit-a",
      harnessUrl: "http://harness",
      harnessToken: harnessTokens.supervisor,
      controlUrl: "http://control",
      controlToken: controlTokens.units["unit-a"],
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
        unit: "unit-a",
        kind: "assign_campaign",
        payload: env.assignPayload(),
      }),
    });
    assert.equal(issued.status, 201);
    const { id } = (await issued.json()) as { id: string };

    let state = await relayOnce(cfg, { cursor: 0 });
    assert.equal(store.command(id)?.status, "delivered");
    assert.equal(env.service.ledger.getInstance("smoke-1")?.status, "running");

    state = await relayOnce(cfg, state);
    const events = store.events("unit-a", 0, 10_000) as { id: number; kind: string }[];
    assert.equal(events.length, env.service.ledger.latestEventId());
    assert.ok(events.some((e) => e.kind === "instance_created"));
    assert.equal(
      store.ingest({
        unit: "unit-a",
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
          unit: "unit-a",
          kind: "pause_instance",
          issued_by: "someone",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          payload: { instance: "smoke-1", reason: "forged" },
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
    assert.equal(env.service.ledger.getInstance("smoke-1")?.status, "running");
  });

  test("a reset harness ledger restarts the cursor, and control keeps both ledgers' events", async () => {
    const store = new ControlStore(":memory:");
    const controlTokens = { admin: "admin-token-abcdef", units: { "unit-a": "unit-token-abcdef" } };
    const control = createControlApi(store, controlTokens, generateSigningKeys().privateKeyPem);
    const harnessTokens = { supervisor: "sup-token-abcdef" };
    let harness = createHarnessApi(makeHarnessEnv("unit-a").service, harnessTokens);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const app = url.host === "harness" ? harness : control;
      return app.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    const cfg = {
      unit: "unit-a",
      harnessUrl: "http://harness",
      harnessToken: harnessTokens.supervisor,
      controlUrl: "http://control",
      controlToken: controlTokens.units["unit-a"],
      fetchImpl,
    };
    const first = makeHarnessEnv("unit-a");
    harness = createHarnessApi(first.service, harnessTokens);
    for (let i = 0; i < 5; i++) first.service.ledger.appendEvent("t", "old", null, { i });
    const state = await relayOnce(cfg, { cursor: 0 });
    assert.equal(state.cursor, 5);

    const wiped = makeHarnessEnv("unit-a"); // a fresh ledger: event ids start at 1 again
    harness = createHarnessApi(wiped.service, harnessTokens);
    for (let i = 0; i < 3; i++) wiped.service.ledger.appendEvent("t", "new", null, { i });
    // A wiped harness also has a new signing key: control holds it until the owner accepts.
    await assert.rejects(relayOnce(cfg, state), /409/);
    const accept = await control.request("/v1/units/unit-a/key/accept", {
      method: "POST",
      headers: { authorization: `Bearer ${controlTokens.admin}` },
    });
    assert.equal(accept.status, 200);
    const after = await relayOnce(cfg, state);
    assert.equal(after.cursor, 3);
    assert.equal(after.ledgerId, wiped.service.ledger.ledgerId());
    const kinds = (store.events("unit-a", 0, 100) as { kind: string }[]).map((e) => e.kind);
    assert.deepEqual(kinds, ["old", "old", "old", "old", "old", "new", "new", "new"]);
  });

  test("a supervisor cannot forge or alter a harness report", async () => {
    const env = makeHarnessEnv("unit-a");
    const store = new ControlStore(":memory:");
    const tokens = { admin: "admin-token-abcdef", units: { "unit-a": "unit-token-abcdef" } };
    const control = createControlApi(store, tokens, env.keys.privateKeyPem);
    env.service.ledger.appendEvent("t", "real", null, {});
    const snap = env.service.snapshot(0, 100) as Record<string, unknown>;
    const post = (body: unknown) =>
      control.request("/v1/units/unit-a/ingest", {
        method: "POST",
        headers: { authorization: "Bearer unit-token-abcdef", "content-type": "application/json" },
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
    const kinds = (store.events("unit-a", 0, 100) as { kind: string }[]).map((e) => e.kind);
    assert.ok(!kinds.includes("champion_promoted"));
  });

  test("a unit token cannot report for another unit or read admin views", async () => {
    const store = new ControlStore(":memory:");
    const tokens = {
      admin: "admin-token-abcdef",
      units: { "unit-a": "unit-token-aaaaaa", "unit-b": "unit-token-bbbbbb" },
    };
    const control = createControlApi(store, tokens, generateSigningKeys().privateKeyPem);
    const asA = { authorization: "Bearer unit-token-aaaaaa", "content-type": "application/json" };
    const body = JSON.stringify({
      unit: "unit-b",
      ledger_id: "l",
      cursor: 0,
      next: 0,
      events: [],
      summary: {},
    });
    assert.equal(
      (await control.request("/v1/units/unit-b/ingest", { method: "POST", headers: asA, body }))
        .status,
      401,
    );
    assert.equal(
      (await control.request("/v1/units/unit-a/ingest", { method: "POST", headers: asA, body }))
        .status,
      403,
    );
    assert.equal((await control.request("/v1/units", { headers: asA })).status, 401);
  });
});
