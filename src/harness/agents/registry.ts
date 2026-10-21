import { canonicalJson, sha256Hex } from "../../core/canonical.ts";
import { type Ledger, LedgerError } from "../ledger.ts";

/**
 * Agent state in the ledger: the direction registry (approach families and how they fared),
 * planner epochs, worker trials and each lane's retained best. The judge never reads any of it;
 * verdicts stay the judge's alone.
 */

type Row = Record<string, unknown>;

export interface FamilyView {
  id: string;
  description: string;
  status: "live" | "blocked" | "exhausted";
  attempts: number;
  verdicts: Record<string, number>;
  best_delta: number | null;
}

export interface Assignment {
  lane: string;
  family: string;
  focus: string;
  parent: "champion" | "lane_best";
  /** The MANDATE or TRY directive this assignment follows, when it follows one. */
  directive?: number | undefined;
  /** The experiment from the run's queue the lane's next trial takes, and why it got it. */
  experiment?: string | undefined;
  why?: string | undefined;
}

export interface EpochRecord {
  n: number;
  source: "planner" | "fallback";
  assignments: Assignment[];
  /** Directive ids in force when the epoch was planned. */
  directives: number[];
  started_at: string;
  ended_at: string | null;
}

export interface Evidence {
  attempt: string;
  lane: string | null;
  family: string | null;
  hypothesis: string | null;
  lifecycle: string;
  verdict: string | null;
  delta: number | null;
}

export class Registry {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  private all(sql: string, ...p: (string | number | null)[]): Row[] {
    return this.ledger.db.prepare(sql).all(...p) as Row[];
  }

  private get(sql: string, ...p: (string | number | null)[]): Row | undefined {
    return this.ledger.db.prepare(sql).get(...p) as Row | undefined;
  }

  private now(): string {
    return new Date().toISOString();
  }

  /**
   * A new direction for the run. `forRules`: the rules in force that named it before the run had
   * it, when the planner designed it for them (goal 066); its event says so.
   */
  addFamily(run: string, id: string, description: string, by: string, forRules?: number[]): void {
    this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare(
          "insert or ignore into family (run, id, description, created_by, created_at) values (?, ?, ?, ?, ?)",
        )
        .run(run, id, description.slice(0, 500), by, this.now());
      if (Number(r.changes) > 0)
        this.ledger.appendEvent(by, "family_added", run, {
          family: id,
          description,
          ...(forRules?.length ? { for_rules: forRules } : {}),
        });
    });
  }

  setFamilyStatus(
    run: string,
    id: string,
    status: FamilyView["status"],
    by: string,
    reason: string,
  ): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare("update family set status = ? where run = ? and id = ?")
        .run(status, run, id);
      this.ledger.appendEvent(by, "family_status", run, { family: id, status, reason });
    });
  }

  families(run: string): FamilyView[] {
    return this.all(
      "select id, description, status from family where run = ? order by created_at",
      run,
    ).map((f) => {
      const attempts = this.all(
        "select id from attempt where run = ? and family = ?",
        run,
        String(f.id),
      ).map((a) => String(a.id));
      const verdicts: Record<string, number> = {};
      let best: number | null = null;
      for (const a of attempts) {
        const v = this.ledger.currentVerdict(a);
        const key = v?.verdict ?? String(this.ledger.getAttempt(a)?.lifecycle);
        verdicts[key] = (verdicts[key] ?? 0) + 1;
        const d = this.get("select delta from verdict where id = ?", v?.id ?? -1)?.delta;
        if (typeof d === "number" && (best === null || d > best)) best = d;
      }
      return {
        id: String(f.id),
        description: String(f.description),
        status: String(f.status) as FamilyView["status"],
        attempts: attempts.length,
        verdicts,
        best_delta: best,
      };
    });
  }

  tagAttempt(attempt: string, family: string): void {
    this.ledger.db.prepare("update attempt set family = ? where id = ?").run(family, attempt);
  }

  /** The newest judged evidence, for the planner and for briefs. */
  evidence(run: string, limit = 30, lane?: string): Evidence[] {
    const rows = lane
      ? this.all(
          "select id, lane, family, hypothesis, lifecycle from attempt where run = ? and lane = ? order by created_at desc limit ?",
          run,
          lane,
          limit,
        )
      : this.all(
          "select id, lane, family, hypothesis, lifecycle from attempt where run = ? order by created_at desc limit ?",
          run,
          limit,
        );
    return rows.map((r) => {
      const v = this.ledger.currentVerdict(String(r.id));
      const d = v ? this.get("select delta from verdict where id = ?", v.id)?.delta : null;
      return {
        attempt: String(r.id),
        lane: r.lane === null ? null : String(r.lane),
        family: r.family === null ? null : String(r.family),
        hypothesis: r.hypothesis === null ? null : String(r.hypothesis).slice(0, 300),
        lifecycle: String(r.lifecycle),
        verdict: v?.verdict ?? null,
        delta: typeof d === "number" ? d : null,
      };
    });
  }

  currentEpoch(run: string): EpochRecord | undefined {
    const r = this.get("select * from epoch where run = ? order by n desc limit 1", run);
    return r
      ? {
          n: Number(r.n),
          source: String(r.source) as EpochRecord["source"],
          assignments: JSON.parse(String(r.assignments)) as Assignment[],
          directives: JSON.parse(String(r.directives ?? "[]")) as number[],
          started_at: String(r.started_at),
          ended_at: r.ended_at === null ? null : String(r.ended_at),
        }
      : undefined;
  }

  startEpoch(input: {
    run: string;
    n: number;
    source: "planner" | "fallback";
    tries: number;
    valid: boolean;
    rawViolations: string[];
    assignments: Assignment[];
    directives?: number[] | undefined;
    notes?: string | undefined;
    /** "research": planned by the research plan's fixed method, not by a model (no refusal). */
    plan?: "research" | undefined;
    by: string;
  }): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          `insert into epoch (run, n, source, planner_tries, planner_valid, raw_violations, assignments, directives, notes, started_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.run,
          input.n,
          input.source,
          input.tries,
          input.valid ? 1 : 0,
          canonicalJson(input.rawViolations),
          canonicalJson(input.assignments),
          canonicalJson(input.directives ?? []),
          input.notes?.slice(0, 2000) ?? null,
          this.now(),
        );
      this.ledger.appendEvent(input.by, "epoch_started", input.run, {
        n: input.n,
        source: input.source,
        // A research run's rounds are planned by a fixed method on purpose: say so, so a reader
        // does not take its "fallback" source for a refused plan.
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.notes ? { notes: input.notes.slice(0, 500) } : {}),
        planner_tries: input.tries,
        planner_valid: input.valid,
        raw_violations: input.rawViolations.length,
        // Why the model's plans were refused (the first few, shortened), so a fallback says why.
        ...(input.rawViolations.length
          ? { refused: input.rawViolations.slice(0, 4).map((v) => v.slice(0, 300)) }
          : {}),
        directives: input.directives ?? [],
        assignments: input.assignments.map((a) => ({
          lane: a.lane,
          family: a.family,
          // What the lane is asked to do, for control's "at work now" (the brief has it all).
          focus: a.focus.slice(0, 300),
          parent: a.parent,
          ...(a.directive === undefined ? {} : { directive: a.directive }),
          ...(a.experiment ? { experiment: a.experiment } : {}),
        })),
      });
    });
  }

  endEpoch(run: string, n: number, by: string): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare("update epoch set ended_at = ? where run = ? and n = ? and ended_at is null")
        .run(this.now(), run, n);
      this.ledger.appendEvent(by, "epoch_ended", run, { n });
    });
  }

  /**
   * Starts a trial with its own token (only its hash is stored). The worker presents the token
   * to the API; the harness binds every call to this trial's run and lane, and the token
   * stops working when the trial ends.
   */
  startTrial(t: {
    id: string;
    run: string;
    lane: string;
    epoch: number;
    family: string;
    parent: string;
    token?: string | undefined;
    /** The lane's focus for this trial, as the planner gave it. */
    focus?: string | undefined;
  }): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          "insert into trial (id, run, lane, epoch, family, parent_commit, token_sha, started_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          t.id,
          t.run,
          t.lane,
          t.epoch,
          t.family,
          t.parent,
          t.token ? sha256Hex(t.token) : null,
          this.now(),
        );
      // Control learns that a lane is at work, and on what, from the record, not the live view.
      this.ledger.appendEvent("scheduler", "trial_started", t.run, {
        trial: t.id,
        lane: t.lane,
        epoch: t.epoch,
        family: t.family,
        ...(t.focus ? { focus: t.focus.slice(0, 300) } : {}),
      });
    });
  }

  /** The open trial a token belongs to; throws when the token is unknown or the trial ended. */
  openTrial(token: string): {
    id: string;
    run: string;
    lane: string;
    family: string | null;
    parent: string;
    attempt: string | null;
  } {
    const r = token
      ? this.get(
          "select id, run, lane, family, parent_commit, attempt, ended_at from trial where token_sha = ?",
          sha256Hex(token),
        )
      : undefined;
    if (!r) throw new LedgerError("not_found", "unknown trial");
    if (r.ended_at !== null) throw new LedgerError("stale", `trial ${String(r.id)} has ended`);
    return {
      id: String(r.id),
      run: String(r.run),
      lane: String(r.lane),
      family: r.family === null ? null : String(r.family),
      parent: String(r.parent_commit),
      attempt: r.attempt === null ? null : String(r.attempt),
    };
  }

  /** Links a submission to its trial as it is recorded (one per trial). */
  linkAttempt(trial: string, attempt: string): void {
    this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare("update trial set attempt = ? where id = ? and attempt is null")
        .run(attempt, trial);
      if (Number(r.changes) === 0)
        throw new LedgerError("conflict", `trial ${trial} already has an attempt`);
      const t = this.get("select family from trial where id = ?", trial);
      if (t?.family) this.tagAttempt(attempt, String(t.family));
    });
  }

  /** The lane's newest finished trials, newest first (for backoff). */
  recentTrials(
    run: string,
    lane: string | null,
    n: number,
  ): { stopped: string; attempt: string | null; ended_at: string; error: string | null }[] {
    const rows = lane
      ? this.all(
          "select stopped, attempt, ended_at, error from trial where run = ? and lane = ? and ended_at is not null order by ended_at desc limit ?",
          run,
          lane,
          n,
        )
      : this.all(
          "select stopped, attempt, ended_at, error from trial where run = ? and ended_at is not null order by ended_at desc limit ?",
          run,
          n,
        );
    return rows.map((r) => ({
      stopped: String(r.stopped),
      attempt: r.attempt === null ? null : String(r.attempt),
      ended_at: String(r.ended_at),
      error: r.error === null ? null : String(r.error),
    }));
  }

  /** Tokens the run's agents have used (trials; the planner's calls are not counted yet). */
  tokensUsed(run: string): { in: number; out: number } {
    const r = this.get(
      "select coalesce(sum(tokens_in), 0) as i, coalesce(sum(tokens_out), 0) as o from trial where run = ?",
      run,
    );
    return { in: Number(r?.i ?? 0), out: Number(r?.o ?? 0) };
  }

  finishTrial(
    id: string,
    r: {
      attempt?: string | undefined;
      stopped: string;
      turns: number;
      toolCalls: number;
      tokensIn: number;
      tokensOut: number;
      /** How many times its conversation was compacted (goal 070): in the event only. */
      compactions?: number | undefined;
      error?: string | undefined;
    },
    by: string,
  ): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          `update trial set attempt = coalesce(attempt, ?), stopped = ?, turns = ?, tool_calls = ?, tokens_in = ?,
             tokens_out = ?, error = ?, ended_at = ? where id = ?`,
        )
        .run(
          r.attempt ?? null,
          r.stopped,
          r.turns,
          r.toolCalls,
          r.tokensIn,
          r.tokensOut,
          r.error?.slice(0, 1000) ?? null,
          this.now(),
          id,
        );
      const t = this.get("select run, lane, epoch, family, attempt from trial where id = ?", id);
      this.ledger.appendEvent(by, "trial_finished", String(t?.run ?? ""), {
        trial: id,
        lane: t?.lane ?? null,
        epoch: t?.epoch ?? null,
        family: t?.family ?? null,
        attempt: t?.attempt ?? null,
        stopped: r.stopped,
        turns: r.turns,
        tokens_in: r.tokensIn,
        tokens_out: r.tokensOut,
        ...(r.compactions ? { compactions: r.compactions } : {}),
        // Why a trial failed reaches control too (the ledger keeps the longer text).
        error: r.error?.slice(0, 300) ?? null,
      });
    });
  }

  /**
   * Trials a dead controller left unfinished. Their worker processes died with it; the trials
   * are closed as interrupted (any submission they made stands), so their lanes can go on.
   */
  interruptUnfinished(by: string): string[] {
    const open = this.all("select id from trial where ended_at is null").map((r) => String(r.id));
    for (const id of open) {
      this.finishTrial(
        id,
        { stopped: "interrupted", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
        by,
      );
    }
    return open;
  }

  /** Trials of a lane in an epoch (finished or running). */
  trials(
    run: string,
    lane: string,
    epoch: number,
  ): { id: string; attempt: string | null; ended: boolean }[] {
    return this.all(
      "select id, attempt, ended_at from trial where run = ? and lane = ? and epoch = ? order by started_at",
      run,
      lane,
      epoch,
    ).map((r) => ({
      id: String(r.id),
      attempt: r.attempt === null ? null : String(r.attempt),
      ended: r.ended_at !== null,
    }));
  }

  laneBest(run: string, lane: string): string | null {
    const r = this.get("select lane_best_attempt from lane where id = ?", `${run}:${lane}`);
    return r?.lane_best_attempt ? String(r.lane_best_attempt) : null;
  }

  clearLaneBest(run: string, lane: string, by: string, reason: string): void {
    this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare(
          "update lane set lane_best_attempt = null where id = ? and lane_best_attempt is not null",
        )
        .run(`${run}:${lane}`);
      if (Number(r.changes) > 0)
        this.ledger.appendEvent(by, "lane_best", run, { lane, attempt: null, reason });
    });
  }

  setLaneBest(run: string, lane: string, attempt: string, by: string): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          `insert into lane (id, run, lane_best_attempt, created_at) values (?, ?, ?, ?)
           on conflict (id) do update set lane_best_attempt = excluded.lane_best_attempt`,
        )
        .run(`${run}:${lane}`, run, attempt, this.now());
      this.ledger.appendEvent(by, "lane_best", run, { lane, attempt });
    });
  }

  /** Duplicate rate: attempts recorded as duplicates over all recorded attempts. */
  duplicateRate(run: string): { duplicates: number; attempts: number } {
    const r = this.get(
      "select sum(lifecycle = 'duplicate') as d, count(*) as n from attempt where run = ?",
      run,
    );
    return { duplicates: Number(r?.d ?? 0), attempts: Number(r?.n ?? 0) };
  }
}
