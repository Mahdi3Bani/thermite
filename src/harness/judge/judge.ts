import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";
import { log, logError, logWarn } from "../../common/log.ts";
import type { Contract, GoalContract, HillClimbContract } from "../../core/contract.ts";
import type { EventToRecord } from "../../core/events/bodies.ts";
import { meanInterval, toFraction, toLog } from "../../core/stats.ts";
import { Audits, auditTrigger } from "../audits.ts";
import { builderRole, runRole } from "../broker/devices.ts";
import type { Runner } from "../broker/runner.ts";
import { Conclusions } from "../conclusions.ts";
import { patchBetween } from "../git.ts";
import { type Kit, loadKit } from "../kit.ts";
import type { JobRow, Ledger } from "../ledger.ts";
import { Reviews } from "../reviews.ts";
import type { HarnessService } from "../service.ts";
import { readThrottle, throttledFraction } from "../targets/cgroup.ts";
import type { TargetDriver } from "../targets/driver.ts";
import {
  BASELINE_BLOCKS,
  BASELINE_PRIORITY,
  type Baseline,
  type BaselineFailure,
  baselineDir,
  baselineDue,
  baselineOf,
  baselineState,
  baselineValue,
  guardTotals,
  prepareBaselineDir,
  removeBaselineDir,
  sealBaselineDir,
} from "./baseline.ts";
import { BuildStore } from "./builds.ts";
import {
  type Block,
  type Decision,
  decideConfirm,
  decideScreen,
  decideThresholdGoal,
  type GoalStatus,
  goalDelta,
  type StartValues,
} from "./decide.ts";
import { leaseLost, recordInfraFailure } from "./failure.ts";
import { GOAL_VALUES_CELLS, type GoalCellValues, runValues, valuesText } from "./goal-values.ts";
import {
  HELD_OUT_INFRA,
  type HeldOutCell,
  type HeldOutKind,
  type HeldOutResult,
  heldOutEvent,
  heldOutKindOf,
  heldOutKinds,
  heldOutMeasure,
  heldOutResult,
  heldOutWords,
  meetsThreshold,
} from "./held-out.ts";
import { exportKit } from "./kits.ts";
import { whileLeased } from "./lease.ts";
import { type Arm, type ArmRun, type MeasureContext, runArm } from "./measure.ts";
import { olderChampion, type PortFound, parentScreened, queuePort } from "./ports.ts";
import { clipReason, REASONS_CHARS } from "./reasons.ts";
import { rng } from "./rng.ts";

/**
 * The judge: the only code that measures, decides verdicts and moves champions. It leases
 * jobs from the ledger with fences, so a judge that lost its lease can no longer write.
 *
 * evaluate:  build both arms, gate the candidate (correctness and dispatch on every cell),
 *            then screen in interleaved blocks with randomized arm order, deciding at the
 *            contract's looks.
 * confirm:   fresh blocks decided on their own data, plus held-out cells (pass or fail only,
 *            seen by promotion alone), then promotion by compare-and-swap if policy allows.
 * baseline:  a hill climb's first job (goal 115): the starting point alone, in blocks on every
 *            measured cell, its values recorded as the run's baseline. No other job of the run
 *            is leased until it exists. When the starting point can't be measured the run is in
 *            setup, and each setup change submitted is judged by a baseline job too: the first
 *            that measures becomes the starting point.
 * calibrate: A/A blocks (champion against itself) to measure the rig's noise.
 * validate:  a goal campaign's champion on every goal; when every required goal is met, a second
 *            validation, which also runs the held-out cells of the goals met, before the run
 *            closes (goal 086).
 */

export type PromotionPolicy = "auto" | "owner_approval";

/** One goal's check on one build: its status, its reasons and, for a code goal, its values. */
interface GoalResult {
  goal: string;
  required: boolean;
  status: GoalStatus;
  reasons: string;
  /** A code verifier's goal: each public cell's values (goal 086); never a held-out cell's. */
  values?: GoalCellValues[];
}

export interface JudgeOptions {
  service: HarnessService;
  runner: Runner;
  driver: TargetDriver;
  owner: string;
  /** The rig's promotion policy: confirmed wins promote on their own, or wait for the owner. */
  promotion: PromotionPolicy;
  leaseMs?: number | undefined;
  /** Readiness retries before a block is abandoned as an infrastructure failure. */
  readyRetries?: number | undefined;
  readyDelayMs?: number | undefined;
  calibrationBlocks?: number | undefined;
  calibrationEveryMs?: number | undefined;
  /** A hill climb's baseline: its blocks (BASELINE_BLOCKS), at least two. */
  baselineBlocks?: number | undefined;
  /** An agent's development run holds the device: the judge waits for it to end. */
  deviceGate?: { active: boolean } | undefined;
  /**
   * This executor's judge card on a rig with several: its place among the judge cards, its id,
   * and how many there are. Each card is calibrated on its own, a confirmation goes to another
   * card than its screen's, and runs are timed by the card's own user.
   */
  card?: { index: number; uuid: string; count: number } | undefined;
}

class InfraError extends Error {}
/** An infrastructure failure in the judge's own fixed words, safe for the agents to read. */
class FixedInfraError extends InfraError {}

/** A job's outcome, written by finish() in one fenced transaction. */
interface Finish {
  result: unknown;
  verdict?: Parameters<Ledger["recordVerdict"]>[0] | undefined;
  promote?:
    | {
        run: string;
        expectedSeq: number;
        attempt: string;
        commitSha: string;
        /**
         * Declared flaws accepted by this step (goal 079: hands-off by default): who accepts
         * them, as the record says. Set only when nothing asks the owner.
         */
        clearFlaws?: string | undefined;
      }
    | undefined;
  events?: EventToRecord[] | undefined;
  /** A port to queue once the job is recorded (goal 135). */
  port?: PortFound | undefined;
  enqueue?: Parameters<Ledger["enqueueJob"]>[0] | undefined;
  lifecycle?: string | undefined;
  /** Close a run (a goal campaign whose success rule holds). */
  close?: { run: string; reason: string } | undefined;
  /**
   * A setup change the baseline job measured (goal 115): it becomes the run's starting point by
   * compare-and-swap on the champion the job read, and then, in the same transaction, its
   * verdict and its `baseline` event (with the new champion's number) are recorded.
   */
  start?:
    | {
        run: string;
        expectedSeq: number;
        attempt: string;
        commitSha: string;
        baseline: Omit<Baseline, "champion_seq">;
      }
    | undefined;
  /** Hold the attempt for an audit (written in the same transaction). */
  audit?:
    | {
        run: string;
        trigger: "absolute" | "ratio" | "known_flaws" | "adversarial_checklist";
        reason: string;
        expectedSeq: number;
      }
    | undefined;
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

const pct = (x: number) => `${(toFraction(x) * 100).toFixed(2)}%`;

export class Judge {
  private readonly o: Required<JudgeOptions>;
  private readonly ledger: Ledger;
  private readonly store: BuildStore;
  /** The job this judge holds: its lease is renewed while a build runs (lease.ts). */
  private holding: JobRow | undefined;

  constructor(opts: JudgeOptions) {
    this.o = {
      leaseMs: 15 * 60_000,
      readyRetries: 15,
      readyDelayMs: 2000,
      calibrationBlocks: 6,
      calibrationEveryMs: 24 * 3_600_000,
      deviceGate: undefined,
      baselineBlocks: BASELINE_BLOCKS,
      card: undefined,
      ...opts,
    } as Required<JudgeOptions>;
    this.ledger = opts.service.ledger;
    const { stateDir, scratchDir } = opts.service.paths;
    this.store = new BuildStore(stateDir, scratchDir, opts.runner, this.ledger);
  }

  /**
   * Takes back the jobs whose lease ran out: queued again, or blocked after their third lost lease.
   * It starts no work, so the harness does it while draining too (goal 079).
   */
  expireLeases(): number[] {
    return this.ledger.expireLeases(this.o.owner);
  }

  /** One scheduling step. Returns true when a job was processed. */
  async tick(): Promise<boolean> {
    if (this.o.deviceGate?.active) return false;
    this.expireLeases();
    const waiting = this.maybeScheduleBaseline();
    this.maybeScheduleCalibration(waiting);
    this.maybeScheduleValidation();
    const job = this.ledger.leaseJob(
      this.o.owner,
      this.o.leaseMs,
      ["baseline", "evaluate", "parent_screen", "confirm", "calibrate", "validate"],
      this.cards > 1 ? this.o.card?.uuid : undefined,
      waiting,
    );
    if (!job) return false;
    this.holding = job;
    const subject = job.attempt ?? this.jobRun(job) ?? "";
    this.note(`${job.kind} ${subject}: started`, this.jobRun(job));
    let fin: Finish;
    try {
      fin =
        job.kind === "baseline"
          ? await this.baseline(job)
          : job.kind === "evaluate" || job.kind === "parent_screen"
            ? await this.evaluate(job)
            : job.kind === "confirm"
              ? await this.confirm(job)
              : job.kind === "validate"
                ? await this.validate(job)
                : await this.calibrate(job);
    } catch (err) {
      const reason = errorText(err);
      logError("judge", "job failed", { job: job.id, kind: job.kind, error: reason });
      this.note(`${job.kind} ${subject}: failed (${clipReason(reason)})`, this.jobRun(job));
      this.infraFailure(job, reason);
      return true;
    }
    this.note(
      `${job.kind} ${subject}: ${fin.verdict ? `${fin.verdict.verdict}${typeof fin.verdict.delta === "number" ? ` ${(fin.verdict.delta * 100).toFixed(2)}%` : ""}` : (fin.lifecycle ?? "done")}`,
      this.jobRun(job),
    );
    let promoted: string | undefined;
    try {
      promoted = this.finish(job, fin);
    } catch (err) {
      // Lost the lease (another holder owns the outcome now) or the ledger refused the write.
      const why = leaseLost(err) ? "its lease was lost: its new holder records it" : String(err);
      logWarn("judge", "could not record the outcome", { job: job.id, error: why });
      return true;
    }
    // The outcome is recorded: what follows from it is logged as its own step (goal 163).
    if (promoted)
      await this.o.service.syncChampionRef(promoted).catch((err: unknown) => {
        log("judge", "the champion's ref was not synced", { run: promoted, error: String(err) });
      });
    if (fin.port)
      await queuePort(this.o.service, fin.port).catch((err: unknown) => {
        log("judge", "the port was not queued", { job: job.id, error: String(err) });
      });
    return true;
  }

  /**
   * Writes a job's outcome in one transaction under its lease: the verdict, a promotion, events,
   * the follow-up job, the attempt's lifecycle and the job's completion. Either all of it is
   * recorded or none, so a crash cannot leave a verdict without its follow-up (or twice).
   * Returns the run whose champion moved, if one did.
   */
  private finish(job: JobRow, fin: Finish): string | undefined {
    let movedRun: string | undefined;
    this.ledger.tx(() => {
      this.ledger.assertLease(job.id, job.fence);
      const result = { ...(fin.result as object) } as Record<string, unknown>;
      let lifecycle = fin.lifecycle;
      let enqueue = fin.enqueue;
      if (fin.verdict) this.ledger.recordVerdict(fin.verdict);
      for (const e of fin.events ?? [])
        this.ledger.appendEvent(this.o.owner, e.kind, e.subject, e.body);
      if (fin.promote) {
        const { clearFlaws, ...promote } = fin.promote;
        // Declared flaws nothing asks the owner about are accepted by this promotion (goal 079),
        // and only if it happens: in its own transaction.
        const r = this.ledger.promote({ ...promote, by: this.o.owner, acceptFlaws: clearFlaws });
        if (r.ok) {
          lifecycle = "promoted";
          movedRun = fin.promote.run;
          result.promoted = { seq: r.seq };
        } else {
          // Lost the compare-and-swap: screen again against the new champion.
          lifecycle = "queued";
          enqueue = { attempt: fin.promote.attempt, kind: "evaluate", actor: this.o.owner };
          result.lost_race_to_seq = r.currentSeq;
        }
      }
      if (fin.start) {
        const { baseline, ...start } = fin.start;
        const r = this.ledger.setStartingPoint({ ...start, by: this.o.owner });
        if (r.ok) {
          this.ledger.recordVerdict({
            attempt: start.attempt,
            verdict: "starting_point",
            dependsOnJobs: [job.id],
            reasons: `the judge measured this setup change on every cell: it is the run's starting point, champion #${r.seq}, and its values are the run's baseline; ${baseline.summary}`,
            judgedBy: this.o.owner,
          });
          this.ledger.appendEvent(this.o.owner, "baseline", start.run, {
            ...baseline,
            champion_seq: r.seq,
          });
          lifecycle = "promoted";
          movedRun = start.run;
          result.start = { seq: r.seq };
        } else {
          // The champion moved while it was measured: judged as a change against it instead.
          lifecycle = "queued";
          enqueue = { attempt: start.attempt, kind: "evaluate", actor: this.o.owner };
          result.lost_race_to_seq = r.currentSeq;
        }
      }
      if (enqueue) this.ledger.enqueueJob(enqueue);
      if (fin.audit && job.attempt) {
        new Audits(this.ledger).request({
          ...fin.audit,
          attempt: job.attempt,
          job: job.id,
          by: this.o.owner,
        });
      }
      // A run the owner closed while this job ran keeps the owner's reason (goal 087).
      if (fin.close && this.ledger.getRun(fin.close.run)?.status !== "closed")
        this.ledger.setRunStatus(fin.close.run, "closed", fin.close.reason, this.o.owner);
      if (lifecycle && job.attempt)
        this.ledger.setAttemptLifecycle(job.attempt, lifecycle, this.o.owner);
      this.ledger.completeJob(job.id, job.fence, "done", result);
    });
    return movedRun;
  }

  // ------------------------------------------------------------------ shared steps

  /** A line for control's live view of the judge. */
  private note(text: string, run?: string | undefined): void {
    this.o.service.live.append({ source: "judge", kind: "log", text, run });
  }

  /** The run a job works for. */
  private jobRun(job: JobRow): string | undefined {
    if (job.attempt) {
      const i = this.ledger.getAttempt(job.attempt)?.run;
      return i === undefined || i === null ? undefined : String(i);
    }
    const i = (JSON.parse(job.spec) as { run?: unknown }).run;
    return typeof i === "string" ? i : undefined;
  }

  private spec(job: JobRow): Record<string, unknown> {
    return JSON.parse(job.spec) as Record<string, unknown>;
  }

  /** Infrastructure failures never count against the research: crash_infra, then one retry. */
  private infraFailure(job: JobRow, reason: string): void {
    recordInfraFailure(this.ledger, job, reason, { owner: this.o.owner, spec: this.spec(job) });
  }

  private async kitFor(contract: Contract): Promise<{ kit: Kit; dir: string; commit: string }> {
    const ref = contract.project.kit;
    if (!ref) throw new InfraError(`contract ${contract.campaign} names no kit`);
    const mirror = this.o.service.mirrorFor(`kit-${ref.repo}`);
    const dir = await exportKit(this.o.service.paths.stateDir, mirror, ref.commit);
    const kit = loadKit(dir);
    if (kit.target !== this.o.driver.type) {
      throw new InfraError(
        `kit ${kit.name} measures ${kit.target}, this rig has ${this.o.driver.type}`,
      );
    }
    return { kit, dir, commit: ref.commit };
  }

  private async build(run: string, commit: string, k: { kit: Kit; dir: string; commit: string }) {
    const inst = this.ledger.getRun(run);
    if (!inst) throw new InfraError(`no run ${run}`);
    const started = Date.now();
    this.note(`build ${commit.slice(0, 12)}: started`, run);
    const ensure = () =>
      this.store.ensure({
        repo: inst.seed_repo,
        mirror: this.o.service.mirrorFor(inst.seed_repo),
        commit,
        kit: k.kit,
        kitDir: k.dir,
        kitCommit: k.commit,
        actor: this.o.owner,
        role: builderRole(this.o.card?.index ?? 0),
      });
    const h = this.holding;
    const renew = () => h && this.ledger.heartbeat(h.id, h.fence, this.o.leaseMs);
    const b = await whileLeased(renew, this.o.leaseMs / 3, ensure, { job: h?.id, commit });
    this.note(
      `build ${commit.slice(0, 12)}: ${b.ok ? "ok" : `failed (${clipReason(b.reason)})`} in ${Math.round((Date.now() - started) / 1000)} s`,
      run,
    );
    return b;
  }

  private async armFor(
    name: Arm["name"],
    run: string,
    commit: string,
    k: { kit: Kit; dir: string; commit: string },
  ): Promise<Arm> {
    const b = await this.build(run, commit, k);
    if (!b.ok) {
      // The starting point's baseline (goal 115) is judged as a candidate is: a build that fails
      // means it can't be measured yet.
      if (name !== "candidate" && name !== "baseline")
        throw new InfraError(`${name} build failed: ${b.reason}`);
      // A build killed for time or memory may be the host's load (never cached): its first kill is
      // no verdict and the job is tried once more; a second is the candidate's crash (the owner,
      // 2026-10-27, goal 163). A build that fails or produces refused outputs is invalid.
      const again = this.holding !== undefined && Number(this.spec(this.holding).retries ?? 0) >= 1;
      if (b.transient && !again) throw new InfraError(`build: ${b.reason}; tried once more`);
      throw new Stop(
        b.transient ? "crash_candidate" : "invalid",
        `build: ${b.reason}\n${b.log.slice(-1500)}`,
      );
    }
    return { name, dir: b.dir, manifest: b.manifest };
  }

  /**
   * A job's measuring context. A hill climb's check gets the run's baseline folder (goal 115):
   * `baselineDir`, the folder a baseline job writes, or else the sealed folder of the run's
   * baseline, read-only.
   */
  private context(
    k: { kit: Kit; dir: string },
    job: JobRow,
    baselineDirNow?: string | undefined,
  ): MeasureContext {
    const runsDir = join(this.o.service.paths.scratchDir, "runs", `job-${job.id}`);
    mkdirSync(runsDir, { recursive: true });
    // Reachable by exact (unguessable) path only: no role may list in-flight runs.
    chmodSync(join(this.o.service.paths.scratchDir, "runs"), 0o711);
    chmodSync(runsDir, 0o711);
    const run = this.jobRun(job);
    // No contract, no held-out mask: the job stops as an infrastructure failure, never measuring
    // on cells it would have hidden (goal 163).
    const contract: Contract | undefined = run ? this.o.service.contractFor(run) : undefined;
    const held = new Set(contract && "held_out_cells" in contract ? contract.held_out_cells : []);
    let heldRuns = 0;
    const sealed = (() => {
      if (baselineDirNow || !run || contract?.mode !== "hill_climb") return undefined;
      const b = baselineOf(this.ledger, run);
      const dir = b ? baselineDir(this.o.service.paths.stateDir, run, b.job) : undefined;
      return dir && existsSync(dir) ? dir : undefined;
    })();
    const folder = baselineDirNow ?? sealed;
    return {
      runner: this.o.runner,
      store: this.store,
      kit: k.kit,
      kitDir: k.dir,
      runsDir,
      modelsDir: join(this.o.service.paths.stateDir, "models"),
      ...(folder ? { baselineDir: folder } : {}),
      runRole: runRole(this.o.card?.index ?? 0),
      note: (arm, cell, outcome) =>
        held.has(cell)
          ? this.note(`held-out run ${++heldRuns} done`, run)
          : this.note(`${arm} · ${cell}: ${outcome}`, run),
    };
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

  /**
   * A candidate's failed run stops the job with its verdict; any other arm's is infra. The
   * baseline's (goal 115) stops it as a candidate's does: the starting point can't be measured.
   */
  private judgeRun(arm: Arm, r: ArmRun, cell?: string): void {
    const judged = arm.name === "candidate" || arm.name === "baseline";
    // The baseline's reasons name the cell: they tell the workers in setup what to fix.
    const on = arm.name === "baseline" && cell ? `cell ${cell}: ` : "";
    if (r.kind === "ok") {
      const implausible = this.o.driver.plausibility(r.metrics);
      if (implausible.length === 0) return;
      if (judged) throw new Stop("invalid", `${on}implausible: ${implausible.join("; ")}`);
      throw new InfraError(`${arm.name} implausible: ${implausible.join("; ")}`);
    }
    if (!judged) throw new InfraError(`${arm.name} run failed: ${r.reason}`);
    throw new Stop(r.kind === "crash" ? "crash_candidate" : "invalid", `${on}${r.reason}`);
  }

  /**
   * Runs `count` interleaved blocks over `cells` and records every value as a measurement.
   * Each block re-checks the target's readiness and renews the lease. With one arm (a baseline),
   * each block runs that arm alone: its values are the block's `candidate` side.
   */
  private async blocks(input: {
    job: JobRow;
    ctx: MeasureContext;
    arms: [Arm, Arm] | [Arm];
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
    b: Arm | undefined;
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
        const pair = !b ? [a] : order() < 0.5 ? [a, b] : [b, a];
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
          this.judgeRun(arm, r, cell);
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
    for (const arm of b ? [a, b] : [a]) {
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
      builds: { a: a.manifest.key, ...(b ? { b: b.manifest.key } : {}) },
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
      values: d.values,
      guards: d.guards.map((g) => {
        // At confirmation, the guard against the run's baseline too (goal 115): a log ratio.
        const s = d.vsStart?.find((x) => x.metric === g.metric);
        return {
          metric: g.metric,
          status: g.status,
          estimate: g.interval.estimate,
          low: g.interval.low,
          high: g.interval.high,
          ...(s ? { vs_start: { estimate: s.estimate, noise: s.noise, spent: s.spent } } : {}),
        };
      }),
    };
  }

  private hillClimb(run: string): HillClimbContract {
    const c = this.o.service.contractFor(run);
    if (c.mode !== "hill_climb") {
      throw new InfraError(`the judge handles hill_climb attempts; ${run} is ${c.mode}`);
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
        reasons: clipReason(err.reason, REASONS_CHARS),
        judgedBy: this.o.owner,
      },
      lifecycle: "judged",
    };
  }

  private async evaluate(job: JobRow): Promise<Finish> {
    const attemptId = job.attempt as string;
    const attempt = this.ledger.getAttempt(attemptId);
    if (!attempt) throw new InfraError(`no attempt ${attemptId}`);
    const run = String(attempt.run);
    if (this.o.service.contractFor(run).mode === "goal") return this.evaluateGoal(job);
    const contract = this.hillClimb(run);
    const champion = this.ledger.currentChampion(run);
    // A parent screen (goal 135): against the older champion it was written on, with no verdict.
    const parent = String(attempt.parent_commit);
    const onParent = job.kind === "parent_screen";
    const step = (l: string) => {
      this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
      if (!onParent) this.ledger.setAttemptLifecycle(attemptId, l, this.o.owner);
    };

    try {
      const k = await this.kitFor(contract);
      step("building");
      const champ = await this.armFor("champion", run, onParent ? parent : champion.commit_sha, k);
      const cand = await this.armFor("candidate", run, String(attempt.commit_sha), k);
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
          decision = decideScreen(contract, bs, this.noiseFloor(run));
          return decision.verdict !== undefined;
        },
      });
      const d = decision as Decision<string>;
      const verdict = d.verdict ?? "inconclusive";
      const win = verdict === "win_screened";
      const older = olderChampion(this.ledger, run, attemptId, champion.seq);
      if (onParent)
        return parentScreened(run, attemptId, older, verdict, toFraction(d.primary.estimate));
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
                spec: { baseline_seq: champion.seq, screen_job: job.id, ...this.avoidMe() },
                actor: this.o.owner,
              },
            }
          : older !== undefined
            ? {
                enqueue: {
                  attempt: attemptId,
                  kind: "parent_screen",
                  priority: 150,
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

  private async confirm(job: JobRow): Promise<Finish> {
    const attemptId = job.attempt as string;
    const attempt = this.ledger.getAttempt(attemptId);
    if (!attempt) throw new InfraError(`no attempt ${attemptId}`);
    const run = String(attempt.run);
    if (this.o.service.contractFor(run).mode === "goal") return this.confirmGoal(job);
    const contract = this.hillClimb(run);
    const baselineSeq = Number(this.spec(job).baseline_seq);
    const champion = this.ledger.currentChampion(run);
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
      const champ = await this.armFor("champion", run, champion.commit_sha, k);
      const cand = await this.armFor("candidate", run, String(attempt.commit_sha), k);
      const ctx = this.context(k, job);
      const blocks = await this.blocks({
        job,
        ctx,
        arms: [cand, champ],
        cells: contract.cells,
        count: contract.acceptance.confirm_blocks,
        runsPerCell: contract.acceptance.runs_per_cell,
      });
      const ho = await this.heldOutPass(job, () => this.heldOut(job, ctx, cand, champ, contract));
      // The guards' total allowance holds against the starting point's values too (goal 115).
      const start: StartValues | undefined = baselineOf(this.ledger, run)?.cells;
      const d = decideConfirm(
        contract,
        blocks,
        guardTotals(this.ledger, run),
        this.noiseFloor(run),
        start,
      );
      let verdict: string = d.verdict ?? "not_confirmed";
      let reasons = d.reasons;
      // A held-out failure is named by its kind alone (goal 082): the reasons say that a held-out
      // check failed and how, never which cell, its values or its texts. The owner's detail is in
      // the held_out record and its event. The figures are the measured cells' only.
      if (ho && !ho.pass) {
        const words = heldOutWords(heldOutKinds(ho.cells));
        reasons =
          verdict === "win_confirmed"
            ? `confirmation failed: ${words}; on the measured cells: ${d.reasons}`
            : `${d.reasons}; ${words}`;
        if (verdict === "win_confirmed") verdict = "not_confirmed";
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
        ...(ho ? { events: [heldOutEvent(job.id, run, attemptId, ho)] } : {}),
        lifecycle: "judged",
      };
      if (verdict !== "win_confirmed") return fin;
      return this.promotion(fin, attemptId, run, champion.seq, attempt);
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      return this.stopped(job, err);
    }
  }

  /**
   * Runs a held-out pass. Whatever goes wrong in it reaches the verdict's reasons, Live and so the
   * agents in fixed words only (goal 082): an error's text can name a held-out cell or carry its
   * parameters or time. The error itself goes to the rig's log, for the owner.
   */
  private async heldOutPass<T>(job: JobRow, pass: () => Promise<T>): Promise<T> {
    try {
      return await pass();
    } catch (err) {
      if (err instanceof FixedInfraError) throw err;
      logError("judge", "held-out pass failed", {
        job: job.id,
        attempt: job.attempt,
        error: errorText(err),
      });
      throw new InfraError(HELD_OUT_INFRA);
    }
  }

  /**
   * Held-out cells: correctness on every one, and no regression beyond twice the equivalence
   * band on the primary metric, judged on the median of three interleaved runs per arm. Each
   * cell's result is recorded with its kind of failure and, for the regression check, its ratio
   * against its threshold (goal 082): in the held_out table, and in the owner's event. Never a
   * cell's inputs, outputs or texts, and never as measurements.
   */
  private async heldOut(
    job: JobRow,
    ctx: MeasureContext,
    cand: Arm,
    champ: Arm,
    contract: HillClimbContract,
  ): Promise<HeldOutResult | undefined> {
    if (!contract.held_out_cells.length) return undefined;
    const { metric, direction } = contract.objective.primary;
    const cells: HeldOutCell[] = [];
    const median = (xs: number[]) =>
      [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] as number;
    // A ratio to the champion above this passes: no worse than twice the equivalence band.
    const threshold = 1 / (1 + 2 * contract.acceptance.equivalence_band);
    for (const cell of contract.held_out_cells) {
      this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
      const cv: number[] = [];
      const rv: number[] = [];
      let failed: HeldOutKind | undefined;
      for (let rep = 0; rep < 3 && !failed; rep++) {
        const c = await runArm(ctx, cand, cell);
        const r = await runArm(ctx, champ, cell);
        if (r.kind !== "ok") {
          // An opaque reason: details of held-out cells never leave promotion code.
          logWarn("judge", "champion failed on a held-out cell", { job: job.id, reason: r.reason });
          throw new FixedInfraError("champion failed on a held-out cell");
        }
        if (c.kind !== "ok") failed = heldOutKindOf(c);
        else {
          cv.push(c.metrics[metric] as number);
          rv.push(r.metrics[metric] as number);
        }
      }
      if (failed) {
        cells.push({ cell, ok: false, kind: failed });
        continue;
      }
      const ratio = direction === "max" ? median(cv) / median(rv) : median(rv) / median(cv);
      const measured = {
        value: ratio,
        threshold,
        op: ">" as const,
        measure: heldOutMeasure(metric, direction),
        unit: "ratio",
      };
      if (Math.log(ratio) > -toLog(2 * contract.acceptance.equivalence_band))
        cells.push({ cell, ok: true, ...measured });
      else cells.push({ cell, ok: false, kind: "threshold_missed", ...measured });
    }
    const result = heldOutResult(cells);
    this.ledger.recordHeldOut(job.id, job.fence, job.attempt as string, result.pass, result);
    return result;
  }

  /**
   * What happens to a promotable result (goal 079: hands-off by default). An audit first when one
   * is triggered (open known flaws, a gain above the contract's audit trigger, a goal campaign's
   * adversarial checklist) and the rig has an auditor, or may have one (its supervisor has not
   * said yet); without an auditor the audit is skipped, and recorded so. Then the owner only where
   * the run asks (every win, a gain above its line, declared flaws); else the champion.
   */
  private promotion(
    fin: Finish,
    attemptId: string,
    run: string,
    expectedSeq: number,
    attempt: Record<string, unknown>,
  ): Finish {
    // A run the owner closed while this job ran (goal 087): nothing changes its champion now. The
    // win stays recorded and waits, and no one decides it.
    if (String(this.ledger.getRun(run)?.status) === "closed")
      return {
        ...fin,
        result: { ...(fin.result as object), promoted: false, waiting: "run_closed" },
        lifecycle: "awaiting_approval",
      };
    const audits = new Audits(this.ledger);
    const trigger = auditTrigger({
      contract: this.o.service.contractFor(run),
      knownFlaws: JSON.parse(String(attempt.known_flaws)) as unknown[],
      delta: fin.verdict?.delta,
      priorDeltas: audits.priorDeltas(run, attemptId),
    });
    if (trigger && this.o.service.advisors?.auditor !== false) {
      return {
        ...fin,
        result: { ...(fin.result as object), promoted: false, waiting: "audit" },
        events: [
          ...(fin.events ?? []),
          {
            kind: "promotion_blocked",
            subject: attemptId,
            body: { reason: `audit required: ${trigger.reason}` },
          },
        ],
        audit: { run, trigger: trigger.kind, reason: trigger.reason, expectedSeq },
        lifecycle: "awaiting_audit",
      };
    }
    const skipped = trigger
      ? [
          {
            kind: "audit_skipped" as const,
            subject: attemptId,
            body: { run, reason: trigger.reason, why: "this rig has no auditor" },
          },
        ]
      : [];
    const ask = this.o.service.ownerAsks(run, attempt, fin.verdict?.delta ?? null);
    if (ask) {
      return {
        ...fin,
        result: { ...(fin.result as object), promoted: false, waiting: "owner" },
        events: [
          ...(fin.events ?? []),
          ...skipped,
          {
            kind: "promotion_pending",
            subject: attemptId,
            body: { run, expected_seq: expectedSeq, commit: attempt.commit_sha, reason: ask },
          },
        ],
        lifecycle: "awaiting_approval",
      };
    }
    return {
      ...fin,
      ...(skipped.length ? { events: [...(fin.events ?? []), ...skipped] } : {}),
      promote: {
        run,
        expectedSeq,
        attempt: attemptId,
        commitSha: String(attempt.commit_sha),
        clearFlaws: `${this.o.owner} (no audit: ${trigger ? "this rig has no auditor" : "none was called for"})`,
      },
    };
  }

  // ------------------------------------------------------------------ goal mode

  private goalContract(run: string): GoalContract {
    const c = this.o.service.contractFor(run);
    if (c.mode !== "goal") throw new InfraError(`${run} is not a goal campaign`);
    return c;
  }

  /**
   * Checks every goal on one build: metric thresholds from repeated runs (per-cell intervals),
   * code verifiers from the kit's named cell sets, subjective reviews not runnable here (M5).
   */
  private async verifyGoals(
    job: JobRow,
    contract: GoalContract,
    ctx: MeasureContext,
    arm: Arm,
    opts: {
      heldOut?: boolean;
      goals?: string[];
      /** Validating the champion: review goals take the panel and owner's word for this commit. */
      champion?: { run: string; attempt: string | null; commit: string };
      /**
       * In the held-out pass, each held-out cell's result goes here (goal 082): its name, its kind
       * of failure, and a threshold goal's value against its threshold. Never its texts.
       */
      heldOutCells?: HeldOutCell[];
    } = {},
  ): Promise<GoalResult[]> {
    const out: GoalResult[] = [];
    // Held-out cells run only at confirmation: an attempt's, or a champion's second validation
    // (goal 086). Their results go to the judge's decision and, by name and kind alone, to the
    // held_out record: never into measurements, goal checks or reports.
    const held = new Set(contract.held_out_cells);
    const heldCell = (c: HeldOutCell) => {
      if (opts.heldOut) opts.heldOutCells?.push(c);
    };
    const pick = (cells: string[]) =>
      cells.filter((c) => (opts.heldOut ? held.has(c) : !held.has(c)));
    // Priority gates: each code verifier is evaluated once per pass, its gates (`requires`)
    // first. One whose gate did not pass runs none of its cells. A gate with no cells in this
    // pass (all held out, or none held out) does not block.
    type VerifierResult = {
      ok: boolean;
      runnable: boolean;
      reasons: string;
      values?: GoalCellValues[];
    };
    const verified = new Map<string, VerifierResult>();
    const evaluate = async (name: string): Promise<VerifierResult> => {
      const known = verified.get(name);
      if (known) return known;
      const ver = ctx.kit.verifiers[name];
      let result: VerifierResult;
      if (!ver) {
        result = { ok: false, runnable: false, reasons: `the kit has no verifier ${name}` };
      } else {
        const blocked: string[] = [];
        for (const gate of ver.requires) {
          const g = await evaluate(gate);
          if (g.runnable && !g.ok) blocked.push(gate);
        }
        const cells = pick(ver.cells);
        if (blocked.length) {
          result = {
            ok: false,
            runnable: true,
            reasons: `not run: it requires ${blocked.join(", ")}, which did not pass`,
          };
        } else if (!cells.length) {
          result = {
            ok: false,
            runnable: false,
            reasons: opts.heldOut ? "no held-out cells" : "every cell of this verifier is held out",
          };
        } else {
          this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
          const failures: string[] = [];
          // Each public cell's values (goal 086). The held-out pass keeps none: names and kinds
          // only, never a held-out cell's values.
          const values: GoalCellValues[] = [];
          for (const cell of cells) {
            if (!ctx.kit.cells[cell]) {
              failures.push(`no cell ${cell}`);
              heldCell({ cell, verifier: name, ok: false, kind: "no_cell" });
              continue;
            }
            const r = await runArm(ctx, arm, cell);
            if (r.kind !== "ok") failures.push(`${cell}: ${r.kind}: ${clipReason(r.reason)}`);
            if (!opts.heldOut) {
              const metrics = runValues(ctx.kit, r);
              if (Object.keys(metrics).length) values.push({ cell, ok: r.kind === "ok", metrics });
            }
            heldCell(
              r.kind === "ok"
                ? { cell, verifier: name, ok: true }
                : { cell, verifier: name, ok: false, kind: heldOutKindOf(r) },
            );
          }
          // In words as a threshold goal gives its values: "cell: metric value; …".
          const said = values.length ? valuesText(values) : "";
          result = {
            ok: !failures.length,
            runnable: true,
            reasons: failures.length
              ? `${failures.join("; ")}${said ? `; measured: ${said}` : ""}`
              : `verifier ${name} passed on ${cells.join(", ")}${said ? `: ${said}` : ""}`,
            ...(values.length ? { values: values.slice(0, GOAL_VALUES_CELLS) } : {}),
          };
        }
      }
      verified.set(name, result);
      return result;
    };
    // Goals run in their verifiers' priority order (others keep the contract's order) and are
    // reported in the contract's order.
    const rank = (g: GoalContract["goals"][number]) =>
      g.verify.type === "code" ? (ctx.kit.verifiers[g.verify.verifier]?.priority ?? 100) : 100;
    for (const g of [...contract.goals].sort((a, b) => rank(a) - rank(b))) {
      if (opts.goals && !opts.goals.includes(g.id)) continue;
      this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
      const v = g.verify;
      if (v.type === "review") {
        if (!opts.champion || opts.heldOut) {
          out.push({
            goal: g.id,
            required: g.required,
            status: "not_runnable",
            reasons: "subjective goals are reviewed for champions only",
          });
          continue;
        }
        const reviews = new Reviews(this.ledger);
        const { run, attempt, commit } = opts.champion;
        if (!reviews.get(run, g.id, commit)) {
          const inst = this.ledger.getRun(run);
          const diff = inst
            ? await patchBetween(this.o.service.mirrorFor(inst.seed_repo), inst.seed_commit, commit)
            : "";
          reviews.request({
            run,
            goal: g.id,
            attempt,
            commit,
            contract,
            diff,
            by: this.o.owner,
          });
        }
        const r = reviews.status(run, g.id, commit);
        out.push({ goal: g.id, required: g.required, status: r.status, reasons: r.reasons });
        continue;
      }
      if (v.type === "code") {
        const r = await evaluate(v.verifier);
        out.push({
          goal: g.id,
          required: g.required,
          status: !r.runnable ? "not_runnable" : r.ok ? "met" : "unmet",
          reasons: r.reasons,
          ...(r.values ? { values: r.values } : {}),
        });
        continue;
      }
      // metric_threshold: threshold_reps runs per cell; the value is a kit metric or a number the kit's
      // check reports (for example memory headroom measured by the judge's client).
      const cells = pick(v.cells ?? Object.keys(ctx.kit.cells));
      if (!cells.length) {
        out.push({
          goal: g.id,
          required: g.required,
          status: "not_runnable",
          reasons: opts.heldOut ? "no held-out cells" : "every cell of this goal is held out",
        });
        continue;
      }
      const values: Record<string, number[]> = {};
      const failures: string[] = [];
      // The held-out cells that failed before a threshold could be checked, and how.
      const failedHeld = new Set<string>();
      for (const cell of cells) {
        if (!ctx.kit.cells[cell]) {
          failures.push(`no cell ${cell}`);
          heldCell({ cell, goal: g.id, ok: false, kind: "no_cell" });
          failedHeld.add(cell);
          continue;
        }
        for (let rep = 1; rep <= contract.threshold_reps; rep++) {
          const r = await runArm(ctx, arm, cell);
          if (r.kind !== "ok") {
            failures.push(`${cell}: ${r.kind}: ${clipReason(r.reason)}`);
            heldCell({ cell, goal: g.id, ok: false, kind: heldOutKindOf(r) });
            failedHeld.add(cell);
            break;
          }
          const value = r.metrics[v.metric] ?? r.check.details[v.metric];
          if (typeof value !== "number" || !Number.isFinite(value)) {
            failures.push(`${cell}: no ${v.metric}`);
            heldCell({ cell, goal: g.id, ok: false, kind: "non_finite", measure: v.metric });
            failedHeld.add(cell);
            break;
          }
          values[cell] = [...(values[cell] ?? []), value];
          if (opts.heldOut) continue;
          this.ledger.recordMeasurement(job.id, job.fence, {
            arm: arm.name,
            metric: v.metric,
            cell,
            rep,
            value,
            unit: ctx.kit.metrics[v.metric]?.unit ?? "",
          });
        }
      }
      if (failures.length && !Object.keys(values).length) {
        out.push({
          goal: g.id,
          required: g.required,
          status: "not_runnable",
          reasons: failures.join("; "),
        });
        continue;
      }
      // Decided on this pass's cells only: a goal whose cells mix measured and held-out ones is
      // screened on the measured ones and confirmed on the held-out ones (goal 082), never
      // "not runnable" for lack of a value that this pass does not measure.
      const d = decideThresholdGoal(v.cells ? { ...g, verify: { ...v, cells } } : g, values, 0.05);
      // Each held-out cell that ran: its mean and interval against the threshold. It passes only
      // when its whole interval is on the passing side, as the goal's own decision rule says (one
      // value gives no interval, and does not pass).
      for (const cell of cells) {
        const xs = values[cell];
        if (!opts.heldOut || failedHeld.has(cell) || !xs?.length) continue;
        const i = xs.length >= 2 ? meanInterval(xs, 0.05) : undefined;
        const ok =
          !!i && meetsThreshold(i.low, v.op, v.value) && meetsThreshold(i.high, v.op, v.value);
        heldCell({
          cell,
          goal: g.id,
          ok,
          ...(ok ? {} : { kind: "threshold_missed" as const }),
          value: i ? i.estimate : (xs[0] as number),
          ...(i ? { low: i.low, high: i.high } : {}),
          threshold: v.value,
          op: v.op,
          measure: v.metric,
          unit: ctx.kit.metrics[v.metric]?.unit ?? "",
        });
      }
      const status: GoalStatus = failures.length && d.status === "met" ? "unmet" : d.status;
      out.push({
        goal: g.id,
        required: g.required,
        status,
        reasons: failures.length ? `${d.reasons}; ${failures.join("; ")}` : d.reasons,
      });
    }
    // Reported in the contract's order, whatever order they ran in.
    const order = new Map(contract.goals.map((g, i) => [g.id, i]));
    return out.sort((a, b) => (order.get(a.goal) ?? 0) - (order.get(b.goal) ?? 0));
  }

  private recordGoals(
    job: JobRow,
    run: string,
    attempt: string | null,
    commit: string,
    results: { goal: string; status: GoalStatus; reasons: string }[],
    updateStatus: boolean,
  ): void {
    this.ledger.tx(() => {
      this.ledger.assertLease(job.id, job.fence);
      for (const r of results) {
        this.ledger.db
          .prepare(
            "insert into goal_check (run, goal, attempt, job, commit_sha, result, detail, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            run,
            r.goal,
            attempt,
            job.id,
            commit,
            r.status,
            clipReason(r.reasons, REASONS_CHARS),
            new Date().toISOString(),
          );
        if (updateStatus) {
          const status = {
            met: "verified",
            unmet: "unmet",
            inconclusive: "attempted",
            not_runnable: "not_runnable",
          }[r.status];
          this.ledger.db
            .prepare("update goal set status = ? where run = ? and id = ?")
            .run(status, run, r.goal);
        }
      }
    });
  }

  /**
   * A goal campaign's held-out pass on one build (goal 082): the held-out cells of these goals,
   * an attempt's newly met goals at its confirmation or, at the confirming validation, each goal
   * the champion meets (goal 086). Each cell's name and kind go into the result, for the owner's
   * record; `failed` names the goals whose held-out check did not pass. Never a cell's values or
   * texts, and its errors reach the agents in fixed words only (heldOutPass).
   */
  private async heldOutGoals(
    job: JobRow,
    contract: GoalContract,
    ctx: MeasureContext,
    arm: Arm,
    goals: string[],
  ): Promise<HeldOutResult & { failed: string[] }> {
    const cells: HeldOutCell[] = [];
    const checked = await this.heldOutPass(job, () =>
      this.verifyGoals(job, contract, ctx, arm, { heldOut: true, goals, heldOutCells: cells }),
    );
    // A goal with no held-out cell has nothing to fail here.
    const failed = checked
      .filter((r) => r.status !== "met" && r.reasons !== "no held-out cells")
      .map((r) => r.goal);
    return { pass: !failed.length, cells: heldOutResult(cells).cells, failed };
  }

  /**
   * The held-out cells one goal's check ran: a threshold goal's own, or those of a code goal's
   * verifier and of the gates it requires.
   */
  private heldOutCellsOf(
    goal: GoalContract["goals"][number] | undefined,
    kit: Kit,
    cells: readonly HeldOutCell[],
  ): HeldOutCell[] {
    if (!goal) return [];
    if (goal.verify.type !== "code") return cells.filter((c) => c.goal === goal.id);
    const verifiers = new Set<string>();
    const add = (name: string) => {
      if (verifiers.has(name)) return;
      verifiers.add(name);
      for (const gate of kit.verifiers[name]?.requires ?? []) add(gate);
    };
    add(goal.verify.verifier);
    return cells.filter((c) => c.verifier !== undefined && verifiers.has(c.verifier));
  }

  private complete(
    contract: GoalContract,
    results: { required: boolean; status: GoalStatus }[],
  ): boolean {
    const met = results.filter((r) => r.status === "met");
    if (contract.success.policy === "k_of_n")
      return met.length >= (contract.success.k ?? results.length);
    const required = results.filter((r) => r.required);
    return required.length > 0 && required.every((r) => r.status === "met");
  }

  /** Measures every goal on the champion: the judge-only validation and the goal tree's state. */
  private async validate(job: JobRow): Promise<Finish> {
    const run = String(this.spec(job).run);
    const contract = this.goalContract(run);
    const champion = this.ledger.currentChampion(run);
    const k = await this.kitFor(contract);
    const arm = await this.armFor("champion", run, champion.commit_sha, k);
    const ctx = this.context(k, job);
    const results = await this.verifyGoals(job, contract, ctx, arm, {
      champion: { run, attempt: champion.attempt, commit: champion.commit_sha },
    });
    this.recordGoals(job, run, null, champion.commit_sha, results, true);
    const done = this.complete(contract, results);
    // Completion is final, so one validation is not enough: a second, independent validation
    // of the same champion must agree before the campaign closes. A confirmation queued for an
    // earlier champion (a promotion came first) is a first validation of this one (goal 086).
    const spec = this.spec(job);
    const confirming =
      spec.confirm === true &&
      (spec.champion_seq === undefined || Number(spec.champion_seq) === champion.seq);
    // The second validation also runs the held-out cells of each goal the champion meets (goal
    // 086, the owner's decision of 2026-10-22): an attempt's confirmation runs them only for the
    // goals it newly met, so without this a goal met long before was never checked on them. The
    // run closes only if every one passes. Subjective goals have no cells.
    let ho: (HeldOutResult & { failed: string[] }) | undefined;
    if (confirming && done && contract.held_out_cells.length) {
      const met = results
        .filter(
          (r) =>
            r.status === "met" &&
            contract.goals.find((g) => g.id === r.goal)?.verify.type !== "review",
        )
        .map((r) => r.goal);
      if (met.length) ho = await this.heldOutGoals(job, contract, ctx, arm, met);
      // No held-out cell ran (none of these goals has one): there was nothing to check.
      if (ho?.pass && !ho.cells.length) ho = undefined;
      if (ho)
        this.ledger.recordChampionHeldOut(job.id, job.fence, run, champion.seq, ho.pass, {
          pass: ho.pass,
          cells: ho.cells,
        });
    }
    // A goal whose held-out check failed is not met: the goal tree says so, so a change that
    // meets it again is progress, and its own confirmation runs that goal's held-out cells. The
    // report says why by kind alone (goal 082), never which cell, its values or its texts; the
    // owner's detail is in the held_out record and its event.
    const unconfirmed = new Set(ho && !ho.pass ? ho.failed : []);
    const shown: GoalResult[] = results.map((r) =>
      unconfirmed.has(r.goal)
        ? {
            ...r,
            status: "unmet",
            reasons: `not confirmed: ${heldOutWords(
              heldOutKinds(
                this.heldOutCellsOf(
                  contract.goals.find((g) => g.id === r.goal),
                  k.kit,
                  ho?.cells ?? [],
                ),
              ),
            )}; on the measured cells: ${r.reasons}`,
          }
        : r,
    );
    if (unconfirmed.size)
      this.recordGoals(
        job,
        run,
        null,
        champion.commit_sha,
        shown.filter((r) => unconfirmed.has(r.goal)),
        true,
      );
    const complete = done && !unconfirmed.size;
    const summary = {
      run,
      champion_seq: champion.seq,
      // Each goal's description too, so a reader of the report needs no copy of the contract;
      // a code goal's values on each public cell (goal 086).
      goals: shown.map((r) => ({
        goal: r.goal,
        description: contract.goals.find((g) => g.id === r.goal)?.description ?? null,
        status: r.status,
        reasons: r.reasons,
        ...(r.values ? { values: r.values } : {}),
      })),
      complete,
      ...(done && !confirming ? { confirming: true } : {}),
      // The champion was not confirmed: its held-out check failed, said by kind alone.
      ...(ho && !ho.pass ? { not_confirmed: heldOutWords(heldOutKinds(ho.cells)) } : {}),
    };
    if (done && !confirming) {
      return {
        result: summary,
        events: [{ kind: "goal_report" as const, subject: run, body: summary }],
        enqueue: {
          kind: "validate",
          priority: 40,
          spec: { run, champion_seq: champion.seq, confirm: true },
          actor: this.o.owner,
        },
      };
    }
    return {
      result: summary,
      events: [
        // The owner's record of the champion's held-out check, before the report it decided.
        ...(ho ? [heldOutEvent(job.id, run, run, ho, champion.seq)] : []),
        { kind: "goal_report" as const, subject: run, body: summary },
        ...(complete
          ? [{ kind: "goal_complete" as const, subject: run, body: { champion_seq: champion.seq } }]
          : []),
      ],
      ...(complete ? { close: { run, reason: "every required goal is met" } } : {}),
    };
  }

  /**
   * A goal-mode attempt: progress means it meets at least one goal the champion does not, and
   * loses none the champion meets. The champion's statuses come from the latest validation.
   */
  private async evaluateGoal(job: JobRow): Promise<Finish> {
    const attemptId = job.attempt as string;
    const attempt = this.ledger.getAttempt(attemptId);
    if (!attempt) throw new InfraError(`no attempt ${attemptId}`);
    const run = String(attempt.run);
    const contract = this.goalContract(run);
    const champion = this.ledger.currentChampion(run);
    try {
      const k = await this.kitFor(contract);
      this.ledger.setAttemptLifecycle(attemptId, "building", this.o.owner);
      const cand = await this.armFor("candidate", run, String(attempt.commit_sha), k);
      this.ledger.setAttemptLifecycle(attemptId, "verifying", this.o.owner);
      const results = await this.verifyGoals(job, contract, this.context(k, job), cand);
      this.recordGoals(job, run, attemptId, String(attempt.commit_sha), results, false);
      const champ = new Map(
        (
          this.ledger.db.prepare("select id, status from goal where run = ?").all(run) as {
            id: string;
            status: string;
          }[]
        ).map((g) => [g.id, g.status]),
      );
      const reviewed = new Set(
        contract.goals.filter((g) => g.verify.type === "review").map((g) => g.id),
      );
      // Subjective goals are reviewed per champion, so they do not decide a candidate.
      const { gained, lost, unsure } = goalDelta(
        results.filter((r) => !reviewed.has(r.goal)),
        champ,
      );
      // A goal the champion meets that the candidate fails is lost; one it could not check
      // (inconclusive, not runnable) is unknown, which is not a regression and not progress.
      const verdict = lost.length
        ? "regress"
        : unsure.length
          ? "inconclusive"
          : gained.length
            ? "goal_screened"
            : "no_progress";
      const reasons = `${gained.length ? `newly met: ${gained.join(", ")}` : "no new goal met"}${lost.length ? `; lost: ${lost.join(", ")}` : ""}${unsure.length ? `; could not check: ${unsure.join(", ")}` : ""}; vs champion seq ${champion.seq}`;
      const screened = verdict === "goal_screened";
      return {
        result: { verdict, gained, lost, unsure },
        verdict: {
          attempt: attemptId,
          verdict,
          dependsOnJobs: [job.id],
          reasons,
          judgedBy: this.o.owner,
          guards: results.map((r) => ({ goal: r.goal, status: r.status })),
        },
        ...(screened
          ? {
              enqueue: {
                attempt: attemptId,
                kind: "confirm",
                priority: 50,
                spec: { baseline_seq: champion.seq, screen_job: job.id, gained, ...this.avoidMe() },
                actor: this.o.owner,
              },
            }
          : {}),
        lifecycle: screened ? "confirming" : "judged",
      };
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      return this.stopped(job, err);
    }
  }

  /**
   * Confirms a screened goal attempt: the goals are checked again in fresh runs (and on the
   * held-out cells, whose result only promotion code sees). It is promoted only if the goals it
   * gained at screening still hold and it loses or blurs none the champion meets.
   */
  private async confirmGoal(job: JobRow): Promise<Finish> {
    const attemptId = job.attempt as string;
    const attempt = this.ledger.getAttempt(attemptId) as Record<string, unknown>;
    const run = String(attempt.run);
    const contract = this.goalContract(run);
    const baselineSeq = Number(this.spec(job).baseline_seq);
    const champion = this.ledger.currentChampion(run);
    if (champion.seq !== baselineSeq) {
      return {
        result: { rescreen: true, baseline_seq: baselineSeq, champion_seq: champion.seq },
        enqueue: { attempt: attemptId, kind: "evaluate", actor: this.o.owner },
        lifecycle: "queued",
      };
    }
    try {
      const k = await this.kitFor(contract);
      this.ledger.setAttemptLifecycle(attemptId, "verifying", this.o.owner);
      const cand = await this.armFor("candidate", run, String(attempt.commit_sha), k);
      const ctx = this.context(k, job);
      const results = await this.verifyGoals(job, contract, ctx, cand);
      this.recordGoals(job, run, attemptId, String(attempt.commit_sha), results, false);
      const champ = new Map(
        (
          this.ledger.db.prepare("select id, status from goal where run = ?").all(run) as {
            id: string;
            status: string;
          }[]
        ).map((g) => [g.id, g.status]),
      );
      const reviewed = new Set(
        contract.goals.filter((g) => g.verify.type === "review").map((g) => g.id),
      );
      // Subjective goals are reviewed per champion, so they do not decide a candidate.
      const { gained, lost, unsure } = goalDelta(
        results.filter((r) => !reviewed.has(r.goal)),
        champ,
      );
      const screened = (this.spec(job).gained as string[] | undefined) ?? [];
      const held = screened.filter((g) => !gained.includes(g));
      let ho: HeldOutResult | undefined;
      if (contract.held_out_cells.length && gained.length) {
        const { pass, cells } = await this.heldOutGoals(job, contract, ctx, cand, gained);
        ho = { pass, cells };
        this.ledger.recordHeldOut(job.id, job.fence, attemptId, ho.pass, ho);
      }
      const ok =
        gained.length > 0 && !lost.length && !unsure.length && !held.length && ho?.pass !== false;
      const verdict = ok ? "goal_progress" : "not_confirmed";
      // A held-out failure is named by its kind alone (goal 082); the owner's detail is in the
      // held_out record and its event.
      const why = [
        ho && !ho.pass ? heldOutWords(heldOutKinds(ho.cells)) : "",
        held.length ? `no longer met: ${held.join(", ")}` : "",
        lost.length ? `lost: ${lost.join(", ")}` : "",
        unsure.length ? `could not check: ${unsure.join(", ")}` : "",
      ].filter(Boolean);
      const reasons = ok
        ? `confirmed: newly met ${gained.join(", ")}; vs champion seq ${champion.seq}`
        : `confirmation failed${why.length ? `: ${why.join("; ")}` : ""}; vs champion seq ${champion.seq}`;
      const fin: Finish = {
        result: { verdict, gained },
        verdict: {
          attempt: attemptId,
          verdict,
          dependsOnJobs: [job.id, Number(this.spec(job).screen_job ?? job.id)],
          reasons,
          judgedBy: this.o.owner,
          guards: results.map((r) => ({ goal: r.goal, status: r.status })),
        },
        ...(ho ? { events: [heldOutEvent(job.id, run, attemptId, ho)] } : {}),
        lifecycle: "judged",
      };
      if (!ok) return fin;
      const promoted = this.promotion(fin, attemptId, run, champion.seq, attempt);
      // A new champion is validated afresh, so the goal tree reflects it.
      return promoted.promote
        ? {
            ...promoted,
            enqueue: { kind: "validate", priority: 60, spec: { run }, actor: this.o.owner },
          }
        : promoted;
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      return this.stopped(job, err);
    }
  }

  /**
   * Each running goal campaign's champion is validated: once per champion, again after a failure
   * (up to three times, ten minutes apart), and never while a validation is queued or running.
   */
  private maybeScheduleValidation(): void {
    for (const inst of this.ledger.listRuns()) {
      if (inst.status !== "running" || inst.mode !== "goal") continue;
      const proposal = new Conclusions(this.ledger).maybePropose(
        inst.id,
        this.goalContract(inst.id),
        this.o.owner,
      );
      // Hands-off by default (goal 079): the evidence ends the campaign unless the run asks.
      if (proposal !== undefined && this.o.service.takeConclusion(inst.id, proposal)) continue;
      const seq = this.ledger.currentChampion(inst.id).seq;
      const jobs = this.ledger.db
        .prepare(
          `select state, updated_at, json_extract(result, '$.champion_seq') as done_seq,
             json_extract(result, '$.confirming') as confirming,
             json_extract(spec, '$.champion_seq') as spec_seq
           from job where kind = 'validate' and json_extract(spec, '$.run') = ? order by id`,
        )
        .all(inst.id) as {
        state: string;
        updated_at: string;
        done_seq: number | null;
        confirming: number | null;
        spec_seq: number | null;
      }[];
      if (jobs.some((j) => j.state === "queued" || j.state === "leased")) continue;
      // Settled: a validation of this champion that did not leave a completion to confirm.
      if (jobs.some((j) => j.state === "done" && Number(j.done_seq) === seq && !j.confirming))
        continue;
      const failed = jobs.filter(
        (j) => j.state === "failed" && (j.spec_seq === null || Number(j.spec_seq) === seq),
      );
      if (failed.length >= 3) continue;
      const lastFail = failed.at(-1);
      if (lastFail && Date.now() - Date.parse(lastFail.updated_at) < 10 * 60_000) continue;
      this.ledger.enqueueJob({
        kind: "validate",
        priority: 40,
        spec: { run: inst.id, champion_seq: seq },
        actor: this.o.owner,
      });
    }
  }

  // ------------------------------------------------------------------ baseline (goal 115)

  /**
   * Queues the baseline of each running hill climb's starting point when it is due (baselineDue),
   * and returns the runs that have no baseline yet, waiting or in setup: the judge leases none
   * of their jobs but a baseline job until they have one.
   */
  private maybeScheduleBaseline(): string[] {
    const waiting: string[] = [];
    for (const inst of this.ledger.listRuns()) {
      if (inst.status !== "running" || inst.mode !== "hill_climb") continue;
      const s = baselineState(this.ledger, inst.id);
      if (!s || s.state === "measured") continue;
      waiting.push(inst.id);
      const due = baselineDue(this.ledger, inst.id);
      if (!due) continue;
      this.ledger.enqueueJob({
        kind: "baseline",
        priority: BASELINE_PRIORITY,
        spec: { run: inst.id, champion_seq: due.seq, commit: due.commit },
        actor: this.o.owner,
      });
    }
    return waiting;
  }

  /**
   * The baseline job (goal 115). It builds the starting point, or a setup change, and runs it
   * alone in blocks on every measured cell (never a held-out one), each block running each cell
   * `runs_per_cell` times. The kit's check may write to the job's judge-only folder meanwhile;
   * the folder is then sealed and each file hashed. Whatever would give a candidate `invalid` or
   * `crash_candidate` means the build can't be measured: for the starting point, a
   * `baseline_failed` event with the reasons (the run is in setup); for a setup change, its
   * verdict. A setup change that measures becomes the starting point (finish), and its values
   * the baseline.
   */
  private async baseline(job: JobRow): Promise<Finish> {
    const spec = this.spec(job);
    const run = String(spec.run);
    const contract = this.hillClimb(run);
    const s = baselineState(this.ledger, run);
    if (!s) throw new InfraError(`${run} has no baseline to measure`);
    const setup = job.attempt ?? undefined;
    let commit: string;
    if (setup) {
      // The run is no longer in setup: the change is judged as any change is, against the champion.
      if (s.state !== "setup")
        return {
          result: { setup_over: true },
          enqueue: { attempt: setup, kind: "evaluate", actor: this.o.owner },
          lifecycle: "queued",
        };
      const attempt = this.ledger.getAttempt(setup);
      if (!attempt) throw new InfraError(`no attempt ${setup}`);
      commit = String(attempt.commit_sha);
    } else {
      if (s.state === "measured" || Number(spec.champion_seq) !== s.start.seq)
        return { result: { skipped: "the starting point has its baseline, or has changed" } };
      commit = s.start.commit;
    }
    const step = (l: string) => {
      this.ledger.heartbeat(job.id, job.fence, this.o.leaseMs);
      if (setup) this.ledger.setAttemptLifecycle(setup, l, this.o.owner);
    };
    const expectedSeq = this.ledger.currentChampion(run).seq;
    const dir = prepareBaselineDir(this.o.service.paths.stateDir, run, job.id);
    try {
      const k = await this.kitFor(contract);
      step("building");
      const arm = await this.armFor("baseline", run, commit, k);
      const ctx = this.context(k, job, dir);
      step("screening");
      const count = Math.max(2, this.o.baselineBlocks ?? BASELINE_BLOCKS);
      const blocks = await this.blocks({
        job,
        ctx,
        arms: [arm],
        cells: contract.cells,
        count,
        runsPerCell: contract.acceptance.runs_per_cell,
      });
      const sealed = sealBaselineDir(dir);
      if (!sealed.ok) throw new Stop("invalid", sealed.reason);
      const body = this.baselineBody({
        job,
        run,
        contract,
        kit: k.kit,
        commit,
        attempt: setup ?? null,
        blocks,
        files: sealed.files,
        bytes: sealed.bytes,
      });
      if (setup)
        return {
          result: { baseline: true, summary: body.summary },
          start: { run, expectedSeq, attempt: setup, commitSha: commit, baseline: body },
        };
      return {
        result: { baseline: true, champion_seq: s.start.seq, summary: body.summary },
        events: [{ kind: "baseline", subject: run, body: { ...body, champion_seq: s.start.seq } }],
      };
    } catch (err) {
      removeBaselineDir(dir);
      if (!(err instanceof Stop)) throw err;
      if (setup)
        return this.stopped(
          job,
          new Stop(
            err.verdict,
            `the judge could not measure this setup change, so the run is still in setup: ${err.reason}`,
          ),
        );
      const reasons = clipReason(err.reason, REASONS_CHARS);
      const failure: BaselineFailure = {
        run,
        job: job.id,
        champion_seq: s.start.seq,
        commit,
        reasons,
        summary: `the judge could not measure champion #${s.start.seq} (${commit.slice(0, 8)}): ${clipReason(reasons.split("\n")[0] ?? "", 300)}`,
      };
      return {
        result: { baseline_failed: true, champion_seq: s.start.seq },
        events: [{ kind: "baseline_failed" as const, subject: run, body: failure }],
      };
    }
  }

  /** A baseline's record from its blocks: every kit metric on every cell, and the folder. */
  private baselineBody(x: {
    job: JobRow;
    run: string;
    contract: HillClimbContract;
    kit: Kit;
    commit: string;
    attempt: string | null;
    blocks: Block[];
    files: Baseline["files"];
    bytes: number;
  }): Omit<Baseline, "champion_seq"> {
    const { contract, kit } = x;
    const cells: Baseline["cells"] = {};
    for (const cell of contract.cells) {
      const byMetric: Baseline["cells"][string] = {};
      for (const metric of Object.keys(kit.metrics)) {
        const xs = x.blocks
          .map((b) => b.candidate[metric]?.[cell])
          .filter((v): v is number => v !== undefined && Number.isFinite(v));
        if (xs.length) byMetric[metric] = baselineValue(xs);
      }
      cells[cell] = byMetric;
    }
    const { metric, direction } = contract.objective.primary;
    const fig = (v: number) =>
      Math.abs(v) >= 1e5 ? v.toExponential(3) : String(Number(v.toPrecision(4)));
    const summary = `${metric} ${contract.cells
      .map((c) => {
        const v = cells[c]?.[metric];
        return v
          ? `${c} ${fig(v.median)} ±${((100 * v.mad) / Math.abs(v.median || 1)).toFixed(2)}%`
          : `${c} none`;
      })
      .join(
        ", ",
      )} (median of ${x.blocks.length} blocks${x.files.length ? `; the check kept ${x.files.length} file${x.files.length === 1 ? "" : "s"}` : ""})`;
    return {
      run: x.run,
      job: x.job.id,
      commit: x.commit,
      attempt: x.attempt,
      blocks: x.blocks.length,
      runs_per_cell: contract.acceptance.runs_per_cell,
      primary: { metric, direction },
      guards: contract.guards.map((g) => ({
        metric: g.metric,
        direction: g.direction,
        max_total_regression: g.max_total_regression,
      })),
      units: Object.fromEntries(Object.entries(kit.metrics).map(([n, m]) => [n, m.unit ?? ""])),
      cells,
      files: x.files,
      bytes: x.bytes,
      summary: clipReason(summary, 1000),
    };
  }

  // ------------------------------------------------------------------ A/A calibration

  /**
   * The run's latest calibrated A/A block spread (log ratio): the least spread a verdict's
   * interval assumes, so a few blocks that happen to agree on a noisy rig do not decide.
   */
  private noiseFloor(run: string): number {
    // With several judge cards, each card's own noise: a verdict uses the floor of the card it
    // was measured on.
    const mine = this.cards > 1 ? this.o.card?.uuid : undefined;
    const e = this.ledger.events.newest("calibration", {
      subject: run,
      body: mine ? { card: mine } : undefined,
    });
    const sigma = e ? Number(e.body.sigma) : 0;
    return Number.isFinite(sigma) && sigma > 0 ? sigma : 0;
  }

  /**
   * A hill climb's calibration (the A/A) comes after its baseline (goal 115): a run that waits
   * for its baseline gets none queued yet.
   */
  private maybeScheduleCalibration(waiting: readonly string[] = []): void {
    if (this.o.calibrationBlocks < 2) return;
    // Each judge card calibrates for itself; its executor schedules the job pinned to it.
    const mine = this.cards > 1 ? this.o.card?.uuid : undefined;
    for (const inst of this.ledger.listRuns()) {
      if (inst.status !== "running" || inst.mode !== "hill_climb") continue;
      if (waiting.includes(inst.id)) continue;
      const last = this.ledger.db
        .prepare(
          `select created_at from job where kind = 'calibrate' and json_extract(spec, '$.run') = ?
             ${mine ? "and json_extract(spec, '$.card') = ?" : ""} order by id desc limit 1`,
        )
        .get(inst.id, ...(mine ? [mine] : [])) as { created_at: string } | undefined;
      if (last && Date.now() - Date.parse(last.created_at) < this.o.calibrationEveryMs) continue;
      this.ledger.enqueueJob({
        kind: "calibrate",
        priority: 200,
        spec: { run: inst.id, ...(mine ? { card: mine } : {}) },
        actor: this.o.owner,
      });
    }
  }

  /** How many judge cards the rig has. */
  private get cards(): number {
    return this.o.card?.count ?? 1;
  }

  /** A confirmation's spec: on a rig with several judge cards, not on this (the screen's) card. */
  private avoidMe(): { avoid_card?: string } {
    return this.cards > 1 && this.o.card ? { avoid_card: this.o.card.uuid } : {};
  }

  private async calibrate(job: JobRow): Promise<Finish> {
    const run = String(this.spec(job).run);
    const contract = this.hillClimb(run);
    const champion = this.ledger.currentChampion(run);
    const k = await this.kitFor(contract);
    const champ = await this.armFor("champion", run, champion.commit_sha, k);
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
      run,
      champion_seq: champion.seq,
      blocks: effects.length,
      sigma: sd,
      mean: i.estimate,
      ci: [i.low, i.high],
      summary: `A/A ${pct(i.estimate)} [${pct(i.low)}, ${pct(i.high)}], block sigma ${(sd * 100).toFixed(3)}%`,
      ...(this.cards > 1 && this.o.card
        ? { card: this.o.card.uuid, card_index: this.o.card.index }
        : {}),
    };
    return { result, events: [{ kind: "calibration" as const, subject: run, body: result }] };
  }
}
