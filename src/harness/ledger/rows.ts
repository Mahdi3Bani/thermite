import type { AskOwner } from "../../core/commands.ts";

/** The ledger's rows as its reads give them, and an attempt as its writer gives it (moved out of ledger.ts). */

export interface RunRow {
  id: string;
  campaign: string;
  version: number;
  contract_sha: string;
  mode: string;
  seed_repo: string;
  seed_commit: string;
  direction: string | null;
  status: "running" | "paused" | "closed";
  pause_reason: string | null;
  /** False: no worker agents run for this run (the judge still works). */
  agents: boolean;
  /** The run's own promotion policy; null: the rig's default. */
  promotion: "auto" | "owner_approval" | null;
  /** What else the run asks the owner about (goal 079); none: nothing. */
  ask_owner: AskOwner;
}

export interface JobRow {
  id: number;
  attempt: string | null;
  kind: string;
  state: string;
  priority: number;
  lease_owner: string | null;
  lease_until: string | null;
  fence: number;
  expiries: number;
  spec: string;
}

export interface AttemptInput {
  id: string;
  run: string;
  lane?: string | undefined;
  origin?: "local" | "imported" | undefined;
  parentRef: string;
  parentCommit: string;
  parentAttempt?: string | null | undefined;
  baselineChampionSeq: number | null;
  commitSha: string;
  ref: string;
  diffSha: string;
  normalizedDiffSha: string;
  lifecycle: string;
  hypothesis?: string | undefined;
  claim?: string | undefined;
  knownFlaws?: string[] | undefined;
  v0?: unknown;
  /** The changed files with their line counts, for the record's readers (control's pages). */
  files?: { path: string; added: number | null; removed: number | null }[] | undefined;
}

/** An experiment in a run's queue (goal 064), as its row holds it. */
export interface ExperimentRow {
  id: string;
  run: string;
  title: string;
  details: string;
  family: string;
  why: string;
  added_by: string;
  state: "proposed" | "queued" | "assigned" | "done" | "dropped";
  /** Its place among the run's queued experiments (0 first); null when it is not queued. */
  place: number | null;
  lane: string | null;
  trial: string | null;
  attempt: string | null;
  result: string | null;
  dropped_by: string | null;
  dropped_why: string | null;
  from_run: string | null;
  from_id: string | null;
  /**
   * Why its trial ended without trying it, or (done) how its trial ended, in words (goal 079).
   * Null: nothing to say.
   */
  cause?: string | null | undefined;
  /** How many times its trial ended without really trying it, and it came back (goal 079). */
  returns?: number | undefined;
  /** A research task's question, as an index from 0 (goal 117); null: none named. */
  question?: number | null | undefined;
  /**
   * What a research task's trial added, as JSON (goal 117: TaskYield); null until its trial
   * ended, and for other runs' experiments.
   */
  yield?: string | null | undefined;
  created_at: string;
  updated_at: string;
}

/** Background the owner picked from past research for a run, with where it came from. */
export interface BriefingItem {
  text: string;
  from: { campaign: string; run: string; kind: string; ref: string };
}
