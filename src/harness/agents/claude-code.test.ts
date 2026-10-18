import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Runner, RunOutcome, RunRequest } from "../broker/runner.ts";
import {
  CLAUDE_SYSTEM,
  claudeArgs,
  claudeModelCheck,
  newClaudeTally,
  readClaudeEvents,
  runClaudeTrial,
} from "./claude-code.ts";
import { modelConfigFromEnv } from "./model.ts";
import { ControlRoute } from "./model-source.ts";
import type { TrialSpec } from "./worker.ts";

const RESET = 1_800_000_000;
const TOKEN = "sk-ant-oat01-test-token"; // public-check: allow (a made-up token shape for tests)
// Claude Code's stream-json output, shaped as version 2.1.302 prints it (trimmed; no real data).
const events = (o: { limited?: boolean } = {}) =>
  [
    { type: "system", subtype: "init", session_id: "s-1", tools: ["Bash"], mcp_servers: [] },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        id: "msg_1",
        content: [{ type: "thinking", thinking: "Read the file first." }],
        usage: { input_tokens: 4, cache_creation_input_tokens: 1000, output_tokens: 20 },
      },
    },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        id: "msg_1",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "make" } }],
        usage: { input_tokens: 4, cache_creation_input_tokens: 1000, output_tokens: 30 },
      },
    },
    {
      type: "rate_limit_event",
      session_id: "s-1",
      rate_limit_info: {
        status: o.limited ? "rejected" : "allowed",
        resetsAt: RESET,
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: o.limited ? 1 : 0.34, resetsAt: RESET },
          seven_day: { utilization: 0.61, resetsAt: RESET + 86_400 },
        },
      },
    },
    {
      type: "user",
      session_id: "s-1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok\n", is_error: false }],
      },
    },
    {
      type: "assistant",
      session_id: "s-1",
      message: {
        id: "msg_2",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 5 },
      },
    },
    o.limited
      ? {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "You've hit your session limit",
          num_turns: 2,
        }
      : {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
          num_turns: 2,
          usage: {
            input_tokens: 6,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 1000,
            output_tokens: 35,
          },
        },
  ].map((e) => JSON.stringify(e));

const model = {
  api: "claude" as const,
  harness: "claude-code" as const,
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-5-5",
  apiKey: TOKEN,
  contextWindow: 1_000_000,
  maxTokens: 0,
};

describe("Claude Code", () => {
  test("its stream-json becomes counters, live lines and the subscription's windows", () => {
    const t = newClaudeTally();
    const live = readClaudeEvents(events(), t);
    assert.equal(t.session, "s-1");
    assert.equal(t.turns, 2, "one message in several events is one turn");
    assert.equal(t.toolCalls, 1);
    assert.equal(t.tokensIn, 2006);
    assert.equal(t.tokensOut, 35);
    assert.deepEqual(t.tools, [{ tool: "Bash", output: "ok\n", ok: true }]);
    assert.equal(t.result, "Done.");
    assert.deepEqual(t.usage, {
      five_hour: { utilization: 0.34, resets_at: new Date(RESET * 1000).toISOString() },
      seven_day: { utilization: 0.61, resets_at: new Date((RESET + 86_400) * 1000).toISOString() },
    });
    assert.equal(t.limitedUntil, undefined);
    assert.deepEqual(
      live.map((l) => l.kind),
      ["thinking", "tool", "result", "text"],
    );
    const full = newClaudeTally();
    readClaudeEvents(events({ limited: true }), full);
    assert.equal(full.limitedUntil, new Date(RESET * 1000).toISOString());
    assert.match(full.errors.at(-1) ?? "", /session limit/);
  });

  test("it runs with no settings, no MCP servers and its permissions bypassed; the trial brief fits it", () => {
    const a = claudeArgs(model, { tools: "" });
    for (const f of ["--strict-mcp-config", "--setting-sources", "--permission-mode", "--verbose"])
      assert.ok(a.includes(f), f);
    assert.equal(a[a.indexOf("--setting-sources") + 1], "");
    assert.equal(a[a.indexOf("--tools") + 1], "");
    assert.equal(a[a.indexOf("--model") + 1], "claude-opus-5-5");
    assert.ok(!a.join(" ").includes("sk-ant"), "the token is never an argument");
    assert.match(CLAUDE_SYSTEM, /Bash tool stops a command after two minutes/);
    assert.doesNotMatch(CLAUDE_SYSTEM, /set timeout to 0/);
  });

  const spec = (area: string, workspace: string, over: Partial<TrialSpec> = {}): TrialSpec => ({
    trialId: "t-1",
    token: "tok",
    run: "r-1",
    lane: "lane-1",
    workspace,
    workspaceRoot: area,
    parentCommit: "c".repeat(40),
    editablePaths: ["src/**"],
    brief: "Make it faster.",
    wallMs: 60_000,
    ...over,
  });
  /** A stand-in runner: setup succeeds; the Claude Code run appends `lines` to its events file. */
  const fakeRunner = (lines: string[], o: { submit?: boolean } = {}) => {
    const runs: RunRequest[] = [];
    const killed: string[] = [];
    let submitted = false;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        if (req.argv.includes("-p")) {
          appendFileSync(String(req.env?.THERMITE_CLAUDE_EVENTS), `${lines.join("\n")}\n`);
          await new Promise((r) => setTimeout(r, 30));
          if (o.submit) submitted = true;
        }
        return { exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" } as RunOutcome;
      },
      killRole: async (role: string) => {
        killed.push(role);
        return 0;
      },
    } as unknown as Runner;
    return { runner, runs, killed, submitted: () => submitted };
  };
  const area = () => {
    const a = mkdtempSync(join(tmpdir(), "thermite-cc-"));
    mkdirSync(join(a, "repo"));
    return a;
  };

  test("a trial runs as the lane's user with the token only in Claude Code's environment, and ends with the submission", async () => {
    const a = area();
    const f = fakeRunner(events(), { submit: true });
    const seen: unknown[] = [];
    const r = await runClaudeTrial(spec(a, join(a, "repo")), {
      runner: f.runner,
      model,
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      usage: (u) => seen.push(u),
      submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
      pollMs: 5,
    });
    assert.equal(r.stopped, "submitted");
    assert.equal(r.turns, 2);
    assert.ok(f.runs.every((x) => x.role === "lane-1"));
    const run = f.runs.find((x) => x.argv.includes("-p")) as RunRequest;
    assert.equal(run.cwd, join(a, "repo"));
    assert.equal(run.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.equal(run.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
    assert.equal(run.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(run.env?.HOME, join(a, "claude-home"));
    assert.equal(run.env?.THERMITE_TRIAL_AUTH, "trial.tok");
    assert.equal(run.env?.THERMITE_PROXY_AUTH, undefined, "no key-adding proxy for a subscription");
    assert.ok(!run.argv.join(" ").includes("sk-ant"), "the token is never on the command line");
    assert.ok(seen.length > 0, "the subscription's windows were reported");
  });

  test("a full usage window ends the trial with when it resets; a turn cap stops it", async () => {
    const a = area();
    const limited = fakeRunner(events({ limited: true }));
    const r = await runClaudeTrial(spec(a, join(a, "repo")), {
      runner: limited.runner,
      model,
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      submitted: () => undefined,
      pollMs: 5,
    });
    assert.equal(r.stopped, "error");
    assert.equal(r.retryAfter, new Date(RESET * 1000).toISOString());
    assert.match(r.error ?? "", /usage window is full until/);
    const b = area();
    const capped = fakeRunner(events());
    const c = await runClaudeTrial(spec(b, join(b, "repo"), { maxTurns: 1 }), {
      runner: capped.runner,
      model,
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      submitted: () => undefined,
      pollMs: 5,
    });
    assert.equal(c.stopped, "turns");
    assert.ok(capped.killed.includes("lane-1"));
  });

  test("the model check: one Bash call through Claude Code, with no tools beyond it", async () => {
    const runs: RunRequest[] = [];
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        const word = /echo (thermite-[a-z0-9]+)/.exec(req.argv.join(" "))?.[1] ?? "";
        const out = req.argv.includes("-p")
          ? events()
              .join("\n")
              .replace('"ok\\n"', JSON.stringify(`${word}\n`))
          : "";
        return {
          exitCode: 0,
          signal: null,
          killedFor: null,
          stdout: out,
          stderr: "",
        } as RunOutcome;
      },
      killRole: async () => 0,
      handOver: async () => undefined,
      remove: async () => undefined,
    } as unknown as Runner;
    const r = await claudeModelCheck(model, {
      runner,
      apiUrl: "http://127.0.0.1:8700",
      scratchDir: mkdtempSync(join(tmpdir(), "thermite-cc-check-")),
    });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /Claude Code/);
    const call = runs.find((x) => x.argv.includes("-p")) as RunRequest;
    assert.equal(call.argv[call.argv.indexOf("--tools") + 1], "Bash");
    assert.equal(call.role, "agent-16");
  });

  test("a Claude subscription goes only with Claude Code, in a route or in the environment", () => {
    const route = {
      name: "claude-max",
      type: "claude" as const,
      harness: "pi" as const,
      version: 1,
      base_url: "https://api.anthropic.com",
      model: "claude-opus-5-5",
      context_window: 0,
      max_tokens: 0,
      reasoning: null,
      key_hint: "…abcd",
      revision: "0123456789abcdef",
      api_key: "t",
    };
    assert.equal(ControlRoute.safeParse(route).success, false);
    assert.equal(ControlRoute.safeParse({ ...route, harness: "claude-code" }).success, true);
    const env = {
      THERMITE_MODEL_BASE_URL: "https://api.anthropic.com",
      THERMITE_MODEL: "claude-opus-5-5",
      THERMITE_MODEL_API_KEY: "t",
      THERMITE_MODEL_API: "claude",
    };
    assert.throws(
      () => modelConfigFromEnv(env),
      /runs only with THERMITE_AGENT_HARNESS=claude-code/,
    );
    assert.equal(
      modelConfigFromEnv({ ...env, THERMITE_AGENT_HARNESS: "claude-code" })?.harness,
      "claude-code",
    );
  });
});
