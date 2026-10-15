import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "../../testing/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv, WRONG_KERNEL } from "../../testing/judge-env.ts";
import { LocalRunner } from "../broker/runner.ts";
import { Scheduler } from "./scheduler.ts";
import { runTrial } from "./worker.ts";

const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("./lanetool.ts", import.meta.url)),
];

/** A scheduler with no model, for its registry. */
function scheduler0(env: ReturnType<typeof makeJudgeEnv>) {
  return new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    owner: "s0",
    runTrial: async () => ({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
  });
}

describe("agent scheduler", () => {
  test("an epoch: plan, one trial per lane, judged, lane best kept, next epoch planned", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    // One fake model plays planner and workers: lane-1 writes a faster kernel, lane-2 a wrong one.
    const fake = await startFakeModel(({ messages, tools }) => {
      if (tools.some((t) => t.function.name === "submit_plan")) {
        return {
          toolCalls: [
            {
              name: "submit_plan",
              args: {
                new_families: [{ id: "loops", description: "simplify the inner loop" }],
                assignments: [
                  {
                    lane: "lane-1",
                    family: "loops",
                    focus: "remove wasted work",
                    parent: "champion",
                  },
                  {
                    lane: "lane-2",
                    family: "loops",
                    focus: "try a closed form",
                    parent: "champion",
                  },
                ],
              },
            },
          ],
        };
      }
      const brief = JSON.stringify(messages[1] ?? messages[0]);
      const kernel = brief.includes("lane-1") ? FAST_KERNEL : WRONG_KERNEL;
      const done = messages.filter((m) => m.role === "tool").length;
      const steps = [
        { name: "write_file", args: { path: "src/kernel/work.mjs", content: kernel } },
        {
          name: "submit",
          args: { hypothesis: brief.includes("lane-1") ? "drop waste" : "closed form" },
        },
      ];
      return steps[done] ? { toolCalls: [steps[done]] } : { text: "done" };
    });
    const runner = new LocalRunner(env.paths.scratchDir);
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "scheduler-test",
      maxConcurrent: 2,
      runTrial: (spec) =>
        runTrial(spec, {
          runner,
          laneTool,
          model,
          // As over the API: the trial's token decides run, lane and parent.
          submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
          status: async (id) => env.service.attemptStatus(id),
        }),
    });
    assert.ok(await scheduler.tick()); // plans epoch 1 and starts both lanes
    await scheduler.idle();
    await env.drain(); // the judge decides both submissions
    await scheduler.tick(); // lane bests, epoch 1 ends
    await scheduler.tick(); // epoch 2 planned
    const epochs = env.ledger.db.prepare("select n, source from epoch order by n").all();
    assert.deepEqual(
      epochs.map((e) => [e.n, e.source]),
      [
        [1, "planner"],
        [2, "planner"],
      ],
    );
    const trials = env.ledger.db
      .prepare("select lane, attempt, stopped from trial where epoch = 1 order by lane")
      .all();
    assert.deepEqual(
      trials.map((t) => t.stopped),
      ["submitted", "submitted"],
    );
    const winner = String(trials[0]?.attempt);
    assert.equal(env.ledger.currentVerdict(winner)?.verdict, "win_confirmed");
    assert.equal(env.ledger.currentVerdict(String(trials[1]?.attempt))?.verdict, "invalid");
    // The win became the champion, so it is no lane's separate best.
    assert.equal(env.ledger.currentChampion("js-1").attempt, winner);
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), null);
    assert.equal(scheduler.registry.laneBest("js-1", "lane-2"), null);
    assert.equal(String(env.ledger.getAttempt(winner)?.family), "loops");
    await scheduler.idle();
    await fake.close();
  });

  test("a lane best is a win measured against the current champion, and is dropped when it moves", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      runTrial: async () => ({
        stopped: "no_submission",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    const a = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          lane: "lane-1",
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "a",
          known_flaws: [],
        },
        "t",
      )
    ).attempt;
    env.ledger.recordVerdict({
      attempt: a,
      verdict: "win_screened",
      delta: 0.1,
      reasons: "t",
      judgedBy: "t",
    });
    await scheduler.tick();
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), a);
    // Another attempt becomes the champion: a's delta was measured against the old one.
    const b = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          patch_base64: env.patch(`${FAST_KERNEL}// b\n`),
          hypothesis: "b",
          known_flaws: [],
        },
        "t",
      )
    ).attempt;
    env.ledger.recordVerdict({
      attempt: b,
      verdict: "win_confirmed",
      delta: 0.1,
      reasons: "t",
      judgedBy: "t",
    });
    env.ledger.promote({
      run: "js-1",
      expectedSeq: 1,
      attempt: b,
      commitSha: String(env.ledger.getAttempt(b)?.commit_sha),
      by: "t",
    });
    await scheduler.tick();
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), null);
    await scheduler.idle();
  });

  test("a worker's token binds its submission to its trial, once, and only while the trial is open", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      runTrial: async (spec) => {
        const req = { patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] };
        const r = await env.service.submitForTrial(String(spec.token), req);
        await assert.rejects(
          env.service.submitForTrial(String(spec.token), req),
          /already submitted/,
        );
        await assert.rejects(env.service.submitForTrial("not-a-token", req), /unknown trial/);
        tokens.push(String(spec.token));
        return {
          submitted: r,
          stopped: "submitted",
          turns: 1,
          toolCalls: 1,
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    });
    const tokens: string[] = [];
    await scheduler.tick();
    await scheduler.idle();
    const t = env.ledger.db.prepare("select lane, attempt from trial").get();
    const a = env.ledger.getAttempt(String(t?.attempt));
    assert.equal(a?.lane, "lane-1");
    assert.equal(a?.family, env.ledger.db.prepare("select family from trial").get()?.family);
    // The trial has ended: its token no longer works.
    await assert.rejects(
      env.service.submitForTrial(String(tokens[0]), {
        patch_base64: env.patch(`${FAST_KERNEL}// late\n`),
        hypothesis: "late",
        known_flaws: [],
      }),
      /has ended/,
    );
  });

  test("reset_workers kills the running trials, clears lane bests and starts a fresh epoch", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
    await env.service.applyCommand(env.assign);
    let aborted = 0;
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      runTrial: (_spec, signal) =>
        new Promise((resolve) => {
          started();
          signal.addEventListener("abort", () => {
            aborted++;
            resolve({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 });
          });
        }),
    });
    await scheduler.tick(); // epoch 1, a trial that runs until it is killed
    await running;
    const r = await env.service.applyCommand(env.sign("reset_workers", { run: "js-1" }));
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    const refused = await env.service.applyCommand(
      env.sign("reset_workers", { run: "js-1", reseed_commit: "a".repeat(40) }),
    );
    assert.ok(refused.status === "applied" && !refused.accepted);
    await scheduler.tick(); // applies the reset, then plans epoch 2
    assert.equal(aborted, 1);
    const trial = env.ledger.db.prepare("select stopped from trial order by started_at").get();
    assert.equal(trial?.stopped, "interrupted");
    const epochs = env.ledger.db.prepare("select n, ended_at from epoch order by n").all();
    assert.equal(epochs.length, 2);
    assert.ok(epochs[0]?.ended_at);
    for (const a of (
      scheduler as unknown as { aborts: Map<string, AbortController> }
    ).aborts.values())
      a.abort();
    await scheduler.idle();
  });

  test("a pause stops the run's planner call and running trials at once", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
    await env.service.applyCommand(env.assign);
    // A model route that never answers: the planner call hangs until it is cancelled.
    let requests = 0;
    const hang = createServer(() => {
      requests++;
    });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const port = (hang.address() as AddressInfo).port;
    const model = {
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
      apiKey: "k",
      contextWindow: 1000,
      maxTokens: 10,
    };
    const runTrial = (_spec: unknown, signal: AbortSignal) =>
      new Promise<{ stopped: "error"; turns: 0; toolCalls: 0; tokensIn: 0; tokensOut: 0 }>(
        (resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
          );
        },
      );
    const planning = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model,
      owner: "s",
      runTrial,
    });
    const tick = planning.tick();
    while (requests === 0) await new Promise((r) => setTimeout(r, 50));
    const paused = await env.service.applyCommand(
      env.sign("pause_run", { run: "js-1", reason: "test" }),
    );
    assert.ok(paused.status === "applied" && paused.accepted, JSON.stringify(paused));
    const t0 = Date.now();
    await tick;
    assert.ok(Date.now() - t0 < 5000, `the planner call took ${Date.now() - t0} ms to stop`);
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from epoch").get()?.n,
      0,
      "no epoch after a pause",
    );
    hang.closeAllConnections();
    hang.close();

    // A running trial: the pause kills it without waiting for the next tick.
    const resumed = await env.service.applyCommand(env.sign("resume_run", { run: "js-1" }));
    assert.ok(resumed.status === "applied" && resumed.accepted, JSON.stringify(resumed));
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
    const s2 = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { ...model, baseUrl: fake.url },
      owner: "s",
      runTrial,
    });
    await s2.tick();
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from trial where ended_at is null").get()?.n,
      1,
    );
    await env.service.applyCommand(env.sign("pause_run", { run: "js-1", reason: "test" }));
    const t1 = Date.now();
    await s2.idle();
    assert.ok(Date.now() - t1 < 5000);
    assert.equal(env.ledger.db.prepare("select stopped from trial").get()?.stopped, "interrupted");
    await fake.close();
  });

  test("a judge-only run plans no epoch and starts no trial", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 }, agents: false });
    const r = await env.service.applyCommand(env.assign);
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    assert.equal(env.ledger.getRun("js-1")?.agents, false);
    let asked = 0;
    const fake = await startFakeModel(() => {
      asked++;
      return { text: "no" };
    });
    const s = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 1000, maxTokens: 10 },
      owner: "s",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    assert.equal(await s.tick(), false);
    await fake.close();
    assert.equal(asked, 0);
    assert.equal(env.ledger.db.prepare("select count(*) as n from epoch").get()?.n, 0);
    // The judge still works on it: a submitted attempt is judged.
    const sub = (await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "less work",
        known_flaws: [],
      },
      "proposer",
    )) as { attempt: string };
    await env.drain();
    assert.ok(env.ledger.currentVerdict(sub.attempt), "the judge gave the attempt a verdict");
  });

  test("a dev run that waited past its trial's end never runs", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const { DevRuns } = await import("./devrun.ts");
    const runner = new LocalRunner(env.paths.scratchDir);
    const dev = new DevRuns({
      runner,
      ledger: env.ledger,
      scratchDir: env.paths.scratchDir,
      gpu: false,
    });
    const registry = scheduler0(env).registry;
    registry.startTrial({
      id: "t-x",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "tok",
    });
    registry.finishTrial(
      "t-x",
      { stopped: "wall", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "t",
    );
    const { mkdirSync } = await import("node:fs");
    const cwd = `${env.paths.scratchDir}/lanes/lane-1/ws/repo`;
    mkdirSync(cwd, { recursive: true });
    const r = (await dev.run({ lane: "lane-1", command: "echo ran", cwd }, "t-x")) as {
      ran: boolean;
      reason: string;
    };
    assert.equal(r.ran, false);
    assert.match(r.reason, /ended/);
    await dev.settle("lane-1");
  });

  test("with a dedicated development card, dev runs and the judge do not wait for each other", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    // A judge job that nothing drains here: the judge is busy throughout.
    env.ledger.enqueueJob({ kind: "calibrate", priority: 10, spec: { run: "js-1" }, actor: "t" });
    const { DevRuns } = await import("./devrun.ts");
    const runner = new LocalRunner(env.paths.scratchDir);
    scheduler0(env).registry.startTrial({
      id: "t-d",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "tok",
    });
    const { mkdirSync } = await import("node:fs");
    const cwd = `${env.paths.scratchDir}/lanes/lane-1/ws/repo`;
    mkdirSync(cwd, { recursive: true });
    const make = (opts: { dedicated?: boolean; unavailable?: string }) =>
      new DevRuns({
        runner,
        ledger: env.ledger,
        scratchDir: env.paths.scratchDir,
        gpu: false,
        maxWaitMs: 300,
        ...opts,
      });
    type Result = { ran: boolean; reason?: string; stdout?: string };
    const shared = (await make({}).run(
      { lane: "lane-1", command: "echo ran", cwd },
      "t-d",
    )) as Result;
    assert.equal(shared.ran, false);
    assert.match(String(shared.reason), /judge kept the device busy/);
    const dedicated = make({ dedicated: true });
    const pending = dedicated.run({ lane: "lane-1", command: "sleep 0.2; echo ran", cwd }, "t-d");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(dedicated.active, false, "the judge never waits for a dev run on its own card");
    const ran = (await pending) as Result;
    assert.equal(ran.ran, true);
    assert.match(String(ran.stdout), /ran/);
    const ev = env.ledger.db
      .prepare("select body from event where kind = 'dev_run' order by id desc limit 1")
      .get() as { body: string };
    const body = JSON.parse(ev.body) as { command: string; peak_rss_mib: number };
    assert.equal(body.command, "sleep 0.2; echo ran");
    assert.equal(typeof body.peak_rss_mib, "number");
    const off = (await make({ unavailable: "the dedicated development card is not set up: x" }).run(
      { lane: "lane-1", command: "echo ran", cwd },
      "t-d",
    )) as Result;
    assert.equal(off.ran, false);
    assert.match(String(off.reason), /not set up/);
  });

  test("a fork round at a third of the wall budget sends every lane back to the champion", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: { budget: { wall_hours: 1, max_open_attempts: 4 } },
    });
    await env.service.applyCommand(env.assign);
    const a = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          lane: "lane-1",
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "a",
          known_flaws: [],
        },
        "t",
      )
    ).attempt;
    env.ledger.recordVerdict({
      attempt: a,
      verdict: "win_screened",
      delta: 0.1,
      reasons: "t",
      judgedBy: "t",
    });
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    scheduler.registry.setLaneBest("js-1", "lane-1", a, "t");
    // 40% of the hour has passed.
    env.ledger.db
      .prepare("update run set created_at = ? where id = 'js-1'")
      .run(new Date(Date.now() - 0.4 * 3_600_000).toISOString());
    await scheduler.tick();
    await scheduler.idle();
    const rounds = env.ledger.eventsAfter(0, 10_000).events.filter((e) => e.kind === "fork_round");
    assert.equal(rounds.length, 1);
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), null);
  });

  test("lanes back off after unproductive trials", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 5 } });
    await env.service.applyCommand(env.assign);
    let started = 0;
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      backoffBaseMs: 60_000,
      runTrial: async () => {
        started++;
        return {
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
          error: "model down",
        };
      },
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.tick(); // within the backoff: no new trial
    await scheduler.idle();
    assert.equal(started, 1);
  });

  test("after a restart, trials a dead controller left open are closed and their lanes go on", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 2 } });
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const model = {
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const first = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "s1",
      runTrial: () => new Promise(() => {}),
    });
    await first.tick(); // plans (fallback: no reachable model) and starts a trial that never ends
    const open = env.ledger.db
      .prepare("select count(*) as n from trial where ended_at is null")
      .get();
    assert.equal(Number(open?.n), 1);
    let started = 0;
    const second = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "s2",
      runTrial: async () => {
        started++;
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    const stopped = env.ledger.db
      .prepare("select stopped from trial order by started_at")
      .all()
      .map((t) => t.stopped);
    assert.deepEqual(stopped, ["interrupted"]);
    assert.ok(await second.tick()); // the lane's next trial starts
    await second.idle();
    assert.equal(started, 1);
  });
});
