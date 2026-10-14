import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { createHarnessApi } from "../harness/api.ts";
import { WIPE_MARKER, wipeIfRequested } from "../harness/service.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../testing/judge-env.ts";
import { propagateChampion } from "./issue.ts";
import {
  advanceResets,
  ComposeDriver,
  confirmReset,
  type DeploymentDriver,
  KubernetesDriver,
} from "./lifecycle.ts";
import { ControlStore } from "./store.ts";
import { leaderboard } from "./views.ts";

function fakeServer(
  handler: (method: string, url: string, headers: Record<string, unknown>) => [number, unknown],
) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const [status, body] = handler(String(req.method), String(req.url), req.headers);
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(body === undefined ? "" : JSON.stringify(body));
  });
  return { server, seen };
}

describe("deployment drivers", () => {
  test("Kubernetes: the unit's pods are found by label in its namespace and deleted", async () => {
    let auth = "";
    const { server, seen } = fakeServer((method, url, headers) => {
      auth = String(headers.authorization ?? "");
      if (method === "GET") {
        const harness = url.includes("component%3Dharness");
        return [
          200,
          { items: [{ metadata: { name: harness ? "harness-abc" : "supervisor-def" } }] },
        ];
      }
      return [200, {}];
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const d = new KubernetesDriver({
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "sa-token",
      namespaceTemplate: "ar-{unit}",
      selectors: {
        harness: "app.kubernetes.io/component=harness",
        supervisor: "app.kubernetes.io/component=supervisor",
      },
    });
    assert.deepEqual(await d.restart("gpu-unit-1", ["harness", "supervisor"]), [
      "ar-gpu-unit-1/harness-abc",
      "ar-gpu-unit-1/supervisor-def",
    ]);
    assert.equal(auth, "Bearer sa-token");
    assert.ok(seen.includes("DELETE /api/v1/namespaces/ar-gpu-unit-1/pods/harness-abc"));
    await assert.rejects(d.restart("../kube-system", ["harness"]), /not a unit name/);
    server.close();
  });

  test("compose: the unit's services are restarted through the engine's socket", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "thermite-eng-")), "engine.sock");
    const { server, seen } = fakeServer((method) =>
      method === "GET" ? [200, [{ Id: "c0ffee" }]] : [204, undefined],
    );
    await new Promise<void>((r) => server.listen(sock, r));
    const d = new ComposeDriver({
      socketPath: sock,
      project: "thermite",
      services: { "local-2": { harness: "harness-2", supervisor: "supervisor-2" } },
    });
    assert.deepEqual(await d.restart("local-2", ["harness"]), ["harness-2"]);
    assert.ok(seen.some((s) => s.startsWith("GET /containers/json") && s.includes("harness-2")));
    assert.ok(seen.includes("POST /containers/c0ffee/restart?t=10"));
    await assert.rejects(d.restart("local-9", ["harness"]), /no harness service/);
    server.close();
  });
});

describe("full reset", () => {
  test("pause, export, verified push, wipe, restart; the harness starts again with a fresh ledger", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    let wiped = false;
    env.service.onWipe = () => {
      wiped = true;
    };
    const harnessTokens = { supervisor: "sup", proposer: "prop" };
    const harness = createHarnessApi(env.service, harnessTokens);
    const store = new ControlStore(":memory:");
    store.setConfiguredUnits(["unit-a"]);
    const { createControlApi } = await import("./api.ts");
    const control = createControlApi(
      store,
      { admin: "adm", units: { "unit-a": "unit-tok" } },
      env.keys.privateKeyPem,
    );
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const app = url.host === "harness" ? harness : control;
      return app.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    const relay = {
      unit: "unit-a",
      harnessUrl: "http://harness",
      harnessToken: "sup",
      controlUrl: "http://control",
      controlToken: "unit-tok",
      fetchImpl,
    };
    let rs = await relayOnce(relay, { cursor: 0 });
    const restarts: string[] = [];
    const driver: DeploymentDriver = {
      kind: "fake",
      restart: async (unit, components) => {
        restarts.push(`${unit}:${components.join(",")}`);
        return components;
      },
    };
    const step = () =>
      advanceResets({
        store,
        privateKeyPem: env.keys.privateKeyPem,
        driver,
        staleAfterMs: 180_000,
      });
    const state = () => String(store.openReset("unit-a")?.state ?? store.resets(1)[0]?.state);
    const id = store.createReset("unit-a", "owner:test");
    await step();
    assert.equal(state(), "quiescing");
    rs = await relayOnce(relay, rs); // the pause reaches the harness; the unit reports idle
    assert.equal(env.ledger.getInstance("js-1")?.status, "paused");
    await step();
    assert.equal(state(), "exporting");
    rs = await relayOnce(relay, rs); // the full export (the supervisor's acknowledgement)
    await step();
    assert.equal(state(), "exporting", "waits for the harness's own record of the export");
    rs = await relayOnce(relay, rs); // the harness's signed report carries it
    await step();
    assert.equal(state(), "verifying");
    const name = String(store.openReset("unit-a")?.export_name);
    await step();
    assert.equal(state(), "verifying", "waits until the supervisor reports the export pushed");
    store.setSupervisor("unit-a", {
      export: { remote: true, pushed: [name], pushed_commit: "c".repeat(40) },
    });
    await step();
    assert.equal(state(), "awaiting_owner", "the owner checks the pushed commit and confirms");
    assert.match(String(store.openReset("unit-a")?.detail), /c{40}/);
    confirmReset(store, id, "owner:test");
    await step();
    assert.equal(state(), "wiping");
    rs = await relayOnce(relay, rs);
    assert.ok(existsSync(join(env.paths.stateDir, WIPE_MARKER)));
    rs = await relayOnce(relay, rs); // the harness's record of the wipe
    await step();
    assert.equal(state(), "done");
    assert.deepEqual(restarts, ["unit-a:harness,supervisor"]);
    await new Promise((r) => setTimeout(r, 2200));
    assert.ok(wiped, "the controller is told to exit");
    const before = env.ledger.ledgerId();
    env.ledger.close();
    // A locked build tree (as the build store leaves them) does not stop the wipe.
    const locked = join(env.paths.stateDir, "builds", "locked", "sub");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o555);
    chmodSync(join(env.paths.stateDir, "builds", "locked"), 0o555);
    assert.ok(wipeIfRequested(env.paths, ["unit-signing.key", "unit-signing.key.pub"]));
    assert.ok(!existsSync(join(env.paths.stateDir, "builds")));
    assert.ok(!existsSync(join(env.paths.stateDir, "ledger", "ledger.db")));
    const { Ledger } = await import("../harness/ledger.ts");
    const fresh = Ledger.open(join(env.paths.stateDir, "ledger", "ledger.db"));
    assert.notEqual(fresh.ledgerId(), before);
    fresh.close();
  });

  test("the harness refuses a wipe when research was recorded after the verified export", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const plain = await env.service.export("t");
    const notFull = await env.service.applyCommand(
      env.sign("wipe_state", {
        confirm: "wipe",
        export: String(plain.dir.split("/").pop()),
        through_event: 0,
      }),
    );
    assert.ok(notFull.status === "applied" && !notFull.accepted);
    assert.match(JSON.stringify(notFull.result), /not a full export/);
    const exp = await env.service.export("t", { full: true });
    await env.service.submitAttempt(
      {
        instance: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "late",
        known_flaws: [],
      },
      "t",
    );
    const r = await env.service.applyCommand(
      env.sign("wipe_state", {
        confirm: "wipe",
        export: String(exp.dir.split("/").pop()),
        through_event: 0,
      }),
    );
    assert.ok(r.status === "applied" && !r.accepted);
    assert.match(JSON.stringify(r.result), /research was recorded after the export/);
    assert.ok(!existsSync(join(env.paths.stateDir, WIPE_MARKER)));
  });
});

describe("leaderboard and propagation", () => {
  test("a champion is cross-verified once another unit's judge accepted it", () => {
    const store = new ControlStore(":memory:");
    const ev = (id: number, kind: string, subject: string, body: unknown) => ({
      id,
      at: new Date(Date.now() + id).toISOString(),
      actor: "t",
      kind,
      subject,
      body,
    });
    store.ingest({
      unit: "unit-a",
      ledger_id: "la",
      cursor: 0,
      next: 6,
      summary: {},
      events: [
        ev(1, "instance_created", "c-1", {
          campaign: "camp",
          mode: "hill_climb",
          seed: { repo: "proj", commit: "s" },
        }),
        ev(2, "attempt_recorded", "a-1", { instance: "c-1", lane: null, lifecycle: "queued" }),
        ev(3, "verdict", "a-1", { verdict: "win_confirmed", delta: 0.2 }),
        ev(5, "champion_promoted", "c-1", { seq: 2, attempt: "a-1", commit: "c2" }),
        ev(6, "champion_published", "c-1", {
          seq: 2,
          repo: "proj",
          base_commit: "a".repeat(40),
          tree: "b".repeat(40),
          sha256: "f".repeat(64),
          path: "champions/c-1/2.patch",
        }),
      ],
    });
    store.ingest({
      unit: "unit-b",
      ledger_id: "lb",
      cursor: 0,
      next: 3,
      summary: {},
      events: [
        ev(1, "instance_created", "c-1", {
          campaign: "camp",
          mode: "hill_climb",
          seed: { repo: "proj", commit: "s" },
        }),
        ev(2, "propagation_received", "c-1", {
          tree: "b".repeat(40),
          attempt: "p-1",
          source_unit: "unit-a",
          source_instance: "c-1",
          source_seq: 2,
        }),
        ev(3, "propagation_accepted", "c-1", {
          attempt: "p-1",
          source_unit: "unit-a",
          source_instance: "c-1",
          source_seq: 2,
          verdict: "win_confirmed",
        }),
      ],
    });
    const board = leaderboard(store, { staleAfterMs: 180_000 });
    const a = board.camp?.find((r) => r.unit === "unit-a");
    assert.deepEqual(a?.verified_by, ["unit-b"]);
    assert.ok(Math.abs((a?.gain ?? 0) - 0.2) < 1e-9);
    // propagateChampion builds the content-addressed command from the published champion.
    const keys = generateSigningKeys();
    const { id, seq } = propagateChampion(store, keys.privateKeyPem, {
      fromUnit: "unit-a",
      instance: "c-1",
      toUnit: "unit-b",
      toInstance: "c-1",
      issuedBy: "owner",
      staleAfterMs: 180_000,
    });
    assert.equal(seq, 2);
    const cmd = store.pendingCommands("unit-b").find((c) => c.envelope.id === id);
    assert.ok(cmd);
    assert.deepEqual((cmd.envelope.payload as { import: unknown }).import, {
      kind: "champion_patch",
      path: "propagate/unit-a/c-1/2.patch",
      repo: "proj",
      base_commit: "a".repeat(40),
      tree: "b".repeat(40),
      sha256: "f".repeat(64),
    });
    assert.throws(
      () =>
        propagateChampion(store, keys.privateKeyPem, {
          fromUnit: "unit-b",
          instance: "c-1",
          toUnit: "unit-a",
          toInstance: "c-1",
          issuedBy: "owner",
          staleAfterMs: 180_000,
        }),
      /no champion beyond its seed/,
    );
  });
});
