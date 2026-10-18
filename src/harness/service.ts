import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../core/canonical.ts";
import {
  CommandPayloads,
  type Envelope,
  type ImportSpec,
  type KeyPairPem,
  reportBody,
  StructuredDirective,
  signJson,
  verifyCommand,
} from "../core/commands.ts";
import { type Contract, contractSha, parseContract } from "../core/contract.ts";
import type { Hardware } from "../core/hardware.ts";
import { LiveLog, liveBody } from "../core/live.ts";
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
import { type Kit, KitSchema, kitProblems } from "./kit.ts";
import { type Ledger, LedgerError } from "./ledger.ts";
import { writeExport } from "./outbox.ts";
import { receivePropagation } from "./propagation.ts";
import { Reviews } from "./reviews.ts";
import { RigSettingsStore } from "./rig-settings.ts";
import { checkV0 } from "./v0.ts";

/** A directive set may not both avoid a family and try or mandate it. */
function conflictCheck(set: { kind: string; family?: string | undefined }[]): void {
  const avoid = new Set(set.filter((d) => d.kind === "avoid" && d.family).map((d) => d.family));
  const both = set.filter((d) => (d.kind === "try" || d.kind === "mandate") && avoid.has(d.family));
  if (both.length) {
    throw new LedgerError(
      "invalid",
      `the set both avoids and asks for ${both.map((d) => d.family).join(", ")}`,
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
  "rig_settings",
]);

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
  /** The rig's own settings (Edit rig): parts on or off, workers at once, limits, promotion. */
  readonly settings: RigSettingsStore;
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
      });
    this.rig = input.rig;
    this.clock = input.clock ?? (() => new Date());
    this.ledger = input.ledger;
    this.paths = input.paths;
    this.controlPublicKeyPem = input.controlPublicKeyPem;
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
      case "message_agent": {
        const p = CommandPayloads.message_agent.parse(payload);
        this.requireRun(p.run);
        const r = this.ledger.db
          .prepare(
            "insert into agent_message (run, target, text, issued_by, created_at) values (?, ?, ?, ?, ?)",
          )
          .run(p.run, p.to, p.text, by, this.clock().toISOString());
        this.ledger.appendEvent(by, "agent_message", p.run, {
          to: p.to,
          chars: p.text.length,
        });
        this.live.append({
          source: p.to.startsWith("trial:") ? p.to : p.to === "planner" ? "planner" : "supervisor",
          kind: "message",
          text: `Owner to ${p.to}: ${p.text}`,
          run: p.run,
          ...(p.to.startsWith("lane-") ? { lane: p.to } : {}),
        });
        return { message: Number(r.lastInsertRowid), to: p.to };
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
        actor: by,
      });
    });
    return { run: p.run, contract_sha: parsed.sha, imported, agents: p.agents !== false };
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
  setModelRoute(route: ControlRoute | null, by: string): ModelInfo {
    if (!this.models) throw new Error("this harness runs no agents");
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
  async auditPackages(): Promise<(AuditPackage & { diff: string })[]> {
    const audits = new Audits(this.ledger);
    const out: (AuditPackage & { diff: string })[] = [];
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
      out.push({ ...pkg, diff: diff.slice(0, 200_000) });
    }
    return out;
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
      ...(goals ? { goals } : {}),
      budget: {
        ...contract.budget,
        device_hours_used: this.ledger.deviceHours(run),
        tokens: registry.tokensUsed(run),
      },
      // The owner's recent messages to the advisors (message_agent to "advisors").
      owner_messages: this.advisorMessages(run),
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
   * The owner's messages for a running trial: those sent to the trial itself or to its lane.
   * Each is delivered once and marked with the trial that took it.
   */
  takeMessages(trial: { id: string; run: string; lane: string }): string[] {
    return this.ledger.tx(() => {
      const rows = this.ledger.db
        .prepare(
          "select id, text from agent_message where run = ? and delivered_at is null and (target = ? or target = ?) order by id",
        )
        .all(trial.run, `trial:${trial.id}`, trial.lane) as { id: number; text: string }[];
      const mark = this.ledger.db.prepare(
        "update agent_message set delivered_at = ?, delivered_to = ? where id = ?",
      );
      for (const r of rows) mark.run(this.clock().toISOString(), `trial:${trial.id}`, r.id);
      return rows.map((r) => r.text);
    });
  }

  /** The owner's messages for the planner (delivered with the next plan). */
  takePlannerMessages(run: string): string[] {
    return this.ledger.tx(() => {
      const rows = this.ledger.db
        .prepare(
          "select id, text from agent_message where run = ? and target = 'planner' and delivered_at is null order by id",
        )
        .all(run) as { id: number; text: string }[];
      const mark = this.ledger.db.prepare(
        "update agent_message set delivered_at = ?, delivered_to = 'planner' where id = ?",
      );
      for (const r of rows) mark.run(this.clock().toISOString(), r.id);
      return rows.map((r) => r.text);
    });
  }

  /** The owner's recent messages for the advisors (shown in their brief for a day). */
  advisorMessages(run: string): { at: string; text: string }[] {
    const since = new Date(this.clock().getTime() - 24 * 3_600_000).toISOString();
    return (
      this.ledger.db
        .prepare(
          "select created_at as at, text from agent_message where run = ? and target = 'advisors' and created_at >= ? order by id desc limit 5",
        )
        .all(run, since) as { at: string; text: string }[]
    ).reverse();
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
    });
  }
}
