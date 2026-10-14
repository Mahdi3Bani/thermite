import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson } from "../core/canonical.ts";
import type { SignedCommand } from "../core/commands.ts";

/**
 * Control's store: units, the events they report, and command queues. A single control process
 * owns it. Ingest is idempotent: re-sent events (same unit and event id) are ignored.
 */
type Row = Record<string, SQLInputValue>;

const SCHEMA = `
create table if not exists unit (
  id text primary key,
  first_seen text not null,
  last_seen text not null,
  last_cursor integer not null default 0,
  ledger_id text,
  summary text not null default '{}'
);
-- Event ids are unique only within one harness ledger, and a wiped or lost ledger starts again
-- at 1, so events are keyed by (unit, ledger_id, event_id). seq is control's own order.
create table if not exists unit_event (
  seq integer primary key autoincrement,
  unit text not null,
  ledger_id text not null,
  event_id integer not null,
  at text not null,
  actor text not null,
  kind text not null,
  subject text,
  body text not null,
  received_at text not null,
  unique (unit, ledger_id, event_id)
);
create index if not exists unit_event_kind on unit_event (unit, kind);
create table if not exists command (
  id text primary key,
  unit text not null,
  kind text not null,
  signed text not null,
  issued_by text not null,
  issued_at text not null,
  status text not null check (status in ('pending', 'delivered', 'rejected', 'failed', 'expired')),
  outcome text,
  acked_at text
);
create index if not exists command_pending on command (unit, status);
create table if not exists audit (
  id integer primary key autoincrement,
  at text not null,
  actor text not null,
  action text not null,
  body text not null
);
`;

export interface IngestReport {
  unit: string;
  ledger_id: string;
  cursor: number;
  next: number;
  events: {
    id: number;
    at: string;
    actor: string;
    kind: string;
    subject: string | null;
    body: unknown;
  }[];
  summary: unknown;
}

export class ControlStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  audit(actor: string, action: string, body: unknown): void {
    this.db
      .prepare("insert into audit (at, actor, action, body) values (?, ?, ?, ?)")
      .run(new Date().toISOString(), actor, action, canonicalJson(body ?? {}));
  }

  /** Stores a unit's report. Returns how many events were new. */
  ingest(report: IngestReport): number {
    const now = new Date().toISOString();
    return this.tx(() => {
      this.db
        .prepare(
          `insert into unit (id, first_seen, last_seen, last_cursor, ledger_id, summary)
           values (?, ?, ?, ?, ?, ?)
           on conflict (id) do update set last_seen = excluded.last_seen,
             last_cursor = case when unit.ledger_id = excluded.ledger_id
               then max(unit.last_cursor, excluded.last_cursor) else excluded.last_cursor end,
             ledger_id = excluded.ledger_id, summary = excluded.summary`,
        )
        .run(
          report.unit,
          now,
          now,
          report.next,
          report.ledger_id,
          canonicalJson(report.summary ?? {}),
        );
      let added = 0;
      const insert = this.db.prepare(
        `insert or ignore into unit_event (unit, ledger_id, event_id, at, actor, kind, subject, body,
           received_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of report.events) {
        added += Number(
          insert.run(
            report.unit,
            report.ledger_id,
            e.id,
            e.at,
            e.actor,
            e.kind,
            e.subject,
            canonicalJson(e.body ?? {}),
            now,
          ).changes,
        );
      }
      return added;
    });
  }

  units(): {
    id: string;
    last_seen: string;
    last_cursor: number;
    ledger_id: string | null;
    summary: unknown;
  }[] {
    return (this.db.prepare("select * from unit order by id").all() as Row[]).map((r) => ({
      id: String(r.id),
      last_seen: String(r.last_seen),
      last_cursor: Number(r.last_cursor),
      ledger_id: r.ledger_id === null ? null : String(r.ledger_id),
      summary: JSON.parse(String(r.summary)),
    }));
  }

  /** A unit's events in control's arrival order; `after` is a control `seq`, not an event id. */
  events(unit: string, after: number, limit: number): unknown[] {
    return (
      this.db
        .prepare(
          `select seq, ledger_id, event_id, at, actor, kind, subject, body from unit_event
             where unit = ? and seq > ? order by seq limit ?`,
        )
        .all(unit, after, limit) as Row[]
    ).map((r) => ({
      seq: Number(r.seq),
      ledger_id: String(r.ledger_id),
      id: Number(r.event_id),
      at: String(r.at),
      actor: String(r.actor),
      kind: String(r.kind),
      subject: r.subject === null ? null : String(r.subject),
      body: JSON.parse(String(r.body)),
    }));
  }

  enqueueCommand(signed: SignedCommand): void {
    const e = signed.envelope;
    this.db
      .prepare(
        "insert into command (id, unit, kind, signed, issued_by, issued_at, status) values (?, ?, ?, ?, ?, ?, 'pending')",
      )
      .run(e.id, e.unit, e.kind, canonicalJson(signed), e.issued_by, e.issued_at);
    this.audit(e.issued_by, "command_issued", { id: e.id, unit: e.unit, kind: e.kind });
  }

  pendingCommands(unit: string): SignedCommand[] {
    return (
      this.db
        .prepare(
          "select signed from command where unit = ? and status = 'pending' order by issued_at",
        )
        .all(unit) as Row[]
    ).map((r) => JSON.parse(String(r.signed)) as SignedCommand);
  }

  ackCommand(
    unit: string,
    id: string,
    status: "delivered" | "rejected" | "failed",
    outcome: unknown,
  ): boolean {
    const r = this.db
      .prepare(
        "update command set status = ?, outcome = ?, acked_at = ? where id = ? and unit = ? and status = 'pending'",
      )
      .run(status, canonicalJson(outcome ?? {}), new Date().toISOString(), id, unit);
    if (Number(r.changes) > 0) this.audit(`unit:${unit}`, "command_acked", { id, status });
    return Number(r.changes) > 0;
  }

  command(id: string): { status: string; outcome: unknown } | undefined {
    const r = this.db.prepare("select status, outcome from command where id = ?").get(id) as
      | Row
      | undefined;
    return r
      ? { status: String(r.status), outcome: r.outcome ? JSON.parse(String(r.outcome)) : null }
      : undefined;
  }
}
