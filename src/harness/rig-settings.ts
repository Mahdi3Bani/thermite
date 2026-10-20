import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { z } from "zod";
import type { CommandPayloads } from "../core/commands.ts";
import { MAX_LANES } from "../core/contract.ts";

/**
 * Workers at a time from THERMITE_MAX_TRIALS (unset: 1; 0: a rig that starts no trials, such as
 * one that only judges or runs its advisors). A rig runs at most MAX_LANES, as on Edit rig;
 * anything else stops the harness at start with the reason.
 */
export function lanesFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_LANES)
    throw new Error(
      `THERMITE_MAX_TRIALS must be a whole number from 0 to ${MAX_LANES}, not ${raw}: a rig has users for lanes 1 to ${MAX_LANES} only`,
    );
  return n;
}

/**
 * The rig's own settings, changed from its Edit page through a signed owner command
 * (rig_settings): which parts run, how many workers at once, a trial's length and turns, and the
 * promotion policy. The harness keeps them in its private state, applies them to its loops at
 * once, and reports them; the supervisor applies its own parts (auditor, teacher pair, review
 * panel) from that report. A part turned off keeps all its data. The GPU split is applied by the
 * broker when the harness starts, so changing it restarts the harness.
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
  /** The supervisor's advisors, used only where configured. */
  auditor: boolean;
  teachers: boolean;
  review: boolean;
  /** Hourly exports for the supervisor to push. */
  exports: boolean;
  /** A trial's length when its contract sets none, in minutes. */
  trial_minutes: number;
  /** A cap on each trial's turns; null: none. */
  max_turns: number | null;
  promotion: "auto" | "owner_approval";
  /**
   * On a rig configured with its GPU set (THERMITE_GPUS): how many cards are the judge's; the
   * rest are the agents'. Null: the rig's default. A change restarts the harness to regroup them.
   */
  judge_gpus: number | null;
}

export type RigSettingsChange = z.infer<(typeof CommandPayloads)["rig_settings"]>;

export class RigSettingsStore {
  private current: RigSettings;
  private readonly listeners: ((s: RigSettings) => void)[] = [];
  private readonly file: string | undefined;

  /** Settings kept in `file` (none: in memory only), starting from `defaults`. */
  constructor(defaults: RigSettings, file?: string | undefined) {
    this.file = file;
    let saved: Partial<RigSettings> = {};
    if (file && existsSync(file)) {
      try {
        saved = JSON.parse(readFileSync(file, "utf8")) as Partial<RigSettings>;
      } catch {}
    }
    this.current = { ...defaults, ...saved };
  }

  get(): RigSettings {
    return { ...this.current };
  }

  /** Applies a change, keeps it, and tells the loops that read it. */
  set(change: RigSettingsChange): RigSettings {
    const next = { ...this.current };
    for (const [k, v] of Object.entries(change))
      if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    this.current = next;
    if (this.file) {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    }
    for (const f of this.listeners) f(this.get());
    return this.get();
  }

  onChange(f: (s: RigSettings) => void): void {
    this.listeners.push(f);
  }
}
