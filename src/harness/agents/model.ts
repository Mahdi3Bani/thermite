import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * The harness's model route: an OpenAI-compatible endpoint (for example a LiteLLM
 * gateway). Workers and the planner use only this; the model name comes from configuration
 * (QWEN_MODEL), never from code.
 */

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
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
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    // LiteLLM and vLLM-style servers: no `store`, no `developer` role, no reasoning_effort.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
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
  return { models, model: resolved };
}
