import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CRASH_KERNEL, FAST_KERNEL, makeJudgeEnv, WRONG_KERNEL } from "../../testing/judge-env.ts";

/** Verdict history with reasons, for assertion messages. */
function why(
  env: { ledger: { db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } } } },
  id: string,
): string {
  return JSON.stringify(
    env.ledger.db
      .prepare("select verdict, reasons from verdict where attempt = ? order by id")
      .all(id),
  );
}

async function setup(opts: Parameters<typeof makeJudgeEnv>[0] = {}) {
  const env = makeJudgeEnv(opts);
  const out = await env.service.applyCommand(env.assign);
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
        "proposer",
      )
    ).attempt;
  return { ...env, submit };
}

describe("judge pipeline (local runner, Node test kit)", () => {
  test("a faster correct kernel is screened, confirmed and promoted", async () => {
    const env = await setup();
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const history = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((r) => r.verdict);
    assert.deepEqual(history, ["win_screened", "win_confirmed"], why(env, id));
    const champ = env.ledger.currentChampion("js-1");
    assert.equal(champ.seq, 2);
    assert.equal(champ.attempt, id);
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "promoted");
    // Measurements name their arm, and receipts exist for every block.
    const arms = env.ledger.db
      .prepare("select distinct arm from measurement order by arm")
      .all()
      .map((r) => r.arm);
    assert.deepEqual(arms, ["candidate", "champion"]);
    const receipts = env.ledger.db.prepare("select count(*) as n from receipt").get();
    // At least the first screening look (3 blocks) plus 4 confirmation blocks.
    assert.ok(Number(receipts?.n) >= 7, `receipts ${receipts?.n}`);
  });

  test("a score from the judge's clock as plain time: a faster kernel wins on lower seconds", async () => {
    const env = await setup({
      kitMetrics: { seconds: { unit: "s", from: "time" } },
      contract: {
        objective: { primary: { metric: "seconds", direction: "min", min_effect: 0.1 } },
      },
    });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const history = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((r) => r.verdict);
    assert.deepEqual(history, ["win_screened", "win_confirmed"], why(env, id));
    const m = env.ledger.db
      .prepare("select distinct metric from measurement")
      .all()
      .map((r) => r.metric);
    assert.deepEqual(m, ["seconds"]);
  });

  test("a score the check works out from the output: measured as the check reports it", async () => {
    // The test kit's check reports the result it read as `value`: the same for both arms.
    const env = await setup({
      kitMetrics: { value: { unit: "", from: "check", field: "value" } },
      contract: { objective: { primary: { metric: "value", direction: "max", min_effect: 0.1 } } },
    });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const last = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id desc limit 1")
      .get(id) as { verdict: string };
    assert.equal(last.verdict, "neutral", why(env, id));
    const values = env.ledger.db
      .prepare("select distinct value from measurement where metric = 'value'")
      .all()
      .map((r) => Number(r.value));
    assert.deepEqual(values, [values[0]]);
    assert.ok((values[0] ?? 0) > 0);
  });

  test("a run driver from run.copy is copied into each run, and a win still promotes", async () => {
    const env = await setup({ runCopy: true });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "promoted", why(env, id));
    assert.equal(env.ledger.currentChampion("js-1").attempt, id);
  });

  test("a wrong kernel is invalid and a crashing one is crash_candidate; the champion stays", async () => {
    const env = await setup();
    const wrong = await env.submit(WRONG_KERNEL, "return early");
    const crash = await env.submit(CRASH_KERNEL, "exit");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(wrong)?.verdict, "invalid");
    assert.equal(env.ledger.currentVerdict(crash)?.verdict, "crash_candidate");
    assert.equal(env.ledger.currentChampion("js-1").seq, 1);
  });

  test("a change that does not build is invalid", async () => {
    const env = await setup();
    const id = await env.submit("export function work( {\n", "syntax error");
    await env.drain();
    // The build only copies files, so the syntax error surfaces when the run imports it.
    assert.ok(
      ["invalid", "crash_candidate"].includes(String(env.ledger.currentVerdict(id)?.verdict)),
    );
    assert.equal(env.ledger.currentChampion("js-1").seq, 1);
  });

  test("without an auto policy a confirmed win waits for approval", async () => {
    const env = await setup({ promotion: "owner_approval" });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(id)?.verdict, "win_confirmed", why(env, id));
    assert.equal(env.ledger.currentChampion("js-1").seq, 1);
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "awaiting_approval");
    const pending = env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "promotion_pending");
    assert.equal(pending.length, 1);
  });

  test("a target that never becomes ready ends in crash_infra, retried once, then errored", async () => {
    const env = await setup({ neverReady: true });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    const history = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((r) => r.verdict);
    assert.deepEqual(history, ["crash_infra", "crash_infra"]);
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "errored");
  });

  test("a win screened against a champion that has since moved is screened again", async () => {
    const env = await setup();
    const a = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    const b = await env.submit(`${FAST_KERNEL}// same idea, restated\n`, "the same, restated");
    assert.ok(await env.judge.tick()); // screens a
    assert.equal(env.ledger.currentVerdict(a)?.verdict, "win_screened");
    // Meanwhile b becomes the champion by another path.
    env.ledger.recordVerdict({ attempt: b, verdict: "win_confirmed", reasons: "t", judgedBy: "t" });
    const commit = String(env.ledger.getAttempt(b)?.commit_sha);
    assert.deepEqual(
      env.ledger.promote({
        run: "js-1",
        expectedSeq: 1,
        attempt: b,
        commitSha: commit,
        by: "t",
      }),
      { ok: true, seq: 2 },
    );
    assert.ok(await env.judge.tick()); // a's confirm job: the champion moved
    assert.equal(String(env.ledger.getAttempt(a)?.lifecycle), "queued");
    const queued = env.ledger.db
      .prepare(
        "select count(*) as n from job where attempt = ? and kind = 'evaluate' and state = 'queued'",
      )
      .get(a);
    assert.equal(Number(queued?.n), 1);
  });

  test("goal mode: the seed is validated; an attempt that meets a new goal completes the campaign", async () => {
    const env = await setup({ goal: { opsPerSecond: 90e6 }, promotion: "auto" });
    await env.drain(); // validates the seed
    const status = () =>
      Object.fromEntries(
        env.ledger.db
          .prepare("select id, status from goal where run = 'js-1'")
          .all()
          .map((g) => [g.id, g.status]),
      );
    assert.deepEqual(status(), { correct: "verified", fast: "unmet", readable: "not_runnable" });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.equal(
      env.ledger.currentVerdict(id)?.verdict,
      "goal_progress",
      JSON.stringify(
        env.ledger.db.prepare("select goal, attempt, result, detail from goal_check").all(),
      ),
    );
    assert.equal(env.ledger.currentChampion("js-1").seq, 2);
    assert.equal(status().fast, "verified");
    assert.equal(env.ledger.getRun("js-1")?.status, "closed");
    const report = env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "goal_complete");
    assert.equal(report.length, 1);
    // Screened, then confirmed in fresh runs; completion needed two agreeing validations.
    const verdicts = env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((v) => v.verdict);
    assert.deepEqual(verdicts, ["goal_screened", "goal_progress"]);
    const complete = env.ledger.db
      .prepare(
        "select count(*) as n from job where kind = 'validate' and state = 'done' and json_extract(result, '$.complete') = 1",
      )
      .get();
    assert.equal(Number(complete?.n), 2);
  });

  test("goal mode: priority gates skip a goal whose gate did not pass", async () => {
    const env = await setup({
      goal: { opsPerSecond: 90e6 },
      promotion: "auto",
      kitVerifiers: {
        correctness: { cells: ["small"], priority: 1 },
        heavy: { cells: ["big"], priority: 2, requires: ["correctness"] },
      },
      contract: {
        // The gated goal comes first in the contract: priority, not order, decides what runs first.
        goals: [
          // Unmet by the seed, so the campaign stays open for the attempt below.
          {
            id: "fast",
            description: "fast enough",
            verify: {
              type: "metric_threshold",
              metric: "ops_per_s",
              op: ">=",
              value: 90e6,
              cells: ["big"],
            },
          },
          {
            id: "heavy-goal",
            description: "the big case",
            verify: { type: "code", verifier: "heavy" },
          },
          {
            id: "correct",
            description: "still correct",
            verify: { type: "code", verifier: "correctness" },
          },
        ],
      },
    });
    await env.drain(); // validates the seed: correct, so both gates open
    const checks = (attempt: string | null) =>
      env.ledger.db
        .prepare(
          `select goal, result, detail from goal_check where ${attempt ? "attempt = ?" : "attempt is null"} order by id`,
        )
        .all(...(attempt ? [attempt] : [])) as { goal: string; result: string; detail: string }[];
    const seed = checks(null);
    assert.ok(
      seed.some((c) => c.goal === "heavy-goal" && c.result === "met"),
      JSON.stringify(seed),
    );
    // A wrong kernel fails the gate, so the heavy goal is not run at all.
    const wrong = await env.submit(WRONG_KERNEL, "return early");
    await env.drain();
    const got = checks(wrong);
    const heavy = got.find((c) => c.goal === "heavy-goal");
    assert.ok(heavy, env.explain(wrong));
    assert.match(String(heavy?.detail), /not run: it requires correctness, which did not pass/);
    assert.ok(
      got.some((c) => c.goal === "correct" && c.result !== "met"),
      JSON.stringify(got),
    );
  });

  test("goal mode: a failed validation is tried again, a few times, spaced out", async () => {
    const env = await setup({ goal: { opsPerSecond: 90e6 }, promotion: "auto" });
    // A validation that failed for an infrastructure reason.
    const jobId = env.ledger.enqueueJob({
      kind: "validate",
      spec: { run: "js-1", champion_seq: 1 },
      actor: "t",
    });
    env.ledger.db.prepare("update job set state = 'failed', result = '{}' where id = ?").run(jobId);
    const queued = () =>
      Number(
        env.ledger.db
          .prepare("select count(*) as n from job where kind = 'validate' and state = 'queued'")
          .get()?.n,
      );
    env.judge.tick = env.judge.tick.bind(env.judge);
    // Too soon after the failure: nothing new.
    (env.judge as unknown as { maybeScheduleValidation(): void }).maybeScheduleValidation();
    assert.equal(queued(), 0);
    env.ledger.db
      .prepare("update job set updated_at = ? where id = ?")
      .run(new Date(Date.now() - 11 * 60_000).toISOString(), jobId);
    (env.judge as unknown as { maybeScheduleValidation(): void }).maybeScheduleValidation();
    assert.equal(queued(), 1);
  });

  test("held-out results stay out of events and exports", async () => {
    const env = await setup({ heldOut: true });
    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(id)?.verdict, "win_confirmed", why(env, id));
    const rows = env.ledger.db.prepare("select count(*) as n from held_out").get();
    assert.equal(Number(rows?.n), 1);
    const leaked = env.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => JSON.stringify(e.body).includes("held"));
    assert.deepEqual(leaked, []);
    const exp = await env.service.export("test");
    const { DatabaseSync } = await import("node:sqlite");
    const snap = new DatabaseSync(`${exp.dir}/ledger.sqlite`);
    const tables = snap
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((r) => r.name);
    snap.close();
    assert.ok(!tables.includes("held_out"));
  });
});
