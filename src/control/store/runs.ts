import type { DatabaseSync } from "node:sqlite";

/**
 * Control's run registry (goal 170): every run control signed an assignment for, and every run a
 * rig reported creating, by run and rig, with the campaign, the assignment and the rig's ledger.
 * A run's name is used while its assignment is pending or delivered, or once a rig created it;
 * the command's own status stays the one record of whether it went through. Runs named before
 * goal 170 may share a name across rigs, hence a row for each rig.
 */

/** The registry's table, and its rows from the commands and the events control already holds. */
export function runRegistryTable(db: DatabaseSync): void {
  db.exec(`create table if not exists run_registry (
  run text not null,
  rig text not null,
  campaign text,
  command text,
  assigned_at text,
  ledger_id text,
  created_at text,
  primary key (run, rig)
)`);
  db.exec(`insert into run_registry (run, rig, campaign, command, assigned_at)
  select json_extract(signed, '$.envelope.payload.run'), rig,
    json_extract(signed, '$.envelope.payload.contract.campaign'), id, issued_at
  from command where kind = 'assign_campaign'
    and json_extract(signed, '$.envelope.payload.run') is not null
  order by issued_at
  on conflict (run, rig) do update set campaign = excluded.campaign, command = excluded.command,
    assigned_at = excluded.assigned_at`);
  db.exec(`insert into run_registry (run, rig, campaign, ledger_id, created_at)
  select subject, rig, json_extract(body, '$.campaign'), ledger_id, at
  from rig_event where kind in ('run_created', 'instance_created') and subject is not null
  order by seq
  on conflict (run, rig) do update set ledger_id = excluded.ledger_id,
    created_at = excluded.created_at, campaign = coalesce(run_registry.campaign, excluded.campaign)`);
}

/** A command control signed: an assignment's run on its rig, for its campaign; others are not. */
export function registerAssignment(
  db: DatabaseSync,
  e: { id: string; rig: string; kind: string; issued_at: string; payload: unknown },
): void {
  const p = e.payload as { run?: unknown; contract?: { campaign?: unknown } } | null;
  if (e.kind !== "assign_campaign" || typeof p?.run !== "string") return;
  const campaign = typeof p.contract?.campaign === "string" ? p.contract.campaign : null;
  const a = { run: p.run, rig: e.rig, campaign, command: e.id, at: e.issued_at };
  db.prepare(
    `insert into run_registry (run, rig, campaign, command, assigned_at) values (?, ?, ?, ?, ?)
     on conflict (run, rig) do update set campaign = excluded.campaign,
       command = excluded.command, assigned_at = excluded.assigned_at`,
  ).run(a.run, a.rig, a.campaign, a.command, a.at);
}

/** An event a rig reported: a run it created goes in the registry, with the rig's ledger. */
export function registerRunCreated(
  db: DatabaseSync,
  rig: string,
  ledgerId: string,
  e: { kind: string; subject: string | null; body: unknown; at: string },
): void {
  if (e.kind !== "run_created" || !e.subject) return;
  const named = (e.body as { campaign?: unknown } | null)?.campaign;
  const campaign = typeof named === "string" ? named : null;
  const r = { run: e.subject, rig, campaign, ledgerId, at: e.at };
  db.prepare(
    `insert into run_registry (run, rig, campaign, ledger_id, created_at) values (?, ?, ?, ?, ?)
     on conflict (run, rig) do update set ledger_id = excluded.ledger_id,
       created_at = excluded.created_at, campaign = coalesce(run_registry.campaign, excluded.campaign)`,
  ).run(r.run, r.rig, r.campaign, r.ledgerId, r.at);
}

/** The registry's rows whose name is used: created on a rig, or assigned and not refused. */
const USED = `select r.run, r.rig, r.campaign, r.command from run_registry r
  left join command c on c.id = r.command
  where r.ledger_id is not null or c.status in ('pending', 'delivered')`;

/** The run names used so far that start with `prefix`. */
export function usedRunNames(db: DatabaseSync, prefix = ""): Set<string> {
  const like = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = db.prepare(`select run from (${USED}) where run like ? escape '\\'`).all(like) as {
    run: string;
  }[];
  return new Set(rows.map((r) => r.run));
}

/** The rig a run's name was used on, or undefined while it is free. */
export function rigOfRunName(db: DatabaseSync, run: string): string | undefined {
  const row = db.prepare(`select rig from (${USED}) where run = ? limit 1`).get(run) as
    | { rig: string }
    | undefined;
  return row?.rig;
}

/**
 * The campaigns control itself assigned to a rig, by run: its signed assignments that did not
 * fail, expire or get refused. What a rig may read and be given is decided from these, never
 * from what the rig's own events claim.
 */
export function assignedCampaignsOf(db: DatabaseSync, rig: string): Map<string, string> {
  const rows = db
    .prepare(
      `select r.run, r.campaign from run_registry r join command c on c.id = r.command
       where r.rig = ? and r.campaign is not null
         and c.status not in ('failed', 'rejected', 'expired')
       order by r.assigned_at`,
    )
    .all(rig) as { run: string; campaign: string }[];
  return new Map(rows.map((r) => [r.run, r.campaign]));
}
