import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "../../testing/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../testing/judge-env.ts";
import { LocalRunner } from "../broker/runner.ts";
import { keepGoing, runTrial } from "./worker.ts";
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
        run: "js-1",
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

  test("a model that stops early is told to go on, twice at most; why it stopped is recorded", async () => {
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
    const trial = (url: string) =>
      runTrial(
        {
          trialId: "t-nudge",
          run: "js-1",
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
            baseUrl: url,
            model: "test",
            apiKey: "k",
            contextWindow: 32000,
            maxTokens: 2000,
          },
          submit: (req) =>
            env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
          status: async (id) => env.service.attemptStatus(id),
        },
      );
    // Thinks aloud first; after the nudge it writes the change and submits.
    const late = await startFakeModel(({ messages }) => {
      const nudged = messages.some(
        (m) => m.role === "user" && String(JSON.stringify(m.content)).includes("not called submit"),
      );
      if (!nudged) return { text: "I would start by reading the kernel." };
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (done === 1)
        return {
          toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
        };
      return { text: "done" };
    });
    const r = await trial(late.url);
    await late.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    // Never uses a tool: two nudges, then no submission, with the reason.
    let requests = 0;
    const idle = await startFakeModel(() => {
      requests++;
      return { text: "Nothing to do." };
    });
    const r2 = await trial(idle.url);
    await idle.close();
    assert.equal(r2.stopped, "no_submission");
    assert.equal(requests, 3);
    assert.match(String(r2.error), /the model stopped \(stop\)/);
  });

  test("a configured turn cap is stated, warned of once, and reported as a limit, not a model error", async () => {
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
    const seen: string[] = [];
    // Reads a file every turn and never submits.
    const busy = await startFakeModel(({ messages }) => {
      seen.push(JSON.stringify(messages.filter((m) => m.role === "user").map((m) => m.content)));
      return { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] };
    });
    const r = await runTrial(
      {
        trialId: "t-budget",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 600_000,
        maxTurns: 14,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: busy.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: async () => {
          throw new Error("not expected");
        },
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await busy.close();
    assert.equal(r.stopped, "turns");
    // The call the limit aborted ends as one more turn.
    assert.ok(r.turns >= 14 && r.turns <= 15, String(r.turns));
    assert.equal(r.error, "the trial reached its limit of 14 turns before a submission");
    assert.match(seen[0] ?? "", /lasts 10 minutes and at most 14 turns/);
    const warnedAt = seen.findIndex((u) => u.includes("turns are left in this trial"));
    assert.equal(warnedAt, 4, "warned once, after turn 4 (10 turns before the limit)");
    assert.equal(seen.at(-1)?.split("turns are left").length, 2, "only once");
  });

  test("without a configured cap a trial is not cut off by its number of turns", async () => {
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
    let first = "";
    // 70 turns of reading (past the old default of 60), then the change and a submission.
    const long = await startFakeModel(({ messages }) => {
      first ||= JSON.stringify(messages.find((m) => m.role === "user")?.content ?? "");
      const done = messages.filter((m) => m.role === "tool").length;
      if (done < 70) return { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] };
      if (done === 70)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (done === 71)
        return {
          toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
        };
      return { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t-long",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 600_000,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: long.url,
          model: "test",
          apiKey: "k",
          contextWindow: 200000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await long.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.ok(r.turns > 70, String(r.turns));
    assert.match(first, /This trial lasts 10 minutes\. Submit before it ends/);
    assert.doesNotMatch(first, /turns/);
  });

  test("a reply cut off at the output limit or a failed call never ends a trial", async () => {
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
    let calls = 0;
    const said: string[] = [];
    const lines: { kind: string; text: string }[] = [];
    const progress: { turns: number; tool_calls: number; tokens_in: number; tokens_out: number }[] =
      [];
    // Four replies cut off while thinking, then two failed calls, then the change and a submission.
    const flaky = await startFakeModel(({ messages }) => {
      calls++;
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      said.push(JSON.stringify(lastUser?.content ?? ""));
      if (calls <= 4)
        return {
          text: "Let me think about the loop structure in depth",
          cutOff: true,
          usage: { prompt: 3000, completion: 2000 },
        };
      if (calls <= 6) return { fail: 503 };
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (done === 1)
        return {
          toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
        };
      return { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t-flaky",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 600_000,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: flaky.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        link: {
          live: async (entries) => {
            lines.push(...entries);
          },
          progress: async (p) => {
            progress.push(p);
          },
        },
      },
    );
    await flaky.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    // After each turn the session reports its counters, which grow (the harness keeps the last).
    assert.ok(progress.length >= 2, JSON.stringify(progress));
    const last = progress.at(-1);
    assert.ok(last && last.turns === progress.length && last.tool_calls >= 1);
    assert.ok((last?.tokens_in ?? 0) >= 4 * 3000, JSON.stringify(last));
    assert.ok(
      said.some((u) => u.includes("cut off at the output limit")),
      said.join("\n"),
    );
    assert.ok(
      said.some((u) => u.includes("The model call failed")),
      said.join("\n"),
    );
    // The live view says how each abnormal reply ended.
    assert.ok(
      lines.some((l) => l.text.startsWith("(reply ended: length; 3000 tokens in, 2000 out")),
      JSON.stringify(lines),
    );
    assert.ok(
      lines.some((l) => l.text.startsWith("(reply ended: error")),
      JSON.stringify(lines),
    );
  });

  test("earlier replies' thinking is never sent back to the model", async () => {
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
    const sent: string[] = [];
    const thinker = await startFakeModel(({ messages }) => {
      sent.push(JSON.stringify(messages));
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          thinking: "SECRET-REASONING-1 the inner loop is waste",
          toolCalls: [{ name: "read_file", args: { path: "src/kernel/work.mjs" } }],
        };
      if (done === 1)
        return {
          thinking: "SECRET-REASONING-2 drop it",
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      return {
        toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
      };
    });
    const r = await runTrial(
      {
        trialId: "t-think",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 60_000,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: thinker.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await thinker.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.equal(sent.length, 3);
    // The replies' tool calls went back; their reasoning never did.
    assert.match(sent[2] ?? "", /write_file/);
    assert.ok(
      sent.every((m) => !m.includes("SECRET-REASONING")),
      sent.join("\n"),
    );
  });

  test("keepGoing ends a trial on a full context or a stuck model, never loops on it", async () => {
    // A stand-in agent: each prompt appends the next scripted assistant message (or messages: a
    // run of several turns).
    type Reply = { stopReason: string; output?: number; input?: number; errorMessage?: string };
    const fake = (replies: (Reply | Reply[])[]) => {
      const messages: unknown[] = [];
      const listeners = new Set<(e: unknown) => void>();
      let i = 0;
      const next = () => {
        const step = replies[Math.min(i++, replies.length - 1)] as Reply | Reply[];
        for (const r of Array.isArray(step) ? step : [step]) {
          const message = {
            role: "assistant",
            stopReason: r.stopReason,
            errorMessage: r.errorMessage,
            usage: { input: r.input ?? 1000, output: r.output ?? 2000 },
          };
          messages.push(message);
          for (const l of listeners) l({ type: "turn_end", message, toolResults: [] });
        }
      };
      next();
      return {
        agent: {
          state: { messages },
          prompt: async () => next(),
          subscribe: (l: (e: unknown) => void) => {
            listeners.add(l);
            return () => listeners.delete(l);
          },
        } as never,
        calls: () => i,
      };
    };
    // A compactor: how many compactions keepGoing asked for.
    const compactor = () => {
      const c = { asked: 0, count: 0, force: () => void c.asked++ };
      return c;
    };
    // With compaction (goal 070), a full context is compacted and the trial goes on.
    const once = fake([{ stopReason: "length", output: 1, input: 31_900 }, { stopReason: "stop" }]);
    const c1 = compactor();
    assert.equal(await keepGoing(once.agent, () => false, 32_768, c1), undefined);
    assert.equal(c1.asked, 1);
    assert.equal(once.calls(), 2, "the trial went on after the compaction");
    const error = fake([
      { stopReason: "error", errorMessage: "400 maximum context length is 32768 tokens" },
      // After the compaction: a turn with a tool call, then the context is full again.
      [
        { stopReason: "toolUse" },
        { stopReason: "error", errorMessage: "400 maximum context length is 32768 tokens" },
      ],
      { stopReason: "stop" },
    ]);
    const c2 = compactor();
    assert.equal(await keepGoing(error.agent, () => false, 32_768, c2), undefined);
    assert.equal(c2.asked, 2, "a reply between two full contexts: each one is compacted");
    // Full again right after each of two compactions: compaction cannot help, the trial ends.
    const always = fake([{ stopReason: "length", output: 1, input: 31_900 }]);
    const c3 = compactor();
    const end = await keepGoing(always.agent, () => false, 32_768, c3);
    assert.equal(end?.stopped, "context");
    assert.match(String(end?.error), /again right after a compaction/);
    assert.equal(c3.asked, 2);
    const never = () => false;
    // A one-token cut-off: the context is full.
    const full = fake([{ stopReason: "length", output: 1, input: 31_900 }]);
    assert.equal((await keepGoing(full.agent, never, 32_768))?.stopped, "context");
    assert.equal(full.calls(), 1, "no further call");
    // A prompt at the context window, even with output: full as well.
    const atWindow = fake([{ stopReason: "length", output: 500, input: 31_500 }]);
    assert.equal((await keepGoing(atWindow.agent, never, 32_768))?.stopped, "context");
    // A context-length error from the provider.
    const tooLong = fake([
      { stopReason: "error", errorMessage: "400 maximum context length is 32768 tokens" },
    ]);
    assert.equal((await keepGoing(tooLong.agent, never, 32_768))?.stopped, "context");
    // Cut off 5 times running with real output: stuck, the trial ends.
    const stuck = fake([{ stopReason: "length" }]);
    const s5 = await keepGoing(stuck.agent, never, 32_768);
    assert.equal(s5?.stopped, "error");
    assert.match(String(s5?.error), /cut off 5 times/);
    assert.equal(stuck.calls(), 5);
    // Two cut-offs, then a reply that stops of its own accord: back to the caller.
    const ok = fake([{ stopReason: "length" }, { stopReason: "length" }, { stopReason: "stop" }]);
    assert.equal(await keepGoing(ok.agent, never, 32_768), undefined);
    // An unknown window (0) never reads a long prompt as a full context by itself.
    const unknown = fake([
      { stopReason: "length", output: 500, input: 300_000 },
      { stopReason: "stop" },
    ]);
    assert.equal(await keepGoing(unknown.agent, never, 0), undefined);
    // The trial's time running out ends it quietly.
    const late = fake([{ stopReason: "length" }]);
    assert.equal(await keepGoing(late.agent, () => true, 32_768), undefined);
  });

  test("the live view: a worker's turns stream out, and the owner's message arrives as a user turn, read once the agent takes it", async () => {
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
    let sawOwner = false;
    const fake = await startFakeModel(({ messages }) => {
      sawOwner ||= messages.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("use the fast kernel"),
      );
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          text: "Reading first.",
          toolCalls: [{ name: "read_file", args: { path: "src/kernel/work.mjs" } }],
        };
      if (!sawOwner) return { text: "Still thinking." };
      if (done === 1)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      return {
        toolCalls: [{ name: "submit", args: { hypothesis: "as the owner said", known_flaws: [] } }],
      };
    });
    const lines: { kind: string; text: string }[] = [];
    // Waiting until confirmed, as the harness keeps it: the worker must not take it twice.
    let pending = [{ id: 7, text: "use the fast kernel" }];
    const reads: number[][] = [];
    const r = await runTrial(
      {
        trialId: "t-live",
        run: "js-1",
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
        link: {
          live: async (entries) => {
            lines.push(...entries);
          },
          messages: async () => pending,
          read: async (ids) => {
            reads.push(ids);
            pending = pending.filter((m) => !ids.includes(m.id));
          },
        },
      },
    );
    await fake.close();
    assert.ok(sawOwner, "the model saw the owner's message");
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.deepEqual(reads, [[7]], "confirmed once, when the agent took it");
    const kinds = new Set(lines.map((l) => l.kind));
    for (const k of ["text", "tool", "result"]) assert.ok(kinds.has(k), `a ${k} line`);
    assert.ok(lines.some((l) => l.kind === "tool" && l.text.startsWith("read_file")));
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
        run: "js-1",
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

  test("a worker proposes an idea for the run's queue with its idea tool, and its trial goes on", async () => {
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
    const replies: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const tools = messages.filter((m) => m.role === "tool");
      if (tools.length) replies[tools.length - 1] = JSON.stringify(tools.at(-1)?.content);
      if (tools.length === 0)
        return {
          toolCalls: [
            {
              name: "idea",
              args: { title: "unroll the tail", why: "the profile", family: "unroll" },
            },
          ],
        };
      if (tools.length === 1) return { toolCalls: [{ name: "idea", args: { title: "  " } }] };
      if (tools.length === 2)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (tools.length === 3) return { toolCalls: [{ name: "submit", args: { hypothesis: "h" } }] };
      return { text: "done" };
    });
    const ideas: unknown[] = [];
    const r = await runTrial(
      {
        trialId: "t3",
        run: "js-1",
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
        idea: async (req) => {
          ideas.push(req);
          return { experiment: "x-0123456789ab" };
        },
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", "the idea did not end the trial");
    assert.equal(r.toolCalls, 4);
    assert.deepEqual(ideas, [
      { title: "unroll the tail", why: "the profile", family: "unroll", details: undefined },
    ]);
    assert.match(
      String(replies[0]),
      /proposed x-0123456789ab: it waits until the planner or the campaign.s owner queues it/,
    );
    assert.match(String(replies[1]), /an idea needs a title/);
  });

  test("a worker keeps field notes with its note tool, and its trial goes on", async () => {
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
    const replies: string[] = [];
    let system = "";
    const fake = await startFakeModel(({ messages }) => {
      system ||= JSON.stringify(
        messages.find((m) => m.role === "system" || m.role === "developer")?.content ?? "",
      );
      const tools = messages.filter((m) => m.role === "tool");
      if (tools.length) replies[tools.length - 1] = JSON.stringify(tools.at(-1)?.content);
      const steps = [
        {
          name: "note",
          args: {
            kind: "Observation",
            text: " the loop is memory bound ",
            about: { type: "trial", id: "t4" },
          },
        },
        { name: "note", args: { kind: "lesson", text: "  " } },
        { name: "note", args: { kind: "rumour", text: "refused by the harness" } },
        { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
        { name: "submit", args: { hypothesis: "h" } },
      ];
      const step = steps[tools.length];
      return step ? { toolCalls: [step] } : { text: "done" };
    });
    const notes: unknown[] = [];
    const r = await runTrial(
      {
        trialId: "t4",
        run: "js-1",
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
        note: async (req) => {
          if (req.kind === "rumour") throw new Error("400: kind: invalid option");
          notes.push(req);
          return { note: notes.length };
        },
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", "notes did not end the trial");
    assert.deepEqual(notes, [
      { kind: "observation", text: "the loop is memory bound", about: { type: "trial", id: "t4" } },
    ]);
    assert.match(String(replies[0]), /noted \(#1\)\. Your trial goes on/);
    assert.match(String(replies[1]), /a note needs its text/);
    assert.match(String(replies[2]), /the note was not recorded: 400: kind/);
    assert.match(system, /keep field notes with the note tool/);
    assert.match(system, /Never note what you tried and its result/);
  });

  test("a worker's lane work goes through the API: its own lane, its own workspace, tool or shell only", async () => {
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
    const { Registry } = await import("./registry.ts");
    const { createHarnessApi } = await import("../api.ts");
    new Registry(env.ledger).startTrial({
      id: "t-lane",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "lane-token",
    });
    env.service.trialWorkspaces.set("t-lane", { lane: "lane-1", repo: ws.repo, root: ws.dir });
    const api = createHarnessApi(env.service, { supervisor: "s" }, { lanes: { runner, laneTool } });
    const run = (body: Record<string, unknown>) =>
      api.request("/v1/lane/run", {
        method: "POST",
        headers: { authorization: "Bearer trial.lane-token", "content-type": "application/json" },
        body: JSON.stringify({ role: "lane-1", cwd: ws.repo, timeoutMs: 20_000, ...body }),
      });
    const ok = await run({
      argv: ["lanetool", "read", JSON.stringify({ path: "src/kernel/work.mjs" })],
    });
    assert.equal(ok.status, 200);
    assert.match(((await ok.json()) as { stdout: string }).stdout, /"ok":true/);
    const shell = await run({ argv: ["sh", "-c", "echo hi"] });
    assert.match(((await shell.json()) as { stdout: string }).stdout, /hi/);
    assert.equal((await run({ argv: ["node", "-e", "1"] })).status, 401, "only tool or shell");
    assert.equal((await run({ role: "lane-2", argv: ["sh", "-c", "id"] })).status, 401, "own lane");
    assert.equal(
      (await run({ cwd: `${ws.dir}/../..`, argv: ["sh", "-c", "ls"] })).status,
      401,
      "own workspace",
    );
    env.service.trialWorkspaces.delete("t-lane");
    assert.equal((await run({ argv: ["sh", "-c", "echo"] })).status, 404);
  });

  /** A trial's lane API over a recording runner, under the given lane limits. */
  async function laneApi(limits?: Record<string, number>) {
    const env = makeJudgeEnv({
      contract: { lanes: { count: 2, trials_per_epoch: 1, ...(limits ? { limits } : {}) } },
    });
    await env.service.applyCommand(env.assign);
    const inner = new LocalRunner(env.paths.scratchDir);
    const seen: {
      timeoutMs?: number;
      rssLimitBytes?: number;
      disk?: { limitBytes: number };
      env?: Record<string, string>;
      keepBackground?: boolean;
      nproc?: number;
    }[] = [];
    const runner = Object.assign(Object.create(inner), {
      run: (req: Parameters<LocalRunner["run"]>[0]) => {
        seen.push(req);
        return inner.run(req);
      },
    }) as LocalRunner;
    const ws = await prepareWorkspace({
      runner: inner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: env.seed,
      lane: "lane-1",
    });
    const { Registry } = await import("./registry.ts");
    const { createHarnessApi } = await import("../api.ts");
    new Registry(env.ledger).startTrial({
      id: "t-lim",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "lim-token",
    });
    env.service.trialWorkspaces.set("t-lim", { lane: "lane-1", repo: ws.repo, root: ws.dir });
    const devRequests: { input: { timeout_s?: number }; limits: unknown }[] = [];
    const devRuns = {
      run: async (input: unknown, _trial: string, limits?: unknown) => {
        devRequests.push({ input: input as { timeout_s?: number }, limits });
        return { ran: true };
      },
    };
    const api = createHarnessApi(
      env.service,
      { supervisor: "s" },
      { lanes: { runner, laneTool }, devRuns },
    );
    const headers = { authorization: "Bearer trial.lim-token", "content-type": "application/json" };
    const run = (body: Record<string, unknown>) =>
      api.request("/v1/lane/run", {
        method: "POST",
        headers,
        body: JSON.stringify({ role: "lane-1", cwd: ws.repo, argv: ["sh", "-c", "true"], ...body }),
      });
    const dev = (body: Record<string, unknown>) =>
      api.request("/v1/dev-runs", {
        method: "POST",
        headers,
        body: JSON.stringify({ command: "true", cwd: ws.repo, ...body }),
      });
    return { env, ws, seen, devRequests, run, dev };
  }

  test("lane commands and dev runs are held to the contract's lane limits", async () => {
    const { env, ws, seen, devRequests, run, dev } = await laneApi({
      run_timeout_s: 30,
      run_rss_mib: 512,
      workspace_mib: 1024,
      dev_run_timeout_s: 45,
      processes: 1024,
    });
    const r = await run({
      timeoutMs: 3_600_000,
      rssLimitBytes: 64 * 1024 ** 3,
      disk: { path: ws.dir, limitBytes: 64 * 1024 ** 3 },
      nproc: 65_536,
    });
    assert.equal(r.status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, 30_000);
    assert.equal(seen.at(-1)?.rssLimitBytes, 512 * 1024 ** 2);
    assert.equal(seen.at(-1)?.disk?.limitBytes, 1024 * 1024 ** 2);
    // The process limit is the contract's, whatever the worker asks for.
    assert.equal(seen.at(-1)?.nproc, 1024);
    // A command that asks for no limit still gets the contract's.
    assert.equal((await run({})).status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, 30_000);
    // The lane's cache: created with its first workspace, kept across trials, named to its commands.
    const cache = `${env.paths.scratchDir}/lanes/lane-1/cache`;
    assert.ok(existsSync(cache));
    assert.equal(seen.at(-1)?.env?.CCACHE_DIR, cache);
    assert.equal(seen.at(-1)?.env?.THERMITE_LANE_CACHE, cache);
    const d = await dev({ timeout_s: 3600 });
    assert.equal(d.status, 200);
    // The dev-run queue applies the limit (it alone knows whether the judge shares the device).
    assert.equal(devRequests.at(-1)?.input.timeout_s, 3600);
    assert.deepEqual(devRequests.at(-1)?.limits, {
      rssMib: 4096,
      diskMib: 1024,
      processes: 1024,
      timeoutS: 45,
    });
  });

  test("without a time limit in the contract, a lane command has none, and its background work runs on", async () => {
    const { seen, devRequests, run, dev } = await laneApi();
    assert.equal((await run({})).status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, undefined);
    assert.equal(seen.at(-1)?.keepBackground, true);
    // No process limit in the contract: the lane's users keep the default.
    assert.equal(seen.at(-1)?.nproc, 256);
    assert.equal((await run({ timeoutMs: 90_000 })).status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, 90_000, "an agent may still set its own");
    assert.equal((await dev({})).status, 200);
    assert.equal(devRequests.at(-1)?.input.timeout_s, undefined);
    assert.deepEqual(devRequests.at(-1)?.limits, { rssMib: 4096, diskMib: 2048, processes: 256 });
  });

  test("the isolation selftest refuses a rig with open trials or judge jobs", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const { busyReason } = await import("../selftest.ts");
    const { Registry } = await import("./registry.ts");
    const jobs = Number(
      (
        env.ledger.db
          .prepare("select count(*) as n from job where state in ('queued','leased')")
          .get() as { n: number }
      ).n,
    );
    if (!jobs) assert.equal(busyReason(env.paths.stateDir), undefined);
    new Registry(env.ledger).startTrial({
      id: "t-busy",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "busy-token",
    });
    assert.match(String(busyReason(env.paths.stateDir)), /1 open trial/);
  });

  test("the lane tool searches the whole tree and keeps each reply small", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(`${tmpdir()}/thermite-lanetool-`);
    // 600 files (more than a listing shows), the match in the last one.
    for (let i = 0; i < 600; i++) {
      mkdirSync(`${dir}/d${String(i).padStart(3, "0")}`);
      writeFileSync(
        `${dir}/d${String(i).padStart(3, "0")}/f.c`,
        i === 599 ? "PQ2_0 here\n" : "x\n",
      );
    }
    writeFileSync(
      `${dir}/long.c`,
      Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const tool = (op: string, args: unknown) =>
      JSON.parse(
        execFileSync(laneTool[0] as string, [...laneTool.slice(1), op, JSON.stringify(args)], {
          cwd: dir,
          encoding: "utf8",
        }),
      ) as Record<string, unknown>;
    const found = tool("search", { pattern: "PQ2_0" }).matches as string[];
    assert.deepEqual(found, ["d599/f.c:1: PQ2_0 here"]);
    const read = tool("read", { path: "long.c" }) as unknown as {
      content: string;
      total_lines: number;
    };
    assert.equal(read.total_lines, 1000);
    assert.match(read.content, /^1\tline 1\n/);
    assert.match(
      read.content,
      /\n400\tline 400\n… lines 401–1000 not shown: read again with offset 400$/,
    );
    const more = tool("read", { path: "long.c", offset: 400, limit: 1000 }) as unknown as {
      content: string;
    };
    assert.match(more.content, /^401\tline 401/);
    assert.match(more.content, /1000\tline 1000$/);
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
