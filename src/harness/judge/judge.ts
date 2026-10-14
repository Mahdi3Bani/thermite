import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../common/env.ts";
import type { HillClimbContract } from "../../core/contract.ts";
import { meanInterval, toFraction, toLog } from "../../core/stats.ts";
import type { Runner } from "../broker/runner.ts";
import { exportTree } from "../git.ts";
import { type Kit, loadKit } from "../kit.ts";
import type { JobRow, Ledger } from "../ledger.ts";
import type { HarnessService } from "../service.ts";
import { readThrottle, throttledFraction } from "../targets/cgroup.ts";
import type { TargetDriver } from "../targets/driver.ts";
import { BuildStore } from "./builds.ts";
import { type Block, type Decision, decideConfirm, decideScreen } from "./decide.ts";
import { type Arm, type ArmRun, type MeasureContext, runArm } from "./measure.ts";

/**
 * The judge: the only code that measures, decides verdicts and moves champions. It leases
 * jobs from the ledger with fences, so a judge that lost its lease can no longer write.
 *
 * evaluate:  build both arms, gate the candidate (correctness and dispatch on every cell),
 *            then screen in interleaved blocks with randomized arm order, deciding at the
 *            contract's looks.
 * confirm:   fresh blocks decided on their own data, plus held-out cells (pass or fail only,
 *            seen by promotion alone), then promotion by compare-and-swap if policy allows.
 * calibrate: A/A blocks (champion against itself) to measure the unit's noise.
 */

export type PromotionPolicy = "auto" | "owner_approval";

export interface JudgeOptions {
  service: HarnessService;
  runner: Runner;
  driver: TargetDriver;
  owner: string;
  /** D8 is an owner decision; until it is made, promotions wait for approval by default. */
  promotion: PromotionPolicy;
  leaseMs?: number | undefined;
  /** Readiness retries before a block is abandoned as an infrastructure failure. */
  readyRetries?: number | undefined;
  readyDelayMs?: number | undefined;
  calibrationBlocks?: number | undefined;
  calibrationEveryMs?: number | undefined;
}

class InfraError extends Error {}

/** A job's outcome, written by finish() in one fenced transaction. */
interface Finish {
  result: unknown;
  verdict?: Parameters<Ledger["recordVerdict"]>[0] | undefined;
  promote?:
    | { instance: string; expectedSeq: number; attempt: string; commitSha: string }
    | undefined;
  events?: { kind: string; subject: string; body: unknown }[] | undefined;
  enqueue?: Parameters<Ledger["enqueueJob"]>[0] | undefined;
  lifecycle?: string | undefined;
}

/**
 * A block is discarded and re-run when the harness was CPU-throttled for more than this fraction
 * of the block, or of any single run in it, or when the target reports a problem afterwards.
 */
const MAX_THROTTLED = 0.02;
const MAX_RUN_THROTTLED = 0.02;
const MAX_BLOCK_TRIES = 3;

/** A verdict reached before the screen finished (a crash, an invalid output, a bad build). */
class Stop extends Error {
  readonly verdict: "invalid" | "crash_candidate";
  readonly reason: string;

  constructor(verdict: "invalid" | "crash_candidate", reason: string) {
    super(reason);
    this.verdict = verdict;
    this.reason = reason;
  }
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (x: number) => `${(toFraction(x) * 100).toFixed(2)}%`;

export class Judge {
  private readonly o: Required<JudgeOptions>;
  private readonly ledger: Ledger;
  private readonly store: BuildStore;

  constructor(opts: JudgeOptions) {
    this.o = {
      leaseMs: 15 * 60_000,
      readyRetries: 15,
      readyDelayMs: 2000,
      calibrationBlocks: 6,
      calibrationEveryMs: 24 * 3_600_000,
      ...opts,
    } as Required<JudgeOptions>;
    this.ledger = opts.service.ledger;
    const { stateDir, scratchDir } = opts.service.paths;
    this.store = new BuildStore(stateDir, scratchDir, opts.runner, this.ledger);
  }

  /** One scheduling step. Returns true when a job was processed. */
  async tick(): Promise<boolean> {
    this.ledger.expireLeases(this.o.owner);
    this.maybeScheduleCalibration();
    const job = this.ledger.leaseJob(this.o.owner, this.o.leaseMs, [
      "evaluate",
      "confirm",
      "calibrate",
    ]);
    if (!job) return false;
    let fin: Finish;
    try {
      fin =
        job.kind === "evaluate"
          ? await this.evaluate(job)
          : job.kind === "confirm"
            ? await this.confirm(job)
            : await this.calibrate(job);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log("judge", "job failed", { job: job.id, kind: job.kind, error: reason });
      this.infraFailure(job, reason);
      return true;
    }
    try {
      const promoted = this.finish(job, fin);
      if (promoted) await this.o.service.syncChampionRef(promoted);
    } catch (err) {
      // Lost the lease (another holder owns the outcome now) or the ledger refused the write.
      log("judge", "could not record the outcome", { job: job.id, error: String(err) });
    }
    return true;
  }

  /**
   * Writes a job's outcome in one transaction under its lease: the verdict, a promotion, events,
   * the follow-up job, the attempt's lifecycle and the job's completion. Either all of it is
   * recorded or none, so a crash cannot leave a verdict without its follow-up (or twice).
   * Returns the instance whose champion moved, if one did.
   */
  private finish(job: JobRow, fin: Finish): string | undefined {
    let movedInstance: string | undefined;
    this.ledger.tx(() => {
      this.ledger.assertLease(job.id, job.fence);
      const result = { ...(fin.result as object) } as Record<string, unknown>;
      let lifecycle = fin.lifecycle;
      let enqueue = fin.enqueue;
      if (fin.verdict) this.ledger.recordVerdict(fin.verdict);
      for (const e of fin.events ?? [])
        this.ledger.appendEvent(this.o.owner, e.kind, e.subject, e.body);
      if (fin.promote) {
        const r = this.ledger.promote({ ...fin.promote, by: this.o.owner });
        if (r.ok) {
          lifecycle = "promoted";
          movedInstance = fin.promote.instance;
          result.promoted = { seq: r.seq };
        } else {
          // Lost the compare-and-swap: screen again against the new champion.
          lifecycle = "queued";
          enqueue = { attempt: fin.promote.attempt, kind: "evaluate", actor: this.o.owner };
          result.lost_race_to_seq = r.currentSeq;
        }
      }
      if (enqueue) this.ledger.enqueueJob(enqueue);
      if (lifecycle && job.attempt)
        this.ledger.setAttemptLifecycle(job.attempt, lifecycle, this.o.owner);
      this.ledger.completeJob(job.id, job.fence, "done", result);
    });
    return movedInstance;
  }

  // ------------------------------------------------------------------ shared steps

  private spec(job: JobRow): Record<string, unknown> {
    return JSON.parse(job.spec) as Record<string, unknown>;
  }

  /** Infrastructure failures never count against the research: crash_infra, then one retry. */
  private infraFailure(job: JobRow, reason: string): void {
    try {
      this.ledger.tx(() => {
        this.ledger.completeJob(job.id, job.fence, "failed", { error: reason.slice(0, 2000) });
        if (!job.attempt) return;
        const retries = Number(this.spec(job).retries ?? 0);
        this.ledger.recordVerdict({
          attempt: job.attempt,
          verdict: "crash_infra",
          dependsOnJobs: [job.id],
          reasons: reason.slice(0, 2000),
          judgedBy: this.o.owner,
        });
        if (retries < 1) {
          this.ledger.enqueueJob({
            attempt: job.attempt,
            kind: job.kind,
            spec: { ...this.spec(job), retries: retries + 1 },
            actor: this.o.owner,
          });
          this.ledger.setAttemptLifecycle(job.attempt, "queued", this.o.owner);
        } else {
          this.ledger.setAttemptLifecycle(job.attempt, "errored", this.o.owner);
        }
      });
    } catch {
      // the lease is gone: whoever holds it now owns the outcome
    }
  }

  private async kitFor(
    contract: HillClimbContract,
  ): Promise<{ kit: Kit; dir: string; commit: string }> {
    const ref = contract.project.kit;
    if (!ref) throw new InfraError(`contract ${contract.campaign} names no kit`);
    const dir = join(this.o.service.paths.stateDir, "kits", ref.commit);
    if (!existsSync(join(dir, "kit.json"))) {
      const tmp = `${dir}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      await exportTree(this.o.service.mirrorFor(`kit-${ref.repo}`), ref.commit, tmp);
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
    }
    const kit = loadKit(dir);
    if (kit.target !== this.o.driver.type) {
      throw new InfraError(
        `kit ${kit.name} measures ${kit.target}, this unit has ${this.o.driver.type}`,
      );
    }
    return { kit, dir, commit: ref.commit };
  }

  private async build(
    instance: string,
    commit: string,
    k: { kit: Kit; dir: string; commit: string },
  ) {
    const inst = this.ledger.getInstance(instance);
    if (!inst) throw new InfraError(`no instance ${instance}`);
    return this.store.ensure({
      repo: inst.seed_repo,
      mirror: this.o.service.mirrorFor(inst.seed_repo),
      commit,
      kit: k.kit,
      kitDir: k.dir,
      kitCommit: k.commit,
      actor: this.o.owner,
    });
  }

  private async armFor(
    name: Arm["name"],
    instance: string,
    commit: string,
    k: { kit: Kit; dir: string; commit: string },
  ): Promise<Arm> {
    const b = await this.build(instance, commit, k);
    if (!b.ok) {
      if (name !== "candidate") throw new InfraError(`${name} build failed: ${b.reason}`);
      // A build killed for time or memory is the candidate's crash (not cached: it may have been
      // load); a build that fails or produces refused outputs is invalid.
      throw new Stop(
        b.transient ? "crash_candidate" : "invalid",
        `build: ${b.reason}\n${b.log.slice(-1500)}`,
      );
    }
    return { name, dir: b.dir, manifest: b.manifest };
  }

  private context(k: { kit: Kit; dir: string }, job: JobRow): MeasureContext {
    const runsDir = join(this.o.service.paths.scratchDir, "runs", `job-${job.id}`);
    mkdirSync(runsDir, { recursive: true });
    // Reachable by exact (unguessable) path only: no role may list in-flight runs.
    chmodSync(join(this.o.service.paths.scratchDir, "runs"), 0o711);
    chmodSync(runsDir, 0o711);
    return { runner: this.o.runner, store: this.store, kit: k.kit, kitDir: k.dir, runsDir };
  }

  private async ready(): Promise<Record<string, unknown>> {
    for (let i = 0; ; i++) {
      const r = await this.o.driver.readyForTiming();
      if (r.ready) return r.details;
      if (i >= this.o.readyRetries) {
        throw new InfraError(`target not ready for timing: ${r.reasons.join("; ")}`);
      }
      await new Promise((res) => setTimeout(res, this.o.readyDelayMs));
    }
  }

  /** A candidate's failed run stops the job with its verdict; any other arm's is infra. */
  private judgeRun(arm: Arm, r: ArmRun): void {
    if (r.kind === "ok") {
      const implausible = this.o.driver.plausibility(r.metrics);
      if (implausible.length === 0) return;
      if (arm.name === "candidate")
        throw new Stop("invalid", `implausible: ${implausible.join("; ")}`);
      throw new InfraError(`${arm.name} implausible: ${implausible.join("; ")}`);
    }
    if (arm.name !== "candidate") throw new InfraError(`${arm.name} run failed: ${r.reason}`);
    throw new Stop(r.kind === "crash" ? "crash_candidate" : "invalid", r.reason);
  }

  /**
   * Runs `count` interleaved blocks over `cells` and records every value as a measurement.
   * Each block re-checks the target's readiness and renews the lease.
   */
  private async blocks(input: {
    job: JobRow;
    ctx: MeasureContext;
    arms: [Arm, Arm];
    cells: readonly string[];
    count: number;
    startAt?: number;
    runsPerCell?: number;
    onBlock?: (blocks: Block[]) => boolean;
  }): Promise<Block[]> {
    const { job, ctx, arms, cells } = input;
    const [a, b] = arms;
    const target = await this.o.driver.identify();
    const out: Block[] = [];
    for (let i = 0; i < input.count; i++) {
      const n = (input.startAt ?? 0) + i + 1;
      for (let attempt = 1; ; attempt++) {
        const done = await this.block({
          job,
          ctx,
          a,
          b,
          cells,
          n,
          attempt,
          target,
          runsPerCell: input.runsPerCell ?? 1,
        });
        if (done) {
          out.push(done);
          break;
        }
        if (attempt >= MAX_BLOCK_TRIES) {
          throw new InfraError(
            `block ${n} throttled on ${attempt} tries: the CPU quota is too tight`,
          );
        }
      }
      if (input.onBlock?.(out)) break;
    }
    return out;
  }

  /**
   * One block: every cell, both arms in random order. Its values are recorded only if the
   * harness was not CPU-throttled for more than MAX_THROTTLED of the block; otherwise the block
   * is discarded (its receipt says why) and run again.
   */
  private async block(x: {
    job: JobRow;
    ctx: MeasureContext;
    a: Arm;
    b: Arm;
    cells: readonly string[];
    n: number;
    attempt: number;
    target: unknown;
    runsPerCell: number;
  }): Promise<Block | undefined> {
    const { job, ctx, a, b, n } = x;
    this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
    const readiness = await this.ready();
    const block: Block = { candidate: {}, reference: {} };
    const values: { arm: string; metric: string; cell: string; value: number }[] = [];
    const runs: unknown[] = [];
    const order = rng(job.id * 7919 + n * 31 + x.attempt);
    let worstRunThrottle = 0;
    const throttleBefore = readThrottle();
    const started = Date.now();
    // Raw values per arm, metric and cell; the block takes their median (runs_per_cell).
    const raw: Record<string, Record<string, Record<string, number[]>>> = {};
    for (const cell of x.cells) {
      for (let k = 0; k < x.runsPerCell; k++) {
        const pair = order() < 0.5 ? [a, b] : [b, a];
        for (const arm of pair) {
          const t0 = readThrottle();
          const r = await runArm(ctx, arm, cell);
          const runThrottle = throttledFraction(t0, readThrottle(), r.outcome.wallMs) ?? 0;
          worstRunThrottle = Math.max(worstRunThrottle, runThrottle);
          runs.push({
            arm: arm.name,
            cell,
            run: k + 1,
            kind: r.kind,
            wall_ms: r.outcome.wallMs,
            peak_rss: r.outcome.peakRssBytes,
            cpu_throttled_fraction: runThrottle,
            // Processes left running after the benchmark exited (killed) and files it left in
            // shared places (removed): flagged, never silently ignored.
            leftovers: r.outcome.leftovers,
            swept: r.outcome.swept.length,
            ...(r.kind === "ok" ? { check: r.check.details } : { reason: r.reason }),
          });
          this.judgeRun(arm, r);
          if (r.kind !== "ok") continue;
          for (const [metric, value] of Object.entries(r.metrics)) {
            const byMetric = raw[arm.name] ?? {};
            const byCell = byMetric[metric] ?? {};
            byCell[cell] = [...(byCell[cell] ?? []), value];
            byMetric[metric] = byCell;
            raw[arm.name] = byMetric;
          }
        }
      }
    }
    const median = (xs: number[]) => {
      const v = [...xs].sort((p, q) => p - q);
      const m = Math.floor(v.length / 2);
      return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
    };
    for (const arm of [a, b]) {
      const side = arm === a ? "candidate" : "reference";
      for (const [metric, byCell] of Object.entries(raw[arm.name] ?? {})) {
        for (const [cell, xs] of Object.entries(byCell)) {
          const value = median(xs);
          values.push({ arm: arm.name, metric, cell, value });
          block[side][metric] ??= {};
          (block[side][metric] as Record<string, number>)[cell] = value;
        }
      }
    }
    const throttled = throttledFraction(throttleBefore, readThrottle(), Date.now() - started);
    const afterBlock = await this.o.driver.afterBlock();
    const accepted =
      worstRunThrottle <= MAX_RUN_THROTTLED &&
      (throttled === undefined || throttled <= MAX_THROTTLED) &&
      afterBlock.length === 0;
    this.ledger.recordReceipt(job.id, job.fence, {
      job: job.id,
      attempt: job.attempt,
      block: n,
      try: x.attempt,
      accepted,
      separated: this.o.runner.separated,
      cpu_throttled_fraction: throttled ?? null,
      worst_run_throttled_fraction: worstRunThrottle,
      after_block: afterBlock,
      target: x.target,
      readiness,
      env: await this.o.driver.envSnapshot(),
      builds: { a: a.manifest.key, b: b.manifest.key },
      runs,
    });
    if (!accepted) return undefined;
    for (const v of values) {
      this.ledger.recordMeasurement(job.id, job.fence, {
        ...v,
        rep: n,
        unit: ctx.kit.metrics[v.metric]?.unit ?? "",
      });
    }
    return block;
  }

  private verdictFields(d: Decision<string>) {
    return {
      delta: toFraction(d.primary.estimate),
      ciLow: toFraction(d.primary.low),
      ciHigh: toFraction(d.primary.high),
      guards: d.guards.map((g) => ({
        metric: g.metric,
        status: g.status,
        estimate: g.interval.estimate,
        low: g.interval.low,
        high: g.interval.high,
      })),
    };
  }

  private hillClimb(instance: string): HillClimbContract {
    const c = this.o.service.contractFor(instance);
    if (c.mode !== "hill_climb") {
      throw new InfraError(`the judge handles hill_climb attempts; ${instance} is ${c.mode}`);
    }
    return c;
  }

  // ------------------------------------------------------------------ evaluate

  private stopped(job: JobRow, err: Stop): Finish {
    return {
      result: { verdict: err.verdict },
      verdict: {
        attempt: job.attempt as string,
        verdict: err.verdict,
        dependsOnJobs: [job.id],
        reasons: err.reason.slice(0, 4000),
        judgedBy: this.o.owner,
      },
      lifecycle: "judged",
    };
  }

  private async evaluate(job: JobRow): Promise<Finish> {
    const attemptId = job.attempt as string;
    const attempt = this.ledger.getAttempt(attemptId);
    if (!attempt) throw new InfraError(`no attempt ${attemptId}`);
    const instance = String(attempt.instance);
    const contract = this.hillClimb(instance);
    const champion = this.ledger.currentChampion(instance);
    const step = (l: string) => {
      this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
      this.ledger.setAttemptLifecycle(attemptId, l, this.o.owner);
    };

    try {
      const k = await this.kitFor(contract);
      step("building");
      const champ = await this.armFor("champion", instance, champion.commit_sha, k);
      const cand = await this.armFor("candidate", instance, String(attempt.commit_sha), k);
      const ctx = this.context(k, job);

      step("gating");
      for (const cell of contract.cells) {
        this.judgeRun(cand, await runArm(ctx, cand, cell));
        this.judgeRun(champ, await runArm(ctx, champ, cell));
      }

      step("screening");
      let decision: Decision<string> | undefined;
      const looks = contract.acceptance.looks;
      await this.blocks({
        job,
        ctx,
        arms: [cand, champ],
        cells: contract.cells,
        count: Math.max(...looks),
        runsPerCell: contract.acceptance.runs_per_cell,
        onBlock: (bs) => {
          if (!looks.includes(bs.length)) return false;
          decision = decideScreen(contract, bs);
          return decision.verdict !== undefined;
        },
      });
      const d = decision as Decision<string>;
      const verdict = d.verdict ?? "inconclusive";
      const win = verdict === "win_screened";
      return {
        result: { verdict, delta: toFraction(d.primary.estimate), baseline_seq: champion.seq },
        verdict: {
          attempt: attemptId,
          verdict,
          ...this.verdictFields(d),
          dependsOnJobs: [job.id],
          reasons: `${d.reasons}; vs champion seq ${champion.seq}`,
          judgedBy: this.o.owner,
        },
        ...(win
          ? {
              enqueue: {
                attempt: attemptId,
                kind: "confirm",
                priority: 50,
                spec: { baseline_seq: champion.seq, screen_job: job.id },
                actor: this.o.owner,
              },
            }
          : {}),
        lifecycle: win ? "confirming" : "judged",
      };
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      return this.stopped(job, err);
    }
  }

  // ------------------------------------------------------------------ confirm and promote

  /** Sum of guard effects (log ratios) of the promoted steps since the seed. */
  private guardTotals(instance: string): Record<string, number> {
    const totals: Record<string, number> = {};
    const rows = this.ledger.db
      .prepare(
        "select attempt from champion where instance = ? and reopened = 0 and attempt is not null",
      )
      .all(instance) as { attempt: string }[];
    for (const r of rows) {
      const v = this.ledger.db
        .prepare(
          "select guards from verdict where attempt = ? and verdict = 'win_confirmed' order by id desc limit 1",
        )
        .get(r.attempt) as { guards: string } | undefined;
      for (const g of JSON.parse(v?.guards ?? "[]") as { metric: string; estimate: number }[]) {
        totals[g.metric] = (totals[g.metric] ?? 0) + g.estimate;
      }
    }
    return totals;
  }

  private async confirm(job: JobRow): Promise<Finish> {
    const attemptId = job.attempt as string;
    const attempt = this.ledger.getAttempt(attemptId);
    if (!attempt) throw new InfraError(`no attempt ${attemptId}`);
    const instance = String(attempt.instance);
    const contract = this.hillClimb(instance);
    const baselineSeq = Number(this.spec(job).baseline_seq);
    const champion = this.ledger.currentChampion(instance);
    if (champion.seq !== baselineSeq) {
      // The champion moved since screening: screen again against the new one.
      return {
        result: { rescreen: true, baseline_seq: baselineSeq, champion_seq: champion.seq },
        enqueue: { attempt: attemptId, kind: "evaluate", actor: this.o.owner },
        lifecycle: "queued",
      };
    }

    try {
      const k = await this.kitFor(contract);
      this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
      const champ = await this.armFor("champion", instance, champion.commit_sha, k);
      const cand = await this.armFor("candidate", instance, String(attempt.commit_sha), k);
      const ctx = this.context(k, job);
      const blocks = await this.blocks({
        job,
        ctx,
        arms: [cand, champ],
        cells: contract.cells,
        count: contract.acceptance.confirm_blocks,
        runsPerCell: contract.acceptance.runs_per_cell,
      });
      const heldOutPass = await this.heldOut(job, ctx, cand, champ, contract);
      let d = decideConfirm(contract, blocks, this.guardTotals(instance));
      let verdict: string = d.verdict ?? "not_confirmed";
      let reasons = d.reasons;
      if (verdict === "win_confirmed" && heldOutPass === false) {
        verdict = "not_confirmed";
        reasons = "confirmation failed"; // held-out detail stays with promotion code
        d = { ...d, reasons };
      }
      const fin: Finish = {
        result: { verdict },
        verdict: {
          attempt: attemptId,
          verdict,
          ...this.verdictFields(d),
          dependsOnJobs: [job.id, Number(this.spec(job).screen_job ?? job.id)],
          reasons: `${reasons}; vs champion seq ${champion.seq}`,
          judgedBy: this.o.owner,
        },
        lifecycle: "judged",
      };
      if (verdict !== "win_confirmed") return fin;
      return this.promotion(fin, attemptId, instance, champion.seq, attempt);
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      return this.stopped(job, err);
    }
  }

  /**
   * Held-out cells: correctness on every one, and no regression beyond twice the equivalence
   * band on the primary metric, judged on the median of three interleaved runs per arm.
   * Recorded only in the held_out table, never as measurements, events or verdict reasons.
   */
  private async heldOut(
    job: JobRow,
    ctx: MeasureContext,
    cand: Arm,
    champ: Arm,
    contract: HillClimbContract,
  ): Promise<boolean | undefined> {
    if (!contract.held_out_cells.length) return undefined;
    const { metric, direction } = contract.objective.primary;
    const detail: Record<string, unknown> = {};
    let pass = true;
    const median = (xs: number[]) =>
      [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] as number;
    for (const cell of contract.held_out_cells) {
      this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
      const cv: number[] = [];
      const rv: number[] = [];
      let failed: string | undefined;
      for (let rep = 0; rep < 3 && !failed; rep++) {
        const c = await runArm(ctx, cand, cell);
        const r = await runArm(ctx, champ, cell);
        if (r.kind !== "ok") {
          // An opaque reason: details of held-out cells never leave promotion code.
          log("judge", "champion failed on a held-out cell", { job: job.id, reason: r.reason });
          throw new InfraError("champion failed on a held-out cell");
        }
        if (c.kind !== "ok") failed = c.kind;
        else {
          cv.push(c.metrics[metric] as number);
          rv.push(r.metrics[metric] as number);
        }
      }
      if (failed) {
        pass = false;
        detail[cell] = { failed };
        continue;
      }
      const ratio = direction === "max" ? median(cv) / median(rv) : median(rv) / median(cv);
      const ok = Math.log(ratio) > -toLog(2 * contract.acceptance.equivalence_band);
      detail[cell] = { ratio, ok };
      if (!ok) pass = false;
    }
    this.ledger.recordHeldOut(job.id, job.fence, job.attempt as string, pass, detail);
    return pass;
  }

  /** What happens to a confirmed win: audit first if flawed, then the promotion policy (D8). */
  private promotion(
    fin: Finish,
    attemptId: string,
    instance: string,
    expectedSeq: number,
    attempt: Record<string, unknown>,
  ): Finish {
    if ((JSON.parse(String(attempt.known_flaws)) as unknown[]).length > 0) {
      return {
        ...fin,
        result: { ...(fin.result as object), promoted: false, waiting: "audit" },
        events: [
          {
            kind: "promotion_blocked",
            subject: attemptId,
            body: { reason: "open known flaws: an audit must clear them" },
          },
        ],
        lifecycle: "awaiting_audit",
      };
    }
    if (this.o.promotion === "owner_approval") {
      return {
        ...fin,
        result: { ...(fin.result as object), promoted: false, waiting: "owner_approval" },
        events: [
          {
            kind: "promotion_pending",
            subject: attemptId,
            body: { instance, expected_seq: expectedSeq, commit: attempt.commit_sha },
          },
        ],
        lifecycle: "awaiting_approval",
      };
    }
    return {
      ...fin,
      promote: {
        instance,
        expectedSeq,
        attempt: attemptId,
        commitSha: String(attempt.commit_sha),
      },
    };
  }

  // ------------------------------------------------------------------ A/A calibration

  private maybeScheduleCalibration(): void {
    if (this.o.calibrationBlocks < 2) return;
    for (const inst of this.ledger.listInstances()) {
      if (inst.status !== "running" || inst.mode !== "hill_climb") continue;
      const last = this.ledger.db
        .prepare(
          `select created_at from job where kind = 'calibrate' and json_extract(spec, '$.instance') = ?
             order by id desc limit 1`,
        )
        .get(inst.id) as { created_at: string } | undefined;
      if (last && Date.now() - Date.parse(last.created_at) < this.o.calibrationEveryMs) continue;
      this.ledger.enqueueJob({
        kind: "calibrate",
        priority: 200,
        spec: { instance: inst.id },
        actor: this.o.owner,
      });
    }
  }

  private async calibrate(job: JobRow): Promise<Finish> {
    const instance = String(this.spec(job).instance);
    const contract = this.hillClimb(instance);
    const champion = this.ledger.currentChampion(instance);
    const k = await this.kitFor(contract);
    const champ = await this.armFor("champion", instance, champion.commit_sha, k);
    const ctx = this.context(k, job);
    const twin: Arm = { ...champ, name: "twin" };
    const blocks = await this.blocks({
      job,
      ctx,
      arms: [twin, champ],
      cells: contract.cells,
      count: this.o.calibrationBlocks,
      runsPerCell: contract.acceptance.runs_per_cell,
    });
    const { metric, direction } = contract.objective.primary;
    const effects = blocks.map((b) => {
      const logs = contract.cells.map((cell) => {
        const x = b.candidate[metric]?.[cell] as number;
        const y = b.reference[metric]?.[cell] as number;
        return direction === "max" ? Math.log(x / y) : Math.log(y / x);
      });
      return logs.reduce((s, v) => s + v, 0) / logs.length;
    });
    const i = meanInterval(effects, contract.acceptance.alpha_screen);
    const sd = Math.sqrt(
      effects.reduce((s, e) => s + (e - i.estimate) ** 2, 0) / (effects.length - 1),
    );
    const result = {
      instance,
      champion_seq: champion.seq,
      blocks: effects.length,
      sigma: sd,
      mean: i.estimate,
      ci: [i.low, i.high],
      summary: `A/A ${pct(i.estimate)} [${pct(i.low)}, ${pct(i.high)}], block sigma ${(sd * 100).toFixed(3)}%`,
    };
    return { result, events: [{ kind: "calibration", subject: instance, body: result }] };
  }
}
