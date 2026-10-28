import type { DatabaseSync } from "node:sqlite";

/**
 * The rigs' events as a kept view reads them (goal 168): whether a rig reported anything since the
 * view last read its events. The events themselves are read with ControlStore.events, as every
 * view reads them.
 */

/**
 * The newest seq of a rig's events after `after`, in any ledger and of any kind; null when the rig
 * reported none since. It reads only the events that came after `after`, of every rig: `+rig`
 * keeps SQLite off the index of a rig's events, which would read all of them.
 */
export function newestEventSeq(db: DatabaseSync, rig: string, after: number): number | null {
  const r = db
    .prepare("select max(seq) as seq from rig_event where seq > ? and +rig = ?")
    .get(after, rig) as { seq: number | null } | undefined;
  return r?.seq ?? null;
}
