#!/usr/bin/env node
// The one-container rig image (containers/rig/Containerfile), as a RunPod pod runs it, on this
// machine: built on the CPU harness image, started as root with the engine's default capabilities
// and without no-new-privileges, and given RunPod's variables (made up) and the launch values
// control mints for pull mode. Control runs in this process and connects to the pod's port, as
// it would through RunPod's proxy. Then:
//   - the harness waits for enrollment; once control has enrolled the pod, root checks control's
//     key against the launch's SHA-256 and gives the harness its own copy, and the rig's
//     settings from control reach the controller, but not the enrollment code;
//   - the rig's reports reach control through control's pulls only;
//   - the isolation selftest passes, both the harness's own check at start and one run as root,
//     with the container checks (the supervisor's user, its GPU access, set-id files, RunPod's
//     variables, the enrollment code, control's key) and the supervisor's places probed for
//     every role;
//   - a key the supervisor writes after enrollment changes nothing the harness trusts;
//   - a supervisor or a controller that exits starts again;
//   - a stop ends both parts cleanly, with exit code 0.
// With rootless Podman on a machine VM it also gives the container GPU device nodes it can't
// regroup (nobody's, mode 0666, as RunPod's are): the GPU fence alone must keep every role but
// the GPU's own off them, and the supervisor too. Nothing here needs or touches a real GPU.
//
//   COMPOSE="podman compose" node scripts/rig-image-acceptance.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cleanEngine } from "./lib/smoke-env.mjs";

// Control's side, in this process (Node.js strips the types of these files).
const { createControlApi } = await import("../src/control/api.ts");
const { SecretBox } = await import("../src/control/secrets.ts");
const { ControlStore } = await import("../src/control/store.ts");
const { ControlTunnels } = await import("../src/control/tunnel.ts");
const { generateSigningKeys } = await import("../src/core/commands.ts");
const { keySha256 } = await import("../src/core/tunnel.ts");

const engine = (process.env.COMPOSE ?? "podman compose").split(" ")[0];
const harnessImage = "localhost/thermite-harness:rig-image-check";
const rigImage = "localhost/thermite-rig:rig-image-check";
const name = "thermite-rig-image-check";
/** Fake device nodes owned by the Podman VM's root, which a rootless container doesn't map. */
const FOREIGN = "/var/tmp/thermite-rig-image-foreign-nodes";
const NODES = ["nvidia0", "nvidiactl", "nvidia-uvm"];
const STATE = "/workspace/thermite";
const sh = (args, opts = {}) =>
  execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

/** As in the multi-GPU acceptance: rootless Podman on a machine VM can show such nodes. */
function foreignNodesPossible() {
  if (engine !== "podman") return false;
  const info = spawnSync(engine, ["info", "--format", "{{.Host.Security.Rootless}}"], {
    encoding: "utf8",
  });
  if (info.stdout.trim() !== "true") return false;
  return spawnSync(engine, ["machine", "inspect"], { stdio: "ignore" }).status === 0;
}
const foreign = foreignNodesPossible();

/** Control's pulls from the pod, once it is launched. */
let pump;
const cleanup = () => {
  clearInterval(pump);
  spawnSync(engine, ["rm", "-f", name], { stdio: "ignore" });
  spawnSync(engine, ["rmi", "-f", rigImage, harnessImage], { stdio: "ignore" });
  if (foreign) spawnSync(engine, ["machine", "ssh", `sudo rm -rf ${FOREIGN}`], { stdio: "ignore" });
  cleanEngine();
};

const logs = () => {
  const r = spawnSync(engine, ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};
const logLines = (msg) =>
  logs()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((l) => l?.msg === msg);
/** The `nth` log line (from 1) with this message, once it is there. */
async function waitFor(msg, ms = 180_000, nth = 1) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const l = logLines(msg)[nth - 1];
    if (l) return l;
    await sleep(1000);
  }
  throw new Error(`no "${msg}" (${nth}) in ${ms / 1000} s\n${logs().slice(-4000)}`);
}
/** Runs a Node.js snippet in the container as root (or as `user`) and returns its output. */
const inside = (code, user) =>
  sh(["exec", ...(user ? ["--user", user] : []), name, "node", "-e", code]).trim();
const pidsOf = (script) =>
  inside(
    `const fs=require("fs");const out=[];for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const a=fs.readFileSync("/proc/"+p+"/cmdline","utf8").split("\\0");if((a[1]||"").endsWith(${JSON.stringify(script)}))out.push(Number(p))}catch{}}console.log(JSON.stringify(out))`,
  );
const kill = (script) =>
  inside(
    `const fs=require("fs");for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const a=fs.readFileSync("/proc/"+p+"/cmdline","utf8").split("\\0");if((a[1]||"").endsWith(${JSON.stringify(script)}))process.kill(Number(p),"SIGKILL")}catch{}}`,
  );

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
  const setid = sh([
    "run",
    "--rm",
    "--entrypoint",
    "find",
    rigImage,
    "/",
    "-xdev",
    "-type",
    "f",
    "-perm",
    "/6000",
  ]).trim();
  check(setid === "", "the image has no set-id file", setid.split("\n").slice(0, 5).join(", "));

  if (foreign) {
    // podman machine ssh joins its arguments into one remote command line: quote it whole.
    const list = NODES.join(" ");
    sh([
      "machine",
      "ssh",
      `sudo sh -c 'rm -rf ${FOREIGN} && mkdir -p ${FOREIGN} && cd ${FOREIGN} && touch ${list} && chown 0:0 ${list} && chmod 666 ${list}'`,
    ]);
  }
  // Control mints the rig, its one-time code and the pod's launch values, as a launch does.
  const controlKeys = generateSigningKeys();
  const store = new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  const tunnels = new ControlTunnels(store, secrets, controlKeys.privateKeyPem);
  createControlApi(
    store,
    { admin: "an-admin-token-for-the-test", rigs: {} },
    controlKeys.privateKeyPem,
    {
      staleAfterMs: 180_000,
      secrets,
      tunnels,
    },
  );
  const rig = "rig-image-check";
  const minted = tunnels.mint({
    by: "owner:test",
    rig,
    config: { THERMITE_TARGET_CLASS: "rig-image-check" },
  });
  check(minted.port === 8790, "control's launch values use the image's port", String(minted.port));
  // RunPod's eight variables, as the first spike found them; the values are made up.
  const runpod = {
    RUNPOD_API_KEY: "made-up-key-for-the-test",
    RUNPOD_CPU_COUNT: "4",
    RUNPOD_DC_ID: "dc-test",
    RUNPOD_GPU_COUNT: "1",
    RUNPOD_GPU_NAME: "none",
    RUNPOD_MEM_GB: "8",
    RUNPOD_POD_HOSTNAME: "pod-test-host",
    RUNPOD_POD_ID: "pod-test",
  };
  sh([
    "run",
    "-d",
    "--name",
    name,
    // RunPod's proxy reaches the pod's port; here control reaches it on this machine.
    "-p",
    "127.0.0.1::8790",
    "-e",
    "THERMITE_CALIBRATION_BLOCKS=0",
    "-e",
    "THERMITE_POLL_SECONDS=5",
    ...Object.entries(minted.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...Object.entries(runpod).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(foreign
      ? [
          // SELinux labels off for this container only: the VM would otherwise refuse the files
          // to every process, and the test must show the fence alone refusing the roles.
          "--security-opt",
          "label=disable",
          ...NODES.flatMap((n) => ["-v", `${FOREIGN}/${n}:/dev/${n}`]),
        ]
      : []),
    rigImage,
  ]);
  // Before enrollment: the supervisor serves the port, the harness waits.
  await waitFor("waiting for enrollment: the harness starts once control has enrolled the pod");
  const supervisorUp = await waitFor("waiting for the harness").catch(() => undefined);
  check(Boolean(supervisorUp) || pidsOf("dist/supervisor/main.js") !== "[]", "the supervisor runs");
  await sleep(3000);
  check(pidsOf("dist/harness/main.js") === "[]", "the harness does not start before enrollment");
  const keyFile = "/etc/thermite/control-signing.pub";
  check(
    spawnSync(engine, ["exec", name, "test", "-e", keyFile]).status !== 0,
    "no key for the harness before enrollment",
  );

  // Control connects to the pod and enrolls it, then exchanges with it as its loop does.
  const port = sh(["port", name, "8790/tcp"]).trim().split("\n")[0].split(":").at(-1);
  tunnels.attach(rig, "pod-test", `http://127.0.0.1:${port}`);
  pump = setInterval(() => {
    tunnels.advance(1000).catch((err) => console.error(`pull: ${String(err)}`));
  }, 500);
  await waitFor("enrolled: the harness starts with control's key from enrollment", 120_000);
  check(Boolean(store.tunnelRig(rig)?.enrolled_at), "control enrolled the pod and pinned its keys");
  await waitFor("judge ready");
  const tokenMade = logLines("made the token between the supervisor and the harness").length;
  check(tokenMade === 1, "the broker made the token between the two parts once");
  const keyNow = () => ({
    sha: keySha256(sh(["exec", name, "cat", keyFile])),
    stat: sh(["exec", name, "stat", "-c", "%U %a", keyFile]).trim(),
  });
  const given = keyNow();
  check(
    given.sha === keySha256(controlKeys.publicKeyPem) && given.stat === "root 644",
    "root gave the harness its own copy of control's key, the one the launch named",
    given.stat,
  );
  // The controller's environment, read as its own user: control's settings, not the code.
  const controller = JSON.parse(pidsOf("dist/harness/main.js"))[0];
  const ctlEnv = inside(
    `process.stdout.write(require("fs").readFileSync("/proc/${controller}/environ","latin1").split("\\0").map(kv=>kv.split("=")[0]+(kv.startsWith("THERMITE_TARGET_CLASS=")?"="+kv.split("=")[1]:"")).join("\\n"))`,
    "10010:10010",
  ).split("\n");
  check(
    ctlEnv.includes("THERMITE_TARGET_CLASS=rig-image-check") &&
      !ctlEnv.some((k) => /^(THERMITE_TUNNEL_(ENROLL_CODE|PREFIX|PORT)|RUNPOD_)/.test(k)),
    "the controller has the rig's settings from control, and no code, path or RunPod variable",
    ctlEnv.filter((k) => k.startsWith("THERMITE_TUNNEL") || k.startsWith("RUNPOD")).join(", "),
  );
  check(
    !logs().includes("made-up-key-for-the-test") &&
      !logs().includes(minted.env.THERMITE_TUNNEL_ENROLL_CODE),
    "RunPod's API key and the enrollment code appear nowhere in the rig's output",
  );
  // The rig's reports reach control, through control's pulls only.
  let reported = false;
  for (let i = 0; i < 60 && !reported; i++) {
    reported = store.rigs().some((r) => r.id === rig);
    if (!reported) await sleep(2000);
  }
  check(reported, "the rig's reports reach control through control's pulls");

  if (foreign) {
    const seen = sh(["exec", name, "stat", "-c", "%U %a", "/dev/nvidia0"]).trim();
    check(seen === "nobody 666", "the GPU's node is nobody's, 0666, as on RunPod", seen);
  }

  // The harness's own isolation check at start, as its controller's user.
  const started = JSON.parse(
    inside(
      `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(`${STATE}/harness/ledger/ledger.db`)},{readOnly:true});console.log(JSON.stringify(db.prepare("select body from event where kind='rig_check_finished' order by id").all().map(r=>JSON.parse(r.body))))`,
    ),
  );
  const atStart = started.find((b) => b.check === "isolation");
  check(atStart?.ok === true, "the harness's isolation check at start passes", atStart?.summary);
  const startContainer = atStart?.detail?.container ?? {};
  check(
    startContainer["supervisor-user"] === "uid 10001, gid 10001, no_new_privs" &&
      /^none \(read [1-9]/.test(startContainer["runpod-variables"] ?? "") &&
      /^none \(read [1-9]/.test(startContainer["enroll-code"] ?? "") &&
      startContainer["control-key"] === "root's, the key the launch named",
    "it checked the container, from the controller's side too",
    JSON.stringify(startContainer),
  );

  // The selftest as root: every process's environment can be read.
  const self = spawnSync(engine, ["exec", name, "thermite", "selftest", "isolation", "--force"], {
    encoding: "utf8",
  });
  let report;
  try {
    report = JSON.parse(self.stdout);
  } catch {
    report = { ok: false, error: `${self.stdout}${self.stderr}`.slice(-3000) };
  }
  check(report.ok === true, "the isolation selftest passes", report.devices ?? report.error);
  const c = report.container ?? {};
  check(
    c["supervisor-user"] === "uid 10001, gid 10001, no_new_privs",
    "the supervisor runs as its own user, with no_new_privs",
    c["supervisor-user"],
  );
  check(c["setid-files"] === "none", "no set-id file on the container's disk", c["setid-files"]);
  // Root without CAP_SYS_PTRACE reads only root's processes: PID 1 (tini) and the broker, from
  // whose environment the supervisor's and the controller's are made.
  const rp = /^none \(read (\d+) of (\d+) processes\)$/.exec(c["runpod-variables"] ?? "");
  check(
    Boolean(rp) && Number(rp[1]) >= 2 && Number(rp[2]) >= 4,
    "no process of the rig holds a RunPod variable, PID 1 included",
    c["runpod-variables"],
  );
  check(
    /^none \(read [1-9]/.test(c["enroll-code"] ?? "") &&
      c["control-key"] === "root's, the key the launch named",
    "only root and the supervisor had the code; the harness's key is root's and the launch's",
    `${c["enroll-code"]}; ${c["control-key"]}`,
  );
  check(
    foreign
      ? c["supervisor-gpu"] === "refused (fence: landlock)"
      : (c["supervisor-gpu"] ?? "").startsWith("no GPU node"),
    "the supervisor's user cannot open the GPU",
    c["supervisor-gpu"],
  );
  const roles = report.roles ?? {};
  const mustRefuse = [
    "pid1-environ",
    "supervisor-home",
    "supervisor-token",
    "inbox-list",
    "supervisor-environ",
    "control-key-write",
  ];
  const leaks = Object.entries(roles).flatMap(([role, r]) => [
    ...mustRefuse.filter((p) => !/^E[A-Z]+$/.test(r[p] ?? "")).map((p) => `${role} ${p}: ${r[p]}`),
    ...(r["runpod-variables"] === "none"
      ? []
      : [`${role} runpod-variables: ${r["runpod-variables"]}`]),
  ]);
  check(
    Object.keys(roles).length >= 6 && leaks.length === 0,
    "no role reaches the supervisor's places, PID 1's environment or a RunPod variable",
    leaks.slice(0, 6).join("; "),
  );
  if (foreign) {
    const fenced = ["builder", "lane-1", "agent-1"].map((r) => [r, roles[r]?.["device:nvidia0"]]);
    check(
      (report.devices ?? "").includes("fence: landlock") &&
        fenced.every(([, v]) => String(v).startsWith("EACCES")),
      "the GPU fence alone keeps every other role off the GPU",
      `${report.devices}; ${JSON.stringify(fenced)}`,
    );
  } else {
    console.log("SKIP nodes a container can't regroup: needs rootless Podman on a machine VM");
  }

  // A supervisor that exits starts again; so does the controller. Until the new supervisor serves
  // its port, control's pulls fail ("pull mode … fetch failed" in this script's output) and wait
  // a little longer each time: that is expected here.
  const before = pidsOf("dist/supervisor/main.js");
  kill("dist/supervisor/main.js");
  await waitFor("supervisor exited; restarting", 30_000);
  let after = "[]";
  for (let i = 0; i < 30 && (after === "[]" || after === before); i++) {
    await sleep(1000);
    after = pidsOf("dist/supervisor/main.js");
  }
  check(
    after !== "[]" && after !== before,
    "a supervisor that exits starts again",
    `${before} -> ${after}`,
  );
  // A supervisor that writes another key after enrollment changes nothing the harness trusts:
  // root copied the key once, at this start, after checking it.
  const otherKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  inside(
    `require("fs").writeFileSync("${STATE}/supervisor/enrolled/control.pub", ${JSON.stringify(otherKey)})`,
    "10001:10001",
  );
  kill("dist/harness/main.js");
  await waitFor("controller exited; restarting", 30_000);
  await waitFor("judge ready", 180_000, 2);
  check(true, "a controller that exits starts again");
  const kept = keyNow();
  check(
    kept.sha === given.sha && kept.stat === "root 644",
    "a key the supervisor writes later is not the one the harness trusts",
    kept.stat,
  );

  // A stop ends both parts, and the container exits with 0, even with control away. Control
  // stops connecting first, and the supervisor's calls (its reports, its poll for commands) wait
  // at its local port for control's next exchange, for up to two minutes each: the stop must end
  // them at once, not wait for control. (The engine's stop below also blocks this process, so
  // control could not answer during it anyway.)
  clearInterval(pump);
  await sleep(8000);
  const t0 = Date.now();
  sh(["stop", "-t", "60", name]);
  const stopS = Math.round((Date.now() - t0) / 1000);
  const code = sh(["inspect", name, "--format", "{{.State.ExitCode}}"]).trim();
  const stopped = logLines("stopped").length;
  const supervisorStopping = logLines("stopping").filter(
    (l) => l.component === "supervisor" && l.pull_mode === true,
  ).length;
  check(
    code === "0" && stopped === 1 && supervisorStopping === 1 && stopS < 60,
    "a stop ends both parts cleanly, with control away",
    `exit ${code}, ${stopS} s, "stopped" logged ${stopped} time(s), the supervisor stopping in pull mode ${supervisorStopping} time(s)`,
  );
  if (code !== "0" || stopped !== 1) console.log(`the rig's last output:\n${logs().slice(-4000)}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  failed++;
} finally {
  cleanup();
}
console.log(failed ? `rig image acceptance: ${failed} FAILED` : "rig image acceptance: OK");
process.exit(failed ? 1 : 0);
