import type { ClusterResourcesRequest, ResizeRefusal } from "./cluster-resources.ts";

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
   * Moves a rig control set up on a cluster onto control's current images, keeping its volume and
   * tokens (the rig's page, or MCP's update_rig_images). It drains the rig first (goal 079):
   * running trials and the judge's job under way finish, then its pods restart. `wait: false`
   * restarts them now, also while a drain is under way.
   */
  updateRigImages?: (
    rig: string,
    by: string,
    o?: { wait?: boolean | undefined },
  ) => Promise<{ ok: string } | { error: string }>;
  /**
   * Changes the GPUs, CPUs or memory of a rig control set up on a cluster, keeping its volume and
   * tokens (Edit rig, REST's POST /v1/rigs/<rig>/cluster/resources, MCP's set_cluster_rig_resources;
   * goal 118), as an image update moves it: it drains first unless `wait: false`. `owner`: whether
   * the owner's token asks, which alone may give the judge's share.
   */
  setClusterRigResources?: (
    rig: string,
    want: ClusterResourcesRequest,
    by: string,
    o: { wait?: boolean | undefined; owner: boolean },
  ) => Promise<{ ok: string } | ResizeRefusal>;
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
}
