import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { laneLimits } from "../../core/contract.ts";
import type { Runner, RunOutcome, RunRequest } from "../broker/runner.ts";
import {
  breachError,
  limitsNote,
  newTally,
  opencodeConfig,
  opencodeModelId,
  readOpencodeEvents,
  runOpencodeTrial,
} from "./opencode.ts";
import type { TrialSpec } from "./worker.ts";

// OpenCode v2's JSON output, as the spike recorded it (trimmed).
const EVENTS = [
  { type: "step_start", sessionID: "ses_1", part: { type: "step-start" } },
  {
    type: "tool_use",
    sessionID: "ses_1",
    part: {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { path: "/work/add.c" }, output: "1: int add" },
    },
  },
  {
    type: "step_finish",
    sessionID: "ses_1",
    part: {
      type: "step-finish",
      reason: "tool-calls",
      tokens: { input: 3211, output: 55, reasoning: 38 },
    },
  },
  {
    type: "tool_use",
    sessionID: "ses_1",
    part: {
      type: "tool",
      tool: "shell",
      state: { status: "completed", input: { command: "make" }, output: "ok\n" },
    },
  },
  { type: "text", sessionID: "ses_1", part: { type: "text", text: "Done." } },
  {
    type: "step_finish",
    sessionID: "ses_1",
    part: { type: "step-finish", reason: "stop", tokens: { input: 300, output: 20, reasoning: 0 } },
  },
].map((e) => JSON.stringify(e));

const model = {
  baseUrl: "https://p.example/v1",
  model: "m-1",
  apiKey: "k",
  contextWindow: 0,
  maxTokens: 8192,
};

describe("the OpenCode harness", () => {
  test("its output becomes counters and live-view lines", () => {
    const t = newTally();
    const live = readOpencodeEvents([...EVENTS, "not json", ""], t);
    assert.equal(t.session, "ses_1");
    assert.equal(t.turns, 2);
    assert.equal(t.toolCalls, 2);
    assert.equal(t.tokensIn, 3511);
    assert.equal(t.tokensOut, 113);
    assert.equal(t.lastText, "Done.");
    assert.deepEqual(
      live.map((l) => l.kind),
      ["tool", "result", "tool", "result", "text"],
    );
    assert.match(live[2]?.text ?? "", /^shell /);
    const errors = newTally();
    readOpencodeEvents(
      [JSON.stringify({ type: "error", error: { type: "x", message: "403: FreeTierError" } })],
      errors,
    );
    assert.deepEqual(errors.errors, ["403: FreeTierError"]);
  });

  test("its configuration reaches a provider only through the key-adding proxy", () => {
    assert.equal(opencodeModelId({ ...model, api: "opencode" }), "opencode/m-1");
    assert.equal(opencodeModelId(model), "thermite/m-1");
    const own = opencodeConfig(
      { ...model, api: "opencode" },
      "http://127.0.0.1:8700/v1/model-proxy",
    );
    assert.equal(own.providers, undefined);
    const openai = opencodeConfig(model, "http://127.0.0.1:8700/v1/model-proxy") as {
      providers: { thermite: { env: string[]; package: string; settings: { baseURL: string } } };
    };
    assert.deepEqual(openai.providers.thermite.env, ["THERMITE_PROXY_AUTH"]);
    assert.match(openai.providers.thermite.package, /openai-compatible$/);
    assert.equal(
      openai.providers.thermite.settings.baseURL,
      "http://127.0.0.1:8700/v1/model-proxy",
    );
    const anthropic = opencodeConfig({ ...model, api: "anthropic" }, "http://h/v1/model-proxy") as {
      providers: { thermite: { package: string; settings: { baseURL: string } } };
    };
    assert.match(anthropic.providers.thermite.package, /anthropic$/);
    assert.equal(anthropic.providers.thermite.settings.baseURL, "http://h/v1/model-proxy/v1");
    // No key appears in a configuration: the proxy adds it.
    assert.ok(!JSON.stringify([own, openai, anthropic]).includes('"k"'));
  });

  test("a trial runs as the lane's user, follows the output, and ends with the submission", async () => {
    const area = mkdtempSync(join(tmpdir(), "thermite-oc-"));
    const workspace = join(area, "repo");
    mkdirSync(workspace);
    const runs: RunRequest[] = [];
    let submitted = false;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        if (req.argv.includes("run")) {
          const events = String(req.env?.THERMITE_OPENCODE_EVENTS);
          appendFileSync(events, `${EVENTS.slice(0, 3).join("\n")}\n`);
          await new Promise((r) => setTimeout(r, 30));
          appendFileSync(events, `${EVENTS.slice(3).join("\n")}\n`);
          submitted = true;
        }
        return { exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" } as RunOutcome;
      },
      killRole: async () => 0,
    } as unknown as Runner;
    const live: string[] = [];
    const spec: TrialSpec = {
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
    };
    const r = await runOpencodeTrial(spec, {
      runner,
      model,
      apiUrl: "http://127.0.0.1:8700",
      live: (es) => live.push(...es.map((e) => e.kind)),
      progress: () => undefined,
      submitted: () => (submitted ? { attempt: "a-1", lifecycle: "queued" } : undefined),
      pollMs: 5,
    });
    assert.equal(r.stopped, "submitted");
    assert.deepEqual(r.submitted, { attempt: "a-1", lifecycle: "queued" });
    assert.equal(r.turns, 2);
    assert.equal(r.toolCalls, 2);
    // Set up and run as the lane's user, in its area and workspace; the trial's token, never a key.
    assert.ok(runs.every((x) => x.role === "lane-1"));
    const run = runs.find((x) => x.argv.includes("run")) as RunRequest;
    assert.equal(run.cwd, workspace);
    assert.ok(run.argv.includes("--auto") && run.argv.includes("thermite/m-1"));
    assert.equal(run.env?.THERMITE_TRIAL_AUTH, "trial.tok");
    assert.equal(run.env?.HOME, join(area, "opencode-home"));
    assert.ok(!JSON.stringify(runs).includes('"apiKey"'));
    assert.ok(live.includes("tool") && live.includes("text"));
  });

  test("a memory or disk limit that stops OpenCode is named, with its figures", async () => {
    const limits = laneLimits({
      lanes: { count: 2, trials_per_epoch: 1, limits: { run_rss_mib: 4096, workspace_mib: 16384 } },
    });
    assert.match(limitsNote(limits), /Memory: 4096 MiB .*OpenCode itself included/);
    assert.equal(breachError({ killedFor: "timeout", peakRssBytes: 0 }, limits), undefined);
    const area = mkdtempSync(join(tmpdir(), "thermite-oc-"));
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> =>
        ({
          exitCode: req.argv.includes("run") ? null : 0,
          signal: req.argv.includes("run") ? "SIGKILL" : null,
          killedFor: req.argv.includes("run") ? "memory" : null,
          peakRssBytes: 4400 * 1024 ** 2,
          peakDiskBytes: 0,
          peakEntries: 0,
          stdout: "",
          stderr: "",
        }) as unknown as RunOutcome,
      killRole: async () => 0,
    } as unknown as Runner;
    const runs: string[] = [];
    const r = await runOpencodeTrial(
      {
        trialId: "t-3",
        run: "r-1",
        lane: "lane-1",
        workspace: area,
        workspaceRoot: area,
        parentCommit: "c".repeat(40),
        editablePaths: ["src/**"],
        brief: "b",
        wallMs: 60_000,
        limits,
      },
      {
        runner: {
          ...runner,
          run: (req: RunRequest) => {
            runs.push(req.argv.join(" "));
            return runner.run(req);
          },
        } as Runner,
        model,
        apiUrl: "http://h",
        live: () => undefined,
        progress: () => undefined,
        submitted: () => undefined,
        pollMs: 5,
      },
    );
    assert.equal(r.stopped, "error");
    assert.match(
      String(r.error),
      /memory limit: OpenCode and what it ran reached 4400 MiB, over 4096 MiB/,
    );
    // Not continued: a breach ends the trial.
    assert.equal(runs.filter((x) => x.includes(" run ")).length, 1);
    // The agent was told its limits.
    assert.ok(runs.some((x) => x.includes("Memory: 4096 MiB")));
    const disk = breachError(
      { killedFor: "disk", peakDiskBytes: 300 * 1024 ** 2, peakEntries: 50_000 },
      limits,
    );
    assert.match(String(disk), /300 MiB in 50000 files, over 16384 MiB/);
  });

  test("a run that ends without a submission is continued in its session, twice at most", async () => {
    const area = mkdtempSync(join(tmpdir(), "thermite-oc-"));
    const runs: RunRequest[] = [];
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        runs.push(req);
        if (req.argv.includes("run"))
          appendFileSync(String(req.env?.THERMITE_OPENCODE_EVENTS), `${EVENTS.join("\n")}\n`);
        return { exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" } as RunOutcome;
      },
      killRole: async () => 0,
    } as unknown as Runner;
    const r = await runOpencodeTrial(
      {
        trialId: "t-2",
        run: "r-1",
        lane: "lane-2",
        workspace: area,
        workspaceRoot: area,
        parentCommit: "c".repeat(40),
        editablePaths: ["src/**"],
        brief: "b",
        wallMs: 60_000,
      },
      {
        runner,
        model,
        apiUrl: "http://h",
        live: () => undefined,
        progress: () => undefined,
        submitted: () => undefined,
        messages: () => ["try the other loop"],
        pollMs: 5,
      },
    );
    const opencodeRuns = runs.filter((x) => x.argv.includes("run"));
    assert.equal(opencodeRuns.length, 3);
    assert.ok(opencodeRuns[1]?.argv.includes("ses_1"));
    assert.match(String(opencodeRuns[2]?.argv.at(-1)), /owner: try the other loop/);
    assert.equal(r.stopped, "no_submission");
  });
});
