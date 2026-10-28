import type { DatabaseSync } from "node:sqlite";

/**
 * The message bus's keys in control's store (goal 168): the user key each rig's supervisor
 * registered, its public part only, and control's own two keys, their seeds sealed with control's
 * secrets key. The audit log and the rig's history keep each change of a rig's key.
 */

/** Control's own keys on the bus: its user in the account, and its user in the system account. */
export type BusIdentityName = "control" | "system";

/** The tables, made by the store's migration to schema version 7. */
export function busKeyTables(db: DatabaseSync): void {
  db.exec(`create table if not exists rig_bus_key (
  rig text primary key,
  public_key text not null,
  registered_at text not null
)`);
  db.exec(`create table if not exists bus_identity (
  name text primary key check (name in ('control', 'system')),
  public_key text not null,
  seed_sealed text not null,
  created_at text not null
)`);
}

/** The key a rig registered, or undefined when it has none. */
export function rigBusKey(db: DatabaseSync, rig: string): string | undefined {
  const r = db.prepare("select public_key from rig_bus_key where rig = ?").get(rig) as
    | { public_key: string }
    | undefined;
  return r?.public_key;
}

/** Records the key a rig registered, in place of the one before. */
export function setRigBusKey(db: DatabaseSync, rig: string, key: string): void {
  db.prepare(
    `insert into rig_bus_key (rig, public_key, registered_at) values (?, ?, ?)
     on conflict (rig) do update set public_key = excluded.public_key,
       registered_at = excluded.registered_at`,
  ).run(rig, key, new Date().toISOString());
}

/** Every rig's registered key, by rig. */
export function rigBusKeys(db: DatabaseSync): { rig: string; key: string }[] {
  const rows = db.prepare("select rig, public_key from rig_bus_key order by rig").all() as {
    rig: string;
    public_key: string;
  }[];
  return rows.map((r) => ({ rig: r.rig, key: r.public_key }));
}

/** One of control's own keys, or undefined before it was made. */
export function busIdentity(
  db: DatabaseSync,
  name: BusIdentityName,
): { publicKey: string; sealedSeed: string } | undefined {
  const r = db
    .prepare("select public_key, seed_sealed from bus_identity where name = ?")
    .get(name) as { public_key: string; seed_sealed: string } | undefined;
  return r ? { publicKey: r.public_key, sealedSeed: r.seed_sealed } : undefined;
}

/** Keeps one of control's own keys, unless it has one of that name already. */
export function addBusIdentity(
  db: DatabaseSync,
  name: BusIdentityName,
  publicKey: string,
  sealedSeed: string,
): void {
  db.prepare(
    `insert or ignore into bus_identity (name, public_key, seed_sealed, created_at)
     values (?, ?, ?, ?)`,
  ).run(name, publicKey, sealedSeed, new Date().toISOString());
}
