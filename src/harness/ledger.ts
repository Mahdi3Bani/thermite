import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { openDatabase, transaction } from "../common/sqlite.ts";
import { canonicalJson } from "../core/canonical.ts";
import type { AppendEvent } from "../core/events/bodies.ts";
import { currentEvent, type EventKind } from "../core/names.ts";
import { LedgerAttempts } from "./ledger/attempts.ts";
import { LedgerBuilds } from "./ledger/builds.ts";
import { LedgerChampions } from "./ledger/champions.ts";
import { LedgerCommands } from "./ledger/commands.ts";
import { LedgerContracts } from "./ledger/contracts.ts";
import { LedgerDirectives } from "./ledger/directives.ts";
import { LedgerEvents } from "./ledger/events.ts";
import { LedgerExperiments } from "./ledger/experiments.ts";
import { LedgerExports } from "./ledger/exports.ts";
import { LedgerGoals } from "./ledger/goals.ts";
import { LedgerHeldOut } from "./ledger/held-out.ts";
import { LedgerImports } from "./ledger/imports.ts";
import { LedgerJobs } from "./ledger/jobs.ts";
import { LedgerMeasurements } from "./ledger/measurements.ts";
import { migrateLedger } from "./ledger/migrate.ts";
import { LedgerError, type Row } from "./ledger/part.ts";
import type { LedgerEvent } from "./ledger/rows.ts";
import { eventRun, LedgerRuns } from "./ledger/runs.ts";
import { LedgerVerdicts } from "./ledger/verdicts.ts";

/**
 * The harness ledger: the authoritative research record for one rig.
 *
 * One process (the controller) owns the database and is its only writer. Every state change
 * also appends an event, so the supervisor can stream changes with a cursor.
 */

export type { PromoteResult } from "./ledger/champions.ts";
export { MAX_LEASE_EXPIRIES } from "./ledger/jobs.ts";
export { LedgerError } from "./ledger/part.ts";
export type { AttemptInput, BriefingItem, ExperimentRow, JobRow, RunRow } from "./ledger/rows.ts";
export type { InvalidationResult } from "./ledger/verdicts.ts";

export class Ledger {
  readonly db: DatabaseSync;
  /** The events, read by kind (the one module that queries the event table). */
  readonly events: LedgerEvents;
  // One module for each of the ledger's tables (goal 125, T6): each owns its table's SQL.
  readonly contracts: LedgerContracts;
  readonly runs: LedgerRuns;
  readonly champions: LedgerChampions;
  readonly attempts: LedgerAttempts;
  readonly jobs: LedgerJobs;
  readonly measurements: LedgerMeasurements;
  readonly heldOut: LedgerHeldOut;
  readonly builds: LedgerBuilds;
  readonly verdicts: LedgerVerdicts;
  readonly commands: LedgerCommands;
  readonly directives: LedgerDirectives;
  readonly experiments: LedgerExperiments;
  readonly goals: LedgerGoals;
  readonly imports: LedgerImports;
  readonly exports: LedgerExports;
  private readonly clock: () => Date;

  private constructor(db: DatabaseSync, clock: () => Date) {
    this.db = db;
    this.events = new LedgerEvents(db);
    this.clock = clock;
    this.contracts = new LedgerContracts(this, db, clock);
    this.runs = new LedgerRuns(this, db, clock);
    this.champions = new LedgerChampions(this, db, clock);
    this.attempts = new LedgerAttempts(this, db, clock);
    this.jobs = new LedgerJobs(this, db, clock);
    this.measurements = new LedgerMeasurements(this, db, clock);
    this.heldOut = new LedgerHeldOut(this, db, clock);
    this.builds = new LedgerBuilds(this, db, clock);
    this.verdicts = new LedgerVerdicts(this, db, clock);
    this.commands = new LedgerCommands(this, db, clock);
    this.directives = new LedgerDirectives(this, db, clock);
    this.experiments = new LedgerExperiments(this, db, clock);
    this.goals = new LedgerGoals(this, db, clock);
    this.imports = new LedgerImports(this, db, clock);
    this.exports = new LedgerExports(this, db, clock);
  }

  static open(path: string, clock: () => Date = () => new Date()): Ledger {
    const db = openDatabase(path);
    const ledger = new Ledger(db, clock);
    migrateLedger(
      db,
      path,
      (fn) => ledger.tx(fn),
      (m) => new LedgerError("invalid", m),
    );
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

  /** Runs fn in an immediate transaction. Nested calls become savepoints of the outer one. */
  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
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

  appendEvent: AppendEvent = (actor, kind, subject, body) =>
    this.run(
      "insert into event (at, actor, kind, subject, body, run) values (?, ?, ?, ?, ?, ?)",
      this.now(),
      actor,
      kind,
      subject,
      canonicalJson(body ?? {}),
      eventRun(this.db, kind, subject, body),
    ).id;

  /** The body of the newest event of a kind about a subject, if any. */
  latestEventBody(kind: string, subject: string): Record<string, unknown> | undefined {
    return this.events.newest(kind as EventKind, { subject })?.body as Record<string, unknown>;
  }

  /** Events strictly after the cursor, in order. The next cursor is the last id returned. */
  eventsAfter(cursor: number, limit = 500): { events: LedgerEvent[]; next: number } {
    const rows = this.all<Row>(
      "select id, at, actor, kind, subject, body, run from event where id > ? order by id limit ?",
      cursor,
      limit,
    );
    // Events recorded before the 2026-10-15 rename are read under the new names.
    const events = rows.map((r) =>
      currentEvent({
        id: Number(r.id),
        at: String(r.at),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: r.subject === null ? null : String(r.subject),
        body: JSON.parse(String(r.body)),
        run: r.run === null ? null : String(r.run),
      }),
    );
    return { events, next: events.length ? (events[events.length - 1] as LedgerEvent).id : cursor };
  }

  latestEventId(): number {
    return Number(this.get<Row>("select coalesce(max(id), 0) as id from event")?.id ?? 0);
  }

  /** Whether an event of any kind but `except` was recorded after event `id`. */
  recordedAfter(id: number, except: readonly string[] = []): boolean {
    const notIn = except.length ? ` and kind not in (${except.map(() => "?").join(", ")})` : "";
    return !!this.get<Row>(`select 1 from event where id > ?${notIn} limit 1`, id, ...except);
  }

  // ---------------------------------------------------------------- contracts and runs

  // ---------------------------------------------------------------- champions

  // ---------------------------------------------------------------- attempts

  // ---------------------------------------------------------------- jobs and leases

  // ---------------------------------------------------------------- measurements, receipts, verdicts

  // ---------------------------------------------------------------- commands, directives, imports

  // ---------------------------------------------------------------- the experiment queue

  /** A compact current-state summary for the supervisor's report. */
  summary(): unknown {
    return {
      ledger_id: this.ledgerId(),
      runs: this.runs.list().map((i) => {
        const champ = this.champions.current(i.id);
        return {
          id: i.id,
          campaign: i.campaign,
          version: i.version,
          mode: i.mode,
          status: i.status,
          pause_reason: i.pause_reason,
          champion: {
            seq: champ.seq,
            commit: champ.commit_sha,
            reopened: this.champions.reopened(i.id),
          },
          attempts: this.attempts.lifecycles(i.id),
        };
      }),
      jobs: this.jobs.states(),
      latest_event: this.latestEventId(),
    };
  }
}
