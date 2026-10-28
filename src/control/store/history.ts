import { type Row, StorePart } from "./part.ts";

/**
 * Each rig's history (goal 125, T6): the steps of its setup and management.
 */

export class RigHistory extends StorePart {
  /** One step of a rig's setup or management, for its history. */
  add(rig: string, step: string, ok: boolean, detail?: string): void {
    this.db
      .prepare("insert into rig_setup_event (rig, at, step, ok, detail) values (?, ?, ?, ?, ?)")
      .run(rig, new Date().toISOString(), step, ok ? 1 : 0, detail ?? null);
  }

  list(rig: string): { at: string; step: string; ok: boolean; detail: string | null }[] {
    return (
      this.db.prepare("select * from rig_setup_event where rig = ? order by id").all(rig) as Row[]
    ).map((r) => ({
      at: String(r.at),
      step: String(r.step),
      ok: Number(r.ok) === 1,
      detail: r.detail === null ? null : String(r.detail),
    }));
  }
}
