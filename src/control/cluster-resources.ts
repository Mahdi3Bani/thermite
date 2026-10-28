import { z } from "zod";
import { errorText } from "../common/errors.ts";
import { judgeGpusByDefault } from "../core/hardware.ts";
import type { ClusterFacts, SlotQuota } from "./clusters/facts.ts";
import { rigResources } from "./clusters/manifests.ts";
import { MAX_RIG_GPUS } from "./machines/deploy.ts";
import type { ClusterRig, ClusterRigSize } from "./store/index.ts";

/**
 * A new size for a rig control set up on a cluster (goal 118): its GPUs, the judge's share of them,
 * and its CPUs and memory. Edit rig, REST's `POST /v1/rigs/<rig>/cluster/resources` and MCP's
 * `set_cluster_rig_resources` check a change here (planClusterResize), with the words Add a rig
 * uses; the dashboard applies it as an image update moves a rig (clusters/resize.ts's setClusterRigResources):
 * its two deployments again, on the images it runs, draining first while it works. Its secret (so
 * its tokens), volume claim, service and network rules stay.
 *
 * An operator's token may change the GPUs, CPUs and memory, within what the slot and the cluster
 * allow. The judge's share (judge_gpus) is the owner's alone, as on Edit rig: a new number of GPUs
 * without it gives the judge half of them, rounded up, as when a rig is added. A rig moves between
 * none and some GPUs only as a new rig: its harness image and its target would change (CPU and
 * CUDA), and the timings of its runs would no longer compare.
 */

/** What a caller asks for; a field left out stays. null CPUs and memory: the namespace's defaults. */
export interface ClusterResourcesRequest {
  gpus?: number | undefined;
  judgeGpus?: number | undefined;
  cpus?: number | null | undefined;
  memoryGi?: number | null | undefined;
}

/** A plan's refusal, with the HTTP status REST answers it with. */
export type ResizeRefusal = { error: string; status: 400 | 403 | 404 | 409 };

/** The judge's share of `n` GPUs: given, else half rounded up; or why not. One GPU is shared. */
export function judgeShareOf(given: number | undefined, n: number): number | undefined | string {
  if (n < 2) return undefined;
  if (given === undefined) return judgeGpusByDefault(n);
  if (!Number.isInteger(given) || given < 1 || given > n - 1 || given > 8 || n - given > 8)
    return `With ${n} GPUs the judge takes 1 to ${Math.min(8, n - 1)} of them, and the agents at most 8.`;
  return given;
}

const num = (x: number) => String(Math.round(x * 1000) / 1000);

/** CPUs and memory in words: "16 CPUs, 52 GiB", or "namespace defaults". */
export const resourcesWords = (r: ClusterRigSize["resources"]) =>
  r ? `${num(r.cpus)} CPU${r.cpus === 1 ? "" : "s"}, ${num(r.memoryGi)} GiB` : "namespace defaults";

/** How a rig's GPUs are used: "2 for the judge, 2 for the agents"; shared; or none. */
export const splitOf = (s: ClusterRigSize) =>
  s.gpus < 2
    ? ""
    : `${s.judgeGpus ?? judgeGpusByDefault(s.gpus)} for the judge, ${s.gpus - (s.judgeGpus ?? judgeGpusByDefault(s.gpus))} for the agents`;

/** A size in a sentence: "4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory". */
export function sizeWords(s: ClusterRigSize): string {
  const gpus = s.gpus === 0 ? "" : s.gpus === 1 ? "1 GPU, " : `${s.gpus} GPUs (${splitOf(s)}), `;
  const res = s.resources
    ? `${num(s.resources.cpus)} CPU${s.resources.cpus === 1 ? "" : "s"} and ${num(s.resources.memoryGi)} GiB of memory`
    : "the namespace's default CPUs and memory";
  return `${gpus}${res}`;
}

/** What changed, for the rig's setup step: "GPUs 3 → 4 (…); CPUs and memory: namespace defaults → 16 CPUs, 52 GiB". */
export function sizeChangeWords(from: ClusterRigSize, to: ClusterRigSize): string {
  const parts: string[] = [];
  if (from.gpus !== to.gpus)
    parts.push(`GPUs ${from.gpus} → ${to.gpus}${to.gpus >= 2 ? ` (${splitOf(to)})` : ""}`);
  else if ((from.judgeGpus ?? null) !== (to.judgeGpus ?? null))
    parts.push(`the judge's share → ${splitOf(to)}`);
  if (!sameResources(from.resources, to.resources))
    parts.push(
      `CPUs and memory: ${resourcesWords(from.resources)} → ${resourcesWords(to.resources)}`,
    );
  return parts.join("; ");
}

const sameResources = (a: ClusterRigSize["resources"], b: ClusterRigSize["resources"]) =>
  a === undefined || b === undefined
    ? a === b
    : Math.abs(a.cpus - b.cpus) < 1e-9 && Math.abs(a.memoryGi - b.memoryGi) < 1e-9;

/** A rig's size now, from its spec. */
export const sizeOf = (r: ClusterRig): ClusterRigSize => ({
  gpus: r.spec.gpus,
  judgeGpus: r.spec.judgeGpus,
  resources: r.spec.resources,
});

/** Whether a request names nothing to change. */
export const asksNothing = (w: ClusterResourcesRequest) =>
  w.gpus === undefined &&
  w.judgeGpus === undefined &&
  w.cpus === undefined &&
  w.memoryGi === undefined;

/**
 * Why a slot's quota refuses a rig this size, in Add a rig's words; undefined when it fits or the
 * quota sets no limit (or control can't read it). Only the parts given are checked.
 */
export function quotaRefusal(
  namespace: string,
  quota: SlotQuota | undefined,
  s: {
    gpus?: number | undefined;
    deviceClass?: string | undefined;
    resources?: ClusterRigSize["resources"];
  },
): string | undefined {
  if (!quota) return undefined;
  const r = s.resources;
  if (r && quota.cpus !== undefined && r.cpus > quota.cpus + 1e-9)
    return `The slot ${namespace} allows ${num(quota.cpus)} CPUs.`;
  if (r && quota.memoryGi !== undefined && r.memoryGi > quota.memoryGi + 1e-9)
    return `The slot ${namespace} allows ${num(quota.memoryGi)} GiB of memory.`;
  const n = s.gpus ?? 0;
  if (n > 0 && s.deviceClass) {
    const max = quota.devices?.[s.deviceClass];
    if (max !== undefined && n > max)
      return `The slot ${namespace} allows ${max} device${max === 1 ? "" : "s"} of the class ${s.deviceClass}.`;
  } else if (n > 0 && quota.gpus !== undefined && n > quota.gpus)
    return `The slot ${namespace} allows ${quota.gpus} GPU${quota.gpus === 1 ? "" : "s"}.`;
  return undefined;
}

/**
 * Checks a new size for a rig control set up on a cluster, as Add a rig checks one: the number of
 * GPUs (none to 16, never between none and some), the judge's share (the owner's only), the device
 * plugin's nodes or the DRA device class as control last read the cluster, CPUs and memory (at
 * least 1.5 CPUs and 6 GiB, both or neither), and the slot's quota (`quota`, as control read it
 * just now). Returns the new size, `same` when nothing differs, or a refusal in words.
 */
export function planClusterResize(
  r: ClusterRig,
  want: ClusterResourcesRequest,
  o: { owner: boolean; facts: ClusterFacts | null; quota: SlotQuota | undefined },
): { size: ClusterRigSize } | { same: true } | ResizeRefusal {
  const refuse = (error: string, status: ResizeRefusal["status"] = 400): ResizeRefusal => ({
    error,
    status,
  });
  const s = r.spec;
  // The split is the owner's, as Edit rig's GPUs for the judge is: a new split restarts the
  // harness and changes how fast the judge checks.
  if (want.judgeGpus !== undefined && !o.owner)
    return refuse(
      "Only the owner's token changes a rig's GPU split: leave out judge_gpus. A new number of GPUs without it gives the judge half of them, rounded up.",
      403,
    );
  if (
    want.gpus !== undefined &&
    (!Number.isInteger(want.gpus) || want.gpus < 0 || want.gpus > MAX_RIG_GPUS)
  )
    return refuse(`A rig takes from none to ${MAX_RIG_GPUS} GPUs.`);
  const n = want.gpus ?? s.gpus;
  if ((s.gpus === 0) !== (n === 0))
    return refuse(
      s.gpus === 0
        ? `${r.rig} measures on the CPU, and can't take GPUs: its harness image and its target would change, and its runs' timings would no longer compare. Add a new rig with GPUs instead.`
        : `${r.rig} measures on GPUs, and can't move to none: its harness image and its target would change, and its runs' timings would no longer compare. Add a new rig on the CPU instead.`,
    );
  if (want.judgeGpus !== undefined && n === s.gpus)
    return refuse(
      `judge_gpus goes with a new number of GPUs. To change the split of ${r.rig}'s ${s.gpus} GPUs alone, use GPUs for the judge on Edit rig, or set_rig_settings.`,
    );
  const judge = n === s.gpus ? s.judgeGpus : judgeShareOf(want.judgeGpus, n);
  if (typeof judge === "string") return refuse(judge);
  const f = o.facts;
  if (n !== s.gpus) {
    if (s.gpuMode === "dra") {
      if (f?.device_classes.length && !f.device_classes.includes(s.deviceClass ?? ""))
        return refuse(`${r.cluster} no longer offers the DRA device class ${s.deviceClass}.`);
    } else {
      const nodes = (f?.nodes ?? []).filter((x) => !s.node || x.name === s.node);
      if (f?.nodes.length && !nodes.some((x) => x.gpus >= n))
        return refuse(
          s.node
            ? `The node ${s.node} offers ${nodes[0]?.gpus ?? 0} GPU${nodes[0]?.gpus === 1 ? "" : "s"} through the device plugin, not ${n}.`
            : `No node of ${r.cluster} offers ${n} GPUs through the device plugin.`,
        );
    }
    const why = quotaRefusal(r.namespace, o.quota, {
      gpus: n,
      deviceClass: s.gpuMode === "dra" ? s.deviceClass : undefined,
    });
    if (why) return refuse(why);
  }
  // CPUs and memory: each left out stays; null for both: the namespace's defaults.
  let resources = s.resources;
  if (want.cpus !== undefined || want.memoryGi !== undefined) {
    if (want.cpus === null || want.memoryGi === null) {
      if (want.cpus !== null || want.memoryGi !== null)
        return refuse(
          "Give the rig both its CPUs and its memory, or neither: null for both gives it the namespace's defaults.",
        );
      resources = undefined;
    } else {
      const cpus = want.cpus ?? s.resources?.cpus;
      const memoryGi = want.memoryGi ?? s.resources?.memoryGi;
      if (cpus === undefined || memoryGi === undefined)
        return refuse(
          `Give ${r.rig} both its CPUs and its memory: it has the namespace's defaults now.`,
        );
      if (!Number.isFinite(cpus) || !Number.isFinite(memoryGi))
        return refuse("CPUs and memory are numbers, such as 16 and 52, or 1.5 and 6.");
      try {
        rigResources({ cpus, memoryGi });
      } catch (err) {
        return refuse(errorText(err));
      }
      resources = { cpus, memoryGi };
      if (!sameResources(resources, s.resources)) {
        const why = quotaRefusal(r.namespace, o.quota, { resources });
        if (why) return refuse(why);
      }
    }
  }
  const size: ClusterRigSize = { gpus: n, judgeGpus: judge, resources };
  if (
    n === s.gpus &&
    (judge ?? null) === (s.judgeGpus ?? null) &&
    sameResources(resources, s.resources)
  )
    return { same: true };
  return { size };
}

/** The request's fields over REST and MCP (MCP adds the rig): types only; values are checked above. */
export const clusterResourcesFields = {
  gpus: z
    .number()
    .int()
    .optional()
    .describe(
      `How many GPUs the rig's harness pod asks for, 1 to ${MAX_RIG_GPUS}, through the rig's own way (NVIDIA's device plugin or its DRA device class). A rig on the CPU can't take GPUs, nor a GPU rig go to none`,
    ),
  judge_gpus: z
    .number()
    .int()
    .optional()
    .describe(
      "With a new number of GPUs: how many are the judge's, 1 to min(8, gpus - 1), the rest the agents' (at most 8). Left out: half, rounded up. The owner's token only",
    ),
  cpus: z
    .number()
    .nullable()
    .optional()
    .describe(
      "The rig's CPUs, at least 1.5: the supervisor gets half a CPU, the harness the rest. null, with memory_gib null: the namespace's defaults",
    ),
  memory_gib: z
    .number()
    .nullable()
    .optional()
    .describe(
      "The rig's memory in GiB, at least 6: the supervisor gets 2 GiB, the harness the rest. null, with cpus null: the namespace's defaults",
    ),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Wait for the running trials and the judge's job to finish before the restart (default true); false: restart now",
    ),
};

export const ClusterResourcesBody = z.strictObject(clusterResourcesFields);
export type ClusterResourcesBody = z.infer<typeof ClusterResourcesBody>;

/** A REST or MCP body as the action takes it. */
export const clusterResourcesRequest = (b: ClusterResourcesBody): ClusterResourcesRequest => ({
  gpus: b.gpus,
  judgeGpus: b.judge_gpus,
  cpus: b.cpus,
  memoryGi: b.memory_gib,
});
