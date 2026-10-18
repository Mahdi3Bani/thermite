import { type ClusterKubectl, type ClusterTarget, kubeError } from "./kubectl.ts";
import { harnessKeptOffCluster } from "./netcheck.ts";

/**
 * What control reads from a cluster before it sets a rig up there, and again with "Check again".
 * Only reads: the server's version, its nodes and their GPUs (NVIDIA's device plugin), DRA device
 * classes, storage classes, and whether control may create namespaces (created placement) or
 * deploy into each slot (pre-made placement).
 */

export interface ClusterNode {
  name: string;
  ready: boolean;
  /** Allocatable nvidia.com/gpu (the device plugin); 0 when none. */
  gpus: number;
  gpu_product?: string | undefined;
  cpu: string;
  memory: string;
}

export interface ClusterSlot {
  namespace: string;
  /** Control may create the rig's objects there. */
  usable: boolean;
  /** A rig control set up there already, by its label. */
  used_by?: string | undefined;
  /** Whether the slot's network rules keep a harness off the cluster, and why. */
  network_ok?: boolean | undefined;
  network_why?: string | undefined;
}

export interface ClusterFacts {
  version: string;
  nodes: ClusterNode[];
  device_classes: string[];
  storage_classes: { name: string; default: boolean }[];
  can_create_namespaces: boolean;
  slots: ClusterSlot[];
}

type K8sList = { items?: Record<string, unknown>[] };
const json = (s: string): K8sList => {
  try {
    return JSON.parse(s) as K8sList;
  } catch {
    return {};
  }
};
const meta = (o: Record<string, unknown>) =>
  (o.metadata ?? {}) as {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };

/** Nodes from `kubectl get nodes -o json`. */
export function parseNodes(text: string): ClusterNode[] {
  return (json(text).items ?? []).map((n) => {
    const status = (n.status ?? {}) as {
      allocatable?: Record<string, string>;
      conditions?: { type: string; status: string }[];
    };
    return {
      name: meta(n).name ?? "?",
      ready: (status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
      gpus: Number(status.allocatable?.["nvidia.com/gpu"] ?? 0) || 0,
      gpu_product: meta(n).labels?.["nvidia.com/gpu.product"],
      cpu: status.allocatable?.cpu ?? "?",
      memory: status.allocatable?.memory ?? "?",
    };
  });
}

/** Storage classes from `kubectl get storageclass -o json`, the default one marked. */
export function parseStorageClasses(text: string): { name: string; default: boolean }[] {
  return (json(text).items ?? []).map((s) => ({
    name: meta(s).name ?? "?",
    default:
      meta(s).annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ||
      meta(s).annotations?.["storageclass.beta.kubernetes.io/is-default-class"] === "true",
  }));
}

/** The labels every rig's harness pod has (its instance label is added per rig). */
export const HARNESS_LABELS = {
  "app.kubernetes.io/name": "thermite",
  "app.kubernetes.io/managed-by": "thermite-control",
  "app.kubernetes.io/component": "harness",
};

/** Reads a slot's network rules and says whether they keep a harness with these labels off the cluster. */
export async function slotNetwork(
  k: ClusterKubectl,
  t: ClusterTarget,
  namespace: string,
  labels: Record<string, string>,
): Promise<{ ok: boolean; why: string }> {
  const r = await k.kubectl(t, ["get", "networkpolicy", "-n", namespace, "-o", "json"]);
  if (r.code !== 0)
    return { ok: false, why: `control could not read the slot's network rules: ${kubeError(r)}` };
  return harnessKeptOffCluster((json(r.stdout).items ?? []) as never[], labels);
}

/** Reads the cluster. Throws, in words, when control can't reach it at all. */
export async function checkCluster(
  k: ClusterKubectl,
  t: ClusterTarget,
  slots: string[],
): Promise<ClusterFacts> {
  const version = await k.kubectl(t, ["version", "-o", "json"]);
  if (version.code !== 0)
    throw new Error(`control could not reach the cluster: ${kubeError(version)}`);
  let gitVersion = "?";
  try {
    gitVersion =
      (JSON.parse(version.stdout) as { serverVersion?: { gitVersion?: string } }).serverVersion
        ?.gitVersion ?? "?";
  } catch {}
  const nodes = await k.kubectl(t, ["get", "nodes", "-o", "json"]);
  const classes = await k.kubectl(t, ["get", "deviceclasses", "-o", "json"]);
  const storage = await k.kubectl(t, ["get", "storageclass", "-o", "json"]);
  const ns = await k.kubectl(t, ["auth", "can-i", "create", "namespaces"]);
  const out: ClusterFacts = {
    version: gitVersion,
    nodes: nodes.code === 0 ? parseNodes(nodes.stdout) : [],
    device_classes:
      classes.code === 0 ? (json(classes.stdout).items ?? []).map((c) => meta(c).name ?? "?") : [],
    storage_classes: storage.code === 0 ? parseStorageClasses(storage.stdout) : [],
    can_create_namespaces: ns.stdout.trim() === "yes",
    slots: [],
  };
  for (const s of slots) {
    const can = await k.kubectl(t, ["auth", "can-i", "create", "deployments", "-n", s]);
    const used = await k.kubectl(t, [
      "get",
      "deployments",
      "-n",
      s,
      "-l",
      "app.kubernetes.io/managed-by=thermite-control",
      "-o",
      "jsonpath={.items[0].metadata.labels.app\\.kubernetes\\.io/instance}",
    ]);
    const net = await slotNetwork(k, t, s, HARNESS_LABELS);
    out.slots.push({
      namespace: s,
      usable: can.stdout.trim() === "yes",
      used_by: used.code === 0 && used.stdout.trim() ? used.stdout.trim() : undefined,
      network_ok: net.ok,
      network_why: net.why,
    });
  }
  return out;
}

/** A short line about the cluster, for the Providers list. */
export function clusterLine(f: ClusterFacts): string {
  const gpuNodes = f.nodes.filter((n) => n.gpus > 0);
  const gpus = gpuNodes.reduce((t, n) => t + n.gpus, 0);
  const def = f.storage_classes.find((s) => s.default)?.name;
  return [
    `Kubernetes ${f.version}`,
    `${f.nodes.length} node${f.nodes.length === 1 ? "" : "s"}${gpuNodes.length ? `, ${gpuNodes.length} with ${gpus} GPU${gpus === 1 ? "" : "s"}` : ", no GPU nodes"}`,
    f.device_classes.length ? `DRA: ${f.device_classes.join(", ")}` : "",
    def
      ? `storage ${def}`
      : f.storage_classes.length
        ? "no default storage class"
        : "no storage class",
  ]
    .filter(Boolean)
    .join(" · ");
}
