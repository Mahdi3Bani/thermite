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
  runOpencodeResearchTrial,
  runOpencodeTrial,
} from "./opencode.ts";
import { RESEARCH_SYSTEM } from "./research-tools.ts";
import type { TrialSpec } from "./worker.ts";

// OpenCode v2's JSON output, as the spike recorded it (trimmed).
/** An inbox of the owner's messages as the harness keeps it: a message waits until it is given. */
function fakeInbox(texts: string[]) {
  let waiting = texts.map((text, i) => ({ id: i + 1, text }));
  const given: number[] = [];
  return {
    given,
    add: (text: string) => waiting.push({ id: waiting.length + given.length + 1, text }),
    inbox: {
      waiting: () => waiting,
      given: (ids: number[]) => {
        given.push(...ids);
        waiting = waiting.filter((m) => !ids.includes(m.id));
      },
    },
  };
}

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

  test("after a submission the run is stopped soon: the agent's closing reply is not waited for", async () => {
    const area = mkdtempSync(join(tmpdir(), "thermite-oc-"));
    mkdirSync(join(area, "repo"));
    let submittedAt = 0;
    let killedAt = 0;
    let stop: () => void = () => undefined;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        if (req.argv.includes("run")) {
          submittedAt = Date.now();
          // The agent goes on writing its closing reply until its processes are stopped.
          await new Promise<void>((r) => {
            stop = r;
          });
          return { exitCode: null, signal: "SIGKILL", killedFor: null } as unknown as RunOutcome;
        }
        return { exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" } as RunOutcome;
      },
      killRole: async () => {
        killedAt ||= Date.now();
        stop();
        return 1;
      },
    } as unknown as Runner;
    const r = await runOpencodeTrial(
      {
        trialId: "t-1",
        token: "tok",
        run: "r-1",
        lane: "lane-1",
        workspace: join(area, "repo"),
        workspaceRoot: area,
        parentCommit: "c".repeat(40),
        editablePaths: ["src/**"],
        brief: "Make it faster.",
        wallMs: 60_000,
      },
      {
        runner,
        model,
        apiUrl: "http://127.0.0.1:8700",
        live: () => undefined,
        progress: () => undefined,
        submitted: () => (submittedAt ? { attempt: "a-1", lifecycle: "queued" } : undefined),
        pollMs: 5,
        afterSubmitMs: 50,
      },
    );
    assert.equal(r.stopped, "submitted");
    assert.ok(killedAt - submittedAt >= 50, "the submit command gets its moment to finish");
    assert.ok(killedAt - submittedAt < 2_000, `stopped ${killedAt - submittedAt} ms after it`);
  });

  test("a memory or disk limit that stops OpenCode is named, with its figures", async () => {
    const limits = laneLimits({
      lanes: {
        count: 2,
        trials_per_epoch: 1,
        limits: { run_rss_mib: 4096, workspace_mib: 16384, processes: 2048 },
      },
    });
    assert.match(limitsNote(limits), /Memory: 4096 MiB .*OpenCode itself included/);
    assert.match(limitsNote(limits), /command that takes it over the limit is killed/);
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
    const nprocs: (number | undefined)[] = [];
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
            if (req.argv.includes("run")) nprocs.push(req.nproc);
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
      /memory limit: OpenCode reached 4400 MiB with what it ran, over 4096 MiB/,
    );
    // Not continued: a breach ends the trial.
    assert.equal(runs.filter((x) => x.includes(" run ")).length, 1);
    // OpenCode runs as the lane, under the contract's process limit.
    assert.deepEqual(nprocs, [2048]);
    // The agent was told its limits.
    assert.ok(runs.some((x) => x.includes("Memory: 4096 MiB")));
    const disk = breachError(
      { killedFor: "disk", peakDiskBytes: 300 * 1024 ** 2, peakEntries: 50_000 },
      limits,
    );
    assert.match(String(disk), /300 MiB in 50000 files, over 16384 MiB/);
  });

  test("a run that ends without a submission is continued in its session, twice at most; a waiting message goes into the next continuation and is read when the agent starts on it", async () => {
    const area = mkdtempSync(join(tmpdir(), "thermite-oc-"));
    const owner = fakeInbox(["try the other loop"]);
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
        messages: owner.inbox,
        pollMs: 5,
      },
    );
    const opencodeRuns = runs.filter((x) => x.argv.includes("run"));
    assert.equal(opencodeRuns.length, 3);
    assert.ok(opencodeRuns[1]?.argv.includes("ses_1"));
    // The message waiting when the first run ended went into the first continuation, once.
    assert.match(String(opencodeRuns[1]?.argv.at(-1)), /owner: try the other loop/);
    assert.doesNotMatch(String(opencodeRuns[2]?.argv.at(-1)), /owner:/);
    assert.deepEqual(owner.given, [1]);
    assert.equal(r.stopped, "no_submission");
  });

  test("a research trial runs in its lane's working area as the lane, with the research commands and the folder, and ends when the agent stops", async () => {
    const area = mkdtempSync(join(tmpdir(), "thermite-oc-"));
    const workdir = join(area, "work");
    mkdirSync(workdir);
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
    const progress: number[] = [];
    const r = await runOpencodeResearchTrial(
      {
        trialId: "t-r1",
        token: "tok",
        run: "r-1",
        lane: "lane-1",
        brief: "# Research assignment\nTopic: 2-bit decoding",
        wallMs: 60_000,
      },
      {
        runner,
        model: { ...model, api: "opencode", model: "glm-5.3-flash-free" },
        apiUrl: "http://127.0.0.1:8700",
        area,
        folder: { root: join(area, "folder"), work: workdir },
        live: () => undefined,
        progress: (p) => progress.push(p.turns),
        pollMs: 5,
      },
    );
    assert.equal(r.stopped, "finished");
    assert.equal(r.error, undefined);
    assert.equal(r.turns, 2);
    assert.ok(progress.includes(2));
    assert.ok(runs.every((x) => x.role === "lane-1"));
    const oc = runs.filter((x) => x.argv.includes("run"));
    assert.equal(oc.length, 1, "not continued: the agent stopped and no message waits");
    const run = oc[0] as RunRequest;
    assert.equal(run.cwd, workdir);
    assert.equal(run.env?.HOME, join(area, "opencode-home"));
    assert.equal(run.env?.THERMITE_TRIAL_AUTH, "trial.tok");
    assert.equal(run.env?.THERMITE_WORKSPACE, undefined, "nothing to submit");
    assert.ok(run.argv.includes("opencode/glm-5.3-flash-free"));
    const prompt = String(run.argv.at(-1));
    assert.ok(prompt.startsWith(RESEARCH_SYSTEM));
    assert.match(prompt, /thermite-trial research add_claim - <<'EOF'/);
    assert.match(prompt, /only archived sources can verify a claim/);
    assert.match(prompt, /research folder, .*folder\. Start with INDEX\.md/);
    assert.match(prompt, /Your own working area is .*work: write anything there/);
    assert.match(prompt, /thermite-trial research add_finding - <<'EOF'/);
    assert.match(prompt, /Topic: 2-bit decoding/);
    assert.match(prompt, /This trial lasts 1 minutes/);
  });

  test("a research trial: a failure after some work and the owner's messages continue it; a failure before any work, or the turn cap, ends it", async () => {
    const failed = JSON.stringify({ type: "error", error: { message: "429 rate limited" } });
    const tool = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_9",
      part: { tool: "shell", state: { status: "completed", input: {}, output: "ok" } },
    });
    const step = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_9",
      part: { tokens: { input: 1, output: 1 } },
    });
    const trial = async (
      outputs: string[][],
      o: {
        messages?: string[];
        maxTurns?: number;
        hang?: boolean;
        /** A message the owner sends while this run (from 1) is going on. */
        during?: { run: number; text: string };
      } = {},
    ) => {
      const area = mkdtempSync(join(tmpdir(), "thermite-oc-"));
      const runs: RunRequest[] = [];
      let killed = 0;
      let release: () => void = () => undefined;
      const owner = fakeInbox(o.messages ?? []);
      const runner = {
        run: async (req: RunRequest): Promise<RunOutcome> => {
          runs.push(req);
          if (req.argv.includes("run")) {
            const n = runs.filter((x) => x.argv.includes("run")).length;
            if (o.during?.run === n) owner.add(o.during.text);
            const lines = outputs[n - 1] ?? [];
            appendFileSync(String(req.env?.THERMITE_OPENCODE_EVENTS), `${lines.join("\n")}\n`);
            if (o.hang) await new Promise<void>((r) => (release = r));
          }
          return {
            exitCode: 0,
            signal: null,
            killedFor: null,
            stdout: "",
            stderr: "",
          } as RunOutcome;
        },
        killRole: async () => {
          killed++;
          release();
          return 1;
        },
      } as unknown as Runner;
      const r = await runOpencodeResearchTrial(
        {
          trialId: "t",
          run: "r",
          lane: "lane-2",
          brief: "b",
          wallMs: 60_000,
          maxTurns: o.maxTurns,
        },
        {
          runner,
          model,
          apiUrl: "http://h",
          area,
          folder: { root: area, work: area },
          live: () => undefined,
          progress: () => undefined,
          messages: owner.inbox,
          pollMs: 5,
        },
      );
      return {
        r,
        prompts: runs.filter((x) => x.argv.includes("run")).map((x) => String(x.argv.at(-1))),
        killed,
        given: owner.given,
      };
    };
    const midway = await trial([
      [tool, step, failed],
      [tool, step],
    ]);
    assert.equal(midway.r.stopped, "finished");
    assert.equal(midway.prompts.length, 2);
    assert.match(
      String(midway.prompts[1]),
      /^The model call failed \(429 rate limited\)\. Continue/,
    );
    const early = await trial([[failed]]);
    assert.equal(early.r.stopped, "error");
    assert.equal(early.r.error, "429 rate limited");
    assert.equal(early.prompts.length, 1);
    const owner = await trial(
      [
        [tool, step],
        [tool, step],
      ],
      { messages: ["look at Pascal too"] },
    );
    assert.equal(owner.prompts.length, 2);
    assert.match(String(owner.prompts[1]), /owner: look at Pascal too/);
    assert.deepEqual(owner.given, [1]);
    // A message that arrives during the third pass is not dropped: a fourth carries it, and it is
    // read there (before 063 it was taken from the queue and lost).
    const third = await trial(
      [
        [tool, step, failed],
        [tool, step, failed],
        [tool, step],
        [tool, step],
      ],
      { during: { run: 3, text: "three passes on" } },
    );
    assert.equal(third.prompts.length, 4);
    assert.match(String(third.prompts[3]), /owner: three passes on/);
    assert.deepEqual(third.given, [1]);
    // A failure before any work ends the trial; a waiting message is not taken.
    const noWork = await trial([[tool, step], [failed]], { messages: ["unread"] });
    assert.equal(noWork.r.stopped, "error");
    assert.match(String(noWork.prompts[1]), /owner: unread/);
    assert.deepEqual(noWork.given, [], "the agent never started on it: it stays waiting");
    const capped = await trial([[tool, step, step, step]], { maxTurns: 2, hang: true });
    assert.equal(capped.r.stopped, "turns");
    assert.ok(capped.killed >= 1, "OpenCode stopped at the cap");
  });
});
