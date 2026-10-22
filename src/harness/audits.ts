import { canonicalJson } from "../core/canonical.ts";
import type { Contract } from "../core/contract.ts";
import { type Ledger, LedgerError } from "./ledger.ts";

/**
 * Audits. The judge flags a promotable result for audit (open known flaws, a gain above the
 * contract's audit trigger, or a goal campaign's adversarial checklist) and holds it while the
 * rig has an auditor. The supervisor's auditor answers clear, block or needs_owner. Its clear is
 * the last step (goal 079, the owner's decision of 2026-10-22: hands-off by default): the win is
 * promoted, even above the trigger or with declared flaws, unless the run asks the owner. Its
 * block stops the win, with its reasons. Without an auditor, the audit is skipped and recorded
 * so. Each confirmation of an attempt gets its own audit, against the champion it was confirmed
 * against.
 */

type Row = Record<string, unknown>;

export type AuditDecision = "clear" | "block" | "needs_owner";
export type AuditTriggerKind = "absolute" | "ratio" | "known_flaws" | "adversarial_checklist";

export interface AuditPackage {
  id: number;
  attempt: string;
  run: string;
  reason: string;
  requested_at: string;
  hypothesis: string | null;
  claim: string | null;
  known_flaws: string[];
  verdict: { verdict: string; delta: number | null; ci_low: number | null; ci_high: number | null };
  contract: {
    title: string;
    mode: string;
    objective: string;
    editable_paths: string[];
    insufficient: string[];
    adversarial_checklist: string[];
  };
}

/** Why a promotable result needs an audit, or undefined. */
export function auditTrigger(input: {
  contract: Contract;
  knownFlaws: unknown[];
  delta: number | null | undefined;
  priorDeltas: number[];
}): { kind: AuditTriggerKind; reason: string } | undefined {
  const { contract } = input;
  if (input.knownFlaws.length) return { kind: "known_flaws", reason: "declared flaws" };
  if (contract.mode === "goal") {
    return contract.adversarial_checklist.length
      ? { kind: "adversarial_checklist", reason: "the contract's adversarial checklist" }
      : undefined;
  }
  if (contract.mode !== "hill_climb" || typeof input.delta !== "number") return undefined;
  const { ratio_to_median, absolute } = contract.acceptance.audit;
  if (input.delta > absolute)
    return {
      kind: "absolute",
      reason: `gain ${(input.delta * 100).toFixed(1)}% above ${absolute * 100}%`,
    };
  const prior = [...input.priorDeltas].filter((d) => d > 0).sort((a, b) => a - b);
  if (prior.length >= 3) {
    const median = prior[Math.floor(prior.length / 2)] as number;
    if (input.delta > ratio_to_median * median) {
      return {
        kind: "ratio",
        reason: `gain ${(input.delta * 100).toFixed(1)}% above ${ratio_to_median}x the median confirmed gain`,
      };
    }
  }
  return undefined;
}

export class Audits {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /** Confirmed gains of earlier wins in the run (for the ratio-to-median trigger). */
  priorDeltas(run: string, except: string): number[] {
    return (
      this.ledger.db
        .prepare(
          `select v.delta as delta from verdict v join attempt a on a.id = v.attempt
           where a.run = ? and a.id != ? and v.verdict = 'win_confirmed' and v.delta is not null
             and not exists (select 1 from verdict s where s.supersedes = v.id)`,
        )
        .all(run, except) as { delta: number }[]
    ).map((r) => r.delta);
  }

  /** Records an audit request; the caller holds the attempt in awaiting_audit (same transaction). */
  request(input: {
    attempt: string;
    /** The confirmation job that held the attempt: one audit per confirmation. */
    job: number;
    run: string;
    trigger: AuditTriggerKind;
    reason: string;
    expectedSeq: number;
    by: string;
  }): number {
    return this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare(
          `insert into audit (attempt, confirm_job, run, trigger, reason, expected_seq, requested_at)
           values (?, ?, ?, ?, ?, ?, ?) on conflict (attempt, confirm_job) do nothing`,
        )
        .run(
          input.attempt,
          input.job,
          input.run,
          input.trigger,
          input.reason,
          input.expectedSeq,
          new Date().toISOString(),
        );
      const id = Number(r.changes)
        ? Number(r.lastInsertRowid)
        : Number(
            (
              this.ledger.db
                .prepare("select id from audit where attempt = ? and confirm_job = ?")
                .get(input.attempt, input.job) as Row
            ).id,
          );
      this.ledger.appendEvent(input.by, "audit_requested", input.attempt, {
        audit: id,
        run: input.run,
        reason: input.reason,
        expected_seq: input.expectedSeq,
      });
      return id;
    });
  }

  /** The attempt's current audit: the one for its latest confirmation. */
  get(attempt: string): Row | undefined {
    return this.ledger.db
      .prepare("select * from audit where attempt = ? order by id desc limit 1")
      .get(attempt) as Row | undefined;
  }

  /** Open audits (the current one of each attempt still held for one). */
  pending(): number[] {
    return (
      this.ledger.db
        .prepare(
          `select au.id as id from audit au join attempt a on a.id = au.attempt
           where au.decision is null and a.lifecycle = 'awaiting_audit'
             and au.id = (select max(id) from audit x where x.attempt = au.attempt)
           order by au.id`,
        )
        .all() as { id: number }[]
    ).map((r) => r.id);
  }

  /**
   * What an auditor sees: the claim, the judge's verdict and the contract's rules. The diff is
   * added by the service (from git). Never held-out results: those stay with promotion code.
   */
  package(id: number, contract: Contract): AuditPackage {
    const au = this.ledger.db.prepare("select * from audit where id = ?").get(id) as
      | Row
      | undefined;
    if (!au) throw new LedgerError("not_found", `no audit ${id}`);
    const a = this.ledger.getAttempt(String(au.attempt)) as Row;
    const current = this.ledger.currentVerdict(String(au.attempt));
    const v = this.ledger.db
      .prepare("select verdict, delta, ci_low, ci_high from verdict where id = ?")
      .get(current?.id ?? -1) as Row | undefined;
    const num = (x: unknown) => (typeof x === "number" ? x : null);
    return {
      id,
      attempt: String(au.attempt),
      run: String(au.run),
      reason: String(au.reason),
      requested_at: String(au.requested_at),
      hypothesis: a.hypothesis === null ? null : String(a.hypothesis),
      claim: a.claim === null ? null : String(a.claim),
      known_flaws: JSON.parse(String(a.known_flaws)) as string[],
      verdict: {
        verdict: String(v?.verdict ?? "none"),
        delta: num(v?.delta),
        ci_low: num(v?.ci_low),
        ci_high: num(v?.ci_high),
      },
      contract: {
        title: contract.title,
        mode: contract.mode,
        objective:
          contract.mode === "hill_climb"
            ? `${contract.objective.primary.direction} ${contract.objective.primary.metric}`
            : contract.mode === "goal"
              ? contract.goals.map((g) => `${g.id}: ${g.description}`).join("; ")
              : contract.topic,
        editable_paths: "editable_paths" in contract ? contract.editable_paths : [],
        insufficient: contract.mode === "goal" ? contract.insufficient : [],
        adversarial_checklist: contract.mode === "goal" ? contract.adversarial_checklist : [],
      },
    };
  }

  /** Writes the decision once. Returns the audit row as it was before the decision. */
  decide(input: {
    attempt: string;
    decision: AuditDecision;
    reasons: string;
    citations: string[];
    auditor: string;
  }): Row {
    return this.ledger.tx(() => {
      const au = this.get(input.attempt);
      if (!au) throw new LedgerError("not_found", `no audit for ${input.attempt}`);
      if (au.decision !== null) {
        throw new LedgerError("conflict", `the audit of ${input.attempt} is already decided`);
      }
      this.ledger.db
        .prepare(
          "update audit set decision = ?, reasons = ?, citations = ?, auditor = ?, decided_at = ? where id = ?",
        )
        .run(
          input.decision,
          input.reasons.slice(0, 8000),
          canonicalJson(input.citations.slice(0, 20)),
          input.auditor,
          new Date().toISOString(),
          Number(au.id),
        );
      this.ledger.appendEvent(input.auditor, "audit_decided", input.attempt, {
        audit: Number(au.id),
        decision: input.decision,
        reasons: input.reasons.slice(0, 1000),
      });
      return au;
    });
  }
}
