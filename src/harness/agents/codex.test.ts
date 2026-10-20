import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { laneLimits } from "../../core/contract.ts";
import { makeJudgeEnv } from "../../testing/judge-env.ts";
import { LocalRunner, type Runner, type RunOutcome, type RunRequest } from "../broker/runner.ts";
import {
  CODEX_SYSTEM,
  codexArgs,
  codexConfig,
  codexLimitsNote,
  codexModelCheck,
  newCodexTally,
  readCodexEvents,
  runCodexTrial,
  tomlString,
} from "./codex.ts";
import { modelConfigFromEnv } from "./model.ts";
import { ControlRoute } from "./model-source.ts";
import { Scheduler } from "./scheduler.ts";
import type { TrialSpec } from "./worker.ts";

const ACCESS = "chatgpt-access-token-for-tests";
const THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53";
// The Codex CLI's `exec --json` output, shaped as version 0.162.1 prints it (no real data).
const events = (o: { failed?: string } = {}) =>
  [
    { type: "thread.started", thread_id: THREAD },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Read it first." } },
    {
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -lc make",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -lc make",
        aggregated_output: "ok\n",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "file_change",
        changes: [{ path: "src/kernel/matmul.c", kind: "update" }],
        status: "completed",
      },
    },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Done." } },
    ...(o.failed
      ? [
          { type: "error", message: o.failed },
          { type: "turn.failed", error: { message: o.failed } },
        ]
      : [
          {
            type: "turn.completed",
            usage: {
              input_tokens: 2400,
              cached_input_tokens: 1200,
              cache_write_input_tokens: 0,
              output_tokens: 90,
              reasoning_output_tokens: 40,
            },
          },
        ]),
  ].map((e) => JSON.stringify(e));

const model = {
  api: "chatgpt" as const,
  harness: "codex" as const,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-test",
  apiKey: ACCESS,
  contextWindow: 0,
  maxTokens: 0,
  reasoning: "off" as const,
};

describe("the Codex CLI", () => {
  test("its JSON events become counters, live lines and the thread to resume", () => {
    const t = newCodexTally();
    const live = readCodexEvents(events(), t);
    assert.equal(t.session, THREAD);
    assert.equal(t.turns, 3, "each message and each tool call is one turn");
    assert.equal(t.toolCalls, 2);
    assert.equal(t.tokensIn, 2400);
    assert.equal(t.tokensOut, 90);
    assert.deepEqual(t.tools, [
      { tool: "shell", output: "ok\n", ok: true },
      { tool: "apply_patch", output: "update src/kernel/matmul.c", ok: true },
    ]);
    assert.equal(t.lastText, "Done.");
    assert.deepEqual(
      live.map((l) => l.kind),
      ["thinking", "tool", "result", "tool", "result", "text"],
    );
    // A resumed thread reports its whole total again: tokens are not counted twice.
    readCodexEvents(events(), t);
    assert.equal(t.tokensIn, 2400);
    // A failed command is a tool call that did not work; a failed turn is an error.
    const f = newCodexTally();
    readCodexEvents(
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_9",
            type: "command_execution",
            command: "false",
            aggregated_output: "",
            exit_code: 1,
            status: "failed",
          },
        }),
        ...events({ failed: "unexpected status 401 Unauthorized: bad key" }),
        "not json at all",
      ],
      f,
    );
    assert.equal(f.tools[0]?.ok, false);
    assert.match(f.errors.at(-1) ?? "", /401/);
    assert.equal(f.notes.at(-1), "not json at all");
  });

  test("it reaches the model only through the harness's proxy, with approvals and its sandbox off", () => {
    const a = codexArgs(model);
    for (const f of [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--dangerously-bypass-approvals-and-sandbox",
    ])
      assert.ok(a.includes(f), f);
    assert.equal(a[a.indexOf("--model") + 1], "gpt-test");
    assert.equal(a.at(-1), "-", "the prompt comes on stdin");
    assert.deepEqual(codexArgs(model, { session: THREAD }).slice(-3), ["resume", THREAD, "-"]);
    const c = codexConfig(model, "http://127.0.0.1:8700/v1/model-proxy");
    assert.match(c, /^model_provider = "thermite"$/m);
    assert.match(c, /^base_url = "http:\/\/127\.0\.0\.1:8700\/v1\/model-proxy"$/m);
    assert.match(c, /^env_key = "THERMITE_PROXY_AUTH"$/m);
    assert.match(c, /^wire_api = "responses"$/m);
    assert.match(c, /^model_reasoning_effort = "none"$/m, "off sends none");
    assert.match(c, /^web_search = "disabled"$/m);
    assert.match(c, /\[analytics\]\nenabled = false/);
    assert.match(c, /\[history\]\npersistence = "none"/);
    // Top-level keys come before the first table, as TOML needs.
    assert.ok(c.indexOf("web_search") < c.indexOf("[model_providers.thermite]"));
    assert.doesNotMatch(
      codexConfig({ ...model, reasoning: undefined }, "http://x"),
      /effort/,
      "unset: nothing is sent",
    );
    assert.ok(!`${a.join(" ")}${c}`.includes(ACCESS), "the access token is in neither");
    assert.equal(tomlString('a"b\\c\nd\u007f'), '"a\\"b\\\\c\\u000ad\\u007f"');
    assert.doesNotMatch(CODEX_SYSTEM, /set timeout to 0/);
    assert.match(CODEX_SYSTEM, /thermite-trial submit --hypothesis/);
    assert.match(CODEX_SYSTEM, /keep field notes with "thermite-trial note --kind KIND/);
    const limits = codexLimitsNote(laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }));
    assert.match(limits, /Codex itself included\./);
    assert.doesNotMatch(limits, /OpenCode|500 MiB/);
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
  /** A stand-in runner: setup succeeds; each Codex run appends `lines` to its events file. */
  const fakeRunner = (lines: string[], o: { submit?: boolean } = {}) => {
    const runs: RunRequest[] = [];
    const killed: string[] = [];
    let submitted = false;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        if (req.argv.includes("exec")) {
          appendFileSync(String(req.env?.THERMITE_CODEX_EVENTS), `${lines.join("\n")}\n`);
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
    return {
      runner,
      runs,
      killed,
      submitted: () => submitted,
      codexRuns: () => runs.filter((x) => x.argv.includes("exec")),
    };
  };
  const area = () => {
    const a = mkdtempSync(join(tmpdir(), "thermite-codex-"));
    mkdirSync(join(a, "repo"));
    return a;
  };
  const deps = (f: ReturnType<typeof fakeRunner>) => ({
    runner: f.runner,
    model,
    apiUrl: "http://127.0.0.1:8700",
    live: () => undefined,
    progress: () => undefined,
    submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
    pollMs: 5,
  });

  test("a trial runs as the lane's user with only the trial's token, and ends with the submission", async () => {
    const a = area();
    const f = fakeRunner(events(), { submit: true });
    const r = await runCodexTrial(spec(a, join(a, "repo")), deps(f));
    assert.equal(r.stopped, "submitted");
    assert.equal(r.turns, 3);
    assert.equal(r.tokensIn, 2400);
    assert.ok(f.runs.every((x) => x.role === "lane-1"));
    // Its home and configuration are made as the lane's user, in the lane's own area.
    const setup = f.runs[0] as RunRequest;
    assert.equal(setup.cwd, a);
    assert.match(String(setup.argv[2]), /cat > codex-home\/\.codex\/config\.toml/);
    assert.match(String(setup.stdin), /base_url = "http:\/\/127\.0\.0\.1:8700\/v1\/model-proxy"/);
    const run = f.codexRuns()[0] as RunRequest;
    assert.equal(run.cwd, join(a, "repo"));
    assert.equal(run.env?.HOME, join(a, "codex-home"));
    assert.equal(run.env?.CODEX_HOME, join(a, "codex-home", ".codex"));
    assert.equal(run.env?.THERMITE_TRIAL_AUTH, "trial.tok");
    assert.equal(run.env?.THERMITE_PROXY_AUTH, "trial.tok", "the proxy takes the trial's token");
    assert.match(String(run.stdin), /^You are a research worker/);
    assert.match(String(run.stdin), /Make it faster\./);
    assert.ok(run.rssLimitBytes && run.disk && run.nproc, "under the lane's limits");
    const everything = JSON.stringify(f.runs);
    assert.ok(!everything.includes(ACCESS), "the ChatGPT access token never reaches the lane");
  });

  test("an owner's message waiting when a run ends without a submission resumes the thread with it, and is read there; after a submission it waits for the lane's next trial", async () => {
    const inbox = (texts: string[]) => {
      let waiting = texts.map((text, i) => ({ id: i + 1, text }));
      const given: number[] = [];
      return {
        given,
        waiting: () => waiting,
        given_: (ids: number[]) => {
          given.push(...ids);
          waiting = waiting.filter((m) => !ids.includes(m.id));
        },
      };
    };
    const run = async (o: { submit: boolean }) => {
      const a = area();
      const f = fakeRunner(events(), { submit: o.submit });
      const owner = inbox(["look at the inner loop"]);
      const r = await runCodexTrial(spec(a, join(a, "repo")), {
        ...deps(f),
        messages: { waiting: owner.waiting, given: owner.given_ },
      });
      const runs = f.codexRuns();
      return { r, runs, prompts: runs.map((x) => String(x.stdin)), given: owner.given };
    };
    const open = await run({ submit: false });
    assert.equal(open.prompts.length, 3);
    assert.match(String(open.prompts[1]), /campaign's owner: look at the inner loop/);
    assert.ok(open.runs[1]?.argv.join(" ").includes(`resume ${THREAD} -`), "the same thread");
    assert.doesNotMatch(String(open.prompts[2]), /campaign's owner/);
    assert.deepEqual(open.given, [1], "read once the resumed thread started on it");
    const done = await run({ submit: true });
    assert.equal(done.r.stopped, "submitted");
    assert.equal(done.prompts.length, 1, "no continuation after a submission");
    assert.deepEqual(done.given, [], "it stays waiting for the lane's next trial");
  });

  test("a full ChatGPT plan, as the proxy saw it, ends the trial until a later time; a turn cap stops it; a failed first run ends it", async () => {
    const a = area();
    const limited = fakeRunner(events({ failed: "exceeded retry limit, last status: 429" }));
    const until = "2030-01-01T00:15:00.000Z";
    const asked: number[] = [];
    const r = await runCodexTrial(spec(a, join(a, "repo")), {
      ...deps(limited),
      usageLimitSince: (since) => {
        asked.push(since);
        return until;
      },
    });
    assert.equal(r.stopped, "error");
    assert.equal(r.retryAfter, until);
    assert.match(r.error ?? "", /subscription_sharing_usage_limit_exceeded/);
    assert.ok(asked.length === 1 && asked[0] !== undefined && asked[0] <= Date.now());
    const b = area();
    const capped = fakeRunner(events());
    const c = await runCodexTrial(spec(b, join(b, "repo"), { maxTurns: 1 }), deps(capped));
    assert.equal(c.stopped, "turns");
    assert.ok(capped.killed.includes("lane-1"));
    const d = area();
    const broken = fakeRunner([
      JSON.stringify({ type: "thread.started", thread_id: THREAD }),
      JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
    ]);
    const e = await runCodexTrial(spec(d, join(d, "repo")), deps(broken));
    assert.equal(e.stopped, "error");
    assert.equal(e.error, "stream disconnected");
    assert.equal(broken.codexRuns().length, 1, "not resumed: nothing was done");
  });

  test("the model check: one shell call through Codex, as the model check's own user, with a minted credential", async () => {
    const runs: RunRequest[] = [];
    let minted = 0;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        const word = /echo (thermite-[a-z0-9]+)/.exec(String(req.stdin))?.[1] ?? "";
        const out = req.argv.includes("exec")
          ? events()
              .join("\n")
              .replace('"aggregated_output":"ok\\n"', `"aggregated_output":"${word}\\n"`)
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
    const r = await codexModelCheck(model, {
      runner,
      apiUrl: "http://127.0.0.1:8700",
      scratchDir: mkdtempSync(join(tmpdir(), "thermite-codex-check-")),
      mintProxyToken: () => `proxy.minted-${++minted}`,
    });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /\(Codex\)/);
    assert.equal((r.detail as { harness: string }).harness, "codex");
    const call = runs.find((x) => x.argv.includes("exec")) as RunRequest;
    assert.equal(call.env?.THERMITE_PROXY_AUTH, "proxy.minted-1");
    assert.equal(call.env?.THERMITE_TRIAL_AUTH, "");
    // The model check's own user: never a lane's, whose cleanup could kill it (or it theirs).
    assert.ok(runs.every((x) => x.role === "model-check"));
    assert.ok(!JSON.stringify(runs).includes(ACCESS));
  });

  test("Codex goes only with OpenAI's Responses API: a ChatGPT sign-in or an OpenAI route, in a route or in the environment", () => {
    const route = {
      name: "chatgpt-pro",
      type: "chatgpt" as const,
      harness: "codex" as const,
      version: 1,
      base_url: "https://api.openai.com/v1",
      model: "gpt-test",
      context_window: 0,
      max_tokens: 0,
      reasoning: null,
      key_hint: "…abcd",
      revision: "0123456789abcdef",
      api_key: "t",
    };
    assert.equal(ControlRoute.safeParse(route).success, true);
    assert.equal(ControlRoute.safeParse({ ...route, type: "openai" }).success, true);
    for (const type of ["anthropic", "opencode"] as const)
      assert.equal(ControlRoute.safeParse({ ...route, type }).success, false, type);
    const env = {
      THERMITE_MODEL_BASE_URL: "https://api.openai.com/v1",
      THERMITE_MODEL: "gpt-test",
      THERMITE_MODEL_API_KEY: "t",
      THERMITE_AGENT_HARNESS: "codex",
    };
    assert.equal(modelConfigFromEnv(env)?.harness, "codex");
    assert.equal(modelConfigFromEnv({ ...env, THERMITE_MODEL_API: "chatgpt" })?.harness, "codex");
    assert.throws(
      () => modelConfigFromEnv({ ...env, THERMITE_MODEL_API: "anthropic" }),
      /speaks only OpenAI's Responses API/,
    );
    assert.throws(
      () => modelConfigFromEnv({ ...env, THERMITE_AGENT_HARNESS: "codecs" }),
      /must be pi, opencode, claude-code or codex/,
    );
  });

  test("a route whose agents run in Codex plans in Codex, and a Pi route does not", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    const asked: { model: string; prompt: string }[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model,
      owner: "codex-test",
      askCodex: async (m, prompt) => {
        asked.push({ model: m.model, prompt });
        return JSON.stringify({
          new_families: [{ id: "cx-tidy", description: "Small tidy-ups." }],
          assignments: [
            { lane: "lane-1", family: "cx-tidy", focus: "tidy the kernel", parent: "champion" },
          ],
          notes: "planned in Codex",
        });
      },
      askClaude: async () => {
        throw new Error("not Claude Code");
      },
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await scheduler.tick();
    await scheduler.idle();
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.model, "gpt-test");
    assert.match(asked[0]?.prompt ?? "", /The campaign, as JSON:/);
    const epoch = env.ledger.db.prepare("select source from epoch where n = 1").get() as {
      source: string;
    };
    assert.equal(epoch.source, "planner");
    // The same sign-in with its agents in Pi: the planner is Pi's (here its model is unreachable,
    // so the fixed rules plan), never Codex.
    const pi = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await pi.service.applyCommand(pi.assign);
    const other = new Scheduler({
      service: pi.service,
      runner: new LocalRunner(pi.paths.scratchDir),
      model: { ...model, harness: undefined, baseUrl: "http://127.0.0.1:9/v1" },
      owner: "codex-test",
      askCodex: async (m, prompt) => {
        asked.push({ model: m.model, prompt });
        return "{}";
      },
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await other.tick();
    await other.idle();
    assert.equal(asked.length, 1, "Codex was not asked");
    const fallback = pi.ledger.db.prepare("select source from epoch where n = 1").get() as {
      source: string;
    };
    assert.equal(fallback.source, "fallback");
  });
});
