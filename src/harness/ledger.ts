import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson, sha256Hex } from "../core/canonical.ts";
import type { Contract } from "../core/contract.ts";
import { MIGRATIONS } from "./schema.ts";

/**
 * The harness ledger: the authoritative research record for one unit.
 *
 * One process (the controller) owns the database and is its only writer. Every state change
 * also appends an event, so the supervisor can stream changes with a cursor.
 */

export class LedgerError extends Error {
  readonly code: "conflict" | "not_found" | "invalid" | "stale";

  constructor(code: LedgerError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface LedgerEvent {
  id: number;
  at: string;
  actor: string;
  kind: string;
  subject: string | null;
  body: unknown;
}

export interface InstanceRow {
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
  instance: string;
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
}

export type PromoteResult = { ok: true; seq: number } | { ok: false; currentSeq: number };

/** Verdicts that may move a champion. */
export const PROMOTABLE_VERDICTS: readonly string[] = [
  "win_confirmed",
  "neutral_simplify",
  // Goal mode: meets more goals than the champion and loses none.
  "goal_progress",
];

export interface InvalidationResult {
  attempts: string[];
  verdictsSuperseded: number[];
  championsReopened: { instance: string; seq: number }[];
}

/** After this many lease expiries a job is blocked instead of re-queued (poison-pill guard). */
export const MAX_LEASE_EXPIRIES = 3;

type Row = Record<string, SQLInputValue>;

export class Ledger {
  readonly db: DatabaseSync;
  private readonly clock: () => Date;
  private depth = 0;

  private constructor(db: DatabaseSync, clock: () => Date) {
    this.db = db;
    this.clock = clock;
  }

  static open(path: string, clock: () => Date = () => new Date()): Ledger {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    const ledger = new Ledger(db, clock);
    ledger.migrate();
    // A new ledger gets a fresh id, so readers can tell a reset ledger from the old one.
    db.prepare("insert or ignore into meta (key, value) values ('ledger_id', ?)").run(randomUUID());
    return ledger;
  }

  close(): void {
    this.db.close();
  }

  /** Random id created with the ledger. Event ids are only unique within one ledger id. */
  ledgerId(): string {
    return String(this.get<Row>("select value from meta where key = 'ledger_id'")?.value);
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private migrate(): void {
    this.db.exec("create table if not exists schema_migrations (version integer primary key)");
    const row = this.db.prepare("select max(version) as v from schema_migrations").get() as
      | { v: number | null }
      | undefined;
    const current = row?.v ?? 0;
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (version <= current) return;
      this.tx(() => {
        this.db.exec(sql);
        this.db.prepare("insert into schema_migrations (version) values (?)").run(version);
      });
    });
  }

  /** Runs fn in an immediate transaction. Nested calls become savepoints of the outer one. */
  tx<T>(fn: () => T): T {
    const savepoint = this.depth > 0 ? `sp${this.depth}` : undefined;
    this.db.exec(savepoint ? `savepoint ${savepoint}` : "begin immediate");
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec(savepoint ? `release ${savepoint}` : "commit");
      return out;
    } catch (err) {
      this.depth--;
      this.db.exec(savepoint ? `rollback to ${savepoint}; release ${savepoint}` : "rollback");
      throw err;
    }
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  // ---------------------------------------------------------------- events

  appendEvent(actor: string, kind: string, subject: string | null, body: unknown): number {
    return this.run(
      "insert into event (at, actor, kind, subject, body) values (?, ?, ?, ?, ?)",
      this.now(),
      actor,
      kind,
      subject,
      canonicalJson(body ?? {}),
    ).id;
  }

  /** The body of the newest event of a kind about a subject, if any. */
  latestEventBody(kind: string, subject: string): Record<string, unknown> | undefined {
    const r = this.get<Row>(
      "select body from event where kind = ? and subject = ? order by id desc limit 1",
      kind,
      subject,
    );
    return r ? (JSON.parse(String(r.body)) as Record<string, unknown>) : undefined;
  }

  /** Events strictly after the cursor, in order. The next cursor is the last id returned. */
  eventsAfter(cursor: number, limit = 500): { events: LedgerEvent[]; next: number } {
    const rows = this.all<Row>(
      "select id, at, actor, kind, subject, body from event where id > ? order by id limit ?",
      cursor,
      limit,
    );
    const events = rows.map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor: String(r.actor),
      kind: String(r.kind),
      subject: r.subject === null ? null : String(r.subject),
      body: JSON.parse(String(r.body)),
    }));
    return { events, next: events.length ? (events[events.length - 1] as LedgerEvent).id : cursor };
  }

  latestEventId(): number {
    return Number(this.get<Row>("select coalesce(max(id), 0) as id from event")?.id ?? 0);
  }

  // ---------------------------------------------------------------- contracts and instances

  /**
   * Stores a contract version. Re-storing the same content is a no-op. A different content for an
   * existing version is a conflict, and a new version must be greater than every stored version.
   */
  storeContract(contract: Contract, sha: string, actor: string): "created" | "exists" {
    return this.tx(() => {
      const same = this.get<Row>(
        "select sha from contract where campaign = ? and version = ?",
        contract.campaign,
        contract.version,
      );
      if (same) {
        if (same.sha === sha) return "exists";
        throw new LedgerError(
          "conflict",
          `contract ${contract.campaign} v${contract.version} already exists with different content; bump the version`,
        );
      }
      const latest = this.get<Row>(
        "select max(version) as v from contract where campaign = ?",
        contract.campaign,
      );
      const latestVersion = latest?.v === null || latest?.v === undefined ? 0 : Number(latest.v);
      if (contract.version <= latestVersion) {
        throw new LedgerError(
          "conflict",
          `contract ${contract.campaign} v${contract.version} is not newer than v${latestVersion}`,
        );
      }
      this.run(
        "insert into contract (campaign, version, sha, mode, body, created_at) values (?, ?, ?, ?, ?, ?)",
        contract.campaign,
        contract.version,
        sha,
        contract.mode,
        canonicalJson(contract),
        this.now(),
      );
      this.appendEvent(actor, "contract_stored", contract.campaign, {
        version: contract.version,
        sha,
        mode: contract.mode,
      });
      return "created";
    });
  }

  contractVersions(campaign: string): { version: number; sha: string; mode: string }[] {
    return this.all<Row>(
      "select version, sha, mode from contract where campaign = ? order by version",
      campaign,
    ).map((r) => ({ version: Number(r.version), sha: String(r.sha), mode: String(r.mode) }));
  }

  getContract(campaign: string, version: number): Contract | undefined {
    const r = this.get<Row>(
      "select body from contract where campaign = ? and version = ?",
      campaign,
      version,
    );
    return r ? (JSON.parse(String(r.body)) as Contract) : undefined;
  }

  /**
   * Creates a campaign instance from a stored contract. The seed commit becomes champion seq 1
   * (the baseline). Goal-mode instances also get their goal tree.
   */
  createInstance(input: {
    id: string;
    contract: Contract;
    contractSha: string;
    seedRepo: string;
    seedCommit: string;
    direction?: string | undefined;
    actor: string;
  }): void {
    this.tx(() => {
      if (this.get<Row>("select id from instance where id = ?", input.id)) {
        throw new LedgerError("conflict", `instance ${input.id} already exists`);
      }
      const stored = this.get<Row>(
        "select sha from contract where campaign = ? and version = ?",
        input.contract.campaign,
        input.contract.version,
      );
      if (!stored || stored.sha !== input.contractSha) {
        throw new LedgerError("invalid", "instance must reference a stored contract version");
      }
      const at = this.now();
      this.run(
        `insert into instance (id, campaign, version, contract_sha, mode, seed_repo, seed_commit,
           direction, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        input.id,
        input.contract.campaign,
        input.contract.version,
        input.contractSha,
        input.contract.mode,
        input.seedRepo,
        input.seedCommit,
        input.direction ?? null,
        at,
        at,
      );
      this.run(
        "insert into champion (instance, seq, attempt, commit_sha, promoted_by, promoted_at) values (?, 1, null, ?, ?, ?)",
        input.id,
        input.seedCommit,
        `${input.actor}:seed`,
        at,
      );
      if (input.contract.mode === "goal") {
        for (const g of input.contract.goals) {
          this.run(
            "insert into goal (instance, id, parent, priority, required, verify) values (?, ?, ?, ?, ?, ?)",
            input.id,
            g.id,
            g.parent ?? null,
            g.priority,
            g.required ? 1 : 0,
            canonicalJson(g.verify),
          );
        }
      }
      this.appendEvent(input.actor, "instance_created", input.id, {
        campaign: input.contract.campaign,
        version: input.contract.version,
        mode: input.contract.mode,
        seed: { repo: input.seedRepo, commit: input.seedCommit },
        direction: input.direction ?? null,
      });
    });
  }

  getInstance(id: string): InstanceRow | undefined {
    const r = this.get<Row>("select * from instance where id = ?", id);
    return r ? toInstance(r) : undefined;
  }

  listInstances(): InstanceRow[] {
    return this.all<Row>("select * from instance order by created_at").map(toInstance);
  }

  setInstanceStatus(
    id: string,
    status: InstanceRow["status"],
    reason: string | null,
    actor: string,
  ): void {
    this.tx(() => {
      const r = this.run(
        "update instance set status = ?, pause_reason = ?, updated_at = ? where id = ?",
        status,
        reason,
        this.now(),
        id,
      );
      if (r.changes === 0) throw new LedgerError("not_found", `no instance ${id}`);
      this.appendEvent(actor, "instance_status", id, { status, reason });
    });
  }

  // ---------------------------------------------------------------- champions

  /**
   * The effective champion: the newest one not reopened by invalidation. The seed (seq 1) has
   * no attempt and is never reopened, so there always is one.
   */
  currentChampion(instance: string): { seq: number; commit_sha: string; attempt: string | null } {
    const r = this.get<Row>(
      "select seq, commit_sha, attempt from champion where instance = ? and reopened = 0 order by seq desc limit 1",
      instance,
    );
    if (!r) throw new LedgerError("not_found", `no champion for ${instance}`);
    return {
      seq: Number(r.seq),
      commit_sha: String(r.commit_sha),
      attempt: r.attempt === null ? null : String(r.attempt),
    };
  }

  /**
   * Compare-and-swap promotion: succeeds only if the effective champion's seq equals expectedSeq,
   * the seq the judge measured against. A lost race returns the current seq so the caller can
   * re-evaluate. The attempt itself must be promotable, or a LedgerError is thrown.
   */
  promote(input: {
    instance: string;
    expectedSeq: number;
    attempt: string;
    commitSha: string;
    by: string;
  }): PromoteResult {
    return this.tx(() => {
      const a = this.getAttempt(input.attempt);
      if (!a || String(a.instance) !== input.instance) {
        throw new LedgerError("invalid", `attempt ${input.attempt} is not in ${input.instance}`);
      }
      if (String(a.commit_sha) !== input.commitSha) {
        throw new LedgerError(
          "invalid",
          `commit ${input.commitSha} is not attempt ${input.attempt}'s`,
        );
      }
      if (a.invalidated_by !== null) {
        throw new LedgerError("invalid", `attempt ${input.attempt} is invalidated`);
      }
      const verdict = this.currentVerdict(input.attempt)?.verdict;
      if (!verdict || !PROMOTABLE_VERDICTS.includes(verdict)) {
        throw new LedgerError(
          "invalid",
          `attempt ${input.attempt} has verdict ${verdict ?? "none"}`,
        );
      }
      if ((JSON.parse(String(a.known_flaws)) as unknown[]).length > 0 && !a.flaws_cleared_by) {
        throw new LedgerError("invalid", `attempt ${input.attempt} has open known flaws`);
      }
      const current = this.currentChampion(input.instance).seq;
      if (current !== input.expectedSeq) return { ok: false, currentSeq: current };
      const top = this.get<Row>(
        "select max(seq) as m from champion where instance = ?",
        input.instance,
      );
      const seq = Number(top?.m) + 1;
      this.run(
        "insert into champion (instance, seq, attempt, commit_sha, promoted_by, promoted_at) values (?, ?, ?, ?, ?, ?)",
        input.instance,
        seq,
        input.attempt,
        input.commitSha,
        input.by,
        this.now(),
      );
      this.appendEvent(input.by, "champion_promoted", input.instance, {
        seq,
        attempt: input.attempt,
        commit: input.commitSha,
      });
      return { ok: true, seq };
    });
  }

  // ---------------------------------------------------------------- attempts

  recordAttempt(a: AttemptInput, actor: string): void {
    this.tx(() => {
      const at = this.now();
      this.run(
        `insert into attempt (id, instance, lane, origin, parent_ref, parent_commit, parent_attempt,
           baseline_champion_seq, commit_sha, ref, diff_sha, normalized_diff_sha, lifecycle, hypothesis,
           claim, known_flaws, v0, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.instance,
        a.lane ?? null,
        a.origin ?? "local",
        a.parentRef,
        a.parentCommit,
        a.parentAttempt ?? null,
        a.baselineChampionSeq,
        a.commitSha,
        a.ref,
        a.diffSha,
        a.normalizedDiffSha,
        a.lifecycle,
        a.hypothesis ?? null,
        a.claim ?? null,
        canonicalJson(a.knownFlaws ?? []),
        a.v0 === undefined ? null : canonicalJson(a.v0),
        at,
        at,
      );
      this.appendEvent(actor, "attempt_recorded", a.id, {
        instance: a.instance,
        lane: a.lane ?? null,
        lifecycle: a.lifecycle,
        commit: a.commitSha,
        parent: a.parentCommit,
        hypothesis: a.hypothesis?.slice(0, 500) ?? null,
        known_flaws: a.knownFlaws ?? [],
      });
    });
  }

  getAttempt(id: string): Row | undefined {
    return this.get<Row>("select * from attempt where id = ?", id);
  }

  /**
   * An earlier attempt in the same instance with an identical normalized change, if any.
   * Attempts lost to infrastructure (errored, crash_infra) or invalidated do not count, so the
   * same change can be measured again.
   */
  findDuplicate(instance: string, normalizedDiffSha: string): string | undefined {
    const rows = this.all<Row>(
      `select id from attempt where instance = ? and normalized_diff_sha = ? and lifecycle != 'errored'
         and invalidated_by is null order by created_at`,
      instance,
      normalizedDiffSha,
    );
    for (const r of rows) {
      const v = this.currentVerdict(String(r.id))?.verdict;
      if (v !== "crash_infra" && v !== "invalidated") return String(r.id);
    }
    return undefined;
  }

  /** The newest attempt in an instance whose commit is `commit`, if any (for lineage). */
  attemptByCommit(instance: string, commit: string): string | undefined {
    const r = this.get<Row>(
      "select id from attempt where instance = ? and commit_sha = ? order by created_at desc limit 1",
      instance,
      commit,
    );
    return r ? String(r.id) : undefined;
  }

  setAttemptLifecycle(id: string, lifecycle: string, actor: string): void {
    this.tx(() => {
      const r = this.run(
        "update attempt set lifecycle = ?, updated_at = ? where id = ?",
        lifecycle,
        this.now(),
        id,
      );
      if (r.changes === 0) throw new LedgerError("not_found", `no attempt ${id}`);
      this.appendEvent(actor, "attempt_lifecycle", id, { lifecycle });
    });
  }

  // ---------------------------------------------------------------- jobs and leases

  enqueueJob(input: {
    attempt?: string | undefined;
    kind: string;
    priority?: number | undefined;
    spec?: unknown;
    actor: string;
  }): number {
    return this.tx(() => {
      const at = this.now();
      const id = this.run(
        "insert into job (attempt, kind, state, priority, spec, created_at, updated_at) values (?, ?, 'queued', ?, ?, ?, ?)",
        input.attempt ?? null,
        input.kind,
        input.priority ?? 100,
        canonicalJson(input.spec ?? {}),
        at,
        at,
      ).id;
      this.appendEvent(input.actor, "job_queued", String(id), {
        attempt: input.attempt ?? null,
        kind: input.kind,
      });
      return id;
    });
  }

  /**
   * Leases the next queued job (lowest priority number first). The fence increments on every
   * lease, so a holder whose lease expired can no longer write results.
   */
  leaseJob(owner: string, ttlMs: number, kinds?: readonly string[]): JobRow | undefined {
    return this.tx(() => {
      const filter = kinds?.length ? `and kind in (${kinds.map(() => "?").join(",")})` : "";
      const r = this.get<Row>(
        `select id from job where state = 'queued' ${filter} order by priority, id limit 1`,
        ...(kinds ?? []),
      );
      if (!r) return undefined;
      const until = new Date(this.clock().getTime() + ttlMs).toISOString();
      this.run(
        "update job set state = 'leased', lease_owner = ?, lease_until = ?, fence = fence + 1, updated_at = ?, leased_at = ? where id = ?",
        owner,
        until,
        this.now(),
        this.now(),
        Number(r.id),
      );
      const job = this.jobById(Number(r.id)) as JobRow;
      this.appendEvent(owner, "job_leased", String(job.id), { fence: job.fence, until });
      return job;
    });
  }

  /**
   * Device time an instance's judging has used, in hours: from each finished job's last lease to
   * its completion (jobs for its attempts, and its validation and calibration jobs).
   */
  deviceHours(instance: string): number {
    const r = this.get<Row>(
      `select sum((julianday(j.updated_at) - julianday(j.leased_at)) * 24) as h from job j
       left join attempt a on a.id = j.attempt
       where j.state in ('done', 'failed') and j.leased_at is not null
         and (a.instance = ? or json_extract(j.spec, '$.instance') = ?)`,
      instance,
      instance,
    );
    return Number(r?.h ?? 0);
  }

  jobById(id: number): JobRow | undefined {
    const r = this.get<Row>("select * from job where id = ?", id);
    return r ? toJob(r) : undefined;
  }

  private assertFence(jobId: number, fence: number): JobRow {
    const job = this.jobById(jobId);
    if (!job) throw new LedgerError("not_found", `no job ${jobId}`);
    if (job.state !== "leased" || job.fence !== fence) {
      throw new LedgerError("stale", `job ${jobId} lease lost (fence ${fence}, now ${job.fence})`);
    }
    return job;
  }

  /** Throws unless the caller still holds the job's lease with this fence. */
  assertLease(jobId: number, fence: number): void {
    this.assertFence(jobId, fence);
  }

  heartbeat(jobId: number, fence: number, ttlMs: number): void {
    this.tx(() => {
      this.assertFence(jobId, fence);
      const until = new Date(this.clock().getTime() + ttlMs).toISOString();
      this.run(
        "update job set lease_until = ?, updated_at = ? where id = ?",
        until,
        this.now(),
        jobId,
      );
    });
  }

  completeJob(jobId: number, fence: number, state: "done" | "failed", result: unknown): void {
    this.tx(() => {
      const job = this.assertFence(jobId, fence);
      this.run(
        "update job set state = ?, result = ?, lease_owner = null, lease_until = null, updated_at = ? where id = ?",
        state,
        canonicalJson(result ?? {}),
        this.now(),
        jobId,
      );
      this.appendEvent(job.lease_owner ?? "executor", "job_finished", String(jobId), {
        state,
        result: result ?? {},
      });
    });
  }

  /** Re-queues jobs whose lease ran out, or blocks them after MAX_LEASE_EXPIRIES. */
  expireLeases(actor = "controller"): number[] {
    return this.tx(() => {
      const rows = this.all<Row>(
        "select id, expiries, fence from job where state = 'leased' and lease_until < ?",
        this.now(),
      );
      for (const r of rows) this.requeue(r, actor, "job_lease_expired");
      return rows.map((r) => Number(r.id));
    });
  }

  /**
   * Startup reconciliation: jobs still leased by `owner` belonged to a process that died, so
   * they are re-queued now (not after their lease runs out), each recorded once as crash_infra.
   */
  reclaimLeases(owner: string, actor = "controller"): number[] {
    return this.tx(() => {
      const rows = this.all<Row>(
        "select id, expiries, fence from job where state = 'leased' and lease_owner = ?",
        owner,
      );
      for (const r of rows) this.requeue(r, actor, "crash_infra");
      return rows.map((r) => Number(r.id));
    });
  }

  private requeue(r: Row, actor: string, kind: string): void {
    const expiries = Number(r.expiries) + 1;
    const state = expiries >= MAX_LEASE_EXPIRIES ? "blocked" : "queued";
    this.run(
      "update job set state = ?, expiries = ?, lease_owner = null, lease_until = null, updated_at = ? where id = ?",
      state,
      expiries,
      this.now(),
      Number(r.id),
    );
    this.appendEvent(actor, kind, String(r.id), { fence: Number(r.fence), expiries, state });
  }

  // ---------------------------------------------------------------- measurements, receipts, verdicts

  recordMeasurement(
    jobId: number,
    fence: number,
    m: {
      metric: string;
      cell: string;
      rep: number;
      value: number;
      unit: string;
      arm?: string | undefined;
    },
  ): void {
    if (!Number.isFinite(m.value)) {
      throw new LedgerError("invalid", `non-finite value for ${m.metric}: never a score`);
    }
    this.tx(() => {
      this.assertFence(jobId, fence);
      this.run(
        "insert into measurement (job, fence, arm, metric, cell, rep, value, unit, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        jobId,
        fence,
        m.arm ?? "candidate",
        m.metric,
        m.cell,
        m.rep,
        m.value,
        m.unit,
        this.now(),
      );
    });
  }

  /** Measurements from the job's latest lease only; rows from a dead earlier lease never mix in. */
  measurementsFor(
    jobId: number,
  ): { arm: string; metric: string; cell: string; rep: number; value: number; unit: string }[] {
    return this.all<Row>(
      `select arm, metric, cell, rep, value, unit from measurement
         where job = ? and fence = (select fence from job where id = ?) order by id`,
      jobId,
      jobId,
    ).map((r) => ({
      arm: String(r.arm),
      metric: String(r.metric),
      cell: String(r.cell),
      rep: Number(r.rep),
      value: Number(r.value),
      unit: String(r.unit),
    }));
  }

  /** Held-out results: for promotion code only, never in events, snapshots or exports. */
  recordHeldOut(
    jobId: number,
    fence: number,
    attempt: string,
    pass: boolean,
    detail: unknown,
  ): void {
    this.tx(() => {
      this.assertFence(jobId, fence);
      this.run(
        "insert into held_out (job, fence, attempt, pass, detail, created_at) values (?, ?, ?, ?, ?, ?)",
        jobId,
        fence,
        attempt,
        pass ? 1 : 0,
        canonicalJson(detail ?? {}),
        this.now(),
      );
    });
  }

  heldOutPassed(jobId: number): boolean | undefined {
    const rows = this.all<Row>(
      "select pass from held_out where job = ? and fence = (select fence from job where id = ?)",
      jobId,
      jobId,
    );
    return rows.length ? rows.every((r) => Number(r.pass) === 1) : undefined;
  }

  recordBuild(b: {
    key: string;
    repo: string;
    commit: string;
    kitCommit: string;
    ok: boolean;
    manifest: unknown;
    actor: string;
  }): void {
    this.tx(() => {
      this.run(
        `insert into build (key, repo, commit_sha, kit_commit, ok, manifest, created_at) values (?, ?, ?, ?, ?, ?, ?)
           on conflict (key) do update set ok = excluded.ok, manifest = excluded.manifest`,
        b.key,
        b.repo,
        b.commit,
        b.kitCommit,
        b.ok ? 1 : 0,
        canonicalJson(b.manifest),
        this.now(),
      );
      this.appendEvent(b.actor, "build_recorded", b.key, {
        commit: b.commit,
        kit_commit: b.kitCommit,
        ok: b.ok,
      });
    });
  }

  getBuild(key: string): { ok: boolean; manifest: unknown } | undefined {
    const r = this.get<Row>("select ok, manifest from build where key = ?", key);
    return r ? { ok: Number(r.ok) === 1, manifest: JSON.parse(String(r.manifest)) } : undefined;
  }

  recordReceipt(jobId: number, fence: number, body: unknown): string {
    const json = canonicalJson(body);
    const id = sha256Hex(json);
    this.tx(() => {
      this.assertFence(jobId, fence);
      this.run(
        "insert into receipt (id, job, fence, body, created_at) values (?, ?, ?, ?, ?)",
        id,
        jobId,
        fence,
        json,
        this.now(),
      );
    });
    return id;
  }

  recordVerdict(v: {
    attempt: string;
    verdict: string;
    delta?: number | null | undefined;
    ciLow?: number | null | undefined;
    ciHigh?: number | null | undefined;
    guards?: unknown;
    dependsOnJobs?: number[] | undefined;
    reasons: string;
    judgedBy: string;
    supersedes?: number | undefined;
  }): number {
    return this.tx(() => {
      const a = this.getAttempt(v.attempt);
      if (!a) throw new LedgerError("not_found", `no attempt ${v.attempt}`);
      if (a.invalidated_by !== null && v.verdict !== "invalidated") {
        throw new LedgerError("invalid", `attempt ${v.attempt} is invalidated`);
      }
      return this.insertVerdict(v);
    });
  }

  private insertVerdict(v: Parameters<Ledger["recordVerdict"]>[0]): number {
    const id = this.run(
      `insert into verdict (attempt, verdict, delta, ci_low, ci_high, guards, depends_on_jobs, reasons,
         judged_by, supersedes, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.attempt,
      v.verdict,
      v.delta ?? null,
      v.ciLow ?? null,
      v.ciHigh ?? null,
      canonicalJson(v.guards ?? []),
      canonicalJson(v.dependsOnJobs ?? []),
      v.reasons,
      v.judgedBy,
      v.supersedes ?? null,
      this.now(),
    ).id;
    this.appendEvent(v.judgedBy, "verdict", v.attempt, {
      id,
      verdict: v.verdict,
      delta: v.delta ?? null,
      supersedes: v.supersedes ?? null,
    });
    return id;
  }

  /** The newest verdict for an attempt that no later verdict supersedes. */
  currentVerdict(
    attempt: string,
  ): { id: number; verdict: string; depends_on_jobs: number[] } | undefined {
    const r = this.get<Row>(
      `select id, verdict, depends_on_jobs from verdict v where attempt = ?
         and not exists (select 1 from verdict s where s.supersedes = v.id)
       order by id desc limit 1`,
      attempt,
    );
    return r
      ? {
          id: Number(r.id),
          verdict: String(r.verdict),
          depends_on_jobs: JSON.parse(String(r.depends_on_jobs)) as number[],
        }
      : undefined;
  }

  /**
   * Invalidates a job's evidence or a whole attempt. Never deletes: current verdicts that depend
   * on the subject are superseded by an `invalidated` verdict, champions built on them are marked
   * reopened, and attempts derived from an invalidated attempt are invalidated in turn.
   */
  invalidate(input: {
    subjectKind: "job" | "attempt";
    subjectId: string;
    reason: string;
    actor: string;
  }): InvalidationResult {
    return this.tx(() => {
      const at = this.now();
      const result: InvalidationResult = {
        attempts: [],
        verdictsSuperseded: [],
        championsReopened: [],
      };
      const invalidationId = this.run(
        "insert into invalidation (subject_kind, subject_id, reason, actor, created_at) values (?, ?, ?, ?, ?)",
        input.subjectKind,
        input.subjectId,
        input.reason,
        input.actor,
        at,
      ).id;
      // An invalidated attempt (and everything built on it) is invalid for good. Attempts whose
      // job evidence was invalidated may be measured again; their descendants are re-judged too.
      const permanent = input.subjectKind === "attempt";
      let frontier: string[] = [];
      if (input.subjectKind === "attempt") {
        frontier = [input.subjectId];
      } else {
        const jobId = Number(input.subjectId);
        const rows = this.all<Row>("select distinct attempt from verdict");
        for (const r of rows) {
          const current = this.currentVerdict(String(r.attempt));
          if (current?.depends_on_jobs.includes(jobId)) frontier.push(String(r.attempt));
        }
      }
      const seen = new Set<string>();
      while (frontier.length) {
        const attempt = frontier.shift() as string;
        if (seen.has(attempt)) continue;
        seen.add(attempt);
        result.attempts.push(attempt);
        if (permanent) {
          this.run(
            "update attempt set invalidated_by = coalesce(invalidated_by, ?), updated_at = ? where id = ?",
            invalidationId,
            at,
            attempt,
          );
        }
        const current = this.currentVerdict(attempt);
        if (current?.verdict !== "invalidated") {
          const id = this.insertVerdict({
            attempt,
            verdict: "invalidated",
            reasons:
              attempt === input.subjectId || input.subjectKind === "job"
                ? input.reason
                : `lineage of invalidated evidence: ${input.reason}`,
            judgedBy: input.actor,
            supersedes: current?.id,
          });
          result.verdictsSuperseded.push(id);
        }
        for (const c of this.all<Row>(
          "select instance, seq from champion where attempt = ? and reopened = 0",
          attempt,
        )) {
          this.run(
            "update champion set reopened = 1 where instance = ? and seq = ?",
            String(c.instance),
            Number(c.seq),
          );
          result.championsReopened.push({ instance: String(c.instance), seq: Number(c.seq) });
          this.appendEvent(input.actor, "champion_reopened", String(c.instance), {
            seq: Number(c.seq),
            attempt,
            reason: input.reason,
          });
        }
        for (const child of this.all<Row>(
          "select id from attempt where parent_attempt = ?",
          attempt,
        )) {
          frontier.push(String(child.id));
        }
      }
      this.appendEvent(input.actor, "invalidation", input.subjectId, {
        kind: input.subjectKind,
        reason: input.reason,
        attempts: result.attempts,
      });
      return result;
    });
  }

  // ---------------------------------------------------------------- commands, directives, imports

  getCommand(id: string): { accepted: boolean; result: unknown } | undefined {
    const r = this.get<Row>("select accepted, result from command where id = ?", id);
    return r
      ? { accepted: Number(r.accepted) === 1, result: JSON.parse(String(r.result)) }
      : undefined;
  }

  recordCommand(c: {
    id: string;
    kind: string;
    envelope: unknown;
    signature: string;
    accepted: boolean;
    result: unknown;
    actor: string;
  }): void {
    this.tx(() => {
      this.run(
        "insert into command (id, kind, envelope, signature, accepted, result, received_at) values (?, ?, ?, ?, ?, ?, ?)",
        c.id,
        c.kind,
        canonicalJson(c.envelope),
        c.signature,
        c.accepted ? 1 : 0,
        canonicalJson(c.result ?? {}),
        this.now(),
      );
      this.appendEvent(c.actor, "command", c.id, {
        kind: c.kind,
        accepted: c.accepted,
        result: c.result ?? {},
      });
    });
  }

  addDirective(instance: string, author: string, body: unknown): number {
    return this.tx(() => {
      const id = this.run(
        "insert into directive (instance, author, body, created_at) values (?, ?, ?, ?)",
        instance,
        author,
        canonicalJson(body),
        this.now(),
      ).id;
      this.appendEvent(author, "directive", instance, { id, body });
      return id;
    });
  }

  /**
   * A directive set. With `replace`, the author's active directives for the instance are
   * superseded first: each author steers with one current set, not an ever-growing pile.
   */
  addDirectiveSet(instance: string, author: string, bodies: unknown[], replace: boolean): number[] {
    return this.tx(() => {
      if (replace) {
        const old = this.all<Row>(
          "select id from directive where instance = ? and author = ? and status = 'active'",
          instance,
          author,
        ).map((r) => Number(r.id));
        if (old.length) {
          this.run(
            "update directive set status = 'superseded', superseded_at = ? where instance = ? and author = ? and status = 'active'",
            this.now(),
            instance,
            author,
          );
          this.appendEvent(author, "directives_superseded", instance, { ids: old });
        }
      }
      return bodies.map((b) => this.addDirective(instance, author, b));
    });
  }

  activeDirectives(instance: string): { id: number; author: string; body: unknown }[] {
    return this.all<Row>(
      "select id, author, body from directive where instance = ? and status = 'active' order by id",
      instance,
    ).map((r) => ({
      id: Number(r.id),
      author: String(r.author),
      body: JSON.parse(String(r.body)),
    }));
  }

  recordImport(i: {
    kind: string;
    name?: string | undefined;
    sha256?: string | undefined;
    commitSha?: string | undefined;
    sourcePath: string;
    storedPath: string;
    actor: string;
  }): number {
    return this.tx(() => {
      const id = this.run(
        "insert into import (kind, name, sha256, commit_sha, source_path, stored_path, verified_at) values (?, ?, ?, ?, ?, ?, ?)",
        i.kind,
        i.name ?? null,
        i.sha256 ?? null,
        i.commitSha ?? null,
        i.sourcePath,
        i.storedPath,
        this.now(),
      ).id;
      this.appendEvent(i.actor, "import_verified", i.kind, {
        name: i.name ?? null,
        sha256: i.sha256 ?? null,
        commit: i.commitSha ?? null,
      });
      return id;
    });
  }

  findImport(kind: string, key: { sha256?: string; commitSha?: string }): string | undefined {
    const r = key.sha256
      ? this.get<Row>(
          "select stored_path from import where kind = ? and sha256 = ? order by id desc",
          kind,
          key.sha256,
        )
      : this.get<Row>(
          "select stored_path from import where kind = ? and commit_sha = ? order by id desc",
          kind,
          key.commitSha ?? "",
        );
    return r ? String(r.stored_path) : undefined;
  }

  recordExport(e: {
    throughEvent: number;
    path: string;
    manifest: unknown;
    actor: string;
  }): number {
    return this.tx(() => {
      const id = this.run(
        "insert into export (through_event, path, manifest, created_at) values (?, ?, ?, ?)",
        e.throughEvent,
        e.path,
        canonicalJson(e.manifest),
        this.now(),
      ).id;
      this.appendEvent(e.actor, "export_written", String(id), {
        through_event: e.throughEvent,
        path: e.path,
      });
      return id;
    });
  }

  lastExport(): { id: number; through_event: number; created_at: string } | undefined {
    const r = this.get<Row>(
      "select id, through_event, created_at from export order by id desc limit 1",
    );
    return r
      ? {
          id: Number(r.id),
          through_event: Number(r.through_event),
          created_at: String(r.created_at),
        }
      : undefined;
  }

  /** A compact current-state summary for the supervisor's report. */
  summary(): unknown {
    return {
      ledger_id: this.ledgerId(),
      instances: this.listInstances().map((i) => {
        const champ = this.currentChampion(i.id);
        const reopened = this.all<Row>(
          "select seq from champion where instance = ? and reopened = 1 order by seq",
          i.id,
        ).map((r) => Number(r.seq));
        const lifecycles = this.all<Row>(
          "select lifecycle, count(*) as n from attempt where instance = ? group by lifecycle",
          i.id,
        );
        return {
          id: i.id,
          campaign: i.campaign,
          version: i.version,
          mode: i.mode,
          status: i.status,
          pause_reason: i.pause_reason,
          champion: { seq: champ.seq, commit: champ.commit_sha, reopened },
          attempts: Object.fromEntries(lifecycles.map((r) => [String(r.lifecycle), Number(r.n)])),
        };
      }),
      jobs: Object.fromEntries(
        this.all<Row>("select state, count(*) as n from job group by state").map((r) => [
          String(r.state),
          Number(r.n),
        ]),
      ),
      latest_event: this.latestEventId(),
    };
  }
}

function toInstance(r: Row): InstanceRow {
  return {
    id: String(r.id),
    campaign: String(r.campaign),
    version: Number(r.version),
    contract_sha: String(r.contract_sha),
    mode: String(r.mode),
    seed_repo: String(r.seed_repo),
    seed_commit: String(r.seed_commit),
    direction: r.direction === null ? null : String(r.direction),
    status: String(r.status) as InstanceRow["status"],
    pause_reason: r.pause_reason === null ? null : String(r.pause_reason),
  };
}

function toJob(r: Row): JobRow {
  return {
    id: Number(r.id),
    attempt: r.attempt === null ? null : String(r.attempt),
    kind: String(r.kind),
    state: String(r.state),
    priority: Number(r.priority),
    lease_owner: r.lease_owner === null ? null : String(r.lease_owner),
    lease_until: r.lease_until === null ? null : String(r.lease_until),
    fence: Number(r.fence),
    expiries: Number(r.expiries),
    spec: String(r.spec),
  };
}
