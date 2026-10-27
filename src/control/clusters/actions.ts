import type { ClusterRig } from "../store.ts";

/** What a cluster rig's page can do to it. */
export type ClusterRigAction = "stop" | "start" | "restart" | "remove";

/**
 * The kubectl calls of one action on a rig control set up on a cluster: stop and start scale its
 * deployments; remove deletes its namespace, or in a pre-made slot its own objects, then its
 * resource claim templates (a cluster without DRA has none, so that last call may fail).
 */
export function clusterActionCalls(r: ClusterRig, action: ClusterRigAction): string[][] {
  const sel = ["-n", r.namespace, "-l", `app.kubernetes.io/instance=${r.rig}`];
  if (action === "stop" || action === "start")
    return [["scale", "deployment", ...sel, `--replicas=${action === "stop" ? 0 : 1}`]];
  if (action === "restart") return [["rollout", "restart", "deployment", ...sel]];
  if (r.placement === "created")
    return [["delete", "namespace", r.namespace, "--wait=false", "--ignore-not-found"]];
  return [
    ["delete", "deployment,service,persistentvolumeclaim,secret", ...sel, "--ignore-not-found"],
    ["delete", "resourceclaimtemplates", ...sel, "--ignore-not-found"],
  ];
}
