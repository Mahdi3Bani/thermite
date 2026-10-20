import { parseContract } from "../core/contract.ts";
import { buildCampaign } from "./campaign-builder.ts";
import { issueCommand } from "./issue.ts";
import type { KitRepos } from "./kit-repos.ts";
import type { CampaignSources, ControlStore } from "./store.ts";

/**
 * Creating a campaign from the new-campaign page: build the contract (and the kit, when it was
 * described there), keep the kit as a git repository on control, store the contract as the
 * campaign's next version approved by whoever started it, with where its runs fetch from, and
 * start a run of it on the chosen rig. The rig's supervisor then fetches the project from its
 * repository and the kit from control, and the harness checks both by commit.
 *
 * A run is either a campaign's own run (its agents at work) or a try: the same assignment with
 * no agents, so the judge builds the starting point and runs every case once on its own, and
 * the owner sees the kit work before agents spend anything.
 */

export interface StartInput {
  /** The page's answers (see campaign-builder.ts); the target comes from the rig. */
  draft: Record<string, unknown>;
  rig: string;
  /** The rig's measurement target, from its reported hardware. */
  target: { type: string; class: string };
  /** Save only; start a run with its agents; or try the kit (a run with no agents). */
  start: boolean | "try";
  promotion?: "auto" | "owner_approval" | undefined;
  by: string;
}

export type StartResult =
  | {
      ok: true;
      campaign: string;
      version: number;
      sha: string;
      run?: string | undefined;
      command?: string | undefined;
    }
  | { ok: false; errors: string[] };

type Deps = {
  store: ControlStore;
  kits: KitRepos;
  privateKeyPem: string;
  /** The files of a kit uploaded on the page, by its id. */
  uploads?: ((id: string) => Record<string, Buffer> | undefined) | undefined;
};

export function startCampaign(deps: Deps, input: StartInput): StartResult {
  const built = buildCampaign({ ...input.draft, target: input.target }, { uploads: deps.uploads });
  if (!built.ok) return built;
  const contract = built.contract as {
    campaign: string;
    version: number;
    mode: string;
    project: { repo: string; kit?: { repo: string; commit: string } };
  };
  const version = deps.store.nextCampaignVersion(contract.campaign);
  contract.version = version;
  if (built.kit && contract.project.kit) {
    contract.project.kit.commit = deps.kits.commit(
      built.kit.name,
      built.kit.files,
      `${contract.campaign} version ${version}: the kit from the new-campaign page`,
    );
  }
  const parsed = parseContract(contract);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const draft = input.draft as {
    project?: { url: string; commit: string; repo: string; access?: string };
    kit?: { source: string; url?: string; access?: string };
  };
  const sources: CampaignSources =
    contract.mode === "research" || !draft.project || !contract.project.kit
      ? {}
      : {
          project: {
            url: draft.project.url,
            ...(draft.project.access ? { access: draft.project.access } : {}),
            repo: draft.project.repo,
            commit: draft.project.commit,
          },
          kit: built.kit
            ? { control: `kits/${contract.project.kit.repo}` }
            : {
                git: draft.kit?.url as string,
                ...(draft.kit?.access ? { access: draft.kit.access } : {}),
              },
        };
  deps.store.putCampaign({
    campaign: contract.campaign,
    version,
    contract: parsed.contract,
    sha: parsed.sha,
    sources,
    by: input.by,
  });
  if (!input.start) return { ok: true, campaign: contract.campaign, version, sha: parsed.sha };
  const r = startRun(deps, {
    campaign: contract.campaign,
    version,
    rig: input.rig,
    target: input.target,
    agents: input.start !== "try",
    promotion: input.promotion,
    by: input.by,
  });
  return r.ok ? { ...r, version, sha: parsed.sha } : r;
}

export interface RunInput {
  campaign: string;
  /** The version to run; the latest when not given. */
  version?: number | undefined;
  rig: string;
  /** The rig's measurement target, when it has reported one. */
  target?: { type: string; class: string } | undefined;
  /** False: a try, with no agents. */
  agents: boolean;
  promotion?: "auto" | "owner_approval" | undefined;
  by: string;
}

/**
 * A run of a campaign assigned over the API, MCP or the CLI (no version saved on control): the
 * newest assignment again, with the same contract, starting point and imports, as a new run.
 */
function againLikeBefore(
  deps: Deps,
  input: RunInput,
): { ok: true; campaign: string; run: string; command: string } | { ok: false; errors: string[] } {
  const past = deps.store.latestAssignments().get(input.campaign);
  if (!past)
    return {
      ok: false,
      errors: [
        `${input.campaign} has no saved version and no earlier assignment on control to start from`,
      ],
    };
  const contract = past.payload.contract as { target?: { type?: string } } | undefined;
  if (input.target && contract?.target?.type && contract.target.type !== input.target.type)
    return {
      ok: false,
      errors: [
        `${input.rig} measures on ${input.target.type}, and this campaign's kit measures on ${contract.target.type}: choose a rig with that hardware`,
      ],
    };
  const name = input.agents ? input.campaign : `${input.campaign.slice(0, 54)}-try`;
  const run = deps.store.nextRunName(input.rig, name);
  const { run: _old, agents: _agents, promotion: _promotion, ...rest } = past.payload;
  const issued = issueCommand(deps.store, deps.privateKeyPem, {
    rig: input.rig,
    kind: "assign_campaign",
    payload: {
      ...rest,
      run,
      ...(input.agents ? {} : { agents: false }),
      ...(input.promotion ? { promotion: input.promotion } : {}),
    },
    issuedBy: input.by,
  });
  return { ok: true, campaign: input.campaign, run, command: issued.id };
}

/** Starts a run of a stored campaign version on a rig: its own run, or a try with no agents. */
export function startRun(
  deps: Deps,
  input: RunInput,
): { ok: true; campaign: string; run: string; command: string } | { ok: false; errors: string[] } {
  const versions = deps.store.campaignVersions(input.campaign);
  const v =
    input.version === undefined ? versions[0] : versions.find((x) => x.version === input.version);
  if (!v && input.version === undefined) return againLikeBefore(deps, input);
  if (!v) return { ok: false, errors: [`no saved version of ${input.campaign} to run`] };
  const contract = v.contract as {
    mode: string;
    target?: { type: string };
    project: { repo: string; kit?: { repo: string; commit: string } };
  };
  if (input.target && contract.target && contract.target.type !== input.target.type)
    return {
      ok: false,
      errors: [
        `${input.rig} measures on ${input.target.type}, and this campaign's kit measures on ${contract.target.type}: choose a rig with that hardware`,
      ],
    };
  const name = input.agents ? input.campaign : `${input.campaign.slice(0, 54)}-try`;
  const run = deps.store.nextRunName(input.rig, name);
  const imports: unknown[] = [];
  let seed: { repo: string; commit: string } | undefined;
  const p = v.sources.project;
  const k = contract.project.kit;
  if (contract.mode !== "research" && p && k && v.sources.kit) {
    seed = { repo: p.repo, commit: p.commit };
    imports.push({
      kind: "repo_bundle",
      path: `repos/${p.repo}-${p.commit}.bundle`,
      repo: p.repo,
      commit: p.commit,
      source: { git: p.url, ...(p.access ? { access: p.access } : {}) },
    });
    imports.push({
      kind: "kit_bundle",
      path: `repos/kit-${k.repo}-${k.commit}.bundle`,
      repo: k.repo,
      commit: k.commit,
      source: v.sources.kit,
    });
  }
  const issued = issueCommand(deps.store, deps.privateKeyPem, {
    rig: input.rig,
    kind: "assign_campaign",
    payload: {
      run,
      contract: v.contract,
      contract_sha: v.sha,
      ...(seed ? { seed } : {}),
      ...(input.agents ? {} : { agents: false }),
      ...(input.promotion ? { promotion: input.promotion } : {}),
      imports,
    },
    issuedBy: input.by,
  });
  return { ok: true, campaign: input.campaign, run, command: issued.id };
}
