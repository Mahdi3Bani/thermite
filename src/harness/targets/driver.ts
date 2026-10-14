/**
 * Target drivers connect the judge to whatever a campaign measures on: a GPU, a CPU set, a board.
 * They identify the target, say whether it is ready for timing, and record its state. The work
 * itself runs through the broker, which owns the clock: nothing the candidate prints is the
 * score of record.
 */

export interface TargetIdentity {
  type: string;
  class: string;
  /** Stable identity used as the comparability key (never compare across different ids). */
  id: string;
  details: Record<string, unknown>;
}

export interface Readiness {
  ready: boolean;
  reasons: string[];
  details: Record<string, unknown>;
}

export interface TargetDriver {
  readonly type: string;
  identify(): Promise<TargetIdentity>;
  /** Idle, healthy and at expected settings: required before every timed block. */
  readyForTiming(): Promise<Readiness>;
  envSnapshot(): Promise<Record<string, unknown>>;
  /**
   * Problems that make the block just measured invalid (for a GPU: throttling or thermal events,
   * overheating). Checked after every block; an empty list means the block stands.
   */
  afterBlock(): Promise<string[]>;
  /** Physical-limit checks; returns problems (empty when plausible). */
  plausibility(metrics: Record<string, number>): string[];
  recover(): Promise<Readiness>;
}
