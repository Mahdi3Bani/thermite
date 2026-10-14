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
  /** The project repository the instance works on (from its assignment). */
  seed_repo: string | null;
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
  /** Audits (M5): what is held for one, and how each ended. */
  audits: { attempt: string; reason: string; decision: string | null; at: string }[];
  /** Subjective-goal reviews: the panel's result, then the owner's. */
  reviews: {
    review: number;
    goal: string;
    commit: string;
    panel: string | null;
    owner: string | null;
  }[];
  /** "Not possible" proposals and the owner's decisions. */
  conclusions: { proposal: number; decision: string | null; approaches: number; at: string }[];
  /** The newest champion published for propagation (what another unit can import). */
  published: {
    seq: number;
    repo: string | null;
    base_commit: string;
    tree: string;
    sha256: string;
    path: string;
  } | null;
  /** Every champion tree this instance published, by seq (cross-verification checks it). */
  published_trees: Record<number, string>;
  /** Champions received from other units, and how this unit's judge decided them. */
  propagations: {
    attempt: string | null;
    source_unit: string;
    source_instance: string;
    source_seq: number;
    tree: string | null;
    result: string;
  }[];
  directives: number;
}

export interface UnitView {
  id: string;
  last_seen: string;
  stale: boolean;
  ledger_id: string | null;
  summary: unknown;
  /** The supervisor's own figures (git sync, advisors); reported by the supervisor, unsigned. */
  supervisor: Record<string, unknown> | null;
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
        seed_repo: null,
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
        audits: [],
        reviews: [],
        conclusions: [],
        published: null,
        published_trees: {},
        propagations: [],
        directives: 0,
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
        v.seed_repo =
          ((b.seed as { repo?: string } | undefined)?.repo as string | undefined) ?? null;
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
      case "audit_requested": {
        inst(String(b.instance)).audits.push({
          attempt: String(e.subject),
          reason: String(b.reason ?? ""),
          decision: null,
          at: e.at,
        });
        break;
      }
      case "audit_decided": {
        for (const v of instances.values()) {
          const a = v.audits.find((x) => x.attempt === e.subject);
          if (a) a.decision = String(b.decision);
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
        inst(String(e.subject)).conclusions.push({
          proposal: Number(b.proposal),
          decision: null,
          approaches: Array.isArray(b.approaches) ? b.approaches.length : 0,
          at: e.at,
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
          source_unit: String(b.source_unit),
          source_instance: String(b.source_instance),
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
    supervisor: store.supervisor(u.id),
    jobs: summary?.jobs ?? {},
    instances: [...instances.values()],
    recent: events.slice(-50).reverse(),
  };
}

export interface LeaderEntry {
  unit: string;
  instance: string;
  mode: string | null;
  status: string;
  champion_seq: number;
  /** Relative gain of the champion over the instance's seed, measured on its own unit. */
  gain: number;
  /** Units whose own judge accepted this exact champion (propagation): cross-verified. */
  verified_by: string[];
}

/**
 * The campaign leaderboard: each instance's champion and its gain over its baseline, measured
 * on its own unit (never absolute numbers across devices), marked cross-verified once another
 * unit's judge accepted it.
 */
export function leaderboard(
  store: ControlStore,
  opts: { staleAfterMs: number },
): Record<string, LeaderEntry[]> {
  const views = store
    .units()
    .map((u) => unitView(store, u.id, opts))
    .filter((v): v is UnitView => v !== undefined);
  // An acceptance counts only for the tree it accepted: the key includes the tree, which must be
  // the one the source unit itself published (signed) for that seq.
  const verified = new Map<string, Set<string>>();
  for (const v of views) {
    for (const i of v.instances) {
      for (const p of i.propagations) {
        if (p.result !== "accepted" || !p.tree) continue;
        const key = `${p.source_unit}/${p.source_instance}/${p.source_seq}/${p.tree}`;
        if (!verified.has(key)) verified.set(key, new Set());
        verified.get(key)?.add(v.id);
      }
    }
  }
  const out: Record<string, LeaderEntry[]> = {};
  for (const v of views) {
    for (const i of v.instances) {
      // Hill climbs: a gain over the baseline is what is compared.
      if (i.mode !== "hill_climb" || !i.campaign) continue;
      const champ = i.champion.filter((c) => !c.reopened).at(-1);
      const seq = champ?.seq ?? 1;
      const tree = i.published_trees[seq];
      if (!out[i.campaign]) out[i.campaign] = [];
      out[i.campaign]?.push({
        unit: v.id,
        instance: i.id,
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
