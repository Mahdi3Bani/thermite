import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  controlKeyPem,
  isRunpodVariable,
  OPEN_NODES_JS,
  oneContainer,
  restartAfter,
  SUPERVISOR_PASSWD_HOME,
  supervisorArgv,
  supervisorEnv,
  supervisorGpu,
  supervisorPaths,
  withoutRunpod,
} from "./one-container.ts";

// RunPod's variables as the first spike found them (names only; the values are made up).
const RUNPOD = {
  RUNPOD_API_KEY: "made-up-key",
  RUNPOD_CPU_COUNT: "8",
  RUNPOD_DC_ID: "dc-1",
  RUNPOD_GPU_COUNT: "1",
  RUNPOD_GPU_NAME: "a gpu",
  RUNPOD_MEM_GB: "31",
  RUNPOD_POD_HOSTNAME: "pod-1-host",
  RUNPOD_POD_ID: "pod-1",
};
const SECRET_VARS = ["THERMITE_SUPERVISOR_TOKEN_FILE", "THERMITE_PROPOSER_TOKEN_FILE"];

describe("the one-container rig image", () => {
  test("only THERMITE_ONE_CONTAINER=1 turns it on", () => {
    assert.equal(oneContainer({ THERMITE_ONE_CONTAINER: "1" }), true);
    assert.equal(oneContainer({ THERMITE_ONE_CONTAINER: "0" }), false);
    assert.equal(oneContainer({}), false);
  });

  test("RunPod's variables are left out of an environment", () => {
    assert.equal(isRunpodVariable("RUNPOD_API_KEY"), true);
    assert.equal(isRunpodVariable("THERMITE_POD_ID"), false);
    const env = withoutRunpod({ ...RUNPOD, PATH: "/bin", GONE: undefined });
    assert.deepEqual(env, { PATH: "/bin" });
  });

  test("the supervisor gets its own places and none of RunPod's or the harness's secrets", () => {
    const base = {
      ...RUNPOD,
      PATH: "/usr/bin",
      THERMITE_RIG_ID: "rig-1",
      THERMITE_POD_ID: "pod-1",
      THERMITE_SUPERVISOR_HOME: "/workspace/thermite/supervisor",
      THERMITE_INBOX_DIR: "/workspace/thermite/inbox",
      THERMITE_SUPERVISOR_TOKEN_FILE: "/workspace/thermite/secrets/supervisor-token",
      THERMITE_PROPOSER_TOKEN_FILE: "/run/secrets/proposer",
      HOME: "/root",
    };
    const paths = supervisorPaths(base);
    assert.deepEqual(paths, {
      home: "/workspace/thermite/supervisor",
      tmp: "/workspace/thermite/supervisor/tmp",
      inbox: "/workspace/thermite/inbox",
      tokenFile: "/workspace/thermite/supervisor/harness-token",
    });
    const env = supervisorEnv(base, paths, SECRET_VARS);
    assert.deepEqual(
      Object.keys(env).filter((k) => k.startsWith("RUNPOD_")),
      [],
    );
    assert.equal(env.THERMITE_SUPERVISOR_TOKEN_FILE, undefined);
    assert.equal(env.THERMITE_PROPOSER_TOKEN_FILE, undefined);
    assert.equal(env.THERMITE_HARNESS_TOKEN_FILE, paths.tokenFile);
    assert.equal(env.HOME, SUPERVISOR_PASSWD_HOME);
    assert.equal(env.TMPDIR, paths.tmp);
    assert.equal(env.USER, "supervisor");
    assert.equal(env.THERMITE_RIG_ID, "rig-1");
    assert.equal(env.THERMITE_POD_ID, "pod-1");
    // Defaults: the supervisor image's places.
    assert.equal(supervisorPaths({}).home, "/var/lib/thermite-supervisor");
    assert.equal(supervisorPaths({}).inbox, "/inbox");
  });

  test("the supervisor starts with no_new_privs, in the GPU fence where there is one", () => {
    const cmd = ["/usr/local/bin/node", "/opt/thermite/dist/supervisor/main.js"];
    assert.deepEqual(supervisorArgv(cmd, { setpriv: "/usr/bin/setpriv", fence: "/f" }), [
      "/usr/bin/setpriv",
      "--no-new-privs",
      "--",
      "/f",
      "--",
      ...cmd,
    ]);
    assert.deepEqual(supervisorArgv(cmd, { setpriv: "/usr/bin/setpriv", fence: undefined }), [
      "/usr/bin/setpriv",
      "--no-new-privs",
      "--",
      ...cmd,
    ]);
    assert.throws(() => supervisorArgv(cmd, { setpriv: undefined, fence: "/f" }), /setpriv/);
  });

  test("the supervisor's GPU probe: refused, opened, no node, or failed", () => {
    const answer =
      (stdout: string, status = 0) =>
      () => ({ status, stdout, stderr: "boom" });
    assert.equal(supervisorGpu([], "node", answer("[]")), "no GPU node");
    assert.equal(supervisorGpu(["/dev/nvidia0"], "node", answer("[]")), "refused");
    assert.equal(
      supervisorGpu(["/dev/nvidia0", "/dev/nvidiactl"], "node", answer('["/dev/nvidia0"]')),
      "OPENED /dev/nvidia0",
    );
    assert.match(supervisorGpu(["/dev/nvidia0"], "node", answer("", 126)), /^failed: exit 126/);
    assert.match(supervisorGpu(["/dev/nvidia0"], "node", answer("{}")), /^failed/);
  });

  test("the GPU probe's script opens what it may and reports only that", () => {
    const dir = mkdtempSync(join(tmpdir(), "rig-gpu-"));
    const open = join(dir, "nvidia0");
    const closed = join(dir, "nvidia1");
    writeFileSync(open, "");
    writeFileSync(closed, "");
    chmodSync(closed, 0o000);
    const got = supervisorGpu([open, closed, join(dir, "missing")], process.execPath, (c) => {
      const r = spawnSync(c[0] as string, c.slice(1), { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    });
    // Root opens a file whatever its mode: then both show.
    assert.equal(got, process.getuid?.() === 0 ? `OPENED ${open}, ${closed}` : `OPENED ${open}`);
    assert.ok(OPEN_NODES_JS.includes("r+"), "it opens each node for reading and writing");
  });

  test("control's key from the launch: an Ed25519 public key in PEM or base64", () => {
    const pem = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    assert.equal(controlKeyPem(pem), pem);
    assert.equal(controlKeyPem(Buffer.from(pem).toString("base64")), pem);
    assert.equal(controlKeyPem(`\n${Buffer.from(pem).toString("base64")}\n`), pem);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    assert.throws(() => controlKeyPem(rsa), /rsa key; control signs with Ed25519/);
    assert.throws(() => controlKeyPem("not a key"), /not a public key/);
  });

  test("a part that exits soon waits longer each time, up to 30 seconds", () => {
    let r = 0;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const next = restartAfter(1000, r);
      r = next.restarts;
      delays.push(next.delayMs);
    }
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    // After a long run it starts again after a second.
    assert.deepEqual(restartAfter(120_000, 5), { restarts: 0, delayMs: 1000 });
  });
});

describe("the entry point removes RunPod's variables", () => {
  const start = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "containers",
    "rig",
    "thermite-rig-start",
  );
  // What the started program sees, exactly: its environment as JSON.
  const run = (env: Record<string, string>) => {
    const r = spawnSync(
      "/bin/sh",
      [start, process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
      { encoding: "utf8", env },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as Record<string, string>;
  };

  test("no RUNPOD_ variable reaches what it starts; the pod's ID goes on as THERMITE_POD_ID", () => {
    const env = run({ PATH: "/usr/bin:/bin", ...RUNPOD, THERMITE_RIG_ID: "rig-1" });
    assert.deepEqual(
      Object.keys(env).filter((k) => k.startsWith("RUNPOD_")),
      [],
    );
    assert.equal(env.THERMITE_POD_ID, "pod-1");
    assert.equal(env.THERMITE_RIG_ID, "rig-1");
  });

  test("a THERMITE_POD_ID given at launch stays, and none is made up without a pod", () => {
    assert.equal(
      run({ PATH: "/usr/bin:/bin", RUNPOD_POD_ID: "pod-1", THERMITE_POD_ID: "given" })
        .THERMITE_POD_ID,
      "given",
    );
    assert.equal(run({ PATH: "/usr/bin:/bin" }).THERMITE_POD_ID, undefined);
  });

  test("a value that looks like a RunPod line is left as it is", () => {
    const env = run({ PATH: "/usr/bin:/bin", NOTE: "x\nRUNPOD_FAKE=1", RUNPOD_API_KEY: "k" });
    assert.equal(env.RUNPOD_API_KEY, undefined);
    assert.equal(env.NOTE, "x\nRUNPOD_FAKE=1");
    assert.equal(env.RUNPOD_FAKE, undefined);
  });
});
