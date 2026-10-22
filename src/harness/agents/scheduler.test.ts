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
    assert.equal(env.ledger.currentVerdict(winner)?.verdict, "win_confirmed", env.explain(winner));
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
      runTrial: (spec, signal) =>
        new Promise((resolve) => {
          // The worker reports its counters as it works (after each turn), then is killed.
          env.service.trialProgress.set(spec.trialId, {
            turns: 7,
            tool_calls: 12,
            tokens_in: 5000,
            tokens_out: 300,
          });
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
    const trial = env.ledger.db
      .prepare("select stopped, turns, tokens_in, tokens_out from trial order by started_at")
      .get();
    assert.equal(trial?.stopped, "interrupted");
    // The killed worker reported nothing at the end: its last counters are kept, not zeros.
    assert.deepEqual(
      [trial?.turns, trial?.tokens_in, trial?.tokens_out].map(Number),
      [7, 5000, 300],
    );
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

  test("a dev run behind another lane's waits with no time limit, and gives up when its trial ends (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const { DevRuns } = await import("./devrun.ts");
    const dev = new DevRuns({
      runner: new LocalRunner(env.paths.scratchDir),
      ledger: env.ledger,
      scratchDir: env.paths.scratchDir,
      gpu: false,
      dedicated: true,
    });
    const registry = scheduler0(env).registry;
    const { mkdirSync } = await import("node:fs");
    const cwd = (lane: string) => {
      const d = `${env.paths.scratchDir}/lanes/${lane}/ws/repo`;
      mkdirSync(d, { recursive: true });
      return d;
    };
    for (const lane of ["lane-1", "lane-2"])
      registry.startTrial({
        id: `t-${lane}`,
        run: "js-1",
        lane,
        epoch: 1,
        family: "f",
        parent: env.seed,
        token: `tok-${lane}`,
      });
    const long = dev.run({ lane: "lane-1", command: "sleep 1", cwd: cwd("lane-1") }, "t-lane-1");
    let settled = false;
    const behind = dev
      .run({ lane: "lane-2", command: "echo ran", cwd: cwd("lane-2") }, "t-lane-2")
      .then((r) => {
        settled = true;
        return r as { ran: boolean; reason: string };
      });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, "it waits: no time limit of its own");
    // Its trial ends: it gives up at once, and the trial's end does not wait behind lane-1.
    const t0 = Date.now();
    await dev.settle("lane-2");
    assert.ok(Date.now() - t0 < 500);
    const r = await behind;
    assert.equal(r.ran, false);
    assert.match(r.reason, /the trial ended before a device was free/);
    assert.equal(((await long) as { ran: boolean }).ran, true);
  });

  test("no time cap on a round or a trial unless one is set (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const walls: (number | undefined)[] = [];
    let release: () => void = () => undefined;
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
      backoffBaseMs: 0,
      runTrial: (spec) => {
        walls.push(spec.wallMs);
        return new Promise((resolve) => {
          release = () =>
            resolve({
              stopped: "no_submission",
              turns: 1,
              toolCalls: 0,
              tokensIn: 0,
              tokensOut: 0,
            });
        });
      },
    });
    assert.ok(await scheduler.tick());
    while (!walls.length) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(walls, [undefined], "no trial length unless set");
    // The round started four hours ago and its trial still runs: the round stays open.
    env.ledger.db
      .prepare("update epoch set started_at = ?")
      .run(new Date(Date.now() - 4 * 3_600_000).toISOString());
    await scheduler.tick();
    assert.equal(scheduler.registry.currentEpoch("js-1")?.ended_at, null);
    release();
    await scheduler.idle();
    // Its trial is done: the round ends because it is complete, not at a time.
    await scheduler.tick();
    assert.notEqual(scheduler.registry.currentEpoch("js-1")?.ended_at, null);
    // A trial length the rig sets reaches the trial.
    scheduler.configure({ trialWallMs: 45 * 60_000 });
    for (let i = 0; i < 200 && walls.length < 2; i++) {
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(walls[1], 45 * 60_000);
    release();
    await scheduler.idle();
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

  test("a dev run's time limit: none on a dedicated card, the shared default otherwise; a run stuck behind another lane's gives up", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const { DevRuns } = await import("./devrun.ts");
    const { SHARED_DEV_RUN_S } = await import("../../core/contract.ts");
    const inner = new LocalRunner(env.paths.scratchDir);
    const seen: (number | undefined)[] = [];
    const runner = Object.assign(Object.create(inner), {
      run: (req: Parameters<LocalRunner["run"]>[0]) => {
        seen.push(req.timeoutMs);
        return inner.run(req);
      },
    }) as LocalRunner;
    const registry = scheduler0(env).registry;
    for (const lane of ["lane-1", "lane-2"]) {
      registry.startTrial({
        id: `t-${lane}`,
        run: "js-1",
        lane,
        epoch: 1,
        family: "f",
        parent: env.seed,
        token: `tok-${lane}`,
      });
    }
    const { mkdirSync } = await import("node:fs");
    const cwd = (lane: string) => {
      const d = `${env.paths.scratchDir}/lanes/${lane}/ws/repo`;
      mkdirSync(d, { recursive: true });
      return d;
    };
    const make = (dedicated: boolean, maxWaitMs = 10_000) =>
      new DevRuns({
        runner,
        ledger: env.ledger,
        scratchDir: env.paths.scratchDir,
        gpu: false,
        dedicated,
        maxWaitMs,
      });
    const limits: { rssMib: number; diskMib: number; timeoutS?: number } = {
      rssMib: 512,
      diskMib: 512,
    };
    const one = (dev: InstanceType<typeof DevRuns>, extra: Record<string, unknown>, l = limits) =>
      dev.run({ lane: "lane-1", command: "true", cwd: cwd("lane-1"), ...extra }, "t-lane-1", l);
    await one(make(true), {});
    await one(make(false), {});
    await one(make(false), { timeout_s: 60 });
    await one(make(true), { timeout_s: 9000 }, { ...limits, timeoutS: 1800 });
    assert.deepEqual(seen, [undefined, SHARED_DEV_RUN_S * 1000, 60_000, 1_800_000]);
    // Lane-1's long dev run holds the card; lane-2's, waiting longer than maxWaitMs, is told so.
    const dev = make(true, 300);
    const long = dev.run(
      { lane: "lane-1", command: "sleep 1.5", cwd: cwd("lane-1") },
      "t-lane-1",
      limits,
    );
    const behind = (await dev.run(
      { lane: "lane-2", command: "echo ran", cwd: cwd("lane-2") },
      "t-lane-2",
      limits,
    )) as { ran: boolean; reason: string };
    assert.equal(behind.ran, false);
    assert.match(behind.reason, /another lane's dev run held the device/);
    const settled = Date.now();
    await dev.settle("lane-2"); // lane-2's trial end does not wait behind lane-1
    assert.ok(Date.now() - settled < 500);
    assert.equal(((await long) as { ran: boolean }).ran, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.length, 5, "the one that gave up never ran");
  });

  test("development cards are a pool: any free card, a wait only when all are busy, one dev run per lane at a time", async () => {
    const env = makeJudgeEnv({ lanes: { count: 3, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const { DevRuns } = await import("./devrun.ts");
    const registry = scheduler0(env).registry;
    for (const lane of ["lane-1", "lane-2", "lane-3"]) {
      registry.startTrial({
        id: `t-${lane}`,
        run: "js-1",
        lane,
        epoch: 1,
        family: "f",
        parent: env.seed,
        token: `tok-${lane}`,
      });
    }
    const { mkdirSync } = await import("node:fs");
    const cwd = (lane: string) => {
      const d = `${env.paths.scratchDir}/lanes/${lane}/ws/repo`;
      mkdirSync(d, { recursive: true });
      return d;
    };
    // A device stand-in: each dev run holds its card for a while; which card and when are kept.
    const log: { lane: string; card: number; start: number; end: number }[] = [];
    const t0 = Date.now();
    const runner = {
      separated: false,
      run: async (req: { role: string; devCard?: number; gpu?: boolean }) => {
        assert.equal(req.gpu, true);
        const start = Date.now() - t0;
        await new Promise((r) => setTimeout(r, 300));
        log.push({ lane: req.role, card: req.devCard ?? 0, start, end: Date.now() - t0 });
        return { exitCode: 0, signal: null, wallMs: 300, peakRssBytes: 0, stdout: "", stderr: "" };
      },
      killRole: async () => 0,
    } as unknown as LocalRunner;
    const dev = new DevRuns({
      runner,
      ledger: env.ledger,
      scratchDir: env.paths.scratchDir,
      gpu: true,
      dedicated: true,
      cards: 2,
      maxWaitMs: 10_000,
    });
    const go = (lane: string) =>
      dev.run({ lane, command: "true", cwd: cwd(lane) }, `t-${lane}`) as Promise<{
        ran: boolean;
        card?: number;
      }>;
    const out = await Promise.all([go("lane-1"), go("lane-2"), go("lane-3"), go("lane-1")]);
    assert.ok(out.every((o) => o.ran));
    // Two at once on the two cards; the third waited for a card.
    const first = log.filter((x) => x.start < 150);
    assert.deepEqual(first.map((x) => x.card).sort(), [0, 1]);
    assert.equal(log.length, 4);
    // Lane-1's second dev run started only after its first ended.
    const l1 = log.filter((x) => x.lane === "lane-1").sort((a, b) => a.start - b.start);
    assert.ok((l1[1] as { start: number }).start >= (l1[0] as { end: number }).end - 5);
    // Never two dev runs on one card at once.
    for (const a of log)
      for (const b of log)
        if (a !== b && a.card === b.card)
          assert.ok(a.end <= b.start + 5 || b.end <= a.start + 5, "a card ran two at once");
    assert.ok(
      out.every((o) => o.card === 1 || o.card === 2),
      "the answer names the card",
    );
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

  /** A scheduler whose trials return `result`, counting the trials it starts (goal 079). */
  function provider(
    env: ReturnType<typeof makeJudgeEnv>,
    result: () => Awaited<
      ReturnType<NonNullable<ConstructorParameters<typeof Scheduler>[0]["runTrial"]>>
    >,
    more: Partial<ConstructorParameters<typeof Scheduler>[0]> = {},
  ) {
    const started = { n: 0 };
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
      backoffBaseMs: 0,
      runTrial: async () => {
        started.n++;
        return result();
      },
      ...more,
    });
    const round = async () => {
      await scheduler.tick();
      await scheduler.idle();
      await new Promise((r) => setTimeout(r, 5));
    };
    const events = (kind: string) =>
      env.ledger.db
        .prepare("select body from event where kind = ? order by id")
        .all(kind)
        .map((e) => JSON.parse(String(e.body)) as Record<string, unknown>);
    return { scheduler, started, round, events };
  }

  test("a trial that finds no credits stops the run's agents until a model check passes (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 10 } });
    await env.service.applyCommand(env.assign);
    const run = (env.assign.envelope.payload as { run: string }).run;
    let checks = 0;
    let checkPasses = false;
    env.service.rigChecks.model = {
      run: async () => {
        checks++;
        return checkPasses
          ? { ok: true, summary: "m answered with a tool call" }
          : { ok: false, summary: "m failed the check: 404 insufficient_credits_for_paid_model" };
      },
    };
    let credits = false;
    const { started, round, events } = provider(env, () =>
      credits
        ? { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 }
        : {
            stopped: "error",
            turns: 0,
            toolCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
            error: "404 insufficient_credits_for_paid_model",
            errorKind: "credits",
          },
    );
    await round();
    const first = started.n;
    assert.ok(first >= 1);
    const stop = events("agents_stopped");
    assert.equal(stop.length, 1);
    assert.equal(stop[0]?.kind, "credits");
    assert.match(String(stop[0]?.words), /insufficient_credits_for_paid_model/);
    // Stopped: no trial and no new plan, however many ticks; the model is not checked again
    // before its first pause (a minute).
    await round();
    await round();
    assert.equal(started.n, first, "no trial starts while the agents are stopped");
    assert.equal(checks, 0);
    // The owner resumes the run: the model is checked at once. It still fails: still stopped.
    env.ledger.appendEvent("control:owner", "run_status", run, { status: "running", reason: null });
    await round();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(checks, 1);
    await round();
    assert.equal(started.n, first, "a failing check keeps them stopped");
    assert.equal(events("agents_stopped").length, 1, "the stop is recorded once");
    // Credits added: the next check passes, the agents go on.
    credits = true;
    checkPasses = true;
    env.ledger.appendEvent("control:owner", "run_status", run, { status: "running", reason: null });
    await round();
    await new Promise((r) => setTimeout(r, 20));
    await round();
    assert.equal(events("agents_resumed").length, 1);
    assert.ok(started.n > first, "a passing check lets trials start again");
  });

  test("no trial starts while the workers' model check fails; a new route ends it (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.service.applyCommand(env.assign);
    const { started, round, events } = provider(env, () => ({
      stopped: "no_submission",
      turns: 1,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
    }));
    // The route was set, and its check failed after it (as at 03:02:49 in the audit).
    env.ledger.appendEvent("supervisor", "model_route_set", null, { model: "m" });
    env.ledger.appendEvent("harness", "rig_check_finished", null, {
      id: "chk-1",
      check: "model",
      ok: false,
      summary: "m failed the tool-call check: 404 insufficient_credits_for_paid_model",
    });
    await round();
    await round();
    assert.equal(started.n, 0, "no trial on a failing check");
    assert.equal(events("agents_stopped")[0]?.kind, "credits");
    // A check of another kind of failure stops them too, as "check".
    // The owner gives the rig another model: the stop ends at once.
    env.ledger.appendEvent("supervisor", "model_route_set", null, { model: "m2" });
    await round();
    assert.ok(started.n >= 1, "a new route ends the stop");
    assert.equal(events("agents_resumed")[0]?.why, "the rig's model route changed");
  });

  test("a rate limit with a time makes the agents wait until then; a passing fault does not stop them (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env.service.applyCommand(env.assign);
    let error = "429 Rate limit reached. Please try again in 30s.";
    const { started, round, events } = provider(env, () => ({
      stopped: "error",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      error,
    }));
    await round();
    assert.equal(started.n, 1);
    const wait = events("agents_wait_for_limit")[0];
    const ms = Date.parse(String(wait?.until)) - Date.now();
    assert.ok(ms > 25_000 && ms <= 30_000, `waits about 30 s (${ms})`);
    await round();
    assert.equal(started.n, 1, "no trial before the provider's time");
    // A provider's 5xx ends no run and stops no agents: the lane's own backoff alone.
    const env2 = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 10 } });
    await env2.service.applyCommand(env2.assign);
    error = "503 Service Unavailable";
    const two = provider(env2, () => ({
      stopped: "error",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      error,
    }));
    for (let i = 0; i < 8; i++) await two.round();
    assert.ok(two.started.n >= 8, `trials go on (${two.started.n})`);
    assert.equal(two.events("agents_stopped").length, 0);
    assert.equal(two.events("agents_cooldown").length, 0, "no cooldown after failures in a row");
  });

  test("a draining rig starts no trial and no plan; shutdown stops trials and keeps their counters (goal 079)", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 3 } });
    await env.service.applyCommand(env.assign);
    let draining = true;
    let id = "";
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
      draining: () => draining,
      runTrial: (spec, signal) =>
        new Promise((resolve) => {
          id = spec.trialId;
          // The worker reports its counters as it goes.
          env.service.trialReport(
            { id: spec.trialId, run: spec.run, lane: spec.lane },
            { progress: { turns: 7, tool_calls: 12, tokens_in: 9000, tokens_out: 800 } },
          );
          signal.addEventListener("abort", () =>
            resolve({ stopped: "interrupted", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 }),
          );
        }),
    });
    assert.equal(await scheduler.tick(), false);
    assert.equal(env.ledger.db.prepare("select count(*) as n from epoch").get()?.n, 0);
    draining = false;
    assert.ok(await scheduler.tick());
    assert.equal(scheduler.trialsRunning, 1);
    // Its workspace is ready and its worker at work.
    while (!id) await new Promise((r) => setTimeout(r, 10));
    await scheduler.shutdown("the harness is stopping");
    const t = env.ledger.db
      .prepare("select stopped, turns, tool_calls, tokens_in, tokens_out from trial where id = ?")
      .get(id);
    assert.deepEqual(
      [t?.stopped, t?.turns, t?.tool_calls, t?.tokens_in, t?.tokens_out],
      ["interrupted", 7, 12, 9000, 800],
    );
    assert.equal(await scheduler.tick(), false, "no new work after shutdown");
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
      .prepare("select id, run, lane from trial where ended_at is null")
      .all();
    assert.equal(open.length, 1);
    // Its worker reported its counters before the controller died (goal 079).
    env.service.trialReport(
      { id: String(open[0]?.id), run: String(open[0]?.run), lane: String(open[0]?.lane) },
      { progress: { turns: 4, tool_calls: 9, tokens_in: 5000, tokens_out: 300 } },
    );
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
      .prepare(
        "select stopped, turns, tool_calls, tokens_in, tokens_out from trial order by started_at",
      )
      .all()
      .map((t) => [t.stopped, t.turns, t.tool_calls, t.tokens_in, t.tokens_out]);
    // Interrupted, with the counters its worker last reported: the work it did still counts.
    assert.deepEqual(stopped, [["interrupted", 4, 9, 5000, 300]]);
    assert.ok(await second.tick()); // the lane's next trial starts
    await second.idle();
    assert.equal(started, 1);
  });

  /**
   * A goal campaign with one lane, a planner that records its input, and trials that record their
   * brief. With `hold`, each trial runs until `release(n)` (or an abort) ends it.
   */
  async function goalSetup(
    goalReportWaitMs?: number,
    o: { trialsPerEpoch?: number; hold?: boolean } = {},
  ) {
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 90e6 },
      contract: { lanes: { count: 1, trials_per_epoch: o.trialsPerEpoch ?? 1 } },
    });
    await env.service.applyCommand(env.assign);
    const planned: string[] = [];
    const fake = await startFakeModel(({ messages, tools }) => {
      if (!tools.some((t) => t.function.name === "submit_plan")) return { text: "done" };
      planned.push(JSON.stringify(messages));
      return {
        toolCalls: [
          {
            name: "submit_plan",
            args: {
              new_families: [{ id: "speed", description: "make the sum faster" }],
              assignments: [
                {
                  lane: "lane-1",
                  family: "speed",
                  focus: "reach the fast goal",
                  parent: "champion",
                },
              ],
            },
          },
        ],
      };
    });
    const briefs: string[] = [];
    const waiting: (() => void)[] = [];
    let aborted = 0;
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "scheduler-test",
      goalReportWaitMs,
      // A trial that submits nothing would make the lane wait before its next one.
      backoffBaseMs: 0,
      runTrial: async (spec, signal) => {
        if (o.hold) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            briefs.push(spec.brief);
            signal.addEventListener("abort", () => {
              aborted++;
              resolve();
            });
          });
        } else briefs.push(spec.brief);
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    const live = () =>
      env.service.live
        .since(0)
        .entries.map((e) => e.text)
        .join("\n");
    /** Ends the trials that are running, once `n` trials in all have reached their worker. */
    const release = async (n: number) => {
      while (briefs.length < n) await new Promise((r) => setTimeout(r, 10));
      for (const r of waiting.splice(0)) r();
    };
    return { env, fake, planned, briefs, scheduler, live, release, aborted: () => aborted };
  }

  test("goal mode: an epoch is planned from the judge's goal report on the champion", async () => {
    const { env, fake, planned, briefs, scheduler, live } = await goalSetup();
    assert.equal(await scheduler.tick(), false); // the seed is not validated yet: no plan
    assert.equal(planned.length, 0);
    assert.match(live(), /round 1 waits for the judge's goal report on champion #1/);
    await env.drain(); // the judge validates the seed
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    assert.equal(planned.length, 1);
    assert.match(live(), /^planning round 1 \(1 lane\)$/m);
    // The planner and the worker both see what the champion meets.
    assert.match(String(planned[0]), /\\"goal_report\\"/);
    assert.match(String(planned[0]), /\\"goal\\":\\"fast\\",[^}]*\\"status\\":\\"unmet\\"/);
    assert.match(String(briefs[0]), /# What the champion meets/);
    // A met goal's reasons too: a code goal's values on its public cases (goal 086).
    assert.match(
      String(briefs[0]),
      /- correct: met\. verifier correctness passed on small: small: ops_per_s \d\.\d{5}e\+\d+\n/,
    );
    assert.match(String(briefs[0]), /- fast: unmet\. /);
    await fake.close();
  });

  test("goal mode: no new trial while a champion that met every goal is confirmed; a trial at work goes on; trials start again when the confirmation fails (goal 086)", async () => {
    const { env, fake, scheduler, live, release, aborted } = await goalSetup(undefined, {
      trialsPerEpoch: 3,
      hold: true,
    });
    await env.drain(); // the seed's goal report: fast is not met
    assert.ok(await scheduler.tick()); // round 1, and its first trial
    assert.equal(scheduler.trialsRunning, 1);
    // A validation found every required goal met: the judge's confirming validation is queued.
    const confirm = env.ledger.enqueueJob({
      kind: "validate",
      priority: 40,
      spec: { run: "js-1", champion_seq: 1, confirm: true },
      actor: "judge-test",
    });
    assert.equal(await scheduler.tick(), false);
    assert.match(
      live(),
      /no new trial starts: the judge is confirming that champion #1 meets every required goal; if it does, the run closes \(a trial at work goes on until then\)/,
    );
    // The trial at work goes on; when it ends, the lane's next trial still waits.
    assert.equal(scheduler.trialsRunning, 1);
    await release(1);
    await scheduler.idle();
    assert.equal(aborted(), 0, "the trial at work ended as it would");
    // Leased by the judge is still pending.
    env.ledger.db.prepare("update job set state = 'leased' where id = ?").run(confirm);
    assert.equal(await scheduler.tick(), false);
    const trials = () => Number(env.ledger.db.prepare("select count(*) as n from trial").get()?.n);
    assert.equal(trials(), 1);
    // The confirmation failed: the lanes go on.
    env.ledger.db
      .prepare("update job set state = 'failed', result = '{}' where id = ?")
      .run(confirm);
    assert.ok(await scheduler.tick());
    assert.equal(trials(), 2);
    assert.match(
      live(),
      /trials start again: the judge's confirmation of champion #1 did not close the run/,
    );
    await release(2);
    await scheduler.idle();
    await fake.close();
  });

  test("goal mode: a confirmation queued for another champion does not hold the lanes (goal 086)", async () => {
    const { env, fake, scheduler } = await goalSetup(undefined, { trialsPerEpoch: 2 });
    await env.drain();
    env.ledger.enqueueJob({
      kind: "validate",
      priority: 40,
      spec: { run: "js-1", champion_seq: 7, confirm: true },
      actor: "judge-test",
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    await fake.close();
  });

  test("goal mode: with no goal report in time, the epoch is planned anyway", async () => {
    const { env, fake, planned, scheduler, live } = await goalSetup(0);
    assert.ok(await scheduler.tick()); // nothing validated, the wait is over: planned
    await scheduler.idle();
    assert.equal(planned.length, 1);
    assert.doesNotMatch(String(planned[0]), /\\"goal_report\\"/);
    assert.match(
      live(),
      /planning round 1 without a goal report on champion #1 \(none after 0 min\)/,
    );
    assert.equal(env.ledger.db.prepare("select count(*) as n from epoch").get()?.n, 1);
    await fake.close();
  });

  test("a lane's next brief shows the start and the end of the judge's reason for its crash", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 2 } });
    await env.service.applyCommand(env.assign);
    // No plan from the model: the fixed plan gives the lane its experiments.
    const fake = await startFakeModel(() => ({ text: "no plan" }));
    const noisy = `import { writeSync } from "node:fs";
export function work() {
  writeSync(2, "warning: noise\\n".repeat(400) + "fatal: index 42 is out of range\\n");
  process.exit(3);
}
`;
    const briefs: string[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "scheduler-test",
      runTrial: async (spec) => {
        briefs.push(spec.brief);
        if (briefs.length > 1)
          return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
        const r = await env.service.submitForTrial(String(spec.token), {
          patch_base64: env.patch(noisy),
          hypothesis: "a crash with a long error output",
          known_flaws: [],
        });
        return {
          stopped: "submitted",
          turns: 1,
          toolCalls: 1,
          tokensIn: 0,
          tokensOut: 0,
          submitted: { attempt: r.attempt, lifecycle: r.lifecycle },
        };
      },
    });
    assert.ok(await scheduler.tick());
    await scheduler.idle();
    await env.drain(); // the judge decides the crash
    await scheduler.tick(); // the lane's second trial
    await scheduler.idle();
    assert.equal(briefs.length, 2);
    const judge = /\. Judge: (exit 3: [^\n]*(?:\n[^\n-][^\n]*)*)/.exec(String(briefs[1]))?.[1];
    assert.ok(judge, String(briefs[1]));
    assert.match(judge, /^exit 3: warning: noise/);
    assert.match(judge, /fatal: index 42 is out of range/);
    assert.ok(judge.length <= 1200, `${judge.length} characters`);
    await fake.close();
  });
});
