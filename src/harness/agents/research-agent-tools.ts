import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { researchOutput, researchTool } from "./research-tools.ts";

/**
 * The research tools as Pi offers them: a research trial has all of them, a hill-climb or goal
 * trial the ones for sources, claims and notes (CODE_RESEARCH_TOOLS). The name, description and
 * operation come from the list OpenCode's commands share (research-tools.ts); the parameters are
 * Pi's.
 */

const PARAMS: Record<string, TSchema> = {
  fetch: Type.Object({ url: Type.String() }),
  read_source: Type.Object({
    source: Type.String(),
    offset: Type.Optional(Type.Number()),
    length: Type.Optional(Type.Number()),
  }),
  search: Type.Object({ query: Type.String() }),
  search_corpus: Type.Object({ text: Type.String() }),
  add_claim: Type.Object({
    text: Type.String(),
    quotes: Type.Array(Type.Object({ source: Type.String(), quote: Type.String() })),
    question: Type.Optional(
      Type.Number({ description: "Index of the campaign question it answers (0-based)." }),
    ),
    confidence: Type.Optional(Type.Number()),
  }),
  add_note: Type.Object({
    text: Type.String(),
    sources: Type.Optional(Type.Array(Type.String())),
  }),
  propose_hypothesis: Type.Object({
    text: Type.String(),
    supporting: Type.Optional(Type.Array(Type.String())),
  }),
  add_finding: Type.Object({
    text: Type.String({ description: "The finding, in one sentence." }),
    summary: Type.String({ description: "What the claims show, and how." }),
    why_it_matters: Type.String({ description: "Why it matters for the campaign." }),
    supporting: Type.Array(Type.String(), { description: "The verified claims behind it." }),
  }),
  update_section: Type.Object({ name: Type.String(), body: Type.String() }),
  progress: Type.Object({}),
};

/**
 * The named research tools. Each calls the research service's operation; the trial's own run and
 * lane always win over anything in the model's arguments (the harness binds them again from the
 * trial's token). `counted` runs once per call (the trial's tool count).
 */
export function researchAgentTools(
  names: readonly string[],
  call: (op: string, args: Record<string, unknown>) => Promise<unknown>,
  base: Record<string, unknown>,
  counted: () => void,
): AgentTool[] {
  return names.map((name) => {
    const t = researchTool(name);
    const parameters = PARAMS[name];
    if (!t || !parameters) throw new Error(`no research tool ${name}`);
    return {
      name,
      label: name,
      description: t.description,
      parameters,
      execute: async (_id: string, params: unknown) => {
        counted();
        const value = await call(t.op, { ...(params as Record<string, unknown>), ...base });
        return { content: [{ type: "text" as const, text: researchOutput(value) }], details: {} };
      },
    } as AgentTool;
  });
}
