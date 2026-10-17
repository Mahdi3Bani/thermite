import type { ProviderModel, ProviderType } from "./store.ts";

/**
 * A model provider's own model list, as other systems read it: an OpenAI-compatible provider's
 * GET {base}/models, or Anthropic's GET {base}/v1/models. Errors say what went wrong in a few
 * words and never carry the key.
 */

/** Anthropic's API, when its base URL is left empty. */
export const ANTHROPIC_BASE = "https://api.anthropic.com";
/** OpenCode's own models (its free ones need no key), when its base URL is left empty. */
export const OPENCODE_BASE = "https://opencode.ai/zen/v1";

/**
 * A provider's base URL as its API client takes it. A pasted endpoint URL is trimmed back to its
 * base: an OpenAI-compatible one loses /models or /chat/completions; Anthropic's has no /v1 (the
 * client adds it).
 */
export function providerBase(type: ProviderType, base: string): string {
  const b = base
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(models|chat\/completions|messages|completions)$/, "");
  if (type === "anthropic") return (b || ANTHROPIC_BASE).replace(/\/v1$/, "");
  if (type === "opencode") return b || OPENCODE_BASE;
  return b;
}

/** A number from the first of these fields that has one: providers name the context differently. */
function contextOf(m: Record<string, unknown>): number | undefined {
  for (const k of ["context_length", "context_window", "max_context_length", "max_input_tokens"]) {
    const v = m[k];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  }
  const top = m.top_provider as Record<string, unknown> | undefined;
  const v = top?.context_length;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

export async function listModels(
  type: ProviderType,
  base: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModel[] | { error: string }> {
  const root = providerBase(type, base);
  // OpenCode's own list needs no key (its free models need none).
  const headers: Record<string, string> =
    type === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : key
        ? { authorization: `Bearer ${key}` }
        : {};
  const out: ProviderModel[] = [];
  let after: string | undefined;
  // Anthropic pages its list; OpenAI-compatible providers answer in one.
  for (let page = 0; page < 20; page++) {
    const url =
      type === "anthropic"
        ? `${root}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`
        : `${root}/models`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      return {
        error:
          e.name === "TimeoutError"
            ? "could not list its models: no answer in 15 s"
            : `could not reach it to list its models${e.cause?.code ? ` (${e.cause.code})` : ""}`,
      };
    }
    if (!res.ok)
      return {
        error: `could not list its models: HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (is the key right?)" : res.status === 404 ? " (is the base URL right?)" : ""}`,
      };
    let body: { data?: unknown; has_more?: unknown; last_id?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { error: "could not list its models: the answer was not JSON" };
    }
    if (!Array.isArray(body.data))
      return { error: "could not list its models: the answer had no model list" };
    for (const m of body.data as Record<string, unknown>[]) {
      if (typeof m?.id !== "string" || !m.id || m.id.length > 200) continue;
      out.push({ id: m.id, context_window: contextOf(m) });
    }
    if (type !== "anthropic" || body.has_more !== true || typeof body.last_id !== "string") break;
    after = body.last_id;
  }
  const seen = new Set<string>();
  return out
    .filter((m) => !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
