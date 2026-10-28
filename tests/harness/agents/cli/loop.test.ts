/**
 * The one trial loop of the agent programs that run as command-line programs (goal 125, T7):
 * each of its steps, in each program's entry.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { laneLimits } from "../../../../src/core/contract.ts";
import { claudeProgram } from "../../../../src/harness/agents/claude-code/program.ts";
import { runCliTrial } from "../../../../src/harness/agents/cli/loop.ts";
import type {
  CliProgram,
  CliTally,
  CliTrialDeps,
} from "../../../../src/harness/agents/cli/program.ts";
import { codexProgram } from "../../../../src/harness/agents/codex/program.ts";
import type { ModelConfig } from "../../../../src/harness/agents/model.ts";
import { opencodeProgram } from "../../../../src/harness/agents/opencode/program.ts";
import type { TrialSpec } from "../../../../src/harness/agents/worker.ts";
import { fakeProgramRunner, type Program } from "../../../helpers/fake-program.ts";

let seq = 0;

/** Each program's entry, a route for it, and its output: tool calls, a provider's error. */
const PROGRAMS: {
  program: Program;
  entry: CliProgram<CliTally>;
  model: ModelConfig;
  /** How a continued run names the session it continues. */
  resumes: string;
  turns(n: number): unknown[];
  failed(words: string): unknown[];
}[] = [
  {
    program: "opencode",
    entry: opencodeProgram,
    model: {
      baseUrl: "https://p.example/v1",
      model: "m-1",
      apiKey: "k",
      contextWindow: 0,
      maxTokens: 8192,
    },
    resumes: "--session ses_1",
    turns: (n) =>
      Array.from({ length: n }, () => [
        {
          type: "tool_use",
          sessionID: "ses_1",
          part: { tool: "shell", state: { status: "completed", input: {}, output: "ok" } },
        },
        { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 1, output: 1 } } },
      ]).flat(),
    failed: (words) => [{ type: "error", sessionID: "ses_1", error: { message: words } }],
  },
  {
    program: "claude-code",
    entry: claudeProgram,
    model: {
      api: "claude",
      harness: "claude-code",
      baseUrl: "https://api.anthropic.com",
      model: "claude-test",
      apiKey: "token",
      contextWindow: 1_000_000,
      maxTokens: 0,
    },
    resumes: "--resume s-1",
    turns: (n) =>
      Array.from({ length: n }, () => {
        const i = ++seq;
        return {
          type: "assistant",
          session_id: "s-1",
          message: {
            id: `msg_${i}`,
            content: [
              { type: "tool_use", id: `tu_${i}`, name: "Bash", input: { command: "make" } },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      }),
    failed: (words) => [
      { type: "result", subtype: "error", is_error: true, result: words, session_id: "s-1" },
    ],
  },
  {
    program: "codex",
    entry: codexProgram,
    model: {
      api: "chatgpt",
      harness: "codex",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      apiKey: "access",
      contextWindow: 0,
      maxTokens: 0,
      reasoning: "off",
    },
    resumes: "resume th-1",
    turns: (n) => [
      { type: "thread.started", thread_id: "th-1" },
      ...Array.from({ length: n }, () => ({
        type: "item.completed",
        item: {
          id: `item_${++seq}`,
          type: "command_execution",
          command: "make",
          aggregated_output: "ok\n",
          exit_code: 0,
          status: "completed",
        },
      })),
    ],
    failed: (words) => [
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.failed", error: { message: words } },
    ],
  },
];

const lines = (events: unknown[]) => events.map((e) => JSON.stringify(e));

const area = () => {
  const a = mkdtempSync(join(tmpdir(), "thermite-loop-"));
  mkdirSync(join(a, "repo"));
  return a;
};

const spec = (a: string, over: Partial<TrialSpec> = {}): TrialSpec => ({
  trialId: "t-1",
  token: "tok",
  run: "r-1",
  lane: "lane-1",
  workspace: join(a, "repo"),
  workspaceRoot: a,
  parentCommit: "c".repeat(40),
  editablePaths: ["src/**"],
  brief: "Make it faster.",
  wallMs: 60_000,
  ...over,
});

type Fake = ReturnType<typeof fakeProgramRunner>;

/** One trial in `p`'s entry on the stand-in runner `f`; `over` replaces any of its deps. */
function trial(
  p: (typeof PROGRAMS)[number],
  s: TrialSpec,
  f: Fake,
  over: Partial<CliTrialDeps> = {},
) {
  return runCliTrial(p.entry, s, {
    runner: f.runner,
    model: p.model,
    apiUrl: "http://127.0.0.1:8700",
    live: () => undefined,
    progress: () => undefined,
    submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
    pollMs: 5,
    ...over,
  });
}

/** The prompts a trial's runs were given, in order (Claude Code's, in its prompt's file). */
function prompts(f: Fake): string[] {
  const written = f.runs.filter((x) => x.argv.join(" ").includes("cat > claude-prompt.txt"));
  return (written.length ? written : f.programRuns()).map((x) => String(x.stdin));
}

const limits = (over: Partial<ReturnType<typeof laneLimits>>) => ({
  ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }),
  ...over,
});

describe("the CLI trial loop, in each program's entry", () => {
  test("a submission ends the trial: the program set up in the lane's area, then run in its workspace", async () => {
    for (const p of PROGRAMS) {
      const a = area();
      const f = fakeProgramRunner(p.program, lines(p.turns(2)), { submit: true });
      const r = await trial(p, spec(a), f);
      const name = p.entry.name;
      assert.equal(r.stopped, "submitted", name);
      assert.deepEqual(r.submitted, { attempt: "a-1", lifecycle: "queued" }, name);
      assert.equal(r.toolCalls, 2, name);
      assert.equal(f.programRuns().length, 1, `${name}: not continued`);
      assert.ok(
        f.runs.every((x) => x.role === "lane-1"),
        `${name}: as the lane`,
      );
      // Its setup comes first, in the lane's own area; the program runs in the workspace, with
      // its events file, the trial's paths and its token.
      assert.equal(f.runs[0]?.cwd, a, name);
      const run = f.programRuns()[0];
      assert.equal(run?.cwd, join(a, "repo"), name);
      assert.equal(run?.env?.[p.entry.eventsVar], join(a, `${p.entry.prefix}-events.jsonl`), name);
      assert.equal(run?.env?.THERMITE_WORKSPACE, join(a, "repo"), name);
      assert.equal(run?.env?.THERMITE_EDITABLE_PATHS, '["src/**"]', name);
      assert.equal(run?.env?.THERMITE_TRIAL_AUTH, "trial.tok", name);
      assert.ok(run?.rssLimitBytes && run.disk && run.nproc, `${name}: under the lane's limits`);
      assert.match(String(prompts(f)[0]), /Make it faster\./, name);
    }
  });

  test("the turn cap stops the program and ends the trial in words", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p.program, lines(p.turns(3)), { hang: true });
      const r = await trial(p, spec(area(), { maxTurns: 2 }), f);
      assert.equal(r.stopped, "turns", p.entry.name);
      assert.equal(
        r.error,
        "the trial reached its limit of 2 turns before a submission",
        p.entry.name,
      );
      assert.ok(f.killed.includes("lane-1"), `${p.entry.name}: stopped at the cap`);
      assert.match(String(prompts(f)[0]), /at most 2 turns/, p.entry.name);
    }
  });

  test("a memory limit that stops the program ends the trial with the program's name and figures", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p.program, lines(p.turns(1)), {
        outcome: {
          exitCode: null,
          signal: "SIGKILL",
          killedFor: "memory",
          peakRssBytes: 4400 * 1024 ** 2,
        },
      });
      const l = limits({ runRssMib: 4096 });
      const r = await trial(p, spec(area(), { limits: l }), f);
      assert.equal(r.stopped, "error", p.entry.name);
      assert.match(
        String(r.error),
        new RegExp(`^stopped by the lane's memory limit: ${p.entry.name} reached 4400 MiB`),
      );
      assert.equal(f.programRuns().length, 1, `${p.entry.name}: not continued`);
      assert.equal(f.programRuns()[0]?.rssLimitBytes, 4096 * 1024 * 1024, p.entry.name);
    }
  });

  test("the wall clock: a run gets the trial's time left, and one the clock stops ends the trial", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p.program, lines(p.turns(1)), {
        outcome: { exitCode: null, signal: "SIGKILL", killedFor: "timeout" },
      });
      const r = await trial(p, spec(area()), f);
      assert.equal(r.stopped, "wall", p.entry.name);
      assert.equal(r.error, "the trial reached its 1-minute limit before a submission");
      const given = Number(f.programRuns()[0]?.timeoutMs);
      assert.ok(given > 50_000 && given <= 60_000, `${p.entry.name}: given ${given} ms`);
      // With its time used up before a run, no run starts.
      const late = fakeProgramRunner(p.program, lines(p.turns(1)));
      const l = await trial(p, spec(area(), { wallMs: 0 }), late);
      assert.equal(l.stopped, "wall", p.entry.name);
      assert.equal(late.programRuns().length, 0, p.entry.name);
    }
  });

  test("a provider's failure: no credits ends the trial with its kind; a passing fault waits and goes on in the same session", async () => {
    for (const p of PROGRAMS) {
      const broke = fakeProgramRunner(p.program, lines(p.failed("402 insufficient credits")));
      const r = await trial(p, spec(area()), broke, { pauseMs: () => 5 });
      assert.deepEqual([r.stopped, r.errorKind], ["error", "credits"], p.entry.name);
      assert.equal(broke.programRuns().length, 1, p.entry.name);
      const flaky = fakeProgramRunner(p.program, lines(p.failed("stream disconnected")));
      const waits: unknown[] = [];
      const e = await trial(p, spec(area(), { limits: limits({ failuresInARow: 2 }) }), flaky, {
        pauseMs: () => 5,
        waiting: (w) => waits.push(w),
      });
      assert.equal(e.stopped, "error", p.entry.name);
      assert.match(String(e.error), /failed 2 times in a row .*stream disconnected/, p.entry.name);
      assert.equal(flaky.programRuns().length, 2, `${p.entry.name}: went on once`);
      assert.equal(waits.length, 1, p.entry.name);
      assert.ok(
        flaky.programRuns()[1]?.argv.join(" ").includes(p.resumes),
        `${p.entry.name}: in the same session`,
      );
      assert.match(String(prompts(flaky)[1]), /^The model call failed/, p.entry.name);
    }
  });

  test("an exit with no session ends the trial in the program's words; with a session, the run is continued", async () => {
    for (const p of PROGRAMS) {
      const f = fakeProgramRunner(p.program, ["boom"], { outcome: { exitCode: 1 } });
      const r = await trial(p, spec(area()), f);
      assert.equal(r.stopped, "error", p.entry.name);
      assert.equal(r.error, `${p.entry.name} exited 1: boom`);
      assert.equal(f.programRuns().length, 1, p.entry.name);
      // The same exit after the session started: nudged once, then ended without a submission.
      const session = fakeProgramRunner(p.program, sessionStart(p), { outcome: { exitCode: 1 } });
      const s = await trial(p, spec(area()), session);
      assert.equal(s.stopped, "no_submission", p.entry.name);
      assert.equal(s.error, undefined, p.entry.name);
      assert.equal(session.programRuns().length, 2, p.entry.name);
      assert.ok(session.programRuns()[1]?.argv.join(" ").includes(p.resumes), p.entry.name);
    }
  });

  test("the owner's messages continue the session: read once the agent starts on them, never after a submission", async () => {
    for (const p of PROGRAMS) {
      const run = async (submit: boolean) => {
        let waiting = [{ id: 1, text: "look at the inner loop" }];
        const given: number[] = [];
        const f = fakeProgramRunner(p.program, lines(p.turns(1)), { submit });
        // The worker keeps working each run: the campaign's nudges of 2 (none by default).
        const r = await trial(p, spec(area(), { limits: limits({ nudges: 2 }) }), f, {
          messages: {
            waiting: () => waiting,
            given: (ids) => {
              given.push(...ids);
              waiting = waiting.filter((m) => !ids.includes(m.id));
            },
          },
        });
        return { r, f, given, said: prompts(f) };
      };
      const open = await run(false);
      assert.equal(open.said.length, 3, p.entry.name);
      assert.match(String(open.said[1]), /campaign's owner: look at the inner loop/, p.entry.name);
      assert.ok(open.f.programRuns()[1]?.argv.join(" ").includes(p.resumes), p.entry.name);
      assert.doesNotMatch(String(open.said[2]), /campaign's owner/, p.entry.name);
      assert.deepEqual(open.given, [1], `${p.entry.name}: read once the session started on it`);
      const done = await run(true);
      assert.equal(done.r.stopped, "submitted", p.entry.name);
      assert.equal(done.said.length, 1, `${p.entry.name}: no continuation after a submission`);
      assert.deepEqual(done.given, [], `${p.entry.name}: it waits for the lane's next trial`);
    }
  });
});

/** A line of each program's output that starts its session and does no work. */
function sessionStart(p: (typeof PROGRAMS)[number]): string[] {
  if (p.program === "opencode")
    return lines([{ type: "text", sessionID: "ses_1", part: { text: "Looking." } }]);
  if (p.program === "claude-code")
    return lines([{ type: "system", subtype: "init", session_id: "s-1" }]);
  return lines([{ type: "thread.started", thread_id: "th-1" }]);
}
