import type { RigOp } from "./runpod-lifecycle.ts";
import type { StoredRunpodRig, TunnelRig } from "./store.ts";

/**
 * A rig the owner launched on a GPU cloud, as control keeps it (runpod-rigs.ts): what it was
 * launched with, its pod as control last saw it, its price, what it has cost, and the owner's
 * spend limit and idle stop. Neither has a default today: each applies only when the owner set
 * it (runpod-rigs.ts's DEFAULT_IDLE_STOP_MINUTES keeps the idle stop's default: none).
 */
export interface RigState {
  image: string;
  /** RunPod's id of the GPU type, and its name. */
  gpu: string;
  gpu_name: string;
  gpu_count: number;
  cloud_type: "SECURE" | "COMMUNITY";
  /** The data center asked for, or the one RunPod chose (null until it says). */
  datacenter: string | null;
  container_disk_gb: number;
  volume_gb: number;
  /** USD per hour for the whole pod: RunPod's price for it, else the GPU's list price. */
  price_per_hr: number | null;
  /** The pod's status at RunPod as control last read it (RUNNING, EXITED, ...). */
  status: string;
  status_at: string | null;
  launched_at: string;
  /** What the pod cost up to billed_since, in USD, at the prices control saw. */
  spent_usd: number;
  /** Since when it runs and costs price_per_hr; null while it is stopped. */
  billed_since: string | null;
  /** Since when it runs without a break (its idle time counts from here at the earliest). */
  running_since: string | null;
  /** The owner's limits; null: none. */
  spend_limit_usd: number | null;
  idle_stop_minutes: number | null;
  /** When the idle stop was set: idle time counts from here at the earliest. */
  idle_from: string | null;
  /** The last time a run was at work on the rig, as control saw it (runpod-rigs.ts's lastWork). */
  busy_at: string | null;
  /** A run was at work on the rig at control's last check: no idle time counts now. */
  at_work?: boolean | undefined;
  /** When control stopped the pod, and why: a limit the owner set, or the owner's stop. */
  stopped_at: string | null;
  stopped_by: "spend_limit" | "idle_stop" | "owner" | null;
  /** When RunPod no longer had the pod. */
  ended_at: string | null;
  /** What went wrong at control's last read of the pod, in words; the next good read clears it. */
  error: string | null;
  /**
   * A change control refused (a terminate that could not go on), in words, and how many steps the
   * rig's history had then. It stays until the owner's next stop, start, restart or terminate, or
   * until a newer step in the rig's history (a full reset, say).
   */
  refusal?: { words: string; steps: number } | null | undefined;
  notes: string[];
  /** The stop, start, restart or terminate under way (runpod-lifecycle.ts); null: none. */
  op?: RigOp | null | undefined;
  /** The runs the last stop paused: the next start resumes them. */
  paused_runs?: string[] | undefined;
  /** The export the last stop made, and whether it had left the pod when the pod stopped. */
  last_export?: string | null | undefined;
  last_export_left?: boolean | undefined;
}

export interface RunpodRigView extends Omit<RigState, "refusal"> {
  /** What went wrong last, in words: the last read's error, else the refusal while it stays. */
  error: string | null;
  /** The change control refused last, in words, while it stays (RigState's refusal). */
  refusal: string | null;
  rig: string;
  cloud: string;
  pod: string;
  /** Control still follows the pod. */
  active: boolean;
  created_by: string;
  /** What the pod has cost so far, in USD, to the cent; null without a price. */
  spend_usd: number | null;
  /** When the pod enrolled with control (pull mode); null: not yet. */
  enrolled_at: string | null;
  /**
   * Since when the rig counts as idle for the idle stop (idleSince); null without an idle stop,
   * before enrollment, while the pod is not running, or while a run is at work on it.
   */
  idle_since: string | null;
  /** The change under way in words (opWords); null: none. */
  op_words: string | null;
}

/** The change under way on a rig, in words: what it is and what it waits for. */
export function opWords(op: Pick<RigOp, "kind" | "phase">): string {
  const doing = {
    stop: "stopping",
    start: "starting",
    restart: "restarting",
    terminate: "terminating",
  }[op.kind];
  const waits = {
    quiescing: "waiting until no judge job and no command waits on the rig",
    exporting: op.kind === "terminate" ? "waiting for its full export" : "waiting for its export",
    leaving:
      op.kind === "terminate"
        ? "waiting for every result to leave the pod"
        : "waiting for its results to leave the pod",
    stopping: "waiting for the pod to stop",
    starting: "waiting for the pod to run",
  }[op.phase];
  return `${doing}: ${waits}`;
}

/** What the pod has cost by `now`, in USD (not rounded). */
export function spentBy(s: RigState, now: number): number {
  if (s.price_per_hr === null) return s.spent_usd;
  const ms = s.billed_since ? Math.max(0, now - Date.parse(s.billed_since)) : 0;
  return s.spent_usd + (s.price_per_hr * ms) / 3_600_000;
}

/**
 * Since when the rig is idle for its idle stop: the latest of when the stop was set, when the
 * pod enrolled, when it last started running and when a run was last at work. Null without an idle
 * stop, before enrollment, while the pod is not running, or while a run is at work on it (as
 * control last saw): the idle stop and the rig's page use this one rule.
 */
export function idleSince(s: RigState, enrolledAt: string | null): string | null {
  if (s.idle_stop_minutes === null || !enrolledAt || !s.running_since || s.at_work) return null;
  const times = [s.idle_from, enrolledAt, s.running_since, s.busy_at].filter((t): t is string =>
    Boolean(t),
  );
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/** A RunPod rig as shown over REST and MCP, and in the rig's view. */
export function runpodRigView(
  r: StoredRunpodRig,
  tunnel: TunnelRig | undefined,
  now: number,
): RunpodRigView {
  const s = r.state as RigState;
  const enrolledAt = tunnel?.enrolled_at ?? null;
  return {
    ...s,
    error: s.error ?? s.refusal?.words ?? null,
    refusal: s.refusal?.words ?? null,
    op: s.op ?? null,
    op_words: s.op ? opWords(s.op) : null,
    paused_runs: s.paused_runs ?? [],
    last_export: s.last_export ?? null,
    last_export_left: s.last_export_left ?? false,
    rig: r.rig,
    cloud: r.cloud,
    pod: r.pod,
    active: r.active,
    created_by: r.created_by,
    spend_usd: s.price_per_hr === null ? null : Math.round(spentBy(s, now) * 100) / 100,
    enrolled_at: enrolledAt,
    idle_since: idleSince(s, enrolledAt),
  };
}
