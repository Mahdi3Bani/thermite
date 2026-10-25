import type { Ledger } from "../ledger.ts";

/**
 * The rig's drain before its images change (goal 079): no new trial, plan or judge job starts,
 * and those running end as they would. The harness keeps it in memory only, and the restart it
 * prepares ends it. The ledger keeps each change as `rig_drain`, and the harness records the end
 * of a drain that a restart ended when it starts again (goal 136), so a research run's clock can
 * leave the drain out.
 */

export interface Draining {
  since: string;
  reason: string;
  by: string;
}

/** The reason recorded for the end of a drain that a restart ended. */
export const RESTARTED = "the harness started again";

/** The drain after a `drain_rig` command: a drain under way stays as it began. */
export function drainAfter(
  now: Draining | undefined,
  p: { drain: boolean; reason?: string | undefined },
  by: string,
  at: Date,
): Draining | undefined {
  if (!p.drain) return undefined;
  return (
    now ?? { since: at.toISOString(), reason: p.reason ?? "its images are about to change", by }
  );
}

/** At start: a drain the ledger leaves open was ended by the restart. Records its end. */
export function endDrainAtStart(ledger: Ledger, by: string): boolean {
  const last = ledger.db
    .prepare("select body from event where kind = 'rig_drain' order by id desc limit 1")
    .get() as { body: string } | undefined;
  if (!last || (JSON.parse(last.body) as { drain?: unknown }).drain !== true) return false;
  ledger.appendEvent(by, "rig_drain", null, { drain: false, reason: RESTARTED });
  return true;
}

/**
 * When the rig drained, oldest first: from each `rig_drain` that starts a drain to the one that
 * ends it, or to the first trial started after it. A draining rig starts no trial, so a trial's
 * start shows the drain had ended: a harness older than goal 136 recorded no end at its restart.
 * A drain still under way runs to `now`.
 */
export function drainSpans(ledger: Ledger, now: number): [number, number][] {
  const first = ledger.db
    .prepare("select min(id) as id from event where kind = 'rig_drain'")
    .get() as { id: number | null } | undefined;
  if (first?.id == null) return [];
  const spans: [number, number][] = [];
  let since: number | null = null;
  for (const e of ledger.db
    .prepare(
      "select kind, at, body from event where kind in ('rig_drain', 'trial_started') and id >= ? order by id",
    )
    .all(first.id) as { kind: string; at: string; body: string }[]) {
    const at = Date.parse(e.at);
    // Asked again while it drains: the same drain.
    if (e.kind === "rig_drain" && (JSON.parse(e.body) as { drain?: unknown }).drain === true)
      since ??= at;
    else if (since !== null) {
      spans.push([since, at]);
      since = null;
    }
  }
  if (since !== null) spans.push([since, now]);
  return spans;
}
