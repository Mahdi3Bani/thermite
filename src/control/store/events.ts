import type { DatabaseSync } from "node:sqlite";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { canonicalJson } from "../../core/canonical.ts";
import { currentEvent } from "../../core/names.ts";
import { MODEL_CALL_EVENT, ModelCallBody } from "../../core/usage.ts";
import { type Row, StorePart } from "./part.ts";
import type { IngestReport } from "./report.ts";

/**
 * The events rigs reported (goal 125, T6): a report taken, with its events, and the events read
 * back, by rig and by run.
 */

/**
 * A rig's events by ledger, in control's order (store migration 8): a view's pages of events start
 * at a seq and stop after a page, where they read the whole ledger again for each page and sorted
 * it.
 */
export function eventsInOrderIndex(db: DatabaseSync): void {
  db.exec("create index if not exists rig_event_ledger_seq on rig_event (rig, ledger_id, seq)");
}

/** An event as control's table keeps it: its place there, its rig and ledger, and the event. */
export interface StoredEvent {
  seq: number;
  rig: string;
  ledger_id: string;
  event: { id: number; at: string; actor: string; kind: string; subject: string | null };
  /** The event's body, as the table keeps it: canonical JSON. */
  body: string;
  run: string | null;
}

export class RigEvents extends StorePart {
  /** Told each time ingest stores new events: the copy on the message bus (control/events). */
  private readonly watchers = new Set<() => void>();

  /** Tells `fn` each time ingest stores new events, until the function it returns is called. */
  watch(fn: () => void): () => void {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  /** Stores a rig's report. Returns how many events were new; tells the watchers when any were. */
  ingest(report: IngestReport): number {
    const added = this.keepReport(report);
    if (!added) return added;
    for (const fn of this.watchers) {
      try {
        fn();
      } catch (err) {
        const what = { rig: report.rig, error: errorText(err) };
        log("control", "a watcher of the events table failed", what, "error");
      }
    }
    return added;
  }

  private keepReport(report: IngestReport): number {
    const now = new Date().toISOString();
    return this.tx(() => {
      this.store.reportedRigs.noteReport(report, now);
      let added = 0;
      const insert = this.db.prepare(
        `insert or ignore into rig_event (rig, ledger_id, event_id, at, actor, kind, subject, body,
           received_at, run) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of report.events) {
        this.store.runRegistry.registerRunCreated(report.rig, report.ledger_id, e);
        if (e.kind === "command" && e.subject) {
          const b = (e.body ?? {}) as { accepted?: boolean };
          this.store.commands.confirmApplied(
            report.rig,
            e.subject,
            b.accepted === false ? "failed" : "delivered",
            canonicalJson({ source: "harness", ...(e.body as object) }),
            now,
          );
        }
        // A model call's usage (goal 075), as columns the sums read. A body that does not read as
        // one stays an event only.
        const call =
          e.kind === MODEL_CALL_EVENT && e.subject ? ModelCallBody.safeParse(e.body) : null;
        if (call?.success)
          this.store.usage.recordCall(
            report.rig,
            report.ledger_id,
            e.id,
            String(e.subject),
            call.data,
          );
        added += Number(
          insert.run(
            report.rig,
            report.ledger_id,
            e.id,
            e.at,
            e.actor,
            e.kind,
            e.subject,
            canonicalJson(e.body ?? {}),
            now,
            e.run ?? null,
          ).changes,
        );
      }
      return added;
    });
  }

  /**
   * The prompts a run's agents were sent on a rig (goal 166), oldest first: each `agent_prompt`
   * event's body, with when the rig recorded it and its ledger.
   */
  prompts(rig: string, run: string): { at: string; ledger_id: string; body: unknown }[] {
    const rows = this.db
      .prepare(
        `select at, ledger_id, body from rig_event
           where rig = ? and kind = 'agent_prompt' and run = ? order by seq`,
      )
      .all(rig, run) as { at: string; ledger_id: string; body: string }[];
    return rows.map((r) => ({ at: r.at, ledger_id: r.ledger_id, body: JSON.parse(r.body) }));
  }

  /**
   * A rig's events after a seq. `lean`: without the text a source's and a document's events
   * carry (the knowledge base keeps it), and without the model calls (one for each call: the
   * usage sums read them, from model_call), for readers that build pages from every event.
   */
  after(
    rig: string,
    after: number,
    limit: number,
    ledgerId?: string | null,
    o: { lean?: boolean } = {},
  ): unknown[] {
    const byLedger = ledgerId ? " and ledger_id = ?" : "";
    const body = o.lean
      ? "case when kind in ('source_fetched', 'research_doc', 'context_compacted') then json_remove(body, '$.text') else body end"
      : "body";
    const calls = o.lean ? ` and kind != '${MODEL_CALL_EVENT}'` : "";
    return (
      this.db
        .prepare(
          `select seq, ledger_id, event_id, at, actor, kind, subject, ${body} as body, run from rig_event
             where rig = ?${byLedger}${calls} and seq > ? order by seq limit ?`,
        )
        .all(...(ledgerId ? [rig, ledgerId, after, limit] : [rig, after, limit])) as Row[]
    ).map((r) =>
      // Events a harness reported before the 2026-10-15 rename are read under the new names.
      currentEvent({
        seq: Number(r.seq),
        ledger_id: String(r.ledger_id),
        id: Number(r.event_id),
        at: String(r.at),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: r.subject === null ? null : String(r.subject),
        body: JSON.parse(String(r.body)),
        run: r.run === null ? null : String(r.run),
      }),
    );
  }

  /**
   * For a kept view (goal 168): the newest seq of a rig's events after `after`, in any ledger and
   * of any kind; null when the rig reported none since the view last read its events. It reads
   * only the events that came after `after`, of every rig: `+rig` keeps SQLite off the index of a
   * rig's events, which would read all of them.
   */
  newestSeq(rig: string, after: number): number | null {
    const r = this.db
      .prepare("select max(seq) as seq from rig_event where seq > ? and +rig = ?")
      .get(after, rig) as { seq: number | null } | undefined;
    return r?.seq ?? null;
  }

  /** The table's last seq: 0 while it holds no event. */
  lastSeq(): number {
    const r = this.db.prepare("select max(seq) as seq from rig_event").get() as {
      seq: number | null;
    };
    return Number(r.seq ?? 0);
  }

  /** How many events the table holds after a seq. */
  countAfter(seq: number): number {
    const r = this.db.prepare("select count(*) as n from rig_event where seq > ?").get(seq) as {
      n: number;
    };
    return Number(r.n);
  }

  /**
   * Every rig's events after a seq, in the table's order, `limit` at most, as the table keeps them:
   * for the copy on the message bus, which keeps each as the rig recorded it.
   */
  inOrder(after: number, limit: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        `select seq, rig, ledger_id, event_id, at, actor, kind, subject, body, run from rig_event
           where seq > ? order by seq limit ?`,
      )
      .all(after, limit) as Row[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      rig: String(r.rig),
      ledger_id: String(r.ledger_id),
      event: {
        id: Number(r.event_id),
        at: String(r.at),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: r.subject === null ? null : String(r.subject),
      },
      body: String(r.body),
      run: r.run === null ? null : String(r.run),
    }));
  }
}
