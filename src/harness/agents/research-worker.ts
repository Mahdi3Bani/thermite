import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { LaneLimitValues } from "../../core/contract.ts";
import { linkSession, type SessionLink } from "./live-session.ts";
import { buildModel, type ModelConfig } from "./model.ts";
import { RESEARCH_SYSTEM, researchOutput, researchTool } from "./research-tools.ts";
import type { TrialResult } from "./worker.ts";
import { keepGoing, withoutPastThinking } from "./worker.ts";

/**
 * A research trial in Pi: a fresh agent session with research tools only, no shell and no files.
 * (In OpenCode, opencode.ts, the agent keeps its shell and files and runs the same tools as
 * commands.) Every research action goes through the harness's research service: the harness
 * fetches and archives, and code decides whether a claim is verified. The agent cannot end the
 * campaign; a trial just ends.
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
}

export interface ResearchDeps {
  model: ModelConfig;
  call(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** The live view: the session's turns out, the owner's messages in. */
  link?: SessionLink | undefined;
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
  const base = { run: spec.run, lane: spec.lane };
  // The name, description and operation come from the list OpenCode's commands share.
  const tool = <P extends TSchema>(name: string, parameters: P): AgentTool<P> => {
    const t = researchTool(name);
    if (!t) throw new Error(`no research tool ${name}`);
    return {
      name,
      label: name,
      description: t.description,
      parameters,
      execute: async (_id, params) => {
        result.toolCalls++;
        // The trial's own run and lane always win over anything in the model's arguments
        // (the harness binds them again from the trial token).
        return out(await deps.call(t.op, { ...(params as Record<string, unknown>), ...base }));
      },
    };
  };
  const tools: AgentTool[] = [
    tool("fetch", Type.Object({ url: Type.String() })),
    tool(
      "read_source",
      Type.Object({
        source: Type.String(),
        offset: Type.Optional(Type.Number()),
        length: Type.Optional(Type.Number()),
      }),
    ),
    tool("search", Type.Object({ query: Type.String() })),
    tool("search_corpus", Type.Object({ text: Type.String() })),
    tool(
      "add_claim",
      Type.Object({
        text: Type.String(),
        quotes: Type.Array(Type.Object({ source: Type.String(), quote: Type.String() })),
        question: Type.Optional(
          Type.Number({ description: "Index of the campaign question it answers (0-based)." }),
        ),
        confidence: Type.Optional(Type.Number()),
      }),
    ),
    tool(
      "add_note",
      Type.Object({ text: Type.String(), sources: Type.Optional(Type.Array(Type.String())) }),
    ),
    tool(
      "propose_hypothesis",
      Type.Object({ text: Type.String(), supporting: Type.Optional(Type.Array(Type.String())) }),
    ),
    tool("update_section", Type.Object({ name: Type.String(), body: Type.String() })),
    tool("progress", Type.Object({})),
  ];

  const { models, model, thinkingLevel } = buildModel(deps.model);
  const agent = new Agent({
    initialState: { systemPrompt: RESEARCH_SYSTEM, model, tools, thinkingLevel },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: withoutPastThinking,
    // One tool call at a time: each is a request to the harness, in the order the model chose.
    toolExecution: "sequential",
  });
  if (deps.link) linkSession(agent, deps.link);
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
  const wall = setTimeout(() => {
    result.stopped = "wall";
    agent.abort();
  }, spec.wallMs);
  try {
    await agent.prompt(spec.brief);
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
