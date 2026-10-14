import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "../../testing/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../testing/judge-env.ts";
import { LocalRunner } from "../broker/runner.ts";
import { runTrial } from "./worker.ts";
import { prepareWorkspace } from "./workspace.ts";

const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("./lanetool.ts", import.meta.url)),
];

describe("worker trial", () => {
  test("a scripted agent reads, edits, tests and submits once; the judge takes it from there", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.currentChampion("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    // The model: list, read, rewrite the kernel, run a quick check, submit.
    const fake = await startFakeModel(({ messages }) => {
      const done = messages.filter((m) => m.role === "tool").length;
      const steps = [
        { name: "list_files", args: {} },
        { name: "read_file", args: { path: "src/kernel/work.mjs" } },
        { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
        {
          name: "run",
          args: {
            command:
              "node -e \"import('./src/kernel/work.mjs').then(m => console.log(m.work(14)))\"",
          },
        },
        { name: "submit", args: { hypothesis: "remove the wasted inner loop", known_flaws: [] } },
      ];
      const next = steps[done];
      return next ? { toolCalls: [next] } : { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t1",
        instance: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.equal(r.toolCalls, 5);
    assert.ok(r.tokensIn > 0);
    const a = env.ledger.getAttempt(r.submitted?.attempt ?? "");
    assert.equal(String(a?.lane), "lane-1");
    assert.equal(String(a?.lifecycle), "queued");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(String(a?.id))?.verdict, "win_confirmed");
  });

  test("tool calls run one at a time, and nothing runs after a submission in the same turn", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.currentChampion("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    // Turn 1 writes and checks in one batch; turn 2 submits and then tries to write again.
    const fake = await startFakeModel(({ messages }) => {
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0) {
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
            { name: "run", args: { command: "grep -c . src/kernel/work.mjs" } },
          ],
        };
      }
      if (done === 2) {
        return {
          toolCalls: [
            { name: "submit", args: { hypothesis: "faster" } },
            { name: "submit", args: { hypothesis: "again" } },
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: "late" } },
          ],
        };
      }
      return { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t2",
        instance: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "b",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "t",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    const n = env.ledger.db.prepare("select count(*) as n from attempt").get();
    assert.equal(Number(n?.n), 1, "one submission");
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(`${ws.repo}/src/kernel/work.mjs`, "utf8"), FAST_KERNEL);
  });

  test("the lane tool never leaves the workspace", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: env.seed,
      lane: "lane-1",
    });
    const tool = async (op: string, args: unknown, stdin?: string) =>
      JSON.parse(
        (
          await runner.run({
            role: "lane-1",
            argv: [...laneTool, op, JSON.stringify(args)],
            cwd: ws.repo,
            timeoutMs: 20_000,
            ...(stdin ? { stdin } : {}),
          })
        ).stdout,
      );
    assert.equal((await tool("read", { path: "../../../../etc/hosts" })).ok, false);
    assert.equal((await tool("write", { path: "/tmp/escape" }, "x")).ok, false);
    assert.equal((await tool("read", { path: "src/kernel/work.mjs" })).ok, true);
  });
});
