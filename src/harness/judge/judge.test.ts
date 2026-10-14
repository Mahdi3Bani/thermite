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
        { instance: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
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
        instance: "js-1",
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
