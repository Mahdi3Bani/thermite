import { parseContract } from "../core/contract.ts";
import { buildCampaign } from "./campaign-builder.ts";
import { issueCommand } from "./issue.ts";
import type { KitRepos } from "./kit-repos.ts";
import type { ControlStore } from "./store.ts";

/**
 * Creating a campaign from the new-campaign page: build the contract (and the kit, when it was
 * described there), keep the kit as a git repository on control, store the contract as the
 * campaign's next version approved by whoever started it, and assign its first run to the
 * chosen rig. The rig's supervisor then fetches the project from its repository and the kit
 * from control, and the harness checks both by commit.
 */

export interface StartInput {
  /** The page's answers (see campaign-builder.ts); the target comes from the rig. */
  draft: Record<string, unknown>;
  rig: string;
  /** The rig's measurement target, from its reported hardware. */
  target: { type: string; class: string };
  /** Save the campaign only, or also start its first run. */
  start: boolean;
  promotion?: "auto" | "owner_approval" | undefined;
  by: string;
}

export type StartResult =
  | { ok: true; campaign: string; version: number; sha: string; run?: string; command?: string }
  | { ok: false; errors: string[] };

export function startCampaign(
  deps: { store: ControlStore; kits: KitRepos; privateKeyPem: string },
  input: StartInput,
): StartResult {
  const built = buildCampaign({ ...input.draft, target: input.target });
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
      `${contract.campaign} version ${version}: the kit as described on the new-campaign page`,
    );
  }
  const parsed = parseContract(contract);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  deps.store.putCampaign({
    campaign: contract.campaign,
    version,
    contract: parsed.contract,
    sha: parsed.sha,
    by: input.by,
  });
  if (!input.start) return { ok: true, campaign: contract.campaign, version, sha: parsed.sha };

  const draft = input.draft as {
    project?: { url: string; commit: string; repo: string; access?: string };
    kit?: { source: string; url?: string; repo?: string; commit?: string; access?: string };
  };
  const run = deps.store.nextRunName(input.rig, contract.campaign);
  const imports: unknown[] = [];
  let seed: { repo: string; commit: string } | undefined;
  if (contract.mode !== "research" && draft.project && contract.project.kit) {
    const p = draft.project;
    seed = { repo: p.repo, commit: p.commit };
    imports.push({
      kind: "repo_bundle",
      path: `repos/${p.repo}-${p.commit}.bundle`,
      repo: p.repo,
      commit: p.commit,
      source: { git: p.url, ...(p.access ? { access: p.access } : {}) },
    });
    const k = contract.project.kit;
    imports.push({
      kind: "kit_bundle",
      path: `repos/kit-${k.repo}-${k.commit}.bundle`,
      repo: k.repo,
      commit: k.commit,
      source: built.kit
        ? { control: `kits/${k.repo}` }
        : {
            git: draft.kit?.url as string,
            ...(draft.kit?.access ? { access: draft.kit.access } : {}),
          },
    });
  }
  const issued = issueCommand(deps.store, deps.privateKeyPem, {
    rig: input.rig,
    kind: "assign_campaign",
    payload: {
      run,
      contract: parsed.contract,
      contract_sha: parsed.sha,
      ...(seed ? { seed } : {}),
      ...(input.promotion ? { promotion: input.promotion } : {}),
      imports,
    },
    issuedBy: input.by,
  });
  return {
    ok: true,
    campaign: contract.campaign,
    version,
    sha: parsed.sha,
    run,
    command: issued.id,
  };
}
