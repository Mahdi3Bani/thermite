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

  addFamily(instance: string, id: string, description: string, by: string): void {
    this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare(
          "insert or ignore into family (instance, id, description, created_by, created_at) values (?, ?, ?, ?, ?)",
        )
        .run(instance, id, description.slice(0, 500), by, this.now());
      if (Number(r.changes) > 0)
        this.ledger.appendEvent(by, "family_added", instance, { family: id, description });
    });
  }

  setFamilyStatus(
    instance: string,
    id: string,
    status: FamilyView["status"],
    by: string,
    reason: string,
  ): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare("update family set status = ? where instance = ? and id = ?")
        .run(status, instance, id);
      this.ledger.appendEvent(by, "family_status", instance, { family: id, status, reason });
    });
  }

  families(instance: string): FamilyView[] {
    return this.all(
      "select id, description, status from family where instance = ? order by created_at",
      instance,
    ).map((f) => {
      const attempts = this.all(
        "select id from attempt where instance = ? and family = ?",
        instance,
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
  evidence(instance: string, limit = 30, lane?: string): Evidence[] {
    const rows = lane
      ? this.all(
          "select id, lane, family, hypothesis, lifecycle from attempt where instance = ? and lane = ? order by created_at desc limit ?",
          instance,
          lane,
          limit,
        )
      : this.all(
          "select id, lane, family, hypothesis, lifecycle from attempt where instance = ? order by created_at desc limit ?",
          instance,
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

  currentEpoch(instance: string): EpochRecord | undefined {
    const r = this.get("select * from epoch where instance = ? order by n desc limit 1", instance);
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
    instance: string;
    n: number;
    source: "planner" | "fallback";
    tries: number;
    valid: boolean;
    rawViolations: string[];
    assignments: Assignment[];
    directives?: number[] | undefined;
    notes?: string | undefined;
    by: string;
  }): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          `insert into epoch (instance, n, source, planner_tries, planner_valid, raw_violations, assignments, directives, notes, started_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.instance,
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
      this.ledger.appendEvent(input.by, "epoch_started", input.instance, {
        n: input.n,
        source: input.source,
        planner_tries: input.tries,
        planner_valid: input.valid,
        raw_violations: input.rawViolations.length,
        directives: input.directives ?? [],
        assignments: input.assignments.map((a) => ({
          lane: a.lane,
          family: a.family,
          parent: a.parent,
          ...(a.directive === undefined ? {} : { directive: a.directive }),
        })),
      });
    });
  }

  endEpoch(instance: string, n: number, by: string): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare("update epoch set ended_at = ? where instance = ? and n = ? and ended_at is null")
        .run(this.now(), instance, n);
      this.ledger.appendEvent(by, "epoch_ended", instance, { n });
    });
  }

  /**
   * Starts a trial with its own token (only its hash is stored). The worker presents the token
   * to the API; the harness binds every call to this trial's instance and lane, and the token
   * stops working when the trial ends.
   */
  startTrial(t: {
    id: string;
    instance: string;
    lane: string;
    epoch: number;
    family: string;
    parent: string;
    token?: string | undefined;
  }): void {
    this.ledger.db
      .prepare(
        "insert into trial (id, instance, lane, epoch, family, parent_commit, token_sha, started_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        t.id,
        t.instance,
        t.lane,
        t.epoch,
        t.family,
        t.parent,
        t.token ? sha256Hex(t.token) : null,
        this.now(),
      );
  }

  /** The open trial a token belongs to; throws when the token is unknown or the trial ended. */
  openTrial(token: string): {
    id: string;
    instance: string;
    lane: string;
    family: string | null;
    parent: string;
    attempt: string | null;
  } {
    const r = token
      ? this.get(
          "select id, instance, lane, family, parent_commit, attempt, ended_at from trial where token_sha = ?",
          sha256Hex(token),
        )
      : undefined;
    if (!r) throw new LedgerError("not_found", "unknown trial");
    if (r.ended_at !== null) throw new LedgerError("stale", `trial ${String(r.id)} has ended`);
    return {
      id: String(r.id),
      instance: String(r.instance),
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
    instance: string,
    lane: string | null,
    n: number,
  ): { stopped: string; attempt: string | null; ended_at: string; error: string | null }[] {
    const rows = lane
      ? this.all(
          "select stopped, attempt, ended_at, error from trial where instance = ? and lane = ? and ended_at is not null order by ended_at desc limit ?",
          instance,
          lane,
          n,
        )
      : this.all(
          "select stopped, attempt, ended_at, error from trial where instance = ? and ended_at is not null order by ended_at desc limit ?",
          instance,
          n,
        );
    return rows.map((r) => ({
      stopped: String(r.stopped),
      attempt: r.attempt === null ? null : String(r.attempt),
      ended_at: String(r.ended_at),
      error: r.error === null ? null : String(r.error),
    }));
  }

  /** Tokens the instance's agents have used (trials; the planner's calls are not counted yet). */
  tokensUsed(instance: string): { in: number; out: number } {
    const r = this.get(
      "select coalesce(sum(tokens_in), 0) as i, coalesce(sum(tokens_out), 0) as o from trial where instance = ?",
      instance,
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
      const t = this.get(
        "select instance, lane, epoch, family, attempt from trial where id = ?",
        id,
      );
      this.ledger.appendEvent(by, "trial_finished", String(t?.instance ?? ""), {
        trial: id,
        lane: t?.lane ?? null,
        epoch: t?.epoch ?? null,
        family: t?.family ?? null,
        attempt: t?.attempt ?? null,
        stopped: r.stopped,
        turns: r.turns,
        tokens_in: r.tokensIn,
        tokens_out: r.tokensOut,
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
    instance: string,
    lane: string,
    epoch: number,
  ): { id: string; attempt: string | null; ended: boolean }[] {
    return this.all(
      "select id, attempt, ended_at from trial where instance = ? and lane = ? and epoch = ? order by started_at",
      instance,
      lane,
      epoch,
    ).map((r) => ({
      id: String(r.id),
      attempt: r.attempt === null ? null : String(r.attempt),
      ended: r.ended_at !== null,
    }));
  }

  laneBest(instance: string, lane: string): string | null {
    const r = this.get("select lane_best_attempt from lane where id = ?", `${instance}:${lane}`);
    return r?.lane_best_attempt ? String(r.lane_best_attempt) : null;
  }

  clearLaneBest(instance: string, lane: string, by: string, reason: string): void {
    this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare(
          "update lane set lane_best_attempt = null where id = ? and lane_best_attempt is not null",
        )
        .run(`${instance}:${lane}`);
      if (Number(r.changes) > 0)
        this.ledger.appendEvent(by, "lane_best", instance, { lane, attempt: null, reason });
    });
  }

  setLaneBest(instance: string, lane: string, attempt: string, by: string): void {
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          `insert into lane (id, instance, lane_best_attempt, created_at) values (?, ?, ?, ?)
           on conflict (id) do update set lane_best_attempt = excluded.lane_best_attempt`,
        )
        .run(`${instance}:${lane}`, instance, attempt, this.now());
      this.ledger.appendEvent(by, "lane_best", instance, { lane, attempt });
    });
  }

  /** Duplicate rate: attempts recorded as duplicates over all recorded attempts. */
  duplicateRate(instance: string): { duplicates: number; attempts: number } {
    const r = this.get(
      "select sum(lifecycle = 'duplicate') as d, count(*) as n from attempt where instance = ?",
      instance,
    );
    return { duplicates: Number(r?.d ?? 0), attempts: Number(r?.n ?? 0) };
  }
}
