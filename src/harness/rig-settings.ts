import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { z } from "zod";
import type { CommandPayloads } from "../core/commands.ts";
import { MAX_LANES } from "../core/contract.ts";

/**
 * A trial's length from THERMITE_TRIAL_MINUTES (goal 079): unset or empty, none; else whole
 * minutes from 1 to 1,440, as a contract's `lanes.limits.trial_minutes`.
 */
export function trialMinutesFromEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1440)
    throw new Error(
      `THERMITE_TRIAL_MINUTES must be a whole number from 1 to 1440, or empty, not ${raw}`,
    );
  return n;
}

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
 * once, and reports them; the supervisor applies its own parts (auditor, teachers, review
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
    let saved: Partial<RigSettings> & { set_keys?: string[] } = {};
    if (file && existsSync(file)) {
      try {
        saved = JSON.parse(readFileSync(file, "utf8")) as typeof saved;
      } catch {}
    }
    // A file written before goal 079 kept every setting, defaults too: its 20-minute trial was
    // the old default, not a choice, and there is no default trial length now. A file that says
    // which settings someone set keeps exactly those.
    if (!saved.set_keys && saved.trial_minutes === 20) delete saved.trial_minutes;
    const { set_keys: _keys, ...values } = saved;
    this.current = { ...defaults, ...values };
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
      // Only what someone set is kept, with the names of those settings: the defaults stay the
      // environment's (goal 079).
      let kept: Record<string, unknown> & { set_keys?: string[] } = {};
      try {
        if (existsSync(this.file))
          kept = JSON.parse(readFileSync(this.file, "utf8")) as typeof kept;
      } catch {}
      const keys = new Set([
        ...(kept.set_keys ?? Object.keys(kept).filter((k) => k !== "set_keys")),
        ...Object.entries(change)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k),
      ]);
      const out: Record<string, unknown> = { set_keys: [...keys].sort() };
      for (const k of keys) out[k] = (next as unknown as Record<string, unknown>)[k];
      writeFileSync(`${this.file}.tmp`, JSON.stringify(out, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    }
    for (const f of this.listeners) f(this.get());
    return this.get();
  }

  onChange(f: (s: RigSettings) => void): void {
    this.listeners.push(f);
  }
}
