import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../common/env.ts";
import type { McpConnect } from "../common/mcp-client.ts";
import { type BriefData, briefData } from "../core/brief.ts";
import { sha256Hex } from "../core/canonical.ts";
import {
  type AskOwner,
  CommandPayloads,
  type Envelope,
  ExperimentId,
  ExperimentText,
  type ImportSpec,
  type KeyPairPem,
  QueuePosition,
  reportBody,
  StructuredDirective,
  signJson,
  verifyCommand,
} from "../core/commands.ts";
import { type Contract, contractSha, parseContract } from "../core/contract.ts";
import { isLegacyRule, researchDirectionRefusal } from "../core/directions.ts";
import type { Hardware } from "../core/hardware.ts";
import { type LiveKind, LiveLog, liveBody } from "../core/live.ts";
import { canonicalUses, type McpUse, McpUses, sameUses, usesWords } from "../core/mcp.ts";
import { ideaWords, queueTarget, ruleRefusal } from "../core/queue-target.ts";
import { labelledQuestion, measurementIn, measurementRefusal } from "../core/research-check.ts";
import { type BuildInfo, buildInfo } from "../core/version.ts";
import { handedOut, rulesInForce } from "./agents/coordinator.ts";
import { CHATGPT_LIMIT_WAIT_MS, type ModelConfig } from "./agents/model.ts";
import type { RigCheckReport } from "./agents/model-check.ts";
import type { ControlRoute, ModelInfo, ModelSource } from "./agents/model-source.ts";
import { logStall, modelStallMs, stalledFor, stallWords } from "./agents/model-stall.ts";
import { KIND_WORDS, type ProviderErrorKind } from "./agents/provider-errors.ts";
import { Registry } from "./agents/registry.ts";
import { type AuditDecision, type AuditPackage, Audits } from "./audits.ts";
import type { Compactions } from "./compactions.ts";
import { Conclusions } from "./conclusions.ts";
import {
  listChampionFiles,
  oneAttempt,
  readAttemptDiff,
  readChampionFile,
  recentAttempts,
  triedCauses,
} from "./evidence.ts";
import {
  createAttemptCommit,
  folderCommit,
  GitError,
  hasCommit,
  initMirror,
  patchBetween,
  showFile,
  updateRef,
} from "./git.ts";
import { goalChecks } from "./goal-checks.ts";
import { importBundle, importFile } from "./imports.ts";
import { Journal, NOTES_ARE_DATA, notesData } from "./journal.ts";
import { BASELINE_PRIORITY, baselineState } from "./judge/baseline.ts";
import { heldOutWords } from "./judge/held-out.ts";
import { type Kit, KitSchema, kitProblems } from "./kit.ts";
import { briefingData, Knowledge, pastResearchLine } from "./knowledge.ts";
import { type Ledger, LedgerError } from "./ledger.ts";
import { type McpCaller, McpGateway } from "./mcp-gateway.ts";
import { type AdvisorRole, messageText, OwnerMessages } from "./messages.ts";
import type { ProviderErrorAnswer } from "./model-forward.ts";
import { writeExport } from "./outbox.ts";
import { receivePropagation } from "./propagation.ts";
import { type Experiment, ExperimentInput, ExperimentQueue } from "./queue.ts";
import { type CardResult, type CardSubmission, Cards } from "./research/cards.ts";
import { folderRootOf, SAVED_LANES_DIR } from "./research/folder.ts";
import { type PaperPackage, type PaperSubmission, Papers } from "./research/paper.ts";
import { NOTE_REPEATS, setHypothesisStatus, startingHypotheses } from "./research/research.ts";
import {
  checkResearchPanel,
  RESEARCH_REVIEW,
  type ResearchPackage,
  type ResearchVerdicts,
  reviewerGaps,
} from "./research/review.ts";
import { researchState, stateBrief } from "./research/shares.ts";
import {
  type ResearchReviewPackage,
  type ReviewKind,
  type ReviewPackage,
  Reviews,
} from "./reviews.ts";
import { RigSettingsStore } from "./rig-settings.ts";
import { RunResearch } from "./run-research.ts";
import { ModelUsage } from "./usage.ts";
import { checkV0, violationsOf } from "./v0.ts";

/** A directive set may not both avoid a direction and ask for it. */
function conflictCheck(set: { kind: string; family?: string | undefined }[]): void {
  const avoid = new Set(set.filter((d) => d.kind === "avoid" && d.family).map((d) => d.family));
  const both = set.filter(
    (d) => (d.kind === "try" || d.kind === "mandate") && d.family && avoid.has(d.family),
  );
  if (both.length) {
    throw new LedgerError(
      "invalid",
      `the set both avoids and asks for ${both.map((d) => d.family).join(", ")}`,
    );
  }
}

/** The directions a set of rules names that the run does not have (goal 066), in order. */
function unknownIn(set: { family?: string | undefined }[], known: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of set)
    if (d.family && !known.includes(d.family) && !out.includes(d.family)) out.push(d.family);
  return out;
}

/**
 * Why a closed run's waiting decision is refused, by kind (goal 087; the owner, 2026-10-22: a
 * closed run's decisions leave Needs you, and approvals of them are refused). A closed run is
 * finished: none of its changes becomes the champion, and nothing in it is decided again.
 */
const CLOSED_RUN_REFUSALS = {
  approve_promotion: "none of its changes can become the champion",
  decline_promotion: "its changes stay as they were when it closed",
  accept_review: "its goals are not checked again",
  conclude: "it can't end as not possible or go on",
} as const;

/** Command kinds only the owner may issue (control records the issuer in the signed envelope). */
const OWNER_ONLY = new Set([
  "approve_promotion",
  "decline_promotion",
  "accept_review",
  "conclude",
  "close_run",
  "wipe_state",
  "message_agent",
  "unkeep_message",
  "rig_settings",
  "queue_add",
  "queue_move",
  "queue_edit",
  "queue_drop",
  "queue_accept",
  "drop_directive",
  "hypothesis_status",
]);

/** An advisor's additions and moves for a run's queue (the supervisor's /v1/queue). */
export const AdvisorQueueRequest = z.strictObject({
  run: z.string().min(1).max(100),
  /** The advisor role that proposes them: it is recorded as who added or moved each one. */
  role: z.enum(["teacher", "auditor"]),
  add: z
    .array(
      z.strictObject({
        title: ExperimentText.title,
        details: ExperimentText.details.optional(),
        family: ExperimentText.family.optional(),
        why: z.string().trim().min(1).max(2000),
        position: QueuePosition.optional(),
        /** A research run's task: the question it is about, an index from 0 (goal 117). */
        question: z.number().int().min(0).optional(),
      }),
    )
    .max(20)
    .default([]),
  move: z
    .array(
      z.strictObject({
        id: ExperimentId,
        position: QueuePosition,
        why: z.string().trim().min(1).max(2000),
      }),
    )
    .max(20)
    .default([]),
});
export type AdvisorQueueRequest = z.infer<typeof AdvisorQueueRequest>;

/** A worker's idea for its run's queue (`thermite-trial idea`, or Pi's idea tool). */
export const IdeaRequest = z.strictObject({
  title: ExperimentText.title,
  details: ExperimentText.details.optional(),
  family: ExperimentText.family.optional(),
  why: ExperimentText.why.optional(),
  /** In a research run, the question the task is about, an index from 0 (goal 117). */
  question: z.number().int().min(0).optional(),
});

/** What a queue command did, as its result: the experiment, its state and its place. */
function queueResult(x: Experiment): {
  experiment: string;
  state: string;
  position: number | null;
} {
  return { experiment: x.id, state: x.state, position: x.place };
}

/** Written by an accepted wipe_state; the next controller start wipes the state and removes it. */
export const WIPE_MARKER = "WIPE_REQUESTED";

/**
 * Carries out a requested wipe at start: everything in the state directory goes except the
 * rig's signing key (its identity stays), and the scratch directory is emptied. Returns
 * whether a wipe happened.
 */
export function wipeIfRequested(paths: HarnessPaths, keep: string[]): boolean {
  const marker = join(paths.stateDir, WIPE_MARKER);
  if (!existsSync(marker)) return false;
  // Build trees are locked read-only: make what this user owns writable before removing it.
  const remove = (p: string) => {
    try {
      execFileSync("chmod", ["-R", "u+rwX", p], { stdio: "ignore" });
    } catch {
      // files of other users: removing them needs the broker (root)
    }
    rmSync(p, { recursive: true, force: true });
  };
  for (const name of readdirSync(paths.stateDir)) {
    if (name === WIPE_MARKER) continue;
    if (name === "ledger") {
      for (const f of readdirSync(join(paths.stateDir, name))) {
        if (!keep.includes(f)) remove(join(paths.stateDir, name, f));
      }
      continue;
    }
    remove(join(paths.stateDir, name));
  }
  // Scratch, and the outbox: its exports reached the results repository before the wipe.
  for (const dir of [paths.scratchDir, paths.outboxDir]) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) remove(join(dir, name));
  }
  mkdirSync(join(paths.stateDir, "ledger"), { recursive: true });
  writeFileSync(join(paths.stateDir, "ledger", NOT_BEFORE_FILE), notBeforeOf(marker));
  rmSync(marker, { force: true });
  return true;
}

/** Left by a wipe: the new ledger refuses commands issued before this time. */
export const NOT_BEFORE_FILE = "NOT_BEFORE";

/** The wipe command's issue time from a marker (control's clock), or now if it is missing. */
export function notBeforeOf(marker: string): string {
  try {
    const at = (JSON.parse(readFileSync(marker, "utf8")) as { not_before?: string }).not_before;
    if (at && Number.isFinite(Date.parse(at))) return at;
  } catch {
    // an unreadable marker: fall back to now
  }
  return new Date().toISOString();
}

export interface HarnessPaths {
  stateDir: string;
  scratchDir: string;
  inboxDir: string;
  outboxDir: string;
}

export type RigCheckName = "model" | "isolation" | "smoke";

export interface RigCheck {
  /** Why the check cannot start now (for example a busy rig), if it cannot. */
  notNow?: (() => string | undefined) | undefined;
  run: (opts: { force: boolean }) => Promise<RigCheckReport>;
}

export type CommandOutcome =
  | { status: "applied" | "replayed"; accepted: boolean; result: unknown }
  | { status: "rejected"; reason: string }
  /** The same command is being applied by another request; ask again later. */
  | { status: "in_progress" };

export const SubmitRequest = z.object({
  run: z.string().min(1),
  lane: z.string().min(1).optional(),
  /** Base64 of `git add -A && git diff --cached --binary` against the parent. */
  patch_base64: z.string().min(1),
  /** Parent commit; defaults to the current champion. */
  parent: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  hypothesis: z.string().min(1).max(4000),
  claim: z.string().max(4000).optional(),
  known_flaws: z.array(z.string().min(1).max(1000)).max(50).default([]),
});
export type SubmitRequest = z.infer<typeof SubmitRequest>;

export interface SubmitResult {
  attempt: string;
  lifecycle: "queued" | "rejected_v0" | "duplicate";
  commit: string;
  violations: string[];
  duplicate_of?: string;
}

/**
 * The harness's application service. It is the only code that changes harness state; the API
 * layer authenticates callers and delegates here.
 */
export class HarnessService {
  readonly rig: string;
  readonly ledger: Ledger;
  readonly paths: HarnessPaths;
  /** What the agents and the judge are doing now, for control's live view (never judged). */
  readonly live = new LiveLog();
  private readonly controlPublicKeyPem: string;
  private readonly clock: () => Date;
  private readonly rigKeys: KeyPairPem | undefined;
  /** What the rig runs on, collected at start; it rides in every report's summary. */
  hardware: Hardware | undefined;
  /**
   * The harness's build (its Thermite version and commit, and the protocol it speaks): it rides
   * in every report's summary, so control can mark a rig that is behind and refuse one whose
   * protocol it cannot work with.
   */
  build: BuildInfo | undefined = buildInfo();
  /** Commands being applied right now, so a concurrent re-send cannot run one twice. */
  private readonly inFlight = new Set<string>();
  /** Trials whose submission is being recorded right now. */
  private readonly submitting = new Set<string>();
  /**
   * Each running code trial's workspace (set by the scheduler): the worker's file and shell tools
   * run there, as the lane's user, through the API with the trial's token.
   */
  readonly trialWorkspaces = new Map<string, { lane: string; repo: string; root: string }>();
  /** Each open trial's counters as its worker last reported them (kept if the trial dies). */
  readonly trialProgress = new Map<
    string,
    { turns: number; tool_calls: number; tokens_in: number; tokens_out: number }
  >();
  /**
   * The owner's messages in each starting trial's brief. They count as read only when its agent
   * is at work (its first line or counters), so a trial that fails first leaves them waiting.
   */
  private readonly briefMessages = new Map<
    string,
    { trial: { id: string; run: string; lane: string }; ids: number[] }
  >();
  /** The rig's own settings (Edit rig): parts on or off, workers at once, limits, promotion. */
  readonly settings: RigSettingsStore;
  /** The owner's messages to the run's agents, and who read each one. */
  readonly messages: OwnerMessages;
  /** Each run's experiment queue: what to try next, in order, and what was tried. */
  readonly queue: ExperimentQueue;
  /** Each run's field notes: what its workers, planner and advisors write down as they work. */
  readonly journal: Journal;
  /** The model usage of each run's agents, one record for each call (goal 075). */
  readonly usage: ModelUsage;
  /** Past research in each run's research folder (knowledge/), as the supervisor syncs it. */
  readonly knowledge: Knowledge;
  /**
   * Each run's own research, read only, for its teachers (goal 098): sources, claims, hypotheses,
   * findings, notes and the files of its research folder, from the ledger and the lanes' saved
   * files.
   */
  readonly runResearch: RunResearch;
  /**
   * The MCP servers the runs' kits name (goal 068): workers and the planner call them through
   * here; their sign-in, from control by way of the supervisor, stays in this process's memory.
   */
  readonly mcp: McpGateway;
  /** A rig configured with its GPU set: how many cards, and how many the judge has now. */
  gpuSplit?: { set: number; judge: number } | undefined;
  /**
   * A subscription's usage windows as its runtime last reported them (Claude Code's 5-hour and
   * weekly windows), for the rig's report: no tokens, only percent used and reset times.
   */
  subscriptionUsage?:
    | {
        five_hour?: { utilization: number; resets_at: string } | undefined;
        seven_day?: { utilization: number; resets_at: string } | undefined;
        at: string;
      }
    | undefined;
  /**
   * When the model proxy last saw OpenAI say the ChatGPT plan's usage is full (ms). A program that
   * keeps only an error's message (the Codex CLI) loses OpenAI's code; the proxy sees the answer.
   */
  private usageLimitAt: number | undefined;

  /** The proxy saw OpenAI's answer that the ChatGPT plan's usage is full. */
  noteUsageLimit(now = Date.now()): void {
    this.usageLimitAt = now;
  }

  /** The newest error answer the model proxy saw for each trial (or "proxy"): goal 079. */
  private readonly providerAnswers = new Map<string, ProviderErrorAnswer & { at: number }>();

  /** The model proxy saw a provider's error answer for a trial (or a check or a plan). */
  noteProviderAnswer(who: string, a: ProviderErrorAnswer, now = Date.now()): void {
    this.providerAnswers.delete(who);
    this.providerAnswers.set(who, { ...a, at: now });
    // The newest few hundred: a trial reads its own soon after its program stops.
    for (const k of this.providerAnswers.keys()) {
      if (this.providerAnswers.size <= 256) break;
      this.providerAnswers.delete(k);
    }
  }

  /**
   * How long a model call's stream may send no data before the model proxy breaks it off (ms;
   * goal 079): THERMITE_MODEL_STALL_SECONDS, 600 s by default. Undefined: never.
   */
  modelStallMs: number | undefined = modelStallMs();

  /**
   * The model proxy broke a call off because its stream went silent (goal 079): the log says so,
   * and a trial's Live. The trial's program then sees a broken connection or a 504, and the
   * proxy's answer for it (noteProviderAnswer) makes it the provider's `server` error.
   */
  noteModelStall(trial: { id: string; run: string; lane: string } | undefined, ms: number): void {
    logStall(ms, trial ? { trial: trial.id, run: trial.run, via: "model proxy" } : {});
    if (trial)
      this.live.append({
        source: `trial:${trial.id}`,
        kind: "status",
        text: `${stallWords(ms)}: retried. The harness broke the call off; the trial goes on in the same session.`,
        lane: trial.lane,
        run: trial.run,
      });
  }

  /** The newest error answer the proxy saw for a trial, if it came at or after `since` (ms). */
  providerAnswerSince(who: string, since: number): ProviderErrorAnswer | undefined {
    const a = this.providerAnswers.get(who);
    return a && a.at >= since ? { status: a.status, headers: a.headers, body: a.body } : undefined;
  }

  /**
   * When agents may try the ChatGPT plan again, if the proxy saw it full at or after `since` (ms):
   * OpenAI gives no reset time, so a fixed wait (CHATGPT_LIMIT_WAIT_MS). Undefined: it did not.
   */
  usageLimitSince(since: number): string | undefined {
    const at = this.usageLimitAt;
    return at !== undefined && at >= since
      ? new Date(at + CHATGPT_LIMIT_WAIT_MS).toISOString()
      : undefined;
  }

  /** A research run's folder as files, for its export (main.ts sets it). */
  researchFolder?: ((run: string) => { root: string; files: string[] }) | undefined;
  /**
   * Each compaction of an agent's conversation (goal 070): the conversation kept in the run's
   * research folder, and the record of it (main.ts sets it, with the research folder).
   */
  compactions?: Compactions | undefined;
  /**
   * The rig drains (goal 079): no new trial, plan or judge job starts, and those running end as
   * they would. Kept in memory only: the restart it prepares for ends it.
   */
  draining: { since: string; reason: string; by: string } | undefined;

  /**
   * What still runs, for a drain's report: open trials and the judge's jobs under a lease still in
   * force (goal 079). A lease that ran out is no work: its holder is gone, the judge takes it back
   * (while draining too), and a drain never waits on it.
   */
  work(): {
    trials: number;
    judge_jobs: number;
    draining: { since: string; reason: string } | null;
  } {
    const n = (sql: string, ...params: string[]) =>
      Number((this.ledger.db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0);
    return {
      trials: n("select count(*) as n from trial where ended_at is null"),
      judge_jobs: n(
        "select count(*) as n from job where state = 'leased' and lease_until > ?",
        this.clock().toISOString(),
      ),
      draining: this.draining ? { since: this.draining.since, reason: this.draining.reason } : null,
    };
  }

  /** The promotion policy: what happens to a confirmed win (and to one an audit cleared). */
  get promotion(): "auto" | "owner_approval" {
    return this.settings.get().promotion;
  }
  private readonly targetType: string | undefined;

  constructor(input: {
    rig: string;
    ledger: Ledger;
    paths: HarnessPaths;
    controlPublicKeyPem: string;
    clock?: (() => Date) | undefined;
    /** The rig's report-signing key (generated once, kept in the private state). */
    rigKeys?: KeyPairPem | undefined;
    promotion?: "auto" | "owner_approval" | undefined;
    /** The rig's target type (cpu, cuda-gpu, ...): an assigned campaign's kit must measure on it. */
    targetType?: string | undefined;
    /** The rig's settings; none: defaults in memory, with this promotion policy. */
    settings?: RigSettingsStore | undefined;
    /** How the MCP gateway reaches MCP servers (tests give their own). */
    mcpConnect?: McpConnect | undefined;
  }) {
    this.rigKeys = input.rigKeys;
    this.targetType = input.targetType;
    this.settings =
      input.settings ??
      new RigSettingsStore({
        judge: true,
        workers: true,
        lanes: 1,
        planner: true,
        auditor: true,
        teachers: true,
        review: true,
        exports: true,
        trial_minutes: null,
        max_turns: null,
        // Hands-off by default (goal 079).
        promotion: input.promotion ?? "auto",
        judge_gpus: null,
      });
    this.rig = input.rig;
    this.clock = input.clock ?? (() => new Date());
    this.ledger = input.ledger;
    this.paths = input.paths;
    this.controlPublicKeyPem = input.controlPublicKeyPem;
    this.messages = new OwnerMessages({
      ledger: this.ledger,
      live: this.live,
      clock: this.clock,
      settings: () => this.settings.get(),
      contractFor: (run) => this.contractFor(run),
    });
    this.queue = new ExperimentQueue(this.ledger);
    this.journal = new Journal({ ledger: this.ledger, live: this.live, clock: this.clock });
    this.usage = new ModelUsage(this.ledger);
    // The same folders as the research folder's (main.ts): scratch/research/<run>/knowledge.
    this.knowledge = new Knowledge({
      stateRoot: join(this.paths.stateDir, "knowledge"),
      folderRoot: (run) => folderRootOf(join(this.paths.scratchDir, "research"), run),
    });
    // The lanes' files where the research folder saves them (main.ts): stateDir/research-work.
    this.runResearch = new RunResearch({
      ledger: this.ledger,
      savedLanes: join(this.paths.stateDir, SAVED_LANES_DIR),
    });
    this.mcp = new McpGateway({
      uses: (run) => this.mcpUses(run),
      // A server that fails or comes back: in the run's history, once each time.
      record: (run, kind, body) => {
        this.ledger.appendEvent("harness", kind, run, body);
      },
      say: (source, run, text) => this.live.append({ source, kind: "status", text, run }),
      connect: input.mcpConnect,
    });
  }

  /** A run's promotion policy: its own, chosen when it was assigned, or the rig's default. */
  promotionFor(run: string): "auto" | "owner_approval" {
    return this.ledger.getRun(run)?.promotion ?? this.promotion;
  }

  /** What else a run asks the owner about (goal 079): nothing unless it was set to ask. */
  askFor(run: string): AskOwner {
    return this.ledger.getRun(run)?.ask_owner ?? {};
  }

  /**
   * Why a confirmed win waits for the owner, or undefined (goal 079). Thermite is hands-off by
   * default: a win waits only where the run (or the rig's default) asks: every win (promotion
   * policy "owner_approval"), a gain above `ask_owner.above_gain`, or declared flaws
   * (`ask_owner.declared_flaws`).
   */
  ownerAsks(
    run: string,
    attempt: Record<string, unknown>,
    delta: number | null,
  ): string | undefined {
    if (this.promotionFor(run) === "owner_approval")
      return "you asked to decide every change (promotion: owner approval)";
    const ask = this.askFor(run);
    const flaws = (JSON.parse(String(attempt.known_flaws ?? "[]")) as unknown[]).length;
    if (ask.declared_flaws && flaws > 0)
      return `you asked to decide changes with declared flaws: this one declares ${flaws}`;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    if (ask.above_gain !== undefined && delta !== null && delta > ask.above_gain)
      return `you asked to decide gains above ${pct(ask.above_gain)}: this one is ${pct(delta)}`;
    return undefined;
  }

  /** The change of an attempt's current verdict, if it has one. */
  private verdictDelta(attempt: string): number | null {
    const v = this.ledger.currentVerdict(attempt);
    const d = v
      ? (this.ledger.db.prepare("select delta from verdict where id = ?").get(v.id) as
          | { delta: number | null }
          | undefined)
      : undefined;
    return typeof d?.delta === "number" ? d.delta : null;
  }

  /**
   * The supervisor's advisors, as it last said (goal 079): whether an auditor decides this rig's
   * audits, how many reviewers its review panel has, and whether a final writer writes research
   * papers (goal 112; a supervisor from before it does not say, which reads as none). Unknown
   * until it says.
   */
  advisors: { auditor: boolean; panel: number; writer: boolean; at: string } | undefined;

  /**
   * The supervisor says which advisors it has (goal 079). Without an auditor, the audits held for
   * one go on by the run's rules: promoted, or to the owner where the run asks.
   */
  async setAdvisors(
    a: { auditor: boolean; panel: number; writer?: boolean | undefined },
    by: string,
  ): Promise<string[]> {
    this.advisors = {
      auditor: a.auditor,
      panel: a.panel,
      writer: a.writer === true,
      at: this.clock().toISOString(),
    };
    return a.auditor ? [] : this.releaseHeldAudits(by);
  }

  /** A research run's folder follows a change the research service did not make (main.ts sets it). */
  researchChanged?: ((run: string) => void) | undefined;

  /** Research runs' answer cards (goal 117): one per question, written by the synthesizer. */
  get cards(): Cards {
    return new Cards(this.ledger, (run) => this.contractFor(run));
  }

  /** For each running research run whose evidence changed since a card, its request (goal 117). */
  cardPackages(): ReturnType<Cards["pending"]> {
    return this.cards.pending();
  }

  /**
   * The synthesizer's cards for a research run, as the supervisor posts them (goal 117): each
   * checked by code, then kept as its question's next version or refused with its problems, which
   * go back with the question's next request. The run's research folder follows what was kept.
   */
  submitCards(run: string, input: CardSubmission, by: string): { results: CardResult[] } {
    const out = this.cards.submit(run, input, by);
    const q = (i: number) => `question ${i + 1}`;
    const kept: string[] = [];
    const refused: string[] = [];
    for (const r of out.results)
      if (r.accepted) kept.push(`${q(r.question)} (version ${r.version})`);
      else refused.push(`${q(r.question)} (${r.problems[0] ?? "no problem said"})`);
    this.live.append({
      source: "planner",
      kind: "status",
      text: [
        kept.length
          ? `the synthesizer ${input.synthesizer} wrote the answer ${kept.length === 1 ? "card" : "cards"} of ${kept.join(", ")}`
          : "",
        refused.length
          ? `the harness refused the ${refused.length === 1 ? "card" : "cards"} of ${refused.join("; ")}: the old ${refused.length === 1 ? "card stands" : "cards stand"}, and the problems go back with the next request`
          : "",
      ]
        .filter(Boolean)
        .join(". ")
        .slice(0, 600),
      run,
    });
    if (kept.length)
      try {
        this.researchChanged?.(run);
      } catch (err) {
        log("harness", "research folder not updated", { run, error: String(err) });
      }
    return out;
  }

  /** Research runs' final papers (goal 112). */
  get papers(): Papers {
    return new Papers(this.ledger, (run) => this.contractFor(run));
  }

  /** The research runs waiting for their paper, each as the final writer's package (goal 112). */
  paperPackages(): (PaperPackage & { campaign_brief?: BriefData })[] {
    return this.papers.pending().map((pkg) => {
      const brief = briefData(this.contractFor(pkg.run));
      return { ...pkg, ...(brief ? { campaign_brief: brief } : {}) };
    });
  }

  /**
   * A research run's paper, as the supervisor posts it (goal 112): checked by code, then accepted
   * or refused with its problems. Accepted, it is the run's paper.md and leads its final report,
   * which the scheduler writes once the run's running trials have ended; then the run closes.
   */
  submitPaper(run: string, input: PaperSubmission, by: string): ReturnType<Papers["submit"]> {
    const out = this.papers.submit(run, input, by);
    if (!out.accepted) {
      this.live.append({
        source: "planner",
        kind: "status",
        text: `the final writer's paper was refused: ${out.problems.length} ${out.problems.length === 1 ? "problem" : "problems"}, the first: ${out.problems[0]?.problem ?? ""}`.slice(
          0,
          600,
        ),
        run,
      });
      return out;
    }
    this.journal.writeAll(
      run,
      [
        {
          kind: "decision",
          text: `The research paper by the final writer ${input.writer} passed the harness's checks${input.ste.checked ? " and the rig's STE checker" : "; the rig has no STE checker, so its style was not checked"}. It leads the final report. The run ends once its running trials end.`,
        },
      ],
      { by: "harness", actor: by, source: "supervisor" },
    );
    this.live.append({
      source: "planner",
      kind: "status",
      text: `the research paper is in: ${out.cited} claims cited, ${out.experiments.length} next ${out.experiments.length === 1 ? "experiment" : "experiments"}${input.ste.checked ? ", STE checked" : ", STE not checked (no checker)"}`,
      run,
    });
    try {
      this.researchChanged?.(run);
    } catch (err) {
      log("harness", "research folder not updated", { run, error: String(err) });
    }
    return out;
  }

  /**
   * A review panel's results (goal 079). A pass is accepted with no owner step, unless the run
   * asks the owner (`ask_owner.reviews`); the goal tree is checked again. A research review's
   * results (goal 112) are checked by code first (recordResearchPanel).
   */
  recordReviewPanel(
    id: number,
    results: {
      reviewer: string;
      pass: boolean;
      reasons: string;
      research?: ResearchVerdicts | undefined;
    }[],
    by: string,
  ): { result: "review_passed" | "review_failed"; accepted?: true } {
    const reviews = new Reviews(this.ledger);
    const asked = reviews.byId(id);
    if (asked?.goal === RESEARCH_REVIEW)
      return this.recordResearchPanel(reviews, asked, results, by);
    const result = reviews.recordPanel(id, results, by);
    const row = this.ledger.db.prepare("select run from review where id = ?").get(id) as
      | { run: string }
      | undefined;
    if (result !== "review_passed" || !row || this.askFor(row.run).reviews) return { result };
    reviews.ownerDecision(
      id,
      row.run,
      true,
      "hands-off: the review panel passed it, and the run does not ask the owner",
      "harness (hands-off)",
    );
    this.ledger.enqueueJob({ kind: "validate", priority: 40, spec: { run: row.run }, actor: by });
    return { result, accepted: true };
  }

  /**
   * A research review's results (goal 112): each reviewer's answers checked by code against the
   * package it was given (research/review.ts), and recorded with each failed check's reason. On
   * gaps, each reviewer's findings go in the run's journal and the run goes on. A pass is accepted
   * hands-off, unless the run asks the owner about reviews; once accepted, the scheduler ends the
   * run when its running trials end, with its final report.
   */
  private recordResearchPanel(
    reviews: Reviews,
    row: Record<string, unknown>,
    results: {
      reviewer: string;
      pass: boolean;
      reasons: string;
      research?: ResearchVerdicts | undefined;
    }[],
    by: string,
  ): { result: "review_passed" | "review_failed"; accepted?: true } {
    const id = Number(row.id);
    const run = String(row.run);
    const pkg = JSON.parse(String(row.package)) as ResearchPackage;
    const checked = checkResearchPanel(this.ledger, run, pkg, results);
    const result = reviews.recordResearchPanel(id, checked, by);
    const panelNote = (reviewer: string, text: string) =>
      this.journal.writeAll(run, [{ kind: "observation", text: text.slice(0, 2000) }], {
        by: `panel:${reviewer}`,
        actor: by,
        source: "supervisor",
      });
    if (result === "review_failed") {
      // One note for each reviewer: what it found missing, and each answer that failed the check.
      for (const r of checked) {
        const gaps = reviewerGaps(r);
        panelNote(
          r.reviewer,
          r.pass
            ? `Review ${id}: this reviewer found every question answered; the review panel as a whole did not.`
            : `Review ${id}: not every question is answered yet. ${gaps.join(". ")}.`,
        );
      }
      return { result };
    }
    if (this.askFor(run).reviews) return { result };
    const words = "hands-off: the review panel passed it, and the run does not ask the owner";
    reviews.ownerDecision(id, run, true, words, "harness (hands-off)");
    this.journal.writeAll(
      run,
      [
        {
          kind: "decision",
          text: `Review ${id}: ${words}. Every question is answered: the run writes its final report and ends once its running trials end.`,
        },
      ],
      { by: "harness", actor: "harness (hands-off)", source: "supervisor" },
    );
    return { result, accepted: true };
  }

  /**
   * A "not possible" proposal (goal 079): taken, closing the run, unless the run asks the owner
   * (`ask_owner.not_possible`). True when it was taken.
   */
  takeConclusion(run: string, proposal: number): boolean {
    if (this.askFor(run).not_possible) return false;
    new Conclusions(this.ledger).decide(
      run,
      proposal,
      true,
      "hands-off: the run does not ask the owner",
      "harness (hands-off)",
      "not possible: the evidence holds, and the run does not ask the owner",
    );
    return true;
  }

  /** The audits held while no auditor decides them (goal 079), released by the run's rules. */
  async releaseHeldAudits(by: string): Promise<string[]> {
    const audits = new Audits(this.ledger);
    const out: string[] = [];
    for (const id of audits.pending()) {
      const au = this.ledger.db.prepare("select * from audit where id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!au) continue;
      const attempt = String(au.attempt);
      if (String(this.ledger.getAttempt(attempt)?.lifecycle) !== "awaiting_audit") continue;
      // A closed run's audit stays held (goal 087): none of its changes becomes the champion.
      if (this.ledger.getRun(String(au.run))?.status === "closed") continue;
      this.ledger.appendEvent(by, "audit_skipped", attempt, {
        audit: id,
        run: String(au.run),
        reason: String(au.reason),
        why: "this rig has no auditor",
      });
      await this.promoteOrAsk(attempt, String(au.run), Number(au.expected_seq), by, "no auditor");
      out.push(attempt);
    }
    return out;
  }

  /**
   * A win with nothing left to hold it (an auditor's clear, or no auditor): the owner, where the
   * run asks; else the champion by compare-and-swap, its declared flaws accepted by this step
   * (goal 079: hands-off by default). A champion that moved meanwhile sends it to be screened
   * again.
   */
  private async promoteOrAsk(
    attempt: string,
    run: string,
    expectedSeq: number,
    by: string,
    cleared: string,
  ): Promise<Record<string, unknown>> {
    const a = this.ledger.getAttempt(attempt) as Record<string, unknown>;
    const ask = this.ownerAsks(run, a, this.verdictDelta(attempt));
    if (ask) {
      this.ledger.tx(() => {
        this.ledger.appendEvent(by, "promotion_pending", attempt, {
          run,
          expected_seq: expectedSeq,
          commit: a.commit_sha,
          reason: ask,
        });
        this.ledger.setAttemptLifecycle(attempt, "awaiting_approval", by);
      });
      return { effect: "waiting for the owner", reason: ask };
    }
    const flaws = (JSON.parse(String(a.known_flaws ?? "[]")) as unknown[]).length > 0;
    const before = (a.flaws_cleared_by as string | null) ?? null;
    if (flaws && !before)
      this.ledger.db
        .prepare("update attempt set flaws_cleared_by = ? where id = ?")
        .run(`${by} (${cleared})`, attempt);
    const r = await this.promoteAttempt({ run, attempt, expectedSeq, by });
    if (r.promoted) {
      if (flaws && !before)
        this.ledger.appendEvent(by, "flaws_accepted", attempt, { by: `${by} (${cleared})` });
      return { effect: "promoted", seq: r.seq };
    }
    if (flaws && !before)
      this.ledger.db
        .prepare("update attempt set flaws_cleared_by = null where id = ?")
        .run(attempt);
    return this.rescreen(attempt, r.currentSeq, by) as Record<string, unknown>;
  }

  mirrorFor(repo: string): string {
    return join(this.paths.stateDir, "git", `${repo}.git`);
  }

  // ------------------------------------------------------------ commands

  async applyCommand(input: unknown, actor = "supervisor"): Promise<CommandOutcome> {
    const verified = verifyCommand(input, this.controlPublicKeyPem, this.rig, this.clock());
    if (!verified.ok && verified.authenticId) {
      // Authentic but expired (or otherwise late): if it was applied before, report that.
      const prior = this.ledger.getCommand(verified.authenticId);
      if (prior) return { status: "replayed", ...prior };
    }
    if (!verified.ok) {
      const kind = (input as { envelope?: { kind?: unknown } })?.envelope?.kind;
      this.ledger.appendEvent(actor, "command_rejected", null, {
        reason: verified.reason,
        kind: typeof kind === "string" ? kind : null,
      });
      return { status: "rejected", reason: verified.reason };
    }
    const { envelope, payload } = verified;
    const prior = this.ledger.getCommand(envelope.id);
    if (prior) return { status: "replayed", ...prior };
    // After a wipe, commands signed for the old ledger are not applied to the new one.
    const notBefore = this.ledger.db
      .prepare("select value from meta where key = 'not_before'")
      .get() as { value: string } | undefined;
    if (notBefore && Date.parse(envelope.issued_at) < Date.parse(notBefore.value)) {
      this.ledger.appendEvent(actor, "command_rejected", null, {
        reason: "issued before this rig's state was wiped",
        kind: envelope.kind,
      });
      return { status: "rejected", reason: "issued before this rig's state was wiped" };
    }
    if (this.inFlight.has(envelope.id)) return { status: "in_progress" };

    this.inFlight.add(envelope.id);
    let accepted = true;
    let result: unknown;
    try {
      result = await this.execute(envelope, payload);
    } catch (err) {
      accepted = false;
      result = { error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.inFlight.delete(envelope.id);
    }
    this.ledger.recordCommand({
      id: envelope.id,
      kind: envelope.kind,
      envelope,
      signature: (input as { signature: string }).signature,
      accepted,
      result,
      actor: `control:${envelope.issued_by}`,
    });
    return { status: "applied", accepted, result };
  }

  private async execute(envelope: Envelope, payload: unknown): Promise<unknown> {
    const by = `control:${envelope.issued_by}`;
    // The owner's gates: control signs who issued a command, and only the owner (not an agent
    // with an API or MCP token) approves promotions, accepts reviews and endings, and wipes.
    if (
      OWNER_ONLY.has(envelope.kind) &&
      envelope.issued_by !== "owner" &&
      !envelope.issued_by.startsWith("owner:")
    ) {
      throw new Error(`${envelope.kind} is the owner's to issue, not ${envelope.issued_by}'s`);
    }
    switch (envelope.kind) {
      case "assign_campaign":
        return this.assignCampaign(CommandPayloads.assign_campaign.parse(payload), by);
      case "rig_check":
        return this.startRigCheck(CommandPayloads.rig_check.parse(payload), by);
      case "drain_rig": {
        const p = CommandPayloads.drain_rig.parse(payload);
        this.draining = p.drain
          ? (this.draining ?? {
              since: this.clock().toISOString(),
              reason: p.reason ?? "its images are about to change",
              by,
            })
          : undefined;
        this.ledger.appendEvent(by, "rig_drain", null, {
          drain: p.drain,
          ...(p.reason ? { reason: p.reason } : {}),
          ...this.work(),
        });
        return this.work();
      }
      case "pause_run": {
        const p = CommandPayloads.pause_run.parse(payload);
        // A closed run stays closed: a pause would let a resume open it again.
        if (this.requireRun(p.run).status === "closed") throw new Error(`run ${p.run} is closed`);
        this.ledger.setRunStatus(p.run, "paused", p.reason, by);
        return { run: p.run, status: "paused" };
      }
      case "resume_run": {
        const p = CommandPayloads.resume_run.parse(payload);
        const inst = this.requireRun(p.run);
        if (inst.status === "closed") throw new Error(`run ${p.run} is closed`);
        // One running run per rig: resuming one pauses the others.
        this.ledger.tx(() => {
          this.pauseOthers(p.run, by);
          this.ledger.setRunStatus(p.run, "running", null, by);
        });
        return { run: p.run, status: "running" };
      }
      case "close_run": {
        // The owner ends a run for good (goal 087), as goal completion does: the run is closed
        // with the reason. The scheduler stops its trials and planner call as for a pause, the
        // judge leases only running runs' jobs, and a closed run is never resumed.
        const p = CommandPayloads.close_run.parse(payload);
        const inst = this.requireRun(p.run);
        if (inst.status === "closed")
          throw new LedgerError(
            "conflict",
            `run ${p.run} is already closed${inst.pause_reason ? ` (${inst.pause_reason})` : ""}: there is nothing to close`,
          );
        this.ledger.setRunStatus(p.run, "closed", p.reason, by);
        return { run: p.run, status: "closed", was: inst.status };
      }
      case "redirect": {
        const p = CommandPayloads.redirect.parse(payload);
        this.openRun(p.run);
        conflictCheck(p.directives);
        // A direction the run doesn't have yet is the planner's to design at its next round
        // (goal 066). A research run's planner designs no direction: it takes only its task kinds.
        const known = this.queue.directions(p.run);
        const unknown = unknownIn(p.directives, known);
        if (unknown.length && this.contractFor(p.run).mode === "research")
          throw new LedgerError("invalid", researchDirectionRefusal(unknown));
        const ids = this.ledger.addDirectiveSet(p.run, by, p.directives, p.replace);
        return {
          run: p.run,
          directives: ids,
          ...(unknown.length ? { new_directions: unknown } : {}),
        };
      }
      case "message_agent":
        return this.messages.send(CommandPayloads.message_agent.parse(payload), by);
      case "unkeep_message": {
        const p = CommandPayloads.unkeep_message.parse(payload);
        this.requireRun(p.run);
        return this.messages.unkeep(p.run, p.message, by);
      }
      // The owner's changes to a run's experiment queue: each refused in plain words when the
      // experiment is unknown or in the wrong state.
      case "queue_add": {
        const p = CommandPayloads.queue_add.parse(payload);
        this.openRun(p.run);
        const x = this.queue.add(
          p.run,
          {
            title: p.title,
            details: p.details,
            family: p.family,
            why: p.why,
            by: "owner",
            position: p.position,
          },
          by,
        );
        return queueResult(x);
      }
      case "queue_move": {
        const p = CommandPayloads.queue_move.parse(payload);
        this.openRun(p.run);
        return queueResult(this.queue.move(p.run, p.id, { by: "owner", position: p.position }, by));
      }
      case "queue_edit": {
        const p = CommandPayloads.queue_edit.parse(payload);
        this.openRun(p.run);
        const { run, id, ...change } = p;
        return queueResult(this.queue.edit(run, id, change, { by: "owner" }, by));
      }
      case "queue_drop": {
        const p = CommandPayloads.queue_drop.parse(payload);
        this.openRun(p.run);
        return queueResult(this.queue.drop(p.run, p.id, { by: "owner", why: p.why }, by));
      }
      case "queue_accept": {
        const p = CommandPayloads.queue_accept.parse(payload);
        this.openRun(p.run);
        return queueResult(
          this.queue.accept(p.run, p.id, { by: "owner", position: p.position }, by),
        );
      }
      case "drop_directive": {
        const p = CommandPayloads.drop_directive.parse(payload);
        this.openRun(p.run);
        this.ledger.dropDirective(p.run, p.id, by);
        return { run: p.run, dropped: p.id };
      }
      // A research run's hypothesis promoted, returned to the pool or retired (goal 117): the
      // planner's changes go through the same function.
      case "hypothesis_status": {
        const p = CommandPayloads.hypothesis_status.parse(payload);
        this.openRun(p.run);
        if (this.contractFor(p.run).mode !== "research")
          throw new LedgerError(
            "invalid",
            `run ${p.run} is not a research run: only a research run has hypotheses to promote or retire`,
          );
        const r = setHypothesisStatus(
          this.ledger,
          p.run,
          { id: p.id, status: p.status, reason: p.reason },
          by,
        );
        if (r.changed) this.researchChanged?.(p.run);
        return { run: p.run, ...r };
      }
      case "reset_workers": {
        // The scheduler acts on the event: it kills the run's running trials, clears the
        // lane bests and ends the epoch, so lanes start again from the champion.
        const p = CommandPayloads.reset_workers.parse(payload);
        this.requireRun(p.run);
        if (p.reseed_commit)
          throw new Error("re-seeding lanes is not available in this version; reset without it");
        this.ledger.appendEvent(by, "workers_reset", p.run, {});
        return { run: p.run, reset: true };
      }
      case "propagate":
        return receivePropagation(this, CommandPayloads.propagate.parse(payload), by);
      case "export_now": {
        const p = CommandPayloads.export_now.parse(payload);
        const r = await this.export(by, { full: p.full });
        return {
          export: r.dir.split("/").pop(),
          export_id: r.id,
          through_event: this.ledger.lastExport()?.through_event ?? 0,
          attempts: r.attempts,
          events: r.events,
        };
      }
      case "wipe_state":
        return this.requestWipe(CommandPayloads.wipe_state.parse(payload), by, envelope.issued_at);
      case "approve_promotion":
        return this.approvePromotion(CommandPayloads.approve_promotion.parse(payload), by);
      case "rig_settings": {
        const change = CommandPayloads.rig_settings.parse(payload);
        const now = this.settings.set(change);
        this.ledger.appendEvent(by, "rig_settings_changed", null, { change, settings: now });
        return { settings: now };
      }
      case "decline_promotion":
        return this.declinePromotion(CommandPayloads.decline_promotion.parse(payload), by);
      case "accept_review": {
        const p = CommandPayloads.accept_review.parse(payload);
        this.decidingRun(p.run, "accept_review");
        const row = new Reviews(this.ledger).ownerDecision(p.review, p.run, p.accept, p.note, by);
        // A research review (goal 112): accepted, the run ends once its running trials end; not
        // accepted, it goes on, and a new review needs new evidence. The owner's word goes in
        // the run's journal.
        if (row.goal === RESEARCH_REVIEW) {
          const note = p.note?.trim();
          this.journal.writeAll(
            p.run,
            [
              {
                kind: "decision",
                text: (p.accept
                  ? `The owner accepted review ${p.review}: every question is answered. The run writes its final report and ends once its running trials end.${note ? ` The owner's note: ${note}` : ""}`
                  : `The owner did not accept review ${p.review}. The run goes on; the review panel is asked again only on new evidence.${note ? ` The owner's note: ${note}` : ""}`
                ).slice(0, 2000),
              },
            ],
            { by: "owner", actor: by, source: "supervisor" },
          );
          return { review: p.review, decision: p.accept ? "accepted" : "rejected" };
        }
        // The goal tree is checked again with the owner's word.
        this.ledger.enqueueJob({
          kind: "validate",
          priority: 40,
          spec: { run: p.run },
          actor: by,
        });
        return { review: p.review, decision: p.accept ? "accepted" : "rejected" };
      }
      case "conclude": {
        const p = CommandPayloads.conclude.parse(payload);
        this.decidingRun(p.run, "conclude");
        return new Conclusions(this.ledger).decide(p.run, p.proposal, p.accept, p.note, by);
      }
    }
  }

  private pauseOthers(run: string, by: string): void {
    for (const other of this.ledger.listRuns()) {
      if (other.status === "running" && other.id !== run) {
        this.ledger.setRunStatus(other.id, "paused", `replaced by ${run}`, by);
      }
    }
  }

  private requireRun(id: string) {
    const inst = this.ledger.getRun(id);
    if (!inst) throw new LedgerError("not_found", `no run ${id}`);
    return inst;
  }

  /**
   * A run whose waiting decisions the owner may still take: one that exists and is not closed
   * (goal 087). Refused in words, by the command's kind.
   */
  private decidingRun(id: string, kind: keyof typeof CLOSED_RUN_REFUSALS) {
    const inst = this.requireRun(id);
    if (inst.status === "closed")
      throw new LedgerError("invalid", `run ${id} is closed: ${CLOSED_RUN_REFUSALS[kind]}`);
    return inst;
  }

  /** A run whose queue may still change: one that exists and is not closed. */
  private openRun(id: string) {
    const inst = this.requireRun(id);
    if (inst.status === "closed")
      throw new LedgerError("invalid", `run ${id} is closed: its queue and rules no longer change`);
    return inst;
  }

  private async runImport(
    spec: ImportSpec,
    repoHint: string,
    actor: string,
    inboxDir = this.paths.inboxDir,
  ): Promise<Record<string, string>> {
    const importId = randomUUID().slice(0, 12);
    switch (spec.kind) {
      case "repo_bundle":
      case "kit_bundle": {
        const repo = spec.kind === "kit_bundle" ? `kit-${spec.repo}` : spec.repo || repoHint;
        const mirror = this.mirrorFor(repo);
        await initMirror(mirror);
        const r = await importBundle({
          inboxDir,
          rel: spec.path,
          mirror,
          scratchDir: join(this.paths.scratchDir, "imports"),
          importId,
          expectedCommit: spec.commit,
          expectedSha256: spec.sha256,
        });
        this.ledger.recordImport({
          kind: spec.kind,
          name: repo,
          sha256: r.sha256,
          commitSha: r.commit,
          sourcePath: spec.path,
          storedPath: mirror,
          actor,
        });
        return { kind: spec.kind, repo, commit: r.commit };
      }
      case "model": {
        const stored = await importFile({
          inboxDir: this.paths.inboxDir,
          rel: spec.path,
          expectedSha256: spec.sha256,
          storeDir: join(this.paths.stateDir, "models"),
        });
        this.ledger.recordImport({
          kind: "model",
          name: spec.name,
          sha256: spec.sha256,
          sourcePath: spec.path,
          storedPath: stored,
          actor,
        });
        return { kind: "model", name: spec.name, sha256: spec.sha256 };
      }
      case "champion_patch":
        throw new Error("a champion patch comes only with a propagate command");
    }
  }

  /**
   * A run on content the harness made itself (a rig check's smoke campaign): its bundles come
   * from `dir` rather than the inbox, and everything else is checked as for a signed assignment.
   */
  async assignLocal(
    input: {
      run: string;
      contract: unknown;
      seed: { repo: string; commit: string };
      bundles: ImportSpec[];
      dir: string;
    },
    by: string,
  ): Promise<unknown> {
    const parsed = parseContract(input.contract);
    if (!parsed.ok) throw new Error(`invalid contract: ${parsed.errors.join("; ")}`);
    return this.assignCampaign(
      {
        run: input.run,
        contract: input.contract,
        contract_sha: parsed.sha,
        seed: input.seed,
        imports: input.bundles,
        agents: false,
      },
      by,
      input.dir,
    );
  }

  private async assignCampaign(
    p: z.infer<(typeof CommandPayloads)["assign_campaign"]>,
    by: string,
    inboxDir = this.paths.inboxDir,
  ): Promise<unknown> {
    const parsed = parseContract(p.contract);
    if (!parsed.ok) throw new Error(`invalid contract: ${parsed.errors.join("; ")}`);
    if (parsed.sha !== p.contract_sha) throw new Error("contract hash does not match contract_sha");
    const contract = parsed.contract;
    // Validate everything before changing anything: a refused assign leaves no trace but events.
    if (this.ledger.getRun(p.run)) throw new Error(`run ${p.run} already exists`);
    // A run without agents (a try) has no queue: nothing would take its experiments.
    if (p.agents === false && p.queue?.length)
      throw new Error("a run without agents has no queue: leave out the experiments to copy");
    for (const [i, s] of (p.queue ?? []).entries()) {
      const ok = ExperimentInput.safeParse(s);
      if (!ok.success)
        throw new Error(`queue experiment ${i + 1}: ${ok.error.issues[0]?.message ?? "invalid"}`);
    }
    // A run without agents (a try) has no briefs: nothing would read the background.
    if (p.agents === false && p.briefing?.length)
      throw new Error(
        "a run without agents has no briefs: leave out the background from past research",
      );
    const existing = this.ledger.getContract(contract.campaign, contract.version);
    if (existing && contractSha(existing) !== parsed.sha) {
      throw new Error(
        `contract ${contract.campaign} v${contract.version} exists with other content`,
      );
    }
    for (const spec of p.imports) {
      if (spec.kind === "model" && !contract.models.some((m) => m.sha256 === spec.sha256)) {
        throw new Error(`model ${spec.name} is not listed in the contract`);
      }
    }
    // Research campaigns work on a corpus, not a repository: they have no seed commit.
    const seed =
      p.seed ??
      (contract.mode === "research" ? { repo: "research", commit: "0".repeat(40) } : undefined);
    if (!seed) throw new Error(`a ${contract.mode} campaign needs a seed commit`);
    const imported = [];
    for (const spec of p.imports)
      imported.push(await this.runImport(spec, seed.repo, by, inboxDir));
    for (const m of contract.models) {
      if (!this.ledger.findImport("model", { sha256: m.sha256 })) {
        throw new Error(`model ${m.name} (${m.sha256}) has not been imported`);
      }
    }
    // The kit is checked against the contract now, not when the judge first needs it.
    const kitRef = contract.mode !== "research" ? contract.project.kit : undefined;
    let named: McpUse[] = [];
    let checkedKit: Kit | undefined;
    if (kitRef) {
      const mirror = this.mirrorFor(`kit-${kitRef.repo}`);
      if (!(await hasCommit(mirror, kitRef.commit))) {
        throw new Error(
          `kit commit ${kitRef.commit} is not in kit ${kitRef.repo}; import its bundle first`,
        );
      }
      let kit: Kit;
      try {
        kit = KitSchema.parse(JSON.parse(await showFile(mirror, kitRef.commit, "kit.json")));
      } catch (err) {
        throw new Error(
          `kit ${kitRef.repo} at ${kitRef.commit} has no valid kit.json: ${err instanceof Error ? err.message.slice(0, 500) : String(err)}`,
        );
      }
      const problems = kitProblems(contract, kit, this.targetType);
      if (problems.length)
        throw new Error(`the kit does not fit the contract: ${problems.join("; ")}`);
      named = kit.mcp_servers ?? [];
      checkedKit = kit;
    }
    // The MCP servers the kit names (a research contract's), as the signed command says them:
    // control gives the rig only those servers, so the two must agree.
    if (contract.mode === "research") named = contract.mcp_servers ?? [];
    if (!sameUses(named, p.mcp_servers))
      throw new Error(
        `the ${contract.mode === "research" ? "contract" : "kit"} names the MCP servers ${usesWords(named)}, and the assignment names ${usesWords(p.mcp_servers)}: start the run from control, which reads the kit's servers, or give the kit's mcp_servers in the assignment`,
      );
    // A project in one folder of its repository starts from that folder: the run's first
    // champion is the folder's own commit, made from the signed commit (git.ts, folderCommit).
    const folder = contract.mode !== "research" ? contract.project.folder : undefined;
    let start = seed.commit;
    if (contract.mode !== "research") {
      const mirror = this.mirrorFor(seed.repo);
      if (!(await hasCommit(mirror, seed.commit))) {
        throw new Error(
          `seed commit ${seed.commit} is not in ${seed.repo}; import its bundle first`,
        );
      }
      if (folder) start = await folderCommit(mirror, seed.commit, folder);
      // The ref first: if the ledger write below fails, a retry simply overwrites it.
      await updateRef(mirror, `refs/thermite/runs/${p.run}/champion`, start);
    }
    this.ledger.tx(() => {
      this.ledger.storeContract(contract, parsed.sha, by);
      this.pauseOthers(p.run, by);
      this.ledger.createRun({
        id: p.run,
        contract,
        contractSha: parsed.sha,
        seedRepo: seed.repo,
        seedCommit: start,
        ...(folder ? { seedFolder: { folder, commit: seed.commit } } : {}),
        direction: p.direction,
        agents: p.agents,
        promotion: p.promotion,
        askOwner: p.ask_owner,
        // The background the owner picked from past research: every agent's brief shows it.
        briefing: p.briefing?.map((b) => ({ text: b.text, from: b.from })),
        actor: by,
      });
      // A research run starts with its campaign's hypotheses as its own (goal 078).
      if (contract.mode === "research" && contract.hypotheses?.length)
        startingHypotheses(this.ledger, p.run, contract.hypotheses, by);
      // The MCP servers the run's agents use, and which agents get each: what the gateway and
      // the advisors read from now on (goal 068).
      if (named.length)
        this.ledger.appendEvent(by, "mcp_servers", p.run, { servers: canonicalUses(named) });
      // How each goal is really checked, as this rig's kit runs it (goal 082): control shows it
      // on the campaign's and the run's pages, also for a kit only the rig has.
      if (contract.mode === "goal" && checkedKit && kitRef)
        this.ledger.appendEvent(
          by,
          "goal_checks",
          p.run,
          goalChecks(contract, { kit: checkedKit, repo: kitRef.repo, commit: kitRef.commit }),
        );
      // Another run's untried experiments start this run's queue, in order, each with who added
      // it, why, its state and where it came from.
      for (const s of p.queue ?? [])
        this.queue.add(
          p.run,
          {
            title: s.title,
            details: s.details,
            family: s.family,
            why: s.why,
            by: s.by,
            state: s.state,
            from: s.from,
          },
          by,
        );
    });
    return {
      run: p.run,
      contract_sha: parsed.sha,
      ...(folder ? { start: { folder, commit: start } } : {}),
      imported,
      agents: p.agents !== false,
      ...(p.queue?.length ? { queue: p.queue.length } : {}),
      ...(p.briefing?.length ? { briefing: p.briefing.length } : {}),
    };
  }

  /** The MCP servers a run's kit names, with the agents that get each (none: an empty list). */
  mcpUses(run: string): McpUse[] {
    return (
      McpUses.safeParse(this.ledger.latestEventBody("mcp_servers", run)?.servers ?? []).data ?? []
    );
  }

  /**
   * Moves the champion to a confirmed attempt by compare-and-swap and points the champion ref
   * at it. Returns the current seq instead when the champion moved since the attempt was judged.
   */
  async promoteAttempt(input: {
    run: string;
    attempt: string;
    expectedSeq: number;
    by: string;
  }): Promise<{ promoted: true; seq: number } | { promoted: false; currentSeq: number }> {
    const a = this.ledger.getAttempt(input.attempt);
    if (!a) throw new LedgerError("not_found", `no attempt ${input.attempt}`);
    const r = this.ledger.promote({
      run: input.run,
      expectedSeq: input.expectedSeq,
      attempt: input.attempt,
      commitSha: String(a.commit_sha),
      by: input.by,
    });
    if (!r.ok) return { promoted: false, currentSeq: r.currentSeq };
    await this.syncChampionRef(input.run);
    this.ledger.setAttemptLifecycle(input.attempt, "promoted", input.by);
    // A new goal-campaign champion is validated afresh, so the goal tree reflects it.
    if (this.contractFor(input.run).mode === "goal") {
      this.ledger.enqueueJob({
        kind: "validate",
        priority: 60,
        spec: { run: input.run },
        actor: input.by,
      });
    }
    return { promoted: true, seq: r.seq };
  }

  // ------------------------------------------------------------ full reset

  /** Events that may follow the verified export without anything being lost in the wipe. */
  private static readonly HOUSEKEEPING = new Set([
    "command",
    "command_rejected",
    "run_status",
    "export_written",
    "champion_published",
    "wipe_requested",
  ]);

  /**
   * A full reset's wipe. Control has verified that the named export (a full one) reached the
   * results repository, and the owner confirmed it. The harness checks that the export exists,
   * was full, covers the events control names, and that nothing but housekeeping happened since.
   * The broker wipes at the next start (a marker is written and the controller exits), after
   * this command's result is delivered.
   */
  private requestWipe(
    p: z.infer<(typeof CommandPayloads)["wipe_state"]>,
    by: string,
    issuedAt: string,
  ): unknown {
    const exp = this.ledger.db
      .prepare("select id, through_event, manifest from export where path = ?")
      .get(p.export) as { id: number; through_event: number; manifest: string } | undefined;
    if (!exp) throw new Error(`no export ${p.export} in this rig`);
    if (!(JSON.parse(exp.manifest) as { full?: boolean }).full)
      throw new Error(`export ${p.export} is not a full export`);
    if (exp.through_event < p.through_event)
      throw new Error("the export does not cover the events");
    const since = (
      this.ledger.db
        .prepare("select kind, count(*) as n from event where id > ? group by kind")
        .all(exp.through_event) as { kind: string; n: number }[]
    ).filter((r) => !HarnessService.HOUSEKEEPING.has(r.kind));
    if (since.length) {
      throw new Error(
        `research was recorded after the export (${since.map((r) => `${r.kind} ${r.n}`).join(", ")}): export again`,
      );
    }
    for (const inst of this.ledger.listRuns()) {
      if (inst.status === "running") this.ledger.setRunStatus(inst.id, "paused", "wiping", by);
    }
    writeFileSync(
      join(this.paths.stateDir, WIPE_MARKER),
      // Commands issued before the wipe command (by control's clock) belonged to the old ledger.
      `${JSON.stringify({ export: p.export, by, at: new Date().toISOString(), not_before: issuedAt })}\n`,
    );
    this.ledger.appendEvent(by, "wipe_requested", null, { export: p.export });
    // Exit after the result is on its way back; the broker restarts the controller, which wipes.
    setTimeout(() => this.onWipe?.(), 2000).unref();
    return { wiping: true, export: p.export };
  }

  /** Called when a wipe was requested (the controller exits; tests observe it). */
  onWipe?: () => void;

  // ------------------------------------------------------------ rig checks

  /**
   * The checks this rig can run, wired in by the controller (main.ts): each may say why it
   * cannot start now (a busy rig), and runs in the background, reporting as an event.
   */
  rigChecks: Partial<Record<RigCheckName, RigCheck>> = {};

  /** Where the agents' model route comes from (control's route, else the rig's settings). */
  models: ModelSource | undefined;

  /**
   * Credentials the model proxy takes besides trials' tokens: one per check or planner call, with
   * the route it reaches when that is not the workers' (a planner's own model, goal 073).
   */
  private proxyTokens = new Map<string, { until: number; model?: ModelConfig | undefined }>();

  /**
   * A credential for the model proxy that lasts `ms` (a model check or a plan in OpenCode or
   * Codex). `model`: the route its calls reach; none, the workers' route at the time of each call.
   */
  mintProxyToken(model?: ModelConfig | undefined, ms = 15 * 60_000): string {
    const now = Date.now();
    for (const [t, v] of this.proxyTokens) if (v.until < now) this.proxyTokens.delete(t);
    const token = `proxy.${randomBytes(24).toString("hex")}`;
    this.proxyTokens.set(token, { until: now + ms, ...(model ? { model } : {}) });
    return token;
  }

  proxyTokenValid(token: string): boolean {
    const v = this.proxyTokens.get(token);
    return v !== undefined && v.until >= Date.now();
  }

  /** The route a minted credential reaches, when it was minted for one; else undefined. */
  proxyTokenModel(token: string): ModelConfig | undefined {
    const v = this.proxyTokens.get(token);
    return v && v.until >= Date.now() ? v.model : undefined;
  }

  /** Credentials the MCP gateway takes besides trials' tokens: the planner's, one per plan. */
  private mcpTokens = new Map<string, { caller: McpCaller; until: number }>();

  /** A credential for the MCP gateway, bound to one run and kind of agent, that lasts `ms`. */
  mintMcpToken(caller: McpCaller, ms = 15 * 60_000): string {
    const now = Date.now();
    for (const [t, v] of this.mcpTokens) if (v.until < now) this.mcpTokens.delete(t);
    const token = `mcp.${randomBytes(24).toString("hex")}`;
    this.mcpTokens.set(token, { caller, until: now + ms });
    return token;
  }

  /** Who a gateway credential is for, while it lasts. */
  mcpTokenCaller(token: string): McpCaller | undefined {
    const v = this.mcpTokens.get(token);
    return v && v.until >= Date.now() ? v.caller : undefined;
  }

  /** A trial's submission, once it has one: its attempt and where the attempt stands. */
  trialSubmission(trialId: string): { attempt: string; lifecycle: string } | undefined {
    const t = this.ledger.db.prepare("select attempt from trial where id = ?").get(trialId) as
      | { attempt: string | null }
      | undefined;
    if (!t?.attempt) return undefined;
    const a = this.ledger.getAttempt(t.attempt);
    return { attempt: t.attempt, lifecycle: String(a?.lifecycle ?? "recorded") };
  }

  /**
   * Takes the model route control set for this rig, or (null) goes back to the rig's own
   * settings. The record names the route, never its key. New plans and trials use it.
   */
  setModelRoute(
    route: ControlRoute | null,
    by: string,
    planner?: ControlRoute | null | undefined,
  ): ModelInfo {
    if (!this.models) throw new Error("this harness runs no agents");
    if (planner !== undefined) this.models.setPlanner(planner);
    if (route) this.models.set(route);
    else this.models.clear();
    const info = this.models.info();
    this.ledger.appendEvent(by, route ? "model_route_set" : "model_route_cleared", null, {
      ...info,
    });
    // A new model is checked at once (unless a check is running): its result shows on the
    // settings page without anyone pressing Check.
    if (info.source !== "none" && this.rigChecks.model) {
      if (this.checking) this.modelCheckWaits = true;
      else this.startRigCheck({ check: "model" }, "harness");
    }
    return info;
  }
  private checking: string | undefined;

  /**
   * After a restart: a check that was running when the controller stopped is over, and says so;
   * a smoke run it left open is closed. Runs the smoke paused stay paused for the operator.
   */
  reconcileRigChecks(): void {
    const open = new Map<string, string>();
    const rows = this.ledger.db
      .prepare(
        "select kind, body from event where kind in ('rig_check_started', 'rig_check_finished') order by id",
      )
      .all() as { kind: string; body: string }[];
    for (const e of rows) {
      const b = JSON.parse(e.body) as { id?: string; check?: string };
      if (e.kind === "rig_check_started" && b.id) open.set(b.id, String(b.check ?? ""));
      if (e.kind === "rig_check_finished" && b.id) open.delete(b.id);
    }
    for (const [id, check] of open) {
      this.ledger.appendEvent("harness", "rig_check_finished", null, {
        id,
        check,
        ok: false,
        summary:
          "interrupted: the controller restarted during the check (runs it paused stay paused)",
      });
    }
    for (const r of this.ledger.listRuns()) {
      if (r.id.startsWith("check-smoke-") && r.status !== "closed")
        this.ledger.setRunStatus(r.id, "closed", "its smoke check was interrupted", "harness");
    }
  }

  private startRigCheck(p: { check: RigCheckName; force?: boolean | undefined }, by: string) {
    const check = this.rigChecks[p.check];
    if (!check) throw new Error(`this rig cannot run the ${p.check} check`);
    if (this.checking) throw new Error(`the ${this.checking} check is still running`);
    const force = p.force === true;
    const notNow = force ? undefined : check.notNow?.();
    if (notNow) throw new Error(`not now: ${notNow}`);
    const id = `chk-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.checking = p.check;
    this.ledger.appendEvent(by, "rig_check_started", null, { id, check: p.check, force });
    const finish = (r: RigCheckReport) => {
      // The details stay bounded: an isolation report lists every probe of every role.
      const detail = r.detail ? JSON.stringify(r.detail) : undefined;
      this.ledger.appendEvent("harness", "rig_check_finished", null, {
        id,
        check: p.check,
        ok: r.ok,
        summary: r.summary.slice(0, 2000),
        ...(r.note ? { note: r.note } : {}),
        ...(detail
          ? { detail: detail.length > 60_000 ? `${detail.slice(0, 60_000)}…` : r.detail }
          : {}),
      });
    };
    this.checkRun = check
      .run({ force })
      .then(finish, (err: unknown) =>
        finish({ ok: false, summary: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => {
        this.checking = undefined;
        // A model route that arrived during another check is checked now.
        if (this.modelCheckWaits && this.rigChecks.model) {
          this.modelCheckWaits = false;
          this.startRigCheck({ check: "model" }, "harness");
        }
      });
    return { check: p.check, id, started: true };
  }
  private checkRun: Promise<void> | undefined;
  private modelCheckWaits = false;

  /** Whether a rig check runs now (a model check would have to wait). */
  modelCheckRunning(): boolean {
    return this.checking !== undefined;
  }

  /**
   * Checks the workers' model now, unless a check runs or this rig has none (goal 079: the
   * scheduler checks again while the agents are stopped). True when it started one.
   */
  checkModelNow(by: string): boolean {
    if (!this.rigChecks.model || this.checking) return false;
    try {
      this.startRigCheck({ check: "model" }, by);
      return true;
    } catch (err) {
      log("harness", "the model check did not start", { error: String(err) });
      return false;
    }
  }

  /**
   * A check at start, run before anything else and awaited. Forced: at start no trial or judge
   * job of this controller can be running. Never fatal: its result is its own event.
   */
  async checkAtStart(check: RigCheckName): Promise<void> {
    if (!this.rigChecks[check]) return;
    this.startRigCheck({ check, force: true }, "harness");
    await this.checkRun;
  }

  // ------------------------------------------------------------ audits, reviews, briefs

  /** What the supervisor's auditor sees for each open audit: the package and the diff. */
  async auditPackages(): Promise<
    (AuditPackage & {
      campaign_brief?: BriefData;
      diff: string;
      owner_messages: { id: number; at: string; text: string }[];
    })[]
  > {
    const audits = new Audits(this.ledger);
    const out: (AuditPackage & {
      campaign_brief?: BriefData;
      diff: string;
      owner_messages: { id: number; at: string; text: string }[];
    })[] = [];
    for (const id of audits.pending()) {
      const row = this.ledger.db.prepare("select attempt, run from audit where id = ?").get(id) as {
        attempt: string;
        run: string;
      };
      const inst = this.requireRun(row.run);
      // A closed run's audits are not the auditor's to decide (goal 087): nothing in it changes.
      if (inst.status === "closed") continue;
      const pkg = audits.package(id, this.contractFor(row.run));
      const a = this.ledger.getAttempt(row.attempt) as Record<string, unknown>;
      const diff = await patchBetween(
        this.mirrorFor(inst.seed_repo),
        String(a.parent_commit),
        String(a.commit_sha),
      );
      // The campaign's brief from its author, whole, before the diff (goal 078): a package too
      // long for the auditor's window is cut at its end.
      const brief = briefData(this.contractFor(row.run));
      out.push({
        ...pkg,
        ...(brief ? { campaign_brief: brief } : {}),
        diff: diff.slice(0, 200_000),
        // The owner's messages the auditor has not read (to it, or to all the advisors).
        owner_messages: this.ownerMessagesFor(row.run, "auditor"),
        ...this.backgroundFor(row.run),
      });
    }
    return out;
  }

  /**
   * Reviews waiting for the panel, each with the owner's messages the panel has not read: goal
   * reviews, and research reviews (goal 112) only for a supervisor that asks for them.
   */
  reviewPackages(kinds: readonly ReviewKind[] = ["goal"]): ((
    | ReviewPackage
    | ResearchReviewPackage
  ) & {
    campaign_brief?: BriefData;
    owner_messages: { id: number; at: string; text: string }[];
  })[] {
    return new Reviews(this.ledger).pending(kinds).map((pkg) => {
      // The campaign's brief from its author, whole, before the diff or the evidence (goal 078).
      const brief = briefData(this.contractFor(pkg.run));
      const extra = {
        ...(brief ? { campaign_brief: brief } : {}),
        owner_messages: this.ownerMessagesFor(pkg.run, "panel"),
        ...this.backgroundFor(pkg.run),
      };
      if (!("diff" in pkg)) return { ...pkg, ...extra };
      const { diff, ...r } = pkg;
      return {
        ...r,
        ...(brief ? { campaign_brief: brief } : {}),
        diff,
        owner_messages: extra.owner_messages,
        ...this.backgroundFor(pkg.run),
      };
    });
  }

  /** A run's background from past research, for an advisor's brief or package (when it has one). */
  /**
   * What an advisor's brief or package carries from past research: the background the owner
   * picked, and what the run's knowledge/ holds with how to search it (the supervisor gives the
   * advisors the search, read only). Both are data, never instructions.
   */
  private backgroundFor(run: string): {
    background?: ReturnType<typeof briefingData>;
    past_research?: string;
  } {
    const items = this.ledger.briefing(run);
    const knowledge = this.knowledge.summary(run);
    return {
      ...(items.length ? { background: briefingData(items) } : {}),
      ...(knowledge ? { past_research: pastResearchLine(knowledge, "tool") } : {}),
    };
  }

  private ownerMessagesFor(run: string, role: AdvisorRole) {
    return this.messages
      .waitingForAdvisor(run, role)
      .map((m) => ({ id: m.id, at: m.at, text: m.text }));
  }

  /**
   * The auditor's decision. Block holds the attempt for good (only the owner can override), with
   * the auditor's reasons; needs_owner sends it to the owner. Clear is the last step (goal 079,
   * the owner's decision of 2026-10-22): the win is promoted, even above the audit trigger or with
   * declared flaws, unless the run asks the owner.
   */
  async decideAudit(input: {
    attempt: string;
    decision: AuditDecision;
    reasons: string;
    citations: string[];
    auditor: string;
  }): Promise<unknown> {
    // A run closed after the auditor took its package (goal 087): its decision is not recorded.
    const held = this.ledger.getAttempt(input.attempt);
    if (held) this.decidingRun(String(held.run), "approve_promotion");
    const audit = new Audits(this.ledger).decide(input);
    const a = this.ledger.getAttempt(input.attempt) as Record<string, unknown>;
    const run = String(a.run);
    const expectedSeq = Number(audit.expected_seq);
    if (String(a.lifecycle) !== "awaiting_audit") {
      return { decision: input.decision, effect: `none: the attempt is ${a.lifecycle}` };
    }
    const toOwner = (why: string) => {
      this.ledger.tx(() => {
        this.ledger.appendEvent(input.auditor, "promotion_pending", input.attempt, {
          run,
          expected_seq: expectedSeq,
          commit: a.commit_sha,
          reason: why,
        });
        this.ledger.setAttemptLifecycle(input.attempt, "awaiting_approval", input.auditor);
      });
      return { decision: input.decision, effect: "waiting for the owner" };
    };
    if (input.decision === "block") {
      this.ledger.tx(() => {
        this.ledger.appendEvent(input.auditor, "promotion_blocked", input.attempt, {
          reason: `blocked by the audit: ${input.reasons.slice(0, 1000)}`,
        });
        this.ledger.setAttemptLifecycle(input.attempt, "audit_blocked", input.auditor);
      });
      return { decision: "block", effect: "blocked" };
    }
    if (input.decision === "needs_owner")
      return toOwner(`the auditor asked for the owner: ${input.reasons.slice(0, 600)}`);
    // The auditor's clear is the last step: the run's own rules decide (goal 079).
    return {
      decision: "clear",
      ...(await this.promoteOrAsk(
        input.attempt,
        run,
        expectedSeq,
        input.auditor,
        "the auditor's clear",
      )),
    };
  }

  /**
   * A run's target queue depth now (goal 081): the target, the lanes it is counted for (the
   * current round's, else the contract's), and how many experiments are ready for a lane, counted
   * as the planner's round counts them: queued, not handed out in the newest round, and in no
   * direction an AVOID rule in force names.
   */
  queueState(run: string): { target: number; lanes: number; ready: number } {
    const contract = this.contractFor(run);
    const epoch = new Registry(this.ledger).currentEpoch(run);
    const lanes = epoch?.assignments.length || contract.lanes.count;
    return {
      target: queueTarget(contract, lanes),
      lanes,
      ready: this.queue.ready(run, rulesInForce(this.ledger, run), handedOut(this.ledger, run))
        .length,
    };
  }

  /**
   * The newest time a planner's round left a run's queue below its target (goal 081), while it
   * still is: the supervisor then starts the teachers' round at once, not on the clock. None for
   * a run that is not running, has no agents or is a research run, or whose queue is at its
   * target again.
   */
  queueLow(
    run: string,
  ): { event: number; at: string; round: number; ready: number; target: number } | null {
    const inst = this.ledger.getRun(run);
    if (inst?.status !== "running" || !inst.agents || inst.mode === "research") return null;
    const e = this.ledger.db
      .prepare(
        "select id, at, body from event where kind = 'queue_low' and subject = ? order by id desc limit 1",
      )
      .get(run) as { id: number; at: string; body: string } | undefined;
    if (!e) return null;
    const now = this.queueState(run);
    if (now.ready >= now.target) return null;
    const b = JSON.parse(e.body) as { round?: number };
    return {
      event: Number(e.id),
      at: e.at,
      round: Number(b.round ?? 0),
      ready: now.ready,
      target: now.target,
    };
  }

  /**
   * The run's project mirror, for the teachers' code reads (goal 081). A research run has none: it
   * works on sources, not a repository, and its seed is a placeholder whose mirror was never made,
   * so Git would be started in a folder that does not exist.
   */
  private codeMirror(run: string): string {
    const inst = this.requireRun(run);
    if (inst.mode === "research")
      throw new LedgerError(
        "invalid",
        `run ${run} is a research run: it has no code to read. Its work is the sources, claims and notes in its research folder`,
      );
    return this.mirrorFor(inst.seed_repo);
  }

  /** The champion's commit and the run's project mirror, for the teachers' code reads (goal 081). */
  private championCode(run: string): { mirror: string; commit: string } {
    return {
      mirror: this.codeMirror(run),
      commit: this.ledger.currentChampion(run).commit_sha,
    };
  }

  /** The files of the champion's tree under a folder, for the teachers (goal 081). */
  codeFiles(run: string, folder: string): ReturnType<typeof listChampionFiles> {
    const c = this.championCode(run);
    return listChampionFiles(c.mirror, c.commit, folder);
  }

  /** One file of the champion's tree, by lines, for the teachers (goal 081). */
  codeFile(
    run: string,
    path: string,
    offset?: number,
    limit?: number,
  ): ReturnType<typeof readChampionFile> {
    const c = this.championCode(run);
    return readChampionFile(c.mirror, c.commit, path, offset, limit);
  }

  /** An attempt's diff, in parts, for the teachers (goal 081). */
  attemptDiff(run: string, attempt: string, offset?: number): ReturnType<typeof readAttemptDiff> {
    return readAttemptDiff(this.ledger, this.codeMirror(run), run, attempt, offset);
  }

  /**
   * The judge's public findings for the teachers (goal 081): one attempt in full, or the newest
   * attempts and the newest tried experiments, each with its cause. Never held-out results.
   */
  evidence(run: string, attempt?: string): unknown {
    this.requireRun(run);
    if (attempt) return oneAttempt(this.ledger, run, attempt);
    return {
      attempts: recentAttempts(this.ledger, run, { limit: 40, reasonChars: 2000 }),
      tried: triedCauses(this.ledger, this.queue, run, { limit: 40, causeChars: 1200 }),
    };
  }

  /**
   * The deterministic snapshot the teachers review: the campaign, the champion and its commit,
   * the direction registry, recent attempts with the judge's public reasons, the causes of the
   * experiments tried, epochs, the directives in force, the queue and its target, and what the
   * teachers proposed before (goal 081). Nothing from held-out cells (evidence.ts says how), and
   * no worker text beyond hypotheses and ideas, the field notes, and the run's own research
   * (goal 098): its counts, each question's coverage and the newest report, marked as data.
   */
  brief(run: string): unknown {
    const inst = this.requireRun(run);
    const contract = this.contractFor(run);
    const registry = new Registry(this.ledger);
    const champion = this.ledger.currentChampion(run);
    const epochs = (
      this.ledger.db
        .prepare("select * from epoch where run = ? order by n desc limit 5")
        .all(run) as Record<string, unknown>[]
    ).map((e) => ({
      n: Number(e.n),
      // A research run's rounds: by its planner (goals 047 and 117), or by its research plan in code.
      source:
        contract.mode === "research" && String(e.source) !== "planner"
          ? "research plan"
          : String(e.source),
      planner_valid: Number(e.planner_valid) === 1,
      violations: (JSON.parse(String(e.raw_violations)) as unknown[]).length,
      directives: JSON.parse(String(e.directives ?? "[]")) as number[],
      assignments: (
        JSON.parse(String(e.assignments)) as { lane: string; family: string; directive?: number }[]
      ).map((a) => ({ lane: a.lane, family: a.family, directive: a.directive ?? null })),
    }));
    const goals =
      contract.mode === "goal"
        ? (this.ledger.db.prepare("select id, status from goal where run = ?").all(run) as {
            id: string;
            status: string;
          }[])
        : undefined;
    const brief = briefData(contract);
    const research = this.runResearch.summary(run);
    return {
      rig: this.rig,
      run,
      campaign: inst.campaign,
      status: inst.status,
      mode: contract.mode,
      title: contract.title,
      objective:
        contract.mode === "hill_climb"
          ? contract.objective
          : contract.mode === "goal"
            ? contract.goals.map((g) => ({
                id: g.id,
                description: g.description,
                required: g.required,
              }))
            : { topic: contract.topic, questions: contract.questions },
      // What the run's own research holds (goal 098): a research run's always, a hill-climb or
      // goal run's when its trials recorded some. Short, before the long parts a window may cut;
      // the teachers' research tools read the rest.
      ...(research ? { research } : {}),
      // Where each question stands for the plan (goal 117): decided, saturated, the weight its card
      // gives it and its share of the last tasks. The teachers propose for the open ones.
      ...(contract.mode === "research"
        ? {
            question_state: stateBrief(
              researchState(this.ledger, run, contract, { lanes: contract.lanes.count }),
            ),
          }
        : {}),
      // The campaign's brief from its author, whole (goal 078): ahead of the long parts, so a
      // brief cut to the teacher's window loses the evidence first.
      ...(brief ? { campaign_brief: brief } : {}),
      editable_paths: "editable_paths" in contract ? contract.editable_paths : [],
      // Its commit: the tree the teachers read with their code tools (goal 081).
      champion: { seq: champion.seq, attempt: champion.attempt, commit: champion.commit_sha },
      families: registry.families(run),
      // The run's directions (goal 066). A rule may also name a new one: the planner designs it.
      directions: this.queue.directions(run),
      // The target the teachers keep the queue at, and how far below it the queue is now
      // (goal 081). Short, so it comes before the long parts, which a window may cut.
      queue_target: (() => {
        const q = this.queueState(run);
        return { ...q, below: q.ready < q.target, wanted: Math.max(0, q.target - q.ready) };
      })(),
      // What the teachers proposed before and what became of it: their portfolio is new since.
      teacher_ideas: this.queue
        .all(run)
        .filter((x) => x.added_by === "teacher")
        .slice(-30)
        .reverse()
        .map((x) => ({
          id: x.id,
          title: x.title,
          state: x.state,
          ...(x.result ? { result: x.result } : {}),
          ...(x.dropped_why ? { dropped: x.dropped_why.slice(0, 200) } : {}),
        })),
      // The newest attempts: the planner's evidence, with a refused change's violations and a
      // held-out failure's kind (goal 082), and the judge's public reasons (goal 081); the
      // teachers read each in full with their tools.
      evidence: recentAttempts(this.ledger, run, { limit: 20, reasonChars: 400 }),
      epochs,
      // A teachers' rule that freezes the queue or pins an experiment, set before code refused
      // them, is marked: it no longer reaches the planner (goal 081).
      directives: this.ledger.activeDirectives(run).map((d) => {
        const refused = d.author.startsWith("supervisor")
          ? ruleRefusal(d.body as StructuredDirective)
          : undefined;
        return {
          ...d,
          ...(isLegacyRule(d.body) ? { legacy: true } : {}),
          ...(refused ? { refused: refused.why } : {}),
        };
      }),
      // The run's experiment queue: the teachers may add experiments and move queued ones.
      queue: this.queue.brief(run),
      // Why each experiment tried ended as it did (goal 081).
      causes: triedCauses(this.ledger, this.queue, run, { limit: 20, causeChars: 400 }),
      ...(goals ? { goals } : {}),
      budget: {
        ...contract.budget,
        device_hours_used: this.ledger.deviceHours(run),
        tokens: registry.tokensUsed(run),
      },
      // The owner's messages to the teachers (to them, or to all the advisors): those they have not
      // read, to answer, and those they read in the last day.
      owner_messages: this.messages
        .forTeachers(run)
        .map((m) => ({ id: m.id, at: m.at, text: m.text, read: m.read })),
      // The run's newest field notes, by every writer: the agents' own words, as data.
      field_notes: { note: NOTES_ARE_DATA, notes: notesData(this.journal.newest(run, 20)) },
      ...this.backgroundFor(run),
    };
  }

  /**
   * Points the run's champion ref at the effective champion. The ledger is the authority;
   * the ref is for git consumers, so a failure here is recorded, never fatal.
   */
  async syncChampionRef(run: string): Promise<void> {
    const inst = this.requireRun(run);
    const champ = this.ledger.currentChampion(run);
    try {
      await updateRef(
        this.mirrorFor(inst.seed_repo),
        `refs/thermite/runs/${run}/champion`,
        champ.commit_sha,
      );
    } catch (err) {
      this.ledger.appendEvent("judge", "champion_ref_failed", run, {
        seq: champ.seq,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The owner approves a promotion: one waiting for approval, or one held or blocked by an audit
   * (the owner is above the auditor). Approving an attempt with declared flaws accepts them.
   * The judge's verdict must still be promotable; the ledger checks that.
   */
  private async approvePromotion(
    p: z.infer<(typeof CommandPayloads)["approve_promotion"]>,
    by: string,
  ): Promise<unknown> {
    this.decidingRun(p.run, "approve_promotion");
    const a = this.ledger.getAttempt(p.attempt);
    if (!a || String(a.run) !== p.run) {
      throw new Error(`attempt ${p.attempt} is not in ${p.run}`);
    }
    const lifecycle = String(a.lifecycle);
    let expectedSeq: number;
    if (lifecycle === "awaiting_approval") {
      expectedSeq = Number(
        this.ledger.latestEventBody("promotion_pending", p.attempt)?.expected_seq,
      );
    } else if (lifecycle === "awaiting_audit" || lifecycle === "audit_blocked") {
      expectedSeq = Number(new Audits(this.ledger).get(p.attempt)?.expected_seq);
    } else {
      throw new Error(`attempt ${p.attempt} is ${lifecycle}, not awaiting approval`);
    }
    if (!Number.isInteger(expectedSeq)) throw new Error(`no pending promotion for ${p.attempt}`);
    const flaws = (JSON.parse(String(a.known_flaws)) as unknown[]).length > 0;
    const setCleared = (v: string | null) =>
      this.ledger.db
        .prepare("update attempt set flaws_cleared_by = ? where id = ?")
        .run(v, p.attempt);
    // The owner's approval accepts declared flaws, but only if the promotion happens.
    if (flaws) setCleared(by);
    let r: Awaited<ReturnType<HarnessService["promoteAttempt"]>>;
    try {
      r = await this.promoteAttempt({ ...p, expectedSeq, by });
    } catch (err) {
      if (flaws) setCleared((a.flaws_cleared_by as string | null) ?? null);
      throw err;
    }
    if (r.promoted) {
      if (lifecycle !== "awaiting_approval")
        this.ledger.appendEvent(by, "audit_overridden", p.attempt, { lifecycle });
      if (flaws) this.ledger.appendEvent(by, "flaws_accepted", p.attempt, {});
      return r;
    }
    if (flaws) setCleared((a.flaws_cleared_by as string | null) ?? null);
    return this.rescreen(p.attempt, r.currentSeq, by);
  }

  /** The owner's no: the attempt never becomes the champion, and its open audit is over. */
  private declinePromotion(
    p: z.infer<(typeof CommandPayloads)["decline_promotion"]>,
    by: string,
  ): unknown {
    // A closed run's changes stay as they were (goal 087): its record does not change.
    this.decidingRun(p.run, "decline_promotion");
    const a = this.ledger.getAttempt(p.attempt);
    if (!a || String(a.run) !== p.run) throw new Error(`attempt ${p.attempt} is not in ${p.run}`);
    const lifecycle = String(a.lifecycle);
    if (!["awaiting_approval", "awaiting_audit", "audit_blocked"].includes(lifecycle))
      throw new Error(`attempt ${p.attempt} is ${lifecycle}: there is nothing to decline`);
    this.ledger.tx(() => {
      this.ledger.setAttemptLifecycle(p.attempt, "declined", by);
      this.ledger.appendEvent(by, "promotion_declined", p.attempt, {
        run: p.run,
        was: lifecycle,
        ...(p.note ? { note: p.note } : {}),
      });
    });
    return { attempt: p.attempt, declined: true, was: lifecycle };
  }

  /** The champion moved after a win was confirmed: it is screened again against the new one. */
  private rescreen(attempt: string, currentSeq: number, by: string): unknown {
    // Another path may have promoted it meanwhile (an audit clear and an approval racing).
    if (String(this.ledger.getAttempt(attempt)?.lifecycle) === "promoted") {
      return { promoted: true, note: "already promoted" };
    }
    this.ledger.enqueueJob({ attempt, kind: "evaluate", actor: by });
    this.ledger.setAttemptLifecycle(attempt, "queued", by);
    return { promoted: false, rescreen: true, champion_seq: currentSeq };
  }

  /**
   * Low-power steering from the teachers: one structured directive set, which
   * replaces the supervisor's previous set. Every directive needs a citation, and free-text notes
   * (planner only) are limited. Nothing here can touch a verdict, a contract or a worker's brief.
   */
  addDirectives(run: string, directives: unknown, author: string): number[] {
    return this.setAdvisorRules(run, directives, author).ids;
  }

  /**
   * addDirectives, with the rules it left out. A rule may name a direction the run doesn't have
   * yet: the planner designs it (goal 066). A research run has no planner, so there a rule for
   * another direction than a task kind is left out, recorded as a `directives_left_out` event
   * with why. A rule that freezes the queue's size or pins an experiment is left out the same
   * way (goal 081). The rest of the set stands.
   */
  setAdvisorRules(
    run: string,
    directives: unknown,
    author: string,
  ): { ids: number[]; left_out: { rule: string; why: string }[] } {
    const inst = this.requireRun(run);
    if (inst.status === "closed") throw new LedgerError("invalid", `run ${run} is closed`);
    const parsed = z.array(StructuredDirective).min(1).max(20).parse(directives);
    const uncited = parsed.filter((d) => !d.citations.length);
    if (uncited.length) {
      throw new LedgerError("invalid", `${uncited.length} directive(s) without a citation`);
    }
    if (parsed.filter((d) => d.kind === "note").length > 3) {
      throw new LedgerError("invalid", "at most 3 notes per directive set");
    }
    conflictCheck(parsed);
    type Rule = (typeof parsed)[number];
    // Rules that freeze the queue's size or pin an experiment (goal 081), each with why.
    const refused = new Map(
      parsed.flatMap((d) => {
        const r = ruleRefusal(d);
        return r ? [[d, r] as const] : [];
      }),
    );
    const research = this.contractFor(run).mode === "research";
    const known = this.queue.directions(run);
    const unknown = research ? unknownIn(parsed, known) : [];
    const unknownWhy = unknown.length ? researchDirectionRefusal(unknown) : "";
    const isUnknown = (d: Rule) => !!d.family && unknown.includes(d.family);
    const keep = parsed.filter((d) => !isUnknown(d) && !refused.has(d));
    const named = (d: Rule) =>
      `${d.kind}${d.family ? ` ${d.family}` : ""}${typeof d.value === "string" ? ` "${d.value.slice(0, 80)}"` : ""}`;
    return this.ledger.tx(() => {
      if (unknown.length)
        this.ledger.appendEvent(author, "directives_left_out", run, {
          rules: parsed.filter(isUnknown),
          why: unknownWhy,
          reason: "unknown_direction",
        });
      for (const reason of ["freezes_queue", "pins_experiment"] as const) {
        const rules = parsed.filter((d) => !isUnknown(d) && refused.get(d)?.reason === reason);
        const first = rules[0];
        if (first)
          this.ledger.appendEvent(author, "directives_left_out", run, {
            rules,
            why: refused.get(first)?.why ?? "",
            reason,
          });
      }
      return {
        ids: this.ledger.addDirectiveSet(run, author, keep, true),
        left_out: parsed
          .filter((d) => !keep.includes(d))
          .map((d) => ({
            rule: named(d),
            why: isUnknown(d) ? unknownWhy : (refused.get(d)?.why ?? ""),
          })),
      };
    });
  }

  /**
   * An advisor's additions and moves for a run's queue (the supervisor, for the teachers or
   * the auditor; the review panel judges goals and has no way into the queue): each recorded
   * with the role as who made it. Each move is
   * applied on its own; one that is refused (an unknown id, an experiment no longer queued) is
   * said in words and the others still apply.
   */
  advisorQueue(input: AdvisorQueueRequest): {
    added: string[];
    moved: string[];
    refused: string[];
  } {
    const p = AdvisorQueueRequest.parse(input);
    this.openRun(p.run);
    const actor = `supervisor:${p.role}`;
    const out = { added: [] as string[], moved: [] as string[], refused: [] as string[] };
    // A teacher's idea that repeats one waiting in the queue (up next, a lane's idea, or in
    // progress) is refused, with the one it repeats (goal 081): the portfolio is new ideas.
    const waiting = new Map(
      this.queue
        .all(p.run)
        .filter((x) => x.state === "queued" || x.state === "proposed" || x.state === "assigned")
        .map((x) => [ideaWords(x.title), x] as const),
    );
    const where: Record<string, string> = {
      queued: "up next",
      proposed: "a lane's idea",
      assigned: "in progress",
    };
    // A research run measures nothing (goal 117): an item that asks for a measurement is a next
    // experiment for the run's report, never a task for its queue.
    const research = this.ledger.getRun(p.run)?.mode === "research";
    for (const a of p.add) {
      const same = p.role === "teacher" ? waiting.get(ideaWords(a.title)) : undefined;
      if (same) {
        out.refused.push(
          `add "${a.title.slice(0, 120)}": it repeats ${same.id} (${where[same.state] ?? same.state})`,
        );
        continue;
      }
      const measures = research
        ? measurementIn([a.title, a.details ?? "", a.why].join("\n"))
        : undefined;
      if (measures) {
        out.refused.push(`add "${a.title.slice(0, 120)}": ${measurementRefusal(measures)}`);
        continue;
      }
      // A research run's task serves one question (goal 117): an item that names none, in its
      // question or a title labelled "Question N (index K)", is refused in words.
      if (research && a.question === undefined && labelledQuestion(a.title) === undefined) {
        out.refused.push(
          `add "${a.title.slice(0, 120)}": a research run's task names the question it serves (question, an index from 0)`,
        );
        continue;
      }
      // A question the run does not have, or one in a run whose tasks name none: refused in words.
      let x: Experiment;
      try {
        x = this.queue.add(p.run, { ...a, by: p.role, position: a.position }, actor);
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        out.refused.push(`add "${a.title.slice(0, 120)}": ${err.message}`);
        continue;
      }
      waiting.set(ideaWords(x.title), x);
      out.added.push(x.id);
    }
    for (const m of p.move) {
      try {
        this.queue.move(p.run, m.id, { by: p.role, position: m.position, why: m.why }, actor);
        out.moved.push(m.id);
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        out.refused.push(`move ${m.id}: ${err.message}`);
      }
    }
    return out;
  }

  /**
   * A worker's idea for its run's queue: proposed, by its lane, until the planner queues or drops
   * it (or the owner does first). The trial (found by its token) decides the run and the lane.
   * No limit on how many: none is set by default (the rules for every goal). In a research run,
   * an idea that asks for a measurement is refused in words (goal 117): it is a next experiment.
   */
  proposeIdea(token: string, input: unknown): { experiment: string; state: "proposed" } {
    const t = new Registry(this.ledger).openTrial(token);
    const idea = IdeaRequest.parse(input);
    if (this.ledger.getRun(t.run)?.mode === "research") {
      const measures = measurementIn(
        [idea.title, idea.details ?? "", idea.why ?? "", idea.family ?? ""].join("\n"),
      );
      if (measures) throw new LedgerError("invalid", measurementRefusal(measures));
    }
    const x = this.queue.add(
      t.run,
      { ...idea, by: t.lane, state: "proposed", trial: t.id },
      t.lane,
    );
    this.live.append({
      source: `trial:${t.id}`,
      kind: "status",
      text: `idea for the queue: ${x.title}`,
      lane: t.lane,
      run: t.run,
    });
    return { experiment: x.id, state: "proposed" };
  }

  /**
   * A worker's field note (`thermite-trial note`, or Pi's note tool). The trial (found by its
   * token) decides the run, the lane, the trial and who wrote it (the lane); the note cannot.
   * In a research run, a note that repeats one of the run's last NOTE_REPEATS field notes word
   * for word, once folded, is refused in words (goal 117).
   */
  writeTrialNote(token: string, input: unknown): { note: number } {
    const t = new Registry(this.ledger).openTrial(token);
    if (this.ledger.getRun(t.run)?.mode === "research") {
      const same = this.journal.repeatOf(t.run, Journal.parse(input).text, NOTE_REPEATS);
      if (same)
        throw new LedgerError(
          "invalid",
          `this note repeats field note #${same.id} (by ${same.by}, ${same.at}) word for word: it is not recorded again. Note what is new, or go on with the work`,
        );
    }
    const n = this.journal.write(t.run, input, {
      by: t.lane,
      actor: `trial:${t.id}`,
      source: `trial:${t.id}`,
      lane: t.lane,
      trial: t.id,
    });
    return { note: n.id };
  }

  /**
   * An advisor's field notes (the supervisor, after the advisor's review, audit or verdict was
   * posted): each recorded as written by `<role>:<name>`, leniently (journal.ts, writeAll).
   */
  advisorNotes(input: { run: string; role: AdvisorRole; by: string; notes: unknown[] }): {
    recorded: number[];
    problems: string[];
  } {
    this.requireRun(input.run);
    return this.journal.writeAll(input.run, input.notes, {
      by: `${input.role}:${input.by}`,
      actor: "supervisor",
      source: "supervisor",
    });
  }

  /**
   * Past research for a run's folder (the supervisor, from control's knowledge base): each item
   * a file under the run's knowledge/, overwritten when it changed. With `folders` (the campaign
   * folders the run may read now), a folder no longer among them is removed.
   */
  writeKnowledge(
    run: string,
    items: unknown[],
    folders?: string[] | undefined,
  ): { written: number; updated: number; removed: string[]; skipped: number } {
    this.requireRun(run);
    return this.knowledge.write(run, items, folders);
  }

  // ------------------------------------------------------------ attempts

  contractFor(run: string): Contract {
    const inst = this.requireRun(run);
    const c = this.ledger.getContract(inst.campaign, inst.version);
    if (!c) throw new LedgerError("not_found", `contract for ${run} missing`);
    return c;
  }

  /**
   * Preserves a submitted change as an attempt ref first, then applies V0 and duplicate checks.
   * Rejected and duplicate attempts are still recorded: nothing submitted is destroyed.
   */
  async submitAttempt(req: SubmitRequest, actor: string): Promise<SubmitResult> {
    const inst = this.requireRun(req.run);
    if (inst.status !== "running")
      throw new LedgerError("invalid", `run ${req.run} is ${inst.status}`);
    const contract = this.contractFor(req.run);
    if (contract.mode === "research")
      throw new LedgerError("invalid", "research campaigns take claims, not patches");
    const champion = this.ledger.currentChampion(req.run);
    const parent = req.parent ?? champion.commit_sha;
    const mirror = this.mirrorFor(inst.seed_repo);
    if (!(await hasCommit(mirror, parent)))
      throw new LedgerError("invalid", `unknown parent ${parent}`);
    const id = `a-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    let made: Awaited<ReturnType<typeof createAttemptCommit>>;
    try {
      made = await createAttemptCommit({
        mirror,
        scratchDir: join(this.paths.scratchDir, "attempts"),
        parent,
        patch: Buffer.from(req.patch_base64, "base64"),
        id,
        message: `thermite attempt ${id}\n\n${req.hypothesis}`,
      });
    } catch (err) {
      if (err instanceof GitError) {
        // Nothing to preserve (the patch did not apply), but the submission is still counted.
        this.ledger.appendEvent(actor, "submission_refused", req.run, {
          lane: req.lane ?? null,
          parent,
          diff_sha: sha256Hex(Buffer.from(req.patch_base64, "base64")),
          reason: err.message,
        });
        throw new LedgerError("invalid", err.message);
      }
      throw err;
    }
    const v0 = checkV0(
      contract,
      made.changedFiles,
      made.addedLines,
      made.binaryFiles,
      made.specialFiles,
    );
    const duplicateOf = this.ledger.findDuplicate(req.run, made.normalizedDiffSha);
    const lifecycle = !v0.ok ? "rejected_v0" : duplicateOf ? "duplicate" : "queued";
    // Lineage: the attempt this one was built on, whether or not it is the champion.
    const parentAttempt =
      parent === champion.commit_sha && champion.attempt
        ? champion.attempt
        : this.ledger.attemptByCommit(req.run, parent);
    const parentRef = parentAttempt
      ? `refs/thermite/attempts/${parentAttempt}`
      : `commit:${parent}`;
    this.ledger.recordAttempt(
      {
        id,
        run: req.run,
        lane: req.lane,
        parentRef,
        parentCommit: parent,
        parentAttempt,
        baselineChampionSeq: champion.seq,
        commitSha: made.commit,
        ref: made.ref,
        diffSha: made.diffSha,
        normalizedDiffSha: made.normalizedDiffSha,
        lifecycle,
        hypothesis: req.hypothesis,
        claim: req.claim,
        knownFlaws: req.known_flaws,
        v0,
        files: made.stat,
      },
      actor,
    );
    if (lifecycle === "queued") {
      // A hill climb in setup (goal 115): its starting point can't be measured yet, so a change
      // is judged by the baseline job, which makes the first one it can measure the starting
      // point. Otherwise the change is screened against the champion.
      const setup = baselineState(this.ledger, req.run)?.state === "setup";
      this.ledger.enqueueJob({
        attempt: id,
        kind: setup ? "baseline" : "evaluate",
        ...(setup ? { priority: BASELINE_PRIORITY } : {}),
        spec: { run: req.run, ...(setup ? { setup: true } : {}) },
        actor,
      });
    }
    return {
      attempt: id,
      lifecycle,
      commit: made.commit,
      violations: v0.violations,
      ...(duplicateOf ? { duplicate_of: duplicateOf } : {}),
    };
  }

  /**
   * A worker's submission. The trial (found by its token) decides the run, lane and parent;
   * the request cannot. A trial submits at most once, and never after it has ended, so a worker
   * that outlives its trial cannot add attempts.
   */
  async submitForTrial(
    token: string,
    req: Pick<SubmitRequest, "patch_base64" | "hypothesis" | "claim" | "known_flaws">,
  ): Promise<SubmitResult> {
    const registry = new Registry(this.ledger);
    const t = registry.openTrial(token);
    if (t.attempt || this.submitting.has(t.id)) {
      throw new LedgerError("conflict", `trial ${t.id} has already submitted`);
    }
    this.submitting.add(t.id);
    try {
      const r = await this.submitAttempt(
        SubmitRequest.parse({
          run: t.run,
          lane: t.lane,
          parent: t.parent,
          patch_base64: req.patch_base64,
          hypothesis: req.hypothesis,
          claim: req.claim,
          known_flaws: req.known_flaws ?? [],
        }),
        `trial:${t.id}`,
      );
      registry.linkAttempt(t.id, r.attempt);
      return r;
    } finally {
      this.submitting.delete(t.id);
    }
  }

  /**
   * What a proposer may see about an attempt: lifecycle, verdict and V0 findings, with the
   * violations of a refused change at the top (`violations`, all of them).
   */
  attemptStatus(id: string): unknown {
    const a = this.ledger.getAttempt(id);
    if (!a) throw new LedgerError("not_found", `no attempt ${id}`);
    const verdict = this.ledger.currentVerdict(id);
    const heldOut = this.ledger.heldOutFailure(id);
    return {
      attempt: id,
      run: a.run,
      lane: a.lane ?? null,
      lifecycle: a.lifecycle,
      commit: a.commit_sha,
      v0: a.v0 ? JSON.parse(String(a.v0)) : null,
      violations: violationsOf(a.v0),
      verdict: verdict ? { verdict: verdict.verdict } : null,
      // Only that a held-out check failed, and how (goal 082): never which cell, or why.
      held_out: heldOut ? heldOutWords(heldOut) : null,
    };
  }

  // ------------------------------------------------------------ live log and messages

  /** Lines of the live log after `after`, signed with the rig's key like a report. */
  liveBatch(after: number, limit: number): unknown {
    const { entries, next } = this.live.since(after, limit);
    const batch = { rig: this.rig, log_id: this.live.id, from: after, next, entries };
    return this.rigKeys
      ? {
          ...batch,
          rig_pubkey: this.rigKeys.publicKeyPem,
          signature: signJson(liveBody(batch), this.rigKeys.privateKeyPem),
        }
      : batch;
  }

  /**
   * A running trial's inbox: the owner's messages waiting for it (to the trial, its lane,
   * everyone working, or an earlier trial of its lane that ended before reading them), and how
   * its harness says it gave them to the agent. Only messages waiting for this trial can be
   * marked; a read is recorded only when they were given.
   */
  trialInbox(trial: { id: string; run: string; lane: string }): {
    waiting(): { id: number; text: string }[];
    given(ids: number[]): void;
  } {
    // Messages its brief already carries are not given again.
    const waiting = () => {
      const briefed = new Set(this.briefMessages.get(trial.id)?.ids ?? []);
      return this.messages.waitingForTrial(trial).filter((m) => !briefed.has(m.id));
    };
    return {
      waiting: () => waiting().map((m) => ({ id: m.id, text: messageText(m) })),
      given: (ids) => {
        const ok = new Set(waiting().map((m) => m.id));
        this.messages.read(
          ids.filter((id) => ok.has(id)),
          trial.lane,
          trial,
        );
      },
    };
  }

  /** The owner's messages a starting trial's brief carries: read once its agent is at work. */
  briefed(trial: { id: string; run: string; lane: string }, ids: number[]): void {
    if (ids.length) this.briefMessages.set(trial.id, { trial, ids });
  }

  /** A trial's agent is at work: the messages in its brief are read now. */
  trialAtWork(id: string): void {
    const b = this.briefMessages.get(id);
    if (!b) return;
    this.briefMessages.delete(id);
    this.messages.read(b.ids, b.trial.lane, b.trial);
  }

  /** A trial ended. Its brief's messages are read only if its agent ever got to work. */
  trialEnded(id: string, atWork: boolean): void {
    if (atWork) this.trialAtWork(id);
    this.briefMessages.delete(id);
  }

  /** A trial's own session lines and counters, as its harness reports them. */
  trialReport(
    trial: { id: string; run: string; lane: string },
    r: {
      entries?: { kind: LiveKind; text: string }[] | undefined;
      progress?:
        | { turns: number; tool_calls: number; tokens_in: number; tokens_out: number }
        | undefined;
    },
  ): void {
    if (r.progress) {
      this.trialProgress.set(trial.id, r.progress);
      // Kept in the trial's record too, so a restart that interrupts it keeps its counters
      // (goal 079).
      this.ledger.db
        .prepare(
          "update trial set turns = ?, tool_calls = ?, tokens_in = ?, tokens_out = ? where id = ? and ended_at is null",
        )
        .run(
          r.progress.turns,
          r.progress.tool_calls,
          r.progress.tokens_in,
          r.progress.tokens_out,
          trial.id,
        );
    }
    for (const e of r.entries ?? [])
      this.live.append({
        source: `trial:${trial.id}`,
        kind: e.kind,
        text: e.text,
        lane: trial.lane,
        run: trial.run,
      });
    if (r.entries?.length || r.progress?.turns || r.progress?.tokens_in) this.trialAtWork(trial.id);
  }

  /**
   * A trial waits for its provider and then goes on in the same conversation (goal 079): a line in
   * its session, and for a rate limit, a wait the scheduler and the research clock read: no new
   * trial starts before it ends, and a research run's clock stops meanwhile.
   */
  trialWait(
    trial: { id: string; run: string; lane: string },
    w: { until: string; kind: string; words: string },
  ): void {
    const at = new Date(w.until);
    const when = Number.isNaN(at.getTime()) ? w.until : at.toISOString().slice(11, 19);
    // A call broken off because its stream went silent (goal 079) says so in its own words.
    const silent = w.kind === "server" ? stalledFor(w.words) : undefined;
    if (silent !== undefined)
      log("harness", "a model call's stream went silent: retried", {
        trial: trial.id,
        run: trial.run,
        seconds: Number(silent),
      });
    this.live.append({
      source: `trial:${trial.id}`,
      kind: "status",
      text:
        silent !== undefined
          ? `the model's stream went silent for ${silent} s: retried at ${when} UTC, in the same conversation.`
          : `waiting until ${when} UTC: ${KIND_WORDS[w.kind as ProviderErrorKind] ?? w.kind} (${w.words.slice(0, 300)}). The trial goes on in the same conversation.`,
      lane: trial.lane,
      run: trial.run,
    });
    if (w.kind === "rate_limit" && !Number.isNaN(at.getTime()))
      this.ledger.appendEvent("scheduler", "agents_wait_for_limit", trial.run, {
        until: at.toISOString(),
        trial: trial.id,
        reason: w.words.slice(0, 600),
        in_trial: true,
      });
  }

  /** A trial's waiting messages, given to it now (each read at once). */
  takeMessages(trial: { id: string; run: string; lane: string }): string[] {
    const inbox = this.trialInbox(trial);
    const msgs = inbox.waiting();
    inbox.given(msgs.map((m) => m.id));
    return msgs.map((m) => m.text);
  }

  /** The planner's waiting messages, given to it now (each read at once). */
  takePlannerMessages(run: string): string[] {
    const msgs = this.messages.waitingForPlanner(run);
    this.messages.read(
      msgs.map((m) => m.id),
      "planner",
    );
    return msgs.map((m) => m.text);
  }

  /**
   * The advisors' receipts and answers (the supervisor, after an advisor ran with the messages
   * in its brief or package): every message must be in the run and addressed to the role.
   */
  advisorMessages(input: {
    run: string;
    role: AdvisorRole;
    read: number[];
    answers: { message: number; text: string; advisor?: string | undefined }[];
  }): { read: number; answers: number } {
    this.requireRun(input.run);
    const ids = [...new Set([...input.read, ...input.answers.map((a) => a.message)])];
    for (const id of ids) this.messages.requireFor(input.run, input.role, id);
    this.messages.read(input.read, input.role);
    for (const a of input.answers) this.messages.answer({ run: input.run, role: input.role, ...a });
    return { read: ids.length, answers: input.answers.length };
  }

  // ------------------------------------------------------------ snapshot and export

  /**
   * A page of events with the current summary, signed with the rig's own key so that control
   * can tell the harness's report from anything the supervisor (which relays it) might invent.
   */
  snapshot(cursor: number, limit: number): unknown {
    const page = this.ledger.eventsAfter(cursor, limit);
    const report = {
      rig: this.rig,
      ledger_id: this.ledger.ledgerId(),
      cursor,
      next: page.next,
      events: page.events,
      summary: {
        ...(this.ledger.summary() as Record<string, unknown>),
        ...(this.hardware ? { hardware: this.hardware } : {}),
        ...(this.build ? { build: this.build } : {}),
        // Which model route the agents use (its name and the key's hint, never the key).
        ...(this.models ? { model: this.models.info() } : {}),
        // What runs on this rig and how (Edit rig).
        settings: this.settings.get(),
        // What still runs, and whether the rig drains (goal 079): control restarts a draining
        // rig once nothing runs.
        work: this.work(),
        ...(this.gpuSplit ? { gpu_split: this.gpuSplit } : {}),
        ...(this.subscriptionUsage && this.models?.info().source !== "none"
          ? {
              subscription_usage: {
                ...this.subscriptionUsage,
                provider: this.models?.info().name ?? null,
              },
            }
          : {}),
      },
      generated_at: this.clock().toISOString(),
      latest_event: this.ledger.latestEventId(),
    };
    return this.rigKeys
      ? {
          ...report,
          rig_pubkey: this.rigKeys.publicKeyPem,
          signature: signJson(reportBody(report), this.rigKeys.privateKeyPem),
        }
      : report;
  }

  /**
   * Exports the supervisor has pushed (or committed, without a remote) leave the outbox, so it
   * does not grow forever. Only recorded export names are removed.
   */
  removeExports(names: string[]): number {
    let removed = 0;
    for (const name of names) {
      if (!/^[0-9TZ]+-[0-9a-f]{8}$/.test(name)) continue;
      const known = this.ledger.db.prepare("select 1 from export where path = ?").get(name);
      const dir = join(this.paths.outboxDir, name);
      if (!known || !existsSync(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  /**
   * An export for the supervisor to push. A full export (a full reset's, or the owner's choice
   * on Export) also carries the research archive and every run's research folder, and the
   * supervisor always pushes its ledger snapshot.
   */
  async export(actor: string, opts: { full?: boolean } = {}) {
    return writeExport({
      ledger: this.ledger,
      mirrorFor: (repo) => this.mirrorFor(repo),
      outboxDir: this.paths.outboxDir,
      rig: this.rig,
      actor,
      ...(opts.full ? { full: true, researchDir: join(this.paths.stateDir, "research") } : {}),
      researchFolder: this.researchFolder,
    });
  }
}
