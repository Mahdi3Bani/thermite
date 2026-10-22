import { directionOf, isLegacyRule, RESEARCH_TASK_KINDS } from "../core/directions.ts";
import { type Hardware, readHardware } from "../core/hardware.ts";
import { clip } from "../core/kb-index.ts";
import { type BuildInfo, buildInfo } from "../core/version.ts";
import { type RunpodRigView, runpodRigView } from "./runpod-rig-view.ts";
import type { ControlStore } from "./store.ts";
import { type RigVersions, rigVersions } from "./versions.ts";

/**
 * Control's read model: what the dashboard, the API and MCP show. It is computed from the
 * events rigs reported (the harness ledger is the source of truth; control only mirrors it),
 * so it is the same after any restart of control, a supervisor or a harness.
 */

export interface StoredEvent {
  seq: number;
  ledger_id: string;
  id: number;
  at: string;
  actor: string;
  kind: string;
  subject: string | null;
  body: Record<string, unknown>;
}

export interface AttemptView {
  id: string;
  run: string;
  lane: string | null;
  lifecycle: string;
  verdict: string | null;
  delta: number | null;
  hypothesis: string | null;
  recorded_at: string;
  updated_at: string;
  /** The commit it proposes, and the commit it was made on. */
  commit: string | null;
  parent: string | null;
  /** Flaws its author declared when submitting it (they trigger an audit). */
  known_flaws: string[];
  /** The planner's direction for the trial that made it. */
  family: string | null;
  trial: string | null;
  /** Goal campaigns: what the judge's latest finished job found against the champion. */
  gained: string[] | null;
  lost: string[];
  unsure: string[];
  /** Every verdict it received, oldest first. */
  history: { at: string; verdict: string; delta: number | null }[];
  /** What it waits for after its last job: "audit" or "owner_approval". */
  waiting: string | null;
  /** Its latest verdict's interval (relative gain, low and high) and the judge's reasons. */
  ci: [number, number] | null;
  reasons: string | null;
  /** The files it changes, with their line counts (null for a binary file), and how many. */
  files: { path: string; added: number | null; removed: number | null }[];
  files_total: number;
  /**
   * Why the static checks refused it before building (goal 082): the first 20 violations, each
   * cut to 300 characters, and how many there were. Empty, and 0, when it was not refused or its
   * rig's harness is older.
   */
  violations: string[];
  violations_total: number;
}

/** A judge job, from its queued, leased and finished events. */
export interface JudgeJob {
  id: string;
  kind: string;
  attempt: string | null;
  /** The run it serves (an attempt's run, or the run that was running when it was queued). */
  run: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  state: string | null;
  result: Record<string, unknown>;
}

export interface ChampionStep {
  seq: number;
  attempt: string | null;
  commit: string;
  at: string;
  /** Step gain from the confirming verdict (a fraction), when known. */
  delta: number | null;
  /** Product of step gains since the seed: the relative gain against the campaign baseline. */
  cumulative: number;
  reopened: boolean;
}

export interface RunView {
  id: string;
  campaign: string | null;
  mode: string | null;
  /** The project repository the run works on (from its assignment). */
  seed_repo: string | null;
  /**
   * A project in one folder of its repository: the folder, and the repository's commit the run
   * started from. The run's own first commit is that folder's alone (see folderCommit).
   */
  seed_folder?: { folder: string; commit: string } | undefined;
  /** The run's own promotion policy (null: the rig's default, which control does not see). */
  promotion: "auto" | "owner_approval" | null;
  status: string;
  pause_reason: string | null;
  champion: ChampionStep[];
  attempts: AttemptView[];
  verdicts: Record<string, number>;
  pending_promotions: string[];
  calibration: { at: string; sigma: number; summary: string } | null;
  /** Agents (M4): planner quality, duplicates, effort. */
  agents: {
    epochs: number;
    planner_valid: number;
    fallbacks: number;
    epochs_with_violations: number;
    trials: number;
    submitted: number;
    tokens_in: number;
    tokens_out: number;
    duplicates: number;
    attempts: number;
  };
  /** Research mode: the newest digest's figures and report. */
  research: Record<string, unknown> | null;
  goals: { goal: string; description: string | null; status: string; reasons: string }[];
  /** When the judge last checked the goals, and on which champion. */
  goals_at: string | null;
  goals_seq: number | null;
  /** Audits (M5): what is held for one, and how each ended. */
  audits: {
    attempt: string;
    reason: string;
    decision: string | null;
    at: string;
    /** The champion the attempt was measured against. */
    expected_seq: number | null;
    /** The auditor's reasons, once it decided. */
    reasons: string | null;
  }[];
  /** Why each pending promotion waits, and against which champion it was measured. */
  promotion_waits: Record<
    string,
    { expected_seq: number | null; reason: string | null; at: string }
  >;
  /** Subjective-goal reviews: the panel's result, then the owner's. */
  reviews: {
    review: number;
    goal: string;
    commit: string;
    panel: string | null;
    owner: string | null;
  }[];
  /** "Not possible" proposals and the owner's decisions. */
  conclusions: {
    proposal: number;
    decision: string | null;
    approaches: number;
    at: string;
    /** The refuted approach families, each with its judged attempts. */
    families: { family: string; attempts: number }[];
  }[];
  /** The newest champion published for propagation (what another rig can import). */
  published: {
    seq: number;
    repo: string | null;
    base_commit: string;
    tree: string;
    sha256: string;
    path: string;
  } | null;
  /** Every champion tree this run published, by seq (cross-verification checks it). */
  published_trees: Record<number, string>;
  /** Champions received from other rigs, and how this rig's judge decided them. */
  propagations: {
    attempt: string | null;
    source_rig: string;
    source_run: string;
    source_seq: number;
    tree: string | null;
    result: string;
  }[];
  directives: number;
  /** When the run started, and its latest epoch's plan. */
  created_at: string | null;
  epoch: {
    n: number;
    at: string;
    source: string;
    assignments: { lane: string; family: string; parent: string; focus: string | null }[];
  } | null;
  /** Finished trials, newest last (at most the latest 100). */
  trials: {
    trial: string;
    lane: string | null;
    family: string | null;
    attempt: string | null;
    stopped: string;
    error: string | null;
    at: string;
  }[];
  /** Each lane's trial in progress: its direction, its focus and when it started. */
  at_work: Record<
    string,
    { trial: string; family: string | null; focus: string | null; since: string }
  >;
  /** The run's events, oldest first (at most the latest 400): the timeline's source. */
  timeline: StoredEvent[];
  /** False for a run with no worker agents (a try: the judge alone). */
  has_agents: boolean;
  /**
   * The rules for the plan in force (directives): who set each, when, and the rule. `legacy`: an
   * old rule in words, from before rules named directions (goal 066); code does not keep it, and
   * the planner's next round converts it. A converted rule's body names the old rule and its
   * words (`converted_from`).
   */
  rules: {
    id: number;
    author: string;
    at: string;
    body: Record<string, unknown>;
    legacy: boolean;
  }[];
  /** The run's directions (goal 066), by name, with what each holds and the rules naming it. */
  directions: DirectionView[];
  /** The directions the run's registry has, from family_added events: what each means, and who added it. */
  families: { name: string; description: string; by: string; at: string; for_rules: number[] }[];
  /** The experiment queue (goal 064): every experiment, with its state; up next in order. */
  queue: ExperimentView[];
  /** The planner's hand-outs, newest last (at most 50): what went to which lane, and why. */
  handouts: {
    at: string;
    round: number | null;
    by: string;
    assignments: { lane: string; experiment: string | null; why: string }[];
    notes: string;
  }[];
  /** The owner's messages to the run's agents (goal 063), newest last, with who read them. */
  messages: MessageView[];
  /** The agents' field notes and research notes (goal 065), oldest first; all of them. */
  journal: JournalNoteView[];
}

/**
 * One note an agent wrote as it worked (goal 065): an observation, a decision and why, a surprise,
 * an open question or a lesson (field notes), or a research note ("note"). Agents' words: data.
 */
export interface JournalNoteView {
  id: number;
  by: string;
  kind: string;
  text: string;
  /** What it is about: an experiment, an attempt, a source, a claim, a round, a trial, … */
  about: { type: string; id: string } | null;
  lane: string | null;
  trial: string | null;
  at: string;
}

/**
 * One of a run's directions (goal 066): an approach family its experiments belong to. A rule names
 * one; a picker lists them.
 */
export interface DirectionView {
  /** Its name: lowercase words joined by dashes. `:shared memory tiling:` names shared-memory-tiling. */
  name: string;
  /** What it means, in the words of whoever added it (the planner's, for one it designed). */
  description: string | null;
  /** Its experiments that were tried (done), and of those, the wins: champion, promoted or confirmed. */
  tried: number;
  wins: number;
  /** Its experiments up next. */
  queued: number;
  /** The lanes at work in it now. */
  lanes: string[];
  /** The rules in force that name it. */
  rules: { id: number; kind: string }[];
  /** Only a rule names it so far: the planner designs it at its next round. */
  to_design: boolean;
}

/** One experiment in a run's queue: what to try, who added it and why, and what became of it. */
export interface ExperimentView {
  id: string;
  title: string;
  details: string;
  family: string;
  why: string;
  by: string;
  state: "proposed" | "queued" | "assigned" | "done" | "dropped";
  /** Its place among the queued ones (0 first); null once it left the queue. */
  position: number | null;
  lane: string | null;
  trial: string | null;
  attempt: string | null;
  result: string | null;
  dropped_why: string | null;
  dropped_by: string | null;
  from_run: string | null;
  at: string;
  updated_at: string;
}

/** The owner's message to a run's agents: to whom, kept in force or not, who read it, answers. */
export interface MessageView {
  id: number;
  to: string;
  text: string;
  keep: boolean;
  unkept: boolean;
  at: string;
  /** Each reader's first read; `round` is the planner's round that read it (goal 066). */
  reads: { by: string; trial: string | null; at: string; round: number | null }[];
  answers: { role: string; text: string; at: string }[];
  /**
   * The rules the planner made from it (goal 066): each directive whose `from_message` is this
   * message, in force or removed since, with its direction and why.
   */
  rules: {
    id: number;
    kind: string;
    family: string | null;
    rationale: string;
    by: string;
    at: string;
  }[];
  /**
   * Rules the planner made from it that the harness left out: rules the owner removed, which
   * only the owner's own `redirect` sets again (`directives_left_out`).
   */
  left_out: { kind: string; family: string | null; at: string }[];
}

/** The rig's own settings as its harness reports them. */
export interface RigSettingsView {
  judge: boolean;
  workers: boolean;
  lanes: number;
  planner: boolean;
  auditor: boolean;
  teachers: boolean;
  review: boolean;
  exports: boolean;
  trial_minutes: number;
  max_turns: number | null;
  promotion: "auto" | "owner_approval";
  /** The judge's share of a rig's GPU set, if set on the rig; null: its default. */
  judge_gpus: number | null;
}

function readSettings(v: unknown): RigSettingsView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const b = (k: string) => o[k] !== false;
  return {
    judge: b("judge"),
    workers: b("workers"),
    lanes: typeof o.lanes === "number" ? o.lanes : 1,
    planner: b("planner"),
    auditor: b("auditor"),
    teachers: b("teachers"),
    review: b("review"),
    exports: b("exports"),
    trial_minutes: typeof o.trial_minutes === "number" ? o.trial_minutes : 20,
    max_turns: typeof o.max_turns === "number" ? o.max_turns : null,
    promotion: o.promotion === "auto" ? "auto" : "owner_approval",
    judge_gpus: typeof o.judge_gpus === "number" ? o.judge_gpus : null,
  };
}

/** A rig configured with its GPU set: how many cards, and how many are the judge's now. */
function readGpuSplit(v: unknown): { set: number; judge: number } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o.set === "number" && typeof o.judge === "number"
    ? { set: o.set, judge: o.judge }
    : null;
}

/**
 * Whether a rig reports: "reporting" within the stale window, "stale" after it, "offline" after
 * the longer offline window. A rig that never sent a report is offline.
 */
export type ReportingState = "reporting" | "stale" | "offline";

/** How long without a report makes a rig offline when control is given no other time. */
export const OFFLINE_AFTER_MS = 900_000;

export function reportingState(
  lastSeen: string,
  opts: { staleAfterMs: number; offlineAfterMs?: number | undefined; now?: number | undefined },
): ReportingState {
  const age = (opts.now ?? Date.now()) - Date.parse(lastSeen);
  // Never before the stale window ends.
  const offline = Math.max(opts.staleAfterMs, opts.offlineAfterMs ?? OFFLINE_AFTER_MS);
  return !(age <= offline) ? "offline" : age > opts.staleAfterMs ? "stale" : "reporting";
}

export interface RigView {
  id: string;
  last_seen: string;
  /** True when the rig is stale or offline. */
  stale: boolean;
  state: ReportingState;
  /** The rig's builds against control's: behind or ahead, refused and why, or unknown. */
  version: RigVersions;
  ledger_id: string | null;
  summary: unknown;
  /** The supervisor's own figures (git sync, advisors); reported by the supervisor, unsigned. */
  supervisor: Record<string, unknown> | null;
  /** What the rig runs on, from its signed report (harnesses before it was added send none). */
  hardware: Hardware | null;
  jobs: Record<string, number>;
  runs: RunView[];
  recent: StoredEvent[];
  /** The judge: its job in progress, its queue and its recent jobs (newest last). */
  judge: { now: JudgeJob | null; queued: JudgeJob[]; jobs: JudgeJob[] };
  /** Each rig check's latest result (model route, isolation, smoke), or that it is running. */
  checks: Record<string, RigCheckView>;
  /** Which model route its agents use, from its signed report (older harnesses send none). */
  model: RigModelView | null;
  /** The rig's own settings (Edit rig), from its signed report; null from an older harness. */
  settings: RigSettingsView | null;
  /** A rig whose GPU split control may change (its GPU set and the judge's share now). */
  gpu_split: { set: number; judge: number } | null;
  /** A rig the owner launched on a GPU cloud: its pod, its price and what it has cost so far. */
  runpod?: RunpodRigView | undefined;
}

/** A RunPod rig whose pod is stopped: it can't report, and that is expected, not stale. */
export const podStopped = (u: Pick<RigView, "runpod">): boolean =>
  Boolean(u.runpod?.active && u.runpod.status === "EXITED");

export interface RigModelView {
  source: "control" | "environment" | "none";
  name: string | null;
  version: number | null;
  model: string | null;
  base_url: string | null;
  key_hint: string | null;
  /** The harness its agents run in. */
  harness: "pi" | "opencode" | "claude-code" | "codex";
}

/** Reads a report's model route loosely: anything malformed is dropped, never trusted. */
export function readModelInfo(x: unknown): RigModelView | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : null);
  const source = o.source;
  if (source !== "control" && source !== "environment" && source !== "none") return null;
  return {
    source,
    name: str(o.name),
    version: typeof o.version === "number" && Number.isInteger(o.version) ? o.version : null,
    model: str(o.model),
    base_url: str(o.base_url),
    key_hint: str(o.key_hint),
    harness:
      o.harness === "opencode" || o.harness === "claude-code" || o.harness === "codex"
        ? o.harness
        : "pi",
  };
}

export interface RigCheckView {
  check: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  summary: string | null;
  /** A check that passed with a caveat says it here (the smoke check on noisy timing). */
  note: string | null;
  /** The rig's id for this run of the check (rig_check's answer names it), or null. */
  id: string | null;
}

/**
 * Each check's newest run, from the rig's rig_check_started and rig_check_finished events: the
 * rig's view, and a check's row on the dashboard, which reads only these events (goal 080).
 */
export function foldCheck(
  checks: Record<string, RigCheckView>,
  e: { at: string; kind: string; body: unknown },
): void {
  const b = (e.body ?? {}) as Record<string, unknown>;
  const check = String(b.check ?? "");
  const id = typeof b.id === "string" ? b.id : null;
  if (e.kind === "rig_check_started")
    checks[check] = {
      check,
      started_at: e.at,
      finished_at: null,
      ok: null,
      summary: null,
      note: null,
      id,
    };
  else if (e.kind === "rig_check_finished")
    checks[check] = {
      check,
      started_at: checks[check]?.started_at ?? e.at,
      finished_at: e.at,
      ok: b.ok === true,
      summary: typeof b.summary === "string" ? b.summary : null,
      note: typeof b.note === "string" ? b.note : null,
      id: id ?? checks[check]?.id ?? null,
    };
}

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
  opts: {
    staleAfterMs: number;
    /** After this long without a report the rig is offline (default OFFLINE_AFTER_MS). */
    offlineAfterMs?: number | undefined;
    now?: number;
    /** Control's own build, which the rig's are compared with (default: this process's). */
    control?: BuildInfo | undefined;
  } = { staleAfterMs: 180_000 },
): RigView | undefined {
  const u = store.rigs().find((x) => x.id === rig);
  if (!u) return undefined;
  // Only the current ledger's events, filtered in the query.
  const events = rigEvents(store, rig, u.ledger_id);
  const runs = new Map<string, RunView>();
  const attempts = new Map<string, AttemptView>();
  const inst = (id: string): RunView => {
    let v = runs.get(id);
    if (!v) {
      v = {
        id,
        campaign: null,
        mode: null,
        seed_repo: null,
        promotion: null,
        status: "unknown",
        pause_reason: null,
        champion: [],
        attempts: [],
        verdicts: {},
        pending_promotions: [],
        calibration: null,
        agents: {
          epochs: 0,
          planner_valid: 0,
          fallbacks: 0,
          epochs_with_violations: 0,
          trials: 0,
          submitted: 0,
          tokens_in: 0,
          tokens_out: 0,
          duplicates: 0,
          attempts: 0,
        },
        research: null,
        goals: [],
        goals_at: null,
        goals_seq: null,
        audits: [],
        promotion_waits: {},
        reviews: [],
        conclusions: [],
        published: null,
        published_trees: {},
        propagations: [],
        directives: 0,
        created_at: null,
        epoch: null,
        trials: [],
        at_work: {},
        timeline: [],
        has_agents: true,
        rules: [],
        directions: [],
        families: [],
        queue: [],
        handouts: [],
        messages: [],
        journal: [],
      };
      runs.set(id, v);
    }
    return v;
  };
  const confirmDelta = new Map<string, number>();
  const jobs = new Map<string, JudgeJob>();
  // The run that was running when a job without an attempt (validate, calibrate) was queued.
  let running: string | null = null;
  // Which run an event belongs to, for the run's timeline.
  const runOf = (e: StoredEvent): string | null => {
    const b = e.body ?? {};
    // A change to the rig's settings (Edit rig) is in the History of the run at work then.
    if (e.kind === "rig_settings_changed") return running;
    if (e.subject && runs.has(e.subject)) return e.subject;
    if (typeof b.run === "string" && b.run) return b.run;
    if (e.subject && attempts.has(e.subject)) return attempts.get(e.subject)?.run ?? null;
    if (e.kind.startsWith("job_") && e.subject) return jobs.get(e.subject)?.run ?? null;
    return null;
  };
  const checks: Record<string, RigCheckView> = {};
  for (const e of events) {
    const b = e.body ?? {};
    switch (e.kind) {
      case "rig_check_started":
      case "rig_check_finished":
        foldCheck(checks, e);
        break;
      case "run_created": {
        const v = inst(String(e.subject));
        v.campaign = String(b.campaign ?? "");
        v.mode = String(b.mode ?? "");
        v.created_at = e.at;
        v.has_agents = b.agents !== false;
        running = v.id;
        v.seed_repo =
          ((b.seed as { repo?: string } | undefined)?.repo as string | undefined) ?? null;
        const seed = (b.seed ?? {}) as { folder?: unknown; source_commit?: unknown };
        v.seed_folder =
          typeof seed.folder === "string" && typeof seed.source_commit === "string"
            ? { folder: seed.folder, commit: seed.source_commit }
            : undefined;
        v.promotion =
          b.promotion === "auto" || b.promotion === "owner_approval" ? b.promotion : null;
        v.status = "running";
        v.champion.push({
          seq: 1,
          attempt: null,
          commit: String((b.seed as { commit?: string } | undefined)?.commit ?? ""),
          at: e.at,
          delta: null,
          cumulative: 1,
          reopened: false,
        });
        break;
      }
      case "run_status": {
        const v = inst(String(e.subject));
        v.status = String(b.status);
        v.pause_reason = (b.reason as string | null) ?? null;
        if (v.status === "running") running = v.id;
        else if (running === v.id) running = null;
        break;
      }
      case "attempt_recorded": {
        const a: AttemptView = {
          id: String(e.subject),
          run: String(b.run),
          lane: (b.lane as string | null) ?? null,
          lifecycle: String(b.lifecycle),
          verdict: null,
          delta: null,
          hypothesis: (b.hypothesis as string | null) ?? null,
          recorded_at: e.at,
          updated_at: e.at,
          commit: typeof b.commit === "string" ? b.commit : null,
          parent: typeof b.parent === "string" ? b.parent : null,
          known_flaws: Array.isArray(b.known_flaws) ? b.known_flaws.map((f) => String(f)) : [],
          family: null,
          trial: null,
          gained: null,
          lost: [],
          unsure: [],
          history: [],
          waiting: null,
          ci: null,
          reasons: null,
          files: Array.isArray(b.files)
            ? (b.files as { path: string; added: number | null; removed: number | null }[]).map(
                (f) => ({
                  path: String(f.path),
                  added: typeof f.added === "number" ? f.added : null,
                  removed: typeof f.removed === "number" ? f.removed : null,
                }),
              )
            : [],
          files_total: typeof b.files_total === "number" ? b.files_total : 0,
          violations: Array.isArray(b.violations)
            ? b.violations.slice(0, 20).map((v) => clip(String(v), 300))
            : [],
          violations_total:
            typeof b.violations_total === "number"
              ? b.violations_total
              : Array.isArray(b.violations)
                ? b.violations.length
                : 0,
        };
        attempts.set(a.id, a);
        inst(a.run).attempts.push(a);
        break;
      }
      case "attempt_lifecycle": {
        const a = attempts.get(String(e.subject));
        if (a) {
          a.lifecycle = String(b.lifecycle);
          a.updated_at = e.at;
          // An attempt that left awaiting_approval (screened again, invalidated) waits no more.
          if (a.lifecycle !== "awaiting_approval") {
            const v = inst(a.run);
            v.pending_promotions = v.pending_promotions.filter((p) => p !== a.id);
          }
        }
        break;
      }
      case "verdict": {
        const a = attempts.get(String(e.subject));
        if (a) {
          a.verdict = String(b.verdict);
          a.delta = typeof b.delta === "number" ? b.delta : null;
          a.ci =
            typeof b.ci_low === "number" && typeof b.ci_high === "number"
              ? [b.ci_low, b.ci_high]
              : null;
          a.reasons = typeof b.reasons === "string" ? b.reasons : null;
          a.updated_at = e.at;
          a.history.push({ at: e.at, verdict: a.verdict, delta: a.delta });
          if (b.verdict === "win_confirmed" && typeof b.delta === "number") {
            confirmDelta.set(a.id, b.delta);
          }
        }
        break;
      }
      case "champion_promoted": {
        const v = inst(String(e.subject));
        const attempt = (b.attempt as string | null) ?? null;
        const delta = attempt ? (confirmDelta.get(attempt) ?? null) : null;
        const prev = v.champion.filter((c) => !c.reopened).at(-1);
        v.champion.push({
          seq: Number(b.seq),
          attempt,
          commit: String(b.commit ?? ""),
          at: e.at,
          delta,
          cumulative: (prev?.cumulative ?? 1) * (1 + (delta ?? 0)),
          reopened: false,
        });
        v.pending_promotions = v.pending_promotions.filter((p) => p !== attempt);
        break;
      }
      case "champion_reopened": {
        const v = inst(String(e.subject));
        const step = v.champion.find((c) => c.seq === Number(b.seq));
        if (step) step.reopened = true;
        break;
      }
      case "promotion_pending": {
        const v = inst(String(b.run));
        if (!v.pending_promotions.includes(String(e.subject))) {
          v.pending_promotions.push(String(e.subject));
        }
        v.promotion_waits[String(e.subject)] = {
          expected_seq: typeof b.expected_seq === "number" ? b.expected_seq : null,
          reason: typeof b.reason === "string" ? b.reason : null,
          at: e.at,
        };
        break;
      }
      case "calibration": {
        const v = inst(String(e.subject));
        v.calibration = { at: e.at, sigma: Number(b.sigma), summary: String(b.summary ?? "") };
        break;
      }
      case "epoch_started": {
        const v = inst(String(e.subject));
        v.epoch = {
          // Epochs are numbered from 1; an event without its number is the next one.
          n: Number.isFinite(Number(b.n)) ? Number(b.n) : v.agents.epochs + 1,
          at: e.at,
          source: String(b.source ?? ""),
          assignments: (Array.isArray(b.assignments) ? b.assignments : []).map((x) => {
            const y = (x ?? {}) as Record<string, unknown>;
            return {
              lane: String(y.lane),
              family: String(y.family),
              parent: String(y.parent),
              focus: typeof y.focus === "string" ? y.focus : null,
            };
          }),
        };
        const a = v.agents;
        a.epochs++;
        if (b.planner_valid === true) a.planner_valid++;
        if (b.source === "fallback") a.fallbacks++;
        if (Number(b.raw_violations ?? 0) > 0) a.epochs_with_violations++;
        break;
      }
      case "trial_started": {
        const v = inst(String(e.subject));
        v.at_work[String(b.lane)] = {
          trial: String(b.trial ?? ""),
          family: typeof b.family === "string" ? b.family : null,
          focus: typeof b.focus === "string" ? b.focus : null,
          since: e.at,
        };
        break;
      }
      case "trial_finished": {
        const v = inst(String(e.subject));
        if (v.at_work[String(b.lane)]?.trial === String(b.trial ?? ""))
          delete v.at_work[String(b.lane)];
        v.trials.push({
          trial: String(b.trial ?? ""),
          lane: (b.lane as string | null) ?? null,
          family: (b.family as string | null) ?? null,
          attempt: (b.attempt as string | null) ?? null,
          stopped: String(b.stopped ?? ""),
          error: (b.error as string | null) ?? null,
          at: e.at,
        });
        if (v.trials.length > 100) v.trials.shift();
        const made = b.attempt ? attempts.get(String(b.attempt)) : undefined;
        if (made) {
          made.family = (b.family as string | null) ?? null;
          made.trial = String(b.trial ?? "") || null;
        }
        const a = v.agents;
        a.trials++;
        if (b.attempt) a.submitted++;
        a.tokens_in += Number(b.tokens_in ?? 0);
        a.tokens_out += Number(b.tokens_out ?? 0);
        break;
      }
      case "research_digest":
      case "research_final": {
        inst(String(e.subject)).research = {
          ...b,
          kind: e.kind === "research_final" ? "final" : "digest",
          at: e.at,
        };
        break;
      }
      case "goal_report": {
        const v = inst(String(e.subject));
        v.goals = (
          (b.goals as { goal: string; description?: string; status: string; reasons: string }[]) ??
          []
        ).map((g) => ({
          goal: g.goal,
          description: typeof g.description === "string" ? g.description : null,
          status: g.status,
          reasons: g.reasons,
        }));
        v.goals_at = e.at;
        v.goals_seq = typeof b.champion_seq === "number" ? b.champion_seq : null;
        break;
      }
      case "audit_requested": {
        inst(String(b.run)).audits.push({
          attempt: String(e.subject),
          reason: String(b.reason ?? ""),
          decision: null,
          at: e.at,
          expected_seq: typeof b.expected_seq === "number" ? b.expected_seq : null,
          reasons: null,
        });
        break;
      }
      case "audit_decided":
      case "audit_overridden":
      case "promotion_declined": {
        for (const v of runs.values()) {
          const a = v.audits.filter((x) => x.attempt === e.subject).at(-1);
          if (a) {
            a.decision =
              e.kind === "audit_overridden"
                ? "overridden by the owner"
                : e.kind === "promotion_declined"
                  ? "declined by the owner"
                  : String(b.decision);
            if (typeof b.reasons === "string") a.reasons = b.reasons;
          }
        }
        break;
      }
      case "review_requested": {
        inst(String(e.subject)).reviews.push({
          review: Number(b.review),
          goal: String(b.goal),
          commit: String(b.commit),
          panel: null,
          owner: null,
        });
        break;
      }
      case "review_panel":
      case "review_decided": {
        const r = inst(String(e.subject)).reviews.find((x) => x.review === Number(b.review));
        if (r && e.kind === "review_panel") r.panel = String(b.result);
        if (r && e.kind === "review_decided") r.owner = String(b.decision);
        break;
      }
      case "conclusion_proposed": {
        const families = (Array.isArray(b.approaches) ? b.approaches : []).map((x) => {
          const y = (x ?? {}) as Record<string, unknown>;
          return { family: String(y.family ?? ""), attempts: Number(y.attempts ?? 0) };
        });
        inst(String(e.subject)).conclusions.push({
          proposal: Number(b.proposal),
          decision: null,
          approaches: families.length,
          at: e.at,
          families,
        });
        break;
      }
      case "conclusion_accepted":
      case "conclusion_rejected": {
        const c = inst(String(e.subject)).conclusions.find(
          (x) => x.proposal === Number(b.proposal),
        );
        if (c) c.decision = e.kind === "conclusion_accepted" ? "accepted" : "rejected";
        break;
      }
      case "champion_published": {
        inst(String(e.subject)).published_trees[Number(b.seq)] = String(b.tree);
        inst(String(e.subject)).published = {
          seq: Number(b.seq),
          repo: (b.repo as string | null) ?? null,
          base_commit: String(b.base_commit),
          tree: String(b.tree),
          sha256: String(b.sha256),
          path: String(b.path),
        };
        break;
      }
      case "propagation_received": {
        inst(String(e.subject)).propagations.push({
          attempt: (b.attempt as string | null) ?? null,
          source_rig: String(b.source_rig),
          source_run: String(b.source_run),
          source_seq: Number(b.source_seq),
          tree: (b.tree as string | undefined) ?? null,
          result: String(b.result ?? "judging"),
        });
        break;
      }
      case "propagation_accepted":
      case "propagation_rejected": {
        const p = inst(String(e.subject)).propagations.find((x) => x.attempt === b.attempt);
        if (p)
          p.result =
            e.kind === "propagation_accepted" ? "accepted" : `rejected (${String(b.verdict)})`;
        break;
      }
      case "directive": {
        const v = inst(String(e.subject));
        v.directives++;
        const body = (b.body as Record<string, unknown> | null) ?? {};
        v.rules.push({
          id: Number(b.id),
          author: e.actor,
          at: e.at,
          body,
          legacy: isLegacyRule(body),
        });
        // A rule the planner made from one of the owner's messages: part of its answer. One
        // converted from the planner's old rule in words takes that rule's place in the answer.
        const from = v.messages.find((m) => m.id === body.from_message);
        const was = (body.converted_from as { rule?: unknown } | undefined)?.rule;
        const old = from?.rules.find((x) => x.id === Number(was));
        if (old) {
          old.id = Number(b.id);
          old.family = typeof body.family === "string" ? body.family : null;
        } else if (from)
          from.rules.push({
            id: Number(b.id),
            kind: String(body.kind ?? ""),
            family: typeof body.family === "string" ? body.family : null,
            rationale: String(body.rationale ?? ""),
            by: e.actor,
            at: e.at,
          });
        break;
      }
      // Rules a set named that the owner had removed: the harness left them out. One the planner
      // made from the owner's message is part of its answer to it.
      case "directives_left_out": {
        const v = inst(String(e.subject));
        for (const x of Array.isArray(b.rules) ? b.rules : []) {
          const r = (x ?? {}) as Record<string, unknown>;
          const from = v.messages.find((m) => m.id === r.from_message);
          if (from)
            from.left_out.push({
              kind: String(r.kind ?? ""),
              family: typeof r.family === "string" ? r.family : null,
              at: e.at,
            });
        }
        break;
      }
      case "family_added": {
        const name = typeof b.family === "string" ? b.family : "";
        if (!name) break;
        const v = inst(String(e.subject));
        if (v.families.some((f) => f.name === name)) break;
        v.families.push({
          name,
          description: typeof b.description === "string" ? b.description : "",
          by: e.actor,
          at: e.at,
          for_rules: Array.isArray(b.for_rules)
            ? b.for_rules.map(Number).filter(Number.isFinite)
            : [],
        });
        break;
      }
      case "directives_superseded":
      case "directive_dropped":
      // An old rule in words the planner converted (goal 066): its new rule took its place.
      case "directive_converted": {
        const v = inst(String(e.subject));
        const ids = new Set(
          (Array.isArray(b.ids) ? b.ids : [b.id]).map((x) => Number(x)).filter(Number.isFinite),
        );
        v.directives = Math.max(0, v.directives - ids.size);
        v.rules = v.rules.filter((r) => !ids.has(r.id));
        break;
      }
      // ---------------------------------------- the experiment queue (goal 064)
      case "experiment_added":
      case "experiment_accepted":
      case "experiment_moved":
      case "experiment_edited":
      case "experiment_dropped":
      case "experiment_assigned":
      case "experiment_finished": {
        queueEvent(inst(String(e.subject)), e);
        break;
      }
      case "planner_handout": {
        const v = inst(String(e.subject));
        v.handouts.push({
          at: e.at,
          round: Number.isFinite(Number(b.round)) ? Number(b.round) : null,
          by: e.actor,
          assignments: (Array.isArray(b.assignments) ? b.assignments : []).map((a) => {
            const x = (a ?? {}) as Record<string, unknown>;
            return {
              lane: String(x.lane ?? ""),
              experiment: typeof x.experiment === "string" ? x.experiment : null,
              why: String(x.why ?? ""),
            };
          }),
          notes: String(b.notes ?? ""),
        });
        if (v.handouts.length > 50) v.handouts.shift();
        break;
      }
      // ---------------------------------------- the agents' notes (goal 065)
      case "journal_note": {
        const id = Number(b.id);
        const text = typeof b.text === "string" ? b.text : "";
        if (!Number.isFinite(id) || !text) break;
        const about =
          b.about && typeof b.about === "object" ? (b.about as Record<string, unknown>) : null;
        inst(String(e.subject)).journal.push({
          id,
          by: String(b.by ?? e.actor),
          kind: typeof b.kind === "string" && b.kind ? b.kind : "note",
          text,
          // A note always says what it is about; one recorded before that rule is about its run.
          about:
            about && typeof about.type === "string" && about.id !== undefined && about.id !== null
              ? { type: about.type, id: String(about.id) }
              : { type: "run", id: String(e.subject) },
          lane: typeof b.lane === "string" ? b.lane : null,
          trial: typeof b.trial === "string" ? b.trial : null,
          at: e.at,
        });
        break;
      }
      // A research note (sources read, in any mode): in the journal's notes card, apart from the
      // field notes. Its id is negative so it never meets a field note's.
      case "research_note": {
        const note = Number(b.note);
        const text = typeof b.text === "string" ? b.text : "";
        if (!Number.isFinite(note) || !text) break;
        const sources = Array.isArray(b.sources) ? b.sources.map(String) : [];
        inst(String(e.subject)).journal.push({
          id: -note,
          by: String(b.by ?? e.actor),
          kind: "note",
          text,
          about: sources[0] ? { type: "source", id: sources[0] } : null,
          lane: typeof b.by === "string" && /^lane-\d+$/.test(b.by) ? b.by : null,
          trial: typeof b.trial === "string" ? b.trial : null,
          at: e.at,
        });
        break;
      }
      // ---------------------------------------- the owner's messages (goal 063)
      case "agent_message": {
        const v = inst(String(e.subject));
        if (typeof b.id !== "number" && !Number.isFinite(Number(b.id))) break;
        v.messages.push({
          id: Number(b.id),
          to: String(b.to ?? ""),
          text: String(b.text ?? ""),
          keep: b.keep === true,
          unkept: false,
          at: e.at,
          reads: [],
          answers: [],
          rules: [],
          left_out: [],
        });
        if (v.messages.length > 200) v.messages.shift();
        break;
      }
      case "agent_message_read":
      case "agent_message_unkept":
      case "advisor_answer": {
        const v = inst(String(e.subject));
        const m = v.messages.find((x) => x.id === Number(b.message));
        if (!m) break;
        if (e.kind === "agent_message_unkept") m.unkept = true;
        else if (e.kind === "advisor_answer")
          m.answers.push({ role: String(b.role ?? ""), text: String(b.text ?? ""), at: e.at });
        else
          m.reads.push({
            by: String(b.by ?? ""),
            trial: typeof b.trial === "string" ? b.trial : null,
            at: e.at,
            // A read from before reads named their round has none.
            round: Number.isInteger(b.round) ? Number(b.round) : null,
          });
        break;
      }
      case "job_queued": {
        const attempt = (b.attempt as string | null) ?? null;
        jobs.set(String(e.subject), {
          id: String(e.subject),
          kind: String(b.kind ?? ""),
          attempt,
          run: attempt ? (attempts.get(attempt)?.run ?? null) : running,
          queued_at: e.at,
          started_at: null,
          finished_at: null,
          state: "queued",
          result: {},
        });
        break;
      }
      case "job_leased": {
        const j = jobs.get(String(e.subject));
        if (j) {
          j.started_at = e.at;
          j.state = "running";
        }
        break;
      }
      case "job_finished": {
        const j = jobs.get(String(e.subject));
        if (!j) break;
        j.finished_at = e.at;
        j.state = String(b.state ?? "done");
        j.result =
          b.result && typeof b.result === "object" ? (b.result as Record<string, unknown>) : {};
        const a = j.attempt ? attempts.get(j.attempt) : undefined;
        if (a && j.state === "done") {
          const r = j.result;
          if (Array.isArray(r.gained)) a.gained = r.gained.map(String);
          if (Array.isArray(r.lost)) a.lost = r.lost.map(String);
          if (Array.isArray(r.unsure)) a.unsure = r.unsure.map(String);
          a.waiting = typeof r.waiting === "string" ? r.waiting : null;
        }
        break;
      }
    }
    const run = runOf(e);
    // The agents' notes are kept in the journal: the timeline tells what happened.
    if (run && runs.has(run) && e.kind !== "journal_note" && e.kind !== "research_note") {
      const t = (runs.get(run) as RunView).timeline;
      t.push(e);
      if (t.length > 400) t.shift();
    }
  }
  for (const v of runs.values()) {
    v.verdicts = {};
    for (const a of v.attempts) {
      const k = a.verdict ?? a.lifecycle;
      v.verdicts[k] = (v.verdicts[k] ?? 0) + 1;
    }
    v.agents.attempts = v.attempts.length;
    v.agents.duplicates = v.attempts.filter((a) => a.lifecycle === "duplicate").length;
    v.directions = runDirections(v);
  }
  const summary = u.summary as
    | {
        jobs?: Record<string, number>;
        hardware?: unknown;
        model?: unknown;
        settings?: unknown;
        gpu_split?: unknown;
      }
    | undefined;
  const now = opts.now ?? Date.now();
  const allJobs = [...jobs.values()];
  const launched = store.runpodRig(u.id);
  return {
    id: u.id,
    last_seen: u.last_seen,
    stale: now - Date.parse(u.last_seen) > opts.staleAfterMs,
    state: reportingState(u.last_seen, { ...opts, now }),
    version: rigVersions(store, u.id, opts.control ?? buildInfo()),
    ledger_id: u.ledger_id,
    summary: u.summary,
    supervisor: store.supervisor(u.id),
    hardware: readHardware(summary?.hardware),
    model: readModelInfo(summary?.model),
    settings: readSettings(summary?.settings),
    gpu_split: readGpuSplit((summary as { gpu_split?: unknown } | undefined)?.gpu_split),
    jobs: summary?.jobs ?? {},
    runs: [...runs.values()],
    recent: events.slice(-50).reverse(),
    judge: {
      now: allJobs.filter((j) => j.state === "running").at(-1) ?? null,
      queued: allJobs.filter((j) => j.state === "queued"),
      jobs: allJobs.slice(-200),
    },
    checks,
    ...(launched ? { runpod: runpodRigView(launched, store.tunnelRig(u.id), now) } : {}),
  };
}

export interface LeaderEntry {
  rig: string;
  run: string;
  mode: string | null;
  status: string;
  champion_seq: number;
  /** Relative gain of the champion over the run's seed, measured on its own rig. */
  gain: number;
  /** Rigs whose own judge accepted this exact champion (propagation): cross-verified. */
  verified_by: string[];
}

/**
 * The campaign leaderboard: each run's champion and its gain over its baseline, measured
 * on its own rig (never absolute numbers across devices), marked cross-verified once another
 * rig's judge accepted it.
 */
export function leaderboard(
  store: ControlStore,
  opts: { staleAfterMs: number },
): Record<string, LeaderEntry[]> {
  const views = store
    .rigs()
    .map((u) => rigView(store, u.id, opts))
    .filter((v): v is RigView => v !== undefined);
  // An acceptance counts only for the tree it accepted: the key includes the tree, which must be
  // the one the source rig itself published (signed) for that seq.
  const verified = new Map<string, Set<string>>();
  for (const v of views) {
    for (const i of v.runs) {
      for (const p of i.propagations) {
        if (p.result !== "accepted" || !p.tree) continue;
        const key = `${p.source_rig}/${p.source_run}/${p.source_seq}/${p.tree}`;
        if (!verified.has(key)) verified.set(key, new Set());
        verified.get(key)?.add(v.id);
      }
    }
  }
  const out: Record<string, LeaderEntry[]> = {};
  for (const v of views) {
    for (const i of v.runs) {
      // Hill climbs: a gain over the baseline is what is compared.
      if (i.mode !== "hill_climb" || !i.campaign) continue;
      const champ = i.champion.filter((c) => !c.reopened).at(-1);
      const seq = champ?.seq ?? 1;
      const tree = i.published_trees[seq];
      if (!out[i.campaign]) out[i.campaign] = [];
      out[i.campaign]?.push({
        rig: v.id,
        run: i.id,
        mode: i.mode,
        status: i.status,
        champion_seq: seq,
        gain: (champ?.cumulative ?? 1) - 1,
        verified_by: tree ? [...(verified.get(`${v.id}/${i.id}/${seq}/${tree}`) ?? [])].sort() : [],
      });
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.gain - a.gain);
  return out;
}

/** A campaign and its runs on every rig: the dashboard's first level. */
export interface CampaignView {
  name: string;
  mode: string | null;
  runs: { rig: RigView; run: RunView }[];
}

/**
 * Groups runs by campaign: Campaign ▸ Run (on a rig) ▸ Lane ▸ Trial ▸ Attempt. Campaigns with a
 * live run come first.
 */
export function campaignViews(vs: RigView[]): CampaignView[] {
  const by = new Map<string, CampaignView>();
  for (const rig of vs) {
    for (const run of rig.runs) {
      const name = run.campaign || run.id;
      const c = by.get(name) ?? { name, mode: run.mode, runs: [] };
      c.runs.push({ rig, run });
      by.set(name, c);
    }
  }
  const rank = (c: CampaignView) =>
    c.runs.some((x) => x.run.status === "running")
      ? 0
      : c.runs.some((x) => x.run.status === "paused")
        ? 1
        : 2;
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * Every campaign control knows, with its mode: from the runs rigs report, the versions saved on
 * control, the assignments it signed, and the knowledge base's folders (goal 065).
 */
export function campaignModes(store: ControlStore, vs: RigView[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const modeOf = (contract: unknown) => {
    const m = (contract as { mode?: unknown } | undefined)?.mode;
    return typeof m === "string" ? m : null;
  };
  for (const k of campaignViews(vs)) out.set(k.name, k.mode);
  for (const v of store.campaignVersions())
    if (!out.get(v.campaign)) out.set(v.campaign, modeOf(v.contract));
  for (const [name, a] of store.latestAssignments())
    if (!out.get(name)) out.set(name, modeOf(a.payload.contract));
  for (const f of store.kb().folders()) if (!out.has(f.campaign)) out.set(f.campaign, null);
  return out;
}

/**
 * One queue event on a run's view (goal 064). The queued experiments keep their order in
 * `position` (0 first); an experiment leaves the order when it is assigned, done or dropped.
 */
function queueEvent(v: RunView, e: StoredEvent): void {
  const b = (e.body ?? {}) as Record<string, unknown>;
  const id = String(b.id ?? "");
  if (!id) return;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  let x = v.queue.find((q) => q.id === id);
  const order = () =>
    v.queue
      .filter((q) => q.state === "queued")
      .sort((a, z) => (a.position ?? 0) - (z.position ?? 0));
  const place = (it: ExperimentView, pos: unknown) => {
    const rest = order().filter((q) => q !== it);
    const at =
      pos === "top"
        ? 0
        : typeof pos === "number" && Number.isFinite(pos)
          ? Math.max(0, Math.min(rest.length, Math.trunc(pos)))
          : rest.length;
    rest.splice(at, 0, it);
    rest.forEach((q, i) => {
      q.position = i;
    });
  };
  const leave = (it: ExperimentView) => {
    it.position = null;
    order()
      .filter((q) => q !== it)
      .forEach((q, i) => {
        q.position = i;
      });
  };
  if (e.kind === "experiment_added") {
    if (x) return;
    x = {
      id,
      title: str("title") ?? id,
      details: str("details") ?? "",
      family: str("family") ?? "",
      why: str("why") ?? "",
      by: str("by") ?? e.actor,
      state: b.state === "proposed" ? "proposed" : "queued",
      position: null,
      lane: str("lane") ?? null,
      trial: null,
      attempt: null,
      result: null,
      dropped_why: null,
      dropped_by: null,
      from_run: str("from_run") ?? null,
      at: e.at,
      updated_at: e.at,
    };
    v.queue.push(x);
    if (x.state === "queued") place(x, b.position);
    return;
  }
  if (!x) return;
  x.updated_at = e.at;
  switch (e.kind) {
    case "experiment_accepted":
      x.state = "queued";
      place(x, b.position);
      break;
    case "experiment_moved":
      if (x.state === "queued") place(x, b.position);
      break;
    case "experiment_edited":
      x.title = str("title") ?? x.title;
      x.details = str("details") ?? x.details;
      x.family = str("family") ?? x.family;
      x.why = str("why") ?? x.why;
      break;
    case "experiment_dropped":
      leave(x);
      x.state = "dropped";
      x.dropped_why = str("why") ?? null;
      x.dropped_by = str("by") ?? e.actor;
      break;
    case "experiment_assigned":
      leave(x);
      x.state = "assigned";
      x.lane = str("lane") ?? x.lane;
      x.trial = str("trial") ?? x.trial;
      break;
    case "experiment_finished":
      leave(x);
      x.state = "done";
      x.trial = str("trial") ?? x.trial;
      x.lane = str("lane") ?? x.lane;
      x.attempt = str("attempt") ?? null;
      x.result = str("result") ?? str("stopped") ?? null;
      break;
  }
}

/**
 * A run's directions (goal 066), as the harness counts them: each experiment's direction, each
 * direction its registry added, each family an attempt or a trial had, the task kinds of a
 * research run, and each direction a rule in force names, which waits for the planner to design
 * it while nothing else has it. Sorted by name.
 */
export function runDirections(v: RunView): DirectionView[] {
  const out = new Map<string, DirectionView>();
  const at = (name: string | undefined, made = true): DirectionView | undefined => {
    if (!name) return undefined;
    let d = out.get(name);
    if (!d) {
      d = {
        name,
        description: null,
        tried: 0,
        wins: 0,
        queued: 0,
        lanes: [],
        rules: [],
        to_design: !made,
      };
      out.set(name, d);
    } else if (made) d.to_design = false;
    return d;
  };
  const won = (attempt: string | null) => {
    if (!attempt) return false;
    if (v.champion.some((c) => c.attempt === attempt && !c.reopened)) return true;
    const a = v.attempts.find((x) => x.id === attempt);
    return (
      a?.lifecycle === "promoted" ||
      a?.verdict === "win_confirmed" ||
      a?.verdict === "goal_progress"
    );
  };
  for (const f of v.families) {
    const d = at(directionOf(f.name));
    if (d && f.description) d.description = f.description;
  }
  if (v.mode === "research") for (const k of RESEARCH_TASK_KINDS) at(k);
  for (const a of v.attempts) at(a.family ? directionOf(a.family) : undefined);
  for (const t of v.trials) at(t.family ? directionOf(t.family) : undefined);
  const busy = new Set<string>();
  for (const x of v.queue) {
    const d = at(x.family ? directionOf(x.family) : undefined);
    if (!d) continue;
    if (x.state === "queued") d.queued++;
    if (x.state === "done") {
      d.tried++;
      if (won(x.attempt)) d.wins++;
    }
    if (x.state === "assigned" && x.lane) {
      busy.add(x.lane);
      if (!d.lanes.includes(x.lane)) d.lanes.push(x.lane);
    }
  }
  // A lane at work on a trial without an experiment (before the queue) counts by its family.
  for (const [lane, w] of Object.entries(v.at_work)) {
    if (busy.has(lane)) continue;
    const d = at(w.family ? directionOf(w.family) : undefined);
    if (d && !d.lanes.includes(lane)) d.lanes.push(lane);
  }
  for (const r of v.rules) {
    if (r.legacy || typeof r.body.family !== "string") continue;
    at(r.body.family, false)?.rules.push({ id: r.id, kind: String(r.body.kind ?? "") });
  }
  for (const d of out.values())
    d.lanes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
