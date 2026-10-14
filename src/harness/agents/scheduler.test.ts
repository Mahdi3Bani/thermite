import assert from "node:assert/strict";
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
          submit: (req) => env.service.submitAttempt(req, "proposer") as never,
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
    assert.equal(scheduler.registry.laneBest("js-1", "lane-1"), winner);
    assert.equal(scheduler.registry.laneBest("js-1", "lane-2"), null);
    assert.equal(String(env.ledger.getAttempt(winner)?.family), "loops");
    await scheduler.idle();
    await fake.close();
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
