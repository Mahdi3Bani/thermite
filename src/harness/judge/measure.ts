import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runSupervised } from "../broker/process.ts";
import type { Runner, RunOutcome } from "../broker/runner.ts";
import { expandArgv, type Kit, paramsText } from "../kit.ts";
import type { BuildManifest, BuildStore } from "./builds.ts";

/**
 * One timed run of one arm on one cell. The run user executes the arm's verified build with
 * the cell's parameters; the judge measures the wall time around the process and runs the
 * kit's check on the outputs. The score is computed here from the judge's own clock.
 */

export interface Arm {
  name: "champion" | "candidate" | "retained" | "twin";
  dir: string;
  manifest: BuildManifest;
}

export interface CheckResult {
  pass: boolean;
  reasons: string[];
  details: Record<string, unknown>;
}

export type ArmRun =
  | {
      kind: "ok";
      wallMs: number;
      metrics: Record<string, number>;
      check: CheckResult;
      outcome: RunOutcome;
    }
  /** The candidate process failed: crash, non-zero exit, or killed for a limit. */
  | { kind: "crash"; reason: string; outcome: RunOutcome }
  /** The run completed but its outputs failed the kit's check. */
  | { kind: "invalid"; reason: string; check: CheckResult; outcome: RunOutcome };

export interface MeasureContext {
  runner: Runner;
  store: BuildStore;
  kit: Kit;
  kitDir: string;
  runsDir: string;
}

/**
 * The outputs a check may read: regular files and directories only, each file with one link,
 * within depth and count caps. A symlink or hard link could point the judge's check at kit
 * references or other private files.
 */
export function outputProblems(dir: string, maxEntries = 10_000, maxDepth = 32): string[] {
  const problems: string[] = [];
  let entries = 0;
  const stack: [string, number][] = [[dir, 0]];
  while (stack.length && problems.length < 5) {
    const [p, depth] = stack.pop() as [string, number];
    const st = lstatSync(p);
    if (++entries > maxEntries) return [`more than ${maxEntries} output entries`];
    if (st.isDirectory()) {
      if (depth >= maxDepth) problems.push(`output tree deeper than ${maxDepth}`);
      else for (const e of readdirSync(p)) stack.push([join(p, e), depth + 1]);
    } else if (!st.isFile()) {
      problems.push(`not a regular file: ${p.slice(dir.length + 1)}`);
    } else if (st.nlink > 1) {
      problems.push(`hard link: ${p.slice(dir.length + 1)}`);
    }
  }
  return problems;
}

export async function runArm(ctx: MeasureContext, arm: Arm, cell: string): Promise<ArmRun> {
  const params = ctx.kit.cells[cell];
  if (!params) throw new Error(`kit ${ctx.kit.name} has no cell ${cell}`);
  // The build must be exactly what was verified at build time.
  const tampered = ctx.store.verify(arm.dir, arm.manifest);
  if (tampered.length) throw new Error(`build store tampered: ${arm.manifest.key} ${tampered}`);

  // <run>/ (0711, unguessable name) holds the judge's own copy of the parameters (0600), which
  // the check uses; <run>/work/ is handed to the run user with a copy of them and its out/.
  const dir = join(ctx.runsDir, randomUUID());
  const work = join(dir, "work");
  const out = join(work, "out");
  mkdirSync(out, { recursive: true });
  chmodSync(dir, 0o711);
  const text = paramsText(params);
  const json = `${JSON.stringify(params)}\n`;
  writeFileSync(join(dir, "params.txt"), text, { mode: 0o600 });
  writeFileSync(join(dir, "params.json"), json, { mode: 0o600 });
  writeFileSync(join(work, "params.txt"), text, { mode: 0o600 });
  writeFileSync(join(work, "params.json"), json, { mode: 0o600 });
  try {
    await ctx.runner.handOver(work, "run");
    const outcome = await ctx.runner.run({
      role: "run",
      argv: expandArgv(ctx.kit.run.command, {
        build: arm.dir,
        params: join(work, "params.txt"),
        params_json: join(work, "params.json"),
        out,
        kit: "/nonexistent",
      }),
      cwd: work,
      env: {},
      timeoutMs: ctx.kit.run.timeout_s * 1000,
      rssLimitBytes: ctx.kit.run.rss_mib * 1024 * 1024,
      disk: { path: work, limitBytes: ctx.kit.run.disk_mib * 1024 * 1024 },
    });
    await ctx.runner.reclaim(work);
    if (outcome.killedFor) {
      return { kind: "crash", reason: `killed: ${outcome.killedFor}`, outcome };
    }
    if (outcome.exitCode !== 0) {
      return {
        kind: "crash",
        reason: `exit ${outcome.exitCode ?? outcome.signal}: ${outcome.stderr.slice(-400)}`,
        outcome,
      };
    }
    const problems = existsSync(out) ? outputProblems(out) : ["no output directory"];
    if (problems.length) {
      const check = { pass: false, reasons: problems, details: {} };
      return { kind: "invalid", reason: `outputs refused: ${problems.join("; ")}`, check, outcome };
    }

    const check = await runCheck(ctx, {
      build: arm.dir,
      params: join(dir, "params.txt"),
      params_json: join(dir, "params.json"),
      out,
      kit: ctx.kitDir,
    });
    if (!check.pass) {
      return {
        kind: "invalid",
        reason: check.reasons.join("; ") || "check failed",
        check,
        outcome,
      };
    }
    const seconds = outcome.wallMs / 1000;
    const metrics: Record<string, number> = {};
    for (const [name, m] of Object.entries(ctx.kit.metrics)) {
      const amount = Number(params[m.work]);
      if (!Number.isFinite(amount) || amount <= 0 || !(seconds > 0)) {
        throw new Error(`kit metric ${name}: bad work ${params[m.work]} or time ${seconds}`);
      }
      metrics[name] = amount / seconds;
    }
    return { kind: "ok", wallMs: outcome.wallMs, metrics, check, outcome };
  } finally {
    await ctx.runner.remove(dir).catch(() => rmSync(dir, { recursive: true, force: true }));
  }
}

async function runCheck(ctx: MeasureContext, vars: Record<string, string>): Promise<CheckResult> {
  const r = await runSupervised({
    argv: expandArgv(ctx.kit.check.command, vars),
    cwd: ctx.kitDir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: ctx.kit.check.timeout_s * 1000,
  });
  const last = r.stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(last) as { pass?: unknown; reasons?: unknown };
    const { pass, reasons, ...details } = parsed;
    return {
      pass: pass === true,
      reasons: Array.isArray(reasons) ? reasons.map(String) : [],
      details,
    };
  } catch {
    return {
      pass: false,
      reasons: [`check produced no result (exit ${r.exitCode}): ${r.stderr.slice(-300)}`],
      details: {},
    };
  }
}
