import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROLES } from "../../src/agents/roles/index.ts";
import { runClaudeTrial } from "../../src/harness/agents/claude-code.ts";
import { runCodexTrial } from "../../src/harness/agents/codex.ts";
import { checkModel } from "../../src/harness/agents/model-check.ts";
import { runOpencodeTrial } from "../../src/harness/agents/opencode.ts";
import { runResearchTrial } from "../../src/harness/agents/research-worker.ts";
import { Scheduler } from "../../src/harness/agents/scheduler.ts";
import { runTrial, type TrialSpec } from "../../src/harness/agents/worker.ts";
import { createHarnessApi } from "../../src/harness/api.ts";
import {
  LocalRunner,
  type Runner,
  type RunOutcome,
  type RunRequest,
} from "../../src/harness/broker/runner.ts";
import { researchPackage, researchReviewDue } from "../../src/harness/research/review.ts";
import { Reviews } from "../../src/harness/reviews.ts";
import { adviseOnce, emptyAdviseState } from "../../src/supervisor/advise.ts";
import { AdvisorsConfig } from "../../src/supervisor/advisors.ts";
import { type Script, startFakeModel } from "../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../helpers/judge-env.ts";
import { cardsUpToDate, seedClaims, seedSources } from "../helpers/research-cards.ts";
import { answeredResearchRun } from "../helpers/research-paper.ts";
import { fillResearch, makeResearchRun, writeCards } from "../helpers/research-run.ts";

/**
 * Every role's whole prompt today, for a sample run (goal 166): what the role's model is sent,
 * captured where it is sent, so the roles' code can move and change without changing a prompt by
 * accident. Each golden file holds a role's system text, its first message and its tools' names,
 * with what differs between runs (ids, commits, times, paths, ports) written as placeholders.
 * Rewrite them with `UPDATE_GOLDEN=1 node scripts/test.mjs tests/agents/prompts.test.ts`, and read
 * the diff.
 */

const GOLDEN = fileURLToPath(new URL("./golden/prompts/", import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("../../src/harness/agents/lanetool.ts", import.meta.url)),
];

/** What one request sent: the system text, the first message, the tools' names. */
interface Sent {
  system: string;
  first: string;
  tools: string[];
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p as { text?: string }).text ?? "").join("")
      : JSON.stringify(content);

/** The role whose fixed text a system text starts with (src/agents/roles). */
function roleOf(system: string): string {
  const role = ROLES.find((r) =>
    r.texts.some((t) => t.text.length >= 80 && system.startsWith(t.text.slice(0, 80))),
  );
  return role?.id ?? `unknown: ${system.slice(0, 60)}`;
}

/** The first request of each role, by the role's id; `answer` replies to every request. */
function recorder(answer: Script) {
  const sent = new Map<string, Sent>();
  const script: Script = (req) => {
    const system = text(req.messages.find((m) => m.role === "system")?.content);
    const role = roleOf(system);
    if (!sent.has(role))
      sent.set(role, {
        system,
        first: text(req.messages.find((m) => m.role === "user")?.content),
        tools: req.tools.map((t) => t.function.name),
      });
    return answer(req);
  };
  return { sent, script };
}

/** A run's own values as placeholders, so a golden is the same on every run and machine. */
function normal(s: string, paths: string[]): string {
  let out = s;
  for (const p of paths.filter(Boolean).sort((a, b) => b.length - a.length))
    out = out.split(p).join("<path>");
  return (
    out
      .replace(/\b[0-9a-f]{40}\b/g, "<commit>")
      .replace(/\b[0-9a-f]{64}\b/g, "<sha256>")
      .replace(/\b([a-z]{1,2})-[0-9a-f]{8,16}\b/g, "<$1-id>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z/g, "<time>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
      .replace(/\b\d+\.\d\d h elapsed/g, "<hours> h elapsed")
      // What the judge measured varies with the machine's load: its gains, deltas and intervals.
      .replace(/-?\b\d+\.\d{4,}(e-?\d+)?/g, "<measured>")
      .replace(/gain -?\d+(\.\d+)?% above/g, "gain <measured>% above")
  );
}

/** Holds `sent` to its golden file, or writes the file under UPDATE_GOLDEN=1. */
function golden(name: string, sent: Sent | undefined, paths: string[]): void {
  assert.ok(sent, `${name}: no request was sent`);
  sections(name, paths, [
    ["system", sent.system],
    ["first message", sent.first],
    ["tools", sent.tools.join(", ") || "(none)"],
  ]);
}

/** Holds labelled sections to the golden file `name`; the home folder is a path like the rest. */
function sections(name: string, paths: string[], parts: [string, string][]): void {
  const body = `${parts.map(([label, t]) => `# ${label}\n${normal(t, [...paths, homedir()])}`).join("\n")}\n`;
  const file = join(GOLDEN, `${name}.txt`);
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, body);
    return;
  }
  assert.equal(body, readFileSync(file, "utf8"), `${name}: the prompt changed; see the diff`);
}

/** A teacher reads its brief, then answers; the merged by model answers at once. */
const teachersScript: Script = ({ messages }) => {
  const system = text(messages.find((m) => m.role === "system")?.content);
  if (roleOf(system).endsWith("merged-by"))
    return {
      toolCalls: [
        {
          name: "answer",
          args: {
            directives: [{ kind: "try", family: "loops", rationale: "both", citations: ["a"] }],
            experiments: [],
          },
        },
      ],
    };
  if (!messages.some((m) => m.role === "tool")) return { toolCalls: [{ name: "brief", args: {} }] };
  return {
    toolCalls: [
      {
        name: "answer",
        args: {
          summary: "the loop does wasted work",
          recommendations: [{ kind: "try", family: "loops", rationale: "r", citations: ["a"] }],
        },
      },
    ],
  };
};

/** The hill climb's planner's plan: one lane, on a new direction. */
const PLAN = {
  toolCalls: [
    {
      name: "submit_plan",
      args: {
        new_families: [{ id: "loops", description: "simplify the inner loop" }],
        assignments: [
          { lane: "lane-1", family: "loops", focus: "remove wasted work", parent: "champion" },
        ],
      },
    },
  ],
};

/**
 * One round of the supervisor's advisors against `env`'s harness, as on a rig, with each advisor
 * a Pi runtime on a fake model that `script` plays. Returns the folder of the runtimes' key file.
 */
async function adviseRound(
  env: { service: Parameters<typeof createHarnessApi>[0] },
  script: Script,
  roles: (runtime: (name: string) => Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const fake = await startFakeModel(script);
  const keys = mkdtempSync(join(tmpdir(), "thermite-prompts-"));
  writeFileSync(join(keys, "key"), "test-key\n");
  const runtime = (name: string) => ({
    name,
    runtime: "openai",
    base_url: fake.url,
    model: name,
    api_key_file: join(keys, "key"),
  });
  const tokens = { supervisor: "sup-token" };
  const api = createHarnessApi(env.service, tokens);
  await adviseOnce(
    {
      harnessUrl: "http://harness",
      harnessToken: tokens.supervisor,
      home: mkdtempSync(join(tmpdir(), "thermite-prompts-sup-")),
      advisors: AdvisorsConfig.parse(roles(runtime)),
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        return await api.request(`${url.pathname}${url.search}`, init as RequestInit);
      },
    },
    emptyAdviseState(),
  );
  await fake.close();
  return keys;
}

describe("every role's whole prompt for a sample run (goal 166)", () => {
  test("a hill-climb run's planner and worker, in Pi", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.start();
    // The sample run has what a brief carries: an owner's message in force and a queued idea.
    const run = (env.assign.envelope.payload as { run: string }).run;
    const command = (kind: Parameters<typeof env.sign>[0], payload: unknown) =>
      env.service.applyCommand(env.sign(kind, payload));
    await command("message_agent", {
      run,
      to: "all",
      text: "Prefer a change a reader can follow.",
      keep: true,
    });
    await command("queue_add", {
      run,
      title: "Unroll the loop by four",
      family: "loops",
      why: "the loop does one add per step",
    });
    const { sent, script } = recorder(({ tools }) =>
      tools.some((t) => t.function.name === "submit_plan") ? PLAN : { text: "done" },
    );
    const fake = await startFakeModel(script);
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
      owner: "prompts-test",
      runTrial: (spec) =>
        runTrial(spec, {
          runner,
          laneTool,
          model,
          submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
          status: async (id) => env.service.attemptStatus(id),
          // As worker-main.ts wires them, so the worker has the tools it has on a rig.
          devRun: async () => ({}),
          idea: async () => ({ experiment: "x-000000000000" }),
          note: async () => ({ note: 1 }),
          research: async () => ({}),
        }),
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, tmpdir()];
    golden("planner.pi", sent.get("planner"), paths);
    golden("worker.pi", sent.get("worker"), paths);
  });
  test("a research run's planner and worker, in Pi", async () => {
    const r = await makeResearchRun("r-1", {
      contract: { notes: "Weigh the sources that measured more than one campaign." },
    });
    await r.env.service.applyCommand(
      r.env.sign("message_agent", {
        run: r.run,
        to: "all",
        text: "Cite page numbers.",
        keep: true,
      }),
    );
    // Every role answers in words only: the planner's plan is then the fallback, and the worker's
    // trial ends with nothing recorded. Only the first request of each is kept.
    const { sent, script } = recorder(() => ({ text: "done" }));
    const fake = await startFakeModel(script);
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: r.env.service,
      runner: new LocalRunner(r.env.service.paths.scratchDir),
      model,
      owner: "prompts-test",
      research: r.research,
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      // As worker-main.ts wires a research trial.
      runResearchTrial: (spec) =>
        runResearchTrial(spec, {
          model,
          call: async () => ({}),
          idea: async () => ({ experiment: "x-000000000000" }),
          note: async () => ({ note: 1 }),
        }),
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    await r.close();
    const { stateDir, scratchDir } = r.env.service.paths;
    const paths = [scratchDir, stateDir, r.env.root, r.base, tmpdir()];
    golden("research-planner.pi", sent.get("research-planner"), paths);
    golden("research-worker.pi", sent.get("research-worker"), paths);
  });
  test("a hill-climb run's two teachers and their merged by model, in Pi", async () => {
    const env = makeJudgeEnv({
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.service.applyCommand(env.assign);
    const run = (env.assign.envelope.payload as { run: string }).run;
    await env.service.applyCommand(
      env.sign("message_agent", { run, to: "teachers", text: "Look at memory traffic first." }),
    );
    const { sent, script } = recorder(teachersScript);
    const keys = await adviseRound(env, script, (runtime) => ({
      teachers: [runtime("teacher-a"), runtime("teacher-b")],
      merged_by: runtime("merged-by"),
    }));
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, keys, tmpdir()];
    golden("teacher.pi", sent.get("teacher"), paths);
    golden("merged-by.pi", sent.get("merged-by"), paths);
  });
  test("a hill-climb run's auditor, in Pi, on a win that asks for an audit", async () => {
    const env = makeJudgeEnv({
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 0.15 },
        },
      },
    });
    await env.service.applyCommand(env.assign);
    const { attempt } = await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "drop the waste",
        known_flaws: [],
      },
      "t",
    );
    await env.drain();
    assert.equal(String(env.ledger.getAttempt(attempt)?.lifecycle), "awaiting_audit");
    const { sent, script } = recorder(() => ({
      toolCalls: [
        { name: "answer", args: { decision: "needs_owner", reasons: "unsure", citations: [] } },
      ],
    }));
    const keys = await adviseRound(env, script, (runtime) => ({ auditor: runtime("auditor") }));
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, keys, tmpdir()];
    golden("auditor.pi", sent.get("auditor"), paths);
  });
  test("a research run's two teachers and their merged by model, in Pi", async () => {
    const r = await makeResearchRun("r-1", {
      contract: { notes: "Weigh the sources that measured more than one campaign." },
    });
    await r.env.service.applyCommand(
      r.env.sign("message_agent", { run: r.run, to: "teachers", text: "Find primary sources." }),
    );
    const { sent, script } = recorder(teachersScript);
    const keys = await adviseRound(r.env, script, (runtime) => ({
      teachers: [runtime("teacher-a"), runtime("teacher-b")],
      merged_by: runtime("merged-by"),
    }));
    await r.close();
    const { stateDir, scratchDir } = r.env.service.paths;
    const paths = [scratchDir, stateDir, r.env.root, r.base, keys, tmpdir()];
    golden("research-teacher.pi", sent.get("research-teacher"), paths);
    golden("research-merged-by.pi", sent.get("research-merged-by"), paths);
  });
  test("a research run's synthesizer, in Pi, with verified claims to write cards from", async () => {
    const r = await makeResearchRun("r-1");
    const ledger = r.env.service.ledger;
    const sources = [...seedSources(ledger, "r-1").values()];
    const from = Date.now() - 24 * 3_600_000;
    for (const [question, tag] of [
      [0, "qa"],
      [1, "qb"],
    ] as const)
      seedClaims(ledger, "r-1", { question, n: 3, sources, from, tag });
    // Every role answers in words: only the first request of each is kept.
    const { sent, script } = recorder(() => ({ text: "done" }));
    const keys = await adviseRound(r.env, script, (runtime) => ({
      teachers: [runtime("teacher-1")],
    }));
    await r.close();
    const { stateDir, scratchDir } = r.env.service.paths;
    const paths = [scratchDir, stateDir, r.env.root, r.base, keys, tmpdir()];
    golden("synthesizer.pi", sent.get("synthesizer"), paths);
  });
  test("a goal run's reviewer, in Pi, on a goal the review panel checks", async () => {
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 1e12 },
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.start();
    await env.drain();
    assert.ok(env.service.reviewPackages()[0], "a review waits for the panel");
    const { sent, script } = recorder(() => ({ text: "done" }));
    const keys = await adviseRound(env, script, (runtime) => ({
      review_panel: [runtime("reviewer-1"), runtime("reviewer-2")],
    }));
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, keys, tmpdir()];
    golden("reviewer.pi", sent.get("reviewer"), paths);
  });
  test("a research run's reviewer, in Pi, once its review is due", async () => {
    const r = await makeResearchRun("r-1");
    const ids = await fillResearch(r);
    writeCards(r, ids);
    const ledger = r.env.service.ledger;
    ledger.db
      .prepare("update run set created_at = ? where id = ?")
      .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), "r-1");
    const contract = r.env.service.contractFor("r-1") as Parameters<typeof researchPackage>[2];
    const due = researchReviewDue(ledger, "r-1", contract, r.research.clock("r-1"));
    assert.ok(due.due);
    new Reviews(ledger).requestResearch({
      run: "r-1",
      marker: due.marker,
      pkg: researchPackage(ledger, "r-1", contract),
      by: "s",
    });
    cardsUpToDate(r.env.service, "r-1");
    const { sent, script } = recorder(() => ({ text: "done" }));
    const keys = await adviseRound(r.env, script, (runtime) => ({
      review_panel: [runtime("reviewer-1"), runtime("reviewer-2")],
    }));
    await r.close();
    const { stateDir, scratchDir } = r.env.service.paths;
    const paths = [scratchDir, stateDir, r.env.root, r.base, keys, tmpdir()];
    golden("research-reviewer.pi", sent.get("research-reviewer"), paths);
  });

  test("a research run's final writer, in Pi, once its review passed, with no STE checker", async () => {
    const s = await answeredResearchRun("r-1");
    await s.env.service.setAdvisors(
      { auditor: false, review_panel: 0, writer: true },
      "supervisor",
    );
    assert.ok(s.env.service.papers.request("r-1", "s"));
    cardsUpToDate(s.env.service, "r-1");
    const { sent, script } = recorder(() => ({ text: "done" }));
    const keys = await adviseRound(s.env, script, (runtime) => ({
      teachers: [runtime("teacher-1")],
    }));
    await s.close();
    const { stateDir, scratchDir } = s.env.service.paths;
    const paths = [scratchDir, stateDir, s.env.root, s.base, keys, tmpdir()];
    golden("final-writer.pi", sent.get("final-writer"), paths);
  });
  test("the compaction summary, in Pi, of a worker's conversation past its compaction point", async () => {
    const env = makeJudgeEnv({ lanes: { count: 1, trials_per_epoch: 1 } });
    await env.start();
    // The worker's first call reports a conversation near its window: the harness then asks the
    // same model for a summary before the next call.
    const { sent, script } = recorder(({ tools, messages }) => {
      if (tools.some((t) => t.function.name === "submit_plan")) return PLAN;
      if (!tools.length) return { text: "The worker listed the files and read nothing yet." };
      if (!messages.some((m) => m.role === "tool"))
        return {
          toolCalls: [{ name: "list_files", args: {} }],
          usage: { prompt: 31_000, completion: 20 },
        };
      return { text: "done" };
    });
    const fake = await startFakeModel(script);
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
      owner: "prompts-test",
      runTrial: (spec) =>
        runTrial(spec, {
          runner,
          laneTool,
          model,
          submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
          status: async (id) => env.service.attemptStatus(id),
        }),
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, tmpdir()];
    golden("compaction.pi", sent.get("compaction"), paths);
  });
  test("the model check, in Pi", async () => {
    const { sent, script } = recorder(() => ({
      toolCalls: [{ name: "echo", args: { text: "ok" } }],
    }));
    const fake = await startFakeModel(script);
    await checkModel({
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    });
    await fake.close();
    // Its texts are too short to name it by: the one request sent is the model check's. Its word
    // is new each time.
    assert.equal(sent.size, 1);
    const [check] = [...sent.values()];
    assert.ok(check);
    const word = (t: string) => t.replace(/thermite-[a-z0-9]+/g, "thermite-<word>");
    golden("model-check.pi", { ...check, first: word(check.first) }, [tmpdir()]);
  });
  test("a hill-climb run's worker in OpenCode, Claude Code and Codex: what each program is given", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.start();
    const run = (env.assign.envelope.payload as { run: string }).run;
    await env.service.applyCommand(
      env.sign("message_agent", {
        run,
        to: "all",
        text: "Prefer a change a reader can follow.",
        keep: true,
      }),
    );
    // The trial the scheduler starts for the sample run, as every program gets it.
    let spec: TrialSpec | undefined;
    const { script } = recorder(() => PLAN);
    const fake = await startFakeModel(script);
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "prompts-test",
      runTrial: async (s) => {
        spec ??= s;
        return { stopped: "no_submission", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    assert.ok(spec);
    /** Every run the trial asks for, answered as a program that did nothing. */
    const recording = () => {
      const runs: RunRequest[] = [];
      const runner = {
        run: async (req: RunRequest) => {
          runs.push(req);
          return {
            exitCode: 0,
            signal: null,
            killedFor: null,
            stdout: "",
            stderr: "",
          } as RunOutcome;
        },
        killRole: async () => 0,
      } as unknown as Runner;
      return { runs, runner };
    };
    const common = {
      apiUrl: "http://127.0.0.1:8700",
      live: () => undefined,
      progress: () => undefined,
      submitted: () => undefined,
      pollMs: 5,
      afterSubmitMs: 5,
    };
    const programs = [
      [
        "worker.opencode",
        (runner: Runner, s: TrialSpec) =>
          runOpencodeTrial(s, {
            ...common,
            runner,
            model: {
              baseUrl: "http://127.0.0.1:9",
              model: "m",
              apiKey: "k",
              contextWindow: 32000,
              maxTokens: 2000,
            },
          }),
      ],
      [
        "worker.claude-code",
        (runner: Runner, s: TrialSpec) =>
          runClaudeTrial(s, {
            ...common,
            runner,
            model: {
              api: "claude" as const,
              harness: "claude-code" as const,
              baseUrl: "https://api.anthropic.com",
              model: "claude-test",
              apiKey: "token",
              contextWindow: 1_000_000,
              maxTokens: 0,
            },
          }),
      ],
      [
        "worker.codex",
        (runner: Runner, s: TrialSpec) =>
          runCodexTrial(s, {
            ...common,
            runner,
            model: {
              api: "chatgpt" as const,
              harness: "codex" as const,
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-test",
              apiKey: "access",
              contextWindow: 0,
              maxTokens: 0,
              reasoning: "off" as const,
            },
          }),
      ],
    ] as const;
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, tmpdir()];
    for (const [name, start] of programs) {
      const { runs, runner } = recording();
      await start(runner, spec);
      // The program's own run: the one whose input is the brief.
      const given = runs.find((r) => String(r.stdin ?? "").includes("# Assignment"));
      assert.ok(given, `${name}: no run was given the brief`);
      // Where the program is installed differs from machine to machine.
      const command = given.argv
        .join(" ")
        .replace(/\S*\/(opencode|codex|claude)(?=\s|$)/g, "<bin>/$1");
      sections(name, paths, [
        ["command", command],
        ["standard input", String(given.stdin)],
      ]);
    }
  });
});
