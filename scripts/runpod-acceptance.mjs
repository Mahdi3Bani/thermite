#!/usr/bin/env node
// Rigs on RunPod from end to end, with no RunPod and nothing paid. Control runs in this process,
// with its REST API, pull mode and the RunPod rigs' loop, against the fake RunPod API
// (src/testing/fake-runpod.ts). Each pod the fake makes is a container of the one-container rig
// image on this machine: the launch's environment, RunPod's variables (made up), a volume at
// /workspace that a stop keeps, and the pull mode port, which the fake's stand-in for RunPod's
// proxy reaches. A stop removes the container and keeps the volume, as RunPod empties a stopped
// pod's disk; a start makes the container again on the same volume; a terminate removes both.
//
//   launch     the owner launches a rig over REST: the pod starts with only the launch values;
//   enroll     control enrolls the pod through the proxy and pins its keys;
//   report     the rig's reports reach control through control's pulls only;
//   stop       the runs are paused, an export leaves the pod for control, then the pod stops;
//   start      the pod runs again from its volume: the same keys and enrollment, and it reports;
//   terminate  a full export leaves the pod, then the pod and its volume are removed, and the
//              rig is retired.
//
// Every step is in the rig's history and RunPod's API sees only the calls it should.
//
//   COMPOSE="podman compose" node scripts/runpod-acceptance.mjs
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanEngine } from "./lib/smoke-env.mjs";

// Control's side, in this process (Node.js strips the types of these files).
const { createControlApi } = await import("../src/control/api.ts");
const { RunpodRigs } = await import("../src/control/runpod-rigs.ts");
const { SecretBox } = await import("../src/control/secrets.ts");
const { ControlStore } = await import("../src/control/store.ts");
const { ControlTunnels } = await import("../src/control/tunnel.ts");
const { generateSigningKeys } = await import("../src/core/commands.ts");
const { FAKE_RUNPOD_KEY, fakeRunpod } = await import("../src/testing/fake-runpod.ts");

const engine = (process.env.COMPOSE ?? "podman compose").split(" ")[0];
const harnessImage = "localhost/thermite-harness:runpod-check";
const rigImage = "localhost/thermite-rig:runpod-check";
/** Each pod's container and volume: thermite-runpod-check-<pid>-<pod>[-volume]. */
const prefix = `thermite-runpod-check-${process.pid}`;
const OWNER = "an-owner-token-for-the-runpod-check";
// Inside the fake's hooks: control's loops go on while the engine works, as they do on RunPod.
const run = async (args) => (await promisify(execFile)(engine, args, { encoding: "utf8" })).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
/** Waits until `fn` gives something, checking every `every` ms; throws, in words, at the end. */
async function until(what, fn, ms = 300_000, every = 1000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`no ${what} within ${ms / 1000} s`);
    await sleep(every);
  }
}

const container = (pod) => `${prefix}-${pod.id}`;
const volume = (pod) => `${prefix}-${pod.id}-volume`;
/** Whether the engine has this container or volume (`kind`), with Docker as with Podman. */
const has = (kind, name) =>
  spawnSync(engine, [kind, "inspect", name], { stdio: "ignore" }).status === 0;
const logsOf = (name) => {
  const r = spawnSync(engine, ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};

/** Starts a pod's container on its volume; its pull mode port is the proxy's way in. */
async function startContainer(pod) {
  await run([
    "run",
    "-d",
    "--name",
    container(pod),
    "-v",
    `${volume(pod)}:/workspace`,
    "-p",
    "127.0.0.1::8790",
    // Test speed: no calibration, reports every 5 s.
    "-e",
    "THERMITE_CALIBRATION_BLOCKS=0",
    "-e",
    "THERMITE_POLL_SECONDS=5",
    // RunPod's own variables (made up), which the image keeps from every process.
    "-e",
    `RUNPOD_POD_ID=${pod.id}`,
    "-e",
    "RUNPOD_API_KEY=made-up-key-for-the-runpod-check",
    "-e",
    "RUNPOD_GPU_COUNT=1",
    ...Object.entries(pod.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    rigImage,
  ]);
  const port = (await run(["port", container(pod), "8790/tcp"])).trim().split("\n")[0];
  pod.upstream = `http://127.0.0.1:${port.split(":").at(-1)}`;
}

const cloud = fakeRunpod({
  onCreate: startContainer,
  // RunPod stops the container and empties its disk; the volume stays.
  onStop: async (pod) => {
    await run(["stop", "-t", "60", container(pod)]);
    pod.stopCode = (
      await run(["inspect", container(pod), "--format", "{{.State.ExitCode}}"])
    ).trim();
    pod.stopLog = logsOf(container(pod));
    await run(["rm", container(pod)]);
    pod.upstream = undefined;
  },
  onStart: startContainer,
  onTerminate: async (pod) => {
    await run(["rm", "-f", container(pod)]);
    await run(["volume", "rm", "-f", volume(pod)]);
  },
});

const exportsDir = mkdtempSync(join(tmpdir(), "thermite-runpod-check-"));
const timers = [];
const cleanup = () => {
  for (const t of timers) clearInterval(t);
  for (const pod of cloud.pods.values()) {
    spawnSync(engine, ["rm", "-f", container(pod)], { stdio: "ignore" });
    spawnSync(engine, ["volume", "rm", "-f", volume(pod)], { stdio: "ignore" });
  }
  spawnSync(engine, ["rmi", "-f", rigImage, harnessImage], { stdio: "ignore" });
  rmSync(exportsDir, { recursive: true, force: true });
  cleanEngine();
};

try {
  console.log("building the CPU harness image and the rig image on it ...");
  execFileSync(
    engine,
    ["build", "-q", "-t", harnessImage, "-f", "containers/harness/Containerfile", "."],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  execFileSync(
    engine,
    [
      "build",
      "-q",
      "-t",
      rigImage,
      "--build-arg",
      `HARNESS_IMAGE=${harnessImage}`,
      "-f",
      "containers/rig/Containerfile",
      ".",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  // Control, with one RunPod account in Providers: the fake's key, sealed.
  const keys = generateSigningKeys();
  const store = new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  store.addGpuCloud({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(FAKE_RUNPOD_KEY),
    key_hint: "…cdef",
    by: "owner:test",
  });
  // Pull mode reaches pods only through the fake's proxy, as through RunPod's.
  const tunnels = new ControlTunnels(store, secrets, keys.privateKeyPem, { fetch: cloud.fetch });
  const rigs = new RunpodRigs(store, secrets, tunnels, {
    fetch: cloud.fetch,
    image: rigImage,
    staleAfterMs: 180_000,
    privateKeyPem: keys.privateKeyPem,
  });
  const app = createControlApi(store, { admin: OWNER, rigs: {} }, keys.privateKeyPem, {
    staleAfterMs: 180_000,
    secrets,
    tunnels,
    runpodRigs: rigs,
    cloudFetch: cloud.fetch,
    exportsDir,
  });
  const api = async (path, body) => {
    const r = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  // Control's loops, faster than main.ts's: pull mode, and the RunPod rigs every 2 s.
  timers.push(
    setInterval(() => {
      tunnels.advance(1000).catch((err) => console.error(`pull: ${String(err)}`));
    }, 500),
    setInterval(() => {
      rigs.advance().catch((err) => console.error(`runpod rigs: ${String(err)}`));
    }, 2000),
  );

  // Launch.
  const launched = await api("/v1/gpu-clouds/runpod/rigs", {
    gpu: "RTX A4000",
    rig: "runpod-check",
    settings: { THERMITE_TARGET: "cpu", THERMITE_TARGET_CLASS: "runpod-check" },
  });
  check(
    launched.status === 201,
    "the owner launches a rig over REST",
    JSON.stringify(launched.body).slice(0, 300),
  );
  const rig = launched.body.rig;
  const pod = cloud.pods.get(launched.body.pod);
  check(
    Boolean(pod) && has("container", container(pod)),
    "its pod runs: a container of the rig image",
    pod ? container(pod) : "no pod",
  );
  check(
    JSON.stringify(Object.keys(pod.env).sort()) ===
      JSON.stringify([
        "THERMITE_RIG_ID",
        "THERMITE_TUNNEL_CONTROL_BOX",
        "THERMITE_TUNNEL_CONTROL_KEY_SHA256",
        "THERMITE_TUNNEL_ENROLL_CODE",
        "THERMITE_TUNNEL_PORT",
        "THERMITE_TUNNEL_PREFIX",
      ]),
    "the launch gave the pod pull mode's values and nothing else",
    Object.keys(pod.env).join(", "),
  );

  // Enroll, then report.
  const enrolled = await until("enrollment", () => store.tunnelRig(rig)?.enrolled_at);
  check(Boolean(enrolled), "control enrolled the pod through the proxy and pinned its keys");
  const keysBefore = store.tunnelRig(rig)?.pod_sign_public;
  await until("report", () =>
    store.rigs().find((u) => u.id === rig && Date.parse(u.last_seen) > 0),
  );
  check(true, "the rig's reports reach control through control's pulls");
  await until(
    "the supervisor's export figures",
    () => store.supervisor(rig)?.export?.to === "control",
  );
  check(true, "the supervisor sends its exports to control");

  // Stop: the results leave first, then the pod stops.
  const stopAsked = await api(`/v1/rigs/${rig}/runpod/stop`, {});
  check(
    stopAsked.status === 200 && stopAsked.body.op?.kind === "stop",
    "the owner stops the pod over REST",
    stopAsked.body.op_words ?? JSON.stringify(stopAsked.body),
  );
  const stopped = await until("the stop", () => {
    const v = rigs.view(rig);
    return v?.status === "EXITED" && !v.op ? v : undefined;
  });
  const stopExport = stopped.last_export;
  check(
    stopped.last_export_left === true && Boolean(store.rigExport(rig, stopExport)?.complete_at),
    "its export left the pod for control before the pod stopped",
    `${stopExport}: ${JSON.stringify(store.rigSetupEvents(rig).at(-1)?.detail)}`,
  );
  check(
    pod.stopCode === "0" && pod.stopLog.includes('"msg":"stopped"'),
    "the pod's container stopped cleanly",
    `exit ${pod.stopCode}`,
  );
  check(
    !has("container", container(pod)) && has("volume", volume(pod)),
    "the pod's disk is gone and its volume stays",
  );
  check(stopped.stopped_by === "owner", "the rig shows who stopped it", stopped.stopped_by);

  // Start: the pod runs again from its volume, with its keys, and reports.
  const startedAt = Date.now();
  const started = await api(`/v1/rigs/${rig}/runpod/start`, {});
  check(
    started.status === 200,
    "the owner starts the pod again over REST",
    started.body.op_words ?? started.body.status,
  );
  await until("a report after the start", () =>
    store.rigs().find((u) => u.id === rig && Date.parse(u.last_seen) > startedAt),
  );
  check(
    store.tunnelRig(rig)?.enrolled_at === enrolled &&
      store.tunnelRig(rig)?.pod_sign_public === keysBefore,
    "the pod reports again with the keys and the enrollment on its volume",
  );

  // Terminate: a full export leaves the pod, then the pod and its volume go.
  const termAt = new Date().toISOString();
  const termAsked = await api(`/v1/rigs/${rig}/runpod/terminate`, { confirm: `terminate ${rig}` });
  check(
    termAsked.status === 200 && termAsked.body.op?.kind === "terminate",
    "the owner terminates the pod over REST",
    termAsked.body.op_words ?? JSON.stringify(termAsked.body),
  );
  const gone = await until("the terminate", () => {
    const v = rigs.view(rig);
    return v && !v.active ? v : undefined;
  });
  // The terminate's own export: full, made after it was asked, every file on control.
  const exports = store.rigExports(rig);
  const lastFull = exports.find((e) => e.full && e.complete_at && e.created_at >= termAt);
  check(
    gone.status === "TERMINATED" && Boolean(lastFull),
    "a full export reached control before the pod was removed",
    lastFull?.name ?? exports.map((e) => `${e.name} full=${e.full} ${e.complete_at}`).join("; "),
  );
  check(
    !has("container", container(pod)) && !has("volume", volume(pod)),
    "the pod and its volume are gone",
  );
  check(Boolean(store.rigRetired(rig)), "the rig is retired: control no longer connects to it");

  const history = store.rigSetupEvents(rig).map((e) => `${e.step}${e.ok ? "" : " (not ok)"}`);
  const want = [
    "runpod_launched",
    "runpod_stopping",
    "runpod_stopped",
    "runpod_starting",
    "runpod_running",
    "runpod_terminating",
    "runpod_terminated",
  ];
  check(
    JSON.stringify(history) === JSON.stringify(want),
    "each change is in the rig's history",
    history.join(", "),
  );
  const calls = cloud.calls
    .filter((c) => c.host === "api.runpod.io" && c.method !== "GET")
    .map((c) => `${c.method} ${c.path}${c.body?.action ? ` ${c.body.action}` : ""}`);
  check(
    JSON.stringify(calls) ===
      JSON.stringify([
        "POST /v2/pods",
        `POST /v2/pods/${pod.id}/action stop`,
        `POST /v2/pods/${pod.id}/action start`,
        `DELETE /v2/pods/${pod.id}`,
      ]),
    "RunPod's API got a create, a stop, a start and a delete, nothing more",
    calls.join("; "),
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  for (const pod of cloud.pods.values())
    console.error(`${container(pod)}'s last output:\n${logsOf(container(pod)).slice(-3000)}`);
  failed++;
} finally {
  cleanup();
}
console.log(failed ? `runpod acceptance: ${failed} FAILED` : "runpod acceptance: OK");
process.exit(failed ? 1 : 0);
