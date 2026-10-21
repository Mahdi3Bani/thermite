import { z } from "zod";
import {
  COMPACT_AT_DEFAULT,
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  compactAtRefusal,
} from "../core/compaction.ts";
import { isOpencodeOwn } from "./providers.ts";
import {
  type AgentRole,
  type ControlStore,
  codexTakes,
  type Effort,
  HARNESS_IDS,
  type Harness,
  type ModelProvider,
} from "./store.ts";

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
  /**
   * The agent's harness (goal 073); left out, what its model needs (the workers': harnessFor on
   * the dashboard, which keeps a rig's Codex or OpenCode where it can).
   */
  harness?: Harness | undefined;
  effort?: Effort | undefined;
  /** A cap on the agent's context window in tokens (goal 070): every agent has its own. */
  contextWindow?: number | undefined;
  /** The agent's compaction point, in percent of the window (goal 070). */
  compactAt?: number | undefined;
}

/**
 * One agent's model on control, the harness it runs in (goal 073), and its own cap and
 * compaction point (goal 070).
 */
export interface AgentModel {
  provider: string;
  model: string;
  effort: Effort | null;
  /** The harness it runs in: the owner's choice, else what its model needs (goal 073). */
  harness: Harness;
  /** A cap on the model's context window in tokens; null: the provider's window. */
  context_cap: number | null;
  /** The compaction point in percent of the window; null: the harness's default. */
  compact_at: number | null;
}
/** The workers' model: as every agent's. */
export type WorkersModel = AgentModel;
/** Each agent's model on control; null: its default (Edit rig's first choice in its row). */
export type AgentModels = { workers: WorkersModel | null } & Record<AgentRole, AgentModel | null>;

/** What a call did: Edit rig's words, the window the agent's route carries, and every agent's model. */
export interface RigModelOutcome {
  ok: string;
  /** The window the agent's model route carries, in tokens; null: unknown, or the model cleared. */
  contextWindow: number | null;
  /** The agent's compaction point (percent); null: the default, or the model cleared. */
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
  harness: z
    .enum(HARNESS_IDS as [Harness, ...Harness[]])
    .optional()
    .describe(
      "Where the agent runs: pi, opencode (OpenCode v2), claude-code or codex; left out, what its model needs",
    ),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("How long the model thinks, as Effort on Edit rig"),
  context_window: z
    .number()
    .int()
    .optional()
    .describe("Any agent: a cap on its model's context window in tokens"),
  // Any number: one that is not a whole percent in range is refused in words.
  compact_at: z
    .number()
    .optional()
    .describe(
      `Any agent: the share of the context window, in percent (${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}), at which its conversation is compacted; left out, ${COMPACT_AT_DEFAULT}`,
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
  // Every agent takes its own harness (goal 073), cap and point (goal 070); a planner with no
  // model of its own has none to set, and uses the workers'.
  if (r.compactAt !== undefined) return compactAtRefusal(r.compactAt);
  return undefined;
}

/** Whether a provider's model runs only in OpenCode: OpenCode's own (free) models. */
export const opencodeOnly = (p: ModelProvider, model: string): boolean =>
  isOpencodeOwn(p) && (p.type === "opencode" || !p.key_sealed || model.endsWith("-free"));

/**
 * The harness a model needs when the owner chooses none: Claude Code for a Claude subscription,
 * OpenCode for OpenCode's own models, else Pi (a ChatGPT sign-in too).
 */
export const neededHarness = (p: ModelProvider, model: string): Harness =>
  p.type === "claude" ? "claude-code" : opencodeOnly(p, model) ? "opencode" : "pi";

/** A harness's name as the dashboard shows it. */
export const HARNESS_NAMES: Record<Harness, string> = {
  pi: "Pi",
  opencode: "OpenCode v2",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Why a harness cannot run a provider's model, in words, for `who` ("the planner"); undefined
 * when it can (goal 073). A Claude subscription runs only in Claude Code, and Claude Code only on
 * one; Codex only on OpenAI's Responses API; OpenCode's own models only in OpenCode.
 */
export function harnessRefusal(
  p: ModelProvider,
  model: string,
  harness: Harness,
  who: string,
): string | undefined {
  if (p.type === "claude" && harness !== "claude-code")
    return `A Claude subscription runs only in Claude Code: choose Claude Code for ${who}, or another model.`;
  if (harness === "claude-code" && p.type !== "claude")
    return `Claude Code runs only with a Claude subscription here: choose ${codexTakes(p.type) ? "Pi, OpenCode v2 or Codex" : "Pi or OpenCode v2"} for this provider.`;
  if (harness === "codex" && !codexTakes(p.type))
    return "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.";
  if (harness !== "opencode" && opencodeOnly(p, model))
    return `OpenCode's free models run only in OpenCode: choose OpenCode v2 for ${who}, or another model.`;
  return undefined;
}

/** Each agent's model, as control keeps them for the rig. */
export function agentModelsOf(store: ControlStore, rig: string): AgentModels {
  const w = store.rigModels()[rig];
  const roles = store.roleModels(rig);
  const of = (role: AgentRole): AgentModel | null => {
    const r = roles[role];
    if (!r) return null;
    const p = store.provider(r.provider);
    return {
      provider: r.provider,
      model: r.model,
      effort: r.effort,
      harness: r.harness ?? (p ? neededHarness(p, r.model) : "pi"),
      context_cap: r.contextCap ?? null,
      compact_at: r.compactAt ?? null,
    };
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
  // The agent's compaction point (goal 070): null, the default.
  compact_at: out.compactAt ?? null,
  said: out.ok,
  agents: out.agents,
});
