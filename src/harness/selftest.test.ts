import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { keySha256 } from "../core/tunnel.ts";
import { SUPERVISOR_RECORD } from "./broker/one-container.ts";
import {
  callsBusy,
  containerChecks,
  controlKeyCheck,
  enrollCodeCheck,
  type IsolationReport,
  isFailure,
  isolationBusy,
  isolationSummary,
  oneContainerTargets,
  PROBE,
  type Probe,
  platformInit,
  runpodCheck,
  setIdCheck,
  supervisorGpuCheck,
  supervisorUserCheck,
} from "./selftest.ts";

/** A made-up /proc: each process's parent, command line, ids and environment. */
function fakeProc(
  procs: {
    pid: number;
    ppid: number;
    argv?: string[];
    uid?: number;
    gid?: number;
    nnp?: boolean;
    env?: Record<string, string>;
    hidden?: boolean;
  }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), "proc-"));
  for (const p of procs) {
    const d = join(dir, String(p.pid));
    mkdirSync(d);
    const u = p.uid ?? 0;
    const g = p.gid ?? 0;
    writeFileSync(
      join(d, "status"),
      `Name:\tnode\nPPid:\t${p.ppid}\nUid:\t${u}\t${u}\t${u}\t${u}\nGid:\t${g}\t${g}\t${g}\t${g}\nNoNewPrivs:\t${p.nnp ? 1 : 0}\n`,
    );
    writeFileSync(join(d, "cmdline"), `${(p.argv ?? ["sleep"]).join("\0")}\0`);
    const environ = join(d, "environ");
    writeFileSync(
      environ,
      `${Object.entries(p.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\0")}\0`,
    );
    if (p.hidden) chmodSync(environ, 0o000);
  }
  return dir;
}

const SUPERVISOR = ["/usr/local/bin/node", "/opt/thermite/dist/supervisor/main.js"];
const asRoot = process.getuid?.() === 0;

/** Runs the roles' probe script here, as this user, with these probes and this environment. */
function probe(probes: Probe[], env: Record<string, string> = {}): Record<string, string> {
  const r = spawnSync(process.execPath, ["-e", PROBE, JSON.stringify(probes)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, string>;
}

describe("when the isolation selftest waits", () => {
  test("a live planner call or model check makes it wait: a probe would kill its user's processes", () => {
    const planner = { uid: 10040 };
    const check = { uid: 10041 };
    const lane = { uid: 10101 };
    assert.equal(callsBusy([]), undefined);
    assert.equal(callsBusy([lane, { uid: 0 }]), undefined);
    assert.equal(
      callsBusy([planner]),
      "a planner call is running: wait for it to end (each probe kills its role's processes)",
    );
    assert.equal(
      callsBusy([check, planner]),
      "a planner call and a model check are running: wait for them to end (each probe kills its role's processes)",
    );
    // With no ledger yet, only the live calls count.
    const state = mkdtempSync(join(tmpdir(), "thermite-busy-"));
    assert.equal(
      isolationBusy(state, () => []),
      undefined,
    );
    assert.match(String(isolationBusy(state, () => [check])), /^a model check is running/);
  });
});

describe("the isolation selftest's results", () => {
  test("what fails it", () => {
    for (const v of [
      "ALLOWED",
      "UNREADABLE EACCES",
      "UNREACHABLE EACCES",
      "WRONG GPUS GPU-1",
      "WRONG USER: pid 9 has uids 0 0 0 0, gids 0 0 0 0",
      "FOUND RUNPOD_API_KEY (own)",
      "OPENED /dev/nvidia0",
      "MISSING: no supervisor process",
      "failed: exit 1",
    ])
      assert.equal(isFailure(v), true, v);
    for (const v of ["EACCES", "ENOENT", "readable", "reachable", "sees GPU-1", "none", "refused"])
      assert.equal(isFailure(v), false, v);
  });

  test("the summary names a failed container check", () => {
    const report: IsolationReport = {
      ok: false,
      devices: "shared (fence: landlock)",
      roles: { builder: { ledger: "EACCES" } },
      container: { "setid-files": "FOUND 1 set-id files: /usr/bin/su", "runpod-variables": "none" },
      skipped: [],
    };
    assert.equal(
      isolationSummary(report),
      "isolation does NOT hold (devices: shared (fence: landlock)): container setid-files: FOUND 1 set-id files: /usr/bin/su",
    );
    assert.equal(
      isolationSummary({ ...report, ok: true, container: {} }),
      "isolation holds: every probe of 1 roles came out as it must (devices: shared (fence: landlock))",
    );
  });
});

describe("a role's probe for RunPod's variables", () => {
  test("none in its own environment or any it can read", () => {
    const proc = fakeProc([{ pid: 1, ppid: 0, env: { PATH: "/bin" } }]);
    const out = probe([{ name: "runpod-variables", op: "runpod", path: proc }]);
    assert.equal(out["runpod-variables"], "none");
  });

  test("found in its own environment", () => {
    const proc = fakeProc([{ pid: 1, ppid: 0 }]);
    const out = probe([{ name: "runpod-variables", op: "runpod", path: proc }], {
      RUNPOD_API_KEY: "made-up",
    });
    assert.equal(out["runpod-variables"], "FOUND RUNPOD_API_KEY (own)");
  });

  test("found in a process's environment it can read; one it cannot read is passed over", () => {
    const proc = fakeProc([
      { pid: 1, ppid: 0, env: { RUNPOD_POD_ID: "pod-1" }, hidden: !asRoot },
      { pid: 42, ppid: 1, env: { A: "1", RUNPOD_API_KEY: "made-up" } },
    ]);
    const out = probe([{ name: "runpod-variables", op: "runpod", path: proc }]);
    assert.equal(
      out["runpod-variables"],
      asRoot
        ? "FOUND RUNPOD_POD_ID (pid 1), RUNPOD_API_KEY (pid 42)"
        : "FOUND RUNPOD_API_KEY (pid 42)",
    );
  });

  test("a probe that cannot list the processes fails", () => {
    const out = probe([{ name: "runpod-variables", op: "runpod", path: "/no/such/proc" }]);
    assert.equal(out["runpod-variables"], "failed: ENOENT");
    assert.equal(isFailure(out["runpod-variables"] as string), true);
  });
});

describe("the one-container image's checks of the container", () => {
  test("they apply only with THERMITE_ONE_CONTAINER=1, to the supervisor's places", () => {
    assert.equal(oneContainerTargets({}), undefined);
    assert.deepEqual(
      oneContainerTargets({
        THERMITE_ONE_CONTAINER: "1",
        THERMITE_SUPERVISOR_HOME: "/workspace/thermite/supervisor",
        THERMITE_INBOX_DIR: "/workspace/thermite/inbox",
      }),
      {
        supervisorHome: "/workspace/thermite/supervisor",
        supervisorToken: "/workspace/thermite/supervisor/harness-token",
        inboxDir: "/workspace/thermite/inbox",
      },
    );
    // Pull mode: the key the harness trusts, and the SHA-256 the launch named.
    assert.deepEqual(
      oneContainerTargets({
        THERMITE_ONE_CONTAINER: "1",
        THERMITE_CONTROL_PUBKEY_FILE: "/etc/thermite/control-signing.pub",
        THERMITE_TUNNEL_CONTROL_KEY_SHA256: "a".repeat(64),
      })?.controlKey,
      { file: "/etc/thermite/control-signing.pub", sha256: "a".repeat(64) },
    );
  });

  test("the enrollment code: only root's processes and the supervisor's own may hold it", () => {
    const code = { THERMITE_TUNNEL_ENROLL_CODE: "c".repeat(64) };
    const clean = fakeProc([
      { pid: 1, ppid: 0, env: code },
      { pid: 2, ppid: 1, env: code },
      { pid: 7, ppid: 2, argv: SUPERVISOR, uid: 10001, gid: 10001, env: code },
      // What the supervisor starts, after taking the code out of its environment.
      { pid: 8, ppid: 7, uid: 10001, gid: 10001, env: { PATH: "/bin" } },
      { pid: 9, ppid: 2, uid: 10010, gid: 10010, env: { THERMITE_TUNNEL_DIR: "/t" } },
    ]);
    assert.equal(enrollCodeCheck(clean), "none (read 5 of 5 processes)");
    const leaked = fakeProc([
      { pid: 1, ppid: 0 },
      { pid: 9, ppid: 1, uid: 10010, gid: 10010, env: code },
      { pid: 11, ppid: 1, uid: 10001, gid: 10001, env: code },
    ]);
    assert.equal(
      enrollCodeCheck(leaked),
      "FOUND THERMITE_TUNNEL_ENROLL_CODE in pid 9 (uid 10010), pid 11 (uid 10001)",
    );
  });

  test("control's key for the harness: root's, closed to other writers, the launch's", () => {
    const me = process.getuid?.() ?? 0;
    const top = mkdtempSync(join(tmpdir(), "etc-"));
    chmodSync(top, 0o755);
    const dir = join(top, "thermite");
    mkdirSync(dir, { mode: 0o755 });
    const file = join(dir, "control-signing.pub");
    const keys = generateKeyPairSync("ed25519");
    const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const sha = keySha256(pem);
    const check = (s = sha, uid = me) => controlKeyCheck(file, s, { rootUid: uid, top });
    assert.match(check(), /^MISSING: /);
    writeFileSync(file, pem, { mode: 0o644 });
    assert.equal(check(), "root's, the key the launch named");
    assert.equal(check("0".repeat(64)), "WRONG: it is not the key the launch named by its SHA-256");
    assert.match(
      check(sha, me + 1),
      /^WRONG: .* is uid \d+, mode 644: another user could change it/,
    );
    chmodSync(file, 0o664);
    assert.match(check(), /^WRONG: .*control-signing.pub is uid \d+, mode 664/);
    chmodSync(file, 0o644);
    chmodSync(dir, 0o777);
    assert.match(check(), /^WRONG: .*thermite is uid \d+, mode 777/);
    chmodSync(dir, 0o755);
    assert.equal(isFailure(check()), false);
  });

  test("the supervisor runs as its own user with no_new_privs", async () => {
    const good = fakeProc([
      { pid: 1, ppid: 0 },
      { pid: 7, ppid: 1, argv: SUPERVISOR, uid: 10001, gid: 10001, nnp: true },
    ]);
    assert.equal(await supervisorUserCheck(good, 0), "uid 10001, gid 10001, no_new_privs");
    const asRootProc = fakeProc([{ pid: 7, ppid: 1, argv: SUPERVISOR, nnp: true }]);
    assert.match(await supervisorUserCheck(asRootProc, 0), /^WRONG USER: pid 7 has uids 0 0 0 0/);
    const mayGain = fakeProc([{ pid: 7, ppid: 1, argv: SUPERVISOR, uid: 10001, gid: 10001 }]);
    assert.match(await supervisorUserCheck(mayGain, 0), /^WRONG: pid 7 may gain privileges/);
    const none = fakeProc([{ pid: 1, ppid: 0 }]);
    assert.equal(await supervisorUserCheck(none, 0), "MISSING: no supervisor process");
  });

  test("the supervisor's GPU access, as the broker recorded it", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-"));
    assert.match(supervisorGpuCheck(dir), /^MISSING: no record from the broker/);
    const record = (gpu: string) =>
      writeFileSync(
        join(dir, SUPERVISOR_RECORD),
        JSON.stringify({ uid: 10001, gid: 10001, fence: "landlock", gpu, home: "/h", at: "x" }),
      );
    record("refused");
    assert.equal(supervisorGpuCheck(dir), "refused (fence: landlock)");
    record("no GPU node");
    assert.equal(supervisorGpuCheck(dir), "no GPU node (fence: landlock)");
    record("OPENED /dev/nvidia0");
    assert.equal(supervisorGpuCheck(dir), "OPENED /dev/nvidia0");
  });

  test("set-id files are found, outside the folders left out", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    mkdirSync(join(root, "scratch"));
    writeFileSync(join(root, "usr", "bin", "plain"), "");
    assert.equal(setIdCheck(root), "none");
    writeFileSync(join(root, "scratch", "own"), "");
    chmodSync(join(root, "scratch", "own"), 0o4755);
    assert.equal(setIdCheck(root, [join(root, "scratch")]), "none");
    writeFileSync(join(root, "usr", "bin", "su"), "");
    chmodSync(join(root, "usr", "bin", "su"), 0o4755);
    assert.equal(
      setIdCheck(root, [join(root, "scratch")]),
      `FOUND 1 set-id files: ${join(root, "usr", "bin", "su")}`,
    );
    assert.match(setIdCheck(root), /^FOUND 2 set-id files/);
  });

  test("RunPod's variables in the rig's processes, not in a shell started from outside", () => {
    const clean = fakeProc([
      { pid: 1, ppid: 0, env: { PATH: "/bin" } },
      { pid: 10, ppid: 1, env: { THERMITE_POD_ID: "pod-1" } },
      // A shell opened with `exec` keeps the container's variables; it is not the rig's.
      { pid: 99, ppid: 0, env: { RUNPOD_API_KEY: "made-up" } },
    ]);
    assert.equal(runpodCheck(clean), "none (read 2 of 2 processes)");
    const leaked = fakeProc([
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10, env: { RUNPOD_API_KEY: "made-up" } },
    ]);
    assert.equal(runpodCheck(leaked), "FOUND RUNPOD_API_KEY (pid 11)");
  });

  test("a platform's own init at PID 1 keeps RunPod's variables; the rig's processes don't", () => {
    // RunPod runs an init of its own as PID 1; the image's entry point is its child.
    const onRunpod = fakeProc([
      { pid: 1, ppid: 0, env: { RUNPOD_API_KEY: "made-up", RUNPOD_POD_ID: "pod-1" } },
      { pid: 10, ppid: 1, env: { THERMITE_TUNNEL_POD: "pod-1" } },
      { pid: 11, ppid: 10, env: { PATH: "/bin" } },
    ]);
    symlinkSync("/sbin/docker-init", join(onRunpod, "1", "exe"));
    assert.equal(platformInit(onRunpod), "/sbin/docker-init");
    assert.equal(
      runpodCheck(onRunpod),
      "none (read 2 of 2 processes); PID 1 is the platform's own init (/sbin/docker-init), not the rig's, and keeps the container's first environment",
    );
    // A process the entry point started still counts.
    const leaked = fakeProc([
      { pid: 1, ppid: 0, env: { RUNPOD_API_KEY: "made-up" } },
      { pid: 10, ppid: 1, env: { RUNPOD_API_KEY: "made-up" } },
    ]);
    symlinkSync("/sbin/docker-init", join(leaked, "1", "exe"));
    assert.equal(runpodCheck(leaked), "FOUND RUNPOD_API_KEY (pid 10)");
    // PID 1 as the image's own tini is the rig's: its variables count.
    const ownInit = fakeProc([{ pid: 1, ppid: 0, env: { RUNPOD_API_KEY: "made-up" } }]);
    symlinkSync("/usr/bin/tini", join(ownInit, "1", "exe"));
    assert.equal(platformInit(ownInit), undefined);
    assert.equal(runpodCheck(ownInit), "FOUND RUNPOD_API_KEY (pid 1)");
  });

  test("all of them together, as the selftest reports them", async () => {
    const proc = fakeProc([
      { pid: 1, ppid: 0 },
      { pid: 7, ppid: 1, argv: SUPERVISOR, uid: 10001, gid: 10001, nnp: true },
    ]);
    const broker = mkdtempSync(join(tmpdir(), "broker-"));
    writeFileSync(
      join(broker, SUPERVISOR_RECORD),
      JSON.stringify({ uid: 10001, gid: 10001, fence: "none", gpu: "no GPU node" }),
    );
    const root = mkdtempSync(join(tmpdir(), "root-"));
    const checks = await containerChecks({
      brokerDir: broker,
      procDir: proc,
      rootDir: root,
      waitMs: 0,
    });
    assert.deepEqual(checks, {
      "supervisor-user": "uid 10001, gid 10001, no_new_privs",
      "supervisor-gpu": "no GPU node (fence: none)",
      "setid-files": "none",
      "runpod-variables": "none (read 2 of 2 processes)",
      "enroll-code": "none (read 2 of 2 processes)",
    });
    assert.equal(Object.values(checks).some(isFailure), false);
    // Pull mode adds the key the harness trusts: here missing, which fails the selftest.
    const pull = await containerChecks({
      brokerDir: broker,
      procDir: proc,
      rootDir: root,
      waitMs: 0,
      controlKey: { file: join(root, "control-signing.pub"), sha256: "a".repeat(64) },
    });
    assert.match(pull["control-key"] ?? "", /^MISSING: /);
    assert.equal(isFailure(pull["control-key"] ?? ""), true);
  });
});
