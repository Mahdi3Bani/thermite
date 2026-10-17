import { type Hardware, readHardware } from "../core/hardware.ts";
import type { ControlStore } from "./store.ts";

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
}

export interface RigView {
  id: string;
  last_seen: string;
  stale: boolean;
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
}

export interface RigModelView {
  source: "control" | "environment" | "none";
  name: string | null;
  version: number | null;
  model: string | null;
  base_url: string | null;
  key_hint: string | null;
  /** The harness its agents run in. */
  harness: "pi" | "opencode";
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
    harness: o.harness === "opencode" ? "opencode" : "pi",
  };
}

export interface RigCheckView {
  check: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  summary: string | null;
}

export function rigEvents(
  store: ControlStore,
  rig: string,
  ledgerId?: string | null,
): StoredEvent[] {
  const out: StoredEvent[] = [];
  let after = 0;
  for (;;) {
    const page = store.events(rig, after, 5000, ledgerId) as StoredEvent[];
    out.push(...page);
    if (page.length < 5000) return out;
    after = (page.at(-1) as StoredEvent).seq;
  }
}

/** Builds a rig's view from its events (only the current ledger's, after a reset). */
export function rigView(
  store: ControlStore,
  rig: string,
  opts: { staleAfterMs: number; now?: number } = { staleAfterMs: 180_000 },
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
      case "rig_check_started": {
        const check = String(b.check ?? "");
        checks[check] = { check, started_at: e.at, finished_at: null, ok: null, summary: null };
        break;
      }
      case "rig_check_finished": {
        const check = String(b.check ?? "");
        checks[check] = {
          check,
          started_at: checks[check]?.started_at ?? e.at,
          finished_at: e.at,
          ok: b.ok === true,
          summary: typeof b.summary === "string" ? b.summary : null,
        };
        break;
      }
      case "run_created": {
        const v = inst(String(e.subject));
        v.campaign = String(b.campaign ?? "");
        v.mode = String(b.mode ?? "");
        v.created_at = e.at;
        running = v.id;
        v.seed_repo =
          ((b.seed as { repo?: string } | undefined)?.repo as string | undefined) ?? null;
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
        inst(String(e.subject)).directives++;
        break;
      }
      case "directives_superseded": {
        const v = inst(String(e.subject));
        v.directives = Math.max(0, v.directives - (Array.isArray(b.ids) ? b.ids.length : 0));
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
    if (run && runs.has(run)) {
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
  }
  const summary = u.summary as
    | { jobs?: Record<string, number>; hardware?: unknown; model?: unknown }
    | undefined;
  const now = opts.now ?? Date.now();
  const allJobs = [...jobs.values()];
  return {
    id: u.id,
    last_seen: u.last_seen,
    stale: now - Date.parse(u.last_seen) > opts.staleAfterMs,
    ledger_id: u.ledger_id,
    summary: u.summary,
    supervisor: store.supervisor(u.id),
    hardware: readHardware(summary?.hardware),
    model: readModelInfo(summary?.model),
    jobs: summary?.jobs ?? {},
    runs: [...runs.values()],
    recent: events.slice(-50).reverse(),
    judge: {
      now: allJobs.filter((j) => j.state === "running").at(-1) ?? null,
      queued: allJobs.filter((j) => j.state === "queued"),
      jobs: allJobs.slice(-200),
    },
    checks,
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
