#!/usr/bin/env node
// Rigs with several GPUs, under Podman (or Docker) with fake devices: the harness image starts on
// four fake GPUs (plain files in place of /dev/nvidia*, and a stand-in nvidia-smi; see
// containers/test-gpu), two for the judge and two for the agents. The broker's per-card groups,
// the timing user of the second judge card, the judge executors and the isolation selftest then
// run for real. A second start with overlapping lists must be refused. The fakes refuse to start
// where a real NVIDIA device is present.
//
//   COMPOSE="podman compose" node scripts/multigpu-acceptance.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanEngine } from "./lib/smoke-env.mjs";

const engine = (process.env.COMPOSE ?? "podman compose").split(" ")[0];
const image = "localhost/thermite-harness:multigpu-check";
const names = ["thermite-multigpu-a", "thermite-multigpu-b", "thermite-multigpu-c"];
const sh = (args, opts = {}) =>
  execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

const dir = mkdtempSync(join(tmpdir(), "thermite-multigpu-"));
const token = randomBytes(24).toString("base64url");
const cleanup = () => {
  for (const n of names) spawnSync(engine, ["rm", "-f", n], { stdio: "ignore" });
  spawnSync(engine, ["rmi", "-f", image], { stdio: "ignore" });
  cleanEngine();
  rmSync(dir, { recursive: true, force: true });
};

/** Starts the harness on fake GPUs with these settings (the judge's and agents' lists, or a set). */
function start(name, gpuEnv) {
  return sh([
    "run",
    "-d",
    "--name",
    name,
    "--cap-drop",
    "ALL",
    ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"].flatMap((c) => [
      "--cap-add",
      c,
    ]),
    "--security-opt",
    "no-new-privileges",
    "-e",
    `THERMITE_RIG_ID=${name}`,
    "-e",
    "THERMITE_TARGET=cuda-gpu",
    ...Object.entries(gpuEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-e",
    "THERMITE_CALIBRATION_BLOCKS=0",
    "-e",
    "THERMITE_CONTROL_PUBKEY_FILE=/keys/control-signing.pub",
    "-e",
    "THERMITE_SUPERVISOR_TOKEN_FILE=/run/secrets/harness-supervisor-token",
    "-e",
    `TEST_SUPERVISOR_TOKEN=${token}`,
    "-e",
    "FAKE_GPUS=4",
    "-e",
    "PATH=/opt/fake-gpu:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "-v",
    `${join(dir, "keys")}:/keys:ro`,
    "-v",
    `${resolve("containers/test-gpu")}:/opt/fake-gpu:ro`,
    "--entrypoint",
    "/opt/fake-gpu/enter",
    image,
  ]).trim();
}

const logs = (name) => {
  const r = spawnSync(engine, ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};
const logLines = (name, msg) =>
  logs(name)
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((l) => l?.msg === msg);
const logLine = (name, msg) => logLines(name, msg)[0];
/** The `nth` line (from 1) with this message, once it is there. */
async function waitFor(name, msg, ms = 180_000, nth = 1) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const l = logLines(name, msg)[nth - 1];
    if (l) return l;
    await sleep(2000);
  }
  throw new Error(`${name}: no "${msg}" (${nth}) in ${ms / 1000} s\n${logs(name).slice(-3000)}`);
}
const groupsOf = (name) =>
  sh([
    "exec",
    name,
    "stat",
    "-c",
    "%n %g",
    "/dev/nvidia0",
    "/dev/nvidia1",
    "/dev/nvidia2",
    "/dev/nvidia3",
  ])
    .trim()
    .replace(/\n/g, "; ");

try {
  mkdirSync(join(dir, "keys"));
  const { publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    join(dir, "keys", "control-signing.pub"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  console.log("building the harness image ...");
  execFileSync(
    engine,
    ["build", "-q", "-t", image, "-f", "containers/harness/Containerfile", "."],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  // Two judge cards and two agents' cards.
  const a = names[0];
  start(a, { THERMITE_GPU_INDEX: "0,1", THERMITE_DEV_GPU_INDEX: "2,3" });
  const cards = await waitFor(a, "dedicated cards");
  check(
    JSON.stringify(cards.judges) === JSON.stringify(["/dev/nvidia0", "/dev/nvidia1"]) &&
      JSON.stringify(cards.devs) === JSON.stringify(["/dev/nvidia2", "/dev/nvidia3"]),
    "the broker set up two judge cards and two agents' cards",
    JSON.stringify(cards),
  );
  const groups = sh([
    "exec",
    a,
    "stat",
    "-c",
    "%n %g %a",
    "/dev/nvidia0",
    "/dev/nvidia1",
    "/dev/nvidia2",
    "/dev/nvidia3",
    "/dev/nvidiactl",
  ]).trim();
  check(
    groups ===
      [
        "/dev/nvidia0 10500 660",
        "/dev/nvidia1 10511 660",
        "/dev/nvidia2 10501 660",
        "/dev/nvidia3 10521 660",
        "/dev/nvidiactl 10502 660",
      ].join("\n"),
    "each card has its own group, the shared nodes gpuctl",
    groups.replace(/\n/g, "; "),
  );
  const run1 = sh(["exec", a, "id", "run-1"]).trim();
  check(
    /uid=10031\(run-1\) gid=10511\(gpu-j1\)/.test(run1),
    "the second judge card's timing user",
    run1,
  );
  const ready = await waitFor(a, "judge ready");
  check(ready.judge_cards === 2, "two judge executors", JSON.stringify(ready));
  const hw = logLine(a, "hardware");
  check(
    JSON.stringify(hw?.devices?.map((d) => d.split(":")[0])) ===
      JSON.stringify(["judge", "judge", "dev", "dev"]),
    "the hardware report lists every card with its role",
    JSON.stringify(hw?.devices),
  );
  const self = spawnSync(engine, ["exec", a, "thermite", "selftest", "isolation", "--force"], {
    encoding: "utf8",
  });
  let report;
  try {
    report = JSON.parse(self.stdout);
  } catch {
    report = { ok: false, error: `${self.stdout}${self.stderr}`.slice(-1500) };
  }
  check(report.ok === true, "the isolation selftest passes on every card", report.devices ?? "");
  const roles = report.roles ?? {};
  check(
    roles["run-1"]?.["device:nvidia1"] === "reachable" &&
      roles["run-1"]?.["device:nvidia0"]?.startsWith("EACCES") &&
      roles["run-1"]?.["device:nvidia3"]?.startsWith("EACCES") &&
      roles["run-1"]?.["visible-gpus"] === "sees GPU-00000000-0000-0000-0000-000000000001",
    "run-1 reaches only judge card 2",
    JSON.stringify(roles["run-1"]),
  );
  check(
    roles["lane-1+gpu@2"]?.["device:nvidia3"] === "reachable" &&
      roles["lane-1+gpu@2"]?.["device:nvidia2"]?.startsWith("EACCES") &&
      roles["lane-1+gpu@2"]?.["device:nvidia1"]?.startsWith("EACCES"),
    "a dev run on the second agents' card reaches only that card",
    JSON.stringify(roles["lane-1+gpu@2"]),
  );
  check(
    Object.values(roles["lane-1"] ?? {}).every((v) => !String(v).startsWith("ALLOWED")) &&
      roles["lane-1"]?.["device:nvidia1"]?.startsWith("EACCES"),
    "a lane's plain commands reach no card",
    JSON.stringify(roles["lane-1"]),
  );

  // Overlapping lists: refused, and the rig neither times nor allows dev runs.
  const b = names[1];
  start(b, { THERMITE_GPU_INDEX: "0,1", THERMITE_DEV_GPU_INDEX: "1,2" });
  const refused = await waitFor(b, "could not set up the dedicated development card");
  check(/both index 1/.test(refused.error ?? ""), "overlapping lists are refused", refused.error);

  // A rig configured with its GPU set: the deployment's starting split, then a new one from the
  // rig's settings (as Edit rig or a campaign's deployment sends it), applied when the harness
  // restarts: the broker regroups the cards.
  const c = names[2];
  start(c, { THERMITE_GPUS: "0,1,2,3", THERMITE_JUDGE_GPUS: "1" });
  const first = await waitFor(c, "judge ready");
  check(
    first.judge_cards === 1 &&
      groupsOf(c) ===
        "/dev/nvidia0 10500; /dev/nvidia1 10501; /dev/nvidia2 10521; /dev/nvidia3 10522",
    "a GPU set starts with the deployment's split: one judge card, three agents' cards",
    groupsOf(c),
  );
  sh([
    "exec",
    c,
    "sh",
    "-c",
    `printf '{"judge_gpus":3}' > /var/lib/thermite/rig-settings.json && chmod 0644 /var/lib/thermite/rig-settings.json`,
  ]);
  // The controller exits to apply a new split (as it does when the setting changes).
  sh([
    "exec",
    c,
    "node",
    "-e",
    `const fs = require("fs"); for (const p of fs.readdirSync("/proc")) { if (!/^\\d+$/.test(p) || Number(p) === process.pid) continue; try { const argv = fs.readFileSync("/proc/" + p + "/cmdline", "utf8").split("\\0"); if ((argv[1] || "").endsWith("dist/harness/main.js")) process.kill(Number(p), "SIGTERM"); } catch {} }`,
  ]);
  const regrouped = await waitFor(c, "the rig's GPU split changed: regrouping the cards");
  const second = await waitFor(c, "judge ready", 180_000, 2);
  check(
    regrouped.judge === "0,1,2" &&
      second.judge_cards === 3 &&
      groupsOf(c) ===
        "/dev/nvidia0 10500; /dev/nvidia1 10511; /dev/nvidia2 10512; /dev/nvidia3 10501",
    "a new split in the rig's settings regroups the cards at the next start: three judge cards, one agents' card",
    groupsOf(c),
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  failed++;
} finally {
  cleanup();
}
console.log(failed ? `multigpu acceptance: ${failed} FAILED` : "multigpu acceptance: OK");
process.exit(failed ? 1 : 0);
