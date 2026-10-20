import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { LaneLimitValues } from "../../core/contract.ts";
import { notesInstruction } from "../../core/journal.ts";
import { linkSession, type SessionLink } from "./live-session.ts";
import { mcpAgentTools, mcpLine } from "./mcp-tools.ts";
import { buildModel, type ModelConfig } from "./model.ts";
import { NOTE_TOOL, type NoteRequest, writeNote } from "./notes-tool.ts";
import { researchAgentTools } from "./research-agent-tools.ts";
import { listFiles, readFile, removeFile, searchFiles, writeFile } from "./research-files.ts";
import {
  RESEARCH_SYSTEM,
  RESEARCH_TOOLS,
  type ResearchFolderPaths,
  researchFolderNote,
  researchOutput,
} from "./research-tools.ts";
import type { IdeaInput, McpForAgent, TrialResult } from "./worker.ts";
import { IDEA_TOOL, keepGoing, proposeIdea, withoutPastThinking } from "./worker.ts";

/**
 * A research trial in Pi: a fresh agent session with the research tools and file tools over its
 * research folder, and no shell. (In OpenCode, opencode.ts, the agent keeps its shell and files
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
  wallMs: number;
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
}

/** A research worker's field notes, told apart from its research notes. */
const RESEARCH_NOTES = `${notesInstruction("with the note tool")} Field notes are not research notes (add_note), which record what sources say for the report.`;

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
              return writeNote(
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
  const agent = new Agent({
    initialState: {
      systemPrompt: `${
        spec.folder
          ? `${RESEARCH_SYSTEM}\n\n${researchFolderNote(spec.folder)} Use the file tools (list_files, read_file, search_files, write_file, remove_file) for it.`
          : RESEARCH_SYSTEM
      }${deps.idea ? "\n\nTo propose another research task for the run's queue, use the idea tool: the planner or the campaign's owner decides whether it is queued, and your trial goes on." : ""}${deps.mcp?.tools.length ? `\n\n${mcpLine([...new Set(deps.mcp.tools.map((t) => t.server))])}` : ""}`,
      model,
      tools,
      thinkingLevel,
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: withoutPastThinking,
    // One tool call at a time: each is a request to the harness, in the order the model chose.
    toolExecution: "sequential",
  });
  agent.subscribe((event) => {
    if (event.type === "turn_end") {
      result.turns++;
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
  const wall = setTimeout(() => {
    result.stopped = "wall";
    agent.abort();
  }, spec.wallMs);
  try {
    // With the note tool, the brief says how to keep field notes, and how they differ from
    // research notes.
    await agent.prompt(deps.note ? `${spec.brief}\n\n${RESEARCH_NOTES}` : spec.brief);
    // A cut-off reply or a failed call does not end a research trial before its time.
    const end = await keepGoing(
      agent,
      () => result.stopped !== "no_submission",
      deps.model.contextWindow,
    );
    if (end) {
      result.stopped = end.stopped === "context" ? "finished" : "error";
      result.error = end.error;
    }
    if (result.stopped === "no_submission") result.stopped = "finished";
  } catch (err) {
    if (result.stopped === "no_submission") {
      result.stopped = "error";
      result.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(wall);
  }
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
        return out(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return [
    fileTool(
      "list_files",
      "List a directory of the research folder (relative paths; '.' is its top).",
      Type.Object({ path: Type.Optional(Type.String()) }),
      (p) => listFiles(folder, str(p.path) ?? "."),
    ),
    fileTool(
      "read_file",
      "Read a file of the research folder, from an offset in characters.",
      Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        length: Type.Optional(Type.Number()),
      }),
      (p) => readFile(folder, String(p.path), num(p.offset) ?? 0, num(p.length) ?? 20_000),
    ),
    fileTool(
      "search_files",
      "Search every file under a path of the research folder for lines with this text (case-insensitive), or matching it as a regular expression with regex true.",
      Type.Object({
        text: Type.String(),
        path: Type.Optional(Type.String()),
        regex: Type.Optional(Type.Boolean()),
      }),
      (p) => searchFiles(folder, String(p.text), { path: str(p.path), regex: p.regex === true }),
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
