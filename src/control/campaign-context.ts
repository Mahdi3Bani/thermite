import { z } from "zod";
import {
  AgentsContext,
  agentsContextRefusal,
  agentsContextWords,
  COMPACT_AT_DEFAULT,
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  contextApplied,
} from "../core/compaction.ts";
import { parseContract } from "../core/contract.ts";
import { RUN_FIELDS } from "./copy-campaign.ts";
import { cappedWindow } from "./providers.ts";
import { MODEL_AGENTS, type ModelAgent } from "./rig-model.ts";
import type { CampaignSources, ControlStore } from "./store.ts";
import { isRigCheck } from "./ui/campaigns.ts";

/**
 * A campaign's own context settings for all its runs (goal 070): a context window and a
 * compaction point that every agent of its runs works with. The rig sets the defaults (each
 * agent's model, with its own cap and point: set_rig_model); a campaign may set its own.
 *
 * Where it lives: the contract, as `agents_context`, optional and without a default, so a
 * contract without it keeps its hash. A contract is what control signs into each assignment, what
 * the rig's harness and supervisor already read for every run, what a copy takes, and what the
 * run's record keeps (its version and hash); a change is a new version, as for the contract's lane
 * limits, so a run's settings never change under it. Kept beside the contract on control instead,
 * the settings would need their own field in the signed assignment and their own record.
 *
 * Each agent's window is the lower of the campaign's and its own (the provider's, or the rig's cap
 * on it): the lower wins. A campaign window above what a provider lists for one of the rig's
 * agents' models is refused when a run starts, in words; a campaign point replaces the rig's.
 *
 * REST's POST /v1/campaigns/<name>/context, MCP's set_campaign_context and `thermite campaign
 * context` save a new version with the settings; copy_campaign and `thermite campaign copy` may set
 * them on a copy; `thermite assign` writes them into the contract it sends.
 */

/** The campaign's own context settings in a contract, when it sets any. */
export function contractContext(contract: unknown): AgentsContext | undefined {
  const raw = (contract as { agents_context?: unknown } | null | undefined)?.agents_context;
  const r = AgentsContext.safeParse(raw);
  return r.success && (r.data.context_window !== undefined || r.data.compact_at !== undefined)
    ? r.data
    : undefined;
}

/** A campaign's newest contract on control: its newest saved version, or else its newest assignment's. */
export function campaignContract(store: ControlStore, campaign: string): unknown {
  return (
    store.campaignVersions(campaign)[0]?.contract ??
    store.latestAssignments().get(campaign)?.payload.contract
  );
}

/** The request's fields over REST and MCP (MCP adds the campaign). */
export const campaignContextFields = {
  context_window: z
    .number()
    .int()
    .optional()
    .describe(
      `The context window, in tokens (${CONTEXT_WINDOW_MIN} to ${CONTEXT_WINDOW_MAX}), that every agent of the campaign's runs works with at most: each agent's window is the lower of this and its own model's. Left out: each agent's own`,
    ),
  // Any number: one that is not a whole percent in range is refused in words.
  compact_at: z
    .number()
    .optional()
    .describe(
      `The share of the window, in percent (${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}), at which every agent's conversation is compacted, in place of the rig's. Left out: each agent's own (default ${COMPACT_AT_DEFAULT})`,
    ),
};

/** The REST body: the settings, and nothing else; an empty body removes them. */
export const CampaignContextBody = z.strictObject(campaignContextFields);
export type CampaignContextBody = z.infer<typeof CampaignContextBody>;

export interface CampaignContextRequest {
  campaign: string;
  contextWindow?: number | undefined;
  compactAt?: number | undefined;
}

export type CampaignContextOutcome =
  | {
      /** saved: a new version; unchanged: the newest version has these settings already. */
      state: "saved" | "unchanged";
      campaign: string;
      version: number;
      sha: string;
      context: AgentsContext | undefined;
    }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** The settings a request asks for, as the contract keeps them (undefined: none). */
export function requestedContext(r: {
  contextWindow?: number | undefined;
  compactAt?: number | undefined;
}): AgentsContext | undefined {
  const c: AgentsContext = {
    ...(r.contextWindow !== undefined ? { context_window: r.contextWindow } : {}),
    ...(r.compactAt !== undefined ? { compact_at: r.compactAt } : {}),
  };
  return Object.keys(c).length ? c : undefined;
}

const same = (a: AgentsContext | undefined, b: AgentsContext | undefined) =>
  a?.context_window === b?.context_window && a?.compact_at === b?.compact_at;

/**
 * Sets a campaign's own context settings, or (none given) removes them: a new version of its
 * contract, saved as the New campaign page saves one, with the same sources. Each call sets them
 * anew: what it leaves out, the new version does not have. A campaign control knows only by an
 * assignment gets its first saved version, from that assignment. Refused in words.
 */
export function setCampaignContext(
  store: ControlStore,
  req: CampaignContextRequest,
  by: string,
): CampaignContextOutcome {
  const refuse = (error: string, status: 400 | 404 | 409 = 409): CampaignContextOutcome => ({
    state: "refused",
    error,
    status,
  });
  const { campaign } = req;
  if (isRigCheck(campaign))
    return refuse(
      `${campaign} is a rig check's campaign. Its agents keep the rig's settings.`,
      400,
    );
  const why = agentsContextRefusal({
    context_window: req.contextWindow,
    compact_at: req.compactAt,
  });
  if (why) return refuse(why, 400);
  const saved = store.campaignVersions(campaign)[0];
  const assigned = store.latestAssignments().get(campaign);
  const source = (saved?.contract ?? assigned?.payload.contract) as
    | Record<string, unknown>
    | undefined;
  if (!source)
    return refuse(
      `Control has no saved version or earlier assignment of ${campaign}. Save it on the New campaign page first.`,
      404,
    );
  const want = requestedContext(req);
  if (saved && same(contractContext(saved.contract), want))
    return {
      state: "unchanged",
      campaign,
      version: saved.version,
      sha: saved.sha,
      context: want,
    };
  // Newer than every version a rig may hold: the harness refuses a version that is not newer.
  const assignedVersion = Number((assigned?.payload.contract as { version?: unknown })?.version);
  const version = Math.max(
    store.nextCampaignVersion(campaign),
    Number.isInteger(assignedVersion) ? assignedVersion + 1 : 1,
  );
  const { agents_context: _old, ...rest } = source;
  const parsed = parseContract({ ...rest, version, ...(want ? { agents_context: want } : {}) });
  if (!parsed.ok)
    return refuse(
      `The contract of ${campaign} is not valid, so control cannot save a new version: ${parsed.errors.join("; ")}`,
    );
  const sources: CampaignSources = saved
    ? saved.sources
    : {
        assignment: Object.fromEntries(
          Object.entries((assigned as NonNullable<typeof assigned>).payload).filter(
            ([k]) => !RUN_FIELDS.has(k),
          ),
        ),
      };
  store.putCampaign({
    campaign,
    version,
    contract: parsed.contract,
    sha: parsed.sha,
    sources,
    // A copy's later versions still say where it came from.
    copiedFrom: saved?.copied_from ?? undefined,
    by,
  });
  store.audit(by, "campaign_context_set", {
    campaign,
    version,
    sha: parsed.sha,
    agents_context: want ?? null,
  });
  return { state: "saved", campaign, version, sha: parsed.sha, context: want };
}

/** The answer REST and MCP give: the campaign's version with the settings, and what it says. */
export function campaignContextAnswer(
  out: Exclude<CampaignContextOutcome, { state: "refused" }>,
): Record<string, unknown> {
  return {
    campaign: out.campaign,
    version: out.version,
    contract_sha: out.sha,
    agents_context: out.context ?? null,
    said:
      out.state === "unchanged"
        ? `Version ${out.version} of ${out.campaign} has these settings already: ${agentsContextWords(out.context)}.`
        : `Version ${out.version} of ${out.campaign} is saved. Its runs' agents: ${agentsContextWords(out.context)}. Runs started from now take it.`,
  };
}

/** The agents a campaign's runs have, by mode: a research run has no planner, auditor or panel. */
export function agentsOfMode(mode: unknown): ModelAgent[] {
  return mode === "research" ? ["workers", "teachers", "combiner"] : [...MODEL_AGENTS];
}

/** How each agent is named in words. */
export const AGENT_NAMES: Record<ModelAgent, string> = {
  workers: "Workers",
  planner: "Planner",
  teachers: "Teacher pair",
  combiner: "Combiner",
  auditor: "Auditor",
  panel: "Review panel",
};

/** What one agent of a run works with: its model, window and compaction point. */
export interface AgentContext {
  /** The model control gives it; null: the rig's own settings, or the rig's advisors file. */
  model: string | null;
  /**
   * Its window in tokens: the lower of the campaign's and its model's (the provider's, or the
   * rig's cap on it). Null: control does not know it (no model from control, no campaign window).
   */
  context_window: number | null;
  /** Its compaction point in percent; null: the rig's own, which control does not know. */
  compact_at: number | null;
}

/** What applies to a run's agents on a rig: the campaign's settings, and each agent's. */
export interface ContextApplies {
  campaign: AgentsContext;
  agents: Partial<Record<ModelAgent, AgentContext>>;
}

/** One agent's own model on control, with the provider's window and its cap and point. */
function ownModel(
  store: ControlStore,
  rig: string,
  agent: ModelAgent,
):
  | { model: string; listed: number; cap?: number | undefined; at?: number | undefined }
  | undefined {
  const own = agent === "workers" ? store.rigModels()[rig] : store.roleModels(rig)[agent];
  if (!own) return undefined;
  const listed =
    store.provider(own.provider)?.models.find((m) => m.id === own.model)?.context_window ?? 0;
  return { model: own.model, listed, cap: own.contextCap, at: own.compactAt };
}

/**
 * What applies to the agents of a run of a campaign with its own settings on a rig, as Start a
 * run says it: each agent's model, window and point. Undefined when the campaign sets none.
 */
export function contextApplies(
  store: ControlStore,
  rig: string,
  contract: unknown,
): ContextApplies | undefined {
  const campaign = contractContext(contract);
  if (!campaign) return undefined;
  const agents: Partial<Record<ModelAgent, AgentContext>> = {};
  const workers = (): AgentContext => {
    const own = ownModel(store, rig, "workers");
    if (!own)
      return {
        model: null,
        context_window: campaign.context_window ?? null,
        compact_at: campaign.compact_at ?? null,
      };
    const a = contextApplied(
      { contextWindow: cappedWindow(own.listed, own.cap), compactAt: own.at },
      campaign,
    );
    return {
      model: own.model,
      context_window: a.contextWindow || null,
      compact_at: a.compactAt ?? COMPACT_AT_DEFAULT,
    };
  };
  for (const agent of agentsOfMode((contract as { mode?: unknown } | null)?.mode)) {
    const own = agent === "workers" ? undefined : ownModel(store, rig, agent);
    if (agent === "workers" || (agent === "planner" && !own)) {
      agents[agent] = workers();
      continue;
    }
    if (!own) {
      agents[agent] = {
        model: null,
        context_window: campaign.context_window ?? null,
        compact_at: campaign.compact_at ?? null,
      };
      continue;
    }
    const a = contextApplied(
      { contextWindow: cappedWindow(own.listed, own.cap), compactAt: own.at },
      campaign,
    );
    agents[agent] = {
      model: own.model,
      context_window: a.contextWindow || null,
      compact_at: a.compactAt ?? COMPACT_AT_DEFAULT,
    };
  }
  return { campaign, agents };
}

const tokens = (n: number) => n.toLocaleString("en-US");

/** What applies, in words: the campaign's settings, then a sentence for each agent. */
export function contextAppliesWords(c: ContextApplies, rig: string): string {
  const lines = (Object.entries(c.agents) as [ModelAgent, AgentContext][]).map(([agent, a]) => {
    const from =
      a.model ??
      (agent === "workers" || agent === "planner"
        ? `the rig's own settings on ${rig}`
        : "the rig's advisors file");
    const window =
      a.context_window === null
        ? "the window of its model"
        : `${a.model ? "" : "at most "}${tokens(a.context_window)} tokens`;
    const point = a.compact_at === null ? "" : `, compacted at ${a.compact_at}% of the window`;
    return `${AGENT_NAMES[agent]}: ${window} (${from})${point}.`;
  });
  return `This campaign sets ${agentsContextWords(c.campaign)}. The lower window wins on each agent. ${lines.join(" ")}`;
}

/**
 * Why a run of a campaign with its own window cannot start on a rig, in words, or "": the window
 * is above what a provider lists for one of the rig's agents' models (control gave them). The
 * lower wins against a rig's cap; a window above the provider's is refused, as a cap is.
 */
export function campaignContextRefusal(
  store: ControlStore,
  rig: string,
  contract: unknown,
): string {
  const window = contractContext(contract)?.context_window;
  if (!window) return "";
  for (const agent of agentsOfMode((contract as { mode?: unknown } | null)?.mode)) {
    const own = ownModel(store, rig, agent);
    if (own && own.listed > 0 && window > own.listed)
      return `This campaign sets a context window of ${tokens(window)} tokens. ${own.model}, the model of the ${AGENT_NAMES[agent].toLowerCase()} on ${rig}, takes at most ${tokens(own.listed)} tokens. Set the campaign's window to ${tokens(own.listed)} or less, or give that agent another model.`;
  }
  return "";
}
