import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKeys, signEnvelope } from "../core/commands.ts";
import { parseContract } from "../core/contract.ts";
import { LocalRunner } from "../harness/broker/runner.ts";
import { Judge, type PromotionPolicy } from "../harness/judge/judge.ts";
import { Ledger } from "../harness/ledger.ts";
import { HarnessService } from "../harness/service.ts";
import { CpuDriver } from "../harness/targets/cpu.ts";

/**
 * A throwaway harness with a small Node-based project and kit, for judge tests that run on any
 * machine (no C toolchain, no root). The seed kernel does pointless extra work, so a candidate
 * that removes it is clearly faster.
 */

const SEED_KERNEL = `// The kernel: sum of i % 7 over [0, n). The seed does pointless extra work.
export function work(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    let waste = 0;
    for (let k = 0; k < 40; k++) waste = (waste + ((i + k) & 3)) | 0;
    if (waste === -1) s += 1;
    s += i % 7;
  }
  return s;
}
`;

export const FAST_KERNEL = `export function work(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

export const WRONG_KERNEL = `export function work(n) {
  return n * 3;
}
`;

export const CRASH_KERNEL = `export function work() {
  process.exit(3);
}
`;

const RUN = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { work } from "./work.mjs";
const [params, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(params, "utf8"));
writeFileSync(join(out, "result.json"), JSON.stringify({ value: work(p.n) }));
`;

const CHECK = `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [params, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(params, "utf8"));
let expected = 0;
for (let i = 0; i < p.n; i++) expected += i % 7;
const f = join(out, "result.json");
const got = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).value : null;
const reasons = got === expected ? [] : ["wrong result " + got + ", expected " + expected];
process.stdout.write(JSON.stringify({ pass: reasons.length === 0, reasons, value: got }) + "\\n");
`;

const KIT = {
  schema_version: 1,
  name: "js-sum",
  target: "cpu",
  build: {
    copy: ["bench"],
    command: ["sh", "-c", "mkdir -p out && cp src/kernel/work.mjs .kit/bench/run.mjs out/"],
    outputs: ["out/work.mjs", "out/run.mjs"],
    timeout_s: 30,
  },
  cells: {
    small: { n: 20000000, work: 20000000 },
    held: { n: 15000000, work: 15000000 },
    big: { n: 100000000, work: 100000000 },
  },
  run: {
    command: ["node", "{build:out/run.mjs}", "{params_json}", "{out}"],
    timeout_s: 30,
    rss_mib: 512,
  },
  metrics: { ops_per_s: { unit: "op/s", work: "work" } },
  verifiers: { correctness: { cells: ["small"] } },
  check: { command: ["node", "{kit:check.mjs}", "{params_json}", "{out}"], timeout_s: 30 },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

function repo(dir: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "init");
  return git(dir, "rev-parse", "HEAD");
}

export function makeJudgeEnv(
  opts: {
    promotion?: PromotionPolicy;
    heldOut?: boolean;
    neverReady?: boolean;
    lanes?: { count: number; trials_per_epoch: number };
    /** A goal-mode campaign instead of a hill climb. */
    goal?: { opsPerSecond: number } | undefined;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "thermite-judge-"));
  const paths = {
    stateDir: join(root, "state"),
    scratchDir: join(root, "scratch"),
    inboxDir: join(root, "inbox"),
    outboxDir: join(root, "outbox"),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
  mkdirSync(join(paths.inboxDir, "repos"), { recursive: true });

  const project = join(root, "project");
  const seed = repo(project, { "src/kernel/work.mjs": SEED_KERNEL, "README.md": "test\n" });
  git(project, "bundle", "create", "--quiet", join(paths.inboxDir, "repos", "p.bundle"), "--all");
  const kitRepo = join(root, "kit");
  const kitCommit = repo(kitRepo, {
    "kit.json": JSON.stringify(KIT, null, 2),
    "bench/run.mjs": RUN,
    "check.mjs": CHECK,
  });
  git(kitRepo, "bundle", "create", "--quiet", join(paths.inboxDir, "repos", "k.bundle"), "--all");

  const keys = generateSigningKeys();
  const ledger = Ledger.open(join(paths.stateDir, "ledger", "ledger.db"));
  const service = new HarnessService({
    unit: "unit-a",
    ledger,
    paths,
    controlPublicKeyPem: keys.publicKeyPem,
    unitKeys: generateSigningKeys(),
  });
  const goalContract = opts.goal
    ? {
        schema_version: 1,
        campaign: "js-goal",
        version: 1,
        title: "Reach the sum goals",
        mode: "goal",
        project: { repo: "proj", commit: seed, kit: { repo: "js-kit", commit: kitCommit } },
        target: { type: "cpu", class: "test" },
        goals: [
          {
            id: "fast",
            description: "fast enough",
            verify: {
              type: "metric_threshold",
              metric: "ops_per_s",
              op: ">=",
              value: opts.goal.opsPerSecond,
              cells: ["big"],
            },
          },
          {
            id: "correct",
            description: "still correct",
            verify: { type: "code", verifier: "correctness" },
          },
          {
            id: "readable",
            description: "readable code",
            required: false,
            verify: { type: "review", criteria: ["clear"] },
          },
        ],
        deliverable: "a commit meeting every required goal",
        editable_paths: ["src/kernel/**"],
      }
    : undefined;
  const parsed = parseContract(
    goalContract ?? {
      schema_version: 1,
      campaign: "js-sum",
      version: 1,
      title: "Speed up the sum",
      mode: "hill_climb",
      project: { repo: "proj", commit: seed, kit: { repo: "js-kit", commit: kitCommit } },
      target: { type: "cpu", class: "test" },
      objective: { primary: { metric: "ops_per_s", direction: "max", min_effect: 0.05 } },
      cells: ["small"],
      held_out_cells: opts.heldOut ? ["held"] : [],
      editable_paths: ["src/kernel/**"],
      acceptance: { looks: [3, 6], confirm_blocks: 4 },
      ...(opts.lanes ? { lanes: opts.lanes } : {}),
    },
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const assign = signEnvelope(
    {
      v: 1,
      id: randomUUID(),
      unit: "unit-a",
      kind: "assign_campaign",
      issued_by: "owner",
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: {
        instance: "js-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        seed: { repo: "proj", commit: seed },
        imports: [
          { kind: "repo_bundle", path: "repos/p.bundle", repo: "proj", commit: seed },
          { kind: "kit_bundle", path: "repos/k.bundle", repo: "js-kit", commit: kitCommit },
        ],
      },
    },
    keys.privateKeyPem,
  );

  const judge = new Judge({
    service,
    runner: new LocalRunner(paths.scratchDir),
    // Host load is not what these tests are about (the judge refuses a loaded CPU; see cpu.test).
    driver: opts.neverReady
      ? new CpuDriver("test", { load: () => Number.POSITIVE_INFINITY })
      : new CpuDriver("test", { maxLoadFraction: Number.POSITIVE_INFINITY }),
    owner: "judge-test",
    promotion: opts.promotion ?? "auto",
    readyRetries: 0,
    calibrationBlocks: 0,
  });

  const patch = (kernel: string): string => {
    const wt = join(root, `wt-${randomUUID().slice(0, 8)}`);
    execFileSync("git", ["clone", "--quiet", project, wt]);
    writeFileSync(join(wt, "src", "kernel", "work.mjs"), kernel);
    execFileSync("git", ["add", "-A"], { cwd: wt });
    return execFileSync("git", ["diff", "--cached", "--binary"], { cwd: wt }).toString("base64");
  };

  /** Runs the judge until no job is left. */
  const drain = async (max = 50) => {
    for (let i = 0; i < max; i++) if (!(await judge.tick())) return;
    throw new Error("judge did not drain");
  };

  return { root, paths, service, ledger, judge, assign, patch, drain, seed, kitCommit, keys };
}
