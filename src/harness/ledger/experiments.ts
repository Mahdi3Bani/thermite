import type { EventOf } from "../../core/events/bodies.ts";
import type { EventKind } from "../../core/names.ts";
import { LedgerError, LedgerPart } from "./part.ts";
import { type ExperimentRow, toExperiment } from "./rows.ts";

/** The `experiment` table: the experiment queue's rows. */
export class LedgerExperiments extends LedgerPart {
  /**
   * Every change to a run's experiment queue goes through here: the rows it changes (the
   * experiment, and the queued ones whose place moved) and its one event, in one transaction.
   * A row keeps its creation time, its author and where it came from; its update time is now.
   */
  write(
    rows: Omit<ExperimentRow, "created_at" | "updated_at">[],
    event: EventOf<Extract<EventKind, `experiment_${string}`>> & { actor: string; run: string },
  ): number {
    return this.tx(() => {
      const now = this.now();
      const upsert = this.db.prepare(
        `insert into experiment (id, run, title, details, family, why, added_by, state, place, lane,
           trial, attempt, result, dropped_by, dropped_why, from_run, from_id, cause, returns,
           question, yield, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set title = excluded.title, details = excluded.details,
           family = excluded.family, why = excluded.why, state = excluded.state,
           place = excluded.place, lane = excluded.lane, trial = excluded.trial,
           attempt = excluded.attempt, result = excluded.result, dropped_by = excluded.dropped_by,
           dropped_why = excluded.dropped_why, cause = excluded.cause, returns = excluded.returns,
           question = coalesce(excluded.question, experiment.question),
           yield = coalesce(excluded.yield, experiment.yield),
           updated_at = excluded.updated_at
         where experiment.run = excluded.run`,
      );
      for (const r of rows) {
        const out = upsert.run(
          r.id,
          r.run,
          r.title,
          r.details,
          r.family,
          r.why,
          r.added_by,
          r.state,
          r.place,
          r.lane,
          r.trial,
          r.attempt,
          r.result,
          r.dropped_by,
          r.dropped_why,
          r.from_run,
          r.from_id,
          r.cause ?? null,
          r.returns ?? 0,
          r.question ?? null,
          r.yield ?? null,
          now,
          now,
        );
        if (Number(out.changes) === 0)
          throw new LedgerError("conflict", `experiment ${r.id} belongs to another run`);
      }
      return this.ledger.appendEvent(event.actor, event.kind, event.run, event.body);
    });
  }

  /** A run's experiments, oldest first. */
  list(run: string): ExperimentRow[] {
    return this.rows<ExperimentRow>(
      "select * from experiment where run = ? order by created_at, rowid",
      run,
    ).map(toExperiment);
  }

  get(id: string): ExperimentRow | undefined {
    const r = this.row<ExperimentRow>("select * from experiment where id = ?", id);
    return r ? toExperiment(r) : undefined;
  }
}
