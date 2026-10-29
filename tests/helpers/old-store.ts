import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../src/core/canonical.ts";

/**
 * Control's store as a Thermite from before the events stream left it (goal 168, step 4): its
 * events table, `rig_event`, holding the rigs' events, and the rig's `last_cursor`, at a schema
 * version before store migration 12 drops them. The tests of the move to the stream make one from
 * a store of this code's, or from the store v0.1.0 wrote.
 */

/** One row of an old store's events table: a rig ledger's event. */
export interface OldRow {
  rig: string;
  ledger: string;
  id: number;
  kind: string;
  subject?: string | null;
  run?: string | null;
  body?: unknown;
  at?: string;
}

/**
 * The events table as the migrations up to 11 left it, with its indexes, made again in a store of
 * this code's; the rig's `last_cursor` too; and the store's version set back to `version`.
 */
export function withEventsTable(db: DatabaseSync, version = 11): void {
  db.exec(`create table if not exists rig_event (
  seq integer primary key autoincrement,
  rig text not null,
  ledger_id text not null,
  event_id integer not null,
  at text not null,
  actor text not null,
  kind text not null,
  subject text,
  body text not null,
  received_at text not null,
  run text,
  unique (rig, ledger_id, event_id)
);
create index if not exists rig_event_kind on rig_event (rig, kind);
create index if not exists rig_event_subject on rig_event (kind, subject);
create index if not exists rig_event_run on rig_event (run, seq);
create index if not exists rig_event_ledger_seq on rig_event (rig, ledger_id, seq);`);
  const cols = db.prepare("pragma table_info(rig)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "last_cursor"))
    db.exec("alter table rig add column last_cursor integer not null default 0");
  db.prepare("delete from schema_migrations where version > ?").run(version);
}

/**
 * Rows kept as an old control's ingest kept them: each event in the table, in order, a run a row
 * creates in the run registry (a store from before the registry, as v0.1.0's, has its migration
 * fill it), and each rig's row and ledgers as its last row's ledger left them. A table without a
 * `run` column (v0.1.0) keeps none.
 */
export function keepOldRows(db: DatabaseSync, rows: readonly OldRow[]): void {
  const hasRun = (db.prepare("pragma table_info(rig_event)").all() as { name: string }[]).some(
    (c) => c.name === "run",
  );
  const insert = db.prepare(
    `insert into rig_event (rig, ledger_id, event_id, at, actor, kind, subject, body, received_at${hasRun ? ", run" : ""})
     values (?, ?, ?, ?, 'harness', ?, ?, ?, ?${hasRun ? ", ?" : ""})`,
  );
  const now = "2026-10-29T07:00:00.000Z";
  const registry = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'run_registry'")
    .get();
  const last = new Map<string, OldRow>();
  for (const r of rows) {
    const at = r.at ?? new Date(Date.UTC(2026, 9, 29, 7, 0, 0, r.id)).toISOString();
    const values = [
      r.rig,
      r.ledger,
      r.id,
      at,
      r.kind,
      r.subject ?? null,
      canonicalJson(r.body ?? { n: r.id }),
      now,
    ];
    insert.run(...values, ...(hasRun ? [r.run ?? null] : []));
    if (registry && r.kind === "run_created" && r.subject)
      db.prepare(
        `insert into run_registry (run, rig, campaign, ledger_id, created_at) values (?, ?, ?, ?, ?)
         on conflict (run, rig) do update set ledger_id = excluded.ledger_id`,
      ).run(
        r.subject,
        r.rig,
        String((r.body as { campaign?: unknown })?.campaign ?? ""),
        r.ledger,
        at,
      );
    last.set(r.rig, r);
  }
  for (const [rig, r] of last) {
    db.prepare(
      `insert into rig (id, first_seen, last_seen, last_cursor, ledger_id, summary, report_at)
       values (?, ?, ?, ?, ?, '{}', ?)
       on conflict (id) do update set last_cursor = excluded.last_cursor, ledger_id = excluded.ledger_id`,
    ).run(rig, now, now, r.id, r.ledger, now);
    for (const ledger of new Set(rows.filter((x) => x.rig === rig).map((x) => x.ledger)))
      db.prepare(
        `insert or ignore into rig_ledger (rig, ledger_id, first_seen, superseded_at)
         values (?, ?, ?, ?)`,
      ).run(rig, ledger, now, ledger === r.ledger ? null : now);
  }
}
