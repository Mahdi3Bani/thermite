import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { type AgentsContext, compactAtRefusal, contextApplied } from "../../core/compaction.ts";

/**
 * The harness's model route: an OpenAI-compatible endpoint (for example a LiteLLM or vLLM
 * gateway). Workers and the planner use only this; the model name comes from configuration
 * (THERMITE_MODEL), never from code.
 */

export type ReasoningEffort = "off" | "low" | "medium" | "high";

/** Where a ChatGPT sign-in's access token is used: OpenAI's Responses API (and its model list). */
export const CHATGPT_API = "https://api.openai.com/v1";
/** OpenAI's code when a ChatGPT plan's usage is full. Its reset time is not given. */
export const CHATGPT_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/** How long agents wait before they try a full ChatGPT plan again (OpenAI gives no reset time). */
export const CHATGPT_LIMIT_WAIT_MS = 15 * 60_000;

/** When agents may try again after a provider's error, if it said a ChatGPT plan's usage is full. */
export function usageLimitRetry(error: string | undefined, now = Date.now()): string | undefined {
  return error?.includes(CHATGPT_LIMIT_CODE)
    ? new Date(now + CHATGPT_LIMIT_WAIT_MS).toISOString()
    : undefined;
}

export interface ModelConfig {
  /**
   * The provider's API: OpenAI-compatible chat completions (the default), Anthropic's Messages,
   * OpenCode's own models (only the OpenCode harness reaches those), a Claude subscription
   * (only Claude Code may use it; apiKey is then its token), or a ChatGPT sign-in (OpenAI's
   * Responses API; apiKey is then a one-hour access token that control renews).
   */
  api?: "openai" | "anthropic" | "opencode" | "claude" | "chatgpt" | undefined;
  /**
   * The harness the agents run in: Pi, in-process (the default), OpenCode v2, Claude Code or the
   * Codex CLI (OpenAI's Responses API only: a ChatGPT sign-in or an OpenAI-compatible route).
   */
  harness?: "pi" | "opencode" | "claude-code" | "codex" | undefined;
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  /**
   * The compaction point (goal 070): the share of `contextWindow`, in percent, at which an agent's
   * conversation is compacted and goes on. Unset: COMPACT_AT_DEFAULT. Never a cap.
   */
  compactAt?: number | undefined;
  /**
   * Sent as `reasoning_effort` ("off" sends "none"). Unset: nothing is sent and the server's
   * default applies. Thinking tokens count toward `maxTokens` on servers that think by default.
   */
  reasoning?: ReasoningEffort | undefined;
  /** Claude Code's effort level, for a Claude subscription (--effort). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  /** The key at the time of each call, when it is renewed while the route stays (a ChatGPT sign-in). */
  keyNow?: (() => string) | undefined;
}

/**
 * Whether the Codex CLI can reach a provider of this API. It speaks only OpenAI's Responses API:
 * a ChatGPT sign-in, or an OpenAI-compatible route whose server answers /responses (OpenAI's own
 * does). Never Anthropic's API, OpenCode's own models or a Claude subscription.
 */
export function codexReaches(api: string | undefined): boolean {
  return api === undefined || api === "openai" || api === "chatgpt";
}

export function reasoningFromEnv(raw: string | undefined): ReasoningEffort | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "none" || raw === "off") return "off";
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new Error(`THERMITE_MODEL_REASONING_EFFORT must be none, low, medium or high, not ${raw}`);
}

/**
 * An agent's model in a run of a campaign with its own context settings (the contract's
 * `agents_context`, goal 070): the lower of the route's window and the campaign's (the
 * campaign's as given when the route lists none), and the campaign's compaction point over the
 * route's. Without campaign settings, or without a model, the same as given.
 */
export function withAgentsContext(
  m: ModelConfig | undefined,
  campaign: AgentsContext | undefined,
): ModelConfig | undefined {
  if (!m || !campaign) return m;
  const a = contextApplied(m, campaign);
  return {
    ...m,
    contextWindow: a.contextWindow,
    ...(a.compactAt !== undefined ? { compactAt: a.compactAt } : {}),
  };
}

/** A compaction point from the environment: unset, or a whole percent in range. */
export function compactAtFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  const refused = compactAtRefusal(n);
  if (refused) throw new Error(`THERMITE_MODEL_COMPACT_AT: ${refused} Not ${raw}.`);
  return n;
}

/**
 * The model route's settings, by their names: THERMITE_MODEL_* (BASE_URL, the model's name as
 * THERMITE_MODEL, API_KEY, CONTEXT_WINDOW, COMPACT_AT, MAX_TOKENS, REASONING_EFFORT, API) and the
 * agents' harness, THERMITE_AGENT_HARNESS.
 */
export const MODEL_SETTINGS = {
  baseUrl: "THERMITE_MODEL_BASE_URL",
  model: "THERMITE_MODEL",
  apiKey: "THERMITE_MODEL_API_KEY",
  contextWindow: "THERMITE_MODEL_CONTEXT_WINDOW",
  compactAt: "THERMITE_MODEL_COMPACT_AT",
  maxTokens: "THERMITE_MODEL_MAX_TOKENS",
  reasoning: "THERMITE_MODEL_REASONING_EFFORT",
  api: "THERMITE_MODEL_API",
  harness: "THERMITE_AGENT_HARNESS",
} as const;

/** Every variable name the model route is read from. */
export const MODEL_ENV_NAMES: string[] = Object.values(MODEL_SETTINGS);

/** A setting's value; empty counts as not set. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig | undefined {
  const baseUrl = setting(env, MODEL_SETTINGS.baseUrl);
  const model = setting(env, MODEL_SETTINGS.model);
  const apiKey = setting(env, MODEL_SETTINGS.apiKey);
  if (!baseUrl || !model || !apiKey) return undefined;
  const api = setting(env, MODEL_SETTINGS.api);
  if (
    api !== undefined &&
    api !== "openai" &&
    api !== "anthropic" &&
    api !== "opencode" &&
    api !== "claude" &&
    api !== "chatgpt"
  )
    throw new Error(
      `THERMITE_MODEL_API must be openai, anthropic, opencode, claude or chatgpt, not ${api}`,
    );
  const harness = setting(env, MODEL_SETTINGS.harness);
  if (
    harness !== undefined &&
    harness !== "pi" &&
    harness !== "opencode" &&
    harness !== "claude-code" &&
    harness !== "codex"
  )
    throw new Error(
      `THERMITE_AGENT_HARNESS must be pi, opencode, claude-code or codex, not ${harness}`,
    );
  // A Claude subscription runs only in Claude Code, and Claude Code only on one.
  if ((api === "claude") !== (harness === "claude-code"))
    throw new Error(
      "a Claude subscription (THERMITE_MODEL_API=claude) runs only with THERMITE_AGENT_HARNESS=claude-code, and that harness only with it",
    );
  if (harness === "codex" && !codexReaches(api))
    throw new Error(
      "the Codex CLI speaks only OpenAI's Responses API: THERMITE_AGENT_HARNESS=codex needs THERMITE_MODEL_API chatgpt or openai",
    );
  return {
    api:
      api === "anthropic" || api === "opencode" || api === "claude" || api === "chatgpt"
        ? api
        : undefined,
    harness:
      harness === "opencode" || harness === "claude-code" || harness === "codex"
        ? harness
        : undefined,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    apiKey,
    // The model's per-request context. Unset is "unknown" (0): replies are then not clamped to an
    // estimate of the room left, because a wrong guess (it was 131072) shrinks every reply to one
    // token once a conversation nears it.
    contextWindow: Number(setting(env, MODEL_SETTINGS.contextWindow) ?? "0"),
    compactAt: compactAtFromEnv(setting(env, MODEL_SETTINGS.compactAt)),
    maxTokens: Number(setting(env, MODEL_SETTINGS.maxTokens) ?? "8192"),
    reasoning: reasoningFromEnv(setting(env, MODEL_SETTINGS.reasoning)),
  };
}

/** A route as a worker's environment (THERMITE_MODEL_*), for a worker started on it. */
export function modelEnv(cfg: ModelConfig): Record<string, string> {
  return {
    ...(cfg.api && cfg.api !== "openai" ? { THERMITE_MODEL_API: cfg.api } : {}),
    ...(cfg.harness === "opencode" || cfg.harness === "claude-code" || cfg.harness === "codex"
      ? { THERMITE_AGENT_HARNESS: cfg.harness }
      : {}),
    THERMITE_MODEL_BASE_URL: cfg.baseUrl,
    THERMITE_MODEL: cfg.model,
    THERMITE_MODEL_API_KEY: cfg.apiKey,
    THERMITE_MODEL_CONTEXT_WINDOW: String(cfg.contextWindow),
    ...(cfg.compactAt !== undefined ? { THERMITE_MODEL_COMPACT_AT: String(cfg.compactAt) } : {}),
    THERMITE_MODEL_MAX_TOKENS: String(cfg.maxTokens),
    ...(cfg.reasoning !== undefined
      ? { THERMITE_MODEL_REASONING_EFFORT: cfg.reasoning === "off" ? "none" : cfg.reasoning }
      : {}),
  };
}

export function buildModel(cfg: ModelConfig) {
  if (cfg.api === "anthropic") return buildAnthropic(cfg);
  if (cfg.api === "chatgpt") return buildChatGPT(cfg);
  const provider = "thermite-openai";
  const model: Model<"openai-completions"> = {
    id: cfg.model,
    name: cfg.model,
    api: "openai-completions",
    provider,
    baseUrl: cfg.baseUrl,
    reasoning: cfg.reasoning !== undefined,
    ...(cfg.reasoning !== undefined ? { thinkingLevelMap: { off: "none" } } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    // LiteLLM and vLLM-style servers: no `store`, no `developer` role; reasoning_effort only
    // when configured.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: cfg.reasoning !== undefined,
      maxTokensField: "max_tokens",
    },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider,
      name: "Harness model route",
      baseUrl: cfg.baseUrl,
      auth: {
        apiKey: {
          name: "Model route key",
          resolve: async () => ({ auth: { apiKey: cfg.apiKey } }),
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  const resolved = models.getModel(provider, cfg.model);
  if (!resolved) throw new Error(`model ${cfg.model} did not register`);
  // The agents' thinking level: "off" sends reasoning_effort "none" when reasoning is configured.
  return { models, model: resolved, thinkingLevel: cfg.reasoning ?? ("off" as const) };
}

/** An Anthropic route: the Messages API; its base URL has no /v1 (the client adds it). */
function buildAnthropic(cfg: ModelConfig) {
  const provider = "thermite-anthropic";
  const model: Model<"anthropic-messages"> = {
    id: cfg.model,
    name: cfg.model,
    api: "anthropic-messages",
    provider,
    baseUrl: cfg.baseUrl,
    reasoning: cfg.reasoning !== undefined && cfg.reasoning !== "off",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider,
      name: "Harness model route",
      baseUrl: cfg.baseUrl,
      auth: {
        apiKey: {
          name: "Model route key",
          resolve: async () => ({ auth: { apiKey: cfg.apiKey } }),
        },
      },
      models: [model],
      api: anthropicMessagesApi(),
    }),
  );
  const resolved = models.getModel(provider, cfg.model);
  if (!resolved) throw new Error(`model ${cfg.model} did not register`);
  return { models, model: resolved, thinkingLevel: cfg.reasoning ?? ("off" as const) };
}

/**
 * A ChatGPT sign-in: OpenAI's Responses API, as pi-ai's own "openai" provider sends it. Direct to
 * OpenAI, pi-ai leaves out the fields this route refuses (it knows the access token from an API
 * key); through the harness's proxy, the proxy does. Its models reason: the instructions go as a
 * developer message, which the route takes (it refuses system messages), and no reasoning effort
 * is sent unless one is set. The key is read at each call, because control renews it hourly.
 */
function buildChatGPT(cfg: ModelConfig) {
  const provider = "openai";
  const model: Model<"openai-responses"> = {
    id: cfg.model,
    name: cfg.model,
    api: "openai-responses",
    provider,
    baseUrl: cfg.baseUrl,
    reasoning: true,
    thinkingLevelMap: { off: cfg.reasoning === "off" ? "none" : null },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    compat: { supportsMaxOutputTokens: false, supportsLongCacheRetention: false },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider,
      name: "ChatGPT sign-in",
      baseUrl: cfg.baseUrl,
      auth: {
        apiKey: {
          name: "ChatGPT access token",
          resolve: async () => ({ auth: { apiKey: cfg.keyNow?.() ?? cfg.apiKey } }),
        },
      },
      models: [model],
      api: openAIResponsesApi(),
    }),
  );
  const resolved = models.getModel(provider, cfg.model);
  if (!resolved) throw new Error(`model ${cfg.model} did not register`);
  return { models, model: resolved, thinkingLevel: cfg.reasoning ?? ("off" as const) };
}
