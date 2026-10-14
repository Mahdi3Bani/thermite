import { canonicalJson } from "../core/canonical.ts";
import type { GoalContract } from "../core/contract.ts";
import { type Ledger, LedgerError, PROMOTABLE_VERDICTS } from "./ledger.ts";

/**
 * "Not possible" endings for goal campaigns. The harness proposes one only where the contract
 * allows it, and only from evidence in the ledger: at least `min_refuted_approaches` approach
 * families, each with several judged attempts and no progress at all. The owner accepts or
 * rejects it; until then the campaign goes on. No agent can end a campaign.
 */

type Row = Record<string, unknown>;

/** Judged attempts a family needs, with no progress, before it counts as refuted. */
export const REFUTE_ATTEMPTS = 3;

/** Verdicts that show an approach is getting somewhere (so it is not refuted). */
const PROMISING = new Set([...PROMOTABLE_VERDICTS, "win_screened", "goal_screened"]);
/** Verdicts that do not count as evidence either way. */
const IGNORED = new Set(["crash_infra", "invalidated"]);

export interface RefutedApproach {
  family: string;
  description: string;
  attempts: { attempt: string; verdict: string; verdict_id: number; reasons: string }[];
}

export class Conclusions {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /** Approach families with enough judged attempts and no progress, with their receipts. */
  refuted(instance: string): RefutedApproach[] {
    const out: RefutedApproach[] = [];
    const families = this.ledger.db
      .prepare("select id, description from family where instance = ?")
      .all(instance) as Row[];
    for (const f of families) {
      const attempts: RefutedApproach["attempts"] = [];
      let promising = false;
      for (const a of this.ledger.db
        .prepare("select id from attempt where instance = ? and family = ? order by created_at")
        .all(instance, String(f.id)) as Row[]) {
        const v = this.ledger.currentVerdict(String(a.id));
        if (!v || IGNORED.has(v.verdict)) continue;
        if (PROMISING.has(v.verdict)) promising = true;
        const reasons = String(
          (this.ledger.db.prepare("select reasons from verdict where id = ?").get(v.id) as Row)
            .reasons,
        );
        attempts.push({
          attempt: String(a.id),
          verdict: v.verdict,
          verdict_id: v.id,
          reasons: reasons.slice(0, 500),
        });
      }
      if (!promising && attempts.length >= REFUTE_ATTEMPTS) {
        out.push({ family: String(f.id), description: String(f.description), attempts });
      }
    }
    return out;
  }

  open(instance: string): Row | undefined {
    return this.ledger.db
      .prepare("select * from conclusion where instance = ? and decision is null")
      .get(instance) as Row | undefined;
  }

  /**
   * Proposes "not possible" when the contract allows it and the evidence is there, unless a
   * proposal is open, or the owner rejected one and there is no new refuted approach since.
   */
  maybePropose(instance: string, contract: GoalContract, by: string): number | undefined {
    if (!contract.infeasibility.allowed) return undefined;
    if (this.open(instance)) return undefined;
    const refuted = this.refuted(instance);
    const need = contract.infeasibility.min_refuted_approaches ?? Number.POSITIVE_INFINITY;
    if (refuted.length < need) return undefined;
    const last = this.ledger.db
      .prepare(
        "select evidence from conclusion where instance = ? and decision = 'rejected' order by id desc limit 1",
      )
      .get(instance) as Row | undefined;
    if (last) {
      const before = (JSON.parse(String(last.evidence)) as { approaches: RefutedApproach[] })
        .approaches.length;
      if (refuted.length <= before) return undefined;
    }
    const goals = this.ledger.db
      .prepare("select id, status from goal where instance = ?")
      .all(instance) as Row[];
    const evidence = {
      approaches: refuted,
      goals: goals.map((g) => ({ goal: String(g.id), status: String(g.status) })),
      rule: `at least ${need} approach families, each with ${REFUTE_ATTEMPTS} or more judged attempts and no progress`,
    };
    return this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare(
          "insert into conclusion (instance, kind, evidence, proposed_at) values (?, 'not_possible', ?, ?)",
        )
        .run(instance, canonicalJson(evidence), new Date().toISOString());
      const id = Number(r.lastInsertRowid);
      for (const a of refuted) {
        this.ledger.db
          .prepare(
            "update family set status = 'exhausted' where instance = ? and id = ? and status = 'live'",
          )
          .run(instance, a.family);
      }
      this.ledger.appendEvent(by, "conclusion_proposed", instance, {
        proposal: id,
        kind: "not_possible",
        approaches: refuted.map((a) => ({ family: a.family, attempts: a.attempts.length })),
      });
      return id;
    });
  }

  /** The owner's decision. Accepting closes the instance; rejecting lets the campaign go on. */
  decide(
    instance: string,
    proposal: number,
    accept: boolean,
    note: string | undefined,
    by: string,
  ) {
    return this.ledger.tx(() => {
      const row = this.ledger.db
        .prepare("select * from conclusion where id = ? and instance = ?")
        .get(proposal, instance) as Row | undefined;
      if (!row) throw new LedgerError("not_found", `no proposal ${proposal} in ${instance}`);
      if (row.decision !== null)
        throw new LedgerError("conflict", `proposal ${proposal} is decided`);
      const decision = accept ? "accepted" : "rejected";
      this.ledger.db
        .prepare("update conclusion set decision = ?, note = ?, decided_at = ? where id = ?")
        .run(decision, note?.slice(0, 2000) ?? null, new Date().toISOString(), proposal);
      this.ledger.appendEvent(
        by,
        accept ? "conclusion_accepted" : "conclusion_rejected",
        instance,
        {
          proposal,
          kind: String(row.kind),
        },
      );
      if (accept) {
        this.ledger.setInstanceStatus(
          instance,
          "closed",
          "not possible: the owner accepted the evidence",
          by,
        );
      }
      return { proposal, decision };
    });
  }
}
