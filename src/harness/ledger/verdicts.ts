import { canonicalJson } from "../../core/canonical.ts";
import { clipReason, REASONS_CHARS } from "../judge/reasons.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";

export interface InvalidationResult {
  attempts: string[];
  verdictsSuperseded: number[];
  championsReopened: { run: string; seq: number }[];
}

/** The `verdict` and `invalidation` tables: the verdicts, and invalidation. */
export class LedgerVerdicts extends LedgerPart {
  record(v: {
    attempt: string;
    verdict: string;
    delta?: number | null | undefined;
    ciLow?: number | null | undefined;
    ciHigh?: number | null | undefined;
    guards?: unknown;
    dependsOnJobs?: number[] | undefined;
    reasons: string;
    judgedBy: string;
    supersedes?: number | undefined;
    /** The main metric's measured values (goal 133): in the event only, for control's pages. */
    values?: unknown;
  }): number {
    return this.tx(() => {
      const a = this.ledger.attempts.get(v.attempt);
      if (!a) throw new LedgerError("not_found", `no attempt ${v.attempt}`);
      if (a.invalidated_by !== null && v.verdict !== "invalidated") {
        throw new LedgerError("invalid", `attempt ${v.attempt} is invalidated`);
      }
      return this.insert(v);
    });
  }

  private insert(v: Parameters<LedgerVerdicts["record"]>[0]): number {
    const id = this.execute(
      `insert into verdict (attempt, verdict, delta, ci_low, ci_high, guards, depends_on_jobs, reasons,
         judged_by, supersedes, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.attempt,
      v.verdict,
      v.delta ?? null,
      v.ciLow ?? null,
      v.ciHigh ?? null,
      canonicalJson(v.guards ?? []),
      canonicalJson(v.dependsOnJobs ?? []),
      v.reasons,
      v.judgedBy,
      v.supersedes ?? null,
      this.now(),
    ).id;
    this.ledger.appendEvent(v.judgedBy, "verdict", v.attempt, {
      id,
      verdict: v.verdict,
      delta: v.delta ?? null,
      // The interval and the judge's reasons, so a reader sees how sure the verdict is and why.
      ci_low: v.ciLow ?? null,
      ci_high: v.ciHigh ?? null,
      reasons: clipReason(v.reasons, REASONS_CHARS),
      supersedes: v.supersedes ?? null,
      ...(v.values ? { values: v.values } : {}),
    });
    return id;
  }

  /** A verdict's change and reasons, by its id. */
  get(id: number): { delta: number | null; reasons: string } | undefined {
    const r = this.row<Row>("select delta, reasons from verdict where id = ?", id);
    return r
      ? { delta: r.delta === null ? null : Number(r.delta), reasons: String(r.reasons) }
      : undefined;
  }

  /** The newest verdict for an attempt that no later verdict supersedes. */
  current(attempt: string): { id: number; verdict: string; depends_on_jobs: number[] } | undefined {
    const r = this.row<Row>(
      `select id, verdict, depends_on_jobs from verdict v where attempt = ?
         and not exists (select 1 from verdict s where s.supersedes = v.id)
       order by id desc limit 1`,
      attempt,
    );
    return r
      ? {
          id: Number(r.id),
          verdict: String(r.verdict),
          depends_on_jobs: JSON.parse(String(r.depends_on_jobs)) as number[],
        }
      : undefined;
  }

  /**
   * Invalidates a job's evidence or a whole attempt. Never deletes: current verdicts that depend
   * on the subject are superseded by an `invalidated` verdict, champions built on them are marked
   * reopened, and attempts derived from an invalidated attempt are invalidated in turn.
   */
  invalidate(input: {
    subjectKind: "job" | "attempt";
    subjectId: string;
    reason: string;
    actor: string;
  }): InvalidationResult {
    return this.tx(() => {
      const at = this.now();
      const result: InvalidationResult = {
        attempts: [],
        verdictsSuperseded: [],
        championsReopened: [],
      };
      const invalidationId = this.execute(
        "insert into invalidation (subject_kind, subject_id, reason, actor, created_at) values (?, ?, ?, ?, ?)",
        input.subjectKind,
        input.subjectId,
        input.reason,
        input.actor,
        at,
      ).id;
      // An invalidated attempt (and everything built on it) is invalid for good. Attempts whose
      // job evidence was invalidated may be measured again; their descendants are re-judged too.
      const permanent = input.subjectKind === "attempt";
      let frontier: string[] = [];
      if (input.subjectKind === "attempt") {
        frontier = [input.subjectId];
      } else {
        const jobId = Number(input.subjectId);
        const rows = this.rows<Row>("select distinct attempt from verdict");
        for (const r of rows) {
          const current = this.current(String(r.attempt));
          if (current?.depends_on_jobs.includes(jobId)) frontier.push(String(r.attempt));
        }
      }
      const seen = new Set<string>();
      while (frontier.length) {
        const attempt = frontier.shift() as string;
        if (seen.has(attempt)) continue;
        seen.add(attempt);
        result.attempts.push(attempt);
        if (permanent) {
          this.execute(
            "update attempt set invalidated_by = coalesce(invalidated_by, ?), updated_at = ? where id = ?",
            invalidationId,
            at,
            attempt,
          );
        }
        const current = this.current(attempt);
        if (current?.verdict !== "invalidated") {
          const id = this.insert({
            attempt,
            verdict: "invalidated",
            reasons:
              attempt === input.subjectId || input.subjectKind === "job"
                ? input.reason
                : `lineage of invalidated evidence: ${input.reason}`,
            judgedBy: input.actor,
            supersedes: current?.id,
          });
          result.verdictsSuperseded.push(id);
        }
        for (const c of this.rows<Row>(
          "select run, seq from champion where attempt = ? and reopened = 0",
          attempt,
        )) {
          this.execute(
            "update champion set reopened = 1 where run = ? and seq = ?",
            String(c.run),
            Number(c.seq),
          );
          result.championsReopened.push({ run: String(c.run), seq: Number(c.seq) });
          this.ledger.appendEvent(input.actor, "champion_reopened", String(c.run), {
            seq: Number(c.seq),
            attempt,
            reason: input.reason,
          });
        }
        for (const child of this.rows<Row>(
          "select id from attempt where parent_attempt = ?",
          attempt,
        )) {
          frontier.push(String(child.id));
        }
      }
      this.ledger.appendEvent(input.actor, "invalidation", input.subjectId, {
        kind: input.subjectKind,
        reason: input.reason,
        attempts: result.attempts,
      });
      return result;
    });
  }
}
