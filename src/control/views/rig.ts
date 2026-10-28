import { readHardware } from "../../core/hardware.ts";
import { type BuildInfo, buildInfo } from "../../core/version.ts";
import { standingOf } from "../research-view.ts";
import { type RunpodRigView, runpodRigView } from "../runpod-rig-view.ts";
import type { ControlStore } from "../store.ts";
import { type RigVersions, rigVersions } from "../versions.ts";
import { runDirections } from "./directions.ts";
import { type FoldedRig, RigFold } from "./fold/index.ts";
import { readGpuSplit, readModelInfo, readSettings, reportingState } from "./report.ts";
import type { RigView, RunView, StoredEvent } from "./types.ts";
import { doingsOf, type TrialDoing } from "./work.ts";

/**
 * A rig's view: its current ledger's events, folded (views/fold/), then read with what else the
 * view shows: the rig's row and last report, the clock, control's build, the supervisor's figures
 * and a RunPod rig's pod.
 */

/** How many of the judge's jobs a rig's view shows. */
const SHOWN_JOBS = 200;

/** How rigView reads a rig's view: when a rig is stale and offline, the time, control's build. */
export interface ViewOptions {
  staleAfterMs: number;
  /** After this long without a report the rig is offline (default OFFLINE_AFTER_MS). */
  offlineAfterMs?: number | undefined;
  now?: number;
  /** Control's own build, which the rig's are compared with (default: this process's). */
  control?: BuildInfo | undefined;
}

/** The rig's row in control's store: when it last reported, its ledger and its last report. */
export interface RigRow {
  id: string;
  last_seen: string;
  ledger_id: string | null;
  summary: unknown;
}

/**
 * What a rig's view reads besides its events: the rig's row, the time it is read at and the
 * windows for stale and offline, the rig's builds against control's, the supervisor's figures, and
 * a RunPod rig's pod.
 */
export interface RigInputs {
  row: RigRow;
  now: number;
  staleAfterMs: number;
  offlineAfterMs?: number | undefined;
  version: RigVersions;
  supervisor: Record<string, unknown> | null;
  runpod: RunpodRigView | undefined;
}

/** A rig's events in one ledger (or all of them), oldest first, read in pages. */
export function rigEvents(
  store: ControlStore,
  rig: string,
  ledgerId?: string | null,
): StoredEvent[] {
  const out: StoredEvent[] = [];
  let after = 0;
  for (;;) {
    // The pages need no source's or document's text: the knowledge base keeps it.
    const page = store.events(rig, after, 5000, ledgerId, { lean: true }) as StoredEvent[];
    out.push(...page);
    if (page.length < 5000) return out;
    after = (page.at(-1) as StoredEvent).seq;
  }
}

/** Builds a rig's view from its events (only the current ledger's, after a reset). */
export function rigView(
  store: ControlStore,
  rig: string,
  opts: ViewOptions = { staleAfterMs: 180_000 },
): RigView | undefined {
  const u = store.rigs().find((x) => x.id === rig);
  if (!u) return undefined;
  const fold = new RigFold();
  // Only the current ledger's events, filtered in the query.
  for (const e of rigEvents(store, rig, u.ledger_id)) fold.apply(e);
  return readRig(fold.state(), rigInputs(store, u, opts));
}

/** What a rig's view reads besides its events, from the store, the clock and control's build. */
export function rigInputs(store: ControlStore, row: RigRow, opts: ViewOptions): RigInputs {
  const now = opts.now ?? Date.now();
  const launched = store.runpodRig(row.id);
  return {
    row,
    now,
    staleAfterMs: opts.staleAfterMs,
    offlineAfterMs: opts.offlineAfterMs,
    version: rigVersions(store, row.id, opts.control ?? buildInfo()),
    supervisor: store.supervisor(row.id),
    runpod: launched ? runpodRigView(launched, store.tunnelRig(row.id), now) : undefined,
  };
}

/**
 * A rig's view from its folded events and what else it shows. It never changes the fold: each run
 * it shows is a copy, with what is worked out from the whole run.
 */
export function readRig(f: FoldedRig, x: RigInputs): RigView {
  const u = x.row;
  // What each lane's trial is doing, from the rig's last report (goal 143).
  const doings = doingsOf(u.summary);
  const summary = u.summary as
    | {
        jobs?: Record<string, number>;
        hardware?: unknown;
        model?: unknown;
        settings?: unknown;
        gpu_split?: unknown;
      }
    | undefined;
  return {
    id: u.id,
    last_seen: u.last_seen,
    stale: x.now - Date.parse(u.last_seen) > x.staleAfterMs,
    state: reportingState(u.last_seen, x),
    version: x.version,
    ledger_id: u.ledger_id,
    summary: u.summary,
    supervisor: x.supervisor,
    hardware: readHardware(summary?.hardware),
    model: readModelInfo(summary?.model),
    settings: readSettings(summary?.settings),
    gpu_split: readGpuSplit(summary?.gpu_split),
    jobs: summary?.jobs ?? {},
    runs: f.runs.map((v) => readRun(v, doings)),
    recent: f.recent.toReversed(),
    judge: {
      now: f.jobs.filter((j) => j.state === "running").at(-1) ?? null,
      queued: f.jobs.filter((j) => j.state === "queued"),
      jobs: f.jobs.slice(-SHOWN_JOBS),
    },
    checks: f.checks,
    ...(x.runpod ? { runpod: x.runpod } : {}),
  };
}

/** A run as its view shows it: a copy of the fold's, with what is worked out from the whole run. */
function readRun(v: RunView, doings: Map<string, TrialDoing>): RunView {
  const verdicts: Record<string, number> = {};
  for (const a of v.attempts) {
    const k = a.verdict ?? a.lifecycle;
    verdicts[k] = (verdicts[k] ?? 0) + 1;
  }
  // A closed run waits for no one (goal 087; the owner, 2026-10-22): the rig refuses approvals
  // of its changes, so none is pending. Each attempt keeps its own lifecycle.
  const pending = v.status === "closed" ? [] : v.pending_promotions;
  return {
    ...v,
    verdicts,
    agents: {
      ...v.agents,
      attempts: v.attempts.length,
      duplicates: v.attempts.filter((a) => a.lifecycle === "duplicate").length,
    },
    directions: runDirections(v),
    standing: standingOf(v),
    pending_promotions: pending,
    // A promoted, declined or withdrawn change waits no more: only pending ones keep their why.
    promotion_waits: Object.fromEntries(
      Object.entries(v.promotion_waits).filter(([id]) => pending.includes(id)),
    ),
    at_work: Object.fromEntries(
      Object.entries(v.at_work).map(([lane, w]) => [lane, { ...w, ...doings.get(w.trial) }]),
    ),
  };
}

/** A RunPod rig whose pod is stopped: it can't report, and that is expected, not stale. */
export const podStopped = (u: Pick<RigView, "runpod">): boolean =>
  Boolean(u.runpod?.active && u.runpod.status === "EXITED");
