import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { log } from "../../common/env.ts";
import type { StructuredDirective } from "../../core/commands.ts";
import { type Contract, laneLimits, type ResearchContract } from "../../core/contract.ts";
import type { LiveKind } from "../../core/live.ts";
import type { Role, Runner } from "../broker/runner.ts";
import type { Ledger } from "../ledger.ts";
import type { Research } from "../research/research.ts";
import type { HarnessService } from "../service.ts";
import type { ModelConfig } from "./model.ts";
import { attribute, type GoalReport, lanesOf, type PlannerInput, plan } from "./planner.ts";
import { type Assignment, Registry } from "./registry.ts";
import type { ResearchTrialSpec } from "./research-worker.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";
import { prepareWorkspace } from "./workspace.ts";

/**
 * The agent scheduler (SLA pattern). Each epoch the planner assigns every lane a direction; each
 * lane then runs `trials_per_epoch` trials, one at a time: a fresh workspace at the champion (or
 * the lane's best), one worker invocation, at most one submission, and the next trial only after
 * that submission is judged. An epoch ends when its lanes' trials are judged (or at a time cap).
 * Agents never judge: the scheduler only reads verdicts.
 */

const SETTLED = new Set([
  "judged",
  "promoted",
  "rejected_v0",
  "duplicate",
  "errored",
  "awaiting_approval",
  "awaiting_audit",
  "audit_blocked",
]);
const KEEP = new Set(["win_screened", "win_confirmed"]);

export interface SchedulerOptions {
  service: HarnessService;
  runner: Runner;
  model?: ModelConfig | undefined;
  /** Runs one trial (in a child process in the harness; in-process in tests); abortable. */
  runTrial: (spec: TrialSpec, signal: AbortSignal) => Promise<TrialResult>;
  /** Research mode: the research service and its trial runner. */
  research?: Research | undefined;
  runResearchTrial?:
    | ((spec: ResearchTrialSpec, signal: AbortSignal) => Promise<TrialResult>)
    | undefined;
  /** Development runs: a lane's queued or running dev run is settled before its next trial. */
  devRuns?: { settle(lane: string): Promise<void> } | undefined;
  owner: string;
  maxConcurrent?: number | undefined;
  trialWallMs?: number | undefined;
  /** A cap on each trial's turns: none unless configured (THERMITE_MAX_TURNS). */
  maxTurns?: number | undefined;
  epochCapMs?: number | undefined;
  /** Goal mode: how long an epoch waits for the judge's goal report on a new champion. */
  goalReportWaitMs?: number | undefined;
  /** Model price per million tokens, for the contract's llm_usd budget (unset: not enforced). */
  usdPerMTokIn?: number | undefined;
  usdPerMTokOut?: number | undefined;
  /** Backoff after unproductive trials: base delay and cap. */
  backoffBaseMs?: number | undefined;
  backoffMaxMs?: number | undefined;
}

/** Lifecycles of attempts the judge has not finished with. */
const OPEN_LIFECYCLES = [
  "queued",
  "building",
  "screening",
  "confirming",
  "verifying",
  "awaiting_audit",
  "awaiting_approval",
];
/** After this many trials in a row end in errors, agents cool down (a model outage, usually). */
const ERROR_STREAK = 6;
const COOLDOWN_MS = 30 * 60_000;

type Optional =
  | "model"
  | "research"
  | "runResearchTrial"
  | "devRuns"
  | "usdPerMTokIn"
  | "usdPerMTokOut";

export class Scheduler {
  readonly registry: Registry;
  private readonly o: Required<Omit<SchedulerOptions, Optional>> & Pick<SchedulerOptions, Optional>;
  private readonly ledger: Ledger;
  private readonly running = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  /** The run each running trial (by lane) works for. */
  private readonly laneRun = new Map<string, string>();
  /** The planner call in flight, if any. */
  private planning: { run: string; ctrl: AbortController } | undefined;
  private watcher: ReturnType<typeof setInterval> | undefined;
  /** The newest workers_reset event acted on. */
  private resetSeen: number;
  private cooldownNoted = "";
  private reportNoted = "";

  constructor(opts: SchedulerOptions) {
    this.o = {
      maxConcurrent: 1,
      trialWallMs: 20 * 60_000,
      epochCapMs: 3 * 3_600_000,
      goalReportWaitMs: 2 * 3_600_000,
      backoffBaseMs: 15_000,
      backoffMaxMs: 10 * 60_000,
      ...opts,
    } as typeof this.o;
    this.ledger = opts.service.ledger;
    this.registry = new Registry(this.ledger);
    // Resume after a restart: nothing of an earlier process is running any more.
    this.registry.interruptUnfinished(opts.owner);
    this.resetSeen = this.lastReset();
  }

  private lastReset(): number {
    const r = this.ledger.db
      .prepare("select max(id) as id from event where kind = 'workers_reset'")
      .get() as { id: number | null };
    return Number(r.id ?? 0);
  }

  /**
   * Work in flight for a run that is no longer running (paused, closed) stops at once: its
   * trials are killed and its planner call is cancelled, instead of running to their end.
   */
  private stopIfNotRunning(): void {
    const running = (id: string) => this.ledger.getRun(id)?.status === "running";
    for (const [lane, ctrl] of this.aborts) {
      const run = this.laneRun.get(lane);
      if (run && !running(run) && !ctrl.signal.aborted) {
        this.ledger.appendEvent(this.o.owner, "trial_stopped", run, {
          lane,
          reason: "run not running",
        });
        ctrl.abort();
      }
    }
    if (this.planning && !running(this.planning.run)) this.planning.ctrl.abort();
  }

  /** Checks every second while trials or a planner call are in flight (the tick may be waiting). */
  private watch(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      try {
        this.stopIfNotRunning();
      } catch (err) {
        log("scheduler", "stop check failed", { error: String(err) });
      }
      if (!this.aborts.size && !this.planning && this.watcher) {
        clearInterval(this.watcher);
        this.watcher = undefined;
      }
    }, 1000);
    this.watcher.unref?.();
  }

  /**
   * reset_workers: running trials of the run are killed, lane bests cleared and the
   * epoch ended, so the next tick plans afresh.
   */
  private async applyResets(): Promise<void> {
    const resets = this.ledger.db
      .prepare("select id, subject from event where kind = 'workers_reset' and id > ? order by id")
      .all(this.resetSeen) as { id: number; subject: string }[];
    for (const r of resets) {
      this.resetSeen = r.id;
      for (const a of this.aborts.values()) a.abort();
      await this.idle();
      for (const lane of this.ledger.db
        .prepare("select id from lane where run = ?")
        .all(r.subject) as { id: string }[]) {
        this.registry.clearLaneBest(
          r.subject,
          lane.id.slice(r.subject.length + 1),
          this.o.owner,
          "workers reset",
        );
      }
      const epoch = this.registry.currentEpoch(r.subject);
      if (epoch && !epoch.ended_at) this.registry.endEpoch(r.subject, epoch.n, this.o.owner);
    }
  }

  /** Why a lane must wait before its next trial (backoff after unproductive trials), if it must. */
  private laneWaitMs(run: string, lane: string, research: boolean): number {
    const recent = this.registry.recentTrials(run, lane, 8);
    let k = 0;
    for (const t of recent) {
      const lifecycle = t.attempt ? String(this.ledger.getAttempt(t.attempt)?.lifecycle) : null;
      const unproductive = research
        ? t.stopped === "error"
        : t.stopped === "error" ||
          (!t.attempt && t.stopped !== "interrupted") ||
          lifecycle === "rejected_v0" ||
          lifecycle === "duplicate";
      if (!unproductive) break;
      k++;
    }
    if (!k || !recent[0]) return 0;
    const delay = Math.min(this.o.backoffBaseMs * 2 ** (k - 1), this.o.backoffMaxMs);
    return Math.max(0, Date.parse(recent[0].ended_at) + delay - Date.now());
  }

  /** A run of errors across the run (a model outage): no new trials for a while. */
  private coolingDown(run: string): boolean {
    const recent = this.registry.recentTrials(run, null, ERROR_STREAK);
    if (recent.length < ERROR_STREAK || !recent.every((t) => t.stopped === "error")) return false;
    const last = recent[0] as { ended_at: string; error: string | null };
    const until = Date.parse(last.ended_at) + COOLDOWN_MS;
    if (Date.now() >= until) return false;
    if (this.cooldownNoted !== last.ended_at) {
      this.cooldownNoted = last.ended_at;
      this.ledger.appendEvent(this.o.owner, "agents_cooldown", run, {
        until: new Date(until).toISOString(),
        trials: ERROR_STREAK,
        last_error: last.error?.slice(0, 300) ?? null,
      });
    }
    return true;
  }

  /**
   * The epoch cap: about 6% of the wall budget (Fork-and-Flush's per-branch exploration budget),
   * between 30 minutes and 3 hours; the configured cap without a wall budget.
   */
  private epochCap(contract: Contract): number {
    const w = contract.budget.wall_hours;
    if (w === undefined) return this.o.epochCapMs;
    return Math.min(3 * 3_600_000, Math.max(30 * 60_000, 0.06 * w * 3_600_000));
  }

  /**
   * Fork rounds (Fork-and-Flush): on a fixed schedule, never on a plateau, every lane starts again
   * from the champion. With a wall budget, at 33% and 66% of it; without one, every 20 epochs.
   */
  private maybeForkRound(run: string, contract: Contract, n: number): void {
    const rounds = Number(
      (
        this.ledger.db
          .prepare("select count(*) as k from event where kind = 'fork_round' and subject = ?")
          .get(run) as { k: number }
      ).k,
    );
    const w = contract.budget.wall_hours;
    let due = false;
    if (w !== undefined) {
      const created = this.ledger.db
        .prepare("select created_at from run where id = ?")
        .get(run) as { created_at: string };
      const used = (Date.now() - Date.parse(created.created_at)) / (w * 3_600_000);
      due = (rounds < 1 && used >= 1 / 3) || (rounds < 2 && used >= 2 / 3);
    } else {
      due = n > 1 && (n - 1) % 20 === 0;
    }
    if (!due) return;
    const lanes = this.ledger.db.prepare("select id from lane where run = ?").all(run) as {
      id: string;
    }[];
    for (const lane of lanes) {
      this.registry.clearLaneBest(
        run,
        lane.id.slice(run.length + 1),
        this.o.owner,
        "fork round: every lane starts from the champion",
      );
    }
    this.ledger.appendEvent(this.o.owner, "fork_round", run, { epoch: n, round: rounds + 1 });
  }

  /** The contract's budgets that end agent work, other than wall time: the first one spent. */
  private budgetSpent(run: string, contract: Contract): string | undefined {
    const b = contract.budget;
    if (b.device_hours !== undefined && this.ledger.deviceHours(run) >= b.device_hours)
      return "the device-hours budget is spent";
    if (
      b.llm_usd !== undefined &&
      this.o.usdPerMTokIn !== undefined &&
      this.o.usdPerMTokOut !== undefined
    ) {
      const t = this.registry.tokensUsed(run);
      const usd = (t.in * this.o.usdPerMTokIn + t.out * this.o.usdPerMTokOut) / 1e6;
      if (usd >= b.llm_usd) return `the model budget is spent ($${usd.toFixed(2)})`;
    }
    return undefined;
  }

  private openAttempts(run: string): number {
    const r = this.ledger.db
      .prepare(
        `select count(*) as n from attempt where run = ? and lifecycle in (${OPEN_LIFECYCLES.map(() => "?").join(",")})`,
      )
      .get(run, ...OPEN_LIFECYCLES) as { n: number };
    return Number(r.n);
  }

  /** Trials still running (awaited by tests and on shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  private run(): { id: string; contract: Contract } | undefined {
    const inst = this.ledger.listRuns().find((i) => i.status === "running");
    // A judge-only run: no planning, no trials.
    if (!inst?.agents) return undefined;
    if (inst.mode === "research" && !(this.o.research && this.o.runResearchTrial)) return undefined;
    return { id: inst.id, contract: this.o.service.contractFor(inst.id) };
  }

  private settled(attempt: string | null): boolean {
    if (!attempt) return true;
    return SETTLED.has(String(this.ledger.getAttempt(attempt)?.lifecycle));
  }

  /**
   * The directives in force. The owner's (issued through control) come first: a supervisor
   * directive about a family the owner has a directive for, or a supervisor lane count when the
   * owner set one, does not apply.
   */
  private directives(run: string): { id: number; body: StructuredDirective }[] {
    const all = this.ledger.activeDirectives(run).map((d) => ({
      id: d.id,
      owner: d.author.startsWith("control:"),
      body: d.body as StructuredDirective,
    }));
    const ownerFamilies = new Set(
      all.filter((d) => d.owner && d.body.family).map((d) => d.body.family),
    );
    const ownerLanes = all.some((d) => d.owner && d.body.kind === "lane_count");
    return all
      .filter(
        (d) =>
          d.owner ||
          ((!d.body.family || !ownerFamilies.has(d.body.family)) &&
            !(d.body.kind === "lane_count" && ownerLanes)),
      )
      .map((d) => ({ id: d.id, body: d.body }));
  }

  private laneCount(run: string, contract: Contract): number {
    const cap = contract.lanes.count;
    const d = this.directives(run)
      .filter((x) => x.body.kind === "lane_count" && typeof x.body.value === "number")
      .at(-1);
    return Math.max(1, Math.min(cap, Number(d?.body.value ?? cap)));
  }

  /** Relative gain of the current champion over the seed, from the confirmed steps. */
  private championGain(run: string): number {
    let gain = 1;
    const rows = this.ledger.db
      .prepare(
        "select attempt from champion where run = ? and reopened = 0 and attempt is not null",
      )
      .all(run) as { attempt: string }[];
    for (const r of rows) {
      const v = this.ledger.db
        .prepare(
          "select delta from verdict where attempt = ? and verdict = 'win_confirmed' order by id desc limit 1",
        )
        .get(r.attempt) as { delta: number | null } | undefined;
      gain *= 1 + (v?.delta ?? 0);
    }
    return gain - 1;
  }

  /**
   * Keeps each lane's best (SLA keep rule): a judged win of the lane, measured against the
   * current champion, that beats its previous best. Deltas measured against different champions
   * are never compared: when the champion moves, an older best is dropped. A best whose win did
   * not hold (failed confirmation, invalidation) or that became the champion is dropped too.
   */
  private updateLaneBests(run: string, lanes: string[]): void {
    const champion = this.ledger.currentChampion(run);
    for (const lane of lanes) {
      let best = this.registry.laneBest(run, lane);
      if (best) {
        const a = this.ledger.getAttempt(best);
        const verdict = this.ledger.currentVerdict(best)?.verdict;
        const why =
          !a || a.invalidated_by !== null
            ? "invalidated"
            : !verdict || !KEEP.has(verdict)
              ? `its verdict is now ${verdict ?? "none"}`
              : best === champion.attempt
                ? "it is the champion"
                : Number(a.baseline_champion_seq) !== champion.seq
                  ? "the champion has moved since it was measured"
                  : undefined;
        if (why) {
          this.registry.clearLaneBest(run, lane, this.o.owner, why);
          best = null;
        }
      }
      // After a fork round, only work done since the round may become a lane's best again.
      const round = this.ledger.db
        .prepare(
          "select at from event where kind = 'fork_round' and subject = ? order by id desc limit 1",
        )
        .get(run) as { at: string } | undefined;
      const current = (id: string) => {
        const a = this.ledger.getAttempt(id);
        return (
          Number(a?.baseline_champion_seq) === champion.seq &&
          (!round || String(a?.created_at) > round.at)
        );
      };
      const bestDelta = best
        ? (this.registry.evidence(run, 500, lane).find((e) => e.attempt === best)?.delta ?? null)
        : null;
      for (const e of this.registry.evidence(run, 20, lane)) {
        if (!e.verdict || !KEEP.has(e.verdict) || e.delta === null || e.attempt === best) continue;
        if (e.attempt === champion.attempt || !current(e.attempt)) continue;
        if (bestDelta === null || e.delta > bestDelta) {
          this.registry.setLaneBest(run, lane, e.attempt, this.o.owner);
          break;
        }
      }
    }
  }

  /** The judge's latest goal report on this champion (its validation), if there is one. */
  private goalReport(run: string, seq: number): GoalReport | undefined {
    const row = this.ledger.db
      .prepare(
        "select body from event where kind = 'goal_report' and subject = ? and json_extract(body, '$.champion_seq') = ? order by id desc limit 1",
      )
      .get(run, seq) as { body: string } | undefined;
    if (!row) return undefined;
    const body = JSON.parse(row.body) as GoalReport;
    return {
      champion_seq: seq,
      goals: body.goals.map((g) => ({
        goal: g.goal,
        status: g.status,
        reasons: g.reasons.slice(0, 500),
      })),
    };
  }

  /**
   * A goal campaign's epoch is planned from the judge's goal report on the current champion, so
   * lanes are not sent after goals it already meets. The wait ends when the report arrives, when
   * the judge has stopped validating this champion (three failures), or after goalReportWaitMs.
   */
  private awaitingGoalReport(run: string, n: number): boolean {
    const { seq } = this.ledger.currentChampion(run);
    if (this.goalReport(run, seq)) return false;
    const since = String(
      (
        this.ledger.db
          .prepare("select promoted_at from champion where run = ? and seq = ?")
          .get(run, seq) as { promoted_at: string } | undefined
      )?.promoted_at ?? "",
    );
    const failed = Number(
      (
        this.ledger.db
          .prepare(
            "select count(*) as k from job where kind = 'validate' and state = 'failed' and json_extract(spec, '$.run') = ? and updated_at >= ?",
          )
          .get(run, since) as { k: number }
      ).k,
    );
    const waited = since ? Date.now() - Date.parse(since) : Number.POSITIVE_INFINITY;
    const giveUp = failed >= 3 || waited >= this.o.goalReportWaitMs;
    const key = `${run}:${seq}:${n}:${giveUp}`;
    if (this.reportNoted !== key) {
      this.reportNoted = key;
      this.o.service.live.append({
        source: "planner",
        kind: "status",
        text: giveUp
          ? `planning epoch ${n} without a goal report on champion #${seq} (${failed >= 3 ? "its validation failed" : `none after ${Math.round(waited / 60_000)} min`})`
          : `epoch ${n} waits for the judge's goal report on champion #${seq}`,
        run,
      });
    }
    return !giveUp;
  }

  private async planEpoch(run: string, contract: Contract, n: number): Promise<void> {
    const laneCount = this.laneCount(run, contract);
    const lanes = lanesOf(laneCount);
    const champion = this.ledger.currentChampion(run);
    const input: PlannerInput = {
      run,
      epoch: n,
      laneCount,
      objective: objectiveOf(contract),
      editablePaths: "editable_paths" in contract ? contract.editable_paths : [],
      champion: { seq: champion.seq, gain: this.championGain(run) },
      families: this.registry.families(run),
      evidence: this.registry.evidence(run, 30),
      directives: this.directives(run),
      laneBests: Object.fromEntries(lanes.map((l) => [l, this.registry.laneBest(run, l)])),
      campaignNotes: contract.notes,
      ownerMessages: this.o.service.takePlannerMessages(run),
      goalReport: contract.mode === "goal" ? this.goalReport(run, champion.seq) : undefined,
    };
    const live = this.o.service.live;
    live.append({
      source: "planner",
      kind: "status",
      text: `planning epoch ${n} (${laneCount} lanes)`,
      run,
    });
    for (const m of input.ownerMessages ?? [])
      live.append({ source: "planner", kind: "message", text: `Owner: ${m}`, run });
    const ctrl = new AbortController();
    this.planning = { run, ctrl };
    this.watch();
    let p: Awaited<ReturnType<typeof plan>>;
    try {
      p = await plan(input, this.o.model, ctrl.signal);
    } finally {
      this.planning = undefined;
    }
    // Paused or closed while planning: no epoch starts.
    if (ctrl.signal.aborted) {
      live.append({ source: "planner", kind: "status", text: "planning cancelled", run });
      return;
    }
    live.append({
      source: "planner",
      kind: "text",
      text: [
        `epoch ${n}: ${p.source === "planner" ? `planned by the model${p.tries > 1 ? ` (try ${p.tries})` : ""}` : "the fallback plan"}`,
        ...p.assignments.map(
          (a) =>
            `${a.lane}: ${a.family}, ${a.focus}${a.parent === "lane_best" ? " (from the lane's best)" : ""}`,
        ),
        ...(p.newFamilies.length
          ? [`new families: ${p.newFamilies.map((f) => f.id).join(", ")}`]
          : []),
        ...(p.rawViolations.length ? [`refused: ${p.rawViolations.slice(0, 3).join("; ")}`] : []),
      ].join("\n"),
      run,
    });
    for (const f of p.newFamilies)
      this.registry.addFamily(run, f.id, f.description, `planner:${p.source}`);
    this.registry.startEpoch({
      run,
      n,
      source: p.source,
      tries: p.tries,
      valid: p.valid,
      rawViolations: p.rawViolations,
      assignments: attribute(p.assignments, input.directives),
      directives: input.directives.map((d) => d.id),
      notes: p.notes,
      by: this.o.owner,
    });
  }

  /** One scheduling step: plan when needed, start trials that may start. */
  async tick(): Promise<boolean> {
    this.stopIfNotRunning();
    await this.applyResets();
    const inst = this.run();
    if (!inst || !this.o.model) return false;
    // The contract's wall-time budget ends agent work (the judge still finishes what is queued).
    const wallHours = inst.contract.budget.wall_hours;
    const created = this.ledger.db
      .prepare("select created_at from run where id = ?")
      .get(inst.id) as { created_at: string } | undefined;
    if (
      wallHours !== undefined &&
      created &&
      Date.now() - Date.parse(created.created_at) > wallHours * 3_600_000
    ) {
      if (!this.running.size) {
        this.ledger.setRunStatus(inst.id, "paused", "the wall-time budget is spent", this.o.owner);
      }
      return false;
    }
    const spent = this.budgetSpent(inst.id, inst.contract);
    if (spent) {
      if (!this.running.size) this.ledger.setRunStatus(inst.id, "paused", spent, this.o.owner);
      return false;
    }
    if (this.coolingDown(inst.id)) return false;
    if (inst.contract.mode === "research") return this.researchTick(inst.id, inst.contract);
    const { id, contract } = inst;
    const perEpoch = contract.lanes.trials_per_epoch;
    let epoch = this.registry.currentEpoch(id);
    if (!epoch || epoch.ended_at) {
      if (contract.mode === "goal" && this.awaitingGoalReport(id, (epoch?.n ?? 0) + 1))
        return false;
      this.maybeForkRound(id, contract, (epoch?.n ?? 0) + 1);
      await this.planEpoch(id, contract, (epoch?.n ?? 0) + 1);
      epoch = this.registry.currentEpoch(id);
      if (!epoch) return false;
    }
    this.updateLaneBests(
      id,
      epoch.assignments.map((a) => a.lane),
    );

    let started = false;
    let complete = true;
    for (const a of epoch.assignments) {
      const trials = this.registry.trials(id, a.lane, epoch.n);
      const last = trials.at(-1);
      const laneDone =
        trials.length >= perEpoch &&
        trials.every((t) => t.ended) &&
        this.settled(last?.attempt ?? null);
      if (!laneDone) complete = false;
      if (trials.length >= perEpoch || this.running.has(a.lane)) continue;
      if (last && (!last.ended || !this.settled(last.attempt))) continue;
      if (this.running.size >= this.o.maxConcurrent) continue;
      if (this.openAttempts(id) >= contract.budget.max_open_attempts) continue;
      if (this.laneWaitMs(id, a.lane, false) > 0) continue;
      this.startTrial(id, contract, epoch.n, a, trials.length + 1, perEpoch);
      started = true;
    }
    const capped = Date.now() - Date.parse(epoch.started_at) > this.epochCap(contract);
    if ((complete || capped) && !this.running.size)
      this.registry.endEpoch(id, epoch.n, this.o.owner);
    return started;
  }

  // ------------------------------------------------------------------ research mode

  /**
   * Research: the harness owns the clock. Lanes run trial after trial (no judge to wait for)
   * until max_duration; an hourly digest and a final report come from the ledger.
   */
  private async researchTick(run: string, contract: ResearchContract): Promise<boolean> {
    const research = this.o.research as Research;
    const clock = research.clock(run);
    if (clock.done) {
      if (this.running.size) return false; // let the last trials finish first
      research.report(run, "final");
      this.ledger.setRunStatus(run, "closed", "the research window is over", this.o.owner);
      return false;
    }
    const last = research.lastReportAt(run);
    if (!last || Date.now() - Date.parse(last) >= contract.report_cadence.digest_minutes * 60_000) {
      research.report(run, "digest");
    }
    let epoch = this.registry.currentEpoch(run);
    if (!epoch || epoch.ended_at) {
      this.planResearchEpoch(run, contract, (epoch?.n ?? 0) + 1);
      epoch = this.registry.currentEpoch(run);
      if (!epoch) return false;
    }
    let started = false;
    let complete = true;
    for (const a of epoch.assignments) {
      const trials = this.registry.trials(run, a.lane, epoch.n);
      if (trials.length < contract.lanes.trials_per_epoch || this.running.has(a.lane))
        complete = false;
      if (trials.length >= contract.lanes.trials_per_epoch || this.running.has(a.lane)) continue;
      if (this.running.size >= this.o.maxConcurrent) continue;
      if (this.laneWaitMs(run, a.lane, true) > 0) continue;
      this.startResearchTrial(run, contract, epoch.n, a, clock);
      started = true;
    }
    if (complete && !this.running.size) this.registry.endEpoch(run, epoch.n, this.o.owner);
    return started;
  }

  private static readonly RESEARCH_TASKS: { id: string; description: string }[] = [
    { id: "explore", description: "Find and read new relevant sources; record verified claims" },
    {
      id: "primary",
      description: "Trace existing claims to primary sources (papers, specifications, data)",
    },
    {
      id: "contradict",
      description: "Look for sources that disagree with recorded claims; record both sides",
    },
    { id: "consolidate", description: "Fold verified claims and notes into the report sections" },
  ];

  /**
   * Deterministic research plan: least-covered questions first, task kinds rotating by epoch.
   * Directives steer it by structure only (redirects in research mode): MANDATE and TRY name
   * task kinds to put first, AVOID removes a task kind, and a numeric TRY or MANDATE value puts
   * that question first. Directive text never reaches a worker's brief.
   */
  private planResearchEpoch(run: string, contract: ResearchContract, n: number): void {
    const research = this.o.research as Research;
    for (const t of Scheduler.RESEARCH_TASKS)
      this.registry.addFamily(run, t.id, t.description, "research-plan");
    const directives = this.directives(run);
    const avoid = new Set(
      directives.filter((d) => d.body.kind === "avoid" && d.body.family).map((d) => d.body.family),
    );
    const rank = (id: string) =>
      directives.some((d) => d.body.kind === "mandate" && d.body.family === id)
        ? 0
        : directives.some((d) => d.body.kind === "try" && d.body.family === id)
          ? 1
          : 2;
    // When novelty falls (an hour with no new source and no newly verified claim), lanes go
    // deeper instead of wider: primary sources and contradictions first. Otherwise task kinds
    // rotate by epoch. Directives then reorder or remove task kinds.
    const stats = research.stats(run);
    const stalled =
      research.clock(run).elapsed_ms > 3_600_000 &&
      stats.last_hour.sources === 0 &&
      stats.last_hour.verified === 0;
    const deep = (id: string) => Number(!["primary", "contradict"].includes(id));
    const rotated = stalled
      ? [...Scheduler.RESEARCH_TASKS].sort((x, y) => deep(x.id) - deep(y.id))
      : Scheduler.RESEARCH_TASKS.map(
          (_, k) =>
            Scheduler.RESEARCH_TASKS[(n + k - 1) % Scheduler.RESEARCH_TASKS.length] as {
              id: string;
              description: string;
            },
        );
    const tasks = rotated
      .filter((t) => !avoid.has(t.id))
      .map((t, k) => ({ t, k }))
      .sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.k - b.k)
      .map((x) => x.t);
    if (!tasks.length) tasks.push(rotated[0] as { id: string; description: string });
    const firstQuestions = directives
      .filter(
        (d) =>
          (d.body.kind === "mandate" || d.body.kind === "try") &&
          typeof d.body.value === "number" &&
          Number.isInteger(d.body.value) &&
          d.body.value >= 0 &&
          d.body.value < contract.questions.length,
      )
      .map((d) => Number(d.body.value));
    const coverage = stats.questions
      .map((q, i) => ({ i, verified: q.verified }))
      .sort(
        (x, y) =>
          Number(!firstQuestions.includes(x.i)) - Number(!firstQuestions.includes(y.i)) ||
          x.verified - y.verified ||
          x.i - y.i,
      );
    const lanes = lanesOf(this.laneCount(run, contract));
    const assignments: Assignment[] = lanes.map((lane, k) => {
      const q = coverage[k % coverage.length] as { i: number };
      const task = tasks[k % tasks.length] as { id: string; description: string };
      return {
        lane,
        family: task.id,
        focus: `Question ${q.i}: ${contract.questions[q.i]}. Task: ${task.description}.`,
        parent: "champion",
      };
    });
    this.registry.startEpoch({
      run,
      n,
      source: "fallback",
      tries: 0,
      valid: false,
      rawViolations: [],
      assignments: attribute(assignments, directives),
      directives: directives.map((d) => d.id),
      notes: stalled
        ? "research plan (deterministic in v1); novelty fell, so primary sources and contradictions first"
        : "research plan (deterministic in v1)",
      by: this.o.owner,
    });
  }

  private startResearchTrial(
    run: string,
    contract: ResearchContract,
    epoch: number,
    a: Assignment,
    clock: { elapsed_ms: number; min_ms: number; max_ms: number },
  ): void {
    const research = this.o.research as Research;
    const id = `t-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const stats = research.stats(run);
    const frontier = research.frontier(run, 30);
    const brief = [
      `# Research assignment (epoch ${epoch}, ${a.lane})`,
      `Campaign: ${contract.title}`,
      `Topic: ${contract.topic}`,
      "Questions:",
      ...contract.questions.map(
        (q, i) => `${i}. ${q} (${stats.questions[i]?.verified ?? 0} verified claims so far)`,
      ),
      "",
      `Your focus: ${a.focus}`,
      `Time: ${(clock.elapsed_ms / 3_600_000).toFixed(2)} h elapsed of at least ${(clock.min_ms / 3_600_000).toFixed(2)} h (the campaign continues after your trial).`,
      `Corpus: ${stats.sources} sources, ${stats.verified} verified claims, ${stats.drafts} drafts.`,
      contract.seeds.length ? `Starting URLs: ${contract.seeds.join(" ")}` : "",
      frontier.length ? `Links from archived sources not fetched yet: ${frontier.join(" ")}` : "",
      "",
      "Record claims only with exact quotes from archived sources, and say which question each answers.",
    ]
      .filter((l) => l !== "")
      .join("\n");
    const token = randomBytes(32).toString("hex");
    this.registry.startTrial({
      id,
      run,
      lane: a.lane,
      epoch,
      family: a.family,
      parent: "research",
      token,
    });
    this.trialLine(
      id,
      run,
      a.lane,
      "status",
      `research trial on ${a.lane}: ${a.family}, ${a.focus}`,
    );
    const fullBrief = this.withOwnerMessages(id, run, a.lane, brief);
    const abort = new AbortController();
    this.aborts.set(a.lane, abort);
    this.laneRun.set(a.lane, run);
    this.watch();
    const work = (async () => {
      let r: TrialResult = { stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      try {
        r = await (
          this.o.runResearchTrial as (
            s: ResearchTrialSpec,
            signal: AbortSignal,
          ) => Promise<TrialResult>
        )(
          {
            trialId: id,
            token,
            run,
            lane: a.lane,
            brief: fullBrief,
            wallMs: laneLimits(contract).trialMinutes
              ? (laneLimits(contract).trialMinutes as number) * 60_000
              : this.o.trialWallMs,
            maxTurns: this.o.maxTurns,
          },
          abort.signal,
        );
      } catch (err) {
        r = { ...r, error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (abort.signal.aborted) r = { ...r, stopped: "interrupted" };
        this.registry.finishTrial(id, r, this.o.owner);
        this.trialLine(
          id,
          run,
          a.lane,
          "status",
          `trial ended: ${r.stopped}${r.error ? ` (${r.error.slice(0, 200)})` : ""}`,
        );
      }
    })().finally(() => {
      this.running.delete(a.lane);
      this.aborts.delete(a.lane);
      this.laneRun.delete(a.lane);
    });
    this.running.set(a.lane, work);
  }

  private startTrial(
    run: string,
    contract: Contract,
    epoch: number,
    a: Assignment,
    k: number,
    perEpoch: number,
  ): void {
    const lane = a.lane as Role;
    const id = `t-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const token = randomBytes(32).toString("hex");
    const abort = new AbortController();
    this.aborts.set(a.lane, abort);
    this.laneRun.set(a.lane, run);
    this.watch();
    const work = (async () => {
      const inst = this.ledger.getRun(run);
      if (!inst) return;
      const champion = this.ledger.currentChampion(run);
      const best = this.registry.laneBest(run, a.lane);
      const parent =
        a.parent === "lane_best" && best
          ? String(this.ledger.getAttempt(best)?.commit_sha)
          : champion.commit_sha;
      this.registry.startTrial({
        id,
        run,
        lane: a.lane,
        epoch,
        family: a.family,
        parent,
        token,
      });
      this.trialLine(
        id,
        run,
        a.lane,
        "status",
        `trial on ${a.lane}: ${a.family}, ${a.focus} (from ${parent === champion.commit_sha ? `the champion, seq ${champion.seq}` : `the lane's best, ${best}`})`,
      );
      const limits = laneLimits(contract);
      let ws: { dir: string; repo: string } | undefined;
      let r: TrialResult = { stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      try {
        ws = await prepareWorkspace({
          runner: this.o.runner,
          scratchDir: this.o.service.paths.scratchDir,
          mirror: this.o.service.mirrorFor(inst.seed_repo),
          commit: parent,
          lane,
        });
        // The worker's tools reach this workspace through the API, for this trial only.
        this.o.service.trialWorkspaces.set(id, { lane: a.lane, repo: ws.repo, root: ws.dir });
        // Reset while the workspace was being prepared: the trial never starts.
        if (abort.signal.aborted) throw new Error("reset before the trial started");
        r = await this.o.runTrial(
          {
            trialId: id,
            token,
            run,
            lane,
            workspace: ws.repo,
            workspaceRoot: ws.dir,
            parentCommit: parent,
            editablePaths: "editable_paths" in contract ? contract.editable_paths : [],
            brief: this.withOwnerMessages(
              id,
              run,
              a.lane,
              this.brief(
                run,
                contract,
                epoch,
                a,
                k,
                perEpoch,
                parent === champion.commit_sha
                  ? `the champion (seq ${champion.seq})`
                  : `your lane's best attempt ${best}`,
              ),
            ),
            wallMs: limits.trialMinutes ? limits.trialMinutes * 60_000 : this.o.trialWallMs,
            maxTurns: this.o.maxTurns,
            limits,
          },
          abort.signal,
        );
      } catch (err) {
        r = { ...r, stopped: "error", error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (abort.signal.aborted && r.stopped !== "submitted") r = { ...r, stopped: "interrupted" };
        if (r.submitted) this.registry.tagAttempt(r.submitted.attempt, a.family);
        // The trial ends first (its token stops working), then its processes and dev runs.
        this.o.service.trialWorkspaces.delete(id);
        this.registry.finishTrial(id, { ...r, attempt: r.submitted?.attempt }, this.o.owner);
        this.trialLine(
          id,
          run,
          a.lane,
          "status",
          `trial ended: ${r.submitted ? `submitted ${r.submitted.attempt}` : r.stopped}${r.error ? ` (${r.error.slice(0, 200)})` : ""}`,
        );
        await this.o.runner.killRole(lane).catch(() => 0);
        await this.o.devRuns?.settle(lane).catch(() => undefined);
        await this.o.runner.killRole(lane).catch(() => 0);
        if (ws) await this.o.runner.remove(ws.dir).catch(() => undefined);
      }
    })().finally(() => {
      this.running.delete(a.lane);
      this.aborts.delete(a.lane);
      this.laneRun.delete(a.lane);
    });
    this.running.set(a.lane, work);
  }

  /** A line in a trial's live session (control's live view). */
  private trialLine(id: string, run: string, lane: string, kind: LiveKind, text: string): void {
    this.o.service.live.append({ source: `trial:${id}`, kind, text, lane, run });
  }

  /** The brief with the owner's messages for this lane, if any (each delivered once). */
  private withOwnerMessages(id: string, run: string, lane: string, brief: string): string {
    const msgs = this.o.service.takeMessages({ id, run, lane });
    if (!msgs.length) return brief;
    for (const m of msgs) this.trialLine(id, run, lane, "message", `Owner: ${m}`);
    return `${brief}\n\n# Messages from the campaign's owner\n${msgs.map((m) => `- ${m}`).join("\n")}`;
  }

  /** The worker's brief: built only from the ledger, and only from this lane's own history. */
  private brief(
    run: string,
    contract: Contract,
    epoch: number,
    a: Assignment,
    k: number,
    perEpoch: number,
    start: string,
  ): string {
    const fam = this.registry.families(run).find((f) => f.id === a.family);
    const mine = this.registry.evidence(run, 3, a.lane);
    const feedback = mine.length
      ? mine
          .map((e) => {
            const v = e.verdict ? this.ledger.currentVerdict(e.attempt) : undefined;
            const reasons = v
              ? String(
                  (
                    this.ledger.db.prepare("select reasons from verdict where id = ?").get(v.id) as
                      | { reasons: string }
                      | undefined
                  )?.reasons ?? "",
                ).slice(0, 600)
              : "";
            const v0 = this.ledger.getAttempt(e.attempt)?.v0;
            const violations = v0
              ? (JSON.parse(String(v0)) as { violations: string[] }).violations
              : [];
            return `- ${e.attempt} (${e.hypothesis ?? "no hypothesis"}): ${e.verdict ?? e.lifecycle}${
              e.delta !== null ? `, change ${(e.delta * 100).toFixed(2)}%` : ""
            }${reasons ? `. Judge: ${reasons}` : ""}${violations.length ? `. Refused before building: ${violations.join("; ")}` : ""}`;
          })
          .join("\n")
      : "- none yet";
    const report =
      contract.mode === "goal"
        ? this.goalReport(run, this.ledger.currentChampion(run).seq)
        : undefined;
    return [
      `# Assignment (epoch ${epoch}, trial ${k} of ${perEpoch}, ${a.lane})`,
      `Campaign: ${contract.title} (${contract.mode})`,
      `Objective: ${objectiveOf(contract)}`,
      `Editable paths: ${"editable_paths" in contract ? contract.editable_paths.join(", ") : "none"}`,
      "forbidden_patterns" in contract && contract.forbidden_patterns.length
        ? `Changes may not add lines matching: ${contract.forbidden_patterns.join(", ")}`
        : "",
      `Starting point: ${start}.`,
      contract.models.length
        ? `Models (read-only; open them by these exact paths in run or dev_run): ${contract.models
            .map((m) => `${m.name} at ${join(this.o.service.paths.stateDir, "models", m.sha256)}`)
            .join("; ")}`
        : "",
      `Direction: ${a.family}${fam ? ` (${fam.description})` : ""}`,
      `Focus: ${a.focus}`,
      "",
      report
        ? `# What the champion meets (the judge's check of champion #${report.champion_seq})\n${report.goals
            .map(
              (g) =>
                `- ${g.goal}: ${g.status}${g.status === "met" ? "" : `. ${g.reasons.slice(0, 300)}`}`,
            )
            .join("\n")}\n`
        : "",
      "# Your lane's recent attempts and the judge's findings",
      feedback,
      "",
      contract.notes ? `# Notes from the campaign's author\n${contract.notes}\n` : "",
      "# How to work",
      "Read the relevant code, make one focused change in the editable paths, build and test it with run, then call submit once. The judge measures it on the real target; your own timings never count.",
      "Your lane keeps a cache directory between trials, $THERMITE_LANE_CACHE (ccache uses it as CCACHE_DIR): use it for build caches so a fresh workspace does not rebuild everything.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }
}

function objectiveOf(c: Contract): string {
  if (c.mode === "hill_climb") {
    const p = c.objective.primary;
    return `${p.direction === "max" ? "increase" : "decrease"} ${p.metric} (at least ${(p.min_effect * 100).toFixed(1)}% to count) on cells ${c.cells.join(", ")}, without breaking correctness`;
  }
  if (c.mode === "goal") {
    return `reach these goals: ${c.goals.map((g) => `${g.id} (${g.description})`).join("; ")}`;
  }
  return c.topic;
}
