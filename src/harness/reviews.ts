import { canonicalJson } from "../core/canonical.ts";
import type { GoalContract } from "../core/contract.ts";
import { type Ledger, LedgerError } from "./ledger.ts";

/**
 * Subjective goals (verify type `review`). The champion's artifact goes to the supervisor's
 * model panel as a package: the goal, its criteria and the change from the seed, with nothing
 * about which lane or model wrote it. A pass is recorded as review_passed; only the owner's
 * acceptance makes the goal met. No model is ever the final gate.
 *
 * Reviews are per champion commit: a new champion needs a new review.
 */

type Row = Record<string, unknown>;

/** At least this many panelists, all passing, for review_passed. */
export const MIN_PANEL = 2;

export interface ReviewPackage {
  id: number;
  run: string;
  goal: string;
  description: string;
  criteria: string[];
  deliverable: string;
  insufficient: string[];
  commit: string;
  diff: string;
  requested_at: string;
}

export class Reviews {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  get(run: string, goal: string, commit: string): Row | undefined {
    return this.ledger.db
      .prepare("select * from review where run = ? and goal = ? and commit_sha = ?")
      .get(run, goal, commit) as Row | undefined;
  }

  /** Requests a review of a champion for a goal (once per commit). Returns its id. */
  request(input: {
    run: string;
    goal: string;
    attempt: string | null;
    commit: string;
    contract: GoalContract;
    diff: string;
    by: string;
  }): number {
    const existing = this.get(input.run, input.goal, input.commit);
    if (existing) return Number(existing.id);
    const g = input.contract.goals.find((x) => x.id === input.goal);
    if (g?.verify.type !== "review")
      throw new LedgerError("invalid", `${input.goal} is not a review goal`);
    const pkg = {
      goal: g.id,
      description: g.description,
      criteria: g.verify.criteria,
      deliverable: input.contract.deliverable,
      insufficient: input.contract.insufficient,
      // Capped: a reviewer reads the change, not a whole repository.
      diff: input.diff.slice(0, 200_000),
    };
    return this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare(
          "insert into review (run, goal, attempt, commit_sha, package, requested_at) values (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.run,
          input.goal,
          input.attempt,
          input.commit,
          canonicalJson(pkg),
          new Date().toISOString(),
        );
      const id = Number(r.lastInsertRowid);
      this.ledger.appendEvent(input.by, "review_requested", input.run, {
        review: id,
        goal: input.goal,
        commit: input.commit,
      });
      return id;
    });
  }

  /** Reviews waiting for the panel, as packages (no lane, model or attempt id in them). */
  pending(): ReviewPackage[] {
    return (
      this.ledger.db
        .prepare(
          `select r.* from review r join run i on i.id = r.run
           where r.panel_result is null and i.status = 'running' order by r.id`,
        )
        .all() as Row[]
    ).map((r) => {
      const pkg = JSON.parse(String(r.package)) as Omit<
        ReviewPackage,
        "id" | "run" | "commit" | "requested_at"
      >;
      return {
        ...pkg,
        id: Number(r.id),
        run: String(r.run),
        commit: String(r.commit_sha),
        requested_at: String(r.requested_at),
      };
    });
  }

  /** The panel's results, written once: review_passed only if every panelist passes it. */
  recordPanel(
    id: number,
    results: { reviewer: string; pass: boolean; reasons: string }[],
    by: string,
  ): "review_passed" | "review_failed" {
    if (results.length < MIN_PANEL) {
      throw new LedgerError("invalid", `a panel needs at least ${MIN_PANEL} reviewers`);
    }
    if (new Set(results.map((r) => r.reviewer)).size !== results.length) {
      throw new LedgerError("invalid", "each reviewer counts once");
    }
    const outcome = results.every((r) => r.pass) ? "review_passed" : "review_failed";
    this.ledger.tx(() => {
      const row = this.ledger.db.prepare("select * from review where id = ?").get(id) as
        | Row
        | undefined;
      if (!row) throw new LedgerError("not_found", `no review ${id}`);
      if (row.panel_result !== null)
        throw new LedgerError("conflict", `review ${id} is already decided`);
      // Only for a running campaign's current champion: a stale review is not recorded.
      const inst = this.ledger.getRun(String(row.run));
      if (inst?.status !== "running")
        throw new LedgerError("invalid", `run ${String(row.run)} is not running`);
      if (this.ledger.currentChampion(String(row.run)).commit_sha !== String(row.commit_sha))
        throw new LedgerError(
          "stale",
          `review ${id} is of a commit that is no longer the champion`,
        );
      this.ledger.db
        .prepare("update review set panel = ?, panel_result = ?, panel_at = ? where id = ?")
        .run(
          canonicalJson(results.map((r) => ({ ...r, reasons: r.reasons.slice(0, 4000) }))),
          outcome,
          new Date().toISOString(),
          id,
        );
      this.ledger.appendEvent(by, "review_panel", String(row.run), {
        review: id,
        goal: row.goal,
        result: outcome,
        reviewers: results.length,
      });
    });
    return outcome;
  }

  /** The owner's final word on a goal the panel passed. */
  ownerDecision(
    id: number,
    run: string,
    accept: boolean,
    note: string | undefined,
    by: string,
  ): Row {
    return this.ledger.tx(() => {
      const row = this.ledger.db.prepare("select * from review where id = ?").get(id) as
        | Row
        | undefined;
      if (!row || String(row.run) !== run)
        throw new LedgerError("not_found", `no review ${id} in ${run}`);
      if (row.panel_result !== "review_passed")
        throw new LedgerError("invalid", `review ${id} has not passed the panel`);
      if (row.owner_decision !== null)
        throw new LedgerError("conflict", `review ${id} is already decided`);
      const decision = accept ? "accepted" : "rejected";
      this.ledger.db
        .prepare("update review set owner_decision = ?, owner_note = ?, owner_at = ? where id = ?")
        .run(decision, note?.slice(0, 2000) ?? null, new Date().toISOString(), id);
      this.ledger.appendEvent(by, "review_decided", run, {
        review: id,
        goal: row.goal,
        decision,
      });
      return row;
    });
  }

  /** A review goal's status for a commit: met only with the owner's acceptance. */
  status(
    run: string,
    goal: string,
    commit: string,
  ): { status: "met" | "unmet" | "not_runnable"; reasons: string } {
    const r = this.get(run, goal, commit);
    if (!r) return { status: "not_runnable", reasons: "no review requested for this commit" };
    if (r.owner_decision === "accepted")
      return { status: "met", reasons: "the panel passed it and the owner accepted it" };
    if (r.owner_decision === "rejected")
      return { status: "unmet", reasons: "the owner did not accept it" };
    if (r.panel_result === "review_failed")
      return { status: "unmet", reasons: "the review panel did not pass it" };
    if (r.panel_result === "review_passed")
      return {
        status: "not_runnable",
        reasons: "review_passed: waiting for the owner's acceptance",
      };
    return { status: "not_runnable", reasons: "waiting for the review panel" };
  }
}
