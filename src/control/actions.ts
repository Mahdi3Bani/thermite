/**
 * Actions the dashboard carries out that MCP offers too, so an agent can do what the owner does
 * on a page, through the same checks. createControlApi hands one object to both: the dashboard
 * fills it in, MCP calls it.
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
  /** Sets the slots of a cluster of pre-made slots and reads it again; an error in words. */
  setClusterSlots?: (cluster: string, slots: string[], by: string) => Promise<string | null>;
}
