import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type Message, type TSchema, Type } from "@earendil-works/pi-ai";
import type { McpCallResult } from "../../common/mcp-client.ts";
import { type LaneLimitValues, laneLimits, SHARED_DEV_RUN_S } from "../../core/contract.ts";
import { notesInstruction } from "../../core/journal.ts";
import type { McpToolInfo } from "../../core/mcp.ts";
import type { CallUsage } from "../../core/usage.ts";
import type { Role, Runner } from "../broker/runner.ts";
import { type CompactionReport, Compactor, summarizer } from "./compaction.ts";
import { linkSession, type SessionLink } from "./live-session.ts";
import { mcpAgentTools, mcpLine } from "./mcp-tools.ts";
import { buildModel, type ModelConfig } from "./model.ts";
import { NOTE_TOOL, type NoteRequest, writeNote } from "./notes-tool.ts";
import { researchAgentTools } from "./research-agent-tools.ts";
import { CODE_RESEARCH_TOOLS, codeResearchNote } from "./research-tools.ts";
import { PiMeter } from "./usage-meter.ts";

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
  /**
   * The MCP servers the run's kit gives its workers (goal 068), by name: the trial reaches them
   * through the harness's gateway with its own token.
   */
  mcpServers?: string[] | undefined;
}

/** A worker's idea for its run's queue (the idea tool, or `thermite-trial idea`). */
export interface IdeaInput {
  title: string;
  why?: string | undefined;
  family?: string | undefined;
  details?: string | undefined;
}

/**
 * The idea tool, the same for code and research workers in Pi: the worker proposes an experiment
 * for the run's queue while it works. It waits as proposed until the planner (or the owner)
 * queues or drops it, and does not end the trial.
 */
export const IDEA_TOOL = {
  name: "idea",
  description:
    "Propose another experiment for the run's queue: something worth trying that is not your assignment. The planner decides whether it is queued; this does not end your trial.",
  parameters: Type.Object({
    title: Type.String({ description: "What to try, in a few words" }),
    why: Type.Optional(Type.String({ description: "Why it is worth trying" })),
    family: Type.Optional(Type.String({ description: "Its direction (approach family)" })),
    details: Type.Optional(Type.String({ description: "How, if it needs saying" })),
  }),
};

/** Runs the idea tool: the proposal through the harness API, and the answer in words. */
export async function proposeIdea(
  idea: (req: IdeaInput) => Promise<{ experiment: string }>,
  p: Record<string, unknown>,
): Promise<ReturnType<typeof text>> {
  const str = (k: string, n: number) =>
    typeof p[k] === "string" && (p[k] as string).trim()
      ? (p[k] as string).trim().slice(0, n)
      : undefined;
  const title = str("title", 200);
  if (!title) return text("an idea needs a title: what to try, in a few words");
  try {
    const out = await idea({
      title,
      why: str("why", 2000),
      family: str("family", 80),
      details: str("details", 4000),
    });
    return text(
      `proposed ${out.experiment}: it waits until the planner or the campaign's owner queues it or drops it. Your trial goes on.`,
    );
  } catch (err) {
    return text(`the idea was not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  devRun?(req: { lane: string; command: string; timeoutS?: number }): Promise<unknown>;
  /** An idea for the run's experiment queue: proposed by this lane, for the planner to take. */
  idea?(req: IdeaInput): Promise<{ experiment: string }>;
  /** A field note: written by this lane, in the run's journal. */
  note?(req: NoteRequest): Promise<{ note: number }>;
  /** The research service (sources, claims and notes in the run's folder): one operation. */
  research?(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** The live view: the session's turns out, the owner's messages in. */
  link?: SessionLink | undefined;
  /** The MCP tools the run's kit gives its workers, and how to call one (the harness's gateway). */
  mcp?: McpForAgent | undefined;
  /** Where a compaction keeps the conversation, and where it is said (goal 070). */
  compaction?: CompactionLink | undefined;
  /** Each model call's usage, as the trial's code measures it (goal 075). */
  modelUsage?: ((u: CallUsage) => void) | undefined;
}

/**
 * A trial's compactions through the harness (goal 070): the harness keeps each conversation in
 * the run's research folder, where the agent can read it, and records each compaction.
 */
export interface CompactionLink {
  /** Keeps the conversation before compaction `n`: its path on disk and in the run's folder. */
  keep(n: number, markdown: string): Promise<{ path: string; rel: string }>;
  /** Records the compaction: the event, and the live view's lines with the summary. */
  done(r: CompactionReport): Promise<unknown>;
}

/** An agent's MCP tools in Pi: what the gateway listed for it, and a call through the gateway. */
export interface McpForAgent {
  tools: McpToolInfo[];
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

export interface TrialResult {
  submitted?: SubmitOutcome | undefined;
  stopped:
    | "submitted"
    | "no_submission"
    | "finished"
    | "interrupted"
    | "turns"
    | "wall"
    | "context"
    | "error";
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** How many times the trial's conversation was compacted (goal 070). */
  compactions?: number | undefined;
  /** Model calls whose usage the worker could not hand to the harness (goal 075). */
  usageUnrecorded?: number | undefined;
  error?: string | undefined;
  /** The model's provider refused for now (a subscription's full usage window): not before this (ISO). */
  retryAfter?: string | undefined;
}

const SYSTEM = `You are a research worker in an automated research harness. You get one assignment and
one trial. Work in the repository in your current directory: read the code, make a focused change
that follows your assignment, build and test it with the run tool, then call submit exactly once
with a short hypothesis. A separate judge you cannot see or change will measure your change; your
own timings are only for your guidance and never count. Keep changes inside the editable paths you
are given. If you find a flaw in your own change, list it in known_flaws: hiding it is worse than
a smaller result. If you cannot make a useful change, explain why in your final message without
submitting. If you see another experiment worth trying that is not your assignment, propose it
with the idea tool: the planner or the campaign's owner decides whether it is queued, and your trial goes on.`;

/** Field notes, and sources, claims and notes from the web, for a code trial (goal 065). */
const NOTES_AND_SOURCES = `${notesInstruction("with the note tool")}

${codeResearchNote("with the fetch tool")}`;

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
      `Run a shell command in the repository (build, test, inspect). Output is truncated to its end. Timings from here never count. ${
        limits.runTimeoutS !== undefined
          ? `A command is stopped after ${limits.runTimeoutS} s (the campaign's limit), or sooner with timeout_s.`
          : "A command runs until it finishes; set timeout_s to stop it sooner."
      } What it starts in the background keeps running until your trial ends: send its output to a file (cmd > log 2>&1 &) and read the file. Memory: ${limits.runRssMib} MiB for everything your lane runs at once. Disk: ${limits.workspaceMib} MiB for the workspace.`,
      Type.Object({ command: Type.String(), timeout_s: Type.Optional(Type.Number()) }),
      async (p) => {
        const r = await deps.runner.run({
          role: spec.lane,
          argv: ["sh", "-c", String(p.command)],
          cwd: spec.workspace,
          ...timeLimit(p.timeout_s, limits.runTimeoutS),
          rssLimitBytes: limits.runRssMib * 1024 * 1024,
          disk: {
            path: spec.workspaceRoot ?? spec.workspace,
            limitBytes: limits.workspaceMib * 1024 * 1024,
          },
          captureBytes: 32 * 1024,
        });
        const earlier = r.backgroundKilled
          ? `\n(your background processes were killed earlier: ${r.backgroundKilled} limit)`
          : "";
        return text(
          `exit ${r.exitCode ?? r.signal}${r.killedFor ? ` (killed: ${r.killedFor})` : ""}${earlier}\n--- stdout\n${r.stdout.slice(-6_000)}\n--- stderr\n${r.stderr.slice(-3_000)}\n(output trimmed to its end: pipe through grep, head or tail to see other parts)`,
        );
      },
    ),
    tool(
      "dev_run",
      `Run a command on the measurement device (for example a GPU) when the judge is not using it. Use it to check that your change works on the real target. Results are diagnostic only. ${
        limits.devRunTimeoutS !== undefined
          ? `A dev run is stopped after ${limits.devRunTimeoutS} s (the campaign's limit), or sooner with timeout_s.`
          : `A dev run ends when its command does, or at timeout_s; where the judge shares the device, it is stopped after ${SHARED_DEV_RUN_S} s at most.`
      } Nothing it starts on the device outlives it.`,
      Type.Object({ command: Type.String(), timeout_s: Type.Optional(Type.Number()) }),
      async (p) => {
        if (!deps.devRun) return text("dev_run is not available for this campaign; use run.");
        const r = await deps.devRun({
          lane: spec.lane,
          command: String(p.command),
          ...(Number(p.timeout_s) > 0 ? { timeoutS: Math.trunc(Number(p.timeout_s)) } : {}),
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
    ...(deps.idea
      ? [
          tool(IDEA_TOOL.name, IDEA_TOOL.description, IDEA_TOOL.parameters, (p) =>
            proposeIdea(deps.idea as NonNullable<TrialDeps["idea"]>, p),
          ),
        ]
      : []),
    ...(deps.note
      ? [
          tool(NOTE_TOOL.name, NOTE_TOOL.description, NOTE_TOOL.parameters, (p) =>
            writeNote(deps.note as NonNullable<TrialDeps["note"]>, p),
          ),
        ]
      : []),
    // Sources, claims and notes in the run's research folder, as a research trial records them.
    ...(deps.research
      ? researchAgentTools(
          CODE_RESEARCH_TOOLS,
          async (op, args) => {
            // A submission ends the trial: nothing runs after it.
            if (result.submitted) return "the trial ended with your submission";
            try {
              return await (deps.research as NonNullable<TrialDeps["research"]>)(op, args);
            } catch (err) {
              return `refused: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
          { run: spec.run, lane: spec.lane },
          () => {
            result.toolCalls++;
          },
        )
      : []),
    // The MCP tools the run's kit gives its workers, through the harness's gateway (goal 068).
    ...(deps.mcp
      ? mcpAgentTools(
          deps.mcp.tools,
          async (server, t, args) =>
            // A submission ends the trial: nothing runs after it.
            result.submitted
              ? {
                  content: [{ type: "text", text: "the trial ended with your submission" }],
                  isError: true,
                }
              : (deps.mcp as McpForAgent).call(server, t, args),
          () => {
            result.toolCalls++;
          },
        )
      : []),
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
  // Each model call's usage, the compaction summaries' included (goal 075).
  const meter = deps.modelUsage ? new PiMeter(deps.modelUsage) : undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: `${SYSTEM}\n\n${NOTES_AND_SOURCES}${deps.mcp?.tools.length ? `\n\n${mcpLine([...new Set(deps.mcp.tools.map((t) => t.server))])}` : ""}`,
      model,
      tools,
      thinkingLevel,
    },
    streamFn: meter ? meter.streamFn(models) : models.streamSimple.bind(models),
    convertToLlm: withoutPastThinking,
    // One tool call at a time: lane processes are killed by user when a tool finishes, so
    // parallel calls would kill each other, and a submission must end the trial before anything
    // else runs.
    toolExecution: "sequential",
  });
  meter?.watch(agent);
  // Near the model's window the conversation is compacted and the trial goes on (goal 070): a
  // conversation that grows never ends a trial nor asks for an early submission.
  const compactor = new Compactor({
    window: deps.model.contextWindow,
    at: deps.model.compactAt,
    convert: withoutPastThinking,
    summarize: summarizer(deps.model, meter),
    keep: async (n, markdown) => {
      if (!deps.compaction) throw new Error("this trial has no place to keep it");
      const { path } = await deps.compaction.keep(n, markdown);
      return {
        path,
        read: `Read it with the run tool when you need a detail, for example grep -n 'a word' ${path} or sed -n '1,200p' ${path}`,
      };
    },
    done: async (r) => deps.compaction?.done(r),
    stop: (reason) => {
      if (result.submitted) return;
      result.stopped = "context";
      result.error = reason;
      agent.abort();
    },
    title: `Trial ${spec.trialId} (${spec.lane})`,
  });
  agent.prepareRequest = compactor.hook(agent);
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
  // After the turn cap above: the owner's messages are not fetched on the turn it stops. After a
  // submission none are taken either: the trial is over, and the lane's next trial, which can
  // act on them, reads them in its brief.
  const link = deps.link;
  const waiting = link?.messages;
  if (link)
    linkSession(agent, {
      ...link,
      messages: waiting ? async () => (result.submitted ? [] : waiting()) : undefined,
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
      const end = await keepGoing(
        agent,
        () => result.submitted !== undefined || result.stopped !== "no_submission",
        deps.model.contextWindow,
        compactor,
      );
      if (end && !result.submitted) {
        result.stopped = end.stopped;
        result.error = end.error;
        break;
      }
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
  if (compactor.count) result.compactions = compactor.count;
  // Why the model stopped, for a trial that ended without a submission. A trial stopped at its
  // own turn or time limit says so, and one whose conversation does not fit even compacted has
  // its reason already; the call the stop aborted is not the model's error.
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
 * What is sent to the model: the conversation with every earlier reply's thinking left out (the
 * replies' text, tool calls and their results stay). Qwen-family chat templates keep earlier
 * reasoning only until the next user turn, so sending it both grows each prompt by all the
 * thinking so far and, whenever a nudge or warning is appended, changes the prompt's prefix, which
 * forces a shared model server to read the whole conversation again.
 */
export function withoutPastThinking(messages: AgentMessage[]): Message[] {
  return messages
    .filter(
      (m) =>
        m.role === "system" ||
        m.role === "user" ||
        m.role === "assistant" ||
        m.role === "toolResult",
    )
    .map((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? { ...m, content: m.content.filter((b) => (b as { type?: string }).type !== "thinking") }
        : m,
    ) as Message[];
}

/** Why keepGoing ended a trial early: its context is full even compacted, or the model is stuck or down. */
export interface TrialEnd {
  stopped: "context" | "error";
  error: string;
}

/** Errors a provider gives for a request longer than the model's context. */
const CONTEXT_ERROR = /context|too long|maximum (context )?length|exceed/i;

/** Said to the agent after the harness compacted a full conversation. */
const COMPACTED =
  "The model's context was full, so the harness compacted the conversation. Continue where you left off.";

/**
 * Until `done()`, a reply cut off at the output limit is told to think less and act, and a
 * failed model call is retried after a growing pause. A full context (a cut-off reply with almost
 * no output, a prompt at the window, or a context-length error) is compacted and the trial goes
 * on (goal 070); only a conversation that the compactor cannot make fit, twice running, ends it.
 * Returns undefined when the model stops of its own accord (or once `done()`), or why the trial
 * must end: a full context that compaction cannot help, or a model cut off 5 times running or
 * failing 6 times running, which is left to the scheduler's backoff rather than retried against
 * a shared endpoint for the rest of the trial. The lane's next trial starts afresh either way, so
 * none of this ends research.
 */
export async function keepGoing(
  agent: Agent,
  done: () => boolean,
  contextWindow?: number | undefined,
  compactor?: Pick<Compactor, "force" | "count"> | undefined,
): Promise<TrialEnd | undefined> {
  let failures = 0;
  let cutoffs = 0;
  // Compactions forced in a row by a full context, with no finished reply between them.
  let forced = 0;
  let replies = 0;
  let repliesAtForce = -1;
  const unsubscribe = agent.subscribe((e) => {
    if (e.type !== "turn_end") return;
    const stop = (e.message as { stopReason?: string }).stopReason;
    if (stop === "stop" || stop === "toolUse") replies++;
  });
  /** A full context: compacted and continued, or the trial's end when that cannot help. */
  const full = async (why: string): Promise<TrialEnd | undefined> => {
    if (replies !== repliesAtForce) forced = 0;
    if (!compactor || forced >= 2)
      return {
        stopped: "context",
        error: `the conversation filled the model's context${compactor ? " again right after a compaction" : ""} (${why})`,
      };
    forced++;
    repliesAtForce = replies;
    compactor.force();
    await agent.prompt(COMPACTED);
    return undefined;
  };
  try {
    while (!done()) {
      const last = lastAssistant(agent);
      if (last?.stopReason === "length") {
        failures = 0;
        const atWindow = (contextWindow ?? 0) > 0 && last.input >= 0.95 * (contextWindow as number);
        if (last.output < 64 || atWindow) {
          const end = await full(`${last.input} tokens in, ${last.output} out`);
          if (end) return end;
          continue;
        }
        if (++cutoffs >= 5) {
          return {
            stopped: "error",
            error: "the model's replies were cut off 5 times in a row without a tool call",
          };
        }
        await agent.prompt(CUT_OFF);
      } else if (last?.stopReason === "error") {
        cutoffs = 0;
        const message = (last.errorMessage ?? "no detail").slice(0, 200);
        if (CONTEXT_ERROR.test(message)) {
          const end = await full(message);
          if (end) return end;
          continue;
        }
        if (++failures > 5) {
          return {
            stopped: "error",
            error: `the model call failed ${failures} times in a row: ${message}`,
          };
        }
        await sleepUnlessDone(Math.min(60_000, 5_000 * 2 ** (failures - 1)), done);
        if (done()) return undefined;
        await agent.prompt(`The model call failed (${message}). Continue where you left off.`);
      } else {
        return undefined;
      }
    }
    return undefined;
  } finally {
    unsubscribe();
  }
}

/** Waits `ms`, or less once `done()` turns true (the trial's time ran out meanwhile). */
async function sleepUnlessDone(ms: number, done: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !done()) {
    await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
  }
}

function lastAssistant(
  agent: Agent,
): { stopReason: string; errorMessage?: string; input: number; output: number } | undefined {
  const messages = agent.state.messages as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: { input?: number; output?: number };
  }[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && m.stopReason)
      return {
        stopReason: m.stopReason,
        ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}),
        input: m.usage?.input ?? 0,
        output: m.usage?.output ?? 0,
      };
  }
  return undefined;
}

/** A command's time limit: the one asked for (seconds), within the campaign's if it sets one. */
function timeLimit(askedS: unknown, limitS: number | undefined): { timeoutMs?: number } {
  const asked = Number(askedS) > 0 ? Math.ceil(Number(askedS)) : undefined;
  const s = asked === undefined ? limitS : limitS === undefined ? asked : Math.min(asked, limitS);
  return s !== undefined ? { timeoutMs: s * 1000 } : {};
}
