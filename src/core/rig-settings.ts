import type { z } from "zod";
import type { CommandPayloads } from "./commands.ts";

/**
 * The rig's own settings, changed from its Edit page through a signed owner command
 * (rig_settings): which parts run, how many workers at once, a trial's length and turns, and the
 * promotion policy. The harness keeps them in its private state, applies them to its loops at
 * once, and reports them; the supervisor applies its own parts (auditor, teachers, review
 * panel) from that report, and control shows them. A part turned off keeps all its data. The GPU
 * split is applied by the broker when the harness starts, so changing it restarts the harness.
 */
export interface RigSettings {
  /** The judge builds and measures; off: changes wait in its queue. */
  judge: boolean;
  /** Workers start trials; off: no new trial starts. */
  workers: boolean;
  /** Trials at the same time. */
  lanes: number;
  /** The planner gives each worker its direction; off: the fixed fallback plan. */
  planner: boolean;
  /** The advisors (in the supervisor), used only where configured. */
  auditor: boolean;
  teachers: boolean;
  review: boolean;
  /** Hourly exports for the supervisor to push. */
  exports: boolean;
  /** A trial's length when its contract sets none, in minutes; null: none (goal 079). */
  trial_minutes: number | null;
  /** A cap on each trial's turns; null: none. */
  max_turns: number | null;
  /**
   * After how many minutes without a line a trial is quiet, and asks the owner under Needs you
   * (goal 143); null: never. It only shows: nothing ends a trial for it.
   */
  quiet_minutes: number | null;
  promotion: "auto" | "owner_approval";
  /**
   * On a rig configured with its GPU set (THERMITE_GPUS): how many cards are the judge's; the
   * rest are the agents'. Null: the rig's default. A change restarts the harness to regroup them.
   */
  judge_gpus: number | null;
}

/** The rig_settings payload: only the fields that change. */
export type RigSettingsChange = z.infer<(typeof CommandPayloads)["rig_settings"]>;
