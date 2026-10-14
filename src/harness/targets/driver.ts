/**
 * Target drivers connect the judge to whatever a campaign measures on: a GPU, a CPU set, a board.
 * The executor owns the clock: `run` measures wall time in the executor's process around the
 * child process; nothing the candidate prints is the score of record.
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

export interface RunSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string> | undefined;
  timeoutMs: number;
  uid?: number | undefined;
  gid?: number | undefined;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Measured by the executor around the child process. */
  wallMs: number;
  stdout: string;
  stderr: string;
}

export interface TargetDriver {
  readonly type: string;
  identify(): Promise<TargetIdentity>;
  /** Idle, healthy and at expected settings: required before every timed block. */
  readyForTiming(): Promise<Readiness>;
  envSnapshot(): Promise<Record<string, unknown>>;
  run(spec: RunSpec): Promise<RunResult>;
  /** Physical-limit checks; returns problems (empty when plausible). */
  plausibility(metrics: Record<string, number>): string[];
  recover(): Promise<Readiness>;
}
