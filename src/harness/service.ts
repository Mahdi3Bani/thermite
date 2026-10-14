import { randomUUID } from "node:crypto";
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
import { createAttemptCommit, GitError, hasCommit, initMirror, updateRef } from "./git.ts";
import { importBundle, importFile } from "./imports.ts";
import { type Ledger, LedgerError } from "./ledger.ts";
import { writeExport } from "./outbox.ts";
import { checkV0 } from "./v0.ts";

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

  constructor(input: {
    unit: string;
    ledger: Ledger;
    paths: HarnessPaths;
    controlPublicKeyPem: string;
    clock?: (() => Date) | undefined;
    /** The unit's report-signing key (generated once, kept in the private state). */
    unitKeys?: KeyPairPem | undefined;
  }) {
    this.unitKeys = input.unitKeys;
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
        const ids = p.directives.map((d) => this.ledger.addDirective(p.instance, by, d));
        return { instance: p.instance, directives: ids };
      }
      case "reset_workers": {
        const p = CommandPayloads.reset_workers.parse(payload);
        this.requireInstance(p.instance);
        this.ledger.appendEvent(by, "workers_reset", p.instance, {
          reseed_commit: p.reseed_commit ?? null,
        });
        return { instance: p.instance, reset: true };
      }
      case "propagate": {
        const p = CommandPayloads.propagate.parse(payload);
        const inst = this.requireInstance(p.instance);
        const imported = await this.runImport(p.import, inst.seed_repo, by);
        this.ledger.appendEvent(by, "propagation_received", p.instance, {
          source_unit: p.source_unit,
          ...imported,
        });
        return { instance: p.instance, imported };
      }
      case "export_now": {
        const r = await this.export(by);
        return { export: r.id, attempts: r.attempts, events: r.events };
      }
      case "wipe_state":
        throw new Error("wipe_state is not available in this version");
      case "approve_promotion":
        return this.approvePromotion(CommandPayloads.approve_promotion.parse(payload), by);
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
    return { promoted: true, seq: r.seq };
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

  private async approvePromotion(
    p: z.infer<(typeof CommandPayloads)["approve_promotion"]>,
    by: string,
  ): Promise<unknown> {
    const a = this.ledger.getAttempt(p.attempt);
    if (!a || String(a.instance) !== p.instance) {
      throw new Error(`attempt ${p.attempt} is not in ${p.instance}`);
    }
    if (String(a.lifecycle) !== "awaiting_approval") {
      throw new Error(`attempt ${p.attempt} is ${a.lifecycle}, not awaiting approval`);
    }
    const pending = this.ledger.latestEventBody("promotion_pending", p.attempt);
    const expectedSeq = Number(pending?.expected_seq);
    if (!Number.isInteger(expectedSeq)) throw new Error(`no pending promotion for ${p.attempt}`);
    const r = await this.promoteAttempt({ ...p, expectedSeq, by });
    if (r.promoted) return r;
    // The champion moved after this win was confirmed: it must be screened against the new one.
    this.ledger.enqueueJob({ attempt: p.attempt, kind: "evaluate", actor: by });
    this.ledger.setAttemptLifecycle(p.attempt, "queued", by);
    return { promoted: false, rescreen: true, champion_seq: r.currentSeq };
  }

  /** Low-power steering from the supervisor's teacher pair: structured directives only. */
  addDirectives(instance: string, directives: unknown, author: string): number[] {
    this.requireInstance(instance);
    const parsed = z.array(StructuredDirective).min(1).parse(directives);
    return parsed.map((d) => this.ledger.addDirective(instance, author, d));
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
