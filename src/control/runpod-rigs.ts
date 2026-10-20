import { log, redact } from "../common/env.ts";
import { POD_CONFIG_ENV, PodConfig } from "../core/tunnel.ts";
import { createPod, getPod, podAction, readRunpod, terminatePod } from "./runpod.ts";
import {
  idleSince,
  type RigState,
  type RunpodRigView,
  runpodRigView,
  spentBy,
} from "./runpod-rig-view.ts";
import type { SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store.ts";
import type { ControlTunnels } from "./tunnel.ts";
import { rigView } from "./views.ts";

/**
 * Rigs on RunPod, launched by the owner alone (REST, MCP or the command line; goal 022). A launch
 * mints the rig and its one-time code for pull mode (ControlTunnels.mint), starts a pod of the
 * one-container rig image with those values in its environment and the pull mode port exposed,
 * and names the pod (attach); control's loop then enrolls it and exchanges with it.
 *
 * Control follows each pod (`advance`, every 30 s): its status, its price and what it has cost
 * so far. It stops the pod only when the owner set a spend limit or an idle stop and the pod
 * reached it. Nothing else stops it: no limit is set for the owner.
 */

/** The one-container image is CUDA 12.6; RunPod places the pod only on hosts whose driver runs it. */
const MIN_CUDA = "12.6";
/** The pod's volume, where the rig keeps its state (containers/rig/Containerfile). */
const VOLUME_PATH = "/workspace";
export const DEFAULT_CONTAINER_DISK_GB = 40;
export const DEFAULT_VOLUME_GB = 100;
/** The shortest idle stop: a rig needs a few minutes between enrollment and its first run. */
export const MIN_IDLE_STOP_MINUTES = 5;

/** What the owner asks for. Only the GPU type has no default. */
export interface LaunchRequest {
  /** A GPU type's id or name, from RunPod's list. */
  gpu: string;
  gpu_count?: number | undefined;
  /** SECURE, on demand: the owner's decision of 2026-10-20 ("Community and spot come later"). */
  cloud_type?: "SECURE" | "COMMUNITY" | undefined;
  /** A data center's id; not given: RunPod chooses. */
  datacenter?: string | undefined;
  /** Default: control's THERMITE_RUNPOD_RIG_IMAGE. */
  image?: string | undefined;
  container_disk_gb?: number | undefined;
  volume_gb?: number | undefined;
  /** The rig's name; not given: control makes one (rp- and 8 hexadecimal characters). */
  rig?: string | undefined;
  /** The enrollment code expires this long after the launch; not given: it does not. */
  enroll_within_minutes?: number | undefined;
  /** The rig's settings at enrollment, over the launch's own (its target and GPUs). */
  settings?: Partial<Record<(typeof POD_CONFIG_ENV)[number], string>> | undefined;
  spend_limit_usd?: number | undefined;
  idle_stop_minutes?: number | undefined;
}

/** A change to a rig's limits: a number sets one, null clears it, nothing keeps it. */
export interface LimitsChange {
  spend_limit_usd?: number | null | undefined;
  idle_stop_minutes?: number | null | undefined;
}

function checkLimits(l: LimitsChange): void {
  if (
    l.spend_limit_usd !== undefined &&
    l.spend_limit_usd !== null &&
    !(Number.isFinite(l.spend_limit_usd) && l.spend_limit_usd > 0)
  )
    throw new Error("a spend limit is a number of US dollars above 0");
  if (
    l.idle_stop_minutes !== undefined &&
    l.idle_stop_minutes !== null &&
    !(Number.isFinite(l.idle_stop_minutes) && l.idle_stop_minutes >= MIN_IDLE_STOP_MINUTES)
  )
    throw new Error(`an idle stop is ${MIN_IDLE_STOP_MINUTES} minutes or more`);
}

const wholeIn = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
const money = (usd: number) => `$${usd.toFixed(2)}`;

export class RunpodRigs {
  private readonly store: ControlStore;
  private readonly secrets: SecretBox;
  private readonly tunnels: ControlTunnels;
  private readonly fetchImpl: typeof fetch;
  private readonly image: string | undefined;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private busy = false;

  constructor(
    store: ControlStore,
    secrets: SecretBox,
    tunnels: ControlTunnels,
    opts: {
      fetch?: typeof fetch | undefined;
      image?: string | undefined;
      now?: (() => number) | undefined;
      staleAfterMs?: number | undefined;
    } = {},
  ) {
    this.store = store;
    this.secrets = secrets;
    this.tunnels = tunnels;
    this.fetchImpl = opts.fetch ?? fetch;
    this.image = opts.image;
    this.now = opts.now ?? Date.now;
    this.staleAfterMs = opts.staleAfterMs ?? 180_000;
  }

  /** The image a launch uses when none is given (control's THERMITE_RUNPOD_RIG_IMAGE). */
  defaultImage(): string | undefined {
    return this.image;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private key(cloud: string): string | undefined {
    const g = this.store.gpuCloud(cloud);
    return g ? this.secrets.open(g.key_sealed) : undefined;
  }

  /**
   * Launches a rig: a pod of the one-container rig image, in pull mode. Billed from now. Throws,
   * in words, when it can't; a launch that fails leaves no pod and no rig behind.
   */
  async launch(cloud: string, req: LaunchRequest, by: string): Promise<RunpodRigView> {
    const key = this.key(cloud);
    if (!key) throw new Error(`no GPU cloud "${cloud}"`);
    const gpuName = (req.gpu ?? "").trim();
    if (!gpuName) throw new Error("name a GPU type: its id or name in RunPod's list");
    const count = req.gpu_count ?? 1;
    if (!wholeIn(count, 1, 8)) throw new Error("a pod has 1 to 8 GPUs");
    const cloudType = req.cloud_type ?? "SECURE";
    if (cloudType !== "SECURE")
      throw new Error(
        "Community cloud comes in a later version: rigs launch on Secure cloud, on demand",
      );
    const disk = req.container_disk_gb ?? DEFAULT_CONTAINER_DISK_GB;
    if (!wholeIn(disk, 10, 2000)) throw new Error("the container's disk is 10 to 2000 GB");
    const volume = req.volume_gb ?? DEFAULT_VOLUME_GB;
    if (!wholeIn(volume, 10, 10_000)) throw new Error("the volume is 10 to 10000 GB");
    const ttl = req.enroll_within_minutes;
    if (ttl !== undefined && !(Number.isFinite(ttl) && ttl > 0))
      throw new Error("the time to enroll is a number of minutes above 0");
    checkLimits(req);
    const image = (req.image ?? this.image ?? "").trim();
    if (!image)
      throw new Error(
        "no image: give one, or set THERMITE_RUNPOD_RIG_IMAGE on control (the one-container rig image, at a registry RunPod can pull from)",
      );
    // The rig's settings: a GPU rig on all the pod's cards, unless the owner says otherwise.
    const settings = PodConfig.safeParse({
      env: {
        THERMITE_TARGET: "cuda-gpu",
        THERMITE_GPUS: Array.from({ length: count }, (_, i) => i).join(","),
        ...(req.settings ?? {}),
      },
    });
    if (!settings.success)
      throw new Error(
        `the rig's settings take only ${POD_CONFIG_ENV.join(", ")}, with values of letters, digits and . _ , : -`,
      );
    // A fresh read: prices and stock change.
    const facts = await readRunpod(key, this.fetchImpl);
    this.store.setGpuCloudFacts(cloud, { facts });
    const gpu = facts.gpus.find((g) => g.id === gpuName || g.name === gpuName);
    if (!gpu) throw new Error(`RunPod lists no GPU type "${gpuName}"`);
    if (cloudType === "SECURE" ? !gpu.secure : !gpu.community)
      throw new Error(
        `${gpu.name} is not offered on ${cloudType === "SECURE" ? "Secure" : "Community"} cloud`,
      );
    if (
      req.datacenter &&
      facts.datacenters.length &&
      !facts.datacenters.some((d) => d.id === req.datacenter)
    )
      throw new Error(`RunPod lists no data center "${req.datacenter}"`);
    const listPrice = cloudType === "SECURE" ? gpu.price_secure : gpu.price_community;
    const minted = this.tunnels.mint({
      by,
      rig: req.rig,
      codeTtlMs: ttl === undefined ? undefined : ttl * 60_000,
      config: settings.data.env,
    });
    let pod: Awaited<ReturnType<typeof createPod>>;
    try {
      pod = await createPod(
        key,
        {
          name: `thermite-${minted.rig}`,
          image,
          gpu: gpu.id,
          gpuCount: count,
          cloud: cloudType,
          diskGb: disk,
          minCudaVersion: MIN_CUDA,
          datacenter: req.datacenter,
          volumeGb: volume,
          volumeMountPath: VOLUME_PATH,
          ports: [`${minted.port}/http`],
          env: { ...minted.env },
        },
        this.fetchImpl,
      );
    } catch (err) {
      // No pod: nothing can use the rig's code.
      this.store.dropTunnelRig(minted.rig, by);
      throw err;
    }
    try {
      this.tunnels.attach(minted.rig, pod.id);
    } catch (err) {
      // RunPod's answer can't be used: the pod goes, so it costs nothing more.
      await terminatePod(key, pod.id, this.fetchImpl).catch((e) =>
        log("control", "could not remove a pod after a failed launch", {
          pod: pod.id,
          error: redact(e instanceof Error ? e.message : String(e)),
        }),
      );
      this.store.dropTunnelRig(minted.rig, by);
      throw err;
    }
    const now = this.iso();
    const state: RigState = {
      image,
      gpu: gpu.id,
      gpu_name: gpu.name,
      gpu_count: count,
      cloud_type: cloudType,
      datacenter: pod.datacenter || req.datacenter || null,
      container_disk_gb: disk,
      volume_gb: volume,
      price_per_hr: pod.cost_per_hr || (listPrice === null ? null : listPrice * count),
      status: pod.status || "PROVISIONING",
      status_at: now,
      launched_at: now,
      spent_usd: 0,
      billed_since: now,
      running_since: now,
      spend_limit_usd: req.spend_limit_usd ?? null,
      idle_stop_minutes: req.idle_stop_minutes ?? null,
      idle_from: req.idle_stop_minutes === undefined ? null : now,
      busy_at: null,
      stopped_at: null,
      stopped_by: null,
      ended_at: null,
      error: null,
      notes: [],
    };
    this.store.addRunpodRig({ rig: minted.rig, cloud, pod: pod.id, state, by });
    this.store.audit(by, "runpod_rig_launched", {
      rig: minted.rig,
      cloud,
      pod: pod.id,
      gpu: gpu.name,
      gpu_count: count,
      cloud_type: cloudType,
      datacenter: state.datacenter,
      price_per_hr: state.price_per_hr,
      image,
      spend_limit_usd: state.spend_limit_usd,
      idle_stop_minutes: state.idle_stop_minutes,
    });
    return this.view(minted.rig) as RunpodRigView;
  }

  /** Sets or clears a rig's spend limit and idle stop. The owner's alone. */
  limits(rig: string, change: LimitsChange, by: string): RunpodRigView {
    const r = this.store.runpodRig(rig);
    if (!r) throw new Error(`no rig ${rig} on a GPU cloud`);
    checkLimits(change);
    const s = r.state as RigState;
    if (change.spend_limit_usd !== undefined) s.spend_limit_usd = change.spend_limit_usd;
    if (change.idle_stop_minutes !== undefined) {
      // Idle time counts from when the stop is set, never from before.
      if (change.idle_stop_minutes !== null && s.idle_stop_minutes === null)
        s.idle_from = this.iso();
      s.idle_stop_minutes = change.idle_stop_minutes;
    }
    this.store.saveRunpodRig(rig, s, r.active);
    this.store.audit(by, "runpod_rig_limits", {
      rig,
      spend_limit_usd: s.spend_limit_usd,
      idle_stop_minutes: s.idle_stop_minutes,
    });
    return this.view(rig) as RunpodRigView;
  }

  /** One step for every rig control follows. Control calls it every 30 s. */
  async advance(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const r of this.store.runpodRigs({ active: true })) await this.step(r.rig);
    } finally {
      this.busy = false;
    }
  }

  /** A run is running on the rig, as its signed reports say. */
  private working(rig: string): boolean {
    const v = rigView(this.store, rig, { staleAfterMs: this.staleAfterMs, now: this.now() });
    return Boolean(v?.runs.some((x) => x.status === "running"));
  }

  private async step(rig: string): Promise<void> {
    const r = this.store.runpodRig(rig);
    if (!r?.active) return;
    const s = r.state as RigState;
    const key = this.key(r.cloud);
    if (!key) {
      s.error = `the GPU cloud "${r.cloud}" was deleted, so control can't follow pod ${r.pod}: see RunPod's console`;
      this.store.saveRunpodRig(rig, s, r.active);
      return;
    }
    const nowMs = this.now();
    const now = this.iso();
    // What it cost up to now, at the price it ran at.
    s.spent_usd = spentBy(s, nowMs);
    if (s.billed_since) s.billed_since = now;
    let active = true;
    try {
      const pod = await getPod(key, r.pod, this.fetchImpl);
      s.status_at = now;
      if (!pod) {
        s.status = "TERMINATED";
        s.ended_at = now;
        s.billed_since = null;
        s.running_since = null;
        s.notes.push("RunPod no longer has the pod.");
        active = false;
      } else {
        s.status = pod.status;
        if (pod.cost_per_hr > 0) s.price_per_hr = pod.cost_per_hr;
        if (pod.datacenter) s.datacenter = pod.datacenter;
        const running = pod.status !== "EXITED" && pod.status !== "TERMINATED";
        s.billed_since = running ? now : null;
        s.running_since = running ? (s.running_since ?? now) : null;
        s.error = null;
        if (running) await this.limit(r.rig, r.pod, key, s, nowMs);
      }
    } catch (err) {
      s.error = redact(err instanceof Error ? err.message : String(err));
      log("control", "runpod rig step failed", { rig, error: s.error });
    }
    this.store.saveRunpodRig(rig, s, active);
  }

  /** The owner's limits, if set: a pod that reached one is stopped. */
  private async limit(
    rig: string,
    pod: string,
    key: string,
    s: RigState,
    nowMs: number,
  ): Promise<void> {
    const enrolledAt = this.store.tunnelRig(rig)?.enrolled_at ?? null;
    if (s.idle_stop_minutes !== null && enrolledAt && this.working(rig))
      s.busy_at = new Date(nowMs).toISOString();
    const spent = spentBy(s, nowMs);
    let why: { by: "spend_limit" | "idle_stop"; words: string } | undefined;
    if (s.spend_limit_usd !== null && spent >= s.spend_limit_usd)
      why = {
        by: "spend_limit",
        words: `it had cost ${money(spent)}, which reached the spend limit you set (${money(s.spend_limit_usd)})`,
      };
    else {
      const since = idleSince(s, enrolledAt);
      if (
        s.idle_stop_minutes !== null &&
        since &&
        nowMs - Date.parse(since) >= s.idle_stop_minutes * 60_000
      )
        why = {
          by: "idle_stop",
          words: `no run ran on it for ${s.idle_stop_minutes} minutes, the idle stop you set`,
        };
    }
    if (!why) return;
    await podAction(key, pod, "stop", this.fetchImpl);
    const at = new Date(nowMs).toISOString();
    s.spent_usd = spent;
    s.billed_since = null;
    s.running_since = null;
    s.stopped_at = at;
    s.stopped_by = why.by;
    s.status = "EXITED";
    s.notes.push(`Stopped by control: ${why.words}. Its volume stays.`);
    this.store.audit("control", "runpod_rig_stopped", {
      rig,
      pod,
      why: why.by,
      spend_usd: Math.round(spent * 100) / 100,
    });
  }

  view(rig: string): RunpodRigView | undefined {
    const r = this.store.runpodRig(rig);
    return r ? runpodRigView(r, this.store.tunnelRig(rig), this.now()) : undefined;
  }

  list(cloud?: string): RunpodRigView[] {
    return this.store
      .runpodRigs({ cloud })
      .map((r) => runpodRigView(r, this.store.tunnelRig(r.rig), this.now()));
  }
}
