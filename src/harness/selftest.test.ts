import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SUPERVISOR_RECORD } from "./broker/one-container.ts";
import {
  containerChecks,
  type IsolationReport,
  isFailure,
  isolationSummary,
  oneContainerTargets,
  PROBE,
  type Probe,
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

  test("all four together, as the selftest reports them", async () => {
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
    });
    assert.equal(Object.values(checks).some(isFailure), false);
  });
});
