import type { CopyCampaignOutcome, CopyCampaignRequest } from "./copy-campaign.ts";
import type { AgentModels, RigModelOutcome, RigModelRequest } from "./rig-model.ts";
import type { StartRunOutcome, StartRunRequest } from "./start-run.ts";

/**
 * Actions the dashboard carries out that MCP offers too, so an agent can do what the owner does
 * on a page, through the same checks. createControlApi hands one object to both: the dashboard
 * fills it in, MCP calls it (and the REST API, for Start a run and for copying a campaign).
 */

/** Adding a rig on a cluster control knows (Add a rig, or MCP's add_cluster_rig). */
export interface ClusterRigRequest {
  rig: string;
  cluster: string;
  /** For a cluster of pre-made slots: which free slot. */
  slot?: string | undefined;
  gpus: number;
  /** With two or more GPUs, how many are the judge's (default: half, rounded up). */
  judgeGpus?: string | number | undefined;
  /** "device-plugin", "dra" (with deviceClass) or "dra:<class>". */
  mode?: string | undefined;
  deviceClass?: string | undefined;
  node?: string | undefined;
  storageClass?: string | undefined;
  storageGi?: number | undefined;
  /** The rig's CPUs and memory; default: what the slot's quota allows, else none. */
  cpus?: number | undefined;
  memoryGi?: number | undefined;
}

export interface ControlActions {
  addClusterRig?: (
    r: ClusterRigRequest,
    by: string,
  ) => Promise<{ rig: string } | { error: string }>;
  /**
   * Gives one of a rig's agents a model from a provider, or (clear) its default again, as that
   * agent's row on Edit rig does (goal 029); the workers' harness default: the model's. A cap on
   * the workers' context window (goal 070) is set anew by each call for them: none when left out.
   */
  setRigModel?: (
    rig: string,
    r: RigModelRequest,
    by: string,
  ) => Promise<RigModelOutcome | { error: string }>;
  /** Each of a rig's agents' models on control (MCP's rig_models, REST's GET of the same route). */
  rigModels?: (rig: string) => AgentModels | { error: string };
  /**
   * Moves a rig control set up on a cluster onto control's current images, keeping its volume and
   * tokens (the rig's page, or MCP's update_rig_images).
   */
  updateRigImages?: (rig: string, by: string) => Promise<{ ok: string } | { error: string }>;
  /** Stop, start or restart a rig control set up on a cluster, as on its page. */
  clusterRigAction?: (
    rig: string,
    action: "stop" | "start" | "restart",
    by: string,
  ) => Promise<{ ok: string } | { error: string }>;
  /** Sets the slots of a cluster of pre-made slots and reads it again; an error in words. */
  setClusterSlots?: (cluster: string, slots: string[], by: string) => Promise<string | null>;
  /**
   * Checks where a rig control set up runs (Check again on its page): whether its containers run.
   * What it found is a step in the rig's history. Null when control can't reach where it runs.
   */
  checkRigPlace?: (rig: string, by: string) => Promise<{ ok: boolean; words: string } | null>;
  /**
   * Starts a run of a campaign control keeps, as a campaign page's Start a run does, with its
   * checks and its refusals in words (REST, MCP's start_run and `thermite run start`). `owner`:
   * whether the owner's token asks, which alone starts a stopped RunPod pod.
   */
  startRun?: (r: StartRunRequest, by: string, owner: boolean) => Promise<StartRunOutcome>;
  /**
   * Copies a campaign control keeps under a new name, with its own empty folder in the knowledge
   * base and no runs (REST, MCP's copy_campaign and `thermite campaign copy`; goal 069).
   */
  copyCampaign?: (r: CopyCampaignRequest, by: string) => CopyCampaignOutcome;
}
