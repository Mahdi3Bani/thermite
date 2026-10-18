import { type AdvisorRuntime, AdvisorsConfig } from "./advisors.ts";

/**
 * The advisors' models that control gives a rig (the owner's choice for each role on the rig's
 * Edit page), as runtimes the supervisor runs. A role control gives a model replaces the
 * supervisor's own configuration for that role; a role it gives none keeps it. A Claude
 * subscription's role runs in Claude Code; an API-key route or a ChatGPT sign-in runs here with
 * read-only tools (a sign-in's access token lasts an hour; control's routes are read each round).
 * OpenCode's own models need OpenCode, which advisors do not run, so such a route is skipped.
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
  if (route.type !== "openai" && route.type !== "anthropic" && route.type !== "chatgpt")
    return undefined;
  const reasoning = route.reasoning;
  return {
    name,
    runtime: "openai",
    api: route.type,
    base_url: route.base_url,
    model: route.model,
    api_key: route.api_key,
    reasoning:
      reasoning === "low" || reasoning === "medium" || reasoning === "high" ? reasoning : undefined,
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
    { headers: { authorization: `Bearer ${o.controlToken}` } },
  );
  // An older control has no such endpoint: its rigs keep their own configuration.
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`control's advisor routes: HTTP ${res.status}`);
  const r = (await res.json()) as Record<string, AdvisorRoute | null>;
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
