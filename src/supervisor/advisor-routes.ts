import { buildHeaders } from "../core/version.ts";
import { type AdvisorRuntime, AdvisorsConfig } from "./advisors.ts";

/**
 * The advisors' models that control gives a rig (the owner's choice for each role on the rig's
 * Edit page, or over MCP and REST), as runtimes the supervisor runs. A role control gives a model
 * replaces the supervisor's own configuration for that role; a role it gives none keeps it. Each
 * runs in the harness its route names (goal 073): Pi here with read-only tools, Claude Code (a
 * Claude subscription, and only it), OpenCode v2 (OpenCode's own models too) or the Codex CLI.
 * A ChatGPT sign-in's access token lasts an hour; control's routes are read each round.
 */

/** A route as control hands it (see the harness's ControlRoute); its key stays in memory. */
export interface AdvisorRoute {
  name: string;
  type: string;
  base_url: string;
  model: string;
  context_window: number;
  reasoning: string | null;
  effort?: string | null | undefined;
  /** The harness the role runs in (older controls: none, Pi or what the model needs). */
  harness?: string | undefined;
  api_key: string;
}

export interface ControlAdvisors {
  teachers?: AdvisorRuntime[] | undefined;
  combiner?: AdvisorRuntime | undefined;
  auditor?: AdvisorRuntime | undefined;
  panel?: AdvisorRuntime[] | undefined;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** One role's runtime from its route, or undefined when advisors can't run it. */
export function runtimeOf(route: AdvisorRoute, name: string): AdvisorRuntime | undefined {
  if (route.type === "claude")
    return {
      name,
      runtime: "claude-code",
      model: route.model,
      token: route.api_key,
      effort: EFFORTS.find((e) => e === route.effort),
      timeout_s: 1800,
    };
  const reasoning = route.reasoning;
  const effort =
    reasoning === "low" || reasoning === "medium" || reasoning === "high" ? reasoning : undefined;
  // OpenCode v2: the provider's API through a proxy for the call; OpenCode's own models with no key.
  if (route.harness === "opencode") {
    if (route.type === "opencode")
      return {
        name,
        runtime: "opencode",
        api: "opencode",
        model: route.model,
        context_window: route.context_window,
        timeout_s: 1800,
      };
    if (route.type !== "openai" && route.type !== "anthropic" && route.type !== "chatgpt")
      return undefined;
    return {
      name,
      runtime: "opencode",
      api: route.type,
      base_url: route.base_url,
      model: route.model,
      api_key: route.api_key,
      context_window: route.context_window,
      timeout_s: 1800,
    };
  }
  // The Codex CLI: OpenAI's Responses API only.
  if (route.harness === "codex") {
    if (route.type !== "openai" && route.type !== "chatgpt") return undefined;
    return {
      name,
      runtime: "codex",
      api: route.type,
      base_url: route.base_url,
      model: route.model,
      api_key: route.api_key,
      reasoning: effort,
      context_window: route.context_window,
      timeout_s: 1800,
    };
  }
  if (route.type !== "openai" && route.type !== "anthropic" && route.type !== "chatgpt")
    return undefined;
  return {
    name,
    runtime: "openai",
    api: route.type,
    base_url: route.base_url,
    model: route.model,
    api_key: route.api_key,
    reasoning: effort,
    context_window: route.context_window || 200_000,
    max_tokens: 8192,
    max_turns: 24,
    timeout_s: 900,
    usd_per_mtok_in: 0,
    usd_per_mtok_out: 0,
  };
}

/** The advisors' routes from control, as runtimes by role (the teacher pair twice, the panel three times). */
export async function fetchControlAdvisors(o: {
  rig: string;
  controlUrl: string;
  controlToken: string;
  fetchImpl?: typeof fetch | undefined;
}): Promise<ControlAdvisors> {
  const res = await (o.fetchImpl ?? fetch)(
    `${o.controlUrl}/v1/rigs/${encodeURIComponent(o.rig)}/advisor-routes`,
    { headers: { authorization: `Bearer ${o.controlToken}`, ...buildHeaders() } },
  );
  // An older control has no such endpoint: its rigs keep their own configuration.
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`control's advisor routes: HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const r = body as Record<string, AdvisorRoute | null>;
  const many = (route: AdvisorRoute | null | undefined, base: string, n: number) => {
    if (!route) return undefined;
    const list = Array.from({ length: n }, (_, i) => runtimeOf(route, `${base}-${i + 1}`)).filter(
      (x): x is AdvisorRuntime => x !== undefined,
    );
    return list.length ? list : undefined;
  };
  return {
    teachers: many(r.teachers, "teacher", 2),
    combiner: r.combiner ? runtimeOf(r.combiner, "combiner") : undefined,
    auditor: r.auditor ? runtimeOf(r.auditor, "auditor") : undefined,
    panel: many(r.panel, "reviewer", 3),
  };
}

/** The supervisor's configuration with control's roles over it; undefined when no role has an advisor. */
export function mergeAdvisors(
  file: AdvisorsConfig | undefined,
  control: ControlAdvisors,
): AdvisorsConfig | undefined {
  const base = file ?? AdvisorsConfig.parse({});
  const merged: AdvisorsConfig = {
    ...base,
    teachers: control.teachers ?? base.teachers,
    combiner: control.combiner ?? base.combiner,
    auditor: control.auditor ?? base.auditor,
    panel: control.panel ?? base.panel,
  };
  return merged.teachers.length || merged.combiner || merged.auditor || merged.panel.length
    ? merged
    : undefined;
}
