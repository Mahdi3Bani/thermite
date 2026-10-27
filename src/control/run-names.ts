import type { ControlStore } from "./store.ts";

/**
 * Run names on control (goal 170): a run's name is used once, across every rig and every ledger
 * control has heard of, retired rigs and runs from before a full reset included. Control mints
 * the readable `<campaign>-<n>` numbered across all of them, and refuses an assignment whose name
 * was used, on every path that starts a run.
 */

/**
 * The run names used so far that start with `prefix`: every run a rig reported, and every
 * assignment control signed that did not fail, expire or get refused (on its way, or delivered).
 */
function usedNames(store: ControlStore, prefix = ""): Set<string> {
  const like = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = store.db
    .prepare(
      `select subject as run from rig_event
         where kind = 'run_created' and subject like ? escape '\\'
       union
       select json_extract(signed, '$.envelope.payload.run') from command
         where kind = 'assign_campaign' and status in ('pending', 'delivered')
           and json_extract(signed, '$.envelope.payload.run') like ? escape '\\'`,
    )
    .all(like, like) as { run: string | null }[];
  return new Set(rows.flatMap((r) => (r.run ? [r.run] : [])));
}

/** The rig a run name was used on, or undefined while it is free. */
export function runNameUsed(store: ControlStore, run: string): string | undefined {
  const row = store.db
    .prepare(
      `select rig from rig_event where kind = 'run_created' and subject = ?
       union all
       select rig from command where kind = 'assign_campaign' and status in ('pending', 'delivered')
         and json_extract(signed, '$.envelope.payload.run') = ?
       limit 1`,
    )
    .get(run, run) as { rig: string } | undefined;
  return row?.rig;
}

/** A name for a campaign's next run: the campaign's name and the next number used nowhere. */
export function nextRunName(store: ControlStore, campaign: string): string {
  const base = campaign.slice(0, 58);
  const taken = usedNames(store, `${base}-`);
  for (let n = 1; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Why an assignment's run name can't be used, in words; empty when it can. */
export function usedRunRefusal(
  store: ControlStore,
  payload: { run: string; contract?: { campaign?: string } },
): string {
  const on = runNameUsed(store, payload.run);
  if (!on) return "";
  const next = nextRunName(store, payload.contract?.campaign ?? payload.run);
  return `run ${payload.run} was used already, on ${on}: a run's name is used once on control, on every rig. Choose another, such as ${next}`;
}
