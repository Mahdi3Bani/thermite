import type { DatabaseSync } from "node:sqlite";

/** The kinds whose subject is a job's number. */
const JOB_KINDS = new Set(["job_queued", "job_leased", "job_finished", "job_unblocked"]);
const isJobKind = (kind: string) =>
  JOB_KINDS.has(kind) || kind === "job_lease_expired" || kind === "crash_infra";

/**
 * The run an event is about (goal 170: every run-scoped event names its run), or null for the
 * rig's own events (a command, a check, the rig's settings). Worked out once, when the event is
 * recorded: its subject is the run, or its body names it, or its subject is one of a run's things
 * (an attempt, a trial, an experiment, a job), each found by its ID.
 */
export function eventRun(
  db: DatabaseSync,
  kind: string,
  subject: string | null,
  body: unknown,
): string | null {
  const one = (sql: string, arg: string | number) => {
    const r = db.prepare(sql).get(arg) as { run?: unknown } | undefined;
    return typeof r?.run === "string" ? r.run : null;
  };
  // A contract's subject is its campaign, which may share a run's name.
  if (kind === "contract_stored") return null;
  const named = (body as { run?: unknown } | null)?.run;
  if (subject !== null && one("select id as run from run where id = ?", subject)) return subject;
  if (typeof named === "string" && one("select id as run from run where id = ?", named))
    return named;
  if (subject === null) return null;
  if (isJobKind(kind) && /^\d+$/.test(subject))
    return one(
      `select coalesce(a.run, json_extract(j.spec, '$.run')) as run
         from job j left join attempt a on a.id = j.attempt where j.id = ?`,
      Number(subject),
    );
  return (
    one("select run from attempt where id = ?", subject) ??
    one("select run from trial where id = ?", subject) ??
    one("select run from experiment where id = ?", subject)
  );
}

/**
 * Migration 23: each event's run, in a column of its own with its index, for every event the
 * ledger already holds, worked out as eventRun does for a new one. Events stay append-only: the
 * update runs inside the migration, between the trigger's removal and its return.
 */
export function eventRunColumn(db: DatabaseSync): void {
  db.exec("alter table event add column run text");
  db.exec("drop trigger event_no_update");
  const rows = db.prepare("select id, kind, subject, body from event").all() as {
    id: number;
    kind: string;
    subject: string | null;
    body: string;
  }[];
  const set = db.prepare("update event set run = ? where id = ?");
  for (const r of rows) {
    const run = eventRun(db, r.kind, r.subject, JSON.parse(r.body));
    if (run !== null) set.run(run, r.id);
  }
  db.exec(
    "create trigger event_no_update before update on event begin select raise(abort, 'event is append-only'); end",
  );
  db.exec("create index event_run on event (run, id)");
}
