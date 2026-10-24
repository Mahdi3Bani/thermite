import { directionOf, isLegacyRule, RESEARCH_TASK_KINDS } from "../core/directions.ts";
import { type Hardware, readHardware } from "../core/hardware.ts";
import { clip } from "../core/kb-index.ts";
import {
  PAPER_ACCEPTED,
  PAPER_REFUSED,
  PAPER_REQUESTED,
  RESEARCH_REVIEW,
} from "../core/research-check.ts";
import { type BuildInfo, buildInfo } from "../core/version.ts";
import { type GoalChecks, parseGoalChecks } from "../harness/goal-checks.ts";
import {
  type GoalCellValues as GoalValues,
  parseGoalValues as goalValuesOf,
} from "../harness/judge/goal-values.ts";
import { type MetricValues, metricValuesOf } from "./metric-values.ts";
import {
  type HypothesisView,
  type ItemDecisionView,
  newReviewFigures,
  type ProgressView,
  panelFigures,
  type ReviewFigures,
  researchEvent,
  type StandingView,
  standingOf,
  type TaskYieldView,
  taskFields,
} from "./research-view.ts";
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
  /** The main metric's values its latest verdict's gain comes from (goal 133). */
  values: MetricValues | null;
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
  /**
   * Its newest confirmation's held-out check, for the owner (goal 082): whether every held-out
   * cell passed, and each cell's name, kind of failure and value against its threshold. Null when
   * no held-out check ran, or its rig's harness is older.
   */
  held_out: HeldOutView | null;
}

/** One held-out check of an attempt, from the judge's `held_out_checked` event. */
export interface HeldOutView {
  at: string;
  pass: boolean;
  cells: {
    cell: string;
    goal: string | null;
    verifier: string | null;
    ok: boolean;
    kind: string | null;
    value: number | null;
    low: number | null;
    high: number | null;
    threshold: number | null;
    op: string | null;
    measure: string | null;
    unit: string | null;
  }[];
  /** How many cells the check had; the event names at most 50. */
  cells_total: number;
}

/** A held-out check of a goal run's champion (goal 086), from the judge's event. */
export type ChampionHeldOutView = HeldOutView & { champion_seq: number };

/** A held-out check from its event's body, each field checked: the rig's report is data. */
function heldOutView(at: string, b: Record<string, unknown>): HeldOutView {
  const txt = (v: unknown, n = 200) => (typeof v === "string" ? clip(v, n) : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const cells = (Array.isArray(b.cells) ? b.cells : []).slice(0, 50).flatMap((x) => {
    const c = (x ?? {}) as Record<string, unknown>;
    if (typeof c.cell !== "string") return [];
    return [
      {
        cell: clip(c.cell, 200),
        goal: txt(c.goal),
        verifier: txt(c.verifier),
        ok: c.ok === true,
        kind: txt(c.kind, 40),
        value: num(c.value),
        low: num(c.low),
        high: num(c.high),
        threshold: num(c.threshold),
        op: c.op === ">=" || c.op === ">" || c.op === "<=" || c.op === "<" ? c.op : null,
        measure: txt(c.measure),
        unit: txt(c.unit, 40),
      },
    ];
  });
  return {
    at,
    pass: b.pass === true,
    cells,
    cells_total: typeof b.cells_total === "number" ? b.cells_total : cells.length,
  };
}

/** A hill climb's baseline from its event's body (goal 115), each field checked. */
function baselineView(at: string, b: Record<string, unknown>): BaselineView {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const txt = (v: unknown, n = 200) => (typeof v === "string" ? clip(v, n) : "");
  const dir = (v: unknown) => (v === "min" ? "min" : "max");
  const p = (b.primary ?? null) as Record<string, unknown> | null;
  const cells = (b.cells ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  return {
    at,
    champion_seq: num(b.champion_seq) || 1,
    commit: txt(b.commit, 80),
    attempt: typeof b.attempt === "string" ? clip(b.attempt, 80) : null,
    blocks: num(b.blocks),
    runs_per_cell: num(b.runs_per_cell),
    primary:
      p && typeof p.metric === "string"
        ? { metric: txt(p.metric), direction: dir(p.direction) }
        : null,
    guards: (Array.isArray(b.guards) ? b.guards : []).slice(0, 50).flatMap((x) => {
      const g = (x ?? {}) as Record<string, unknown>;
      return typeof g.metric === "string"
        ? [
            {
              metric: txt(g.metric),
              direction: dir(g.direction),
              max_total_regression: num(g.max_total_regression),
            },
          ]
        : [];
    }),
    units: Object.fromEntries(
      Object.entries((b.units ?? {}) as Record<string, unknown>)
        .slice(0, 100)
        .map(([k, v]) => [clip(k, 200), txt(v, 40)]),
    ),
    cells: Object.entries(cells)
      .slice(0, 200)
      .map(([cell, metrics]) => ({
        cell: clip(cell, 200),
        metrics: Object.entries(metrics ?? {})
          .slice(0, 100)
          .map(([metric, v]) => ({
            metric: clip(metric, 200),
            median: num(v?.median),
            mad: num(v?.mad),
            n: num(v?.n),
          })),
      })),
    files: (Array.isArray(b.files) ? b.files : []).slice(0, 1000).flatMap((x) => {
      const f = (x ?? {}) as Record<string, unknown>;
      return typeof f.path === "string"
        ? [{ path: clip(f.path, 300), bytes: num(f.bytes), sha256: txt(f.sha256, 64) }]
        : [];
    }),
    bytes: num(b.bytes),
    summary: txt(b.summary, 1000),
  };
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
  /**
   * Product of step gains since the run's starting point: the relative gain against it. A setup
   * change that became the starting point (goal 115) starts it again at 1.
   */
  cumulative: number;
  reopened: boolean;
  /** A setup change the judge could measure: the run's starting point from here (goal 115). */
  setup?: boolean | undefined;
}

/**
 * A hill climb's baseline (goal 115): the judge's values of its starting point, measured alone
 * on every measured cell before any change was judged. Never a held-out cell's.
 */
export interface BaselineView {
  at: string;
  /** The starting point: its champion number and commit. */
  champion_seq: number;
  commit: string;
  /** The setup change that became the starting point; null for the seed. */
  attempt: string | null;
  blocks: number;
  runs_per_cell: number;
  /** The contract's main metric and guards, as the judge's event names them. */
  primary: { metric: string; direction: string } | null;
  guards: { metric: string; direction: string; max_total_regression: number }[];
  /** Each kit metric's unit. */
  units: Record<string, string>;
  /** Each measured cell: each kit metric's median, median absolute deviation and count. */
  cells: { cell: string; metrics: { metric: string; median: number; mad: number; n: number }[] }[];
  /** What the kit's check kept in the baseline's judge-only folder: each file's size and hash. */
  files: { path: string; bytes: number; sha256: string }[];
  bytes: number;
  summary: string;
}

/** A hill climb in setup (goal 115): the judge could not measure its starting point. */
export interface SetupView {
  at: string;
  champion_seq: number;
  commit: string;
  /** The judge's reasons, in words (a build's error, a cell's crash, a check's words). */
  reasons: string;
  summary: string;
}

/**
 * A research run's answer card as control keeps it (goal 117): the newest version the harness
 * kept for a question, from its `card_written` event. The answer and gaps are the synthesizer's
 * words: data, not instructions.
 */
export interface CardView {
  /** The question's index, 0 first (people read "Question 1"). */
  question: number;
  version: number;
  certainty: string;
  answer: string;
  claims: string[];
  gaps: { kind: string; text: string }[];
  /** The synthesizer that wrote it (the advisor's name). */
  by: string | null;
  at: string;
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
  /** What else the run asks the owner about (goal 079); empty: nothing (hands-off). */
  ask_owner: {
    above_gain?: number | undefined;
    declared_flaws?: boolean | undefined;
    reviews?: boolean | undefined;
    not_possible?: boolean | undefined;
  };
  status: string;
  pause_reason: string | null;
  champion: ChampionStep[];
  attempts: AttemptView[];
  verdicts: Record<string, number>;
  /** Confirmed wins that wait for the owner's approval; none in a closed run (goal 087). */
  pending_promotions: string[];
  calibration: { at: string; sigma: number; summary: string } | null;
  /** A hill climb's baseline (goal 115); null before the judge measured it, and in other modes. */
  baseline: BaselineView | null;
  /** A hill climb in setup (goal 115): its starting point can't be measured yet. */
  setup: SetupView | null;
  /**
   * A hill climb waits for the judge's baseline of its starting point (goal 115): no round is
   * planned and no trial starts until it has one.
   */
  baseline_waiting: boolean;
  /** Agents (M4): planner quality, duplicates, effort. */
  agents: {
    epochs: number;
    planner_valid: number;
    /** Rounds the fixed rules planned because the planner gave no usable plan (or was off). */
    fallbacks: number;
    /** A research run's rounds: planned by the research plan, never by the planner (goal 079). */
    research_rounds: number;
    epochs_with_violations: number;
    trials: number;
    submitted: number;
    tokens_in: number;
    tokens_out: number;
    duplicates: number;
    attempts: number;
  };
  /**
   * The run's agents stopped (goal 079): the provider refused (no credits, a refused key, an
   * unserved model) or the workers' model check fails. Null while they can run.
   */
  agents_stopped: {
    kind: string;
    /** The provider's or the check's own words. */
    words: string;
    /** The kind in plain words. */
    said: string;
    /** What found it: a trial, the model check. */
    by: string;
    since: string;
  } | null;
  /** Research mode: the newest digest's figures and report. */
  research: Record<string, unknown> | null;
  /**
   * A research run's answer cards (goal 117): each question's newest card the harness kept, by
   * question index (0 first), from its `card_written` events. Empty until the synthesizer writes
   * one, and in other modes.
   */
  cards: CardView[];
  /**
   * The newest refused card of each question since its card (goal 117), with the harness's
   * problems (the first 5, short): the synthesizer writes it again at its next round.
   */
  card_refusals: { question: number; at: string; by: string | null; problems: string[] }[];
  /**
   * A research run's hypotheses (goal 117), oldest first: the author's, the pool's, promoted,
   * merged and retired ones, with their questions and the newest change of their status.
   */
  hypotheses: HypothesisView[];
  /** The review panel's decision on each item in each review (goal 117), oldest first. */
  decisions: ItemDecisionView[];
  /**
   * Each item's newest decision (goal 117), and whether it stands: a question's stands until its
   * card has a newer version than the one decided on.
   */
  standing: StandingView[];
  /** The progress rule's state at the newest digest (goal 117); null until a harness sends one. */
  progress: ProgressView | null;
  goals: {
    goal: string;
    description: string | null;
    status: string;
    reasons: string;
    /**
     * A code verifier's goal (goal 086): each public cell's values as the judge measured them,
     * met or not; null for another goal, or a report from an older harness. Never a held-out
     * cell's.
     */
    values: GoalValues[] | null;
  }[];
  /** When the judge last checked the goals, and on which champion. */
  goals_at: string | null;
  goals_seq: number | null;
  /**
   * The judge's check of the champion found every required goal met, and its second, confirming
   * check is still to come (goal 086): the run's lanes start no new trial until it is done.
   */
  goals_confirming: boolean;
  /**
   * The newest goal report found the goals met for good: every required goal (or the k of n the
   * contract asks for) met, and confirmed by the judge's second check (goal 086). A closed goal
   * run with it reads Completed on the dashboard (goal 099).
   */
  goals_complete: boolean;
  /**
   * The newest held-out check of the run's champion, for the owner (goal 086): the second
   * validation of a champion that met every required goal runs the held-out cells of the goals
   * met. As an attempt's `held_out`, with the champion it checked. Null when none ran.
   */
  champion_held_out: ChampionHeldOutView | null;
  /**
   * How each goal is really checked, as the rig's kit runs it (goal 082): from the rig's
   * `goal_checks` event when the run started. Null for a run an older harness started.
   */
  goal_checks: GoalChecks | null;
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
  /**
   * Subjective-goal reviews: the panel's result, then the owner's. A research run's reviews (goal
   * 112) have the goal `research`; `gaps` holds what its reviewers found missing, short, and
   * `answers` each question's first answer that passed the harness's check, short (questions
   * numbered from 0); both null until the review panel decided, and for a goal's review. Each
   * also has its times and figures (goal 116): when it was asked and posted, what it saw, each
   * reviewer's answers per item and the panel's decision per item (goal 117).
   */
  reviews: ({
    review: number;
    goal: string;
    commit: string;
    panel: string | null;
    owner: string | null;
    gaps: string[] | null;
    answers: { question: number; answer: string }[] | null;
  } & ReviewFigures)[];
  /**
   * A research run's paper (goal 112): asked of the supervisor's final writer once the review
   * panel's pass was accepted (`writing`), with the newest refusal of a draft while it is still
   * written, then accepted (`in`), with the paper itself. Null until it is asked for.
   */
  paper: {
    state: "writing" | "in";
    requested_at: string;
    refused: { at: string; problems: string[] } | null;
    at: string | null;
    writer: string | null;
    ste_checked: boolean | null;
    experiments: number;
    /** Its next experiments by the run each is for (goal 119); both 0 for a paper that tagged none. */
    next_for: { hill_climb: number; goal: number };
    /** The paper, with the references the harness appended, as its event carries it. */
    text: string | null;
  } | null;
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
  /**
   * How its trial ended, in words; or, back in the queue, why its last trial never really tried
   * it (goal 079). Null: nothing said.
   */
  cause: string | null;
  /** How many times its trial ended without really trying it, and it came back (goal 079). */
  returns: number;
  /** A research task's question, as an index from 0 (goal 117); null: none. */
  question: number | null;
  /** What a research task's trial added (goal 117); null until its trial ends with one. */
  yield: TaskYieldView | null;
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
  /** Each advisor's answer: its role, and the advisor by name when the supervisor says. */
  answers: { role: string; text: string; at: string; advisor?: string | undefined }[];
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
  /** A trial's length when its contract sets none; null: none (goal 079). */
  trial_minutes: number | null;
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
    trial_minutes: typeof o.trial_minutes === "number" ? o.trial_minutes : null,
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
 * A rig's own settings (Edit rig) and its GPU split, as its last signed report gives them, read
 * as rigView reads them; undefined for a rig control has no report of (or one retired).
 */
export function rigSettingsOf(
  store: ControlStore,
  rig: string,
): Pick<RigView, "settings" | "gpu_split"> | undefined {
  const u = store.rigs().find((x) => x.id === rig);
  if (!u) return undefined;
  const summary = u.summary as { settings?: unknown; gpu_split?: unknown } | undefined;
  return {
    settings: readSettings(summary?.settings),
    gpu_split: readGpuSplit(summary?.gpu_split),
  };
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
        ask_owner: {},
        status: "unknown",
        pause_reason: null,
        champion: [],
        attempts: [],
        verdicts: {},
        pending_promotions: [],
        calibration: null,
        baseline: null,
        setup: null,
        baseline_waiting: false,
        agents: {
          epochs: 0,
          planner_valid: 0,
          fallbacks: 0,
          research_rounds: 0,
          epochs_with_violations: 0,
          trials: 0,
          submitted: 0,
          tokens_in: 0,
          tokens_out: 0,
          duplicates: 0,
          attempts: 0,
        },
        agents_stopped: null,
        research: null,
        cards: [],
        card_refusals: [],
        hypotheses: [],
        decisions: [],
        standing: [],
        progress: null,
        goals: [],
        goals_at: null,
        goals_seq: null,
        goals_confirming: false,
        goals_complete: false,
        champion_held_out: null,
        goal_checks: null,
        audits: [],
        promotion_waits: {},
        reviews: [],
        paper: null,
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
        {
          const ask = (b.ask_owner ?? {}) as Record<string, unknown>;
          v.ask_owner = {
            ...(typeof ask.above_gain === "number" ? { above_gain: ask.above_gain } : {}),
            ...(ask.declared_flaws === true ? { declared_flaws: true } : {}),
            ...(ask.reviews === true ? { reviews: true } : {}),
            ...(ask.not_possible === true ? { not_possible: true } : {}),
          };
        }
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
      case "agents_stopped": {
        const v = inst(String(e.subject));
        v.agents_stopped = {
          kind: String(b.kind ?? ""),
          words: String(b.words ?? ""),
          said: String(b.said ?? b.kind ?? ""),
          by: String(b.by ?? ""),
          since: e.at,
        };
        break;
      }
      case "agents_resumed": {
        inst(String(e.subject)).agents_stopped = null;
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
          values: null,
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
          held_out: null,
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
          a.values = metricValuesOf(b.values);
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
      case "held_out_checked": {
        // A goal run's champion's check names its champion (goal 086); else it is an attempt's.
        if (typeof b.champion_seq === "number") {
          inst(typeof b.run === "string" ? b.run : String(e.subject)).champion_held_out = {
            ...heldOutView(e.at, b),
            champion_seq: b.champion_seq,
          };
          break;
        }
        const a = attempts.get(String(e.subject));
        if (a) a.held_out = heldOutView(e.at, b);
        break;
      }
      case "goal_checks": {
        inst(String(e.subject)).goal_checks = parseGoalChecks(b);
        break;
      }
      case "champion_promoted": {
        const v = inst(String(e.subject));
        const attempt = (b.attempt as string | null) ?? null;
        // A setup change that became the starting point (goal 115): the gain starts again.
        const setup = b.setup === true;
        const delta = attempt && !setup ? (confirmDelta.get(attempt) ?? null) : null;
        const prev = v.champion.filter((c) => !c.reopened).at(-1);
        v.champion.push({
          seq: Number(b.seq),
          attempt,
          commit: String(b.commit ?? ""),
          at: e.at,
          delta,
          cumulative: setup ? 1 : (prev?.cumulative ?? 1) * (1 + (delta ?? 0)),
          reopened: false,
          ...(setup ? { setup: true } : {}),
        });
        v.pending_promotions = v.pending_promotions.filter((p) => p !== attempt);
        break;
      }
      case "champion_reopened": {
        const v = inst(String(e.subject));
        const step = v.champion.find((c) => c.seq === Number(b.seq));
        if (step) step.reopened = true;
        // A starting point withdrawn takes its baseline with it (goal 115).
        if (v.baseline?.champion_seq === Number(b.seq)) v.baseline = null;
        break;
      }
      // A hill climb's baseline (goal 115): the judge measured its starting point.
      case "baseline": {
        const v = inst(String(e.subject));
        v.baseline = baselineView(e.at, b);
        v.setup = null;
        v.baseline_waiting = false;
        break;
      }
      // The judge could not measure the starting point: the run is in setup.
      case "baseline_failed": {
        const v = inst(String(e.subject));
        v.baseline = null;
        v.baseline_waiting = false;
        v.setup = {
          at: e.at,
          champion_seq: Number(b.champion_seq ?? 1),
          commit: String(b.commit ?? ""),
          reasons: clip(String(b.reasons ?? ""), 4000),
          summary: clip(String(b.summary ?? ""), 1000),
        };
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
        // A research round is planned by the research plan on purpose: not a fallback (goal 079).
        // Nor is a hill climb's setup round, set from the judge's reasons (goal 115).
        if (b.plan === "research") a.research_rounds++;
        else if (b.source === "fallback" && b.plan !== "setup") a.fallbacks++;
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
      // A research run's answer cards (goal 117): the newest the harness kept for each question.
      case "card_written": {
        const v = inst(String(e.subject));
        const q = Number(b.question);
        if (!Number.isInteger(q) || q < 0) break;
        const card: CardView = {
          question: q,
          version: Number(b.version) || 0,
          certainty: String(b.certainty ?? ""),
          answer: typeof b.answer === "string" ? b.answer : "",
          claims: (Array.isArray(b.cited) ? b.cited : []).map(String),
          gaps: (Array.isArray(b.gap_list) ? b.gap_list : []).flatMap((g) => {
            const x = (g ?? {}) as Record<string, unknown>;
            return typeof x.text === "string" ? [{ kind: String(x.kind ?? ""), text: x.text }] : [];
          }),
          by: typeof b.by === "string" ? b.by : null,
          at: e.at,
        };
        v.cards = [...v.cards.filter((c) => c.question !== q), card].sort(
          (x, y) => x.question - y.question,
        );
        v.card_refusals = v.card_refusals.filter((r) => r.question !== q);
        break;
      }
      case "card_refused": {
        const v = inst(String(e.subject));
        const q = Number(b.question);
        if (!Number.isInteger(q) || q < 0) break;
        v.card_refusals = [
          ...v.card_refusals.filter((r) => r.question !== q),
          {
            question: q,
            at: e.at,
            by: typeof b.by === "string" ? b.by : null,
            problems: (Array.isArray(b.problems) ? b.problems : [])
              .filter((x): x is string => typeof x === "string")
              .slice(0, 5)
              .map((x) => x.slice(0, 300)),
          },
        ].sort((x, y) => x.question - y.question);
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
          values: goalValuesOf((g as { values?: unknown }).values),
        }));
        v.goals_at = e.at;
        v.goals_seq = typeof b.champion_seq === "number" ? b.champion_seq : null;
        // Every required goal met, and the second check still to come (goal 086).
        v.goals_confirming = b.complete === true && b.confirming === true;
        // Met for good: complete, and not the first check that a second one must confirm.
        v.goals_complete = b.complete === true && b.confirming !== true;
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
      case "audit_skipped": {
        // No auditor decides it (goal 079): the run's own rules did.
        const a = inst(String(b.run))
          .audits.filter((x) => x.attempt === e.subject)
          .at(-1);
        if (a && a.decision === null) {
          a.decision = "skipped";
          a.reasons = String(b.why ?? "this rig has no auditor");
        }
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
          gaps: null,
          answers: null,
          ...newReviewFigures(e.at, b),
        });
        break;
      }
      case "review_panel":
      case "review_decided": {
        const r = inst(String(e.subject)).reviews.find((x) => x.review === Number(b.review));
        if (r && e.kind === "review_panel") {
          r.panel = String(b.result);
          panelFigures(r, e.at, b);
          // A research review's gaps (goal 112): the reviewers' words, kept short.
          if (Array.isArray(b.gaps))
            r.gaps = b.gaps
              .filter((g): g is string => typeof g === "string")
              .map((g) => g.slice(0, 300));
          if (r.goal === RESEARCH_REVIEW && Array.isArray(b.questions))
            r.answers = (b.questions as Record<string, unknown>[]).flatMap((q) =>
              q && typeof q.answer === "string" && Number.isInteger(q.question)
                ? [{ question: Number(q.question), answer: q.answer.slice(0, 500) }]
                : [],
            );
        }
        if (r && e.kind === "review_decided") {
          r.owner = String(b.decision);
          r.owner_at = e.at;
          r.owner_note = typeof b.note === "string" && b.note ? b.note : null;
        }
        break;
      }
      // A research run's items (goals 116 and 117): its hypotheses, each reviewer's answers per
      // item, the review panel's decision on each item, and the progress rule's state.
      case "hypothesis_added":
      case "hypothesis_revised":
      case "hypothesis_merged":
      case "hypothesis_status":
      case "review_items":
      case "review_try_failed":
      case "item_decided":
      case "research_progress":
        researchEvent(inst(String(e.subject)), e);
        break;
      // A research run's paper (goal 112): asked for, refused with problems, then in.
      case PAPER_REQUESTED: {
        inst(String(e.subject)).paper = {
          state: "writing",
          requested_at: e.at,
          refused: null,
          at: null,
          writer: null,
          ste_checked: null,
          experiments: 0,
          next_for: { hill_climb: 0, goal: 0 },
          text: null,
        };
        break;
      }
      case PAPER_REFUSED: {
        const p = inst(String(e.subject)).paper;
        if (p && p.state === "writing")
          p.refused = {
            at: e.at,
            problems: (Array.isArray(b.problems) ? b.problems : [])
              .filter((x): x is string => typeof x === "string")
              .slice(0, 5)
              .map((x) => x.slice(0, 300)),
          };
        break;
      }
      case PAPER_ACCEPTED: {
        const v = inst(String(e.subject));
        const ste = (b.ste ?? {}) as { checked?: unknown };
        v.paper = {
          state: "in",
          requested_at: v.paper?.requested_at ?? e.at,
          refused: null,
          at: e.at,
          writer: typeof b.writer === "string" ? b.writer : null,
          ste_checked: ste.checked === true,
          experiments: Array.isArray(b.experiments) ? b.experiments.length : 0,
          next_for: {
            hill_climb: (Array.isArray(b.experiments) ? b.experiments : []).filter(
              (x) => (x as { kind?: unknown })?.kind === "hill_climb",
            ).length,
            goal: (Array.isArray(b.experiments) ? b.experiments : []).filter(
              (x) => (x as { kind?: unknown })?.kind === "goal",
            ).length,
          },
          text: typeof b.paper === "string" ? b.paper : null,
        };
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
      case "experiment_finished":
      case "experiment_returned": {
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
          m.answers.push({
            role: String(b.role ?? ""),
            text: String(b.text ?? ""),
            at: e.at,
            ...(typeof b.advisor === "string" && b.advisor ? { advisor: b.advisor } : {}),
          });
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
        const run =
          typeof b.run === "string" && b.run
            ? b.run
            : attempt
              ? (attempts.get(attempt)?.run ?? null)
              : running;
        jobs.set(String(e.subject), {
          id: String(e.subject),
          kind: String(b.kind ?? ""),
          attempt,
          run,
          queued_at: e.at,
          started_at: null,
          finished_at: null,
          state: "queued",
          result: {},
        });
        // The judge measures a hill climb's starting point (goal 115): its rounds wait.
        const jr = run ? runs.get(run) : undefined;
        if (jr && b.kind === "baseline" && !attempt && !jr.baseline && !jr.setup)
          jr.baseline_waiting = true;
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
      case "crash_infra":
      case "job_lease_expired": {
        // A job whose lease ran out too often is blocked: it will not run. A blocked validation
        // leaves no completion to confirm, and the lanes go on (goal 086). Both requeue events
        // (a crash, and a lease that ran out) can block one.
        const j = jobs.get(String(e.subject));
        if (!j || b.state !== "blocked") break;
        j.finished_at = e.at;
        j.state = "blocked";
        const jr = j.run ? runs.get(j.run) : undefined;
        if (jr && j.kind === "validate") jr.goals_confirming = false;
        break;
      }
      case "job_finished": {
        const j = jobs.get(String(e.subject));
        if (!j) break;
        j.finished_at = e.at;
        j.state = String(b.state ?? "done");
        j.result =
          b.result && typeof b.result === "object" ? (b.result as Record<string, unknown>) : {};
        // A validation that failed leaves no completion to confirm: the lanes go on (goal 086).
        const jr = j.run ? runs.get(j.run) : undefined;
        if (jr && j.kind === "validate" && j.state === "failed") jr.goals_confirming = false;
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
    v.standing = standingOf(v);
    // A closed run waits for no one (goal 087; the owner, 2026-10-22): the rig refuses approvals
    // of its changes, so none is pending. Each attempt keeps its own lifecycle.
    if (v.status === "closed") v.pending_promotions = [];
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
 * A campaign's newest run, by when it started (goal 099): with no run at work, the campaign
 * stands where its newest run stands, so an older paused run does not hide a newer one's end.
 */
export function newestRun(k: CampaignView): CampaignView["runs"][number] | undefined {
  let best: CampaignView["runs"][number] | undefined;
  for (const x of k.runs)
    if (!best || (x.run.created_at ?? "") > (best.run.created_at ?? "")) best = x;
  return best;
}

/**
 * Groups runs by campaign: Campaign ▸ Run (on a rig) ▸ Lane ▸ Trial ▸ Attempt. Campaigns with a
 * live run come first, then those whose newest run is paused.
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
      : newestRun(c)?.run.status === "paused"
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
      cause: null,
      returns: 0,
      question: null,
      yield: null,
      at: e.at,
      updated_at: e.at,
    };
    taskFields(x, e);
    v.queue.push(x);
    if (x.state === "queued") place(x, b.position);
    return;
  }
  if (!x) return;
  x.updated_at = e.at;
  taskFields(x, e);
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
      x.cause = str("cause") ?? null;
      break;
    // Its trial never really tried it (goal 079): the same experiment, back at the top.
    case "experiment_returned":
      x.state = "queued";
      x.lane = null;
      x.trial = null;
      x.attempt = null;
      x.result = null;
      x.cause = str("cause") ?? null;
      x.returns = Number(b.returns) || x.returns + 1;
      place(x, b.position ?? "top");
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
