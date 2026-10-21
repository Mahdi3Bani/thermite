import { z } from "zod";
import {
  COMPACT_AT_DEFAULT,
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  compactAtRefusal,
} from "../core/compaction.ts";
import type { AgentRole, ControlStore, Effort, Harness } from "./store.ts";

/**
 * Each agent's model on a rig, from outside the dashboard (goals 029 and 070): REST's
 * `POST /v1/rigs/<rig>/model` and MCP's `set_rig_model` set one agent's model, or clear it, as a
 * row of Edit rig's section "2 · The agents" does; `GET /v1/rigs/<rig>/model` and MCP's
 * `rig_models` read them all. Both call the dashboard's own code (ControlActions.setRigModel and
 * rigModels, filled in by dashboard.ts), so Edit rig and its twins check and refuse alike. This
 * module holds what the twins share: the request's fields, its checks of shape, and the answer.
 */

/** The agents, as Edit rig's rows and control's records name them. */
export const MODEL_AGENTS = [
  "workers",
  "planner",
  "teachers",
  "combiner",
  "auditor",
  "panel",
] as const satisfies readonly ("workers" | AgentRole)[];
export type ModelAgent = (typeof MODEL_AGENTS)[number];

/** One agent's model request, in the dashboard's terms. */
export interface RigModelRequest {
  /** Default: the workers. */
  agent?: ModelAgent | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** True: the agent's default again, as Edit rig's first choice in its row. */
  clear?: boolean | undefined;
  /** The workers' harness (the other agents run where their model needs). */
  harness?: "pi" | "opencode" | "codex" | undefined;
  effort?: Effort | undefined;
  /** A cap on the workers' context window in tokens (goal 070). */
  contextWindow?: number | undefined;
  /** The workers' compaction point, in percent of the window (goal 070). */
  compactAt?: number | undefined;
}

/** One agent's model on control; the workers' has its harness and cap too. */
export interface AgentModel {
  provider: string;
  model: string;
  effort: Effort | null;
}
export interface WorkersModel extends AgentModel {
  harness: Harness;
  context_cap: number | null;
  /** The compaction point in percent of the window; null: the harness's default. */
  compact_at: number | null;
}
/** Each agent's model on control; null: its default (Edit rig's first choice in its row). */
export type AgentModels = { workers: WorkersModel | null } & Record<AgentRole, AgentModel | null>;

/** What a call did: Edit rig's words, the window the agent's route carries, and every agent's model. */
export interface RigModelOutcome {
  ok: string;
  /** The window the agent's model route carries, in tokens; null: unknown, or the model cleared. */
  contextWindow: number | null;
  /** The workers' compaction point (percent); null: the default, or the model cleared. */
  compactAt?: number | null | undefined;
  agents: AgentModels;
}

/** The request's fields over REST and MCP, in snake case (MCP adds the rig). */
export const rigModelFields = {
  agent: z
    .enum(MODEL_AGENTS)
    .optional()
    .describe(
      "Whose model: workers (default), planner, teachers (the teacher pair), combiner, auditor or panel (the review panel)",
    ),
  provider: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The model provider's name in Providers"),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("A model id, as the providers tool lists it"),
  clear: z
    .boolean()
    .optional()
    .describe(
      "true: the agent goes back to its default, with no provider or model: the workers to the rig's own settings, the planner to the workers' model, an advisor to the rig's advisors file",
    ),
  harness: z.enum(["pi", "opencode", "codex"]).optional().describe("The workers' harness only"),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("How long the model thinks, as Effort on Edit rig"),
  context_window: z
    .number()
    .int()
    .optional()
    .describe("The workers only: a cap on the model's context window in tokens"),
  // Any number: one that is not a whole percent in range is refused in words.
  compact_at: z
    .number()
    .optional()
    .describe(
      `The workers only: the share of the context window, in percent (${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}), at which a conversation is compacted; left out, ${COMPACT_AT_DEFAULT}`,
    ),
};

export const RigModelBody = z.strictObject(rigModelFields);
export type RigModelBody = z.infer<typeof RigModelBody>;

export const rigModelRequest = (b: RigModelBody): RigModelRequest => ({
  agent: b.agent,
  provider: b.provider,
  model: b.model,
  clear: b.clear,
  harness: b.harness,
  effort: b.effort,
  contextWindow: b.context_window,
  compactAt: b.compact_at,
});

/** Why a request has the wrong fields for its agent, in words; undefined when its shape is right. */
export function rigModelShapeRefusal(r: RigModelRequest): string | undefined {
  const agent = r.agent ?? "workers";
  if (r.clear) {
    if (
      r.provider !== undefined ||
      r.model !== undefined ||
      r.harness !== undefined ||
      r.effort !== undefined ||
      r.contextWindow !== undefined ||
      r.compactAt !== undefined
    )
      return "Give clear alone, or a provider and a model.";
    return undefined;
  }
  if (!r.provider || !r.model) return "Give a provider and a model, or clear: true.";
  if (agent !== "workers" && r.harness !== undefined)
    return "Only the workers take a harness. The other agents run where their model needs, as Runs in on Edit rig says.";
  if (agent !== "workers" && r.contextWindow !== undefined)
    return "Only the workers take a context window cap. A planner with no model of its own uses the workers' cap.";
  if (agent !== "workers" && r.compactAt !== undefined)
    return "Only the workers take a compaction point. A planner with no model of its own uses the workers' point.";
  if (r.compactAt !== undefined) return compactAtRefusal(r.compactAt);
  return undefined;
}

/** Each agent's model, as control keeps them for the rig. */
export function agentModelsOf(store: ControlStore, rig: string): AgentModels {
  const w = store.rigModels()[rig];
  const roles = store.roleModels(rig);
  const of = (role: AgentRole): AgentModel | null => {
    const r = roles[role];
    return r ? { provider: r.provider, model: r.model, effort: r.effort } : null;
  };
  return {
    workers: w
      ? {
          provider: w.provider,
          model: w.model,
          effort: w.effort ?? null,
          harness: w.harness,
          context_cap: w.contextCap ?? null,
          compact_at: w.compactAt ?? null,
        }
      : null,
    planner: of("planner"),
    teachers: of("teachers"),
    combiner: of("combiner"),
    auditor: of("auditor"),
    panel: of("panel"),
  };
}

/** The answer over REST and MCP. */
export const rigModelAnswer = (rig: string, r: RigModelRequest, out: RigModelOutcome) => ({
  rig,
  agent: r.agent ?? "workers",
  model: r.clear ? null : (r.model ?? null),
  context_window: out.contextWindow,
  // The workers' compaction point (goal 070): null, the default.
  ...((r.agent ?? "workers") === "workers" ? { compact_at: out.compactAt ?? null } : {}),
  said: out.ok,
  agents: out.agents,
});
