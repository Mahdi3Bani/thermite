import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { runSupervised } from "../broker/process.ts";
import { type Role, type Runner, type RunOutcome, walk } from "../broker/runner.ts";
import { cellParams, cellTimeoutS, expandArgv, type Kit, paramsText } from "../kit.ts";
import type { BuildManifest, BuildStore } from "./builds.ts";
import { clipReason } from "./reasons.ts";

/**
 * One timed run of one arm on one cell. The run user executes the arm's verified build with
 * the cell's parameters; the judge measures the wall time around the process and runs the
 * kit's check on the outputs. The score is computed here from the judge's own clock.
 */

export interface Arm {
  /** baseline: a hill climb's starting point, measured on its own (goal 115). */
  name: "champion" | "candidate" | "retained" | "twin" | "baseline";
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
  | { kind: "crash"; failure: CrashFailure; reason: string; outcome: RunOutcome }
  /** The run completed but its outputs failed the kit's check. */
  | {
      kind: "invalid";
      failure: InvalidFailure;
      reason: string;
      check: CheckResult;
      outcome: RunOutcome;
    };

/**
 * How a run failed, as the judge saw it, apart from its reason's text: a held-out cell's record
 * names only this (goal 082). A crash: stopped for time, memory or disk, or it exited with an
 * error. Invalid: its outputs were refused, the kit's check failed, or a metric the check reports
 * was not a number above zero.
 */
export type CrashFailure = "timeout" | "memory" | "disk" | "exit";
export type InvalidFailure = "outputs" | "check" | "metric";

export interface MeasureContext {
  runner: Runner;
  store: BuildStore;
  kit: Kit;
  kitDir: string;
  runsDir: string;
  /** The imported models (`<sha256>` files, read-only): `{models:<sha256>}` in run and check. */
  modelsDir: string;
  /** Tells the live view how a run went (never a measurement; held-out cells are not named). */
  note?: ((arm: string, cell: string, outcome: string) => void) | undefined;
  /** The user that times runs on this executor's judge card: run, or run-1 to run-7. */
  runRole?: Role | undefined;
  /**
   * A hill climb's baseline folder (goal 115): the kit's check gets it as THERMITE_BASELINE_DIR,
   * writable during the baseline job and read-only (sealed) in every later job of the run. The
   * kit's run command never gets it, and the folder is the judge's, mode 0700.
   */
  baselineDir?: string | undefined;
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

/**
 * Copies the kit's `run.copy` paths into `dest` for one run: regular files and directories
 * only, owned by the judge and read-only, so the run user can read them but not change them.
 * A link is refused, because it could reach the kit's references.
 */
export function copyForRun(kitDir: string, paths: readonly string[], dest: string): void {
  const copy = (from: string, to: string, rel: string) => {
    const st = lstatSync(from);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from)) copy(join(from, e), join(to, e), `${rel}/${e}`);
    } else if (st.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, st.mode & 0o111 ? 0o555 : 0o444);
    } else {
      throw new Error(`kit run.copy: not a regular file or directory: ${rel}`);
    }
  };
  mkdirSync(dest, { recursive: true });
  for (const rel of paths) {
    const from = join(kitDir, rel);
    if (!existsSync(from)) throw new Error(`kit run.copy: ${rel} is not in the kit`);
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    copy(from, join(dest, rel), rel);
  }
  walk(dest, (p, isDir) => {
    if (isDir) chmodSync(p, 0o555);
  });
}

export async function runArm(ctx: MeasureContext, arm: Arm, cell: string): Promise<ArmRun> {
  const r = await runArmInner(ctx, arm, cell);
  ctx.note?.(arm.name, cell, r.kind === "ok" ? "ok" : `${r.kind}: ${r.reason}`);
  return r;
}

async function runArmInner(ctx: MeasureContext, arm: Arm, cell: string): Promise<ArmRun> {
  const params = cellParams(ctx.kit, cell);
  if (!params) throw new Error(`kit ${ctx.kit.name} has no cell ${cell}`);
  // The build must be exactly what was verified at build time.
  const tampered = ctx.store.verify(arm.dir, arm.manifest);
  if (tampered.length) throw new Error(`build store tampered: ${arm.manifest.key} ${tampered}`);

  // <run>/ (0711, unguessable name) holds the judge's own copy of the parameters (0600), which
  // the check uses; <run>/work/ is handed to the run user with a copy of them and its out/;
  // <run>/kit/ is the run's read-only copy of the kit's run.copy paths, which stays the judge's.
  const dir = join(ctx.runsDir, randomUUID());
  const work = join(dir, "work");
  const out = join(work, "out");
  const kit = join(dir, "kit");
  mkdirSync(out, { recursive: true });
  chmodSync(dir, 0o711);
  const text = paramsText(params);
  const json = `${JSON.stringify(params)}\n`;
  writeFileSync(join(dir, "params.txt"), text, { mode: 0o600 });
  writeFileSync(join(dir, "params.json"), json, { mode: 0o600 });
  writeFileSync(join(work, "params.txt"), text, { mode: 0o600 });
  writeFileSync(join(work, "params.json"), json, { mode: 0o600 });
  try {
    if (ctx.kit.run.copy.length) copyForRun(ctx.kitDir, ctx.kit.run.copy, kit);
    await ctx.runner.handOver(work, ctx.runRole ?? "run");
    const outcome = await ctx.runner.run({
      role: ctx.runRole ?? "run",
      argv: expandArgv(ctx.kit.run.command, {
        build: arm.dir,
        params: join(work, "params.txt"),
        params_json: join(work, "params.json"),
        out,
        kit: ctx.kit.run.copy.length ? kit : "/nonexistent",
        models: ctx.modelsDir,
      }),
      cwd: work,
      env: {},
      // The cell's own limit when it sets one, else the kit's.
      timeoutMs: cellTimeoutS(ctx.kit, cell) * 1000,
      rssLimitBytes: ctx.kit.run.rss_mib * 1024 * 1024,
      disk: { path: work, limitBytes: ctx.kit.run.disk_mib * 1024 * 1024 },
    });
    await ctx.runner.reclaim(work);
    if (outcome.killedFor) {
      return {
        kind: "crash",
        failure: outcome.killedFor,
        reason: `killed: ${outcome.killedFor}`,
        outcome,
      };
    }
    if (outcome.exitCode !== 0) {
      return {
        kind: "crash",
        failure: "exit",
        reason: clipReason(`exit ${outcome.exitCode ?? outcome.signal}: ${outcome.stderr}`),
        outcome,
      };
    }
    const problems = existsSync(out) ? outputProblems(out) : ["no output directory"];
    if (problems.length) {
      const check = { pass: false, reasons: problems, details: {} };
      return {
        kind: "invalid",
        failure: "outputs",
        reason: clipReason(`outputs refused: ${problems.join("; ")}`),
        check,
        outcome,
      };
    }

    const check = await runCheck(ctx, {
      build: arm.dir,
      params: join(dir, "params.txt"),
      params_json: join(dir, "params.json"),
      out,
      kit: ctx.kitDir,
      models: ctx.modelsDir,
    });
    if (!check.pass) {
      return {
        kind: "invalid",
        failure: "check",
        reason: clipReason(check.reasons.join("; ")) || "check failed",
        check,
        outcome,
      };
    }
    const seconds = outcome.wallMs / 1000;
    const metrics: Record<string, number> = {};
    for (const [name, m] of Object.entries(ctx.kit.metrics)) {
      if ("from" in m && m.from === "check") {
        // The judge's check worked it out from the outputs; it must be a number above zero.
        const v = Number(check.details[m.field]);
        if (!Number.isFinite(v) || v <= 0) {
          return {
            kind: "invalid",
            failure: "metric",
            reason: `the check reported no ${m.field} above zero (got ${JSON.stringify(check.details[m.field] ?? null)})`,
            check,
            outcome,
          };
        }
        metrics[name] = v;
        continue;
      }
      if (!(seconds > 0)) throw new Error(`kit metric ${name}: bad time ${seconds}`);
      if ("from" in m) {
        metrics[name] = seconds;
        continue;
      }
      const amount = Number(params[m.work]);
      if (!Number.isFinite(amount) || amount <= 0) {
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
  const r = await (ctx.runner.check ?? runSupervised)({
    argv: expandArgv(ctx.kit.check.command, vars),
    cwd: ctx.kitDir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(ctx.baselineDir ? { THERMITE_BASELINE_DIR: ctx.baselineDir } : {}),
    },
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
      reasons: [clipReason(`check produced no result (exit ${r.exitCode}): ${r.stderr}`)],
      details: {},
    };
  }
}
