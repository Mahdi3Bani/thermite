import type { ControlStore } from "./store.ts";

/**
 * Control's read model: what the dashboard, the API and MCP show. It is computed from the
 * events units reported (the harness ledger is the source of truth; control only mirrors it),
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
  instance: string;
  lane: string | null;
  lifecycle: string;
  verdict: string | null;
  delta: number | null;
  hypothesis: string | null;
  recorded_at: string;
  updated_at: string;
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

export interface InstanceView {
  id: string;
  campaign: string | null;
  mode: string | null;
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
  goals: { goal: string; status: string; reasons: string }[];
}

export interface UnitView {
  id: string;
  last_seen: string;
  stale: boolean;
  ledger_id: string | null;
  summary: unknown;
  jobs: Record<string, number>;
  instances: InstanceView[];
  recent: StoredEvent[];
}

export function unitEvents(store: ControlStore, unit: string): StoredEvent[] {
  const out: StoredEvent[] = [];
  let after = 0;
  for (;;) {
    const page = store.events(unit, after, 5000) as StoredEvent[];
    out.push(...page);
    if (page.length < 5000) return out;
    after = (page.at(-1) as StoredEvent).seq;
  }
}

/** Builds a unit's view from its events (only the current ledger's, after a reset). */
export function unitView(
  store: ControlStore,
  unit: string,
  opts: { staleAfterMs: number; now?: number } = { staleAfterMs: 180_000 },
): UnitView | undefined {
  const u = store.units().find((x) => x.id === unit);
  if (!u) return undefined;
  const all = unitEvents(store, unit);
  const events = u.ledger_id ? all.filter((e) => e.ledger_id === u.ledger_id) : all;
  const instances = new Map<string, InstanceView>();
  const attempts = new Map<string, AttemptView>();
  const inst = (id: string): InstanceView => {
    let v = instances.get(id);
    if (!v) {
      v = {
        id,
        campaign: null,
        mode: null,
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
      };
      instances.set(id, v);
    }
    return v;
  };
  const confirmDelta = new Map<string, number>();
  for (const e of events) {
    const b = e.body ?? {};
    switch (e.kind) {
      case "instance_created": {
        const v = inst(String(e.subject));
        v.campaign = String(b.campaign ?? "");
        v.mode = String(b.mode ?? "");
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
      case "instance_status": {
        const v = inst(String(e.subject));
        v.status = String(b.status);
        v.pause_reason = (b.reason as string | null) ?? null;
        break;
      }
      case "attempt_recorded": {
        const a: AttemptView = {
          id: String(e.subject),
          instance: String(b.instance),
          lane: (b.lane as string | null) ?? null,
          lifecycle: String(b.lifecycle),
          verdict: null,
          delta: null,
          hypothesis: (b.hypothesis as string | null) ?? null,
          recorded_at: e.at,
          updated_at: e.at,
        };
        attempts.set(a.id, a);
        inst(a.instance).attempts.push(a);
        break;
      }
      case "attempt_lifecycle": {
        const a = attempts.get(String(e.subject));
        if (a) {
          a.lifecycle = String(b.lifecycle);
          a.updated_at = e.at;
        }
        break;
      }
      case "verdict": {
        const a = attempts.get(String(e.subject));
        if (a) {
          a.verdict = String(b.verdict);
          a.delta = typeof b.delta === "number" ? b.delta : null;
          a.updated_at = e.at;
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
        const v = inst(String(b.instance));
        if (!v.pending_promotions.includes(String(e.subject))) {
          v.pending_promotions.push(String(e.subject));
        }
        break;
      }
      case "calibration": {
        const v = inst(String(e.subject));
        v.calibration = { at: e.at, sigma: Number(b.sigma), summary: String(b.summary ?? "") };
        break;
      }
      case "epoch_started": {
        const a = inst(String(e.subject)).agents;
        a.epochs++;
        if (b.planner_valid === true) a.planner_valid++;
        if (b.source === "fallback") a.fallbacks++;
        if (Number(b.raw_violations ?? 0) > 0) a.epochs_with_violations++;
        break;
      }
      case "trial_finished": {
        const a = inst(String(e.subject)).agents;
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
        v.goals = ((b.goals as { goal: string; status: string; reasons: string }[]) ?? []).map(
          (g) => ({ goal: g.goal, status: g.status, reasons: g.reasons }),
        );
        break;
      }
    }
  }
  for (const v of instances.values()) {
    v.verdicts = {};
    for (const a of v.attempts) {
      const k = a.verdict ?? a.lifecycle;
      v.verdicts[k] = (v.verdicts[k] ?? 0) + 1;
    }
    v.agents.attempts = v.attempts.length;
    v.agents.duplicates = v.attempts.filter((a) => a.lifecycle === "duplicate").length;
  }
  const summary = u.summary as { jobs?: Record<string, number> } | undefined;
  const now = opts.now ?? Date.now();
  return {
    id: u.id,
    last_seen: u.last_seen,
    stale: now - Date.parse(u.last_seen) > opts.staleAfterMs,
    ledger_id: u.ledger_id,
    summary: u.summary,
    jobs: summary?.jobs ?? {},
    instances: [...instances.values()],
    recent: events.slice(-50).reverse(),
  };
}
