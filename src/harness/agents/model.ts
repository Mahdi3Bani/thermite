import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * The harness's model route: an OpenAI-compatible endpoint (for example a LiteLLM
 * gateway). Workers and the planner use only this; the model name comes from configuration
 * (QWEN_MODEL), never from code.
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
  throw new Error(`QWEN_REASONING_EFFORT must be none, low, medium or high, not ${raw}`);
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig | undefined {
  const baseUrl = env.QWEN_BASE_URL;
  const model = env.QWEN_MODEL;
  const apiKey = env.QWEN_API_KEY;
  if (!baseUrl || !model || !apiKey) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    apiKey,
    contextWindow: Number(env.QWEN_CONTEXT_WINDOW ?? "131072"),
    maxTokens: Number(env.QWEN_MAX_TOKENS ?? "8192"),
    reasoning: reasoningFromEnv(env.QWEN_REASONING_EFFORT),
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
