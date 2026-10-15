import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { type LaneLimitValues, laneLimits } from "../../core/contract.ts";
import type { Role, Runner } from "../broker/runner.ts";
import { linkSession, type SessionLink } from "./live-session.ts";
import { buildModel, type ModelConfig } from "./model.ts";

/**
 * One worker trial: a fresh agent session (Pi) with Thermite's tools, in the lane's own
 * workspace, ending with at most one submission. Every tool acts as the lane's user through the
 * broker; the agent never touches the judge, the ledger or the model key. No state survives
 * the trial except what the harness records.
 */

export interface TrialSpec {
  trialId: string;
  /** The trial's own token: it binds API calls to this trial and stops working when it ends. */
  token?: string | undefined;
  run: string;
  lane: Role;
  /** The lane's workspace: a git repository at the parent commit, owned by the lane user. */
  workspace: string;
  /** The directory the lane owns for this trial (the workspace's parent); the disk cap's scope. */
  workspaceRoot?: string | undefined;
  parentCommit: string;
  /** The contract's editable paths (globs): only changes there are submitted. */
  editablePaths: string[];
  /** The assignment and context, as the planner and the ledger give them. */
  brief: string;
  wallMs: number;
  /** A cap on the trial's turns: none unless configured (the owner's direction, 2026-10-15). */
  maxTurns?: number | undefined;
  /** The contract's lane limits (the server enforces them too). */
  limits?: LaneLimitValues | undefined;
}

export interface SubmitOutcome {
  attempt: string;
  lifecycle: string;
  violations?: string[];
  duplicate_of?: string;
}

export interface TrialDeps {
  runner: Runner;
  /** argv prefix that runs the lane tool (lanetool.ts or its build). */
  laneTool: string[];
  model: ModelConfig;
  submit(req: {
    run: string;
    lane: string;
    parent: string;
    patch_base64: string;
    hypothesis: string;
    claim?: string | undefined;
    known_flaws: string[];
  }): Promise<SubmitOutcome>;
  status(attempt: string): Promise<unknown>;
  devRun?(req: { lane: string; command: string; timeoutS: number }): Promise<unknown>;
  /** The live view: the session's turns out, the owner's messages in. */
  link?: SessionLink | undefined;
}

export interface TrialResult {
  submitted?: SubmitOutcome | undefined;
  stopped: "submitted" | "no_submission" | "finished" | "interrupted" | "turns" | "wall" | "error";
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  error?: string | undefined;
}

const SYSTEM = `You are a research worker in an automated research harness. You get one assignment and
one trial. Work in the repository in your current directory: read the code, make a focused change
that follows your assignment, build and test it with the run tool, then call submit exactly once
with a short hypothesis. A separate judge you cannot see or change will measure your change; your
own timings are only for your guidance and never count. Keep changes inside the editable paths you
are given. If you find a flaw in your own change, list it in known_flaws: hiding it is worse than
a smaller result. If you cannot make a useful change, explain why in your final message without
submitting.`;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

export async function runTrial(spec: TrialSpec, deps: TrialDeps): Promise<TrialResult> {
  const result: TrialResult = {
    stopped: "no_submission",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const lane = (op: string, args: unknown, stdin?: string) =>
    deps.runner.run({
      role: spec.lane,
      argv: [...deps.laneTool, op, JSON.stringify(args)],
      cwd: spec.workspace,
      timeoutMs: 30_000,
      ...(stdin !== undefined ? { stdin } : {}),
      captureBytes: 4 * 1024 * 1024,
    });
  const laneResult = async (op: string, args: unknown, stdin?: string) => {
    const r = await lane(op, args, stdin);
    try {
      const parsed = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
        ok: boolean;
        error?: string;
      };
      if (!parsed.ok) throw new Error(parsed.error ?? "failed");
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : `tool failed: ${r.stderr.slice(-300)}`);
    }
  };
  const tool = <P extends TSchema>(
    name: string,
    description: string,
    parameters: P,
    run: (p: Record<string, unknown>) => Promise<ReturnType<typeof text> & { terminate?: boolean }>,
  ): AgentTool<P> => ({
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, params) => {
      result.toolCalls++;
      // A submission ends the trial: nothing runs after it, even later calls of the same turn.
      if (result.submitted)
        return { ...text("the trial ended with your submission"), terminate: true };
      return run(params as Record<string, unknown>);
    },
  });

  // Without the contract's limits: the defaults (the server enforces the contract's own).
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const tools: AgentTool[] = [
    tool(
      "list_files",
      "List files under a directory of the repository (default: the root).",
      Type.Object({ path: Type.Optional(Type.String()), depth: Type.Optional(Type.Number()) }),
      async (p) => text(((await laneResult("list", p)).entries as string[]).join("\n")),
    ),
    tool(
      "read_file",
      "Read a text file, with line numbers. Use offset and limit for long files.",
      Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      async (p) => {
        const r = await laneResult("read", p);
        return text(`${r.content}\n(${r.total_lines} lines)`);
      },
    ),
    tool(
      "write_file",
      "Create or replace a file with the given content.",
      Type.Object({ path: Type.String(), content: Type.String() }),
      async (p) => {
        await laneResult("write", { path: p.path }, String(p.content));
        return text(`wrote ${p.path}`);
      },
    ),
    tool(
      "edit_file",
      "Replace an exact piece of text in a file. old_text must occur exactly once unless replace_all is true.",
      Type.Object({
        path: Type.String(),
        old_text: Type.String(),
        new_text: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      async (p) => {
        const r = await laneResult(
          "edit",
          { path: p.path },
          JSON.stringify({ old: p.old_text, new: p.new_text, all: p.replace_all === true }),
        );
        return text(`replaced ${r.replaced} occurrence(s) in ${p.path}`);
      },
    ),
    tool(
      "search",
      "Search the repository for a regular expression; returns file:line matches.",
      Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
      async (p) =>
        text(((await laneResult("search", p)).matches as string[]).join("\n") || "no matches"),
    ),
    tool(
      "run",
      `Run a shell command in the repository (build, test, inspect). Output is truncated. Timings from here never count. Limits: ${limits.runTimeoutS} s per command (timeout_s, default 120), ${limits.runRssMib} MiB of memory, ${limits.workspaceMib} MiB of disk for the workspace.`,
      Type.Object({ command: Type.String(), timeout_s: Type.Optional(Type.Number()) }),
      async (p) => {
        const r = await deps.runner.run({
          role: spec.lane,
          argv: ["sh", "-c", String(p.command)],
          cwd: spec.workspace,
          timeoutMs: Math.min(Number(p.timeout_s ?? 120), limits.runTimeoutS) * 1000,
          rssLimitBytes: limits.runRssMib * 1024 * 1024,
          disk: {
            path: spec.workspaceRoot ?? spec.workspace,
            limitBytes: limits.workspaceMib * 1024 * 1024,
          },
          captureBytes: 32 * 1024,
        });
        return text(
          `exit ${r.exitCode ?? r.signal}${r.killedFor ? ` (killed: ${r.killedFor})` : ""}\n--- stdout\n${r.stdout.slice(-12_000)}\n--- stderr\n${r.stderr.slice(-6_000)}`,
        );
      },
    ),
    tool(
      "dev_run",
      `Run a command on the measurement device (for example a GPU) when the judge is not using it. Use it to check that your change works on the real target. Results are diagnostic only. Limit: ${limits.devRunTimeoutS} s (timeout_s, default 120).`,
      Type.Object({ command: Type.String(), timeout_s: Type.Optional(Type.Number()) }),
      async (p) => {
        if (!deps.devRun) return text("dev_run is not available for this campaign; use run.");
        const r = await deps.devRun({
          lane: spec.lane,
          command: String(p.command),
          timeoutS: Math.min(Number(p.timeout_s ?? 120), limits.devRunTimeoutS),
        });
        return text(JSON.stringify(r).slice(0, 16_000));
      },
    ),
    tool(
      "status",
      "Show the lifecycle and verdict of an attempt you submitted earlier.",
      Type.Object({ attempt: Type.String() }),
      async (p) => text(JSON.stringify(await deps.status(String(p.attempt)))),
    ),
    tool(
      "submit",
      "Submit your change for judging. Call it once, when your change builds and passes your own tests. This ends the trial.",
      Type.Object({
        hypothesis: Type.String({
          description: "What you changed and why it should help, in one or two sentences.",
        }),
        claim: Type.Optional(Type.String({ description: "What you expect the judge to find." })),
        known_flaws: Type.Optional(
          Type.Array(Type.String(), {
            description: "Anything wrong or limited about this change.",
          }),
        ),
      }),
      async (p) => {
        if (result.submitted)
          return { ...text("already submitted in this trial"), terminate: true };
        // Only the editable paths are staged, so build outputs and scratch files never enter a patch.
        const pathspecs = spec.editablePaths
          .map((p) => `':(glob)${p.replace(/'/g, "")}'`)
          .join(" ");
        const diff = await deps.runner.run({
          role: spec.lane,
          argv: ["sh", "-c", `git add -A -- ${pathspecs} && git diff --cached --binary`],
          cwd: spec.workspace,
          timeoutMs: 60_000,
          captureBytes: 32 * 1024 * 1024,
        });
        if (diff.exitCode !== 0)
          return text(`could not prepare the patch: ${diff.stderr.slice(-500)}`);
        if (!diff.stdout.trim()) {
          return text(
            `there are no changes inside the editable paths (${spec.editablePaths.join(", ")})`,
          );
        }
        const out = await deps.submit({
          run: spec.run,
          lane: spec.lane,
          parent: spec.parentCommit,
          patch_base64: Buffer.from(diff.stdout).toString("base64"),
          hypothesis: String(p.hypothesis).slice(0, 2000),
          claim: p.claim === undefined ? undefined : String(p.claim).slice(0, 2000),
          known_flaws: ((p.known_flaws as string[] | undefined) ?? []).map((f) =>
            String(f).slice(0, 1000),
          ),
        });
        result.submitted = out;
        result.stopped = "submitted";
        return {
          ...text(
            `submitted ${out.attempt}: ${out.lifecycle}${out.violations?.length ? `; refused: ${out.violations.join("; ")}` : ""}`,
          ),
          terminate: true,
        };
      },
    ),
  ];

  const { models, model, thinkingLevel } = buildModel(deps.model);
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM, model, tools, thinkingLevel },
    streamFn: models.streamSimple.bind(models),
    // One tool call at a time: lane processes are killed by user when a tool finishes, so
    // parallel calls would kill each other, and a submission must end the trial before anything
    // else runs.
    toolExecution: "sequential",
  });
  if (deps.link) linkSession(agent, deps.link);
  // The budget is stated up front, and the worker is told once when it is nearly spent, so a
  // trial ends with its best change submitted rather than cut off with nothing.
  const started = Date.now();
  const minutes = Math.round(spec.wallMs / 60_000);
  let warned = false;
  const warn = (why: string) => {
    if (warned || result.submitted) return;
    warned = true;
    agent.steer({
      role: "user",
      content: `${why} Build and test what you have, then submit your best working change now, listing anything unfinished in known_flaws. A trial that ends without a submission is lost.`,
      timestamp: Date.now(),
    });
  };
  const maxTurns = spec.maxTurns;
  const warnTurns = maxTurns === undefined ? undefined : Math.max(1, maxTurns - 10);
  agent.subscribe((event) => {
    if (event.type === "turn_end") {
      result.turns++;
      const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
      result.tokensIn += usage?.input ?? 0;
      result.tokensOut += usage?.output ?? 0;
      if (maxTurns !== undefined && result.turns >= maxTurns && !result.submitted) {
        result.stopped = "turns";
        agent.abort();
      } else if (maxTurns !== undefined && warnTurns !== undefined && result.turns >= warnTurns) {
        warn(`${maxTurns - result.turns} turns are left in this trial.`);
      } else if (Date.now() - started >= spec.wallMs * 0.85) {
        warn(
          `About ${Math.max(1, Math.round((spec.wallMs - (Date.now() - started)) / 60_000))} minutes are left in this trial.`,
        );
      }
    }
  });
  const wall = setTimeout(() => {
    if (!result.submitted) result.stopped = "wall";
    agent.abort();
  }, spec.wallMs);
  try {
    await agent.prompt(
      `${spec.brief}\n\nThis trial lasts ${minutes} minutes${maxTurns !== undefined ? ` and at most ${maxTurns} turns (each model reply is one)` : ""}. Submit before it ends.`,
    );
    // A model that stops of its own accord without submitting is told to go on, twice at most;
    // then this trial ends and the lane's next one starts afresh. Cut-off replies and failed
    // calls never end it (keepGoing).
    let nudges = 0;
    for (;;) {
      await keepGoing(
        agent,
        () => result.submitted !== undefined || result.stopped !== "no_submission",
      );
      if (result.submitted || result.stopped !== "no_submission" || nudges++ >= 2) break;
      await agent.prompt(NUDGE);
    }
  } catch (err) {
    if (result.stopped === "no_submission") {
      result.stopped = "error";
      result.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(wall);
  }
  // Why the model stopped, for a trial that ended without a submission. A trial stopped at its
  // own turn or time limit says so; the call the limit aborted is not the model's error.
  const last = lastAssistant(agent);
  if (!result.submitted && (result.stopped === "turns" || result.stopped === "wall")) {
    result.error =
      result.stopped === "turns"
        ? `the trial reached its limit of ${maxTurns} turns before a submission`
        : `the trial reached its ${minutes}-minute limit before a submission`;
  } else if (!result.submitted && !result.error && last && last.stopReason !== "toolUse") {
    result.error = `the model stopped (${last.stopReason})${last.errorMessage ? `: ${last.errorMessage.slice(0, 300)}` : ""}`;
    if (last.stopReason === "error" && result.stopped === "no_submission") result.stopped = "error";
  }
  return result;
}

const NUDGE =
  "You have not called submit yet. Keep working with your tools: make your change, build and test it, then call submit once. If you find no change worth judging, say why in one sentence.";

const CUT_OFF =
  "Your last reply was cut off at the output limit before it made a tool call. Think briefly, then make one tool call; keep each reply short.";

/**
 * Until `done()`, a reply cut off at the output limit is told to think less and act, and a
 * failed model call is retried after a growing pause (5 s to 60 s). Returns when the model
 * stops of its own accord, or once `done()` (a submission, or the trial's time ran out).
 */
export async function keepGoing(agent: Agent, done: () => boolean): Promise<void> {
  let failures = 0;
  while (!done()) {
    const last = lastAssistant(agent);
    if (last?.stopReason === "length") {
      failures = 0;
      await agent.prompt(CUT_OFF);
    } else if (last?.stopReason === "error") {
      failures++;
      await sleepUnlessDone(Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 4)), done);
      if (done()) return;
      await agent.prompt(
        `The model call failed (${(last.errorMessage ?? "no detail").slice(0, 200)}). Continue where you left off.`,
      );
    } else {
      return;
    }
  }
}

/** Waits `ms`, or less once `done()` turns true (the trial's time ran out meanwhile). */
async function sleepUnlessDone(ms: number, done: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !done()) {
    await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
  }
}

function lastAssistant(agent: Agent): { stopReason: string; errorMessage?: string } | undefined {
  const messages = agent.state.messages as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  }[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && m.stopReason)
      return {
        stopReason: m.stopReason,
        ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}),
      };
  }
  return undefined;
}
