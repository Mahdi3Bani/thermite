import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson, sha256Hex } from "../core/canonical.ts";
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
create table if not exists unit_report (
  id integer primary key autoincrement,
  unit text not null,
  kind text not null,
  body text not null,
  at text not null
);
-- Full resets (owner only): pause, export, verify the push, wipe, restart. One open per unit.
create table if not exists reset (
  id integer primary key autoincrement,
  unit text not null,
  state text not null,
  requested_by text not null,
  command text,
  export_name text,
  through_event integer,
  detail text,
  created_at text not null,
  updated_at text not null
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
  private configuredUnits = new Set<string>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const cols = (this.db.prepare("pragma table_info(unit)").all() as Row[]).map((r) => r.name);
    if (!cols.includes("pubkey")) this.db.exec("alter table unit add column pubkey text");
    if (!cols.includes("pending_pubkey"))
      this.db.exec("alter table unit add column pending_pubkey text");
    if (!cols.includes("supervisor")) {
      this.db.exec("alter table unit add column supervisor text");
      this.db.exec("alter table unit add column supervisor_at text");
    }
  }

  /** The supervisor's own figures for a unit (unsigned: it reports them about itself). */
  setSupervisor(unit: string, stats: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into unit (id, first_seen, last_seen, supervisor, supervisor_at) values (?, ?, ?, ?, ?)
         on conflict (id) do update set supervisor = excluded.supervisor, supervisor_at = excluded.supervisor_at`,
      )
      .run(unit, now, now, canonicalJson(stats ?? {}), now);
  }

  supervisor(unit: string): Record<string, unknown> | null {
    const r = this.db
      .prepare("select supervisor, supervisor_at from unit where id = ?")
      .get(unit) as Row | undefined;
    return r?.supervisor
      ? { ...(JSON.parse(String(r.supervisor)) as object), received_at: String(r.supervisor_at) }
      : null;
  }

  addReport(unit: string, kind: string, body: string): number {
    const r = this.db
      .prepare("insert into unit_report (unit, kind, body, at) values (?, ?, ?, ?)")
      .run(unit, kind, body.slice(0, 200_000), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  reports(
    limit = 20,
    unit?: string,
  ): { id: number; unit: string; kind: string; body: string; at: string }[] {
    const rows = (
      unit
        ? this.db
            .prepare("select * from unit_report where unit = ? order by id desc limit ?")
            .all(unit, limit)
        : this.db.prepare("select * from unit_report order by id desc limit ?").all(limit)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      unit: String(r.unit),
      kind: String(r.kind),
      body: String(r.body),
      at: String(r.at),
    }));
  }

  openReset(unit: string): Row | undefined {
    return this.db
      .prepare(
        "select * from reset where unit = ? and state not in ('done', 'failed', 'cancelled') order by id desc",
      )
      .get(unit) as Row | undefined;
  }

  resets(limit = 20): Row[] {
    return this.db.prepare("select * from reset order by id desc limit ?").all(limit) as Row[];
  }

  createReset(unit: string, by: string): number {
    if (this.openReset(unit)) throw new Error(`a reset of ${unit} is already in progress`);
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        "insert into reset (unit, state, requested_by, created_at, updated_at) values (?, 'start', ?, ?, ?)",
      )
      .run(unit, by, now, now);
    this.audit(by, "reset_requested", { unit });
    return Number(r.lastInsertRowid);
  }

  updateReset(
    id: number,
    fields: {
      state: string;
      command?: string;
      export_name?: string;
      through_event?: number;
      detail?: string;
    },
  ): void {
    this.db
      .prepare(
        `update reset set state = ?, command = coalesce(?, command), export_name = coalesce(?, export_name),
           through_event = coalesce(?, through_event), detail = coalesce(?, detail), updated_at = ? where id = ?`,
      )
      .run(
        fields.state,
        fields.command ?? null,
        fields.export_name ?? null,
        fields.through_event ?? null,
        fields.detail ?? null,
        new Date().toISOString(),
        id,
      );
    this.audit("control", "reset_step", { id, ...fields });
  }

  /** The unit's pinned report-signing key, if any. */
  unitKey(unit: string): { pubkey: string | null; pending: string | null } {
    const r = this.db.prepare("select pubkey, pending_pubkey from unit where id = ?").get(unit) as
      | Row
      | undefined;
    return {
      pubkey: r?.pubkey ? String(r.pubkey) : null,
      pending: r?.pending_pubkey ? String(r.pending_pubkey) : null,
    };
  }

  /** Pins a unit's key on first contact (trust on first use, shown on the dashboard). */
  pinKey(unit: string, pubkey: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into unit (id, first_seen, last_seen, pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pubkey = excluded.pubkey, pending_pubkey = null`,
      )
      .run(unit, now, now, pubkey);
    this.audit(`unit:${unit}`, "unit_key_pinned", { fingerprint: fingerprint(pubkey) });
  }

  /** A different key arrived: hold it until the owner accepts it. */
  holdKey(unit: string, pubkey: string): void {
    this.db.prepare("update unit set pending_pubkey = ? where id = ?").run(pubkey, unit);
    this.audit(`unit:${unit}`, "unit_key_changed", { fingerprint: fingerprint(pubkey) });
  }

  acceptPendingKey(unit: string, actor: string): boolean {
    const { pending } = this.unitKey(unit);
    if (!pending) return false;
    this.db
      .prepare("update unit set pubkey = pending_pubkey, pending_pubkey = null where id = ?")
      .run(unit);
    this.audit(actor, "unit_key_accepted", { unit, fingerprint: fingerprint(pending) });
    return true;
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
      // A harness's own record of a command it applied is authoritative (it is signed with the
      // unit's key); the supervisor's acknowledgement is only the fast path.
      const confirm = this.db.prepare(
        "update command set status = ?, outcome = ?, acked_at = coalesce(acked_at, ?) where id = ? and unit = ?",
      );
      for (const e of report.events) {
        if (e.kind === "command" && e.subject) {
          const b = (e.body ?? {}) as { accepted?: boolean };
          confirm.run(
            b.accepted === false ? "failed" : "delivered",
            canonicalJson({ source: "harness", ...(e.body as object) }),
            now,
            e.subject,
            report.unit,
          );
        }
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

  /** Units that have a token but have not reported yet still accept commands. */
  knownUnit(unit: string): boolean {
    return this.configuredUnits.has(unit);
  }

  setConfiguredUnits(units: readonly string[]): void {
    this.configuredUnits = new Set(units);
  }

  listCommands(limit = 100): {
    id: string;
    unit: string;
    kind: string;
    issued_by: string;
    issued_at: string;
    status: string;
    acked_at: string | null;
    outcome: unknown;
  }[] {
    return (
      this.db
        .prepare(
          "select id, unit, kind, issued_by, issued_at, status, acked_at, outcome from command order by issued_at desc limit ?",
        )
        .all(limit) as Row[]
    ).map((r) => ({
      id: String(r.id),
      unit: String(r.unit),
      kind: String(r.kind),
      issued_by: String(r.issued_by),
      issued_at: String(r.issued_at),
      status: String(r.status),
      acked_at: r.acked_at === null ? null : String(r.acked_at),
      outcome: r.outcome ? JSON.parse(String(r.outcome)) : null,
    }));
  }

  listAudit(limit = 200): { at: string; actor: string; action: string; body: unknown }[] {
    return (
      this.db
        .prepare("select at, actor, action, body from audit order by id desc limit ?")
        .all(limit) as Row[]
    ).map((r) => ({
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      body: JSON.parse(String(r.body)),
    }));
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

/** A short fingerprint of a public key, for the dashboard and the audit log. */
export function fingerprint(pubkeyPem: string): string {
  return sha256Hex(pubkeyPem.trim()).slice(0, 16);
}
