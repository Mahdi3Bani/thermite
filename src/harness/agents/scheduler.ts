import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Prompt, promptText } from "../../agents/prompt.ts";
import { ownerMessageSections } from "../../agents/roles/shared.ts";
import { renderWorkerBrief } from "../../agents/roles/worker.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { writeAtomic } from "../../common/fs.ts";
import { BRIEF_FILE, briefData, briefFile, briefSection } from "../../core/brief.ts";
import { EXPERIMENT_DETAILS, type StoredRule } from "../../core/commands.ts";
import type { Contract, ResearchContract } from "../../core/contract.ts";
import { asToken } from "../../core/directions.ts";
import type { NoteInput } from "../../core/journal.ts";
import type { LiveKind } from "../../core/live.ts";
import { queueTarget } from "../../core/queue-target.ts";
import {
  ANSWERED,
  NO_WRITER,
  PROGRESS_STOPPED,
  questionLabel,
  questionName,
  RESEARCH_PROGRESS,
  RESEARCH_STOPPED,
} from "../../core/research-check.ts";
import type { CallUsage } from "../../core/usage.ts";
import type { Role, Runner } from "../broker/runner.ts";
import { NOTES_ARE_DATA, notesData, notesText } from "../journal.ts";
import {
  type BaselineState,
  baselineState,
  SETUP_FAMILY,
  startingPoint,
} from "../judge/baseline.ts";
import { clipReason } from "../judge/reasons.ts";
import { briefingText, pastResearchLine } from "../knowledge.ts";
import { type Ledger, LedgerError } from "../ledger.ts";
import { type McpCaller, NOT_HANDED } from "../mcp-gateway.ts";
import { messageText } from "../messages.ts";
import { type Experiment, inFamily, type TaskYield } from "../queue.ts";
import { briefCards } from "../research/cards.ts";
import { hypothesisTask } from "../research/hypothesis-evidence.ts";
import { lastImprovement, progressStopped, questionSaturated } from "../research/progress.ts";
import type { Research } from "../research/research.ts";
import {
  briefGaps,
  itemsState,
  type ResearchEnd,
  researchEnd,
  researchPackage,
  researchReviewDue,
  waitingReview,
} from "../research/review.ts";
import {
  gapOf,
  nextGap,
  nextQuestion,
  type QuestionState,
  type ResearchState,
  researchState,
  stateWords,
  taskDetails,
  took,
} from "../research/shares.ts";
import { Reviews } from "../reviews.ts";
import { statusEvents } from "../run-status.ts";
import type { HarnessService } from "../service.ts";
import { routeOf } from "../usage.ts";
import { violationsOf, violationsText } from "../v0.ts";
import type { OnceKeeping } from "./cli-compaction.ts";
import {
  Coordinator,
  type Directive,
  focusOf,
  type Handout,
  keepsWorking,
  lanesAtWork,
  limitsInForce,
  PLANNER,
  resultOf,
  rulesInForce,
} from "./coordinator.ts";
import { mcpAgentTools } from "./mcp-tools.ts";
import { type ModelConfig, withAgentsContext } from "./model.ts";
import {
  type Ask,
  attribute,
  causeWords,
  fallbackPlan,
  type GoalReport,
  lanesOf,
  type PlannerCompaction,
  type PlannerInput,
  type PlannerMcp,
  type PlannerPast,
  plan,
  toDesign,
} from "./planner.ts";
import {
  classifyProviderError,
  FAILING_SAID,
  failedTooLong,
  KIND_WORDS,
  type ProviderErrorKind,
  stopsAgents,
} from "./provider-errors.ts";
import { type Assignment, type EpochRecord, Registry } from "./registry.ts";
import {
  plannerHypotheses,
  planResearch,
  type ResearchPlannerInput,
  type ResearchPlanResult,
} from "./research-planner.ts";
import type { ResearchTrialSpec } from "./research-worker.ts";
import { heldHandouts, lanesInRound, roundOver, waitsForJudge } from "./scheduler/rounds.ts";
import { lastStopAsked, stopTrials } from "./scheduler/stops.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";
import { prepareWorkspace } from "./workspace.ts";

export { questionDetails } from "../research/shares.ts";

/** How much of the judge's reasons a brief shows: for each of a lane's attempts, for each goal. */
const BRIEF_REASON_CHARS = 1200;
const BRIEF_GOAL_CHARS = 600;
/** How much of the judge's reasons a setup trial's brief shows (goal 115). */
const SETUP_REASON_CHARS = 3000;

/**
 * The agent scheduler (SLA pattern). Each epoch (a round) the planner, as the coordinator of the
 * run's experiment queue, gives every lane an experiment; each lane then runs `trials_per_epoch`
 * trials, one at a time, each on an experiment of its own (the round's first, then the next in
 * the queue): a fresh workspace at the champion (or the lane's best), one worker invocation, at
 * most one submission, and the next trial only after that submission is judged. An epoch ends
 * when its lanes' trials are judged; it has no time cap (goal 079). When its lanes keep working
 * (goal 135), the next trial and the next epoch start while the judge works through their changes
 * (at most max_open_attempts unjudged). Agents never judge: the scheduler only reads verdicts.
 *
 * The model provider decides when agents can work (goal 079): no trial or plan starts while the
 * workers' model check fails or after a trial found no credits, a refused key or an unserved
 * model (the run's agents stop, and the model is checked again after a growing pause), nor while
 * the provider's rate limit asked for a pause.
 */

const KEEP = new Set(["win_screened", "win_confirmed"]);

/**
 * A planner call through another harness: a folder it may read (its past research), the MCP
 * servers it may call with the gateway's credential made for this call (goal 068), and where its
 * model usage goes, as the program's output reports it (goal 075).
 */
export interface PlannerCallOptions {
  read?: string | undefined;
  mcp?: { auth: string; servers: string[] } | undefined;
  usage?: ((u: CallUsage) => void) | undefined;
  /**
   * Where the call's conversation is kept before each compaction, and who records it (goal 070):
   * OpenCode's, Codex's or Claude Code's own compactions of a planner call.
   */
  compaction?: OnceKeeping | undefined;
}

/**
 * The harness a planner call runs in. With a model of its own (`own`), the harness its route names
 * (goal 073): Pi, OpenCode, Claude Code or Codex. Following the workers' route: OpenCode for
 * OpenCode's own models, Codex when the workers run in Codex, else Pi. A Claude subscription runs
 * only in Claude Code, and OpenCode's own models only in OpenCode, whatever the route says.
 */
export function plannerHarness(
  m: ModelConfig | undefined,
  own: boolean,
): "pi" | "opencode" | "claude-code" | "codex" {
  if (!m) return "pi";
  if (m.api === "claude") return "claude-code";
  if (m.api === "opencode") return "opencode";
  if (m.harness === "codex") return "codex";
  if (own && m.harness === "opencode") return "opencode";
  return "pi";
}

export interface SchedulerOptions {
  service: HarnessService;
  runner: Runner;
  /**
   * The model route, or how to read it now: control may set or change the route while the
   * harness runs, and each plan and trial takes the route current when it starts.
   */
  model?: ModelConfig | (() => ModelConfig | undefined) | undefined;
  /**
   * A planner call through OpenCode, for OpenCode's own models: the answer's text. `read`: a
   * folder it may read and search (the run's past research), read only.
   */
  askOpencode?:
    | ((
        model: ModelConfig,
        prompt: string,
        signal?: AbortSignal,
        o?: PlannerCallOptions,
      ) => Promise<string>)
    | undefined;
  /** The planner's own model route, when control gave the planner one. */
  plannerModel?: (() => ModelConfig | undefined) | undefined;
  /**
   * A planner call through Claude Code, for a Claude subscription (only Claude Code may use one).
   * `read`: a folder it may read and search with read-only tools (the run's past research).
   */
  askClaude?:
    | ((
        model: ModelConfig,
        prompt: string,
        signal?: AbortSignal,
        o?: PlannerCallOptions,
      ) => Promise<string>)
    | undefined;
  /**
   * A planner call through the Codex CLI, for a route whose agents run in Codex. `read`: a folder
   * it may read and search (the run's past research), which its user may read and not change.
   */
  askCodex?:
    | ((
        model: ModelConfig,
        prompt: string,
        signal?: AbortSignal,
        o?: PlannerCallOptions,
      ) => Promise<string>)
    | undefined;
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
  /** A trial's length when its contract sets none: none unless the rig sets one (goal 079). */
  trialWallMs?: number | undefined;
  /** A cap on each trial's turns: none unless configured (THERMITE_MAX_TURNS). */
  maxTurns?: number | undefined;
  /** The rig's settings: whether workers start trials and the planner plans (default on). */
  workersOn?: (() => boolean) | undefined;
  plannerOn?: (() => boolean) | undefined;
  /**
   * The rig drains (goal 079): before its images change, no new trial or plan starts, and those
   * running end as they would.
   */
  draining?: (() => boolean) | undefined;
  /** A round's time cap: none unless given (tests only; goal 079). */
  epochCapMs?: number | undefined;
  /** Goal mode: how long an epoch waits for the judge's goal report on a new champion. */
  goalReportWaitMs?: number | undefined;
  /** Model price per million tokens, for the contract's llm_usd budget (unset: not enforced). */
  usdPerMTokIn?: number | undefined;
  usdPerMTokOut?: number | undefined;
  /** Backoff after unproductive trials: base delay and cap. */
  backoffBaseMs?: number | undefined;
  backoffMaxMs?: number | undefined;
  /** How long a run waits for its MCP servers before its first plan or trial (MCP_WAIT_MS). */
  mcpWaitMs?: number | undefined;
}

/**
 * How long a run whose kit names MCP servers waits, before its first plan or trial on this
 * harness, for the rig to hold each one its workers or planner get (goal 068). The supervisor
 * hands them over with the model route, every 30 s by default, and a harness that just started
 * or a run just assigned may not have them yet: a trial that started then would list no tools
 * from them for its whole length. A server control says it can't give is not waited for. Pacing,
 * not a cap: once the wait ends, the run goes on without the servers still missing, and History
 * and Live say which and why.
 */
export const MCP_WAIT_MS = 2 * 60_000;

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
/** The first pause before the model is checked again after the run's agents stopped (goal 079). */
const RECHECK_FIRST_MS = 60_000;
/** The longest pause between those checks: they double up to it. */
const RECHECK_MAX_MS = 30 * 60_000;

/** Why the run's agents are stopped (goal 079): the provider's kind and words. */
export interface AgentsStopped {
  kind: ProviderErrorKind | "check";
  words: string;
  /** What found it: a trial, the model check. */
  by: string;
  since: string;
}

type Optional =
  | "model"
  | "research"
  | "runResearchTrial"
  | "devRuns"
  | "usdPerMTokIn"
  | "usdPerMTokOut"
  | "trialWallMs"
  | "epochCapMs"
  | "draining";

export class Scheduler {
  readonly registry: Registry;
  /** How lanes get work from the run's experiment queue. */
  readonly coordinator: Coordinator;
  private readonly o: Required<Omit<SchedulerOptions, Optional>> & Pick<SchedulerOptions, Optional>;
  private readonly ledger: Ledger;
  private readonly running = new Map<string, Promise<void>>();
  /** Research runs whose starting links this scheduler has begun to archive (goal 078). */
  private readonly seeded = new Set<string>();
  /** Closed research runs whose final report failed (finishClosedResearch). */
  private readonly finalFailed = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();
  /** The run each running trial (by lane) works for. */
  private readonly laneRun = new Map<string, string>();
  /** The planner call in flight, if any. */
  private planning: { run: string; ctrl: AbortController } | undefined;
  private watcher: ReturnType<typeof setInterval> | undefined;
  /** The newest workers_reset and trial_stop_asked events acted on. */
  private resetSeen: number;
  private stopSeen: number;
  private reportNoted = "";
  /** Shutting down: no new plan or trial (goal 079). */
  private stopping = false;
  /**
   * Each run's model calls failing with no call that worked, since when (ms), from its trials'
   * results (goal 079): a trial that ends at its own time limit while its calls fail passes it on.
   */
  private readonly failingSince = new Map<string, number>();

  constructor(opts: SchedulerOptions) {
    this.o = {
      maxConcurrent: 1,
      goalReportWaitMs: 2 * 3_600_000,
      backoffBaseMs: 15_000,
      backoffMaxMs: 10 * 60_000,
      mcpWaitMs: MCP_WAIT_MS,
      ...opts,
    } as typeof this.o;
    this.ledger = opts.service.ledger;
    this.registry = new Registry(this.ledger);
    this.coordinator = new Coordinator({
      ledger: this.ledger,
      queue: opts.service.queue,
      registry: this.registry,
    });
    // Resume after a restart: nothing of an earlier process is running any more, and the
    // experiments those trials had go back to the queue.
    this.registry.interruptUnfinished(opts.owner);
    this.coordinator.finishOrphans(opts.owner);
    this.resetSeen = this.lastReset();
    this.stopSeen = lastStopAsked(this.ledger);
  }

  private lastReset(): number {
    const r = this.ledger.db
      .prepare("select max(id) as id from event where kind = 'workers_reset'")
      .get() as { id: number | null };
    return Number(r.id ?? 0);
  }

  /**
   * Work in flight that must stop stops at once (scheduler/stops.ts): the trials of a run that is
   * no longer running (paused, closed) and those the owner asked to stop are killed, and a planner
   * call for a run no longer running is cancelled, instead of running to their end.
   */
  private applyStops(): void {
    const o = { aborts: this.aborts, laneRun: this.laneRun, owner: this.o.owner };
    this.stopSeen = stopTrials(this.ledger, { ...o, seen: this.stopSeen });
    const p = this.planning;
    if (p && this.ledger.getRun(p.run)?.status !== "running") p.ctrl.abort();
  }

  /**
   * A research run the owner closed (close_run, goal 087) ends as one whose window is over: once
   * its last trial has ended, its final report is written from the ledger, and the next export
   * carries it and the run's folder. A run closed at the end of its window has its final report.
   */
  private finishClosedResearch(): void {
    if (!this.o.research) return;
    const closed = this.ledger.db
      .prepare(
        `select id from run where mode = 'research' and status = 'closed'
           and not exists (select 1 from event where kind = 'research_final' and subject = run.id)`,
      )
      .all() as { id: string }[];
    for (const { id } of closed) {
      // Its last trials end first; a report that failed is not tried again by this process.
      if ([...this.laneRun.values()].includes(id) || this.finalFailed.has(id)) continue;
      try {
        this.o.research.report(id, "final");
      } catch (err) {
        this.finalFailed.add(id);
        log("scheduler", "final report of a closed research run failed", {
          run: id,
          error: String(err),
        });
      }
    }
  }

  /**
   * A running research run that ended (goals 112 and 117): its review's pass was accepted, or the
   * progress rule stopped it. No new trial starts in it (researchTick). It waits for its research
   * paper: the harness asks the supervisor's final writer for it once, and the run ends when code
   * accepted the paper and its running trials have ended (closeEnded). A rig whose supervisor says
   * it has no final writer ends the run without one, once its trials have ended; until the
   * supervisor says, the run waits. Checked on every step, with or without a model.
   */
  private finishEndedResearch(): void {
    if (!this.o.research) return;
    const running = this.ledger.db
      .prepare("select id from run where mode = 'research' and status = 'running'")
      .all() as { id: string }[];
    const papers = this.o.service.papers;
    for (const { id } of running) {
      const end = researchEnd(this.ledger, id);
      if (!end) continue;
      let noPaper: string | undefined;
      if (!papers.accepted(id)) {
        const advisors = this.o.service.advisors;
        // The supervisor has not said yet whether it has a final writer: the run waits.
        if (!advisors) continue;
        if (advisors.writer) {
          try {
            if (papers.request(id, this.o.owner))
              this.o.service.live.append({
                source: "planner",
                kind: "status",
                text: "the final writer is asked for the run's research paper",
                run: id,
              });
          } catch (err) {
            log("scheduler", "the research paper was not asked for", {
              run: id,
              error: String(err),
            });
          }
          continue;
        }
        noPaper = NO_WRITER;
      }
      // Its running trials end first; a close that failed is not tried again by this process.
      if ([...this.laneRun.values()].includes(id) || this.finalFailed.has(id)) continue;
      try {
        this.closeEnded(id, end, noPaper);
      } catch (err) {
        this.finalFailed.add(id);
        log("scheduler", "an ended research run could not close", {
          run: id,
          error: String(err),
        });
      }
    }
  }

  /**
   * The end of a research run that ended (goals 112 and 117): its final report, which starts
   * with its research paper, then holds the review panel's decisions, and the close, with the
   * end's reason: `every question is answered`, or the progress rule's. The one place a run ends
   * this way, once its paper is in (or its rig has no final writer, `noPaper`) and its running
   * trials have ended.
   */
  private closeEnded(run: string, end: ResearchEnd, noPaper?: string | undefined): void {
    (this.o.research as Research).report(run, "final", { noPaper });
    if (noPaper)
      this.o.service.live.append({
        source: "planner",
        kind: "status",
        text: `${end.reason === ANSWERED ? "every question is answered" : "research stopped adding"}; the run ends with no research paper: ${noPaper}`,
        run,
      });
    this.ledger.setRunStatus(run, "closed", end.reason, this.o.owner);
  }

  /** Checks every second while trials or a planner call are in flight (the tick may be waiting). */
  private watch(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      try {
        this.applyStops();
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

  /**
   * A subscription's usage window is full (a trial said until when): no new trials or plans on
   * this rig until it resets. The agents wait; nothing pays for more (the owner's rule).
   */
  private waitingForLimit(run: string): boolean {
    const r = this.ledger.db
      .prepare(
        "select json_extract(body, '$.until') as until from event where kind = 'agents_wait_for_limit' order by id desc limit 1",
      )
      .get() as { until: string | null } | undefined;
    const until = r?.until ? Date.parse(r.until) : 0;
    if (Date.now() >= until) return false;
    if (this.limitNoted !== r?.until) {
      this.limitNoted = r?.until ?? undefined;
      this.o.service.live.append({
        source: "planner",
        kind: "status",
        text: `agents wait for the subscription's usage window to reset at ${r?.until}`,
        run,
      });
    }
    return true;
  }
  private limitNoted: string | undefined;

  /** Runs waiting for their MCP servers on this harness, since when (ms). */
  private readonly mcpWaits = new Map<string, number>();
  /** Runs whose wait for their MCP servers is over on this harness. */
  private readonly mcpReady = new Set<string>();

  /**
   * Whether a run waits for the MCP servers its kit names (MCP_WAIT_MS): no plan or trial starts
   * until the rig holds each one its workers or planner get, or control says why it can't give
   * one, or the wait ends. Then, once, History (`mcp_servers_wait`) and Live say how long it
   * waited and which are missing and why, and the run goes on without those: each later trial
   * gets a server the rig holds by then. A research run's clock does not count the wait. In this
   * process's memory: after a restart, the harness holds no server until the supervisor hands
   * them over again, so the run waits again.
   */
  private waitingForMcp(run: string): boolean {
    if (this.mcpReady.has(run)) return false;
    const lacking = this.o.service.mcp.lacking(run);
    const unknown = lacking.filter((l) => l.why === undefined).map((l) => l.name);
    const since = this.mcpWaits.get(run);
    const now = Date.now();
    const say = (text: string) =>
      this.o.service.live.append({ source: "planner", kind: "status", text, run });
    const seconds = Math.round(this.o.mcpWaitMs / 1000);
    if (unknown.length && (since === undefined || now - since < this.o.mcpWaitMs)) {
      if (since === undefined) {
        this.mcpWaits.set(run, now);
        say(
          `waiting for the MCP ${unknown.length === 1 ? "server" : "servers"} ${unknown.join(", ")}: control has not handed ${unknown.length === 1 ? "it" : "them"} to this rig yet. No plan or trial starts until ${unknown.length === 1 ? "it comes" : "they come"}, for up to ${seconds} s.`,
        );
      }
      return true;
    }
    this.mcpReady.add(run);
    this.mcpWaits.delete(run);
    const missing = lacking.map((l) => ({ name: l.name, why: l.why ?? NOT_HANDED }));
    const waited = since === undefined ? 0 : Math.round((now - since) / 1000);
    if (since !== undefined || missing.length)
      this.ledger.appendEvent(this.o.owner, "mcp_servers_wait", run, {
        ...(since !== undefined ? { since: new Date(since).toISOString() } : {}),
        waited_s: waited,
        missing,
      });
    if (missing.length) {
      say(
        `the run goes on without the MCP ${missing.length === 1 ? "server" : "servers"} ${missing.map((s) => `${s.name} (${s.why})`).join("; ")}${since !== undefined ? `, after waiting ${waited} s` : ""}. A later trial gets each one once the rig has it.`,
      );
    } else if (since !== undefined) {
      say("the run's MCP servers reached this rig: its plans and trials start with their tools.");
    }
    return false;
  }

  /** The newest event of these kinds (for this subject, when given). */
  private newest(
    kinds: string[],
    subject?: string,
  ): { id: number; at: string; body: Record<string, unknown> } | undefined {
    const r = this.ledger.db
      .prepare(
        `select id, at, body from event where kind in (${kinds.map(() => "?").join(",")})${subject !== undefined ? " and subject = ?" : ""} order by id desc limit 1`,
      )
      .get(...kinds, ...(subject !== undefined ? [subject] : [])) as
      | { id: number; at: string; body: string }
      | undefined;
    return r
      ? {
          id: Number(r.id),
          at: String(r.at),
          body: JSON.parse(r.body) as Record<string, unknown>,
        }
      : undefined;
  }

  /** The workers' model checks finished after event `after`, newest first. */
  private modelChecks(after: number): { id: number; at: string; ok: boolean; summary: string }[] {
    return (
      this.ledger.db
        .prepare(
          "select id, at, body from event where kind = 'rig_check_finished' and id > ? and json_extract(body, '$.check') = 'model' order by id desc",
        )
        .all(after) as { id: number; at: string; body: string }[]
    ).map((r) => {
      const b = JSON.parse(r.body) as { ok?: boolean; summary?: string };
      return { id: Number(r.id), at: String(r.at), ok: b.ok === true, summary: String(b.summary) };
    });
  }

  /**
   * The run's agents stop (goal 079): no new trial or plan, until a model check passes or the
   * route changes. Recorded once, with the provider's words, for History and Needs you. `said`
   * replaces the kind's own words (a failure that never cleared).
   */
  stopAgents(
    run: string,
    why: { kind: AgentsStopped["kind"]; words: string; by: string; said?: string | undefined },
  ): void {
    const stop = this.newest(["agents_stopped", "agents_resumed"], run);
    if (stop && this.ledgerKind(stop.id) === "agents_stopped") return;
    const said =
      why.said ?? (why.kind === "check" ? "the workers' model check fails" : KIND_WORDS[why.kind]);
    this.ledger.appendEvent(this.o.owner, "agents_stopped", run, {
      kind: why.kind,
      words: why.words.slice(0, 600),
      by: why.by,
      said,
    });
    this.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `the agents stop: ${said} (${why.words.slice(0, 300)}). No trial starts until a model check passes; the model is checked again in a minute, then less often.`,
      run,
    });
  }

  private ledgerKind(id: number): string {
    return String(
      (this.ledger.db.prepare("select kind from event where id = ?").get(id) as { kind: string })
        .kind,
    );
  }

  /**
   * Why the run's agents are stopped now, if they are (goal 079). A failing model check of the
   * workers' route (newer than the route) stops them; so does a trial that found no credits, a
   * refused key or an unserved model. They go on once a model check passes after the stop, or the
   * route changes. While stopped, the model is checked again after a pause that doubles from a
   * minute to 30 minutes; at once after the owner resumes the run.
   */
  private agentsStopped(run: string): AgentsStopped | undefined {
    const stop = this.newest(["agents_stopped", "agents_resumed"], run);
    const change = this.newest(["model_route_set", "model_route_cleared"]);
    const open = stop && this.ledgerKind(stop.id) === "agents_stopped" ? stop : undefined;
    if (open) {
      const checks = this.modelChecks(open.id);
      const passed = checks.find((c) => c.ok);
      const changed = change && change.id > open.id;
      if (passed || changed) {
        this.ledger.appendEvent(this.o.owner, "agents_resumed", run, {
          why: passed ? "a model check passed" : "the rig's model route changed",
        });
        this.o.service.live.append({
          source: "planner",
          kind: "status",
          text: `the agents go on: ${passed ? "a model check passed" : "the rig's model route changed"}`,
          run,
        });
        return undefined;
      }
      this.maybeRecheck(run, open, checks);
      return {
        kind: open.body.kind as AgentsStopped["kind"],
        words: String(open.body.words ?? ""),
        by: String(open.body.by ?? ""),
        since: open.at,
      };
    }
    // A failing model check of the workers' route, newer than the route and than the last time
    // the agents went on: no trial starts on a model that fails it.
    const last = this.modelChecks(Math.max(change?.id ?? 0, stop?.id ?? 0))[0];
    if (last && !last.ok) {
      const kind = classifyProviderError(last.summary).kind;
      this.stopAgents(run, {
        kind: stopsAgents(kind) ? kind : "check",
        words: last.summary,
        by: "the model check",
      });
      return {
        kind: stopsAgents(kind) ? kind : "check",
        words: last.summary,
        by: "the model check",
        since: last.at,
      };
    }
    return undefined;
  }

  /** While stopped: the model is checked again after a growing pause, at once after a resume. */
  private maybeRecheck(
    run: string,
    open: { id: number; at: string },
    checks: { id: number; at: string }[],
  ): void {
    if (this.o.service.modelCheckRunning()) return;
    const after = Math.max(open.id, checks[0]?.id ?? 0);
    const resumed = statusEvents(this.ledger, run, after).some((e) => e.status === "running");
    const pause = Math.min(RECHECK_MAX_MS, RECHECK_FIRST_MS * 2 ** checks.length);
    const due = Date.parse(checks[0]?.at ?? open.at) + pause;
    if (!resumed && Date.now() < due) return;
    this.o.service.checkModelNow("scheduler");
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

  /**
   * The harness is stopping (goal 079): no new plan or trial, the planner's call is cancelled, and
   * running trials stop and are recorded as interrupted, with the counters their workers last
   * reported, before this returns.
   */
  async shutdown(reason: string): Promise<void> {
    this.stopping = true;
    for (const [lane, ctrl] of this.aborts) {
      const run = this.laneRun.get(lane);
      if (run && !ctrl.signal.aborted)
        this.ledger.appendEvent(this.o.owner, "trial_stopped", run, { lane, reason });
      ctrl.abort();
    }
    this.planning?.ctrl.abort();
    await this.idle();
  }

  /** Trials running now (for a drain's report). */
  get trialsRunning(): number {
    return this.running.size;
  }

  private run(): { id: string; contract: Contract } | undefined {
    const inst = this.ledger.listRuns().find((i) => i.status === "running");
    // A judge-only run: no planning, no trials.
    if (!inst?.agents) return undefined;
    if (inst.mode === "research" && !(this.o.research && this.o.runResearchTrial)) return undefined;
    return { id: inst.id, contract: this.o.service.contractFor(inst.id) };
  }

  /** The directives in force: the owner's first (rulesInForce). */
  private directives(run: string): { id: number; body: StoredRule }[] {
    return rulesInForce(this.ledger, run);
  }

  private laneCount(run: string, contract: Contract): number {
    return lanesAtWork(this.ledger, run, contract);
  }

  /**
   * Relative gain of the current champion over the run's starting point (the seed, or the
   * champion a setup change became: goal 115), from the confirmed steps since.
   */
  private championGain(run: string): number {
    let gain = 1;
    const rows = this.ledger.db
      .prepare(
        "select attempt from champion where run = ? and reopened = 0 and attempt is not null and seq > ?",
      )
      .all(run, startingPoint(this.ledger, run).seq) as { attempt: string }[];
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
        reasons: clipReason(g.reasons, BRIEF_GOAL_CHARS),
      })),
      // Its held-out check failed (goal 086): the judge's fixed words of the kinds alone.
      ...(typeof body.not_confirmed === "string"
        ? { not_confirmed: clipReason(body.not_confirmed, BRIEF_GOAL_CHARS) }
        : {}),
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
          ? `planning round ${n} without a goal report on champion #${seq} (${failed >= 3 ? "its validation failed" : `none after ${Math.round(waited / 60_000)} min`})`
          : `round ${n} waits for the judge's goal report on champion #${seq}`,
        run,
      });
    }
    return !giveUp;
  }

  /**
   * Goal mode (goal 086): a validation of the champion found every required goal met, and only
   * the judge's second, confirming validation is left. No new round or trial starts while it is
   * queued or running: if it agrees, the run closes and a new trial's work would be lost. A trial
   * already at work goes on. If it does not agree (a goal is not met again, or the validation
   * fails), the lanes go on.
   */
  private waitingForConfirmation(run: string): boolean {
    const { seq } = this.ledger.currentChampion(run);
    const pending = this.ledger.db
      .prepare(
        `select count(*) as k from job where kind = 'validate' and state in ('queued', 'leased')
           and json_extract(spec, '$.run') = ? and json_extract(spec, '$.confirm') = 1
           and json_extract(spec, '$.champion_seq') = ?`,
      )
      .get(run, seq) as { k: number };
    const waiting = Number(pending.k) > 0;
    const noted = this.confirmNoted.get(run);
    if (waiting && noted !== seq) {
      this.confirmNoted.set(run, seq);
      this.o.service.live.append({
        source: "planner",
        kind: "status",
        text: `no new trial starts: the judge is confirming that champion #${seq} meets every required goal; if it does, the run closes (a trial at work goes on until then)`,
        run,
      });
    } else if (!waiting && noted !== undefined) {
      this.confirmNoted.delete(run);
      this.o.service.live.append({
        source: "planner",
        kind: "status",
        text: `trials start again: the judge's confirmation of champion #${noted} did not close the run`,
        run,
      });
    }
    return waiting;
  }
  /** Each run's champion whose confirmation Live was told about, so it is said once. */
  private readonly confirmNoted = new Map<string, number>();

  /**
   * Tells Live where a hill climb's baseline stands (goal 115), once for each change: the round
   * that waits for it, the setup when the judge could not measure the starting point, and the
   * baseline's arrival after either.
   */
  private noteBaseline(run: string, s: BaselineState, n: number): void {
    const before = this.baselineNoted.get(run);
    const key =
      s.state === "waiting"
        ? `waiting:${s.start.seq}:${n}:${s.infra?.at ?? ""}`
        : s.state === "setup"
          ? `setup:${s.failure.id}`
          : `measured:${s.baseline.id}`;
    if (before === key) return;
    this.baselineNoted.set(run, key);
    if (s.state === "measured" && (before === undefined || before.startsWith("measured:"))) return;
    this.o.service.live.append({
      source: "planner",
      kind: "status",
      text:
        s.state === "waiting"
          ? `round ${n} waits for the judge's baseline of the starting point (champion #${s.start.seq})${s.infra ? `; the judge's last try failed (${clipReason(s.infra.error, 300)}), and it tries again` : ""}`
          : s.state === "setup"
            ? `the judge could not measure the starting point (champion #${s.start.seq}): the run is in setup, and each lane works to make it build and run its cells. ${clipReason(s.failure.summary, 600)}`
            : `the judge measured the starting point (champion #${s.baseline.champion_seq}): ${clipReason(s.baseline.summary, 600)}. The rounds of the plan start now`,
      run,
    });
  }
  private readonly baselineNoted = new Map<string, string>();

  /**
   * A setup round (goal 115): the judge could not measure the starting point, so each lane gets
   * one setup experiment, at the top of the queue: make the project build and run its cells,
   * within the editable paths, never the kit. No planner call: the judge's reasons are the plan.
   */
  private planSetupEpoch(
    run: string,
    contract: Contract,
    n: number,
    setup: Extract<BaselineState, { state: "setup" }>,
  ): void {
    this.registry.addFamily(
      run,
      SETUP_FAMILY,
      "Make the starting point build and run its cells, so the judge can measure it",
      PLANNER,
    );
    const queue = this.o.service.queue;
    const handout: Handout[] = [];
    const assignments: Assignment[] = [];
    const why = `the judge could not measure the starting point (champion #${setup.start.seq}): no change can be judged until it can`;
    for (const lane of lanesOf(this.laneCount(run, contract))) {
      const x = queue.add(
        run,
        {
          title: "Make the starting point build and run its cells",
          details: clipReason(
            `The judge could not measure the starting point (champion #${setup.start.seq}, commit ${setup.start.commit.slice(0, 12)}). Its reasons: ${setup.failure.reasons}`,
            EXPERIMENT_DETAILS,
          ),
          family: SETUP_FAMILY,
          why,
          by: PLANNER,
          position: "top",
        },
        PLANNER,
      );
      handout.push({ lane, experiment: x.id, why: "setup" });
      assignments.push({
        lane,
        family: SETUP_FAMILY,
        focus: focusOf(x),
        parent: "champion",
        experiment: x.id,
        why: "setup",
      });
    }
    this.registry.startEpoch({
      run,
      n,
      source: "fallback",
      tries: 0,
      valid: false,
      rawViolations: [],
      assignments,
      notes:
        "setup: the judge could not measure the starting point; each lane works to make it build and run its cells",
      plan: "setup",
      by: this.o.owner,
    });
    this.coordinator.handout(
      run,
      n,
      handout,
      "setup round: each lane works to make the starting point build and run its cells",
    );
    this.o.service.live.append({
      source: "planner",
      kind: "text",
      text: `round ${n}: a setup round (the judge could not measure the starting point)\n${assignments.map((a) => `${a.lane}: make the starting point build and run its cells`).join("\n")}`,
      run,
    });
  }

  /** Setup experiments left in the queue once the starting point is measured are dropped. */
  private dropSetupExperiments(run: string): void {
    for (const x of this.o.service.queue.queued(run)) {
      if (x.family !== SETUP_FAMILY) continue;
      this.o.service.queue.drop(
        run,
        x.id,
        { by: PLANNER, why: "the judge measured the starting point: setup is over" },
        PLANNER,
      );
    }
  }

  /** New limits from the rig's settings; they apply from the next trial or check. */
  configure(p: {
    maxConcurrent?: number;
    trialWallMs?: number | undefined;
    maxTurns?: number | undefined;
  }): void {
    Object.assign(this.o, p);
  }

  /**
   * How the planner is called this round (goals 068, 070, 073, 075): its model, the harness it
   * runs in (`ask` when not Pi), the MCP servers the run's kit gives it, where its model calls are
   * recorded, and the run's past research it may read. The hill climb's and goal campaign's plan
   * and the research plan share it.
   */
  private async plannerRoute(
    run: string,
    contract: Contract,
    n: number,
  ): Promise<{
    m: ModelConfig | undefined;
    ask: Ask | undefined;
    mcp: PlannerMcp | undefined;
    usage: ((u: CallUsage) => void) | undefined;
    past: PlannerPast | undefined;
    pastLine: string | undefined;
  }> {
    // The planner's own model when control gave it one; else the workers'. A campaign's own
    // context settings apply to it too: the lower window, and the campaign's point (goal 070).
    const own = this.o.plannerModel?.();
    const m = withAgentsContext(own ?? this.modelNow(), contract.agents_context);
    // With a model of its own, the planner runs in the harness its route names (goal 073).
    // Following the workers: OpenCode's own models are reached only through OpenCode, a route
    // whose workers run in Codex plans in Codex too, and every other provider plans in Pi.
    // A Claude subscription, only through Claude Code: without it the planner refuses the route.
    // The MCP servers the run's kit gives the planner (goal 068), through the gateway: Pi's
    // tools call it in this process; another harness gets a credential made for the call.
    const caller: McpCaller = { run, kind: "planner", source: "planner" };
    const mcpServers = this.o.service.mcp.given(run, "planner").map((g) => g.name);
    const via = plannerHarness(m, own !== undefined);
    // Each of the round's model calls, in the run's records (goal 075).
    const usage = m
      ? this.o.service.usage.recorder(
          run,
          { round: `epoch ${n}`, agent: "planner" },
          routeOf(m, via),
        )
      : undefined;
    // Each call through OpenCode, Claude Code or Codex keeps its conversation before each of its
    // compactions in the run's research folder, as a Pi call does (goal 070).
    const keeping = via !== "pi" ? this.cliPlannerCompaction(run, via) : undefined;
    const withMcp = (o: Parameters<Ask>[2]): PlannerCallOptions => ({
      ...(o?.read !== undefined ? { read: o.read } : {}),
      ...(o?.mcp?.length
        ? { mcp: { auth: this.o.service.mintMcpToken(caller), servers: o.mcp } }
        : {}),
      usage,
      ...(keeping ? { compaction: keeping() } : {}),
    });
    const ask: Ask | undefined =
      via === "opencode" && m && this.o.askOpencode
        ? (prompt, sig, o) =>
            (this.o.askOpencode as NonNullable<SchedulerOptions["askOpencode"]>)(
              m,
              prompt,
              sig,
              withMcp(o),
            )
        : via === "claude-code" && m && this.o.askClaude
          ? (prompt, sig, o) =>
              (this.o.askClaude as NonNullable<SchedulerOptions["askClaude"]>)(
                m,
                prompt,
                sig,
                withMcp(o),
              )
          : via === "codex" && m && this.o.askCodex
            ? (prompt, sig, o) =>
                (this.o.askCodex as NonNullable<SchedulerOptions["askCodex"]>)(
                  m,
                  prompt,
                  sig,
                  withMcp(o),
                )
            : undefined;
    const mcp: PlannerMcp | undefined = mcpServers.length
      ? {
          servers: mcpServers,
          tools: ask
            ? []
            : mcpAgentTools((await this.o.service.mcp.tools(caller)).tools, (s, t, a) =>
                this.o.service.mcp.call(caller, s, t, a),
              ),
        }
      : undefined;
    // The run's past research, read only: Pi's planner searches it with its tool; through OpenCode,
    // Claude Code or Codex, the planner reads the run's knowledge/ files with its own tools.
    const knowledge = this.o.service.knowledge;
    const pastLine = this.pastResearch(run, ask ? "files" : "tool");
    const past: PlannerPast | undefined = pastLine
      ? { search: (q, o) => knowledge.search(run, q, o), dir: knowledge.dir(run) }
      : undefined;
    return { m, ask, mcp, usage, past, pastLine };
  }

  private async planEpoch(run: string, contract: Contract, n: number): Promise<void> {
    const laneCount = this.laneCount(run, contract);
    // The owner's messages to the planner and to everyone working, not read yet.
    const owner = this.o.service.messages.waitingForPlanner(run);
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
      queue: this.o.service.queue.brief(run),
      laneState: this.coordinator.laneState(run, lanes),
      directives: this.directives(run),
      directions: this.o.service.queue.directions(run),
      laneBests: Object.fromEntries(lanes.map((l) => [l, this.registry.laneBest(run, l)])),
      // The campaign's brief from its author, whole (goal 078).
      campaignBrief: briefData(contract),
      ownerMessages: owner.map((m) => ({ id: m.id, text: messageText(m) })),
      goalReport: contract.mode === "goal" ? this.goalReport(run, champion.seq) : undefined,
      // The run's newest field notes, the owner's picks from past research, and where the run's
      // past research is: all data for the planner to weigh.
      notes: notesData(this.o.service.journal.newest(run, 20)),
      briefing: this.ledger.briefing(run),
      // The queue's target (goal 081): the planner tops the queue up to it with distinct ideas.
      queueTarget: queueTarget(contract, laneCount),
    };
    const live = this.o.service.live;
    live.append({
      source: "planner",
      kind: "status",
      text: `planning round ${n} (${laneCount} lane${laneCount === 1 ? "" : "s"})`,
      run,
    });
    const ctrl = new AbortController();
    this.planning = { run, ctrl };
    this.watch();
    let p: Awaited<ReturnType<typeof plan>>;
    try {
      const r = await this.plannerRoute(run, contract, n);
      input.pastResearch = r.pastLine;
      // The planner off on this rig: the fixed fallback plan, said so in the epoch's record.
      if (this.o.plannerOn && !this.o.plannerOn()) {
        const f = fallbackPlan(input);
        p = {
          source: "fallback",
          tries: 0,
          valid: false,
          rawViolations: [],
          notes: "the planner is off on this rig (Edit rig)",
          assignments: f.assignments,
          newFamilies: f.newFamilies,
        };
      } else
        p = await plan(
          input,
          r.m,
          ctrl.signal,
          r.ask,
          r.past,
          r.mcp,
          this.plannerCompaction(run),
          r.usage,
        );
    } finally {
      this.planning = undefined;
    }
    // Paused or closed while planning: no epoch starts, and the owner's messages wait. The notes
    // the model already wrote are kept.
    if (ctrl.signal.aborted) {
      live.append({ source: "planner", kind: "status", text: "planning cancelled", run });
      this.plannerNotes(run, p.journal);
      return;
    }
    // Read only when the model's plan was valid and used: a planner that is off, a model that
    // could not be reached, or plans refused on both tries leave them waiting for the next plan.
    // The read names this round, whose rules and notes answer them.
    if (owner.length && p.source === "planner")
      this.o.service.messages.read(
        owner.map((m) => m.id),
        "planner",
        undefined,
        n,
      );
    // New directions, with the rules that named them before the run had them, and the old rules
    // in words converted to them (goal 066).
    const waiting = toDesign(input);
    for (const f of p.newFamilies)
      this.registry.addFamily(run, f.id, f.description, `planner:${p.source}`, [
        ...(waiting.find((d) => d.name === f.id)?.rules.map((r) => r.id) ?? []),
        ...(p.queue?.convert.filter((c) => c.family === f.id).map((c) => c.rule) ?? []),
      ]);
    // The hand-out: the model's answer applied to the queue, or the fixed rules. Every lane gets
    // an experiment for its next trial; none goes to two lanes.
    const given = new Set<string>();
    const handout: (Handout & { parent: "champion" | "lane_best" })[] = [];
    let skipped: string[] = [];
    let refs = new Map<string, string>();
    if (p.queue) {
      const r = this.coordinator.apply(run, p.queue);
      skipped = r.skipped;
      refs = r.refs;
      for (const h of r.handout) {
        handout.push(h);
        given.add(h.experiment);
      }
    }
    // Rules the model just added (from the owner's messages) or converted (from old rules in
    // words) apply from this hand-out on.
    const directives =
      p.queue?.rules.length || p.queue?.convert.length ? this.directives(run) : input.directives;
    if (lanes.some((l) => !handout.some((h) => h.lane === l)))
      this.coordinator.ensureMandates(run, directives);
    // The queue's target (goal 081): when up next would hold fewer than the target after the
    // hand-out, the lanes' distinct ideas go up next first, oldest first, as the planner's.
    const target = input.queueTarget ?? 0;
    const avoided = (x: Experiment) =>
      directives.some(
        (d) => d.body.kind === "avoid" && d.body.family && inFamily(x, d.body.family),
      );
    // The one count of ready ideas, which the teachers' brief and queue_low read too.
    const ready = () => this.o.service.queue.ready(run, directives, given).length;
    const waitingLanes = lanes.filter((l) => !handout.some((h) => h.lane === l)).length;
    // A target of 0 asks for no ideas: the lanes' ideas then wait, as before (goal 081).
    const ideas =
      target > 0
        ? this.coordinator.acceptIdeas(
            run,
            target + waitingLanes - ready(),
            avoided,
            `the queue had fewer than its target of ${target} experiments ready: a lane's distinct idea goes up next`,
          )
        : [];
    for (const lane of lanes) {
      if (handout.some((h) => h.lane === lane)) continue;
      const fixed = p.assignments.find((a) => a.lane === lane);
      let x = this.coordinator.pick(run, lane, { directives, window: laneCount, exclude: given });
      let why = x ? this.coordinator.whyPicked(run, lane, x, directives) : "";
      if (!x && fixed) {
        x = this.coordinator.fill(
          run,
          fixed,
          `the queue was empty: the fixed plan's direction for ${lane} (${fixed.family})`,
        );
        why = "the queue was empty, so the fixed plan added it";
      }
      if (!x) continue;
      given.add(x.id);
      handout.push({
        lane,
        experiment: x.id,
        parent: fixed?.parent ?? (input.laneBests[lane] ? "lane_best" : "champion"),
        why,
      });
    }
    const assignments: Assignment[] = handout.flatMap((h) => {
      const x = this.o.service.queue.get(h.experiment);
      if (!x) return [];
      return [
        {
          lane: h.lane,
          family: this.coordinator.direction(run, x, p.newFamilies),
          focus: x.title,
          parent: h.parent,
          experiment: x.id,
          why: h.why,
        },
      ];
    });
    live.append({
      source: "planner",
      kind: "text",
      text: [
        `round ${n}: ${p.source === "planner" ? `planned by the model${p.tries > 1 ? ` (try ${p.tries})` : ""}` : `taken from the queue by the fixed rules${p.notes ? ` (${p.notes})` : p.rawViolations.length ? " (the model gave no usable plan)" : p.tries === 0 ? " (no model)" : ""}`}`,
        ...assignments.map(
          (a) =>
            `${a.lane}: ${a.family}, ${a.focus}${a.parent === "lane_best" ? " (from the lane's best)" : ""}`,
        ),
        ...(p.newFamilies.length
          ? [
              `new directions: ${p.newFamilies.map((f) => `${asToken(f.id)} (${f.description})`).join("; ")}`,
            ]
          : []),
        ...(p.queue?.convert.length
          ? [
              `old rules in words converted: ${p.queue.convert.map((c) => `rule ${c.rule} to ${asToken(c.family)}`).join("; ")}`,
            ]
          : []),
        // Why the model's tries gave no usable plan, each by its real cause (goal 079).
        ...(p.causes?.length
          ? [
              `no usable plan: ${p.causes
                .map((c) => `try ${c.try}: ${causeWords[c.cause]} (${c.detail.slice(0, 200)})`)
                .join("; ")}`,
            ]
          : p.rawViolations.length
            ? [`refused: ${p.rawViolations.slice(0, 3).join("; ")}`]
            : []),
        ...(skipped.length ? [`skipped: ${skipped.slice(0, 3).join("; ")}`] : []),
        ...(ideas.length
          ? [
              `the lanes' ideas queued to reach the target of ${target}: ${ideas.map((x) => x.title).join("; ")}`,
            ]
          : []),
      ].join("\n"),
      run,
    });
    this.registry.startEpoch({
      run,
      n,
      source: p.source,
      tries: p.tries,
      valid: p.valid,
      rawViolations: p.rawViolations,
      causes: p.causes,
      assignments: attribute(assignments, directives),
      directives: directives.map((d) => d.id),
      notes: p.notes,
      by: this.o.owner,
    });
    this.coordinator.handout(
      run,
      n,
      handout,
      [
        p.source === "planner"
          ? (p.notes ?? "the planner's plan")
          : p.notes
            ? `${p.notes}: lanes took queued experiments in order`
            : p.rawViolations.length
              ? "the model gave no usable plan: lanes took queued experiments in order"
              : "lanes took queued experiments in order",
        ...(skipped.length ? [`skipped: ${skipped.join("; ")}`] : []),
      ].join(". "),
    );
    // Still below the target (goal 081): the planner could not top the queue up, so the teachers
    // are asked for ideas at once (the supervisor reads queue_low), not on their clock.
    const left = ready();
    if (target > 0 && left < target) {
      this.ledger.appendEvent(PLANNER, "queue_low", run, {
        round: n,
        ready: left,
        target,
        lanes: laneCount,
        source: p.source,
      });
      live.append({
        source: "planner",
        kind: "status",
        text: `after round ${n} the queue has ${left} of its target of ${target} experiments ready: the teachers are asked for ideas now`,
        run,
      });
    }
    // The planner's field notes, also when the rest of its answer was refused; a note about an
    // experiment it added names the experiment's id, not the ref it used.
    this.plannerNotes(
      run,
      p.journal?.map((j) =>
        j.about?.type === "experiment" && refs.has(j.about.id)
          ? { ...j, about: { type: "experiment", id: refs.get(j.about.id) as string } }
          : j,
      ),
    );
  }

  /** The planner's field notes, recorded as the planner's; a problem is a line in its live view. */
  private plannerNotes(run: string, notes: NoteInput[] | undefined): void {
    if (!notes?.length) return;
    const r = this.o.service.journal.writeAll(run, notes, {
      by: PLANNER,
      actor: PLANNER,
      source: "planner",
    });
    if (r.problems.length)
      this.o.service.live.append({
        source: "planner",
        kind: "status",
        text: `field notes: ${r.problems.join("; ")}`,
        run,
      });
  }

  /** Where a run's past research is, when its folder has some: one line for a brief. */
  private pastResearch(
    run: string,
    reader: "worker" | "research" | "files" | "tool",
  ): string | undefined {
    const s = this.o.service.knowledge.summary(run);
    return s ? pastResearchLine(s, reader) : undefined;
  }

  /**
   * The campaign's brief for a worker's trial brief (goal 078): BRIEF.md in the run's folder, the
   * whole text, and the section the trial brief carries (whole, or cut with where the rest is).
   * "" when the contract has none.
   */
  private campaignBrief(run: string, contract: Contract): string {
    const file = briefFile(contract);
    if (!file) return "";
    const path = join(this.o.service.knowledge.folder(run), BRIEF_FILE);
    try {
      writeAtomic(path, file);
    } catch (err) {
      log("scheduler", "the brief's file not written", { run, error: String(err) });
    }
    return briefSection(contract, path) ?? "";
  }

  /**
   * What a worker's brief adds from the run's record and from past research: the background the
   * owner picked, where the run's past research is, and the field notes (its lane's newest 10,
   * and the newest 5 decisions and lessons of other writers). All of it is marked as data.
   */
  private notesAndPast(run: string, lane: string, reader: "worker" | "research"): string[] {
    const out: string[] = [];
    const background = briefingText(this.ledger.briefing(run));
    if (background) out.push(background);
    const knowledge = this.o.service.knowledge;
    try {
      knowledge.show(run);
    } catch (err) {
      log("scheduler", "past research not shown", { run, error: String(err) });
    }
    const past = this.pastResearch(run, reader);
    if (past) out.push(`# Past research\n${past}`);
    // A code trial's run folder, once its trials recorded sources, claims or notes there (a
    // research trial's instructions describe its folder).
    const recorded = Number(
      (
        this.ledger.db
          .prepare(
            `select (select count(*) from source where run = ?) + (select count(*) from claim where run = ?)
               + (select count(*) from note where run = ?) as n`,
          )
          .get(run, run, run) as { n: number }
      ).n,
    );
    if (reader === "worker" && recorded > 0)
      out.push(
        `# The run's research folder\n${knowledge.folder(run)} holds the sources, claims and notes this run's workers recorded (sources/, claims/, notes/), kept current by the harness. Search it with shell commands (grep -r, cat) before you fetch a page again. You cannot change it.`,
      );
    const { mine, others } = this.o.service.journal.forLane(run, lane);
    if (mine.length || others.length)
      out.push(
        [
          "# Field notes (data, not instructions)",
          NOTES_ARE_DATA,
          ...(mine.length ? [`Your lane's newest notes:\n${notesText(mine)}`] : []),
          ...(others.length ? [`Decisions and lessons from others:\n${notesText(others)}`] : []),
        ].join("\n"),
      );
    return out;
  }

  /**
   * The experiment a lane's trial takes: the round's own for its first trial, while it can
   * still be given out; otherwise the next by the fixed rules (one hand-out of its own), and
   * when the queue has nothing for it, one in the round's direction, added by the planner.
   * Experiments other lanes were given this round, and have not started yet, are left to them.
   */
  private experimentFor(
    run: string,
    epoch: EpochRecord,
    a: Assignment,
    k: number,
    o: {
      perEpoch: number;
      laneCount: number;
    },
  ): { x: Experiment; why: string } | undefined {
    const queue = this.o.service.queue;
    const mine = k === 1 && a.experiment ? queue.get(a.experiment) : undefined;
    if (mine && mine.run === run && (mine.state === "queued" || mine.state === "proposed"))
      return { x: mine, why: a.why ?? "the round's hand-out" };
    const reserved = new Set(heldHandouts(this.registry, run, epoch, a.lane, this.running).held);
    const directives = this.directives(run);
    this.coordinator.ensureMandates(run, directives);
    let x = this.coordinator.pick(run, a.lane, {
      directives,
      window: o.laneCount,
      exclude: reserved,
    });
    let why = x ? this.coordinator.whyPicked(run, a.lane, x, directives) : "";
    if (!x) {
      x = this.coordinator.fill(
        run,
        a,
        `the queue had nothing for ${a.lane}: it goes on in its round's direction (${a.family})`,
      );
      why = "the queue had nothing for this lane, so it goes on in its round's direction";
    }
    if (!x) return undefined;
    this.coordinator.handout(
      run,
      epoch.n,
      [{ lane: a.lane, experiment: x.id, why }],
      k === 1
        ? `${a.lane}'s first trial of round ${epoch.n}: the experiment the round gave it can no longer be given out`
        : `${a.lane}'s trial ${k} of ${o.perEpoch} in round ${epoch.n}`,
    );
    return { x, why };
  }

  /** The model route now (none: agents wait). */
  private modelNow(): ModelConfig | undefined {
    const m = this.o.model;
    return typeof m === "function" ? m() : m;
  }

  /**
   * Stopping or draining (goal 079): no new plan or trial starts; those running end as they
   * would. Asked at the top of a step, again after a planner call, and before each trial.
   */
  private halted(): boolean {
    return this.stopping || this.o.draining?.() === true;
  }

  /** One scheduling step: plan when needed, start trials that may start. */
  async tick(): Promise<boolean> {
    this.applyStops();
    await this.applyResets();
    // Stopping or draining: no new plan or trial; those running end as they would.
    if (this.halted()) return false;
    this.finishClosedResearch();
    this.finishEndedResearch();
    const inst = this.run();
    if (!inst || !this.modelNow()) return false;
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
    if (this.agentsStopped(inst.id)) return false;
    if (this.waitingForLimit(inst.id)) return false;
    // The MCP servers the run's kit names, before its first plan or trial (goal 068).
    if (this.waitingForMcp(inst.id)) return false;
    if (inst.contract.mode === "research") return this.researchTick(inst.id, inst.contract);
    const { id, contract } = inst;
    if (contract.mode === "goal" && this.waitingForConfirmation(id)) return false;
    let epoch = this.registry.currentEpoch(id);
    // A hill climb's baseline (goal 115): no round is planned and no trial starts until the
    // judge has measured the starting point. When it can't, the run is in setup: its rounds are
    // setup rounds, one trial a lane, each working to make the starting point build and run.
    const base = contract.mode === "hill_climb" ? baselineState(this.ledger, id) : undefined;
    if (base?.state === "waiting") {
      this.noteBaseline(id, base, epoch && !epoch.ended_at ? epoch.n : (epoch?.n ?? 0) + 1);
      return false;
    }
    const setup = base?.state === "setup" ? base : undefined;
    if (base) this.noteBaseline(id, base, 0);
    if (base?.state === "measured") this.dropSetupExperiments(id);
    // A round of the other kind (a setup round once the starting point is measured, a round of
    // the plan while in setup) starts no new trial, and ends when its trials have.
    if (base && epoch && !epoch.ended_at && isSetupRound(epoch) !== !!setup) {
      if (!this.running.size) this.registry.endEpoch(id, epoch.n, this.o.owner);
      return false;
    }
    const perEpoch = setup ? 1 : contract.lanes.trials_per_epoch;
    if (!epoch || epoch.ended_at) {
      if (contract.mode === "goal" && this.awaitingGoalReport(id, (epoch?.n ?? 0) + 1))
        return false;
      if (setup) this.planSetupEpoch(id, contract, (epoch?.n ?? 0) + 1, setup);
      else {
        this.maybeForkRound(id, contract, (epoch?.n ?? 0) + 1);
        await this.planEpoch(id, contract, (epoch?.n ?? 0) + 1);
      }
      epoch = this.registry.currentEpoch(id);
      if (!epoch) return false;
      // A drain or a stop that began while the planner worked (goal 079): the round is
      // recorded, and no trial starts.
      if (this.halted()) return false;
    }
    this.updateLaneBests(
      id,
      epoch.assignments.map((a) => a.lane),
    );

    let started = false;
    const keep = keepsWorking(this.ledger, id, contract);
    for (const a of epoch.assignments) {
      const trials = this.registry.trials(id, a.lane, epoch.n);
      const last = trials.at(-1);
      if (trials.length >= perEpoch || this.running.has(a.lane)) continue;
      if (last?.ended === false || waitsForJudge(this.ledger, this.registry, id, a.lane, keep))
        continue;
      if (this.running.size >= this.o.maxConcurrent) continue;
      if (this.o.workersOn && !this.o.workersOn()) continue;
      if (this.openAttempts(id) >= contract.budget.max_open_attempts) continue;
      if (this.laneWaitMs(id, a.lane, false) > 0) continue;
      // Each trial asks again: no trial starts once the rig drains or stops.
      if (this.halted()) return started;
      const k = trials.length + 1;
      const got = this.experimentFor(id, epoch, a, k, {
        perEpoch,
        laneCount: epoch.assignments.length,
      });
      if (!got) continue;
      this.startTrial(id, contract, epoch.n, a, k, perEpoch, got);
      started = true;
    }
    // Not waiting for other lanes' trials (goal 136); no time cap unless one is given (tests).
    const capped =
      this.o.epochCapMs !== undefined &&
      Date.now() - Date.parse(epoch.started_at) > this.o.epochCapMs;
    const lanes = lanesInRound(this.ledger, this.registry, id, epoch, this.running, keep);
    if (roundOver(lanes, perEpoch) || (capped && !this.running.size))
      this.registry.endEpoch(id, epoch.n, this.o.owner);
    return started;
  }

  // ------------------------------------------------------------------ research mode

  /**
   * Research: the harness owns the clock. Lanes run trial after trial (no judge to wait for)
   * until the run ends (goals 112 and 117: the review panel's decisions give every item an end,
   * or the progress rule stops it) or max_duration; a digest every report_cadence.digest_minutes
   * and a final report come from the ledger.
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
    // The run ended: no new trial starts; it closes once those running end (finishEndedResearch).
    if (researchEnd(this.ledger, run)) return false;
    const last = research.lastReportAt(run);
    if (!last || Date.now() - Date.parse(last) >= contract.report_cadence.digest_minutes * 60_000) {
      // At a digest, after the minimum: the review panel is asked about the items with no
      // standing decision, when code finds them ready (research/review.ts); then the progress
      // rule is checked. A failure of either is logged; the digest and the research go on, and
      // the next digest tries again.
      try {
        this.askResearchReview(run, contract, clock);
      } catch (err) {
        log("scheduler", "the review panel was not asked", { run, error: String(err) });
      }
      try {
        if (this.checkProgress(run, contract)) {
          research.report(run, "digest");
          return false;
        }
      } catch (err) {
        log("scheduler", "the progress rule was not checked", { run, error: String(err) });
      }
      research.report(run, "digest");
    }
    // The campaign's starting links, archived by the harness, beside the first trials.
    if (!this.seeded.has(run)) {
      this.seeded.add(run);
      void this.archiveSeeds(run, contract);
    }
    let epoch = this.registry.currentEpoch(run);
    if (!epoch || epoch.ended_at) {
      await this.planResearchEpoch(run, contract, (epoch?.n ?? 0) + 1);
      epoch = this.registry.currentEpoch(run);
      // Planning was cancelled (the run paused or closed meanwhile): no round started. A drain
      // or a stop that began while the planner worked: the round is recorded, and no trial starts.
      if (!epoch || epoch.ended_at || this.halted()) return false;
    }
    let started = false;
    for (const a of epoch.assignments) {
      const trials = this.registry.trials(run, a.lane, epoch.n);
      if (trials.length >= contract.lanes.trials_per_epoch || this.running.has(a.lane)) continue;
      if (this.running.size >= this.o.maxConcurrent) continue;
      if (this.o.workersOn && !this.o.workersOn()) continue;
      if (this.laneWaitMs(run, a.lane, true) > 0) continue;
      if (this.halted()) return started;
      const got = this.researchTaskFor(run, contract, epoch, a, trials.length + 1);
      if (!got) continue;
      this.startResearchTrial(run, contract, epoch.n, a, clock, got);
      started = true;
    }
    const lanes = lanesInRound(this.ledger, this.registry, run, epoch, this.running, true);
    if (roundOver(lanes, contract.lanes.trials_per_epoch))
      this.registry.endEpoch(run, epoch.n, this.o.owner);
    return started;
  }

  /**
   * The progress rule (goal 117), at a digest after the minimum: where it stands is the event
   * `research_progress`; when it holds (every open question saturated, no improvement for a
   * quarter of the running time), no review waits, and some item is still open, the run ends with
   * its open items stated (`research_stopped`): no new trial starts, the final writer writes its
   * paper, and it closes with PROGRESS_STOPPED. True when it ended the run. No time cap: the rule
   * holds only once research stopped adding.
   */
  private checkProgress(run: string, contract: ResearchContract): boolean {
    const research = this.o.research as Research;
    const clock = research.clock(run);
    if (clock.elapsed_ms < clock.min_ms) return false;
    const n = contract.questions.length;
    const p = progressStopped(this.ledger, run, n, (at) => research.clock(run, at));
    const saturated = p.open.filter((q) => questionSaturated(this.ledger, run, q));
    const last = lastImprovement(this.ledger, run);
    const { open } = itemsState(this.ledger, run, n);
    // A review that waits may still improve an item; a run with every item at an end waits for
    // the review panel's pass, or the owner's word on it, never for this rule.
    const waiting = waitingReview(this.ledger, run);
    const ends = p.stopped && !waiting && (open.questions.length > 0 || open.hypotheses.length > 0);
    const figures = {
      open: p.open,
      saturated,
      last_improvement: last,
      since_ms: p.since_ms,
      needed_ms: p.needed_ms,
    };
    this.ledger.appendEvent(this.o.owner, RESEARCH_PROGRESS, run, { ...figures, stopped: ends });
    if (!ends) return false;
    const h = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
    const why = `every open question is saturated, and no item improved for ${h(p.since_ms)} (the rule needs ${h(p.needed_ms)}, a quarter of the running time)`;
    this.ledger.appendEvent(this.o.owner, RESEARCH_STOPPED, run, {
      reason: PROGRESS_STOPPED,
      ...figures,
      open: { questions: open.questions, hypotheses: open.hypotheses },
    });
    const items = [
      ...open.questions.map(questionName),
      ...(open.hypotheses.length
        ? [
            `${open.hypotheses.length} required ${open.hypotheses.length === 1 ? "hypothesis" : "hypotheses"} with no verdict`,
          ]
        : []),
    ];
    this.o.service.journal.writeAll(
      run,
      [
        {
          kind: "decision",
          text: `Research stopped adding: ${why}. The run ends with these items open: ${items.join(", ")}. It writes its paper and final report, and closes once its running trials end.`.slice(
            0,
            2000,
          ),
        },
      ],
      { by: "harness", actor: this.o.owner, source: "planner" },
    );
    this.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `research stopped adding (the progress rule): ${why}; open: ${items.join(", ")}`.slice(
        0,
        600,
      ),
      run,
    });
    return true;
  }

  /**
   * Asks the review panel about a research run's items (goals 112 and 117), when code finds it
   * due: after the minimum running time, every question with an answer card, the campaign's floor
   * of verified claims met, no review waiting, and some item with no standing decision.
   */
  private askResearchReview(
    run: string,
    contract: ResearchContract,
    clock: { elapsed_ms: number; min_ms: number },
  ): void {
    const due = researchReviewDue(this.ledger, run, contract, clock);
    if (!due.due) return;
    const id = new Reviews(this.ledger).requestResearch({
      run,
      marker: due.marker,
      pkg: researchPackage(this.ledger, run, contract),
      by: this.o.owner,
    });
    this.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `review ${id}: the review panel is asked to decide ${[
        due.questions.length ? questionsList(due.questions) : "",
        due.hypotheses.length
          ? `${due.hypotheses.length} required ${due.hypotheses.length === 1 ? "hypothesis" : "hypotheses"}`
          : "",
      ]
        .filter(Boolean)
        .join(" and ")}`,
      run,
    });
  }

  /**
   * A research run's starting links (goal 078), fetched and archived by the harness when the run
   * starts (and again after a restart, when an archived link is found at once), one after
   * another, beside the first trials. A link the fetcher refuses is an event with its reason
   * (fetch_refused) and a line in Live; the run goes on without it.
   */
  private async archiveSeeds(run: string, contract: ResearchContract): Promise<void> {
    if (!contract.seeds.length) return;
    const research = this.o.research as Research;
    let archived = 0;
    const refused: string[] = [];
    for (const url of contract.seeds) {
      try {
        const r = (await research.fetch(run, null, url)) as { refused?: string };
        if (r.refused) refused.push(`${url} (${r.refused})`);
        else archived++;
      } catch (err) {
        refused.push(`${url} (${errorText(err)})`);
      }
    }
    this.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `starting links: ${archived} of ${contract.seeds.length} archived${refused.length ? `; not archived: ${refused.join("; ").slice(0, 1000)}` : ""}`,
      run,
    });
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
   * A research round (goals 047 and 117): research tasks are the run's experiments, each about one
   * question and one evidence gap. With the planner on, the model plans the round from the answer
   * cards and their gaps (planResearch); code checks every task, and applies its queue changes and
   * the hypotheses it promotes or retires (through the owner's command's function). A lane the
   * model gives no task that can still be given out, and every lane when the planner is off or
   * gave no usable plan, gets its task by the gap-driven rules (nextResearchTask). One hand-out in
   * the planner's log.
   */
  private async planResearchEpoch(
    run: string,
    contract: ResearchContract,
    n: number,
  ): Promise<void> {
    for (const t of Scheduler.RESEARCH_TASKS)
      this.registry.addFamily(run, t.id, t.description, "research-plan");
    const directives = this.directives(run);
    const lanes = lanesOf(this.laneCount(run, contract));
    const state = researchState(this.ledger, run, contract, { lanes: lanes.length, epoch: n });
    const live = this.o.service.live;
    const research = this.o.research as Research;
    const plannerOn = !this.o.plannerOn || this.o.plannerOn();
    // The owner's messages to the planner and to everyone working, not read yet.
    const owner = plannerOn ? this.o.service.messages.waitingForPlanner(run) : [];
    let p: ResearchPlanResult | undefined;
    if (plannerOn) {
      live.append({
        source: "planner",
        kind: "status",
        text: `planning round ${n} (${lanes.length} lane${lanes.length === 1 ? "" : "s"}) from the answer cards`,
        run,
      });
      const input: ResearchPlannerInput = {
        run,
        epoch: n,
        laneCount: lanes.length,
        title: contract.title,
        topic: contract.topic,
        state,
        queue: this.o.service.queue.brief(run),
        hypotheses: plannerHypotheses(this.ledger, run),
        directives,
        ownerMessages: owner.map((m) => ({ id: m.id, text: messageText(m) })),
        campaignBrief: briefData(contract),
        notes: notesData(this.o.service.journal.newest(run, 20)),
        briefing: this.ledger.briefing(run),
      };
      const ctrl = new AbortController();
      this.planning = { run, ctrl };
      this.watch();
      try {
        const r = await this.plannerRoute(run, contract, n);
        input.pastResearch = r.pastLine;
        p = await planResearch(
          input,
          r.m,
          ctrl.signal,
          r.ask,
          r.past,
          r.mcp,
          this.plannerCompaction(run),
          r.usage,
        );
      } finally {
        this.planning = undefined;
      }
      // Paused or closed while planning: no round starts, and the owner's messages wait. The notes
      // the model already wrote are kept.
      if (ctrl.signal.aborted) {
        live.append({ source: "planner", kind: "status", text: "planning cancelled", run });
        this.plannerNotes(run, p.journal);
        return;
      }
    }
    const given = new Set<string>();
    const handout: Handout[] = [];
    const assignments: Assignment[] = [];
    const skipped: string[] = [];
    const changed: string[] = [];
    let refs = new Map<string, string>();
    const give = (lane: string, x: Experiment, why: string) => {
      given.add(x.id);
      handout.push({ lane, experiment: x.id, why });
      assignments.push({
        lane,
        family: x.family || "explore",
        focus: focusOf(x),
        parent: "champion",
        experiment: x.id,
        why,
      });
    };
    const plan = p?.plan;
    if (plan) {
      const r = this.coordinator.apply(run, plan.queue);
      skipped.push(...r.skipped);
      refs = r.refs;
      // The hypotheses it promoted or retired, through the function the owner's command uses: a
      // change the records no longer allow (the owner changed it meanwhile) is skipped and said.
      for (const [list, status] of [
        [plan.promote, "promoted"],
        [plan.retire, "retired"],
      ] as const)
        for (const x of list)
          try {
            const done = research.hypothesisStatus(
              run,
              { id: x.id, status, reason: x.why },
              PLANNER,
            );
            if (done.changed) changed.push(`${status} ${x.id}`);
          } catch (err) {
            if (!(err instanceof LedgerError)) throw err;
            skipped.push(`${status === "promoted" ? "promote" : "retire"} ${x.id}: ${err.message}`);
          }
      // Read only when the model's plan was used; the read names this round.
      if (owner.length)
        this.o.service.messages.read(
          owner.map((m) => m.id),
          "planner",
          undefined,
          n,
        );
      for (const h of r.handout) {
        const x = this.o.service.queue.get(h.experiment);
        if (!x) continue;
        if (typeof x.question === "number") took(state, x.question);
        give(h.lane, x, h.why);
      }
    }
    // Each lane with no task yet: the gap-driven rules.
    let stalled = false;
    for (const lane of lanes) {
      if (handout.some((h) => h.lane === lane)) continue;
      const got = this.nextResearchTask(run, contract, n, lane, state, given, directives);
      if (!got) continue;
      stalled ||= got.stalled;
      give(lane, got.x, got.why);
    }
    const where = state.questions.map(stateWords).join("; ");
    const deeper = stalled ? "; novelty fell, so primary sources and contradictions first" : "";
    const notes = plan
      ? (plan.notes ?? "the planner's research plan, from the answer cards")
      : plannerOn
        ? `the gap-driven plan${deeper}: ${where}`
        : `research plan, gap-driven${deeper}: ${where}`;
    const why = p?.causes?.length
      ? p.causes
          .map((c) => `try ${c.try}: ${causeWords[c.cause]} (${c.detail.slice(0, 200)})`)
          .join("; ")
      : "";
    live.append({
      source: "planner",
      kind: "text",
      text: [
        `round ${n}: ${
          plan
            ? `planned by the model${(p?.tries ?? 1) > 1 ? ` (try ${p?.tries})` : ""}`
            : plannerOn
              ? "set by the gap-driven plan (the model gave no usable plan)"
              : "set by the gap-driven plan (the planner is off on this rig (Edit rig))"
        }`,
        ...assignments.map((a) => {
          const x = this.o.service.queue.get(a.experiment ?? "");
          return `${a.lane}: ${a.family}, ${x?.title ?? a.focus}`;
        }),
        ...(changed.length ? [`hypotheses: ${changed.join("; ")}`] : []),
        ...(why ? [`no usable plan: ${why}`] : []),
        ...(skipped.length ? [`skipped: ${skipped.slice(0, 3).join("; ")}`] : []),
      ].join("\n"),
      run,
    });
    this.registry.startEpoch({
      run,
      n,
      source: plan ? "planner" : "fallback",
      tries: p?.tries ?? 0,
      valid: plan !== undefined,
      rawViolations: p?.rawViolations ?? [],
      causes: p?.causes,
      assignments: attribute(assignments, directives),
      directives: directives.map((d) => d.id),
      notes,
      // The code plan by choice (the planner is off): a research round, not a fallback.
      ...(plannerOn ? {} : { plan: "research" as const }),
      by: this.o.owner,
    });
    this.coordinator.handout(
      run,
      n,
      handout,
      [
        plan
          ? (plan.notes ?? "the planner's research plan, from the answer cards")
          : `${plannerOn ? "the model gave no usable plan: " : "research plan, "}gap-driven: each lane takes the owner's tasks first, else the question its gaps weigh for (its queued task, or a new one)`,
        ...(changed.length ? [`hypotheses: ${changed.join("; ")}`] : []),
        ...(skipped.length ? [`skipped: ${skipped.join("; ")}`] : []),
      ].join(". "),
    );
    // The planner's field notes, also when the rest of its answer was refused; a note about a task
    // it added names the task's id, not the ref it used.
    this.plannerNotes(
      run,
      p?.journal?.map((j) =>
        j.about?.type === "experiment" && refs.has(j.about.id)
          ? { ...j, about: { type: "experiment", id: refs.get(j.about.id) as string } }
          : j,
      ),
    );
  }

  /** The questions a TRY or MANDATE rule with a question's index puts first. */
  private firstQuestions(directives: Directive[], contract: ResearchContract): number[] {
    return directives
      .filter(
        (d) =>
          (d.body.kind === "mandate" || d.body.kind === "try") &&
          typeof d.body.value === "number" &&
          Number.isInteger(d.body.value) &&
          d.body.value >= 0 &&
          d.body.value < contract.questions.length,
      )
      .map((d) => Number(d.body.value));
  }

  /**
   * A lane's next research task by the gap-driven rules (goal 117). First the owner's queued tasks,
   * in queue order, as before (AVOID task kinds skipped, MANDATE and TRY kinds first), any other
   * that names no question, else one for a hypothesis with no evidence (hypothesisTask). Then the
   * question the gaps weigh for (nextQuestion: the floor, then the weighted shares under the
   * ceiling; never a question decided or saturated, unless every open one is): the first task
   * queued for it, whoever added it (a teacher's, a lane's idea once queued, the plan's), else a
   * new task of the gap-driven plan for it. Each task given counts in `state`.
   */
  private nextResearchTask(
    run: string,
    contract: ResearchContract,
    n: number,
    lane: string,
    state: ResearchState,
    exclude: ReadonlySet<string>,
    directives: Directive[],
  ): { x: Experiment; why: string; stalled: boolean } | undefined {
    const queued = this.o.service.queue.queued(run);
    const only = (keep: (x: Experiment) => boolean) =>
      this.coordinator.pick(run, lane, {
        directives,
        window: 1,
        exclude: new Set([...exclude, ...queued.filter((x) => !keep(x)).map((x) => x.id)]),
      });
    const unbalanced = only((x) => x.added_by === "owner" || typeof x.question !== "number");
    const queue = this.o.service.queue;
    const lead = unbalanced ?? hypothesisTask(this.ledger, queue, run, contract.questions, PLANNER);
    if (lead) {
      if (typeof lead.question === "number") took(state, lead.question);
      const why = unbalanced ? this.coordinator.whyPicked(run, lane, lead, directives) : lead.why;
      return { x: lead, why, stalled: false };
    }
    const next = nextQuestion(state, this.firstQuestions(directives, contract));
    if (!next) return undefined;
    const q = next.question.index;
    const waiting = only((x) => x.question === q);
    if (waiting) {
      took(state, q);
      return {
        x: waiting,
        why: `the gap-driven plan: ${next.why}; this task was queued for it`,
        stalled: false,
      };
    }
    const added = this.fillResearch(
      run,
      contract,
      n,
      next.question,
      `the gap-driven plan: ${next.why}`,
      directives,
    );
    took(state, q);
    return { x: added.x, why: added.x.why, stalled: added.stalled };
  }

  /**
   * The task a lane's research trial takes (goal 117): the round's own for its first trial, while
   * it can still be given out; otherwise the next by the gap-driven rules (one hand-out of its
   * own). Tasks other lanes were given this round, and have not started yet, are left to them.
   */
  private researchTaskFor(
    run: string,
    contract: ResearchContract,
    epoch: EpochRecord,
    a: Assignment,
    k: number,
  ): { x: Experiment; why: string } | undefined {
    const queue = this.o.service.queue;
    const mine = k === 1 && a.experiment ? queue.get(a.experiment) : undefined;
    if (mine && mine.run === run && (mine.state === "queued" || mine.state === "proposed"))
      return { x: mine, why: a.why ?? "the round's hand-out" };
    // A busy lane's hand-out stays its own, but its question is not taken by it (goal 136).
    const { held, counted } = heldHandouts(this.registry, run, epoch, a.lane, this.running);
    const state = researchState(this.ledger, run, contract, {
      lanes: this.laneCount(run, contract),
      epoch: epoch.n,
      reserved: counted,
    });
    const got = this.nextResearchTask(
      run,
      contract,
      epoch.n,
      a.lane,
      state,
      new Set(held),
      this.directives(run),
    );
    if (!got) return undefined;
    this.coordinator.handout(
      run,
      epoch.n,
      [{ lane: a.lane, experiment: got.x.id, why: got.why }],
      k === 1
        ? `${a.lane}'s first trial of round ${epoch.n}: the task the round gave it can no longer be given out`
        : `${a.lane}'s trial ${k} of ${contract.lanes.trials_per_epoch} in round ${epoch.n}`,
    );
    return { x: got.x, why: got.why };
  }

  /**
   * Whether a research run's novelty fell: past its first hour, an hour with no new source and no
   * newly verified claim. Then the plan's tasks go deeper instead of wider.
   */
  private noveltyFell(run: string): boolean {
    const research = this.o.research as Research;
    if (research.clock(run).elapsed_ms <= 3_600_000) return false;
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const n = (sql: string) =>
      Number((this.ledger.db.prepare(sql).get(run, hourAgo) as { n: number }).n);
    return (
      n("select count(*) as n from source where run = ? and fetched_at > ?") === 0 &&
      n("select count(*) as n from claim where run = ? and verified = 1 and created_at > ?") === 0
    );
  }

  /**
   * A new task of the gap-driven plan for one question (goal 117): its title names the question,
   * its details the gap it closes (nextGap: the first of its card's open evidence gaps that no
   * task waiting for it names), and its task kind comes in turn. When novelty fell, primary
   * sources and contradictions come first. Directives steer it by structure only: MANDATE and TRY
   * name task kinds to put first, AVOID removes a task kind. Directive text never reaches a
   * worker's brief.
   */
  private fillResearch(
    run: string,
    contract: ResearchContract,
    n: number,
    q: QuestionState,
    why: string,
    directives: Directive[] = this.directives(run),
  ): { x: Experiment; stalled: boolean } {
    const question = q.index;
    const avoid = new Set(
      directives.filter((d) => d.body.kind === "avoid" && d.body.family).map((d) => d.body.family),
    );
    const rank = (id: string) =>
      directives.some((d) => d.body.kind === "mandate" && d.body.family === id)
        ? 0
        : directives.some((d) => d.body.kind === "try" && d.body.family === id)
          ? 1
          : 2;
    const stalled = this.noveltyFell(run);
    const deep = (id: string) => Number(!["primary", "contradict"].includes(id));
    const all = Scheduler.RESEARCH_TASKS;
    const rotated = stalled
      ? [...all].sort((x, y) => deep(x.id) - deep(y.id))
      : all.map((_, k) => all[(n + k - 1) % all.length] as { id: string; description: string });
    const kinds = rotated
      .filter((t) => !avoid.has(t.id))
      .map((t, k) => ({ t, k }))
      .sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.k - b.k)
      .map((x) => x.t);
    if (!kinds.length) kinds.push(rotated[0] as { id: string; description: string });
    const queue = this.o.service.queue;
    const waiting = [...queue.queued(run), ...queue.assigned(run)];
    // Task kinds go on in turn after the plan's own waiting tasks.
    const own = waiting.filter((x) => x.added_by === PLANNER).length;
    const kind = kinds[own % kinds.length] as { id: string; description: string };
    const gap = nextGap(
      q,
      waiting.filter((x) => x.question === question).flatMap((x) => gapOf(x.details) ?? []),
    );
    const x = queue.add(
      run,
      {
        title: `${questionLabel(question)}: ${kind.description}`,
        details: taskDetails(question, contract.questions[question] ?? "", gap),
        family: kind.id,
        question,
        why: (stalled
          ? `${why}; novelty fell, so primary sources and contradictions first`
          : why
        ).slice(0, 2000),
        by: PLANNER,
      },
      PLANNER,
    );
    return { x, stalled };
  }

  private startResearchTrial(
    run: string,
    contract: ResearchContract,
    epoch: number,
    round: Assignment,
    clock: { elapsed_ms: number; min_ms: number; max_ms: number | null },
    got: { x: Experiment; why: string },
  ): void {
    // A research task from the queue: its task kind is the trial's family, its text the focus.
    const a: Assignment = {
      ...round,
      family: got.x.family || "explore",
      focus: [focusOf(got.x), got.x.why ? `Why: ${got.x.why}` : ""].filter(Boolean).join("\n"),
      experiment: got.x.id,
      why: got.why,
    };
    const research = this.o.research as Research;
    const id = `t-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const stats = research.stats(run);
    const frontier = research.frontier(run, 30);
    const brief = [
      `# Research assignment (epoch ${epoch}, ${a.lane})`,
      `Campaign: ${contract.title}`,
      `Topic: ${contract.topic}`,
      // Numbered from 1 for reading, with the index from 0 that a claim's, a hypothesis's or a
      // task's `question` field takes (goal 117).
      "Questions (a claim's or a hypothesis's `question` is the index):",
      ...contract.questions.map(
        (q, i) =>
          `${questionLabel(i)}: ${q.replace(/\n/g, "\n   ")} (${stats.questions[i]?.verified ?? 0} verified claims so far)`,
      ),
      "",
      // Each question's answer card (goal 117): its answer, certainty and open evidence gaps.
      briefCards(this.ledger, run, contract),
      "",
      // The campaign's brief from its author (goal 078): whole, or cut with where the rest is.
      this.campaignBrief(run, contract),
      "",
      `Your focus: ${a.focus}`,
      `Time: ${(clock.elapsed_ms / 3_600_000).toFixed(2)} h elapsed of at least ${(clock.min_ms / 3_600_000).toFixed(2)} h (the campaign continues after your trial).`,
      `Corpus: ${stats.sources} sources, ${stats.verified} verified claims, ${stats.drafts} drafts, ${stats.findings} findings.`,
      frontier.length ? `Links from archived sources not fetched yet: ${frontier.join(" ")}` : "",
      "",
      "Record claims only with exact quotes from archived sources, and give the question each answers by its index, in `question`.",
      // The hypotheses: which need a verdict, and the pool (goal 117).
      `\n${research.hypothesesBrief(run)}`,
      // What the newest failed review found missing (goal 112), until a newer review is decided.
      ...[briefGaps(this.ledger, run)].filter((s) => s !== undefined).map((s) => `\n${s}`),
      ...this.notesAndPast(run, a.lane, "research").map((s) => `\n${s}`),
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
      focus: a.focus,
    });
    this.o.service.queue.assign(
      run,
      got.x.id,
      { lane: a.lane, trial: id, by: PLANNER, why: got.why },
      PLANNER,
    );
    this.trialLine(
      id,
      run,
      a.lane,
      "status",
      `research trial on ${a.lane}: ${a.family}, ${got.x.title}`,
    );
    const fullBrief = this.withOwnerMessages(id, run, a.lane, brief);
    const limits = limitsInForce(this.ledger, run, contract);
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
            wallMs: limits.trialMinutes ? limits.trialMinutes * 60_000 : this.o.trialWallMs,
            maxTurns: this.o.maxTurns,
            limits,
            mcpServers: this.o.service.mcp.given(run, "workers").map((g) => g.name),
          },
          abort.signal,
        );
      } catch (err) {
        r = { ...r, error: errorText(err) };
      } finally {
        if (abort.signal.aborted) r = { ...r, stopped: "interrupted" };
        r = this.withProgress(id, r);
        this.o.service.trialEnded(id, r.turns > 0 || r.tokensIn > 0);
        this.registry.finishTrial(id, r, this.o.owner);
        // What the task's trial added, kept with the task (goal 117).
        this.finishExperiment(id, r, undefined, this.taskYield(run, id));
        this.afterTrial(id, run, r);
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
    round: Assignment,
    k: number,
    perEpoch: number,
    got: { x: Experiment; why: string },
  ): void {
    // The trial works on its experiment: its direction and its text are the trial's.
    const a: Assignment = {
      ...round,
      family: this.coordinator.direction(run, got.x),
      focus: focusOf(got.x),
      experiment: got.x.id,
      why: got.why,
    };
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
        focus: a.focus,
      });
      // The experiment is the trial's now: no other lane can be given it.
      this.o.service.queue.assign(
        run,
        got.x.id,
        { lane: a.lane, trial: id, by: PLANNER, why: got.why },
        PLANNER,
      );
      this.trialLine(
        id,
        run,
        a.lane,
        "status",
        `trial on ${a.lane}: ${a.family}, ${got.x.title} (from ${parent === champion.commit_sha ? `the champion, seq ${champion.seq}` : `the lane's best, ${best}`})`,
      );
      const limits = limitsInForce(this.ledger, run, contract);
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
            brief: promptText(
              this.withOwnerSections(
                id,
                run,
                a.lane,
                this.brief(
                  run,
                  contract,
                  epoch,
                  a,
                  got.x,
                  k,
                  perEpoch,
                  parent === champion.commit_sha
                    ? `the champion (seq ${champion.seq})`
                    : `your lane's best attempt ${best}`,
                ),
              ),
            ),
            wallMs: limits.trialMinutes ? limits.trialMinutes * 60_000 : this.o.trialWallMs,
            maxTurns: this.o.maxTurns,
            limits,
            // The MCP servers the run's kit gives its workers (goal 068).
            mcpServers: this.o.service.mcp.given(run, "workers").map((g) => g.name),
          },
          abort.signal,
        );
      } catch (err) {
        r = { ...r, stopped: "error", error: errorText(err) };
      } finally {
        if (abort.signal.aborted && r.stopped !== "submitted") r = { ...r, stopped: "interrupted" };
        r = this.withProgress(id, r);
        this.o.service.trialEnded(id, r.turns > 0 || r.tokensIn > 0);
        if (r.submitted) this.registry.tagAttempt(r.submitted.attempt, a.family);
        // The trial ends first (its token stops working), then its processes and dev runs.
        this.o.service.trialWorkspaces.delete(id);
        this.registry.finishTrial(id, { ...r, attempt: r.submitted?.attempt }, this.o.owner);
        // Its attempt is the one linked to the trial as it submitted, also when its worker was
        // stopped before it could say so (goal 079): an interrupted Pi trial that submitted has
        // its attempt with the judge, and its experiment is done, not back in the queue.
        const attempt = r.submitted?.attempt ?? this.registry.attemptOf(id);
        this.finishExperiment(id, r, attempt);
        this.afterTrial(id, run, r);
        this.trialLine(
          id,
          run,
          a.lane,
          "status",
          `trial ended: ${attempt ? `submitted ${attempt}${r.submitted ? "" : ` (then ${r.stopped})`}` : r.stopped}${r.error ? ` (${r.error.slice(0, 200)})` : ""}`,
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

  /** What a research trial added (goal 117); undefined when it cannot be read (logged). */
  private taskYield(run: string, trial: string): TaskYield | undefined {
    try {
      return (this.o.research as Research).trialYield(run, trial);
    } catch (err) {
      log("scheduler", "the research trial's yield was not read", { trial, error: String(err) });
      return undefined;
    }
  }

  /**
   * A trial ended: its experiment is done, with how its trial ended in words, or goes back to the
   * top of the queue when the trial never really tried it (interrupted, or the provider's error:
   * goal 079). Only an error that came from a call to the provider counts as the provider's: its
   * kind (`errorKind`) is set where the call was made, never read from a local failure's words. A
   * failure here is logged; the trial's own record stands.
   */
  private finishExperiment(
    trial: string,
    r: TrialResult,
    attempt?: string | undefined,
    taskYield?: TaskYield | undefined,
  ): void {
    try {
      this.coordinator.finish(
        trial,
        {
          result: resultOf(r.stopped, attempt),
          attempt,
          cause: r.error ?? (r.stopped === "interrupted" ? "its trial was stopped" : undefined),
          kind: r.errorKind,
          // Its calls failed until the run's agents stopped: it never really tried it either.
          agentsStopped: r.stopped === "error" && !!r.failing && failedTooLong(r.failing.since),
          yield: taskYield,
        },
        this.o.owner,
      );
    } catch (err) {
      log("scheduler", "the trial's experiment was not finished", { trial, error: String(err) });
    }
  }

  /**
   * What a trial's provider error means for the run (goal 079): no credits, a refused key or an
   * unserved model stop the run's agents; so do model calls that failed with the provider's
   * passing faults or the model's own errors, with no call that worked, for 30 minutes; a rate
   * limit with a time makes them wait until then. Only the kind the provider's call set counts
   * (`errorKind`): a local failure (a workspace that could not be set up, a worker process that
   * gave no result, a program that exited) never stops the agents, whatever its words.
   */
  private afterTrial(id: string, run: string, r: TrialResult): void {
    if (this.stopOnLongFailure(id, run, r)) return;
    if (r.stopped !== "error" || !r.error) return;
    const kind = r.errorKind;
    if (stopsAgents(kind)) {
      this.stopAgents(run, { kind: kind as ProviderErrorKind, words: r.error, by: `trial ${id}` });
      return;
    }
    const until =
      r.retryAfter ?? (kind === "rate_limit" ? classifyProviderError(r.error).retryAt : undefined);
    if (until)
      this.ledger.appendEvent(this.o.owner, "agents_wait_for_limit", run, {
        until,
        trial: id,
        reason: r.error,
      });
  }

  /**
   * The run's model calls have failed with the provider's passing faults or the model's own
   * errors, with no call that worked, for 30 minutes (goal 079): within one trial, or over trials
   * that each ended at their own time limit while their calls failed. The run's agents stop as
   * for no credits, with the newest failure's words. Pacing, so that the owner sees a failure
   * that never clears; the model is checked again as for any stop. A trial whose calls worked at
   * its end clears the run's count. True when the agents stopped.
   */
  private stopOnLongFailure(id: string, run: string, r: TrialResult): boolean {
    const f = r.failing;
    if (!f) {
      if (r.submitted || r.tokensIn > 0 || r.tokensOut > 0) this.failingSince.delete(run);
      return false;
    }
    const since = Math.min(
      this.failingSince.get(run) ?? Number.POSITIVE_INFINITY,
      Date.parse(f.since),
    );
    if (!failedTooLong(since)) {
      this.failingSince.set(run, since);
      return false;
    }
    this.failingSince.delete(run);
    this.stopAgents(run, {
      kind: f.kind,
      words: f.words,
      by: `trial ${id}`,
      said: `${FAILING_SAID} (${KIND_WORDS[f.kind]})`,
    });
    return true;
  }

  /**
   * A trial's result with the counters its worker last reported, when the worker died before
   * reporting its own (an interrupt kills it): an interrupted trial keeps the work it did.
   */
  private withProgress(id: string, r: TrialResult): TrialResult {
    const p = this.o.service.trialProgress.get(id);
    this.o.service.trialProgress.delete(id);
    if (!p || r.turns >= p.turns) return r;
    return {
      ...r,
      turns: p.turns,
      toolCalls: Math.max(r.toolCalls, p.tool_calls),
      tokensIn: Math.max(r.tokensIn, p.tokens_in),
      tokensOut: Math.max(r.tokensOut, p.tokens_out),
    };
  }

  /**
   * Where a planner call's compactions go in Pi (goal 070): the run's research folder keeps each
   * conversation, numbered within the call, and each is recorded as a worker's is.
   */
  private plannerCompaction(run: string): PlannerCompaction | undefined {
    const store = this.o.service.compactions;
    if (!store) return undefined;
    const of = {
      run,
      lane: "planner",
      trial: null,
      who: `planner-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      source: "planner",
    };
    let n = 0;
    return {
      keep: (_n, markdown) => store.keep(of, ++n, markdown),
      done: (r) =>
        store.record(of, {
          number: n,
          tokensBefore: r.tokensBefore,
          tokensAfter: r.tokensAfter,
          how: r.how,
          harness: "pi",
          summary: r.summary,
          error: r.error,
          kept: r.path !== undefined,
        }),
    };
  }

  /**
   * Where a planner call through OpenCode, Claude Code or Codex keeps its conversation before each
   * of that program's own compactions (goal 070): one place for each call (a plan may take two),
   * in the run's research folder, named as a Pi call's are. The planner is not told it may read
   * the file: its summary names it, for the owner.
   */
  private cliPlannerCompaction(
    run: string,
    harness: "opencode" | "claude-code" | "codex",
  ): (() => OnceKeeping) | undefined {
    const store = this.o.service.compactions;
    if (!store) return undefined;
    return () => {
      const of = {
        run,
        lane: "planner",
        trial: null,
        who: `planner-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        source: "planner",
      };
      return {
        keptAt: store.keptAt(of, false),
        title: "The planner",
        compacted: (c) => store.fromHarness(of, harness, c),
      };
    };
  }

  /** A line in a trial's live session (control's live view). */
  private trialLine(id: string, run: string, lane: string, kind: LiveKind, text: string): void {
    this.o.service.live.append({ source: `trial:${id}`, kind, text, lane, run });
  }

  /**
   * The brief with the owner's messages for this trial: those kept in force (to everyone working
   * or to this lane) in every new trial's brief until the owner removes them, then those its lane
   * has not read yet. Both are read by this trial once its agent is at work (code and research
   * trials alike).
   */
  private withOwnerMessages(id: string, run: string, lane: string, brief: string): string {
    return promptText(
      this.withOwnerSections(id, run, lane, {
        role: "brief",
        sections: [{ id: "brief", source: "role", text: brief }],
      }),
    );
  }

  /** The same, for a brief in sections (goal 166): the owner's messages as sections of their own. */
  private withOwnerSections(id: string, run: string, lane: string, brief: Prompt): Prompt {
    const inbox = this.o.service.messages;
    const kept = inbox.inForce(run, lane);
    const waiting = inbox
      .waitingForTrial({ id, run, lane })
      .filter((m) => !kept.some((k) => k.id === m.id));
    if (!kept.length && !waiting.length) return brief;
    // Read when the trial's agent is at work, not now: a trial that fails first leaves them.
    this.o.service.briefed(
      { id, run, lane },
      [...kept, ...waiting].map((m) => m.id),
    );
    return {
      ...brief,
      sections: [
        ...brief.sections,
        ...ownerMessageSections(kept.map(messageText), waiting.map(messageText)),
      ],
    };
  }

  /** The worker's brief (goal 166): gathered only from the ledger and this lane's own history. */
  private brief(
    run: string,
    contract: Contract,
    epoch: number,
    a: Assignment,
    x: Experiment,
    k: number,
    perEpoch: number,
    start: string,
  ): Prompt {
    const fam = this.registry.families(run).find((f) => f.id === a.family);
    const attempts = this.registry.evidence(run, 3, a.lane).map((e) => {
      const v = e.verdict ? this.ledger.currentVerdict(e.attempt) : undefined;
      // Its start and its end, where a crash's error usually is.
      const reasons = v
        ? clipReason(
            String(
              (
                this.ledger.db.prepare("select reasons from verdict where id = ?").get(v.id) as
                  | { reasons: string }
                  | undefined
              )?.reasons ?? "",
            ),
            BRIEF_REASON_CHARS,
          )
        : "";
      const violations = violationsOf(this.ledger.getAttempt(e.attempt)?.v0);
      return {
        attempt: e.attempt,
        hypothesis: e.hypothesis ?? null,
        outcome: e.verdict ?? e.lifecycle,
        delta: e.delta,
        reasons,
        violations: violations.length ? violationsText(violations) : "",
      };
    });
    const report =
      contract.mode === "goal"
        ? this.goalReport(run, this.ledger.currentChampion(run).seq)
        : undefined;
    // A setup trial (goal 115): why the judge could not measure the starting point.
    const base = a.family === SETUP_FAMILY ? baselineState(this.ledger, run) : undefined;
    const setup = base?.state === "setup" ? base : undefined;
    return renderWorkerBrief({
      epoch,
      trial: k,
      trials: perEpoch,
      lane: a.lane,
      title: contract.title,
      mode: contract.mode,
      objective: objectiveOf(contract),
      editablePaths: "editable_paths" in contract ? contract.editable_paths : undefined,
      forbiddenPatterns: "forbidden_patterns" in contract ? contract.forbidden_patterns : [],
      start,
      models: contract.models.map((m) => ({
        name: m.name,
        path: join(this.o.service.paths.stateDir, "models", m.sha256),
      })),
      direction: { id: a.family, description: fam?.description },
      experiment: {
        title: x.title,
        ...(x.details ? { details: x.details } : {}),
        ...(x.why ? { why: x.why } : {}),
        addedBy: x.added_by,
      },
      setup: setup
        ? {
            seq: setup.start.seq,
            commit: setup.start.commit.slice(0, 12),
            reasons: clipReason(setup.failure.reasons, SETUP_REASON_CHARS),
          }
        : undefined,
      goalReport: report
        ? {
            championSeq: report.champion_seq,
            notConfirmed: report.not_confirmed,
            goals: report.goals.map((g) => ({
              goal: g.goal,
              status: g.status,
              reasons: clipReason(g.reasons, BRIEF_GOAL_CHARS),
            })),
          }
        : undefined,
      attempts,
      campaignBrief: this.campaignBrief(run, contract),
      notesAndPast: this.notesAndPast(run, a.lane, "worker"),
    });
  }
}

/**
 * A setup round (goal 115): every lane's assignment is the setup direction, given out as setup
 * (planSetupEpoch), not a direction a planner chose.
 */
function isSetupRound(e: EpochRecord): boolean {
  return (
    e.assignments.length > 0 &&
    e.assignments.every((a) => a.family === SETUP_FAMILY && a.why === "setup")
  );
}

/** Question indexes in words for people: "question 2", "questions 2, 5". */
function questionsList(xs: number[]): string {
  return `${xs.length === 1 ? "question" : "questions"} ${xs.map((i) => i + 1).join(", ")}`;
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
