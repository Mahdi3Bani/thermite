import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { Compactor, summarizer } from "../../../agents/compaction/index.ts";
import { mcpAgentTools, mcpLine } from "../../../agents/mcp/index.ts";
import { buildModel, type ModelConfig, PiMeter } from "../../../agents/model/index.ts";
import { RESEARCH_WORKER_NOTES, RESEARCH_WORKER_SYSTEM } from "../../../agents/roles/index.ts";
import {
  NOTE_TOOL,
  NoteLimit,
  type NoteRequest,
  READ_MAX,
  RESEARCH_TOOLS,
  type ResearchFolderPaths,
  researchFolderNote,
  researchOutput,
} from "../../../agents/tools/index.ts";
import { errorText } from "../../../common/errors.ts";
import type { LaneLimitValues } from "../../../core/contract.ts";
import type { CallUsage } from "../../../core/usage.ts";
import { linkSession, type SessionLink } from "../live-session.ts";
import { type FailureCount, failingOf, ProviderWatch } from "../provider-errors.ts";
import { guardRepeats } from "../repeats.ts";
import {
  IDEA_TOOL,
  type IdeaInput,
  listFiles,
  proposeIdea,
  readFile,
  removeFile,
  researchAgentTools,
  searchFiles,
  writeFile,
} from "../tools/index.ts";
import { TrialClock } from "../trial-clock.ts";
import type { CompactionLink, McpForAgent, ProviderWait, TrialResult } from "../worker/index.ts";
import { keepGoing, watchedStream, withoutPastThinking } from "../worker/index.ts";

/**
 * A research trial in Pi: a fresh agent session with the research tools and file tools over its
 * research folder, and no shell. (In OpenCode, cli/opencode.ts, the agent keeps its shell and files
 * and runs the same research tools as commands.) Every research action goes through the
 * harness's research service: the harness fetches and archives, and code decides whether a claim
 * or a finding holds. The agent cannot end the campaign; a trial just ends.
 */

export interface ResearchTrialSpec {
  trialId: string;
  /** The trial's own token (see TrialSpec). */
  token?: string | undefined;
  run: string;
  lane: string;
  brief: string;
  /** The trial's length: none unless the campaign or the rig sets one (goal 079). */
  wallMs?: number | undefined;
  /** A cap on the trial's turns: none unless configured. */
  maxTurns?: number | undefined;
  /** The lane's limits (an OpenCode trial runs under them; Pi's worker under its own). */
  limits?: LaneLimitValues | undefined;
  /** The run's research folder and this lane's working area in it (the harness prepares both). */
  folder?: ResearchFolderPaths | undefined;
  /** The MCP servers the run's kit gives its workers (goal 068), by name (see TrialSpec). */
  mcpServers?: string[] | undefined;
}

export interface ResearchDeps {
  model: ModelConfig;
  call(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** The live view: the session's turns out, the owner's messages in. */
  link?: SessionLink | undefined;
  /** A research task for the run's queue, proposed by this lane (the idea tool). */
  idea?: ((req: IdeaInput) => Promise<{ experiment: string }>) | undefined;
  /** A field note, written by this lane in the run's journal (the note tool). */
  note?: ((req: NoteRequest) => Promise<{ note: number }>) | undefined;
  /** The MCP tools the run's kit gives its workers (goal 068), through the harness's gateway. */
  mcp?: McpForAgent | undefined;
  /** Where a compaction keeps the conversation, and where it is said (goal 070). */
  compaction?: CompactionLink | undefined;
  /** Each model call's usage, as the trial's code measures it (goal 075). */
  modelUsage?: ((u: CallUsage) => void) | undefined;
  /** Told of each wait for the provider (a rate limit, a failed call) before it (goal 079). */
  waiting?: ((w: ProviderWait) => void) | undefined;
}

const out = (value: unknown) => ({
  content: [{ type: "text" as const, text: researchOutput(value) }],
  details: {},
});

export async function runResearchTrial(
  spec: ResearchTrialSpec,
  deps: ResearchDeps,
): Promise<TrialResult> {
  const result: TrialResult = {
    stopped: "no_submission",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  // Near a set length's end, each tool result says the time left, and the end stops a tool (goal 144).
  const clock = new TrialClock(spec.wallMs);
  const notes = new NoteLimit(spec.limits?.notesPerTurn); // the notes of one reply (goal 147)
  const tools: AgentTool[] = [
    ...researchAgentTools(
      RESEARCH_TOOLS.map((t) => t.name),
      deps.call,
      { run: spec.run, lane: spec.lane },
      () => {
        result.toolCalls++;
      },
    ),
    ...(spec.folder ? folderTools(spec.folder, result) : []),
    ...(deps.idea
      ? [
          {
            name: IDEA_TOOL.name,
            label: IDEA_TOOL.name,
            description: IDEA_TOOL.description,
            parameters: IDEA_TOOL.parameters,
            execute: async (_id: string, params: unknown) => {
              result.toolCalls++;
              return proposeIdea(
                deps.idea as NonNullable<ResearchDeps["idea"]>,
                params as Record<string, unknown>,
              );
            },
          } as AgentTool,
        ]
      : []),
    ...(deps.note
      ? [
          {
            name: NOTE_TOOL.name,
            label: NOTE_TOOL.name,
            description: NOTE_TOOL.description,
            parameters: NOTE_TOOL.parameters,
            execute: async (_id: string, params: unknown) => {
              result.toolCalls++;
              return notes.write(
                deps.note as NonNullable<ResearchDeps["note"]>,
                params as Record<string, unknown>,
              );
            },
          } as AgentTool,
        ]
      : []),
    ...(deps.mcp
      ? mcpAgentTools(
          deps.mcp.tools,
          (s, t, a) => (deps.mcp as McpForAgent).call(s, t, a),
          () => {
            result.toolCalls++;
          },
        )
      : []),
  ];

  const { models, model, thinkingLevel } = buildModel(deps.model);
  // Each model call's usage, the compaction summaries' included (goal 075).
  const meter = deps.modelUsage ? new PiMeter(deps.modelUsage) : undefined;
  // The provider's error answers, for a rate limit's time (goal 079).
  const watch = new ProviderWatch();
  const agent = new Agent({
    initialState: {
      systemPrompt: `${
        spec.folder
          ? `${RESEARCH_WORKER_SYSTEM}\n\n${researchFolderNote(spec.folder)} Use the file tools (list_files, read_file, search_files, write_file, remove_file) for it.`
          : RESEARCH_WORKER_SYSTEM
      }${deps.idea ? "\n\nTo propose another research task for the run's queue, use the idea tool: the planner or the campaign's owner decides whether it is queued, and your trial goes on." : ""}${deps.mcp?.tools.length ? `\n\n${mcpLine([...new Set(deps.mcp.tools.map((t) => t.server))])}` : ""}`,
      model,
      tools: clock.wrap(guardRepeats(tools, () => compactor.count)),
      thinkingLevel,
    },
    streamFn: watchedStream(models, watch, meter),
    convertToLlm: withoutPastThinking,
    // One tool call at a time: each is a request to the harness, in the order the model chose.
    toolExecution: "sequential",
  });
  meter?.watch(agent);
  // Near the model's window the conversation is compacted and the trial goes on (goal 070).
  const compactor = new Compactor({
    window: deps.model.contextWindow,
    at: deps.model.compactAt,
    convert: withoutPastThinking,
    summarize: summarizer(deps.model, meter),
    keep: async (n, markdown) => {
      if (!deps.compaction) throw new Error("this trial has no place to keep it");
      const { rel } = await deps.compaction.keep(n, markdown);
      return {
        path: rel,
        read: `It is in your research folder: read it with read_file (path ${rel}), or search it with search_files, when you need a detail`,
      };
    },
    done: async (r) => deps.compaction?.done(r),
    stop: (reason) => {
      result.stopped = "context";
      result.error = reason;
      agent.abort();
    },
    title: `Research trial ${spec.trialId} (${spec.lane})`,
  });
  agent.prepareRequest = compactor.hook(agent);
  agent.subscribe((event) => {
    if (event.type === "turn_end") {
      result.turns++;
      notes.reset();
      const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
      result.tokensIn += usage?.input ?? 0;
      result.tokensOut += usage?.output ?? 0;
      if (spec.maxTurns !== undefined && result.turns >= spec.maxTurns) {
        result.stopped = "turns";
        agent.abort();
      }
    }
  });
  // After the turn cap above: the owner's messages are not fetched on the turn it stops.
  if (deps.link) linkSession(agent, deps.link);
  // A trial's length only when the campaign or the rig sets one (goal 079).
  const wall =
    spec.wallMs !== undefined
      ? setTimeout(() => {
          result.stopped = "wall";
          agent.abort();
        }, spec.wallMs)
      : undefined;
  // The trial's failed model calls in a row, and since when (goal 079).
  const failures: FailureCount = { failures: 0, rateWaits: 0 };
  try {
    // With the note tool, the brief says how to keep field notes, and how they differ from
    // research notes.
    await agent.prompt(deps.note ? `${spec.brief}\n\n${RESEARCH_WORKER_NOTES}` : spec.brief);
    // A cut-off reply, a failed call or a full context (compacted) does not end a research trial
    // before its time; only a conversation that does not fit even compacted does, and failures
    // that stop the run's agents.
    const end = await keepGoing(
      agent,
      () => result.stopped !== "no_submission",
      deps.model.contextWindow,
      compactor,
      {
        failuresInARow: spec.limits?.failuresInARow,
        cutoffsInARow: spec.limits?.cutoffsInARow,
        watch,
        onWait: deps.waiting,
        count: failures,
      },
    );
    if (end) {
      result.stopped = end.stopped;
      result.error = end.error;
      if (end.kind) result.errorKind = end.kind;
    }
    if (result.stopped === "no_submission") result.stopped = "finished";
  } catch (err) {
    if (result.stopped === "no_submission") {
      result.stopped = "error";
      result.error = errorText(err);
    }
  } finally {
    if (wall) clearTimeout(wall);
  }
  if (compactor.count) result.compactions = compactor.count;
  const failing = failingOf(failures);
  if (failing) result.failing = failing;
  return result;
}

/** The file tools over the research folder: each failure is an answer in words, not a crash. */
function folderTools(folder: ResearchFolderPaths, result: TrialResult): AgentTool[] {
  const fileTool = <P extends TSchema>(
    name: string,
    description: string,
    parameters: P,
    run: (p: Record<string, unknown>) => unknown,
  ): AgentTool<P> => ({
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, params) => {
      result.toolCalls++;
      try {
        return out(run(params as Record<string, unknown>));
      } catch (err) {
        return out(`error: ${errorText(err)}`);
      }
    },
  });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return [
    fileTool(
      "list_files",
      "List a directory of the research folder (relative paths; '.' is its top), a page at a time: next_skip, when there is one, gives the next page.",
      Type.Object({
        path: Type.Optional(Type.String()),
        skip: Type.Optional(Type.Number({ description: "Entries to skip: an answer's next_skip" })),
      }),
      (p) => listFiles(folder, str(p.path) ?? ".", num(p.skip) ?? 0),
    ),
    fileTool(
      "read_file",
      `Read a file of the research folder, from an offset in characters: at most ${READ_MAX} characters a read; next_offset says where the next part starts.`,
      Type.Object({
        path: Type.String(),
        offset: Type.Optional(
          Type.Number({ description: "Where to start, in characters: an answer's next_offset" }),
        ),
        length: Type.Optional(
          Type.Number({ description: `How many characters, at most ${READ_MAX}` }),
        ),
      }),
      (p) => readFile(folder, String(p.path), num(p.offset) ?? 0, num(p.length) ?? READ_MAX),
    ),
    fileTool(
      "search_files",
      "Search every file under a path of the research folder for lines with this text (case-insensitive), or matching it as a regular expression with regex true. A page of lines at a time: next_skip, when there is one, gives the next page.",
      Type.Object({
        text: Type.String(),
        path: Type.Optional(Type.String()),
        regex: Type.Optional(Type.Boolean()),
        skip: Type.Optional(Type.Number({ description: "Lines to skip: an answer's next_skip" })),
      }),
      (p) =>
        searchFiles(folder, String(p.text), {
          path: str(p.path),
          regex: p.regex === true,
          skip: num(p.skip),
        }),
    ),
    fileTool(
      "write_file",
      "Write a file in your working area (its path from the folder's top); append true adds to its end.",
      Type.Object({
        path: Type.String(),
        content: Type.String(),
        append: Type.Optional(Type.Boolean()),
      }),
      (p) => writeFile(folder, String(p.path), String(p.content), p.append === true),
    ),
    fileTool(
      "remove_file",
      "Remove a file or directory in your working area.",
      Type.Object({ path: Type.String() }),
      (p) => removeFile(folder, String(p.path)),
    ),
  ] as AgentTool[];
}
