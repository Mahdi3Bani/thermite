import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { createHarnessApi } from "../harness/api.ts";
import { verifyExport } from "../supervisor/git-export.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { createControlApi } from "./api.ts";
import { issueCommand } from "./issue.ts";
import { ControlStore, fingerprint } from "./store.ts";

const tokens = { admin: "admin-token-abcdef", units: { "unit-a": "unit-token-abcdef" } };
const unitHeaders = {
  authorization: "Bearer unit-token-abcdef",
  "content-type": "application/json",
};

describe("signed reports at control", () => {
  test("stale reports, gaps and reports from a ledger the unit left are refused", async () => {
    const env = makeHarnessEnv("unit-a");
    const store = new ControlStore(":memory:");
    const control = createControlApi(store, tokens, env.keys.privateKeyPem);
    const post = (body: unknown) =>
      control.request("/v1/units/unit-a/ingest", {
        method: "POST",
        headers: unitHeaders,
        body: JSON.stringify(body),
      });
    env.service.ledger.appendEvent("t", "one", null, {});
    const old = env.service.snapshot(0, 100) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 10));
    env.service.ledger.appendEvent("t", "two", null, {});
    const fresh = env.service.snapshot(0, 100) as Record<string, unknown>;
    assert.equal((await post(fresh)).status, 200);
    // An older report (a replay) is refused: the unit cannot be frozen in an old state.
    const replay = await post(old);
    assert.equal(replay.status, 409);
    // A page that starts past what control has is a gap.
    env.service.ledger.appendEvent("t", "three", null, {});
    env.service.ledger.appendEvent("t", "four", null, {});
    const ahead = env.service.snapshot(Number(fresh.next) + 1, 100) as Record<string, unknown>;
    const gap = await post(ahead);
    assert.equal(gap.status, 409);
    assert.equal(((await gap.json()) as { expected_cursor: number }).expected_cursor, fresh.next);
    const kinds = (store.events("unit-a", 0, 100) as { kind: string }[]).map((e) => e.kind);
    assert.deepEqual(kinds, ["one", "two"]);
    // A unit that moved to a new ledger never goes back to the one it left.
    const base = { unit: "unit-a", cursor: 0, next: 0, events: [], summary: {} };
    store.ingest({ ...base, ledger_id: "ledger-new", generated_at: new Date().toISOString() });
    const back = store.reportCheck("unit-a", {
      ledgerId: String(fresh.ledger_id),
      cursor: 0,
      generatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    assert.equal(back.ok, false);
  });

  test("with owner acceptance required, a unit's first key is held, and only the checked one is accepted", async () => {
    const env = makeHarnessEnv("unit-a");
    const store = new ControlStore(":memory:");
    const control = createControlApi(store, tokens, env.keys.privateKeyPem, {
      staleAfterMs: 180_000,
      requireKeyAcceptance: true,
    });
    const snap = env.service.snapshot(0, 100);
    const post = () =>
      control.request("/v1/units/unit-a/ingest", {
        method: "POST",
        headers: unitHeaders,
        body: JSON.stringify(snap),
      });
    assert.equal((await post()).status, 409);
    assert.equal(store.unitKey("unit-a").pubkey, null);
    const wrong = await control.request("/v1/units/unit-a/key/accept?fingerprint=0000", {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    assert.equal(wrong.status, 404);
    const fp = fingerprint(String(store.unitKey("unit-a").pending));
    const ok = await control.request(`/v1/units/unit-a/key/accept?fingerprint=${fp}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    assert.equal(ok.status, 200);
    assert.equal((await post()).status, 200);
  });
});

describe("the command queue", () => {
  test("expired commands are not relayed; the owner can cancel one; commands go through when reporting fails", async () => {
    const env = makeHarnessEnv("unit-a");
    const store = new ControlStore(":memory:");
    store.setConfiguredUnits(["unit-a"]);
    const control = createControlApi(store, tokens, env.keys.privateKeyPem);
    const expired = issueCommand(store, env.keys.privateKeyPem, {
      unit: "unit-a",
      kind: "export_now",
      payload: {},
      ttlMinutes: 1,
      issuedBy: "owner:test",
    });
    store.db
      .prepare(
        "update command set signed = json_set(signed, '$.envelope.expires_at', ?) where id = ?",
      )
      .run(new Date(Date.now() - 60_000).toISOString(), expired.id);
    const cancel = issueCommand(store, env.keys.privateKeyPem, {
      unit: "unit-a",
      kind: "export_now",
      payload: {},
      issuedBy: "owner:test",
    });
    const r = await control.request(`/v1/commands/${cancel.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    assert.equal(r.status, 200);
    const keep = issueCommand(store, env.keys.privateKeyPem, {
      unit: "unit-a",
      kind: "export_now",
      payload: {},
      issuedBy: "owner:test",
    });
    assert.deepEqual(
      store.pendingCommands("unit-a").map((c) => c.envelope.id),
      [keep.id],
    );
    assert.equal(store.command(expired.id)?.status, "expired");
    // Reporting fails (control refuses every report), yet the command is relayed and applied.
    const harness = createHarnessApi(env.service, { supervisor: "sup" });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/ingest")) return new Response("{}", { status: 500 });
      const app = url.host === "harness" ? harness : control;
      return app.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    await assert.rejects(
      relayOnce(
        {
          unit: "unit-a",
          harnessUrl: "http://harness",
          harnessToken: "sup",
          controlUrl: "http://control",
          controlToken: "unit-token-abcdef",
          fetchImpl,
        },
        { cursor: 0 },
      ),
    );
    assert.equal(store.command(keep.id)?.status, "delivered");
  });

  test("a command too large to deliver is refused when it is issued", () => {
    const store = new ControlStore(":memory:");
    store.setConfiguredUnits(["unit-a"]);
    assert.throws(
      () =>
        issueCommand(store, generateSigningKeys().privateKeyPem, {
          unit: "unit-a",
          kind: "pause_instance",
          payload: { instance: "i-1", reason: "x".repeat(4 * 1024 * 1024) },
          issuedBy: "owner:test",
        }),
      /too large/,
    );
  });
});

describe("exports", () => {
  test("a link or an unlisted file in an export is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-exp-"));
    mkdirSync(join(dir, "attempts"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        from_event: 0,
        through_event: 1,
        files: { "events.jsonl": "0".repeat(64) },
      }),
    );
    symlinkSync("/etc/hosts", join(dir, "events.jsonl"));
    const r = verifyExport(dir);
    assert.equal(r.manifest, undefined);
    assert.match(r.problems.join(";"), /not a regular file/);
    const dir2 = mkdtempSync(join(tmpdir(), "thermite-exp-"));
    writeFileSync(
      join(dir2, "manifest.json"),
      JSON.stringify({ from_event: 0, through_event: 1, files: {} }),
    );
    writeFileSync(join(dir2, "events.jsonl"), "");
    assert.match(verifyExport(dir2).problems.join(";"), /events.jsonl is not in the manifest/);
  });
});
