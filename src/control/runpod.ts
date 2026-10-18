/**
 * RunPod as a place for rigs (Settings › Providers), read-only for now: control seals the
 * owner's API key and reads, with RunPod's REST API v2, the GPU types with their prices and
 * stock, the data centers, the network volumes and the account's pods. It starts nothing and
 * spends nothing; launching a rig on RunPod is a separate, owner-only step that comes after the
 * spike (plan: NEXT-WORK, RunPod).
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

/** Reads the account. Throws, in words, when RunPod refuses the key or can't be reached. */
export async function readRunpod(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunpodFacts> {
  const get = async (path: string): Promise<Json> => {
    let r: Response;
    try {
      r = await fetchImpl(`${RUNPOD_API}${path}`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(
        `control could not reach RunPod: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (r.status === 401 || r.status === 403) throw new Error("RunPod refused the key");
    if (!r.ok) throw new Error(`RunPod answered ${r.status} for ${path.split("?")[0]}`);
    return (await r.json()) as Json;
  };
  // The pods first: it needs the key, so a wrong key fails here, in words.
  const pods = await get("/v2/pods");
  const gpus = await get("/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE");
  const dcs = await get("/v2/catalog/datacenters");
  const vols = await get("/v2/network-volumes");
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
