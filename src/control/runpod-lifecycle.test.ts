import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateSigningKeys } from "../core/commands.ts";
import { FAKE_RUNPOD_KEY, fakeRunpod, NO_FREE_GPU } from "../testing/fake-runpod.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  harnessRefusesExport,
  pendingOf,
  supervisorReports,
} from "../testing/rig-results.ts";
import { createControlApi } from "./api.ts";
import { advanceResets, confirmReset } from "./lifecycle.ts";
import { STOP_WAIT_MS } from "./runpod-lifecycle.ts";
import type { RunpodRigView } from "./runpod-rig-view.ts";
import { RunpodRigs } from "./runpod-rigs.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";
import { ControlTunnels } from "./tunnel.ts";

const IMAGE = "ghcr.io/example/thermite-rig:test-cuda";
const HOUR = 3_600_000;
const TOKENS = {
  admin: "owner-token-abcdef",
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

/** Control with one RunPod account (the fake RunPod), its API, and a clock the test moves. */
function setup(o: Parameters<typeof fakeRunpod>[0] = {}) {
  const store = new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  store.addGpuCloud({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(FAKE_RUNPOD_KEY),
    key_hint: "…cdef",
    by: "owner:ui",
  });
  const cloud = fakeRunpod(o);
  const control = generateSigningKeys();
  let clock = Date.now();
  const now = () => clock;
  const tunnels = new ControlTunnels(store, secrets, control.privateKeyPem, { now });
  const rigs = new RunpodRigs(store, secrets, tunnels, {
    fetch: cloud.fetch,
    image: IMAGE,
    now,
    privateKeyPem: control.privateKeyPem,
  });
  const api = createControlApi(store, TOKENS, control.privateKeyPem, {
    staleAfterMs: 180_000,
    secrets,
    tunnels,
    runpodRigs: rigs,
  });
  const call = (path: string, body?: unknown, token = TOKENS.admin) =>
    api.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const advance = async (ms = 30_000) => {
    clock += ms;
    await rigs.advance();
  };
  const view = (rig: string) => rigs.view(rig) as RunpodRigView;
  const steps = (rig: string) => store.rigSetupEvents(rig).map((e) => [e.step, e.ok]);
  return { store, cloud, control, rigs, api, call, advance, view, steps };
}

/** The rig's harness reports a run that runs (or one that ended), as its signed reports would. */
function reportRun(store: ControlStore, rig: string, run: string, n: number, ended = false) {
  store.ingest({
    rig,
    ledger_id: "l1",
    cursor: n - 1,
    next: n,
    summary: {},
    events: [
      {
        id: n,
        at: new Date(Date.now() + n).toISOString(),
        actor: "t",
        kind: ended ? "run_status" : "run_created",
        subject: run,
        body: ended
          ? { status: "completed" }
          : { campaign: "camp", mode: "hill_climb", seed: { repo: "p" } },
      },
    ],
  });
}

/** A launched rig that enrolled and whose harness reports one running run. */
async function working(s: ReturnType<typeof setup>, o: { spend_limit_usd?: number } = {}) {
  const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", ...o }, "owner:api");
  await s.advance();
  assert.ok(s.store.pinTunnelRig(v.rig, "sign", "box"));
  reportRun(s.store, v.rig, "run-1", 1);
  supervisorReports(s.store, v.rig);
  return v.rig;
}

const json = async <T>(r: Response) => (await r.json()) as T;

describe("RunPod rigs: stop", () => {
  test("pauses the runs and sends the results out first; the pod stops once they have left", async () => {
    const s = setup();
    const rig = await working(s);
    const r = await s.call(`/v1/rigs/${rig}/runpod/stop`, {});
    assert.equal(r.status, 200);
    const asked = await json<RunpodRigView>(r);
    assert.deepEqual(
      [asked.op?.kind, asked.op?.phase, asked.op?.by],
      ["stop", "exporting", "owner:api"],
    );
    assert.equal(asked.op_words, "stopping: waiting for its export");
    assert.deepEqual(asked.op?.paused, ["run-1"]);
    const sent = pendingOf(s.store, rig);
    assert.deepEqual(
      sent.map((c) => [c.kind, c.payload]),
      [
        ["pause_run", { run: "run-1", reason: "the owner stops the rig's pod" }],
        ["export_now", { full: false }],
      ],
    );
    // Nothing leaves yet: the pod runs on.
    await s.advance();
    assert.deepEqual(s.cloud.stops(), []);
    harnessApplies(s.store, rig, exportName(1));
    supervisorReports(s.store, rig, { waiting: 1 });
    await s.advance();
    assert.equal(s.view(rig).op?.phase, "leaving");
    assert.equal(s.view(rig).op_words, "stopping: waiting for its results to leave the pod");
    // On control, but another export still waits on the rig: not yet.
    exportOnControl(s.store, rig, exportName(1));
    await s.advance();
    assert.deepEqual(s.cloud.stops(), []);
    supervisorReports(s.store, rig);
    const spentBefore = s.view(rig).spend_usd;
    await s.advance();
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    const v = s.view(rig);
    assert.deepEqual([v.status, v.stopped_by, v.op], ["EXITED", "owner", null]);
    assert.deepEqual(v.paused_runs, ["run-1"], "the next start resumes it");
    assert.deepEqual([v.last_export, v.last_export_left], [exportName(1), true]);
    // Stopped: it costs nothing more.
    await s.advance(5 * HOUR);
    assert.ok(Math.abs((s.view(rig).spend_usd ?? 0) - (spentBefore ?? 0)) < 0.01);
    assert.deepEqual(s.steps(rig), [
      ["runpod_launched", true],
      ["runpod_stopping", true],
      ["runpod_stopped", true],
    ]);
    const audit = s.store.listAudit(50);
    assert.equal(audit.find((a) => a.action === "runpod_rig_stop")?.actor, "owner:api");
    const stoppedAudit = audit.find((a) => a.action === "runpod_rig_stopped");
    assert.equal((stoppedAudit?.body as { why?: string } | undefined)?.why, "owner");
  });

  test("stops all the same when the export fails or takes too long: the volume keeps the rest", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.stop(rig, "owner:api");
    harnessRefusesExport(s.store, rig);
    await s.advance();
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    const failed = s.store.rigSetupEvents(rig).at(-1);
    assert.equal(failed?.step, "runpod_stopped");
    assert.match(
      String(failed?.detail),
      /the export did not complete \(failed\): what it had not sent out stays on its volume/,
    );
    assert.equal(s.view(rig).last_export_left, false);

    const t = setup();
    const slow = await working(t);
    await t.rigs.stop(slow, "owner:api");
    await t.advance(STOP_WAIT_MS - 60_000);
    assert.deepEqual(t.cloud.stops(), []);
    await t.advance(2 * 60_000);
    assert.deepEqual(t.cloud.stops(), [{ action: "stop" }]);
    assert.match(
      String(t.store.rigSetupEvents(slow).at(-1)?.detail),
      /no export within 15 minutes/,
    );
  });

  test("a rig whose harness never reported holds no result: its pod stops at once", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    const stopped = await s.rigs.stop(v.rig, "owner:mcp");
    assert.deepEqual([stopped.status, stopped.op], ["EXITED", null]);
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    assert.deepEqual(pendingOf(s.store, v.rig), []);
    await assert.rejects(s.rigs.stop(v.rig, "owner:api"), /pod is stopped already/);
  });

  test("one change at a time; the owner's own stop waits for a full reset", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.stop(rig, "owner:api");
    await assert.rejects(
      s.rigs.stop(rig, "owner:api"),
      /a stop of .* is under way: wait until it ends/,
    );
    await assert.rejects(
      s.rigs.terminate(rig, "owner:api", `terminate ${rig}`),
      /a stop of .* is under way/,
    );
    const t = setup();
    const other = await working(t);
    t.store.createReset(other, "owner:api");
    await assert.rejects(
      t.rigs.stop(other, "owner:api"),
      /a full reset of .* is under way \(start\)/,
    );
  });
});

describe("RunPod rigs: start and restart", () => {
  test("RunPod has no GPU free: the start says so, and the pod stays stopped", async () => {
    const s = setup({ noGpuOnStart: true });
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    await s.rigs.stop(v.rig, "owner:api");
    const r = await s.call(`/v1/rigs/${v.rig}/runpod/start`, {});
    assert.equal(r.status, 409);
    const { error } = await json<{ error: string }>(r);
    assert.match(error, /RunPod has no free GPU for pod pod1 now, so the pod stays stopped/);
    assert.ok(error.includes(NO_FREE_GPU), "RunPod's own words");
    assert.match(error, /Try again later, or terminate it and launch a new rig/);
    assert.deepEqual([s.view(v.rig).status, s.view(v.rig).op], ["EXITED", null]);
    assert.deepEqual(s.steps(v.rig).at(-1), ["runpod_start_refused", false]);
    // A GPU is free again: the start goes through.
    s.cloud.setNoGpuOnStart(false);
    const started = await json<RunpodRigView>(await s.call(`/v1/rigs/${v.rig}/runpod/start`, {}));
    assert.deepEqual([started.status, started.op, started.stopped_by], ["RUNNING", null, null]);
    assert.deepEqual(s.steps(v.rig).slice(-2), [
      ["runpod_starting", true],
      ["runpod_running", true],
    ]);
  });

  test("a start resumes the runs the stop paused, once the pod runs again", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.stop(rig, "owner:api");
    harnessApplies(s.store, rig, exportName(1));
    exportOnControl(s.store, rig, exportName(1));
    await s.advance();
    assert.equal(s.view(rig).status, "EXITED");
    await assert.rejects(s.rigs.restart(rig, "owner:api"), /stopped: start it instead/);
    const v = await s.rigs.start(rig, "owner:api");
    assert.equal(v.status, "RUNNING");
    assert.deepEqual(v.paused_runs, []);
    assert.deepEqual(
      pendingOf(s.store, rig).map((c) => [c.kind, c.payload]),
      [["resume_run", { run: "run-1" }]],
    );
    assert.match(
      String(s.store.rigSetupEvents(rig).at(-1)?.detail),
      /with 1 GPU; runs resumed: run-1/,
    );
    await assert.rejects(
      s.rigs.start(rig, "owner:api"),
      /pod is not stopped: RunPod says it is RUNNING/,
    );
  });

  test("a pod that runs with fewer GPUs than it was launched with is said in its history", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", gpu_count: 2 }, "owner:api");
    await s.rigs.stop(v.rig, "owner:api");
    const pod = s.cloud.pods.get("pod1");
    assert.ok(pod);
    pod.count = 1;
    await s.rigs.start(v.rig, "owner:api");
    const last = s.store.rigSetupEvents(v.rig).at(-1);
    assert.deepEqual([last?.step, last?.ok], ["runpod_running", false]);
    assert.match(String(last?.detail), /with 1 GPU; not the 2 it was launched with/);
  });

  test("no start while the pod has cost its spend limit", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", spend_limit_usd: 1 }, "owner:api");
    for (let i = 0; i < 4; i++) await s.advance(HOUR);
    assert.equal(s.view(v.rig).stopped_by, "spend_limit");
    await assert.rejects(
      s.rigs.start(v.rig, "owner:api"),
      /has cost \$1\.00, which is at its spend limit \(\$1\.00\): raise or clear the limit first/,
    );
    s.rigs.limits(v.rig, { spend_limit_usd: 2 }, "owner:api");
    assert.equal((await s.rigs.start(v.rig, "owner:api")).status, "RUNNING");
  });

  test("restart: the pod stops and starts again through RunPod, with no export", async () => {
    const s = setup();
    const rig = await working(s);
    // The route every rig has: RunPod's driver serves this rig with no THERMITE_LIFECYCLE.
    const partial = await s.call(`/v1/rigs/${rig}/restart`, { components: ["supervisor"] });
    assert.equal(partial.status, 409);
    assert.match((await json<{ error: string }>(partial)).error, /restart together/);
    const r = await s.call(`/v1/rigs/${rig}/restart`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { restarted: ["pod pod1: it stops, then starts again"] });
    assert.deepEqual(pendingOf(s.store, rig), [], "no pause and no export");
    assert.equal(s.view(rig).op_words, "restarting: waiting for the pod to stop");
    await s.advance();
    assert.deepEqual(s.cloud.actions(), [{ action: "stop" }, { action: "start" }]);
    const v = s.view(rig);
    assert.deepEqual([v.status, v.op, v.stopped_by], ["RUNNING", null, null]);
    assert.deepEqual(s.steps(rig).slice(1), [
      ["runpod_restarting", true],
      ["runpod_starting", true],
      ["runpod_running", true],
    ]);
    // A rig not on RunPod still needs THERMITE_LIFECYCLE's driver.
    const other = await s.call("/v1/rigs/local-1/restart", {});
    assert.equal(other.status, 409);
  });
});

describe("RunPod rigs: terminate", () => {
  test("removes the pod only once every result has left it, then retires the rig", async () => {
    const s = setup();
    const rig = await working(s);
    const bad = await s.call(`/v1/rigs/${rig}/runpod/terminate`, { confirm: "yes" });
    assert.equal(bad.status, 400);
    assert.equal((await json<{ error: string }>(bad)).error, `confirm with "terminate ${rig}"`);
    const r = await s.call(`/v1/rigs/${rig}/runpod/terminate`, { confirm: `terminate ${rig}` });
    assert.equal(r.status, 200);
    assert.equal(
      (await json<RunpodRigView>(r)).op_words,
      "terminating: waiting until no judge job and no command waits on the rig",
    );
    // The pause waits for the rig: the full export comes after it.
    await s.advance();
    assert.deepEqual(
      pendingOf(s.store, rig).map((c) => c.kind),
      ["pause_run"],
    );
    harnessApplies(s.store, rig, exportName(1));
    await s.advance();
    assert.deepEqual(
      pendingOf(s.store, rig).map((c) => [c.kind, c.payload]),
      [["export_now", { full: true }]],
    );
    harnessApplies(s.store, rig, exportName(2));
    // Exports still wait on the rig: the pod stays, however long it takes.
    supervisorReports(s.store, rig, { waiting: 2 });
    exportOnControl(s.store, rig, exportName(2));
    for (let i = 0; i < 10; i++) await s.advance(60_000);
    assert.deepEqual(s.cloud.terminated(), [], "terminate refuses while exports are pending");
    assert.equal(s.view(rig).op_words, "terminating: waiting for every result to leave the pod");
    supervisorReports(s.store, rig, { champions_waiting: 1 });
    await s.advance();
    assert.deepEqual(s.cloud.terminated(), [], "a champion's patch still waits");
    supervisorReports(s.store, rig);
    await s.advance();
    assert.deepEqual(s.cloud.terminated(), ["pod1"]);
    const v = s.view(rig);
    assert.deepEqual([v.active, v.status, v.op], [false, "TERMINATED", null]);
    assert.ok(s.store.rigRetired(rig), "control stops connecting to it; its records stay");
    assert.deepEqual(s.steps(rig).slice(-2), [
      ["runpod_terminating", true],
      ["runpod_terminated", true],
    ]);
    assert.ok(s.store.listAudit(80).some((a) => a.action === "runpod_rig_terminated"));
    // Gone: nothing more to do.
    await assert.rejects(s.rigs.stop(rig, "owner:api"), /pod is gone/);
  });

  test("refuses when a result can't leave: the pod keeps running, its runs paused", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.terminate(rig, "owner:api", `terminate ${rig}`);
    harnessApplies(s.store, rig, exportName(1));
    await s.advance();
    harnessApplies(s.store, rig, exportName(2));
    // The rig has nowhere to send its exports (an older supervisor).
    supervisorReports(s.store, rig, { to: "none" });
    await s.advance();
    assert.deepEqual(s.cloud.terminated(), []);
    assert.deepEqual(s.cloud.stops(), []);
    const v = s.view(rig);
    assert.deepEqual([v.active, v.status, v.op], [true, "RUNNING", null]);
    assert.deepEqual(v.paused_runs, ["run-1"]);
    assert.match(
      String(v.error),
      /^Not terminated: .*does not send exports to control.* The pod keeps running, with its runs paused/,
    );
    assert.deepEqual(s.steps(rig).at(-1), ["runpod_terminate_refused", false]);

    const t = setup();
    const other = await working(t);
    await t.rigs.terminate(other, "owner:api", `terminate ${other}`);
    harnessApplies(t.store, other, exportName(1));
    await t.advance();
    harnessRefusesExport(t.store, other);
    await t.advance();
    assert.deepEqual(t.cloud.terminated(), []);
    assert.match(String(t.view(other).error), /the export did not complete \(failed\)/);
  });

  test("a stopped pod: removed only when its results left it before it stopped", async () => {
    const s = setup();
    const rig = await working(s);
    await s.rigs.stop(rig, "owner:api");
    harnessRefusesExport(s.store, rig);
    await s.advance();
    await assert.rejects(
      s.rigs.terminate(rig, "owner:api", `terminate ${rig}`),
      /pod is stopped, and results may wait on its volume .*: start it, so they can leave, then terminate it/,
    );
    assert.deepEqual(s.cloud.terminated(), []);

    const t = setup();
    const done = await working(t);
    await t.rigs.stop(done, "owner:api");
    harnessApplies(t.store, done, exportName(1));
    exportOnControl(t.store, done, exportName(1));
    await t.advance();
    const v = await t.rigs.terminate(done, "owner:api", `terminate ${done}`);
    assert.deepEqual([v.active, v.status], [false, "TERMINATED"]);
    assert.deepEqual(t.cloud.terminated(), ["pod1"]);
  });

  test("a pod whose harness never reported is removed at once", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    const gone = await s.rigs.terminate(v.rig, "owner:api", `terminate ${v.rig}`);
    assert.deepEqual([gone.active, gone.status], [false, "TERMINATED"]);
    assert.deepEqual(s.cloud.terminated(), ["pod1"]);
  });
});

describe("RunPod rigs: the full reset", () => {
  test("every result leaves the pod first, the wipe waits for the owner, and the pod stays", async () => {
    const s = setup();
    const rig = await working(s);
    const step = () =>
      advanceResets({
        store: s.store,
        privateKeyPem: s.control.privateKeyPem,
        driver: undefined,
        staleAfterMs: 180_000,
      });
    const r = await s.call(`/v1/rigs/${rig}/reset`, { confirm: `reset ${rig}` });
    assert.equal(r.status, 201);
    const { reset } = await json<{ reset: number }>(r);
    assert.equal(String(s.store.openReset(rig)?.state), "quiescing");
    harnessApplies(s.store, rig, exportName(1));
    await step();
    assert.equal(String(s.store.openReset(rig)?.state), "exporting");
    harnessApplies(s.store, rig, exportName(2));
    await step();
    // Control holds the export, but another export still waits on the pod: not yet.
    exportOnControl(s.store, rig, exportName(2));
    supervisorReports(s.store, rig, { waiting: 1 });
    await step();
    assert.equal(String(s.store.openReset(rig)?.state), "verifying");
    supervisorReports(s.store, rig);
    await step();
    assert.equal(String(s.store.openReset(rig)?.state), "awaiting_owner");
    // While it runs, the owner's stop waits.
    await assert.rejects(s.rigs.stop(rig, "owner:api"), /a full reset of .* is under way/);
    confirmReset(s.store, reset, "owner:api");
    await step();
    const wipe = pendingOf(s.store, rig);
    assert.deepEqual(
      wipe.map((c) => c.kind),
      ["wipe_state"],
    );
    harnessApplies(s.store, rig, exportName(3));
    await step();
    const done = s.store.resets(1)[0];
    assert.equal(done?.state, "done");
    assert.match(String(done?.detail), /the pod and its GPU stay/);
    assert.deepEqual(s.cloud.actions(), [], "the pod was never stopped");
    assert.deepEqual(s.steps(rig).slice(-2), [
      ["reset_requested", true],
      ["reset_done", true],
    ]);
  });

  test("refused while the pod is stopped: its results could not leave", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    await s.rigs.stop(v.rig, "owner:api");
    const r = await s.call(`/v1/rigs/${v.rig}/reset`, { confirm: `reset ${v.rig}` });
    assert.equal(r.status, 409);
    assert.match((await json<{ error: string }>(r)).error, /pod is stopped: start it first/);
    // One made elsewhere (the dashboard) fails at its first step, in the same words.
    s.store.createReset(v.rig, "owner:ui");
    await advanceResets({
      store: s.store,
      privateKeyPem: s.control.privateKeyPem,
      driver: undefined,
      staleAfterMs: 180_000,
    });
    assert.equal(s.store.resets(1)[0]?.state, "failed");
    assert.deepEqual(s.steps(v.rig).at(-1), ["reset_failed", false]);
  });
});

/** An MCP client on control in-process, with this token. */
async function connect(api: ReturnType<typeof createControlApi>, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
  };
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: fetchImpl }),
  );
  return client;
}

/** A tool's answer: its text, JSON (an error is {"error": …}). */
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";

describe("RunPod rigs' lifecycle: the owner's alone", () => {
  test("REST: any other token gets 401 and changes nothing", async () => {
    const s = setup();
    const rig = await working(s);
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read])
      for (const [path, body] of [
        [`/v1/rigs/${rig}/runpod/stop`, {}],
        [`/v1/rigs/${rig}/runpod/start`, {}],
        [`/v1/rigs/${rig}/runpod/terminate`, { confirm: `terminate ${rig}` }],
        [`/v1/rigs/${rig}/restart`, {}],
        [`/v1/rigs/${rig}/reset`, { confirm: `reset ${rig}` }],
      ] as const)
        assert.equal((await s.call(path, body, token)).status, 401, `${path} ${token}`);
    assert.deepEqual(s.cloud.actions(), []);
    assert.deepEqual(pendingOf(s.store, rig), []);
    assert.equal((await s.call("/v1/rigs/nope/runpod/stop", {})).status, 404);
    // The owner reads the rig's history with it.
    const one = await json<{ history: { step: string; words: string }[] }>(
      await s.call(`/v1/rigs/${rig}/runpod`),
    );
    assert.deepEqual(
      one.history.map((h) => [h.step, h.words]),
      [["runpod_launched", "Launched on RunPod"]],
    );
  });

  test("MCP: runpod_rig for the owner only; rig_setup shows the history", async () => {
    const s = setup();
    const rig = await working(s);
    for (const token of [TOKENS.operator, TOKENS.read, TOKENS.agent]) {
      const tools = (await (await connect(s.api, token)).listTools()).tools.map((t) => t.name);
      assert.ok(!tools.includes("runpod_rig"), token);
    }
    const owner = await connect(s.api, TOKENS.admin);
    const stopped = await owner.callTool({
      name: "runpod_rig",
      arguments: { rig, action: "stop" },
    });
    const v = JSON.parse(text(stopped)) as RunpodRigView;
    assert.deepEqual([v.op?.kind, v.op?.by], ["stop", "owner:mcp"]);
    const refused = await owner.callTool({
      name: "runpod_rig",
      arguments: { rig, action: "terminate", confirm: `terminate ${rig}` },
    });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /a stop of .* is under way/);
    const setupView = JSON.parse(
      text(await owner.callTool({ name: "rig_setup", arguments: { rig } })),
    ) as { on: string; op: { kind: string }; steps: { step: string }[] };
    assert.equal(setupView.on, "runpod");
    assert.equal(setupView.op.kind, "stop");
    assert.deepEqual(
      setupView.steps.map((x) => x.step),
      ["runpod_launched", "runpod_stopping"],
    );

    // A full reset over MCP: started, then confirmed, by the owner.
    const t = setup();
    const other = await working(t);
    const o = await connect(t.api, TOKENS.admin);
    const noConfirm = await o.callTool({
      name: "runpod_rig",
      arguments: { rig: other, action: "reset" },
    });
    assert.equal(JSON.parse(text(noConfirm)).error, `confirm with "reset ${other}"`);
    const started = JSON.parse(
      text(
        await o.callTool({
          name: "runpod_rig",
          arguments: { rig: other, action: "reset", confirm: `reset ${other}` },
        }),
      ),
    ) as { reset: { state: string } };
    assert.equal(started.reset.state, "quiescing");
    const early = await o.callTool({
      name: "runpod_rig",
      arguments: { rig: other, action: "confirm_wipe" },
    });
    assert.match(text(early), /not waiting for confirmation/);
    const cancelled = JSON.parse(
      text(
        await o.callTool({ name: "runpod_rig", arguments: { rig: other, action: "cancel_reset" } }),
      ),
    ) as { reset: { state: string } };
    assert.equal(cancelled.reset.state, "cancelled");
    assert.deepEqual(t.steps(other).at(-1), ["reset_cancelled", true]);
  });
});
