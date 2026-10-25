import { type Ledger, MAX_LEASE_EXPIRIES } from "../ledger.ts";

/**
 * The judge's jobs and their leases around builds and restarts. Builds run one at a time across
 * the rig's executors (serial), and a build of a large project, with the wait for the lock, can
 * take longer than the lease (15 minutes): without renewal the lease ran out mid-build, the job
 * went back to the queue, and after MAX_LEASE_EXPIRIES it was blocked, its attempt never judged.
 * A build has its own time limit (the kit's), so renewing the lease while it runs can't hold a
 * job forever.
 */

/** One at a time: each call waits for the ones before it. */
export function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** Runs `work`, calling `renew` every `everyMs` until it ends; a renewal that throws stops them. */
export async function whileLeased<T>(
  renew: () => void,
  everyMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    try {
      renew();
    } catch {
      // The lease is lost: whoever holds the job now owns its outcome; the work ends as it will.
      clearInterval(timer);
    }
  }, everyMs);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * At the harness's start, each job blocked by lost leases is queued once more, one lost lease
 * from blocked again, with a `job_unblocked` event, and its attempt, which ended when the job was
 * blocked, waits for the judge again: a lease lost to a judge that could not renew it (an older
 * harness, during a long build) gets its try on the new one, and a job that keeps killing its
 * judge is blocked again after one more try. Returns their ids.
 */
export function unblockAtStart(ledger: Ledger, actor: string): number[] {
  return ledger.tx(() => {
    const rows = ledger.db
      .prepare("select id, expiries, attempt from job where state = 'blocked'")
      .all() as { id: number; expiries: number; attempt: string | null }[];
    for (const r of rows) {
      ledger.db
        .prepare(
          "update job set state = 'queued', expiries = ?, lease_owner = null, lease_until = null, updated_at = ? where id = ?",
        )
        .run(MAX_LEASE_EXPIRIES - 1, new Date().toISOString(), r.id);
      ledger.appendEvent(actor, "job_unblocked", String(r.id), {
        expiries: Number(r.expiries),
        reason: "queued again at the harness's start: one more lost lease blocks it again",
      });
      if (r.attempt !== null) ledger.setAttemptLifecycle(r.attempt, "queued", actor);
    }
    return rows.map((r) => Number(r.id));
  });
}

/**
 * The harness's start: jobs still leased by its executors belonged to a process that died, and
 * go back to the queue (reclaimLeases); blocked jobs get one more try (unblockAtStart); then the
 * queued jobs of closed runs are cancelled, those two may have put back too.
 */
export function jobsAtStart(
  ledger: Ledger,
  executors: string[],
  log: (msg: string, fields: Record<string, unknown>) => void,
): void {
  for (const id of executors) {
    const reclaimed = ledger.reclaimLeases(id, "controller-start");
    if (reclaimed.length) log("reclaimed leases at start", { executor: id, jobs: reclaimed });
  }
  const unblocked = unblockAtStart(ledger, "controller-start");
  if (unblocked.length) log("blocked jobs queued again at start", { jobs: unblocked });
  const cancelled = ledger.endClosedRunJobs("controller-start");
  if (cancelled.length) log("cancelled closed runs' jobs at start", { jobs: cancelled });
}
