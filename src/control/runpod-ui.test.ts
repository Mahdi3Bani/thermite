import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatRunpodRigs } from "../cli/runpod.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { FAKE_GPUS, FAKE_RUNPOD_KEY, fakeRunpod } from "../testing/fake-runpod.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  harnessRefusesExport,
  pendingOf,
  supervisorReports,
} from "../testing/rig-results.ts";
import { createControlApi } from "./api.ts";
import type { RunpodRigView } from "./runpod-rig-view.ts";
import { DEFAULT_IDLE_STOP_MINUTES, RunpodRigs } from "./runpod-rigs.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";
import { ControlTunnels } from "./tunnel.ts";

const ADMIN = "admin-token-abcdef";
const IMAGE = "ghcr.io/example/thermite-rig:test-cuda";

/** Control with a RunPod account (the fake RunPod), signed in, with a clock the test moves. */
async function setup(o: Parameters<typeof fakeRunpod>[0] = {}) {
  const store = new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  store.addGpuCloud({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(FAKE_RUNPOD_KEY),
    key_hint: "…cdef",
    by: "owner:ui",
  });
  const cloud = fakeRunpod({
    ...o,
    gpus: o.gpus ?? [
      ...FAKE_GPUS,
      {
        id: "NVIDIA B200",
        name: "B200",
        memory: 180,
        secure: true,
        price: { secure: 5.99 },
        availability: "NONE",
      },
    ],
  });
  const keys = generateSigningKeys();
  let clock = Date.now();
  const now = () => clock;
  const tunnels = new ControlTunnels(store, secrets, keys.privateKeyPem, { now });
  const rigs = new RunpodRigs(store, secrets, tunnels, {
    fetch: cloud.fetch,
    image: IMAGE,
    now,
    privateKeyPem: keys.privateKeyPem,
  });
  const api = createControlApi(store, { admin: ADMIN, rigs: {} }, keys.privateKeyPem, {
    staleAfterMs: 180_000,
    secrets,
    tunnels,
    runpodRigs: rigs,
    cloudFetch: cloud.fetch,
  });
  const login = await api.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: ADMIN }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = (path: string) => api.request(path, { headers: { cookie } });
  const page = async (path: string) => (await get(path)).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/settings"))?.[1] ?? "";
  const send = (path: string, form: Record<string, string> = {}) =>
    api.request(path, {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
  const post = async (path: string, form: Record<string, string> = {}) =>
    decodeURIComponent(String((await send(path, form)).headers.get("location")));
  const advance = async (ms = 30_000) => {
    clock += ms;
    await rigs.advance();
  };
  // Read the account, as Read again on the launch page does.
  assert.match(await post("/ui/rigs/add/runpod", { cloud: "runpod", read: "1" }), /cloud=runpod$/);
  return { store, cloud, rigs, api, page, send, post, advance };
}

/** The launch form's answers, as the owner fills them in. */
const LAUNCH = {
  cloud: "runpod",
  gpu: "NVIDIA RTX A4000",
  gpu_count: "2",
  judge_gpus: "1",
  datacenter: "",
  volume_gb: "60",
  image_choice: "control",
  image: "",
  spend_limit_usd: "20",
  idle_stop_minutes: "",
  rig: "rp-test-1",
};

/** A launched rig that enrolled, reported a running run, and whose supervisor reported. */
async function working(s: Awaited<ReturnType<typeof setup>>, form: Partial<typeof LAUNCH> = {}) {
  assert.match(
    await s.post("/ui/rigs/add/runpod", { ...LAUNCH, ...form }),
    /^\/ui\/rigs\/rp-test-1\?ok=Launched/,
  );
  await s.advance();
  assert.ok(s.store.pinTunnelRig("rp-test-1", "sign", "box"));
  s.store.ingest({
    rig: "rp-test-1",
    ledger_id: "l1",
    cursor: 0,
    next: 1,
    summary: {},
    events: [
      {
        id: 1,
        at: new Date().toISOString(),
        actor: "t",
        kind: "run_created",
        subject: "run-1",
        body: { campaign: "camp", mode: "hill_climb", seed: { repo: "p" } },
      },
    ],
  });
  supervisorReports(s.store, "rp-test-1");
}

describe("Launch on RunPod", () => {
  test("the form: RunPod's GPUs on Secure cloud with their prices, the hidden ones, the price, every label's tip", async () => {
    const s = await setup();
    const page = await s.page("/ui/rigs/add/runpod");
    assert.match(page, /<title>Launch on RunPod/);
    // Cheapest first, the one with no stock hidden, and said so.
    const a4000 = page.indexOf("<b>RTX A4000</b>");
    const h100 = page.indexOf("<b>H100 SXM</b>");
    assert.ok(a4000 > 0 && h100 > a4000);
    assert.doesNotMatch(page, /<b>B200<\/b>/);
    assert.match(page, /1 GPU type is hidden: not on Secure cloud, or none in stock there now\./);
    assert.match(page, /data-price="0\.25"/);
    assert.match(page, /<span class="price" id="price">\$0\.25 an hour<\/span>/);
    assert.match(page, /Launch · \$0\.25\/h/);
    assert.match(page, /Secure cloud, on demand/);
    assert.match(page, /Community cloud and spot pods come later\./);
    // The form opens with the idle stop at 30 minutes; the owner changes or clears it. Its tip
    // says so, and that a launch over REST, MCP or the command line has no default.
    assert.match(
      page,
      /name="idle_stop_minutes" id="idle" inputmode="numeric" placeholder="never" value="30"/,
    );
    assert.match(
      page,
      /The idle stop starts at 30 minutes\. Change it, or clear it so that the pod never stops by itself\./,
    );
    assert.match(
      page,
      /5 minutes or more\. This form fills in 30 minutes\. Empty: it never stops by itself\. A launch over the REST API, MCP or the command line has no idle stop unless it names one\./,
    );
    assert.equal(DEFAULT_IDLE_STOP_MINUTES, null, "REST, MCP and the CLI keep no default");
    // Read again opens the form afresh: 30 again.
    assert.match(
      await s.page("/ui/rigs/add/runpod?cloud=runpod"),
      /name="idle_stop_minutes" id="idle" inputmode="numeric" placeholder="never" value="30"/,
    );
    // Only public values in the pod's settings: the hash of control's key, not the key.
    assert.match(
      page,
      /the SHA-256 of control's signing key \(not the key\) and a one-time enrollment code/,
    );
    // Every field's label has its tip.
    for (const label of [
      "How many GPUs",
      "GPUs for the judge",
      "Cloud",
      "Data center",
      "Storage",
      "Volume size (GB)",
      "Image",
      "Your image",
      "Spend limit (USD)",
      "Stop when idle for (minutes)",
      "Rig name",
    ])
      assert.match(
        page,
        new RegExp(`${label.replace(/[()]/g, "\\$&")}<i class="ii"[^>]*data-tip="[^"]+"`),
      );
    assert.match(page, /<script src="\/ui\/assets\/runpod-launch\.js" defer><\/script>/);
    const js = await s.page("/ui/assets/runpod-launch.js");
    assert.match(js, /Launch · /);
    // Rigs › Add a rig and Settings › Providers lead here.
    assert.match(
      await s.page("/ui/rigs/add"),
      /href="\/ui\/rigs\/add\/runpod\?cloud=runpod"><span><b>runpod · RunPod/,
    );
    assert.match(
      await s.page("/ui/settings"),
      /<a class="btn sm" href="\/ui\/rigs\/add\/runpod\?cloud=runpod">Launch a rig<\/a>/,
    );
  });

  test("Read again posts where its form points, reads the account again, and opens the form", async () => {
    const s = await setup();
    const page = await s.page("/ui/rigs/add/runpod");
    // The page's own form, as the browser sends it: its action and its hidden fields.
    const form =
      /<form method="post" action="([^"]+)" class="inline">((?:(?!<\/form>).)*)<button class="sm">Read again<\/button><\/form>/s.exec(
        page,
      );
    assert.ok(form, "the page has a Read again form");
    const fields = Object.fromEntries(
      [...(form[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(
        (m) => [m[1], m[2]],
      ),
    );
    const before = s.cloud.calls.length;
    const to = await s.post(form[1] ?? "", fields);
    assert.equal(to, "/ui/rigs/add/runpod?cloud=runpod");
    assert.ok(s.cloud.calls.length > before, "control read RunPod again");
    assert.match(await s.page(to), /<title>Launch on RunPod/);
  });

  test("a launch from the form: the pod RunPod starts, the rig's settings, its limits; the rig's page follows it", async () => {
    const s = await setup();
    const to = await s.post("/ui/rigs/add/runpod", LAUNCH);
    assert.match(
      to,
      /^\/ui\/rigs\/rp-test-1\?ok=Launched: RunPod bills pod \S+ from now at \$0\.50 an hour\./,
    );
    const body = s.cloud.calls.find((c) => c.method === "POST" && c.path === "/v2/pods")?.body as {
      image: string;
      gpu: { count: number };
      cloud: string;
      volume: { size: number };
      env: Record<string, string>;
    };
    assert.equal(body.image, IMAGE);
    assert.equal(body.gpu.count, 2);
    assert.equal(body.cloud, "SECURE");
    assert.equal(body.volume.size, 60);
    assert.equal(s.store.tunnelRig("rp-test-1")?.config.env.THERMITE_JUDGE_GPUS, "1");
    const v = s.rigs.view("rp-test-1");
    assert.equal(v?.spend_limit_usd, 20);
    assert.equal(v?.idle_stop_minutes, null, "cleared: none");
    // Before its first report, its page shows the way there, the pod and its history.
    const page = await s.page("/ui/rigs/rp-test-1");
    assert.match(page, /Getting it ready/);
    assert.match(page, /Launched on RunPod: pod \S+, 2 × RTX A4000\./);
    assert.match(page, /<h2>The pod<\/h2>/);
    assert.match(page, /data-cost>\$0\.50\/h</);
    assert.match(page, /data-limit>\$20\.00</);
    assert.match(page, /data-idle>never</);
    assert.match(page, /data-k="pod"[^>]*>.*Launched on RunPod: by owner:ui/s);
    assert.match(page, /<h2>Pull mode<\/h2>/);
  });

  test("refusals keep what was typed and start nothing", async () => {
    const s = await setup();
    const page = await (
      await s.send("/ui/rigs/add/runpod", { ...LAUNCH, idle_stop_minutes: "2" })
    ).text();
    assert.match(
      page,
      /Not launched\.<\/b> An idle stop is a whole number of minutes, 5 or more\./,
    );
    assert.match(page, /name="rig" id="nm" placeholder="[^"]*" value="rp-test-1"/);
    assert.match(
      page,
      /name="idle_stop_minutes" id="idle" inputmode="numeric" placeholder="never" value="2"/,
    );
    // A refusal after the owner cleared the idle stop keeps it cleared: no 30 comes back.
    const cleared = await (
      await s.send("/ui/rigs/add/runpod", { ...LAUNCH, idle_stop_minutes: "", volume_gb: "5" })
    ).text();
    assert.match(cleared, /Not launched\.<\/b> The volume is 10 to 10000 GB\./);
    assert.match(
      cleared,
      /name="idle_stop_minutes" id="idle" inputmode="numeric" placeholder="never" value=""/,
    );
    const own = await (
      await s.send("/ui/rigs/add/runpod", { ...LAUNCH, image_choice: "own" })
    ).text();
    assert.match(own, /Give your image's name and tag\./);
    assert.ok(!s.cloud.calls.some((c) => c.method === "POST" && c.path === "/v2/pods"));
    // RunPod's own refusal, in its words.
    const full = await setup({ noCapacity: true });
    const refused = await (await full.send("/ui/rigs/add/runpod", LAUNCH)).text();
    assert.match(refused, /Not launched\.<\/b> RunPod answered/);
    assert.equal(full.rigs.view("rp-test-1"), undefined);
  });
});

describe("a RunPod rig's page", () => {
  test("its cost, its limits changed on the page, and every change in History", async () => {
    const s = await setup();
    await working(s);
    let page = await s.page("/ui/rigs/rp-test-1");
    assert.match(page, /rp-test-1 is a RunPod pod with 2 × RTX A4000, on Secure cloud/);
    assert.match(page, /<span class="ok">live<\/span> · RunPod · \$0\.50\/h/);
    assert.match(page, /data-pod-state>Running</);
    assert.match(page, /id="hf"/);
    assert.match(page, /data-k="runs"/);
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/limits", {
        spend_limit_usd: "",
        idle_stop_minutes: "30",
      }),
      /ok=Saved\. No spend limit\. It stops after 30 minutes with no run at work\./,
    );
    assert.equal(s.rigs.view("rp-test-1")?.idle_stop_minutes, 30);
    assert.equal(s.rigs.view("rp-test-1")?.spend_limit_usd, null);
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/limits", {
        spend_limit_usd: "x",
        idle_stop_minutes: "30",
      }),
      /error=A spend limit is an amount in US dollars above 0/,
    );
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/limits", {
        spend_limit_usd: "",
        idle_stop_minutes: "3",
      }),
      /error=An idle stop is a whole number of minutes, 5 or more\./,
    );
    page = await s.page("/ui/rigs/rp-test-1");
    assert.match(page, /data-idle>30 min</);
    assert.match(page, /Exports waiting to leave the pod → control/);
    assert.match(page, /none waiting/);
  });

  test("stop, then start: the change under way with its steps, the buttons that apply, the stopped pod", async () => {
    const s = await setup();
    await working(s);
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/stop"),
      /ok=Stopping: its runs are paused and its results go out first, then the pod stops\./,
    );
    let page = await s.page("/ui/rigs/rp-test-1");
    assert.match(page, /stopping: waiting for its export/);
    assert.match(
      page,
      /<div class="step wait"><span class="ic"><\/span><span>Send the waiting results out of the pod\./,
    );
    // While it runs, nothing else may start.
    assert.match(
      page,
      /action="\/ui\/rigs\/rp-test-1\/runpod\/terminate">(?:(?!<\/form>).)*<button class="danger" disabled>Terminate<\/button>/s,
    );
    harnessApplies(s.store, "rp-test-1", exportName(1));
    exportOnControl(s.store, "rp-test-1", exportName(1));
    supervisorReports(s.store, "rp-test-1");
    await s.advance();
    await s.advance();
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    // Stopped is not offline, whenever it last reported.
    s.store.db
      .prepare("update rig set last_seen = ? where id = ?")
      .run(new Date(Date.now() - 3_600_000).toISOString(), "rp-test-1");
    page = await s.page("/ui/rigs/rp-test-1");
    assert.match(page, /data-pod-state>Stopped</);
    assert.match(page, /<span class="muted">stopped<\/span> · RunPod/);
    assert.match(
      page,
      /Its pod is stopped: its runs are paused, and only its volume costs money\./,
    );
    assert.doesNotMatch(page, /data-state="offline"/);
    assert.match(page, /data-cost>storage only</);
    assert.match(
      page,
      /<form class="lcb off" method="post" action="\/ui\/rigs\/rp-test-1\/runpod\/stop">.*?The pod is stopped\./s,
    );
    assert.match(page, /Pod stopped: its GPU is no longer billed, and its volume stays/);
    // A full reset needs the pod running.
    assert.match(
      await s.post("/ui/rigs/rp-test-1/reset", { confirm: "reset rp-test-1" }),
      /error=rp-test-1's pod is stopped: start it first/,
    );
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/start"),
      /ok=Starting: RunPod starts the pod, and its paused runs resume once it runs\./,
    );
    await s.advance();
    assert.match(await s.page("/ui/rigs/rp-test-1"), /The pod runs again/);
  });

  test("terminate needs its words; a refusal comes back in words", async () => {
    const s = await setup({ noGpuOnStart: true });
    await working(s);
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/terminate", { confirm: "terminate" }),
      /error=Type "terminate rp-test-1" to terminate it\./,
    );
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/terminate", { confirm: "terminate rp-test-1" }),
      /ok=Terminating: its runs are paused, and the pod is removed only once every result has left it\./,
    );
    assert.equal(s.rigs.view("rp-test-1")?.op?.kind, "terminate");
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/start"),
      /error=a terminate of rp-test-1 is under way: wait until it ends/,
    );
    assert.match(await s.post("/ui/rigs/rp-test-1/runpod/nope"), /error=No such action\./);
    assert.match(
      await s.post("/ui/rigs/own-1/runpod/stop"),
      /error=own-1 is not a rig control launched on RunPod\./,
    );
  });

  test("a refused terminate stays on the page, REST and the command line until the owner's next change", async () => {
    const s = await setup();
    await working(s);
    await s.post("/ui/rigs/rp-test-1/runpod/terminate", { confirm: "terminate rp-test-1" });
    harnessApplies(s.store, "rp-test-1", exportName(1));
    await s.advance();
    harnessRefusesExport(s.store, "rp-test-1");
    await s.advance();
    const rest = async () =>
      (await (
        await s.api.request("/v1/rigs/rp-test-1/runpod", {
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).json()) as RunpodRigView;
    const said = /Not terminated: the export did not complete \(failed\)\. The pod keeps running/;
    /** The red line under The pod's facts (History keeps the step either way). */
    const flash = async () =>
      /<div class="flash bad" style="margin-top:12px">([^<]*)<\/div>/.exec(
        await s.page("/ui/rigs/rp-test-1"),
      )?.[1] ?? "";
    // Several good reads of the pod later, every surface still says it.
    for (let i = 0; i < 4; i++) await s.advance();
    assert.match(await flash(), said);
    const v = await rest();
    assert.match(String(v.error), said);
    assert.match(String(v.refusal), said);
    assert.match(formatRunpodRigs([v]), /\n {2}last error: Not terminated: the export did not/);
    // The owner's next change to the pod ends it at once.
    assert.match(await s.post("/ui/rigs/rp-test-1/runpod/stop"), /ok=Stopping/);
    assert.equal(await flash(), "");
    const after = await rest();
    assert.deepEqual([after.error, after.refusal], [null, null]);
    assert.doesNotMatch(formatRunpodRigs([after]), /last error/);
  });

  test("a refusal ends with a newer step in the rig's history, such as a full reset", async () => {
    const s = await setup();
    await working(s);
    await s.post("/ui/rigs/rp-test-1/runpod/terminate", { confirm: "terminate rp-test-1" });
    harnessApplies(s.store, "rp-test-1", exportName(1));
    await s.advance();
    harnessRefusesExport(s.store, "rp-test-1");
    await s.advance();
    await s.advance();
    assert.match(String(s.rigs.view("rp-test-1")?.refusal), /^Not terminated/);
    // The step a full reset records when it starts (lifecycle.ts).
    s.store.rigSetupEvent("rp-test-1", "reset_requested", true, "asked by owner:ui");
    await s.advance();
    assert.equal(s.rigs.view("rp-test-1")?.refusal, null);
    assert.equal(s.rigs.view("rp-test-1")?.error, null);
    assert.doesNotMatch(
      await s.page("/ui/rigs/rp-test-1"),
      /<div class="flash bad" style="margin-top:12px">Not terminated/,
    );
  });

  test("the idle stop's line says a run is at work while one is, and counts only time with none", async () => {
    const s = await setup();
    await working(s, { idle_stop_minutes: "30" });
    /** The harness's next signed events, after working()'s first. */
    let cursor = 1;
    const report = (...events: [kind: string, body: object][]) => {
      s.store.ingest({
        rig: "rp-test-1",
        ledger_id: "l1",
        cursor,
        next: cursor + events.length,
        summary: {},
        events: events.map(([kind, body], i) => ({
          id: cursor + i + 1,
          at: new Date().toISOString(),
          actor: "t",
          kind,
          subject: "run-1",
          body,
        })),
      });
      cursor += events.length;
    };
    /** The line under Idle stop, without its "Change it" link. */
    const idleLine = async () =>
      /data-idle>30 min<\/div><div class="s">([^<]*?)(?: · )?</.exec(
        await s.page("/ui/rigs/rp-test-1"),
      )?.[1];
    const rest = async () =>
      (await (
        await s.api.request("/v1/rigs/rp-test-1/runpod", {
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).json()) as RunpodRigView;
    // A lane's trial in progress: at work, however long it takes. No idle time counts.
    report(["trial_started", { lane: "lane-1", trial: "t-1" }]);
    await s.advance();
    assert.equal(await idleLine(), "a run is at work");
    assert.equal((await rest()).idle_since, null);
    for (let i = 0; i < 80; i++) await s.advance();
    assert.equal(await idleLine(), "a run is at work", "40 minutes into the trial");
    assert.deepEqual(s.cloud.stops(), [], "never stopped with a run at work");
    assert.equal(s.rigs.view("rp-test-1")?.op, null);
    // The run finishes: the idle time counts from then, as the idle stop counts it.
    report(
      ["trial_finished", { lane: "lane-1", trial: "t-1", stopped: "done" }],
      ["run_status", { status: "closed", reason: "done" }],
    );
    await s.advance();
    await s.advance();
    assert.match(String(await idleLine()), /^no run at work for \d+ s of 30 min$/);
    assert.ok((await rest()).idle_since);
    for (let i = 0; i < 60; i++) await s.advance();
    assert.equal(s.rigs.view("rp-test-1")?.op?.why, "idle_stop");
  });

  test("restart from the page goes to RunPod, and its words say what it does to the runs", async () => {
    const s = await setup();
    await working(s);
    // The box says what a restart does: it pauses no run, and a trial in progress stops.
    const box =
      /<form class="lcb" method="post" action="\/ui\/rigs\/rp-test-1\/runpod\/restart">.*?<\/form>/s.exec(
        await s.page("/ui/rigs/rp-test-1"),
      )?.[0];
    assert.match(
      String(box),
      /Its runs are not paused: a trial in progress stops, and the harness plans it again\./,
    );
    assert.doesNotMatch(String(box), /pause and resume/);
    assert.match(
      await s.post("/ui/rigs/rp-test-1/runpod/restart"),
      /ok=Restarting: the pod stops, then starts again\./,
    );
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    assert.equal(s.rigs.view("rp-test-1")?.op?.kind, "restart");
    assert.deepEqual(
      pendingOf(s.store, "rp-test-1").map((c) => c.kind),
      [],
      "a restart sends no pause_run and no export",
    );
    // Its steps under way say the same.
    const card = /<div class="card" style="margin-top:12px" id="op">.*?<\/div><\/div>/s.exec(
      await s.page("/ui/rigs/rp-test-1"),
    )?.[0];
    assert.match(
      String(card),
      /The harness starts again: a trial that was in progress is planned again\./,
    );
    assert.doesNotMatch(String(card), /Resume the runs/);
  });
});
