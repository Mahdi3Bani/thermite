import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../core/canonical.ts";
import {
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
import type { Hardware } from "../core/hardware.ts";
import { type LiveKind, LiveLog, liveBody } from "../core/live.ts";
import type { RigCheckReport } from "./agents/model-check.ts";
import type { ControlRoute, ModelInfo, ModelSource } from "./agents/model-source.ts";
import { Registry } from "./agents/registry.ts";
import { type AuditDecision, type AuditPackage, Audits } from "./audits.ts";
import { Conclusions } from "./conclusions.ts";
import {
  createAttemptCommit,
  GitError,
  hasCommit,
  initMirror,
  patchBetween,
  showFile,
  updateRef,
} from "./git.ts";
import { importBundle, importFile } from "./imports.ts";
import { Journal, NOTES_ARE_DATA, notesData } from "./journal.ts";
import { type Kit, KitSchema, kitProblems } from "./kit.ts";
import { briefingData, Knowledge, pastResearchLine } from "./knowledge.ts";
import { type Ledger, LedgerError } from "./ledger.ts";
import { type AdvisorRole, messageText, OwnerMessages } from "./messages.ts";
import { writeExport } from "./outbox.ts";
import { receivePropagation } from "./propagation.ts";
import { type Experiment, ExperimentInput, ExperimentQueue } from "./queue.ts";
import { folderRootOf } from "./research/folder.ts";
import { type ReviewPackage, Reviews } from "./reviews.ts";
import { RigSettingsStore } from "./rig-settings.ts";
import { checkV0 } from "./v0.ts";

/** A directive set may not both avoid a direction (a family, or the same words) and ask for it. */
function conflictCheck(
  set: { kind: string; family?: string | undefined; match?: string | undefined }[],
): void {
  const key = (d: { family?: string | undefined; match?: string | undefined }) =>
    d.family ? `family ${d.family}` : d.match ? `"${d.match.trim().toLowerCase()}"` : undefined;
  const avoid = new Set(set.filter((d) => d.kind === "avoid").map(key));
  avoid.delete(undefined);
  const both = set.filter((d) => (d.kind === "try" || d.kind === "mandate") && avoid.has(key(d)));
  if (both.length) {
    throw new LedgerError(
      "invalid",
      `the set both avoids and asks for ${both.map((d) => d.family ?? d.match).join(", ")}`,
    );
  }
}

/** Command kinds only the owner may issue (control records the issuer in the signed envelope). */
const OWNER_ONLY = new Set([
  "approve_promotion",
  "decline_promotion",
  "accept_review",
  "conclude",
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
]);

/** An advisor's additions and moves for a run's queue (the supervisor's /v1/queue). */
export const AdvisorQueueRequest = z.strictObject({
  run: z.string().min(1).max(100),
  /** The advisor role that proposes them: it is recorded as who added or moved each one. */
  role: z.enum(["teacher", "auditor", "panel"]),
  add: z
    .array(
      z.strictObject({
        title: ExperimentText.title,
        details: ExperimentText.details.optional(),
        family: ExperimentText.family.optional(),
        why: z.string().trim().min(1).max(2000),
        position: QueuePosition.optional(),
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
  /** Past research in each run's research folder (knowledge/), as the supervisor syncs it. */
  readonly knowledge: Knowledge;
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
  /** A research run's folder as files, for its export (main.ts sets it). */
  researchFolder?: ((run: string) => { root: string; files: string[] }) | undefined;
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
        trial_minutes: 20,
        max_turns: null,
        promotion: input.promotion ?? "owner_approval",
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
    // The same folders as the research folder's (main.ts): scratch/research/<run>/knowledge.
    this.knowledge = new Knowledge({
      stateRoot: join(this.paths.stateDir, "knowledge"),
      folderRoot: (run) => folderRootOf(join(this.paths.scratchDir, "research"), run),
    });
  }

  /** A run's promotion policy: its own, chosen when it was assigned, or the rig's default. */
  promotionFor(run: string): "auto" | "owner_approval" {
    return this.ledger.getRun(run)?.promotion ?? this.promotion;
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
      case "pause_run": {
        const p = CommandPayloads.pause_run.parse(payload);
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
      case "redirect": {
        const p = CommandPayloads.redirect.parse(payload);
        this.requireRun(p.run);
        conflictCheck(p.directives);
        const ids = this.ledger.addDirectiveSet(p.run, by, p.directives, p.replace);
        return { run: p.run, directives: ids };
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
        this.requireRun(p.run);
        this.ledger.dropDirective(p.run, p.id, by);
        return { run: p.run, dropped: p.id };
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
        this.requireRun(p.run);
        new Reviews(this.ledger).ownerDecision(p.review, p.run, p.accept, p.note, by);
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
        this.requireRun(p.run);
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

  /** A run whose queue may still change: one that exists and is not closed. */
  private openRun(id: string) {
    const inst = this.requireRun(id);
    if (inst.status === "closed")
      throw new LedgerError("invalid", `run ${id} is closed: its queue no longer changes`);
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
    for (const [i, s] of (p.queue ?? []).entries()) {
      const ok = ExperimentInput.safeParse(s);
      if (!ok.success)
        throw new Error(`queue experiment ${i + 1}: ${ok.error.issues[0]?.message ?? "invalid"}`);
    }
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
    }
    if (contract.mode !== "research") {
      const mirror = this.mirrorFor(seed.repo);
      if (!(await hasCommit(mirror, seed.commit))) {
        throw new Error(
          `seed commit ${seed.commit} is not in ${seed.repo}; import its bundle first`,
        );
      }
      // The ref first: if the ledger write below fails, a retry simply overwrites it.
      await updateRef(mirror, `refs/thermite/runs/${p.run}/champion`, seed.commit);
    }
    this.ledger.tx(() => {
      this.ledger.storeContract(contract, parsed.sha, by);
      this.pauseOthers(p.run, by);
      this.ledger.createRun({
        id: p.run,
        contract,
        contractSha: parsed.sha,
        seedRepo: seed.repo,
        seedCommit: seed.commit,
        direction: p.direction,
        agents: p.agents,
        promotion: p.promotion,
        // The background the owner picked from past research: every agent's brief shows it.
        briefing: p.briefing?.map((b) => ({ text: b.text, from: b.from })),
        actor: by,
      });
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
      imported,
      agents: p.agents !== false,
      ...(p.queue?.length ? { queue: p.queue.length } : {}),
      ...(p.briefing?.length ? { briefing: p.briefing.length } : {}),
    };
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

  /** Credentials the model proxy takes besides trials' tokens: one per check or planner call. */
  private proxyTokens = new Map<string, number>();

  /** A credential for the model proxy that lasts `ms` (an OpenCode model check or plan). */
  mintProxyToken(ms = 15 * 60_000): string {
    const now = Date.now();
    for (const [t, until] of this.proxyTokens) if (until < now) this.proxyTokens.delete(t);
    const token = `proxy.${randomBytes(24).toString("hex")}`;
    this.proxyTokens.set(token, now + ms);
    return token;
  }

  proxyTokenValid(token: string): boolean {
    const until = this.proxyTokens.get(token);
    return until !== undefined && until >= Date.now();
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
    (AuditPackage & { diff: string; owner_messages: { id: number; at: string; text: string }[] })[]
  > {
    const audits = new Audits(this.ledger);
    const out: (AuditPackage & {
      diff: string;
      owner_messages: { id: number; at: string; text: string }[];
    })[] = [];
    for (const id of audits.pending()) {
      const row = this.ledger.db.prepare("select attempt, run from audit where id = ?").get(id) as {
        attempt: string;
        run: string;
      };
      const pkg = audits.package(id, this.contractFor(row.run));
      const a = this.ledger.getAttempt(row.attempt) as Record<string, unknown>;
      const inst = this.requireRun(row.run);
      const diff = await patchBetween(
        this.mirrorFor(inst.seed_repo),
        String(a.parent_commit),
        String(a.commit_sha),
      );
      out.push({
        ...pkg,
        diff: diff.slice(0, 200_000),
        // The owner's messages the auditor has not read (to it, or to all the advisors).
        owner_messages: this.ownerMessagesFor(row.run, "auditor"),
        ...this.backgroundFor(row.run),
      });
    }
    return out;
  }

  /** Reviews waiting for the panel, each with the owner's messages the panel has not read. */
  reviewPackages(): (ReviewPackage & {
    owner_messages: { id: number; at: string; text: string }[];
  })[] {
    return new Reviews(this.ledger).pending().map((r) => ({
      ...r,
      owner_messages: this.ownerMessagesFor(r.run, "panel"),
      ...this.backgroundFor(r.run),
    }));
  }

  /** A run's background from past research, for an advisor's brief or package (when it has one). */
  private backgroundFor(run: string): { background?: ReturnType<typeof briefingData> } {
    const items = this.ledger.briefing(run);
    return items.length ? { background: briefingData(items) } : {};
  }

  private ownerMessagesFor(run: string, role: AdvisorRole) {
    return this.messages
      .waitingForAdvisor(run, role)
      .map((m) => ({ id: m.id, at: m.at, text: m.text }));
  }

  /**
   * The auditor's decision. Block holds the attempt for good (only the owner can override);
   * needs_owner sends it to the owner; clear returns it to the promotion policy, except that
   * declared flaws always go to the owner: an audit can block, never pass.
   */
  async decideAudit(input: {
    attempt: string;
    decision: AuditDecision;
    reasons: string;
    citations: string[];
    auditor: string;
  }): Promise<unknown> {
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
          reason: "blocked by the audit",
        });
        this.ledger.setAttemptLifecycle(input.attempt, "audit_blocked", input.auditor);
      });
      return { decision: "block", effect: "blocked" };
    }
    if (input.decision === "needs_owner") return toOwner("the auditor asked for the owner");
    if (String(audit.trigger) === "known_flaws") return toOwner("declared flaws need the owner");
    // A gain above the absolute trigger always needs the owner; a model never decides it.
    if (String(audit.trigger) === "absolute") return toOwner("a gain this large needs the owner");
    if (this.promotionFor(run) === "owner_approval")
      return toOwner("promotion policy: owner approval");
    const r = await this.promoteAttempt({
      run,
      attempt: input.attempt,
      expectedSeq,
      by: input.auditor,
    });
    if (r.promoted) return { decision: "clear", effect: "promoted", seq: r.seq };
    return {
      decision: "clear",
      ...(this.rescreen(input.attempt, r.currentSeq, input.auditor) as object),
    };
  }

  /**
   * The deterministic snapshot the supervisor's teacher pair reviews: the campaign, the champion,
   * the direction registry, recent evidence, epochs and the directives in force. Nothing from
   * held-out cells, and no worker text beyond hypotheses.
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
      source: String(e.source),
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
    const knowledge = this.knowledge.summary(run);
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
      editable_paths: "editable_paths" in contract ? contract.editable_paths : [],
      champion: { seq: champion.seq, attempt: champion.attempt },
      families: registry.families(run),
      evidence: registry.evidence(run, 40),
      epochs,
      directives: this.ledger.activeDirectives(run),
      // The run's experiment queue: the teachers may add experiments and move queued ones.
      queue: this.queue.brief(run),
      ...(goals ? { goals } : {}),
      budget: {
        ...contract.budget,
        device_hours_used: this.ledger.deviceHours(run),
        tokens: registry.tokensUsed(run),
      },
      // The owner's messages to the teacher pair (to it, or to all the advisors): those it has not
      // read, to answer, and those it read in the last day.
      owner_messages: this.messages
        .forTeachers(run)
        .map((m) => ({ id: m.id, at: m.at, text: m.text, read: m.read })),
      // The run's newest field notes, by every writer: the agents' own words, as data.
      field_notes: { note: NOTES_ARE_DATA, notes: notesData(this.journal.newest(run, 20)) },
      ...this.backgroundFor(run),
      ...(knowledge ? { past_research: pastResearchLine(knowledge, "advisor") } : {}),
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
   * Low-power steering from the supervisor's teacher pair: one structured directive set, which
   * replaces the supervisor's previous set. Every directive needs a citation, and free-text notes
   * (planner only) are limited. Nothing here can touch a verdict, a contract or a worker's brief.
   */
  addDirectives(run: string, directives: unknown, author: string): number[] {
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
    return this.ledger.addDirectiveSet(run, author, parsed, true);
  }

  /**
   * An advisor's additions and moves for a run's queue (the supervisor, for the teacher pair,
   * the auditor or the review panel): each recorded with the role as who made it. Each move is
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
    for (const a of p.add)
      out.added.push(this.queue.add(p.run, { ...a, by: p.role, position: a.position }, actor).id);
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
   * No limit on how many: none is set by default (the rules for every goal).
   */
  proposeIdea(token: string, input: unknown): { experiment: string; state: "proposed" } {
    const t = new Registry(this.ledger).openTrial(token);
    const idea = IdeaRequest.parse(input);
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
   */
  writeTrialNote(token: string, input: unknown): { note: number } {
    const t = new Registry(this.ledger).openTrial(token);
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
   * a file under the run's knowledge/, overwritten when it changed.
   */
  writeKnowledge(run: string, items: unknown[]): { written: number; updated: number } {
    this.requireRun(run);
    return this.knowledge.write(run, items);
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
      this.ledger.enqueueJob({
        attempt: id,
        kind: "evaluate",
        spec: { run: req.run },
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

  /** What a proposer may see about its own attempt: lifecycle, verdict and V0 findings. */
  attemptStatus(id: string): unknown {
    const a = this.ledger.getAttempt(id);
    if (!a) throw new LedgerError("not_found", `no attempt ${id}`);
    const verdict = this.ledger.currentVerdict(id);
    return {
      attempt: id,
      run: a.run,
      lifecycle: a.lifecycle,
      commit: a.commit_sha,
      v0: a.v0 ? JSON.parse(String(a.v0)) : null,
      verdict: verdict ? { verdict: verdict.verdict } : null,
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
    if (r.progress) this.trialProgress.set(trial.id, r.progress);
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
        // Which model route the agents use (its name and the key's hint, never the key).
        ...(this.models ? { model: this.models.info() } : {}),
        // What runs on this rig and how (Edit rig).
        settings: this.settings.get(),
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
   * An export for the supervisor to push. A full export (a full reset's) also carries the
   * research archive, and the supervisor always pushes its ledger snapshot.
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
