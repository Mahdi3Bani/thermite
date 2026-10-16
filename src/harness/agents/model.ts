import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * The harness's model route: an OpenAI-compatible endpoint (for example a LiteLLM or vLLM
 * gateway). Workers and the planner use only this; the model name comes from configuration
 * (THERMITE_MODEL), never from code.
 */

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  /**
   * Sent as `reasoning_effort` ("off" sends "none"). Unset: nothing is sent and the server's
   * default applies. Thinking tokens count toward `maxTokens` on servers that think by default.
   */
  reasoning?: ReasoningEffort | undefined;
}

function reasoningFromEnv(raw: string | undefined): ReasoningEffort | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "none" || raw === "off") return "off";
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new Error(`THERMITE_MODEL_REASONING_EFFORT must be none, low, medium or high, not ${raw}`);
}

/**
 * The model route's settings, by their names: THERMITE_MODEL_* (BASE_URL, the model's name as
 * THERMITE_MODEL, API_KEY, CONTEXT_WINDOW, MAX_TOKENS, REASONING_EFFORT). The QWEN_* names
 * they had before are still read, as aliases, when the new one is not set.
 */
export const MODEL_SETTINGS = {
  baseUrl: ["THERMITE_MODEL_BASE_URL", "QWEN_BASE_URL"],
  model: ["THERMITE_MODEL", "QWEN_MODEL"],
  apiKey: ["THERMITE_MODEL_API_KEY", "QWEN_API_KEY"],
  contextWindow: ["THERMITE_MODEL_CONTEXT_WINDOW", "QWEN_CONTEXT_WINDOW"],
  maxTokens: ["THERMITE_MODEL_MAX_TOKENS", "QWEN_MAX_TOKENS"],
  reasoning: ["THERMITE_MODEL_REASONING_EFFORT", "QWEN_REASONING_EFFORT"],
} as const;

/** Every variable name the model route may be read from (new names and their aliases). */
export const MODEL_ENV_NAMES: string[] = Object.values(MODEL_SETTINGS).flat();

let warnedAlias = false;
function setting(env: NodeJS.ProcessEnv, names: readonly [string, string]): string | undefined {
  const [current, alias] = names;
  if (env[current] !== undefined && env[current] !== "") return env[current];
  const old = env[alias];
  if (old !== undefined && old !== "" && !warnedAlias) {
    warnedAlias = true;
    console.warn(
      `${alias} and the other QWEN_* model settings are old names: use THERMITE_MODEL_* (${current})`,
    );
  }
  return old;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig | undefined {
  const baseUrl = setting(env, MODEL_SETTINGS.baseUrl);
  const model = setting(env, MODEL_SETTINGS.model);
  const apiKey = setting(env, MODEL_SETTINGS.apiKey);
  if (!baseUrl || !model || !apiKey) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    apiKey,
    // The model's per-request context. Unset is "unknown" (0): replies are then not clamped to an
    // estimate of the room left, because a wrong guess (it was 131072) shrinks every reply to one
    // token once a conversation nears it.
    contextWindow: Number(setting(env, MODEL_SETTINGS.contextWindow) ?? "0"),
    maxTokens: Number(setting(env, MODEL_SETTINGS.maxTokens) ?? "8192"),
    reasoning: reasoningFromEnv(setting(env, MODEL_SETTINGS.reasoning)),
  };
}

export function buildModel(cfg: ModelConfig) {
  const provider = "thermite-qwen";
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
