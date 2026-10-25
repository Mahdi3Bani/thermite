import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger, MAX_LEASE_EXPIRIES } from "../ledger.ts";
import { jobsAtStart, unblockAtStart, whileLeased } from "./lease.ts";

test("a long build keeps its job's lease: renewed while it runs, and no more once it ends", async () => {
  let renewed = 0;
  const out = await whileLeased(
    () => {
      renewed++;
    },
    10,
    () => new Promise<string>((r) => setTimeout(() => r("built"), 75)),
  );
  assert.equal(out, "built");
  assert.ok(renewed >= 4, `renewed ${renewed} times`);
  const after = renewed;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(renewed, after, "no renewal after the build");
  // A lost lease stops the renewals; the build ends as it will.
  let tries = 0;
  await whileLeased(
    () => {
      tries++;
      throw new Error("lease lost");
    },
    5,
    () => new Promise((r) => setTimeout(r, 40)),
  );
  assert.equal(tries, 1);
  // A build that fails ends the renewals too.
  await assert.rejects(
    whileLeased(
      () => {},
      5,
      () => Promise.reject(new Error("build failed")),
    ),
    /build failed/,
  );
});

test("a job blocked by lost leases gets one more try at the harness's start, and is blocked again by one more", () => {
  let now = new Date("2026-10-25T00:00:00Z");
  const dir = mkdtempSync(join(tmpdir(), "thermite-lease-"));
  const ledger = Ledger.open(join(dir, "ledger.db"), () => now);
  const job = ledger.enqueueJob({ kind: "evaluate", actor: "t" });
  const lose = () => {
    assert.ok(ledger.leaseJob("executor-0", 1_000));
    now = new Date(now.getTime() + 2_000);
    ledger.expireLeases();
  };
  for (let i = 0; i < MAX_LEASE_EXPIRIES; i++) lose();
  assert.equal(ledger.jobById(job)?.state, "blocked");
  const said: string[] = [];
  jobsAtStart(ledger, ["executor-0"], (msg) => said.push(msg));
  assert.deepEqual(said, ["blocked jobs queued again at start"]);
  assert.equal(ledger.jobById(job)?.state, "queued");
  const event = ledger.db
    .prepare("select body from event where kind = 'job_unblocked' and subject = ?")
    .get(String(job)) as { body: string };
  assert.equal(JSON.parse(event.body).expiries, MAX_LEASE_EXPIRIES);
  // One more lost lease blocks it again; nothing is blocked, nothing is queued again.
  lose();
  assert.equal(ledger.jobById(job)?.state, "blocked");
  assert.deepEqual(unblockAtStart(ledger, "t"), [job]);
  assert.deepEqual(unblockAtStart(ledger, "t"), []);
  ledger.close();
});
