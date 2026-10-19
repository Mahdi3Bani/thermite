/**
 * RunPod as a place for rigs (Settings › Providers): control seals the owner's API key and reads,
 * with RunPod's REST API v2, the GPU types with their prices and stock, the data centers, the
 * network volumes and the account's pods. Reading spends nothing. The only thing control starts
 * is a test pod, when the owner or an operator asks for one (runpod-tests.ts).
 */

export const RUNPOD_API = "https://api.runpod.io";

export interface RunpodGpu {
  id: string;
  name: string;
  memory_gb: number;
  secure: boolean;
  community: boolean;
  /** USD per GPU per hour, list price. */
  price_secure: number | null;
  price_community: number | null;
  /** Stock for pods on Secure cloud: NONE, LOW, MEDIUM, HIGH. */
  availability?: string | undefined;
}

export interface RunpodFacts {
  gpus: RunpodGpu[];
  datacenters: { id: string; name: string; region: string }[];
  volumes: { id: string; name: string; size_gb: number; datacenter: string }[];
  pods: { id: string; name: string; status: string; cost_per_hr: number; gpus: number }[];
}

type Json = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** RunPod refused a call with this status (400: no capacity or a broken rule; 409: wrong state). */
export class RunpodRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One call to RunPod's REST API v2; null for a 204 or a 404. Throws, in words, otherwise. */
async function runpodCall(
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Json | null> {
  let r: Response;
  try {
    r = await fetchImpl(`${RUNPOD_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `control could not reach RunPod: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (r.status === 401 || r.status === 403)
    throw new Error(
      method === "GET"
        ? "RunPod refused the key"
        : "RunPod refused the key for this: a read-only key can't start or stop pods",
    );
  if (r.status === 204 || (r.status === 404 && method !== "POST")) return null;
  if (!r.ok) {
    // RunPod's errors are problem+json: a title and a detail, in words.
    let why = "";
    try {
      const p = (await r.json()) as Json;
      why = [str(p.title), str(p.detail)].filter(Boolean).join(": ");
    } catch {}
    throw new RunpodRefused(
      r.status,
      `RunPod answered ${r.status} for ${method} ${path.split("?")[0]}${why ? ` (${why.slice(0, 300)})` : ""}`,
    );
  }
  return (await r.json()) as Json;
}

/** A pod as control follows it. */
export interface RunpodPod {
  id: string;
  status: string;
  /** USD per hour while it runs; 0 when stopped or gone. */
  cost_per_hr: number;
  gpu: string;
  gpus: number;
  datacenter: string;
}

const podOf = (p: Json): RunpodPod => ({
  id: str(p.id),
  status: str(p.status),
  cost_per_hr: num(p.cost) ?? 0,
  gpu: str((p.gpu as Json | undefined)?.id),
  gpus: num((p.gpu as Json | undefined)?.count) ?? 0,
  datacenter: str(p.dataCenterId),
});

/** What a pod is started with (RunPod's create-a-pod body, v2). */
export interface RunpodPodSpec {
  name: string;
  image: string;
  gpu: string;
  gpuCount: number;
  cloud: "SECURE" | "COMMUNITY";
  diskGb: number;
  minCudaVersion?: string | undefined;
  ports: string[];
  env: Record<string, string>;
  cmd: string[];
}

/** Starts a pod (it is billed from now). */
export async function createPod(
  key: string,
  spec: RunpodPodSpec,
  fetchImpl: typeof fetch = fetch,
): Promise<RunpodPod> {
  const body = {
    name: spec.name,
    image: spec.image,
    gpu: {
      id: spec.gpu,
      count: spec.gpuCount,
      ...(spec.minCudaVersion ? { minCudaVersion: spec.minCudaVersion } : {}),
    },
    cloud: spec.cloud,
    disk: spec.diskGb,
    ports: spec.ports,
    env: spec.env,
    cmd: spec.cmd,
  };
  const r = await runpodCall(key, "POST", "/v2/pods", body, fetchImpl);
  if (!r) throw new Error("RunPod answered without the new pod");
  return podOf(r);
}

/** A pod now, or null when RunPod no longer has it. */
export async function getPod(
  key: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunpodPod | null> {
  const r = await runpodCall(
    key,
    "GET",
    `/v2/pods/${encodeURIComponent(id)}`,
    undefined,
    fetchImpl,
  );
  return r ? podOf(r) : null;
}

/** Stops a running pod (its disk stays) or starts a stopped one. */
export async function podAction(
  key: string,
  id: string,
  action: "stop" | "start",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await runpodCall(key, "POST", `/v2/pods/${encodeURIComponent(id)}/action`, { action }, fetchImpl);
}

/** Removes a pod for good; nothing more is billed. A pod already gone is fine. */
export async function terminatePod(
  key: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await runpodCall(key, "DELETE", `/v2/pods/${encodeURIComponent(id)}`, undefined, fetchImpl);
}

/** Where RunPod's HTTP proxy serves a pod's port (public: what it serves must need a secret path). */
export const podPortUrl = (podId: string, port: number) =>
  `https://${podId}-${port}.proxy.runpod.net`;

/** Reads the account. Throws, in words, when RunPod refuses the key or can't be reached. */
export async function readRunpod(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunpodFacts> {
  const get = (path: string) => runpodCall(key, "GET", path, undefined, fetchImpl);
  // The pods first: it needs the key, so a wrong key fails here, in words.
  const pods = (await get("/v2/pods")) ?? {};
  const gpus = (await get("/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE")) ?? {};
  const dcs = (await get("/v2/catalog/datacenters")) ?? {};
  const vols = (await get("/v2/network-volumes")) ?? {};
  return {
    gpus: ((gpus.gpus as Json[]) ?? [])
      .map((g) => {
        const price = (g.price ?? {}) as Json;
        return {
          id: str(g.id),
          name: str(g.name) || str(g.id),
          memory_gb: num(g.memory) ?? 0,
          secure: g.secure === true,
          community: g.community === true,
          price_secure: num(price.secure),
          price_community: num(price.community),
          availability: str(g.availability) || undefined,
        };
      })
      .sort((a, b) => (a.price_secure ?? 1e9) - (b.price_secure ?? 1e9)),
    datacenters: ((dcs.dataCenters as Json[]) ?? []).map((d) => ({
      id: str(d.id),
      name: str(d.name),
      region: typeof d.region === "string" ? d.region : str((d.region as Json | undefined)?.name),
    })),
    volumes: ((vols.networkVolumes as Json[]) ?? []).map((v) => ({
      id: str(v.id),
      name: str(v.name),
      size_gb: num(v.size) ?? 0,
      datacenter: str(v.dataCenter),
    })),
    pods: ((pods.pods as Json[]) ?? []).map((p) => ({
      id: str(p.id),
      name: str(p.name),
      status: str(p.status),
      cost_per_hr: num(p.cost) ?? 0,
      gpus: num((p.gpu as Json | undefined)?.count) ?? 0,
    })),
  };
}

/** A short line about the account, for the Providers list. */
export function runpodLine(f: RunpodFacts): string {
  const cheapest = f.gpus.find((g) => g.secure && g.price_secure !== null);
  const running = f.pods.filter((p) => p.cost_per_hr > 0);
  const spend = running.reduce((t, p) => t + p.cost_per_hr, 0);
  return [
    `${f.gpus.length} GPU types`,
    cheapest ? `from $${cheapest.price_secure?.toFixed(2)}/h (${cheapest.name}, Secure)` : "",
    `${f.datacenters.length} data centers`,
    running.length
      ? `${running.length} pod${running.length === 1 ? "" : "s"} running, $${spend.toFixed(2)}/h`
      : "no pod running",
  ]
    .filter(Boolean)
    .join(" · ");
}
