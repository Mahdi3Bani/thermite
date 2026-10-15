import {
  chownSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BrokerClient } from "./broker/client.ts";
import { IDS, type Role, walk } from "./broker/runner.ts";
import { copyForRun } from "./judge/measure.ts";

/**
 * Isolation self-test, run as root inside the harness container (`thermite selftest
 * isolation`). For each role it asks the broker to run a probe as that role's user, which tries
 * to read, list or write what the role must not reach. Every probe must be refused, except a
 * `readable` probe, which must succeed.
 */

export interface Probe {
  name: string;
  op: "read" | "list" | "write" | "access" | "create" | "readable";
  path: string;
}

export interface IsolationReport {
  ok: boolean;
  roles: Record<string, Record<string, string>>;
  skipped: string[];
}

const PROBE = `
const fs = require("node:fs");
const probes = JSON.parse(process.argv[1]);
const out = {};
for (const p of probes) {
  try {
    if (p.op === "read" || p.op === "readable") fs.readFileSync(p.path);
    else if (p.op === "list") fs.readdirSync(p.path);
    else if (p.op === "write") fs.writeFileSync(p.path, "tampered", { flag: "r+" });
    else if (p.op === "create") fs.writeFileSync(p.path + "/probe-" + process.getuid(), "x");
    else fs.accessSync(p.path, fs.constants.W_OK);
    out[p.name] = p.op === "readable" ? "readable" : "ALLOWED";
  } catch (e) {
    out[p.name] = (p.op === "readable" ? "UNREADABLE " : "") + (e.code || String(e));
  }
}
process.stdout.write(JSON.stringify(out));
`;

function controllerPid(): number | undefined {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (Number(name) !== process.pid && (argv[1] ?? "").endsWith("dist/harness/main.js")) {
        return Number(name);
      }
    } catch {
      // gone
    }
  }
  return undefined;
}

function firstKitFile(kitsDir: string): string | undefined {
  if (!existsSync(kitsDir)) return undefined;
  for (const commit of readdirSync(kitsDir)) {
    const f = join(kitsDir, commit, "kit.json");
    if (existsSync(f)) return f;
  }
  return undefined;
}

function firstBuildFile(buildsDir: string): string | undefined {
  if (!existsSync(buildsDir)) return undefined;
  for (const key of readdirSync(buildsDir)) {
    const manifest = join(buildsDir, key, "manifest.json");
    if (!existsSync(manifest)) continue;
    const files = Object.keys(
      (JSON.parse(readFileSync(manifest, "utf8")) as { files: Record<string, string> }).files,
    );
    if (files[0]) return join(buildsDir, key, files[0]);
  }
  return undefined;
}

/**
 * Why the rig is too busy for the selftest, if it is. Each probe ends by killing every process
 * of its role's user (as every run does), so probing while a worker, a dev run or a timed run is
 * live would kill it.
 */
export function busyReason(stateDir: string): string | undefined {
  const path = join(stateDir, "ledger", "ledger.db");
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    const trials = n("select count(*) as n from trial where ended_at is null");
    const jobs = n("select count(*) as n from job where state in ('queued', 'leased')");
    if (trials || jobs) {
      return `${trials} open trial(s) and ${jobs} judge job(s): pause the rig's runs and let the judge finish first (each probe kills its role's processes)`;
    }
    return undefined;
  } finally {
    db.close();
  }
}

export async function isolationSelftest(opts: {
  socketPath: string;
  stateDir: string;
  scratchDir: string;
  outboxDir: string;
  secretFiles: string[];
  roles?: Role[];
  /** Probe even while trials or judge jobs are live (they may be killed). */
  force?: boolean;
}): Promise<IsolationReport> {
  const busy = opts.force ? undefined : busyReason(opts.stateDir);
  if (busy) throw new Error(`the rig is busy: ${busy}; rerun with --force to probe anyway`);
  const skipped: string[] = [];
  const probes: Probe[] = [
    { name: "ledger", op: "read", path: join(opts.stateDir, "ledger", "ledger.db") },
    { name: "state-list", op: "list", path: opts.stateDir },
    { name: "kits", op: "list", path: join(opts.stateDir, "kits") },
    { name: "git-mirrors", op: "list", path: join(opts.stateDir, "git") },
    { name: "models-list", op: "list", path: join(opts.stateDir, "models") },
    { name: "builds-list", op: "list", path: join(opts.stateDir, "builds") },
    { name: "broker-socket", op: "access", path: opts.socketPath },
    { name: "outbox-write", op: "access", path: opts.outboxDir },
    { name: "outbox-read", op: "list", path: opts.outboxDir },
    { name: "runs-list", op: "list", path: join(opts.scratchDir, "thermite", "runs") },
    { name: "tmp-create", op: "create", path: "/tmp" },
    { name: "var-tmp-create", op: "create", path: "/var/tmp" },
    { name: "shm-create", op: "create", path: "/dev/shm" },
  ];
  const kitFile = firstKitFile(join(opts.stateDir, "kits"));
  if (kitFile) probes.push({ name: "kit-by-path", op: "read", path: kitFile });
  else skipped.push("kit-by-path (no kit checked out yet)");
  for (const f of opts.secretFiles) probes.push({ name: `secret:${f}`, op: "read", path: f });
  const build = firstBuildFile(join(opts.stateDir, "builds"));
  if (build) probes.push({ name: "build-overwrite", op: "write", path: build });
  else skipped.push("build-overwrite (no build yet)");
  // A run's copy of the kit's run.copy paths, made as the judge makes it and owned by the
  // controller's user: the run user reads it, and no role may change or add to it.
  const runKit = join(opts.scratchDir, "thermite", "selftest-run-kit");
  rmSync(runKit, { recursive: true, force: true });
  mkdirSync(join(runKit, "src", "run"), { recursive: true });
  writeFileSync(join(runKit, "src", "run", "driver.sh"), "#!/bin/sh\n", { mode: 0o755 });
  copyForRun(join(runKit, "src"), ["run"], join(runKit, "kit"));
  walk(join(runKit, "kit"), (p) => chownSync(p, IDS.thermite.uid, IDS.thermite.gid));
  const driver = join(runKit, "kit", "run", "driver.sh");
  probes.push(
    { name: "run-kit-write", op: "write", path: driver },
    { name: "run-kit-create", op: "create", path: join(runKit, "kit", "run") },
  );
  const pid = controllerPid();
  if (pid) probes.push({ name: "controller-environ", op: "read", path: `/proc/${pid}/environ` });
  else skipped.push("controller-environ (controller not found)");
  for (const dev of existsSync("/dev") ? readdirSync("/dev") : []) {
    if (dev.startsWith("nvidia") && !statSync(join("/dev", dev)).isDirectory()) {
      probes.push({ name: `device:${dev}`, op: "access", path: join("/dev", dev) });
    }
  }

  const client = new BrokerClient(opts.socketPath);
  const roles = opts.roles ?? (["builder", "run", "lane-1", "lane-1-dev", "agent-1"] as Role[]);
  const report: IsolationReport = { ok: true, roles: {}, skipped };
  try {
    for (const role of roles) {
      const cwd = join(opts.scratchDir, "thermite", `selftest-${role}`);
      mkdirSync(cwd, { recursive: true });
      await client.handOver(cwd, role);
      // `run` and the development users legitimately reach the device: skip those probes there.
      const mine = probes.filter(
        (p) => !(p.name.startsWith("device:") && (role === "run" || role.endsWith("-dev"))),
      );
      if (role === "run") mine.push({ name: "run-kit-read", op: "readable", path: driver });
      const r = await client.run({
        role,
        argv: [process.execPath, "-e", PROBE, JSON.stringify(mine)],
        cwd,
        timeoutMs: 30_000,
      });
      await client.remove(cwd);
      let results: Record<string, string>;
      try {
        results = JSON.parse(r.stdout) as Record<string, string>;
      } catch {
        results = { probe: `failed: exit ${r.exitCode} ${r.stderr.slice(-200)}` };
      }
      report.roles[role] = results;
      if (
        Object.values(results).some(
          (v) => v === "ALLOWED" || v.startsWith("UNREADABLE") || v.startsWith("failed"),
        )
      ) {
        report.ok = false;
      }
    }
  } finally {
    client.close();
    rmSync(runKit, { recursive: true, force: true });
  }
  return report;
}
