import { z } from "zod";
import { IdSchema, parseContract } from "../core/contract.ts";
import type { CampaignSources, ControlStore, CopiedFrom } from "./store.ts";
import { isRigCheck } from "./ui/campaigns.ts";

/**
 * Copy a campaign (goal 069): a new campaign with another name, the same contract and the same
 * kit as the source's newest saved version or, for a campaign control knows only by an
 * assignment, as that assignment. Control saves the copy as its first version, with the new name
 * in its contract, so its contract hash is its own. The copy has no runs: Start a run starts one.
 * Its folder in Thermite's knowledge base is its own and empty, and no grant names it, so its
 * runs read nothing that the source's runs recorded. That is what two runs of one campaign can't
 * do: they share the campaign's folder.
 *
 * REST's POST /v1/campaigns/<name>/copy, MCP's copy_campaign and `thermite campaign copy` call it
 * through ControlActions.copyCampaign, which dashboard.ts fills in with the campaigns it knows.
 */

export interface CopyCampaignRequest {
  /** The campaign to copy. */
  from: string;
  /** The copy's name. */
  name: string;
}

export type CopyCampaignOutcome =
  | { state: "copied"; campaign: string; version: number; sha: string; from: CopiedFrom }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** The request's field over REST and MCP, besides the campaign to copy. */
export const copyCampaignFields = {
  name: z
    .string()
    .describe(
      "The copy's name, as on the New campaign page: lowercase letters, digits, dots, dashes and underscores, at most 64. No campaign may have it yet",
    ),
};

/** The REST body: the copy's name, and nothing else. */
export const CopyCampaignBody = z.strictObject(copyCampaignFields);

/** The fields of an assignment that belong to one run, not to the campaign: a copy leaves them out. */
const RUN_FIELDS = new Set([
  "run",
  "contract",
  "contract_sha",
  "agents",
  "promotion",
  "queue",
  "briefing",
]);

/**
 * Copies a campaign, or says in words why not. `known`: every campaign name control knows (from
 * rigs' reports, saved versions, assignments and the knowledge base's folders), none of which a
 * copy may take.
 */
export function copyCampaign(
  store: ControlStore,
  req: CopyCampaignRequest,
  by: string,
  known: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): CopyCampaignOutcome {
  const refuse = (error: string, status: 400 | 404 | 409 = 409): CopyCampaignOutcome => ({
    state: "refused",
    error,
    status,
  });
  const { from, name } = req;
  if (isRigCheck(from))
    return refuse(`${from} is a rig check's campaign. A rig check cannot be copied.`, 400);
  const saved = store.campaignVersions(from)[0];
  const assigned = saved ? undefined : store.latestAssignments().get(from);
  if (!saved && !assigned)
    return refuse(
      `Control has no saved version or earlier assignment of ${from}. There is nothing to copy.`,
      404,
    );
  if (!IdSchema.safeParse(name).success)
    return refuse(
      "A campaign's name is lowercase letters, digits, dots, dashes and underscores, at most 64. It starts with a letter or a digit.",
      400,
    );
  if (isRigCheck(name))
    return refuse(
      "A name that starts with rig-check- is for rig checks. Choose another name.",
      400,
    );
  const kb = store.kb();
  if (known.has(name) || kb.reads(name).length || kb.readBy(name).length)
    return refuse(`There is a campaign named ${name} already. Choose another name.`, 409);
  const version = store.nextCampaignVersion(name);
  const source = (saved?.contract ?? assigned?.payload.contract) as Record<string, unknown>;
  // The contract names its campaign once: the copy's name, and its first version, there.
  const parsed = parseContract({ ...source, campaign: name, version });
  if (!parsed.ok)
    return refuse(
      `The contract of ${from} is not valid, so control cannot copy it: ${parsed.errors.join("; ")}`,
    );
  let sources: CampaignSources;
  let copiedFrom: CopiedFrom;
  if (saved) {
    sources = saved.sources;
    copiedFrom = { campaign: from, version: saved.version };
  } else {
    const a = assigned as NonNullable<typeof assigned>;
    sources = {
      assignment: Object.fromEntries(Object.entries(a.payload).filter(([k]) => !RUN_FIELDS.has(k))),
    };
    copiedFrom = { campaign: from, rig: a.rig, run: a.run };
  }
  store.putCampaign({
    campaign: name,
    version,
    contract: parsed.contract,
    sha: parsed.sha,
    sources,
    copiedFrom,
    by,
  });
  store.audit(by, "campaign_copied", { campaign: name, from: copiedFrom, sha: parsed.sha });
  return { state: "copied", campaign: name, version, sha: parsed.sha, from: copiedFrom };
}

/** The answer REST and MCP give: the copy, its contract's hash and where it came from. */
export function copyCampaignAnswer(
  out: Extract<CopyCampaignOutcome, { state: "copied" }>,
): Record<string, unknown> {
  return {
    campaign: out.campaign,
    version: out.version,
    contract_sha: out.sha,
    from: out.from,
  };
}

/** Where a copy came from, in words: "gemv-speed version 2", or the assignment it copied. */
export function copiedFromWords(f: CopiedFrom): string {
  return f.version !== undefined
    ? `${f.campaign} version ${f.version}`
    : `${f.campaign} as assigned for ${f.run ?? "a run"} on ${f.rig ?? "a rig"}`;
}
