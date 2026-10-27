import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runResearchTrial } from "../../src/harness/agents/research-worker.ts";
import { Scheduler } from "../../src/harness/agents/scheduler.ts";
import { runTrial } from "../../src/harness/agents/worker.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import { type Script, startFakeModel } from "../helpers/fake-model.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";
import { makeResearchRun } from "../helpers/research-run.ts";

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

/** The first request of each role, by a key `roleOf` gives it; `answer` replies to every one. */
function recorder(roleOf: (tools: string[]) => string, answer: Script) {
  const sent = new Map<string, Sent>();
  const script: Script = (req) => {
    const tools = req.tools.map((t) => t.function.name);
    const role = roleOf(tools);
    if (!sent.has(role))
      sent.set(role, {
        system: text(req.messages.find((m) => m.role === "system")?.content),
        first: text(req.messages.find((m) => m.role === "user")?.content),
        tools,
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
  return out
    .replace(/\b[0-9a-f]{40}\b/g, "<commit>")
    .replace(/\b([atx])-[0-9a-f]{12,16}\b/g, "<$1-id>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z/g, "<time>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
    .replace(/\b\d+\.\d\d h elapsed/g, "<hours> h elapsed");
}

/** Holds `sent` to its golden file, or writes the file under UPDATE_GOLDEN=1. */
function golden(name: string, sent: Sent | undefined, paths: string[]): void {
  assert.ok(sent, `${name}: no request was sent`);
  const body = [
    "# system",
    normal(sent.system, paths),
    "# first message",
    normal(sent.first, paths),
    "# tools",
    sent.tools.join(", "),
    "",
  ].join("\n");
  const file = join(GOLDEN, `${name}.txt`);
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, body);
    return;
  }
  assert.equal(body, readFileSync(file, "utf8"), `${name}: the prompt changed; see the diff`);
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
    const { sent, script } = recorder(
      (tools) => (tools.includes("submit_plan") ? "planner" : "worker"),
      ({ tools }) =>
        tools.some((t) => t.function.name === "submit_plan")
          ? {
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
                    ],
                  },
                },
              ],
            }
          : { text: "done" },
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
    const { sent, script } = recorder(
      (tools) => (tools.includes("submit_plan") ? "planner" : "worker"),
      () => ({ text: "done" }),
    );
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
    golden("research-planner.pi", sent.get("planner"), paths);
    golden("research-worker.pi", sent.get("worker"), paths);
  });
});
