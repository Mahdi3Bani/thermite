import type { ControlStore } from "../control/store.ts";

/** Control's own record that it assigned a run of a campaign to a rig (a delivered command). */
export function assigned(store: ControlStore, rig: string, run: string, campaign: string) {
  store.db
    .prepare(
      "insert into command (id, rig, kind, signed, issued_by, issued_at, status) values (?, ?, 'assign_campaign', ?, 'owner:ui', ?, 'delivered')",
    )
    .run(
      `cmd-${rig}-${run}`,
      rig,
      JSON.stringify({ envelope: { payload: { run, contract: { campaign } } } }),
      new Date().toISOString(),
    );
}
