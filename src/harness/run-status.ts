import { eventKinds } from "../core/names.ts";
import type { Ledger } from "./ledger.ts";

/**
 * A run's status changes after an event id, oldest first, under every name the event was
 * recorded with (core/names.ts: run_status was instance_status before 2026-10-15), so no reader
 * keeps its own copy of the rename (goal 163).
 */
export function statusEvents(
  ledger: Ledger,
  run: string,
  afterId = 0,
): { id: number; at: string; status: string }[] {
  const kinds = eventKinds("run_status");
  const rows = ledger.db
    .prepare(
      `select id, at, json_extract(body, '$.status') as status from event
       where kind in (${kinds.map(() => "?").join(", ")}) and subject = ? and id > ? order by id`,
    )
    .all(...kinds, run, afterId) as { id: number; at: string; status: unknown }[];
  return rows.map((r) => ({ id: Number(r.id), at: String(r.at), status: String(r.status) }));
}
