import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { signEnvelope } from "../core/commands.ts";
import { parseContract } from "../core/contract.ts";
import { startFakeModel } from "../testing/fake-model.ts";
import { researchFixture } from "../testing/fixtures.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../testing/judge-env.ts";
import { Scheduler } from "./agents/scheduler.ts";
import { LocalRunner } from "./broker/runner.ts";
import { Research } from "./research/research.ts";

/**
 * The owner closes a run by hand (goal 087): close_run ends it for good, as goal completion does,
 * with the owner's reason. Its trials stop as for a pause, nothing new starts, its jobs waiting
 * for the judge never run, it can't be paused or resumed again, and its records and export stay.
 */

type Applied = { status: string; accepted?: boolean; result?: unknown; reason?: string };

/** A trial that runs until it is stopped. */
const heldTrial = (_spec: unknown, signal: AbortSignal) =>
  new Promise<{ stopped: "error"; turns: 0; toolCalls: 0; tokensIn: 0; tokensOut: 0 }>(
    (resolve) => {
      signal.addEventListener("abort", () =>
        resolve({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
      );
    },
  );

const count = (env: { ledger: { db: { prepare(s: string): { get(): unknown } } } }, sql: string) =>
  Number((env.ledger.db.prepare(sql).get() as { n: number }).n);

describe("close_run (goal 087)", () => {
  test("the owner closes a running run: its trial stops, nothing new starts, its judge jobs never run, and it stays closed", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
    await env.service.applyCommand(env.assign);
    // A change waiting for the judge when the run closes.
    const sub = (await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "less work",
        known_flaws: [],
      },
      "proposer",
    )) as { attempt: string };
    const fake = await startFakeModel(() => ({
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            assignments: [{ lane: "lane-1", family: "loops", focus: "f", parent: "champion" }],
            new_families: [{ id: "loops", description: "d" }],
          },
        },
      ],
    }));
    const s = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 200 },
      owner: "s",
      runTrial: heldTrial,
    });
    await s.tick();
    assert.equal(count(env, "select count(*) as n from trial where ended_at is null"), 1);
    const apply = (
      kind: "close_run" | "resume_run" | "pause_run",
      payload: unknown,
      by = "owner",
    ) =>
      env.service.applyCommand(
        signEnvelope(
          {
            v: 1,
            id: randomUUID(),
            rig: "rig-a",
            kind,
            issued_by: by,
            issued_at: new Date(Date.now() - 1000).toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            payload,
          },
          env.keys.privateKeyPem,
        ),
      ) as Promise<Applied>;
    const why = "another run finished the work";

    // Only the owner closes a run.
    const byAgent = await apply("close_run", { run: "js-1", reason: why }, "agent:mcp");
    assert.equal(byAgent.accepted, false);
    assert.match(
      JSON.stringify(byAgent.result),
      /close_run is the owner's to issue, not agent:mcp's/,
    );
    assert.equal(env.ledger.getRun("js-1")?.status, "running");
    // A reason of spaces alone is no reason: the payload is refused before anything changes.
    const blank = await apply("close_run", { run: "js-1", reason: "   " });
    assert.equal(blank.status, "rejected");
    assert.match(String(blank.reason), /bad payload: reason/);

    const closed = await apply("close_run", { run: "js-1", reason: why }, "owner:ui");
    assert.equal(closed.accepted, true, JSON.stringify(closed));
    assert.deepEqual(closed.result, { run: "js-1", status: "closed", was: "running" });
    const run = env.ledger.getRun("js-1");
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", why]);
    assert.deepEqual(env.ledger.latestEventBody("run_status", "js-1"), {
      status: "closed",
      reason: why,
    });
    const ev = env.ledger.db
      .prepare("select actor from event where kind = 'run_status' order by id desc limit 1")
      .get() as { actor: string };
    assert.equal(ev.actor, "control:owner:ui");

    // Its trial stops at once, as for a pause; no new round or trial starts.
    const t0 = Date.now();
    await s.idle();
    assert.ok(Date.now() - t0 < 5000, `the trial took ${Date.now() - t0} ms to stop`);
    assert.equal(env.ledger.db.prepare("select stopped from trial").get()?.stopped, "interrupted");
    assert.ok(
      env.ledger.db
        .prepare("select 1 from event where kind = 'trial_stopped' and subject = 'js-1'")
        .get(),
      "the trial's stop is recorded",
    );
    const epochs = count(env, "select count(*) as n from epoch");
    assert.equal(await s.tick(), false);
    assert.equal(count(env, "select count(*) as n from trial"), 1, "no new trial");
    assert.equal(count(env, "select count(*) as n from epoch"), epochs, "no new round");

    // The judge leases no job of a closed run: the change stays queued, its attempt kept.
    assert.equal(await env.judge.tick(), false);
    assert.equal(
      env.ledger.db.prepare("select state from job where attempt = ?").get(sub.attempt)?.state,
      "queued",
    );
    assert.equal(env.ledger.currentVerdict(sub.attempt), undefined);
    assert.ok(env.ledger.getAttempt(sub.attempt), "the attempt stays");
    assert.equal(env.ledger.currentChampion("js-1").seq, 1, "the champion stays");

    // It stays closed: no resume, no pause, no second close.
    const resumed = await apply("resume_run", { run: "js-1" });
    assert.equal(resumed.accepted, false);
    assert.deepEqual(resumed.result, { error: "run js-1 is closed" });
    const paused = await apply("pause_run", { run: "js-1", reason: "then resume it" });
    assert.equal(paused.accepted, false);
    assert.deepEqual(paused.result, { error: "run js-1 is closed" });
    const again = await apply("close_run", { run: "js-1", reason: "twice" });
    assert.equal(again.accepted, false);
    assert.deepEqual(again.result, {
      error: `run js-1 is already closed (${why}): there is nothing to close`,
    });
    assert.deepEqual(
      [env.ledger.getRun("js-1")?.status, env.ledger.getRun("js-1")?.pause_reason],
      ["closed", why],
    );
    const unknown = await apply("close_run", { run: "js-9", reason: why });
    assert.deepEqual(unknown.result, { error: "no run js-9" });

    // The export after it closes carries the end, and the run's attempt.
    const out = await env.service.export("test");
    const events = readFileSync(join(out.dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; subject: string; body: unknown });
    assert.ok(
      events.some(
        (e) =>
          e.kind === "run_status" &&
          e.subject === "js-1" &&
          JSON.stringify(e.body) === JSON.stringify({ reason: why, status: "closed" }),
      ),
      "the export has the run's close",
    );
    assert.ok(events.some((e) => e.kind === "attempt_recorded" && e.subject === sub.attempt));
    await fake.close();
  });

  test("a paused run closes too, and a job the judge had already taken ends without reopening it", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1 } });
    await env.service.applyCommand(env.assign);
    // A validation the judge took while the run was running, which would close it as complete.
    env.ledger.enqueueJob({ kind: "validate", priority: 1, spec: { run: "js-1" }, actor: "t" });
    const job = env.ledger.leaseJob("judge-test", 60_000, ["validate"]);
    assert.ok(job);
    await env.service.applyCommand(env.sign("pause_run", { run: "js-1", reason: "seen enough" }));
    const closed = (await env.service.applyCommand(
      env.sign("close_run", { run: "js-1", reason: "done elsewhere" }),
    )) as Applied;
    assert.deepEqual(closed.result, { run: "js-1", status: "closed", was: "paused" });
    // The judge's finish of that job keeps the owner's reason.
    const judge = env.judge as unknown as {
      finish(j: unknown, fin: { result: unknown; close: { run: string; reason: string } }): void;
    };
    judge.finish(job, {
      result: {},
      close: { run: "js-1", reason: "every required goal is met" },
    });
    assert.deepEqual(
      [env.ledger.getRun("js-1")?.status, env.ledger.getRun("js-1")?.pause_reason],
      ["closed", "done elsewhere"],
    );
  });

  test("a research run closed by the owner gets its final report once its trial ends", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract({ ...researchFixture, lanes: { count: 1, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    const research = new Research(env.service.ledger, env.service.paths.stateDir, {
      allowPrivate: true,
    });
    const s = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      research,
      runTrial: heldTrial,
      runResearchTrial: heldTrial,
    });
    const finals = () =>
      Number(
        (
          env.service.ledger.db
            .prepare("select count(*) as n from event where kind = 'research_final'")
            .get() as { n: number }
        ).n,
      );
    await s.tick();
    assert.equal(
      Number(
        (
          env.service.ledger.db
            .prepare("select count(*) as n from trial where ended_at is null")
            .get() as { n: number }
        ).n,
      ),
      1,
    );
    const closed = (await env.service.applyCommand(
      env.sign("close_run", { run: "r-1", reason: "the question is answered elsewhere" }),
    )) as Applied;
    assert.equal(closed.accepted, true, JSON.stringify(closed));
    await s.idle();
    assert.equal(await s.tick(), false);
    assert.equal(finals(), 1, "its final report is written");
    const report = env.service.ledger.db
      .prepare("select body from report_version where kind = 'final'")
      .get() as { body: string };
    assert.match(report.body, /^# /);
    await s.tick();
    assert.equal(finals(), 1, "once");
    assert.equal(env.service.ledger.getRun("r-1")?.status, "closed");
  });
});
