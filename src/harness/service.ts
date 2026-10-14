import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { Registry } from "./agents/registry.ts";
import { type AuditDecision, type AuditPackage, Audits } from "./audits.ts";
import { Conclusions } from "./conclusions.ts";
import {
  createAttemptCommit,
  GitError,
  hasCommit,
  initMirror,
  patchBetween,
  updateRef,
} from "./git.ts";
import { importBundle, importFile } from "./imports.ts";
import { type Ledger, LedgerError } from "./ledger.ts";
import { writeExport } from "./outbox.ts";
import { receivePropagation } from "./propagation.ts";
import { Reviews } from "./reviews.ts";
import { checkV0 } from "./v0.ts";

/** Written by an accepted wipe_state; the next controller start wipes the state and removes it. */
export const WIPE_MARKER = "WIPE_REQUESTED";

/**
 * Carries out a requested wipe at start: everything in the state directory goes except the
 * unit's signing key (its identity stays), and the scratch directory is emptied. Returns
 * whether a wipe happened.
 */
export function wipeIfRequested(paths: HarnessPaths, keep: string[]): boolean {
  const marker = join(paths.stateDir, WIPE_MARKER);
  if (!existsSync(marker)) return false;
  for (const name of readdirSync(paths.stateDir)) {
    if (name === WIPE_MARKER) continue;
    if (name === "ledger") {
      for (const f of readdirSync(join(paths.stateDir, name))) {
        if (!keep.includes(f))
          rmSync(join(paths.stateDir, name, f), { recursive: true, force: true });
      }
      continue;
    }
    rmSync(join(paths.stateDir, name), { recursive: true, force: true });
  }
  // Scratch, and the outbox: its exports reached the results repository before the wipe.
  for (const dir of [paths.scratchDir, paths.outboxDir]) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  rmSync(marker, { force: true });
  return true;
}

export interface HarnessPaths {
  stateDir: string;
  scratchDir: string;
  inboxDir: string;
  outboxDir: string;
}

export type CommandOutcome =
  | { status: "applied" | "replayed"; accepted: boolean; result: unknown }
  | { status: "rejected"; reason: string }
  /** The same command is being applied by another request; ask again later. */
  | { status: "in_progress" };

export const SubmitRequest = z.object({
  instance: z.string().min(1),
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
  readonly unit: string;
  readonly ledger: Ledger;
  readonly paths: HarnessPaths;
  private readonly controlPublicKeyPem: string;
  private readonly clock: () => Date;
  private readonly unitKeys: KeyPairPem | undefined;
  /** Commands being applied right now, so a concurrent re-send cannot run one twice. */
  private readonly inFlight = new Set<string>();
  /** Trials whose submission is being recorded right now. */
  private readonly submitting = new Set<string>();
  /** D8: what happens to a confirmed win (and to one an audit cleared). */
  readonly promotion: "auto" | "owner_approval";

  constructor(input: {
    unit: string;
    ledger: Ledger;
    paths: HarnessPaths;
    controlPublicKeyPem: string;
    clock?: (() => Date) | undefined;
    /** The unit's report-signing key (generated once, kept in the private state). */
    unitKeys?: KeyPairPem | undefined;
    promotion?: "auto" | "owner_approval" | undefined;
  }) {
    this.unitKeys = input.unitKeys;
    this.promotion = input.promotion ?? "owner_approval";
    this.unit = input.unit;
    this.clock = input.clock ?? (() => new Date());
    this.ledger = input.ledger;
    this.paths = input.paths;
    this.controlPublicKeyPem = input.controlPublicKeyPem;
  }

  mirrorFor(repo: string): string {
    return join(this.paths.stateDir, "git", `${repo}.git`);
  }

  // ------------------------------------------------------------ commands

  async applyCommand(input: unknown, actor = "supervisor"): Promise<CommandOutcome> {
    const verified = verifyCommand(input, this.controlPublicKeyPem, this.unit, this.clock());
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
    switch (envelope.kind) {
      case "assign_campaign":
        return this.assignCampaign(CommandPayloads.assign_campaign.parse(payload), by);
      case "pause_instance": {
        const p = CommandPayloads.pause_instance.parse(payload);
        this.ledger.setInstanceStatus(p.instance, "paused", p.reason, by);
        return { instance: p.instance, status: "paused" };
      }
      case "resume_instance": {
        const p = CommandPayloads.resume_instance.parse(payload);
        const inst = this.requireInstance(p.instance);
        if (inst.status === "closed") throw new Error(`instance ${p.instance} is closed`);
        // One running instance per unit: resuming one pauses the others.
        this.ledger.tx(() => {
          this.pauseOthers(p.instance, by);
          this.ledger.setInstanceStatus(p.instance, "running", null, by);
        });
        return { instance: p.instance, status: "running" };
      }
      case "redirect": {
        const p = CommandPayloads.redirect.parse(payload);
        this.requireInstance(p.instance);
        const ids = this.ledger.addDirectiveSet(p.instance, by, p.directives, p.replace);
        return { instance: p.instance, directives: ids };
      }
      case "reset_workers": {
        // The scheduler acts on the event: it kills the instance's running trials, clears the
        // lane bests and ends the epoch, so lanes start again from the champion.
        const p = CommandPayloads.reset_workers.parse(payload);
        this.requireInstance(p.instance);
        if (p.reseed_commit)
          throw new Error("re-seeding lanes is not available in this version; reset without it");
        this.ledger.appendEvent(by, "workers_reset", p.instance, {});
        return { instance: p.instance, reset: true };
      }
      case "propagate":
        return receivePropagation(this, CommandPayloads.propagate.parse(payload), by);
      case "export_now": {
        const r = await this.export(by);
        return {
          export: r.dir.split("/").pop(),
          export_id: r.id,
          through_event: this.ledger.lastExport()?.through_event ?? 0,
          attempts: r.attempts,
          events: r.events,
        };
      }
      case "wipe_state":
        return this.requestWipe(CommandPayloads.wipe_state.parse(payload), by);
      case "approve_promotion":
        return this.approvePromotion(CommandPayloads.approve_promotion.parse(payload), by);
      case "accept_review": {
        const p = CommandPayloads.accept_review.parse(payload);
        this.requireInstance(p.instance);
        new Reviews(this.ledger).ownerDecision(p.review, p.instance, p.accept, p.note, by);
        // The goal tree is checked again with the owner's word.
        this.ledger.enqueueJob({
          kind: "validate",
          priority: 40,
          spec: { instance: p.instance },
          actor: by,
        });
        return { review: p.review, decision: p.accept ? "accepted" : "rejected" };
      }
      case "conclude": {
        const p = CommandPayloads.conclude.parse(payload);
        this.requireInstance(p.instance);
        return new Conclusions(this.ledger).decide(p.instance, p.proposal, p.accept, p.note, by);
      }
    }
  }

  private pauseOthers(instance: string, by: string): void {
    for (const other of this.ledger.listInstances()) {
      if (other.status === "running" && other.id !== instance) {
        this.ledger.setInstanceStatus(other.id, "paused", `replaced by ${instance}`, by);
      }
    }
  }

  private requireInstance(id: string) {
    const inst = this.ledger.getInstance(id);
    if (!inst) throw new LedgerError("not_found", `no instance ${id}`);
    return inst;
  }

  private async runImport(
    spec: ImportSpec,
    repoHint: string,
    actor: string,
  ): Promise<Record<string, string>> {
    const importId = randomUUID().slice(0, 12);
    switch (spec.kind) {
      case "repo_bundle":
      case "kit_bundle": {
        const repo = spec.kind === "kit_bundle" ? `kit-${spec.repo}` : spec.repo || repoHint;
        const mirror = this.mirrorFor(repo);
        await initMirror(mirror);
        const r = await importBundle({
          inboxDir: this.paths.inboxDir,
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

  private async assignCampaign(
    p: z.infer<(typeof CommandPayloads)["assign_campaign"]>,
    by: string,
  ): Promise<unknown> {
    const parsed = parseContract(p.contract);
    if (!parsed.ok) throw new Error(`invalid contract: ${parsed.errors.join("; ")}`);
    if (parsed.sha !== p.contract_sha) throw new Error("contract hash does not match contract_sha");
    const contract = parsed.contract;
    // Validate everything before changing anything: a refused assign leaves no trace but events.
    if (this.ledger.getInstance(p.instance))
      throw new Error(`instance ${p.instance} already exists`);
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
    for (const spec of p.imports) imported.push(await this.runImport(spec, seed.repo, by));
    for (const m of contract.models) {
      if (!this.ledger.findImport("model", { sha256: m.sha256 })) {
        throw new Error(`model ${m.name} (${m.sha256}) has not been imported`);
      }
    }
    if (contract.mode !== "research") {
      const mirror = this.mirrorFor(seed.repo);
      if (!(await hasCommit(mirror, seed.commit))) {
        throw new Error(
          `seed commit ${seed.commit} is not in ${seed.repo}; import its bundle first`,
        );
      }
      // The ref first: if the ledger write below fails, a retry simply overwrites it.
      await updateRef(mirror, `refs/thermite/instances/${p.instance}/champion`, seed.commit);
    }
    this.ledger.tx(() => {
      this.ledger.storeContract(contract, parsed.sha, by);
      this.pauseOthers(p.instance, by);
      this.ledger.createInstance({
        id: p.instance,
        contract,
        contractSha: parsed.sha,
        seedRepo: seed.repo,
        seedCommit: seed.commit,
        direction: p.direction,
        actor: by,
      });
    });
    return { instance: p.instance, contract_sha: parsed.sha, imported };
  }

  /**
   * Moves the champion to a confirmed attempt by compare-and-swap and points the champion ref
   * at it. Returns the current seq instead when the champion moved since the attempt was judged.
   */
  async promoteAttempt(input: {
    instance: string;
    attempt: string;
    expectedSeq: number;
    by: string;
  }): Promise<{ promoted: true; seq: number } | { promoted: false; currentSeq: number }> {
    const a = this.ledger.getAttempt(input.attempt);
    if (!a) throw new LedgerError("not_found", `no attempt ${input.attempt}`);
    const r = this.ledger.promote({
      instance: input.instance,
      expectedSeq: input.expectedSeq,
      attempt: input.attempt,
      commitSha: String(a.commit_sha),
      by: input.by,
    });
    if (!r.ok) return { promoted: false, currentSeq: r.currentSeq };
    await this.syncChampionRef(input.instance);
    this.ledger.setAttemptLifecycle(input.attempt, "promoted", input.by);
    // A new goal-campaign champion is validated afresh, so the goal tree reflects it.
    if (this.contractFor(input.instance).mode === "goal") {
      this.ledger.enqueueJob({
        kind: "validate",
        priority: 60,
        spec: { instance: input.instance },
        actor: input.by,
      });
    }
    return { promoted: true, seq: r.seq };
  }

  // ------------------------------------------------------------ full reset

  /** Event kinds that are research: losing any of them in a wipe is refused. */
  private static readonly RESEARCH_EVENTS = [
    "attempt_recorded",
    "verdict",
    "champion_promoted",
    "claim_added",
    "source_fetched",
    "goal_report",
    "review_panel",
    "review_decided",
    "conclusion_proposed",
  ];

  /**
   * A full reset's wipe. Control has verified that the named export reached the results
   * repository; the harness checks that it is its own latest export, covers the events control
   * names, and that no research was recorded since. The wipe itself happens at the next start
   * (a marker is written and the controller exits), after this command's result is delivered.
   */
  private requestWipe(p: z.infer<(typeof CommandPayloads)["wipe_state"]>, by: string): unknown {
    const last = this.ledger.lastExport();
    const name = last
      ? String(
          (
            this.ledger.db.prepare("select path from export where id = ?").get(last.id) as {
              path: string;
            }
          ).path,
        )
      : undefined;
    if (!last || name !== p.export) {
      throw new Error(`the verified export ${p.export} is not this unit's latest export`);
    }
    if (last.through_event < p.through_event)
      throw new Error("the export does not cover the events");
    const after = this.ledger.db
      .prepare(
        `select count(*) as n from event where id > ? and kind in (${HarnessService.RESEARCH_EVENTS.map(() => "?").join(",")})`,
      )
      .get(last.through_event, ...HarnessService.RESEARCH_EVENTS) as { n: number };
    if (Number(after.n) > 0) {
      throw new Error(
        `${after.n} research events were recorded after the export: pause the instances and export again`,
      );
    }
    for (const inst of this.ledger.listInstances()) {
      if (inst.status === "running") this.ledger.setInstanceStatus(inst.id, "paused", "wiping", by);
    }
    writeFileSync(
      join(this.paths.stateDir, WIPE_MARKER),
      `${JSON.stringify({ export: p.export, by, at: new Date().toISOString() })}\n`,
    );
    this.ledger.appendEvent(by, "wipe_requested", null, { export: p.export });
    // Exit after the result is on its way back; the broker restarts the controller, which wipes.
    setTimeout(() => this.onWipe?.(), 2000).unref();
    return { wiping: true, export: p.export };
  }

  /** Called when a wipe was requested (the controller exits; tests observe it). */
  onWipe?: () => void;

  // ------------------------------------------------------------ audits, reviews, briefs

  /** What the supervisor's auditor sees for each open audit: the package and the diff. */
  async auditPackages(): Promise<(AuditPackage & { diff: string })[]> {
    const audits = new Audits(this.ledger);
    const out: (AuditPackage & { diff: string })[] = [];
    for (const id of audits.pending()) {
      const row = this.ledger.db
        .prepare("select attempt, instance from audit where id = ?")
        .get(id) as {
        attempt: string;
        instance: string;
      };
      const pkg = audits.package(id, this.contractFor(row.instance));
      const a = this.ledger.getAttempt(row.attempt) as Record<string, unknown>;
      const inst = this.requireInstance(row.instance);
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
    const instance = String(a.instance);
    const expectedSeq = Number(audit.expected_seq);
    if (String(a.lifecycle) !== "awaiting_audit") {
      return { decision: input.decision, effect: `none: the attempt is ${a.lifecycle}` };
    }
    const toOwner = (why: string) => {
      this.ledger.tx(() => {
        this.ledger.appendEvent(input.auditor, "promotion_pending", input.attempt, {
          instance,
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
    if (String(audit.reason) === "known_flaws") return toOwner("declared flaws need the owner");
    if (this.promotion === "owner_approval") return toOwner("promotion policy: owner approval");
    const r = await this.promoteAttempt({
      instance,
      attempt: input.attempt,
      expectedSeq,
      by: input.auditor,
    });
    if (r.promoted) return { decision: "clear", effect: "promoted", seq: r.seq };
    this.ledger.enqueueJob({ attempt: input.attempt, kind: "evaluate", actor: input.auditor });
    this.ledger.setAttemptLifecycle(input.attempt, "queued", input.auditor);
    return { decision: "clear", effect: "the champion moved: screened again" };
  }

  /**
   * The deterministic snapshot the supervisor's teacher pair reviews: the campaign, the champion,
   * the direction registry, recent evidence, epochs and the directives in force. Nothing from
   * held-out cells, and no worker text beyond hypotheses.
   */
  brief(instance: string): unknown {
    const inst = this.requireInstance(instance);
    const contract = this.contractFor(instance);
    const registry = new Registry(this.ledger);
    const champion = this.ledger.currentChampion(instance);
    const epochs = (
      this.ledger.db
        .prepare("select * from epoch where instance = ? order by n desc limit 5")
        .all(instance) as Record<string, unknown>[]
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
        ? (this.ledger.db
            .prepare("select id, status from goal where instance = ?")
            .all(instance) as {
            id: string;
            status: string;
          }[])
        : undefined;
    return {
      unit: this.unit,
      instance,
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
      families: registry.families(instance),
      evidence: registry.evidence(instance, 40),
      epochs,
      directives: this.ledger.activeDirectives(instance),
      ...(goals ? { goals } : {}),
      budget: {
        ...contract.budget,
        device_hours_used: this.ledger.deviceHours(instance),
        tokens: registry.tokensUsed(instance),
      },
    };
  }

  /**
   * Points the instance's champion ref at the effective champion. The ledger is the authority;
   * the ref is for git consumers, so a failure here is recorded, never fatal.
   */
  async syncChampionRef(instance: string): Promise<void> {
    const inst = this.requireInstance(instance);
    const champ = this.ledger.currentChampion(instance);
    try {
      await updateRef(
        this.mirrorFor(inst.seed_repo),
        `refs/thermite/instances/${instance}/champion`,
        champ.commit_sha,
      );
    } catch (err) {
      this.ledger.appendEvent("judge", "champion_ref_failed", instance, {
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
    if (!a || String(a.instance) !== p.instance) {
      throw new Error(`attempt ${p.attempt} is not in ${p.instance}`);
    }
    const lifecycle = String(a.lifecycle);
    let expectedSeq: number;
    if (lifecycle === "awaiting_approval") {
      expectedSeq = Number(
        this.ledger.latestEventBody("promotion_pending", p.attempt)?.expected_seq,
      );
    } else if (lifecycle === "awaiting_audit" || lifecycle === "audit_blocked") {
      expectedSeq = Number(new Audits(this.ledger).get(p.attempt)?.expected_seq);
      this.ledger.appendEvent(by, "audit_overridden", p.attempt, { lifecycle });
    } else {
      throw new Error(`attempt ${p.attempt} is ${lifecycle}, not awaiting approval`);
    }
    if (!Number.isInteger(expectedSeq)) throw new Error(`no pending promotion for ${p.attempt}`);
    if ((JSON.parse(String(a.known_flaws)) as unknown[]).length) {
      this.ledger.db
        .prepare("update attempt set flaws_cleared_by = ? where id = ?")
        .run(by, p.attempt);
      this.ledger.appendEvent(by, "flaws_accepted", p.attempt, {});
    }
    const r = await this.promoteAttempt({ ...p, expectedSeq, by });
    if (r.promoted) return r;
    // The champion moved after this win was confirmed: it must be screened against the new one.
    this.ledger.enqueueJob({ attempt: p.attempt, kind: "evaluate", actor: by });
    this.ledger.setAttemptLifecycle(p.attempt, "queued", by);
    return { promoted: false, rescreen: true, champion_seq: r.currentSeq };
  }

  /**
   * Low-power steering from the supervisor's teacher pair: one structured directive set, which
   * replaces the supervisor's previous set. Every directive needs a citation, and free-text notes
   * (planner only) are limited. Nothing here can touch a verdict, a contract or a worker's brief.
   */
  addDirectives(instance: string, directives: unknown, author: string): number[] {
    const inst = this.requireInstance(instance);
    if (inst.status === "closed")
      throw new LedgerError("invalid", `instance ${instance} is closed`);
    const parsed = z.array(StructuredDirective).min(1).max(20).parse(directives);
    const uncited = parsed.filter((d) => !d.citations.length);
    if (uncited.length) {
      throw new LedgerError("invalid", `${uncited.length} directive(s) without a citation`);
    }
    if (parsed.filter((d) => d.kind === "note").length > 3) {
      throw new LedgerError("invalid", "at most 3 notes per directive set");
    }
    return this.ledger.addDirectiveSet(instance, author, parsed, true);
  }

  // ------------------------------------------------------------ attempts

  contractFor(instance: string): Contract {
    const inst = this.requireInstance(instance);
    const c = this.ledger.getContract(inst.campaign, inst.version);
    if (!c) throw new LedgerError("not_found", `contract for ${instance} missing`);
    return c;
  }

  /**
   * Preserves a submitted change as an attempt ref first, then applies V0 and duplicate checks.
   * Rejected and duplicate attempts are still recorded: nothing submitted is destroyed.
   */
  async submitAttempt(req: SubmitRequest, actor: string): Promise<SubmitResult> {
    const inst = this.requireInstance(req.instance);
    if (inst.status !== "running")
      throw new LedgerError("invalid", `instance ${req.instance} is ${inst.status}`);
    const contract = this.contractFor(req.instance);
    if (contract.mode === "research")
      throw new LedgerError("invalid", "research campaigns take claims, not patches");
    const champion = this.ledger.currentChampion(req.instance);
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
        this.ledger.appendEvent(actor, "submission_refused", req.instance, {
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
    const duplicateOf = this.ledger.findDuplicate(req.instance, made.normalizedDiffSha);
    const lifecycle = !v0.ok ? "rejected_v0" : duplicateOf ? "duplicate" : "queued";
    // Lineage: the attempt this one was built on, whether or not it is the champion.
    const parentAttempt =
      parent === champion.commit_sha && champion.attempt
        ? champion.attempt
        : this.ledger.attemptByCommit(req.instance, parent);
    const parentRef = parentAttempt
      ? `refs/thermite/attempts/${parentAttempt}`
      : `commit:${parent}`;
    this.ledger.recordAttempt(
      {
        id,
        instance: req.instance,
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
      },
      actor,
    );
    if (lifecycle === "queued") {
      this.ledger.enqueueJob({
        attempt: id,
        kind: "evaluate",
        spec: { instance: req.instance },
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
   * A worker's submission. The trial (found by its token) decides the instance, lane and parent;
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
          instance: t.instance,
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
      instance: a.instance,
      lifecycle: a.lifecycle,
      commit: a.commit_sha,
      v0: a.v0 ? JSON.parse(String(a.v0)) : null,
      verdict: verdict ? { verdict: verdict.verdict } : null,
    };
  }

  // ------------------------------------------------------------ snapshot and export

  /**
   * A page of events with the current summary, signed with the unit's own key so that control
   * can tell the harness's report from anything the supervisor (which relays it) might invent.
   */
  snapshot(cursor: number, limit: number): unknown {
    const page = this.ledger.eventsAfter(cursor, limit);
    const report = {
      unit: this.unit,
      ledger_id: this.ledger.ledgerId(),
      cursor,
      next: page.next,
      events: page.events,
      summary: this.ledger.summary(),
    };
    return this.unitKeys
      ? {
          ...report,
          unit_pubkey: this.unitKeys.publicKeyPem,
          signature: signJson(reportBody(report), this.unitKeys.privateKeyPem),
        }
      : report;
  }

  async export(actor: string) {
    return writeExport({
      ledger: this.ledger,
      mirrorFor: (repo) => this.mirrorFor(repo),
      outboxDir: this.paths.outboxDir,
      unit: this.unit,
      actor,
    });
  }
}
