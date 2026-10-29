import type { DatabaseSync } from "node:sqlite";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { canonicalJson } from "../../core/canonical.ts";
import { currentEvent } from "../../core/names.ts";
import { type Row, StorePart } from "./part.ts";
import type { IngestReport } from "./report.ts";

/**
 * The events rigs reported (goal 125, T6): a report taken, with its events. Control's views, its
 * raw reads of events and the knowledge base read the message bus's events stream (goal 168,
 * step 4); the table is read only by its copy there (control/events/mirror.ts), until the copy
 * goes, and by the store's migrations.
 */

/**
 * A rig's events by ledger, in control's order (store migration 8): a view's pages of events
 * started at a seq and stopped after a page, where they read the whole ledger again for each page
 * and sorted it. The views read the events stream now; the migration stays, as every one does.
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

  /**
   * The report's events, and the rig's row, in one transaction. What control derives from the
   * events (a command's outcome, a model call's usage, the knowledge base's items) the apply of
   * the events stream writes (control/events), in the stream's order. A run a rig created goes in
   * the run registry here too, before the copy on the bus chooses its events' subjects from the
   * registry; the apply writes it again, the same, from the stream.
   */
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
        this.store.runRegistry.registerRunCreated(report.rig, report.ledger_id, currentEvent(e));
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
