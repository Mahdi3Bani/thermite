import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { copiesOf } from "../../src/common/db-copy.ts";
import { sha256Hex } from "../../src/core/canonical.ts";
import { type Contract, parseContract } from "../../src/core/contract.ts";
import { Ledger, LedgerError, MAX_LEASE_EXPIRIES } from "../../src/harness/ledger.ts";
import { MIGRATIONS } from "../../src/harness/schema.ts";
import { goalFixture, hillClimbFixture } from "../helpers/fixtures.ts";

function contractOf(input: unknown): { contract: Contract; sha: string } {
  const r = parseContract(input);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return { contract: r.contract, sha: r.sha };
}

function setup(clock?: () => Date): { ledger: Ledger; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
  const ledger = Ledger.open(path, clock);
  const { contract, sha } = contractOf(hillClimbFixture);
  ledger.storeContract(contract, sha, "test");
  ledger.createRun({
    id: "race-1",
    contract,
    contractSha: sha,
    seedRepo: "smoke",
    seedCommit: "a".repeat(40),
    actor: "test",
  });
  return { ledger, path };
}

const commitOf = (id: string) => sha256Hex(id).slice(0, 40);

function attempt(
  ledger: Ledger,
  id: string,
  opts: { parentAttempt?: string; knownFlaws?: string[] } = {},
): void {
  ledger.recordAttempt(
    {
      id,
      run: "race-1",
      parentRef: opts.parentAttempt ? `refs/thermite/attempts/${opts.parentAttempt}` : "seed",
      parentCommit: opts.parentAttempt ? commitOf(opts.parentAttempt) : "a".repeat(40),
      parentAttempt: opts.parentAttempt,
      baselineChampionSeq: 1,
      commitSha: commitOf(id),
      ref: `refs/thermite/attempts/${id}`,
      diffSha: id,
      normalizedDiffSha: id,
      lifecycle: "submitted",
      knownFlaws: opts.knownFlaws,
    },
    "test",
  );
}

/** A confirmed attempt, ready to promote. */
function confirmed(ledger: Ledger, id: string, opts: { parentAttempt?: string } = {}): void {
  attempt(ledger, id, opts);
  ledger.recordVerdict({ attempt: id, verdict: "win_confirmed", reasons: "t", judgedBy: "judge" });
}

const promoteArgs = (id: string, expectedSeq = 1) => ({
  run: "race-1",
  expectedSeq,
  attempt: id,
  commitSha: commitOf(id),
  by: "judge",
});

describe("ledger", () => {
  test("a ledger written by newer code is refused, not opened", () => {
    const { ledger, path } = setup();
    ledger.db
      .prepare("insert into schema_migrations (version) values (?)")
      .run(MIGRATIONS.length + 1);
    ledger.close();
    assert.throws(() => Ledger.open(path), /newer than this code/);
  });

  test("a ledger with a record is copied before its migrations run, and only then", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
    const older = MIGRATIONS.length - 1;
    const db = new DatabaseSync(path);
    db.exec("create table schema_migrations (version integer primary key)");
    MIGRATIONS.slice(0, older).forEach((sql, i) => {
      if (typeof sql === "string") db.exec(sql);
      else sql(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(i + 1);
    });
    db.close();

    Ledger.open(path).close();
    const copies = copiesOf(path);
    assert.deepEqual(
      copies.map((c) => c.version),
      [older],
    );
    Ledger.open(path).close();
    assert.equal(copiesOf(path).length, 1, "a ledger at this code's version is not copied again");

    const newer = new DatabaseSync(path);
    newer.prepare("insert into schema_migrations (version) values (?)").run(MIGRATIONS.length + 1);
    newer.close();
    assert.throws(() => Ledger.open(path), /the copy made then: .*ledger\.db\.v\d+\..*\.copy/);
  });

  test("a new ledger is not copied", () => {
    const { ledger, path } = setup();
    ledger.close();
    assert.deepEqual(copiesOf(path), []);
  });

  test("migrations are idempotent across reopen", () => {
    const { ledger, path } = setup();
    ledger.close();
    const again = Ledger.open(path);
    assert.equal(again.getRun("race-1")?.status, "running");
    again.close();
  });

  test("a ledger from before the 2026-10-15 rename opens under the new names", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
    const db = new DatabaseSync(path);
    db.exec("create table schema_migrations (version integer primary key)");
    MIGRATIONS.slice(0, 9).forEach((m, i) => {
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(i + 1);
    });
    const at = "2026-10-14T00:00:00.000Z";
    db.prepare(
      "insert into event (at, actor, kind, subject, body) values (?, 'control', 'instance_created', 'old-1', ?)",
    ).run(at, JSON.stringify({ campaign: "c", mode: "hill_climb", instance: "old-1" }));
    db.prepare(
      "insert into job (kind, state, spec, created_at, updated_at) values ('calibrate', 'queued', ?, ?, ?)",
    ).run(JSON.stringify({ instance: "old-1" }), at, at);
    db.close();
    const ledger = Ledger.open(path);
    const cols = (t: string) =>
      (ledger.db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    const tables = (
      ledger.db.prepare("select name from sqlite_master where type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    assert.ok(tables.includes("run") && !tables.includes("instance"));
    for (const t of tables)
      for (const c of cols(t))
        assert.ok(!["instance", "source_instance", "source_unit"].includes(c), `${t}.${c}`);
    assert.ok(cols("propagation").includes("source_rig"));
    assert.ok(cols("measurement").includes("unit"), "a metric's unit keeps its name");
    // Events keep what was recorded; readers see the new names.
    const e = ledger.eventsAfter(0).events[0];
    assert.ok(e);
    assert.equal(e.kind, "run_created");
    assert.equal((e.body as { run?: string }).run, "old-1");
    assert.equal(
      String((ledger.db.prepare("select kind from event").get() as { kind: string }).kind),
      "instance_created",
    );
    const spec = ledger.db.prepare("select spec from job").get() as { spec: string };
    assert.deepEqual(JSON.parse(spec.spec), { run: "old-1" });
    ledger.close();
  });

  test("field notes kept before version 16 say what they are about: the run, if nothing else", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
    const db = new DatabaseSync(path);
    db.exec("create table schema_migrations (version integer primary key)");
    MIGRATIONS.slice(0, 15).forEach((m, i) => {
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(i + 1);
    });
    const add = db.prepare(
      "insert into journal_note (run, by, kind, text, about_type, about_id, at) values (?, ?, ?, ?, ?, ?, ?)",
    );
    const at = "2026-10-20T00:00:00.000Z";
    add.run("old-1", "lane-1", "lesson", "said nothing", null, null, at);
    add.run("old-1", "planner", "decision", "about a trial", "trial", "t-1", at);
    db.close();
    const ledger = Ledger.open(path);
    assert.deepEqual(
      ledger.db
        .prepare("select id, run, about_type, about_id, text from journal_note order by id")
        .all()
        .map((r) => ({ ...r })),
      [
        { id: 1, run: "old-1", about_type: "run", about_id: "old-1", text: "said nothing" },
        { id: 2, run: "old-1", about_type: "trial", about_id: "t-1", text: "about a trial" },
      ],
    );
    // Still append-only, and never empty again; the next note takes the next number.
    assert.throws(
      () => ledger.db.prepare("update journal_note set text = 'x' where id = 1").run(),
      /append-only/,
    );
    assert.throws(
      () =>
        ledger.db
          .prepare(
            "insert into journal_note (run, by, kind, text, about_type, about_id, at) values ('old-1', 'x', 'note', 't', null, null, ?)",
          )
          .run(at),
      /NOT NULL/,
    );
    const next = ledger.db
      .prepare(
        "insert into journal_note (run, by, kind, text, about_type, about_id, at) values ('old-1', 'x', 'note', 't', 'run', 'old-1', ?)",
      )
      .run(at);
    assert.equal(Number(next.lastInsertRowid), 3);
    ledger.close();
  });

  test("held-out records kept before version 20 stay as they were; a champion's names its run and no attempt (goal 086)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
    const db = new DatabaseSync(path);
    db.exec("create table schema_migrations (version integer primary key)");
    MIGRATIONS.slice(0, 19).forEach((m, i) => {
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(i + 1);
    });
    const at = "2026-10-21T00:00:00.000Z";
    db.prepare(
      "insert into contract (campaign, version, sha, mode, body, created_at) values ('c', 1, 's', 'goal', '{}', ?)",
    ).run(at);
    db.prepare(
      "insert into run (id, campaign, version, contract_sha, mode, seed_repo, seed_commit, status, created_at, updated_at) values ('old-1', 'c', 1, 's', 'goal', 'r', 'c0', 'running', ?, ?)",
    ).run(at, at);
    db.prepare(
      "insert into attempt (id, run, parent_ref, parent_commit, commit_sha, ref, diff_sha, normalized_diff_sha, lifecycle, created_at, updated_at) values ('a-1', 'old-1', 'p', 'c0', 'c1', 'r', 'd', 'n', 'judged', ?, ?)",
    ).run(at, at);
    db.prepare(
      "insert into job (kind, state, fence, lease_owner, lease_until, spec, created_at, updated_at) values ('validate', 'leased', 1, 't', '2999-01-01T00:00:00.000Z', '{}', ?, ?)",
    ).run(at, at);
    db.prepare(
      "insert into held_out (job, fence, attempt, pass, detail, created_at) values (1, 1, 'a-1', 0, ?, ?)",
    ).run('{"cells":[{"cell":"h","ok":false,"kind":"crashed"}],"pass":false}', at);
    db.close();
    const ledger = Ledger.open(path);
    const rows = () =>
      ledger.db
        .prepare("select id, attempt, run, champion_seq, pass from held_out order by id")
        .all()
        .map((r) => ({ ...r }));
    assert.deepEqual(rows(), [{ id: 1, attempt: "a-1", run: null, champion_seq: null, pass: 0 }]);
    assert.deepEqual(ledger.heldOutFailure("a-1"), ["crashed"]);
    // A champion's record: its run and champion, no attempt; the attempt's own is unchanged.
    ledger.recordChampionHeldOut(1, 1, "old-1", 2, false, {
      pass: false,
      cells: [{ cell: "h", ok: true }],
    });
    assert.deepEqual(rows()[1], { id: 2, attempt: null, run: "old-1", champion_seq: 2, pass: 0 });
    assert.deepEqual(ledger.heldOutFailure("a-1"), ["crashed"]);
    // Still append-only; a record names an attempt, or a run and its champion.
    assert.throws(
      () => ledger.db.prepare("update held_out set pass = 1 where id = 1").run(),
      /append-only/,
    );
    assert.throws(() => ledger.db.prepare("delete from held_out").run(), /append-only/);
    assert.throws(
      () =>
        ledger.db
          .prepare(
            "insert into held_out (job, fence, attempt, pass, detail, created_at) values (1, 1, null, 1, '{}', ?)",
          )
          .run(at),
      /CHECK constraint/,
    );
    ledger.close();
  });

  test("a contract edit must become a new version", () => {
    const { ledger } = setup();
    const v1 = contractOf(hillClimbFixture);
    assert.equal(ledger.storeContract(v1.contract, v1.sha, "t"), "exists");
    const edited = contractOf({ ...hillClimbFixture, cells: ["n1024"] });
    assert.throws(
      () => ledger.storeContract(edited.contract, edited.sha, "t"),
      (e: unknown) => e instanceof LedgerError && e.code === "conflict",
    );
    const v2 = contractOf({ ...hillClimbFixture, version: 2, cells: ["n1024"] });
    assert.equal(ledger.storeContract(v2.contract, v2.sha, "t"), "created");
    assert.deepEqual(
      ledger.contractVersions("smoke-matmul").map((v) => v.version),
      [1, 2],
    );
    assert.throws(() => ledger.db.exec("update contract set mode = 'goal'"), /immutable/);
  });

  test("the seed is champion seq 1 and goal runs get their goal tree", () => {
    const { ledger } = setup();
    assert.equal(ledger.currentChampion("race-1").seq, 1);
    const g = contractOf(goalFixture);
    ledger.storeContract(g.contract, g.sha, "t");
    ledger.createRun({
      id: "goal-1",
      contract: g.contract,
      contractSha: g.sha,
      seedRepo: "engine",
      seedCommit: "b".repeat(40),
      actor: "t",
    });
    const goals = ledger.db
      .prepare("select id, status from goal where run = 'goal-1' order by id")
      .all();
    assert.deepEqual(
      goals.map((r) => r.id),
      ["correctness", "decode-speed", "resident"],
    );
  });

  test("promotion is compare-and-swap: a stale expected seq loses", () => {
    const { ledger } = setup();
    confirmed(ledger, "a1");
    confirmed(ledger, "a2");
    assert.deepEqual(ledger.promote(promoteArgs("a1")), { ok: true, seq: 2 });
    assert.deepEqual(ledger.promote(promoteArgs("a2")), { ok: false, currentSeq: 2 });
  });

  test("only a promotable, unflawed attempt of this run with its own commit is promoted", () => {
    const { ledger } = setup();
    const refused = (args: Parameters<Ledger["promote"]>[0], why: RegExp) =>
      assert.throws(
        () => ledger.promote(args),
        (e: unknown) => e instanceof LedgerError && why.test(e.message),
      );
    attempt(ledger, "unjudged");
    refused(promoteArgs("unjudged"), /verdict none/);
    attempt(ledger, "screened");
    ledger.recordVerdict({
      attempt: "screened",
      verdict: "win_screened",
      reasons: "t",
      judgedBy: "j",
    });
    refused(promoteArgs("screened"), /verdict win_screened/);
    attempt(ledger, "flawed", { knownFlaws: ["only measured at short context"] });
    ledger.recordVerdict({
      attempt: "flawed",
      verdict: "win_confirmed",
      reasons: "t",
      judgedBy: "j",
    });
    refused(promoteArgs("flawed"), /open known flaws/);
    confirmed(ledger, "ok");
    refused({ ...promoteArgs("ok"), commitSha: "f".repeat(40) }, /is not attempt/);
    refused({ ...promoteArgs("ok"), run: "other" }, /is not in other/);
    assert.equal(ledger.currentChampion("race-1").seq, 1);
  });

  test("two processes racing one promotion: exactly one wins", async () => {
    const { ledger, path } = setup();
    confirmed(ledger, "p1");
    confirmed(ledger, "p2");
    ledger.close();
    const startAt = String(Date.now() + 2500);
    const script = new URL("../helpers/promote-race.ts", import.meta.url).pathname;
    const run = (id: string) =>
      new Promise<{ ok: boolean }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          script,
          path,
          id,
          startAt,
        ]);
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
          out += d;
        });
        child.stderr.on("data", (d) => {
          err += d;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(new Error(`racer ${id} exited ${code}: ${err.slice(0, 2000)}`));
          }
        });
      });
    const results = await Promise.all([run("p1"), run("p2")]);
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    const check = Ledger.open(path);
    assert.equal(check.currentChampion("race-1").seq, 2);
    check.close();
  });

  test("a paused run's jobs wait in the queue; the judge takes a running run's first", () => {
    const { ledger } = setup();
    const old = ledger.enqueueJob({ kind: "validate", spec: { run: "race-1" }, actor: "t" });
    ledger.setRunStatus("race-1", "paused", "replaced", "t");
    const free = ledger.enqueueJob({ kind: "calibrate", actor: "t" });
    assert.equal(ledger.leaseJob("exec", 60_000)?.id, free);
    assert.equal(ledger.leaseJob("exec", 60_000), undefined);
    ledger.setRunStatus("race-1", "running", null, "t");
    assert.equal(ledger.leaseJob("exec", 60_000)?.id, old);
  });

  test("with several judge cards, a pinned job waits for its card and a confirmation avoids its screen's", () => {
    const { ledger } = setup();
    const calA = ledger.enqueueJob({
      kind: "calibrate",
      priority: 10,
      spec: { run: "race-1", card: "GPU-a" },
      actor: "t",
    });
    const confirm = ledger.enqueueJob({
      kind: "confirm",
      priority: 20,
      spec: { run: "race-1", avoid_card: "GPU-a" },
      actor: "t",
    });
    const plain = ledger.enqueueJob({
      kind: "validate",
      priority: 30,
      spec: { run: "race-1" },
      actor: "t",
    });
    // Card B: not A's calibration, but the confirmation (it must not run on A).
    assert.equal(ledger.leaseJob("executor-1", 60_000, undefined, "GPU-b")?.id, confirm);
    // Card A: its own calibration, then the unpinned job; never the confirmation.
    assert.equal(ledger.leaseJob("executor-0", 60_000, undefined, "GPU-a")?.id, calA);
    assert.equal(ledger.leaseJob("executor-0", 60_000, undefined, "GPU-a")?.id, plain);
    assert.equal(ledger.leaseJob("executor-0", 60_000, undefined, "GPU-a"), undefined);
    // A rig with one judge card passes no card and takes everything.
    const again = ledger.enqueueJob({
      kind: "confirm",
      spec: { run: "race-1", avoid_card: "GPU-a" },
      actor: "t",
    });
    assert.equal(ledger.leaseJob("executor-0", 60_000)?.id, again);
  });

  test("leases are fenced: an expired holder cannot write, and repeated expiry blocks the job", () => {
    let now = new Date("2026-10-14T00:00:00Z");
    const { ledger } = setup(() => now);
    const id = ledger.enqueueJob({ kind: "screen", actor: "t" });
    const first = ledger.leaseJob("exec-a", 60_000);
    assert.equal(first?.id, id);
    now = new Date(now.getTime() + 61_000);
    assert.deepEqual(ledger.expireLeases(), [id]);
    const second = ledger.leaseJob("exec-b", 60_000);
    assert.ok(second && second.fence > (first?.fence ?? 0));
    assert.throws(
      () =>
        ledger.recordMeasurement(id, first?.fence ?? 0, {
          metric: "gflops",
          cell: "n256",
          rep: 1,
          value: 1,
          unit: "GFLOP/s",
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "stale",
    );
    assert.throws(() => ledger.completeJob(id, first?.fence ?? 0, "done", {}), /lease lost/);
    ledger.completeJob(id, second?.fence ?? 0, "done", { ok: true });
    assert.equal(ledger.jobById(id)?.state, "done");

    const poison = ledger.enqueueJob({ kind: "screen", actor: "t" });
    for (let i = 0; i < MAX_LEASE_EXPIRIES; i++) {
      assert.ok(ledger.leaseJob("exec", 1_000));
      now = new Date(now.getTime() + 2_000);
      ledger.expireLeases();
    }
    assert.equal(ledger.jobById(poison)?.state, "blocked");
  });

  test("only the completing lease's measurements count, and a dead holder is reclaimed once", () => {
    let now = new Date("2026-10-14T00:00:00Z");
    const { ledger } = setup(() => now);
    const id = ledger.enqueueJob({ kind: "screen", actor: "t" });
    const dead = ledger.leaseJob("executor-0", 600_000);
    const m = { metric: "gflops", cell: "n256", rep: 1, value: 1, unit: "GFLOP/s" };
    ledger.recordMeasurement(id, dead?.fence ?? 0, { ...m, value: 999 });
    // The controller restarts: its old leases are reclaimed at once, recorded as crash_infra.
    assert.deepEqual(ledger.reclaimLeases("executor-0"), [id]);
    assert.deepEqual(ledger.reclaimLeases("executor-0"), []);
    const crashes = ledger.eventsAfter(0, 1000).events.filter((e) => e.kind === "crash_infra");
    assert.equal(crashes.length, 1);
    const retry = ledger.leaseJob("executor-0", 600_000);
    ledger.recordMeasurement(id, retry?.fence ?? 0, { ...m, value: 2 });
    ledger.completeJob(id, retry?.fence ?? 0, "done", {});
    assert.deepEqual(
      ledger.measurementsFor(id).map((x) => x.value),
      [2],
    );
    now = new Date(now.getTime() + 1);
  });

  test("text values and deletes are refused where evidence lives", () => {
    const { ledger } = setup();
    const id = ledger.enqueueJob({ kind: "screen", actor: "t" });
    ledger.leaseJob("exec", 60_000);
    assert.throws(() =>
      ledger.db
        .prepare(
          "insert into measurement (job, fence, metric, cell, rep, value, unit, created_at) values (?, 1, 'm', 'c', 1, 'fast', 'x', 'now')",
        )
        .run(id),
    );
    assert.throws(() => ledger.db.exec("delete from contract"), /immutable/);
  });

  test("each new ledger has its own id", () => {
    const a = setup().ledger.ledgerId();
    const b = setup().ledger.ledgerId();
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, b);
  });

  test("nested transactions roll back only their own part", () => {
    const { ledger } = setup();
    ledger.tx(() => {
      ledger.appendEvent("t", "outer", null, {});
      assert.throws(() =>
        ledger.tx(() => {
          ledger.appendEvent("t", "inner", null, {});
          throw new Error("inner fails");
        }),
      );
    });
    const kinds = ledger.eventsAfter(0, 1000).events.map((e) => e.kind);
    assert.ok(kinds.includes("outer"));
    assert.ok(!kinds.includes("inner"));
  });

  test("non-finite measurements are refused by code and by the database", () => {
    const { ledger } = setup();
    const id = ledger.enqueueJob({ kind: "screen", actor: "t" });
    const lease = ledger.leaseJob("exec", 60_000);
    assert.throws(
      () =>
        ledger.recordMeasurement(id, lease?.fence ?? 0, {
          metric: "m",
          cell: "c",
          rep: 1,
          value: Number.NaN,
          unit: "x",
        }),
      /never a score/,
    );
    assert.throws(() =>
      ledger.db
        .prepare(
          "insert into measurement (job, fence, metric, cell, rep, value, unit, created_at) values (?, 1, 'm', 'c', 1, ?, 'x', 'now')",
        )
        .run(id, Number.NaN),
    );
  });

  test("verdicts, measurements and events are append-only", () => {
    const { ledger } = setup();
    attempt(ledger, "v1");
    ledger.recordVerdict({
      attempt: "v1",
      verdict: "neutral",
      reasons: "within band",
      judgedBy: "judge",
    });
    assert.throws(
      () => ledger.db.exec("update verdict set verdict = 'win_confirmed'"),
      /append-only/,
    );
    assert.throws(() => ledger.db.exec("delete from verdict"), /append-only/);
    assert.throws(() => ledger.db.exec("delete from event"), /append-only/);
  });

  test("invalidating evidence supersedes dependent verdicts, reopens the champion and follows lineage", () => {
    const { ledger } = setup();
    attempt(ledger, "base");
    attempt(ledger, "child", { parentAttempt: "base" });
    attempt(ledger, "unrelated");
    const job = ledger.enqueueJob({ attempt: "base", kind: "confirm", actor: "t" });
    ledger.recordVerdict({
      attempt: "base",
      verdict: "win_confirmed",
      dependsOnJobs: [job],
      reasons: "confirmed",
      judgedBy: "judge",
    });
    ledger.recordVerdict({
      attempt: "child",
      verdict: "win_screened",
      reasons: "screened",
      judgedBy: "judge",
    });
    ledger.recordVerdict({
      attempt: "unrelated",
      verdict: "neutral",
      reasons: "flat",
      judgedBy: "judge",
    });
    ledger.promote(promoteArgs("base"));

    const r = ledger.invalidate({
      subjectKind: "job",
      subjectId: String(job),
      reason: "evaluator bug found later",
      actor: "owner",
    });
    assert.deepEqual(r.attempts.sort(), ["base", "child"]);
    assert.equal(ledger.currentVerdict("base")?.verdict, "invalidated");
    assert.equal(ledger.currentVerdict("child")?.verdict, "invalidated");
    assert.equal(ledger.currentVerdict("unrelated")?.verdict, "neutral");
    assert.deepEqual(r.championsReopened, [{ run: "race-1", seq: 2 }]);
    const history = ledger.db
      .prepare("select verdict from verdict where attempt = 'base' order by id")
      .all();
    assert.deepEqual(
      history.map((h) => h.verdict),
      ["win_confirmed", "invalidated"],
    );
    // The reopened champion no longer counts: the effective champion falls back to the seed.
    assert.equal(ledger.currentChampion("race-1").seq, 1);
    const summary = ledger.summary() as { runs: { champion: { reopened: number[] } }[] };
    assert.deepEqual(summary.runs[0]?.champion.reopened, [2]);
    // Evidence invalidation allows re-measurement; a new verdict may follow.
    ledger.recordVerdict({
      attempt: "base",
      verdict: "neutral",
      reasons: "re-run",
      judgedBy: "judge",
    });
  });

  test("invalidating an attempt is permanent, follows any parent attempt, and works before a verdict", () => {
    const { ledger } = setup();
    attempt(ledger, "x");
    attempt(ledger, "y", { parentAttempt: "x" }); // built on x's commit, x never champion
    attempt(ledger, "z", { parentAttempt: "y" });
    ledger.recordVerdict({ attempt: "y", verdict: "win_screened", reasons: "t", judgedBy: "j" });
    const r = ledger.invalidate({
      subjectKind: "attempt",
      subjectId: "x",
      reason: "bad",
      actor: "owner",
    });
    assert.deepEqual(r.attempts, ["x", "y", "z"]);
    for (const id of ["x", "y", "z"])
      assert.equal(ledger.currentVerdict(id)?.verdict, "invalidated");
    assert.throws(
      () =>
        ledger.recordVerdict({
          attempt: "x",
          verdict: "win_confirmed",
          reasons: "t",
          judgedBy: "j",
        }),
      /invalidated/,
    );
    assert.throws(() => ledger.promote(promoteArgs("x")), /invalidated/);
    // An invalidated change may be submitted again: it is not a duplicate.
    assert.equal(ledger.findDuplicate("race-1", "x"), undefined);
  });

  test("a stale baseline champion seq is refused at promotion", () => {
    const { ledger } = setup();
    confirmed(ledger, "first");
    confirmed(ledger, "second"); // measured against seq 1
    assert.deepEqual(ledger.promote(promoteArgs("first")), { ok: true, seq: 2 });
    assert.deepEqual(ledger.promote(promoteArgs("second", 1)), { ok: false, currentSeq: 2 });
  });

  test("the event cursor never loses or duplicates events under interleaved writes", () => {
    const { ledger } = setup();
    let cursor = 0;
    const seen: number[] = [];
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < (round % 7) + 1; i++) ledger.appendEvent("t", "tick", null, { round, i });
      const page = ledger.eventsAfter(cursor, 3);
      seen.push(...page.events.map((e) => e.id));
      cursor = page.next;
    }
    for (;;) {
      const page = ledger.eventsAfter(cursor, 3);
      if (!page.events.length) break;
      seen.push(...page.events.map((e) => e.id));
      cursor = page.next;
    }
    const all = ledger.eventsAfter(0, 100_000).events.map((e) => e.id);
    assert.deepEqual(seen, all);
    assert.equal(new Set(seen).size, seen.length);
  });

  test("an export's own event is not something new to export", () => {
    const { ledger } = setup();
    ledger.recordExport({
      throughEvent: ledger.latestEventId(),
      path: "x",
      manifest: {},
      actor: "t",
    });
    const through = ledger.lastExport()?.through_event ?? 0;
    assert.equal(ledger.recordedAfter(through), true);
    assert.equal(ledger.recordedAfter(through, ["export_written"]), false);
    ledger.appendEvent("t", "tick", null, {});
    assert.equal(ledger.recordedAfter(through, ["export_written"]), true);
  });
});
