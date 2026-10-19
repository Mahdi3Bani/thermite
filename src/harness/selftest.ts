import {
  chmodSync,
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
import { cardsOf, type GpuLayout, judgeCardOf, readLayout, runRole } from "./broker/devices.ts";
import { IDS, type Role, walk } from "./broker/runner.ts";
import { copyForRun } from "./judge/measure.ts";

/**
 * Isolation self-test, run as root inside the harness container (`thermite selftest
 * isolation`). For each role it asks the broker to run a probe as that role's user, which tries
 * to read, list or write what the role must not reach. Every probe must be refused, except a
 * `readable` or `reachable` probe, which must succeed.
 */

export interface Probe {
  name: string;
  op: "read" | "list" | "write" | "access" | "open" | "create" | "readable" | "reachable" | "gpus";
  path: string;
  /** For `gpus`: the only card UUIDs nvidia-smi may list, comma-separated. */
  expect?: string;
}

export interface IsolationReport {
  ok: boolean;
  /** "shared", or "dedicated" with the judge's and the development card's nodes. */
  devices: string;
  roles: Record<string, Record<string, string>>;
  skipped: string[];
}

const PROBE = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const probes = JSON.parse(process.argv[1]);
const out = {};
for (const p of probes) {
  if (p.op === "gpus") {
    // A card whose node is refused is silently left out, so check exactly which cards show.
    let ids = "";
    try {
      const listed = execFileSync("nvidia-smi", ["-L"], { encoding: "utf8" });
      ids = [...listed.matchAll(/UUID: (GPU-[0-9a-fA-F-]+)/g)].map((m) => m[1]).join(",");
    } catch (e) {
      ids = "none (" + (e.code || e.status) + ")";
    }
    out[p.name] = ids === p.expect ? "sees " + ids : "WRONG GPUS " + ids;
    continue;
  }
  try {
    if (p.op === "read" || p.op === "readable") fs.readFileSync(p.path);
    else if (p.op === "list") fs.readdirSync(p.path);
    else if (p.op === "write") fs.writeFileSync(p.path, "tampered", { flag: "r+" });
    else if (p.op === "create") fs.writeFileSync(p.path + "/probe-" + process.getuid(), "x");
    // A device node is opened for real (and closed): file modes and the Landlock fence both
    // act on opening, while access() sees only the modes.
    else if (p.op === "reachable" || p.op === "open") fs.closeSync(fs.openSync(p.path, "r+"));
    else fs.accessSync(p.path, fs.constants.W_OK);
    out[p.name] = p.op === "readable" || p.op === "reachable" ? p.op : "ALLOWED";
  } catch (e) {
    const must = { readable: "UNREADABLE ", reachable: "UNREACHABLE " }[p.op] || "";
    out[p.name] = must + (e.code || String(e));
  }
}
process.stdout.write(JSON.stringify(out));
`;

/** Who a role is to the device: the run user, a development run, or neither. */
function deviceSide(role: Role, gpu: boolean): "judge" | "dev" | "other" {
  if (judgeCardOf(role) !== undefined) return "judge";
  return gpu || role.endsWith("-dev") ? "dev" : "other";
}

/**
 * The device-node probes for one side. In shared mode the run user and development runs reach
 * every node and are not probed; everyone else is refused every node. With dedicated cards each
 * judge identity and each development card must reach its own card and the shared nodes, and be
 * refused every other card, and nvidia-smi must list exactly its own card.
 */
export function deviceProbes(
  nodes: string[],
  side: "judge" | "dev" | "other",
  layout?: GpuLayout | undefined,
  card = 0,
): Probe[] {
  const refuse = (p: string): Probe => ({ name: `device:${p.slice(5)}`, op: "open", path: p });
  const reach = (p: string): Probe => ({ name: `device:${p.slice(5)}`, op: "reachable", path: p });
  if (side === "other") return nodes.map(refuse);
  if (!layout) return [];
  const { judges, devs } = cardsOf(layout);
  const own = (side === "judge" ? judges : devs)[card];
  if (!own) throw new Error(`no ${side === "judge" ? "judge" : "development"} card ${card + 1}`);
  const others = [...judges, ...devs].filter((c) => c.node !== own.node);
  return [
    reach(own.node),
    ...layout.control.map(reach),
    ...others.map((c) => refuse(c.node)),
    { name: "visible-gpus", op: "gpus", path: "nvidia-smi", expect: own.uuid },
  ];
}

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
  /** The rig is configured for a dedicated development card (THERMITE_DEV_GPU_INDEX). */
  dedicated?: boolean;
  /** Probe even while trials or judge jobs are live (they may be killed). */
  force?: boolean;
  /** The controller's pid, when the controller itself runs the selftest (a rig check). */
  controllerPid?: number;
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
  removeOwnTree(runKit);
  mkdirSync(join(runKit, "src", "run"), { recursive: true });
  writeFileSync(join(runKit, "src", "run", "driver.sh"), "#!/bin/sh\n", { mode: 0o755 });
  copyForRun(join(runKit, "src"), ["run"], join(runKit, "kit"));
  walk(join(runKit, "kit"), (p) => chownSync(p, IDS.thermite.uid, IDS.thermite.gid));
  const driver = join(runKit, "kit", "run", "driver.sh");
  probes.push(
    { name: "run-kit-write", op: "write", path: driver },
    { name: "run-kit-create", op: "create", path: join(runKit, "kit", "run") },
  );
  const pid = opts.controllerPid ?? controllerPid();
  if (pid) probes.push({ name: "controller-environ", op: "read", path: `/proc/${pid}/environ` });
  else skipped.push("controller-environ (controller not found)");
  const nodes = (existsSync("/dev") ? readdirSync("/dev") : [])
    .filter((d) => d.startsWith("nvidia") && !statSync(join("/dev", d)).isDirectory())
    .map((d) => join("/dev", d));
  // A dedicated development card is probed as the broker set it up; a failed setup fails here.
  const card = opts.dedicated ? readLayout(opts.socketPath) : {};
  const cards = card.layout ? cardsOf(card.layout) : undefined;
  const devices = cards
    ? `dedicated: judge ${cards.judges.map((c) => c.node).join(", ")}, development ${cards.devs.map((c) => c.node).join(", ")}`
    : card.error
      ? `dedicated, NOT SET UP: ${card.error}`
      : "shared";

  const client = new BrokerClient(opts.socketPath);
  const roles =
    opts.roles ??
    ([
      "builder",
      "run",
      // Each further judge card's timing user.
      ...(cards?.judges.slice(1).map((_, i) => runRole(i + 1)) ?? []),
      "lane-1",
      "lane-1-dev",
      "agent-1",
    ] as Role[]);
  // A lane's development run is the lane's user with the device group: probed as itself too,
  // once on each development card.
  const subjects = roles.flatMap((role) =>
    role === "lane-1"
      ? [
          { key: role, role, gpu: false, card: 0 },
          ...(cards?.devs ?? [undefined]).map((_, k) => ({
            key: k ? `lane-1+gpu@${k + 1}` : "lane-1+gpu",
            role,
            gpu: true,
            card: k,
          })),
        ]
      : [{ key: role as string, role, gpu: false, card: judgeCardOf(role) ?? 0 }],
  );
  const report: IsolationReport = { ok: card.error === undefined, devices, roles: {}, skipped };
  try {
    for (const { key, role, gpu, card: n } of subjects) {
      const cwd = join(opts.scratchDir, "thermite", `selftest-${key}`);
      mkdirSync(cwd, { recursive: true });
      await client.handOver(cwd, role);
      const mine = [...probes, ...deviceProbes(nodes, deviceSide(role, gpu), card.layout, n)];
      if (judgeCardOf(role) !== undefined)
        mine.push({ name: "run-kit-read", op: "readable", path: driver });
      const r = await client.run({
        role,
        argv: [process.execPath, "-e", PROBE, JSON.stringify(mine)],
        cwd,
        timeoutMs: 30_000,
        ...(gpu ? { gpu: true, ...(n ? { devCard: n } : {}) } : {}),
      });
      await client.remove(cwd);
      let results: Record<string, string>;
      try {
        results = JSON.parse(r.stdout) as Record<string, string>;
      } catch {
        results = { probe: `failed: exit ${r.exitCode} ${r.stderr.slice(-200)}` };
      }
      report.roles[key] = results;
      if (
        Object.values(results).some(
          (v) =>
            v === "ALLOWED" ||
            v.startsWith("UNREADABLE") ||
            v.startsWith("UNREACHABLE") ||
            v.startsWith("WRONG GPUS") ||
            v.startsWith("failed"),
        )
      ) {
        report.ok = false;
      }
    }
  } finally {
    client.close();
    removeOwnTree(runKit);
  }
  return report;
}

/** A selftest's outcome in a sentence: what passed, or which probes a role got through. */
export function isolationSummary(report: IsolationReport): string {
  const bad = Object.entries(report.roles).flatMap(([role, results]) =>
    Object.entries(results)
      .filter(
        ([, v]) =>
          v === "ALLOWED" ||
          v.startsWith("UNREADABLE") ||
          v.startsWith("UNREACHABLE") ||
          v.startsWith("WRONG GPUS") ||
          v.startsWith("failed"),
      )
      .map(([probe, v]) => `${role} ${probe}: ${v}`),
  );
  const roles = Object.keys(report.roles).length;
  if (report.ok)
    return `isolation holds: every probe of ${roles} roles came out as it must (devices: ${report.devices})`;
  return `isolation does NOT hold (devices: ${report.devices}): ${bad.slice(0, 12).join("; ") || "the device setup failed"}`;
}

/**
 * Removes a tree the controller made read-only (a run's kit copy): its directories are opened
 * again first, since only root may remove entries from a directory without write permission.
 */
function removeOwnTree(path: string): void {
  if (!existsSync(path)) return;
  walk(path, (p, isDir) => {
    if (isDir) chmodSync(p, 0o755);
  });
  rmSync(path, { recursive: true, force: true });
}
