/**
 * RunPod for tests and acceptance runs: the calls control makes to RunPod's REST API v2
 * (src/control/runpod.ts) and RunPod's HTTP proxy, behind a fake fetch. Never the real RunPod: a
 * request to any other host throws, so nothing leaves the test, and no key but the fake's works.
 *
 * Pods move as RunPod's do, one step per read of the pod: a new pod is PROVISIONING and a started
 * one STARTING until control reads it, then RUNNING; a stopped pod is EXITED with no GPU; a
 * terminated pod is gone. A running pod costs its GPU's price times its GPUs an hour.
 *
 * Hooks put something real behind a pod: the RunPod acceptance (scripts/runpod-acceptance.mjs)
 * starts a container of the rig image for each pod and points the pod's proxy address at it.
 */

export const FAKE_RUNPOD_KEY = "rpa_test-key-0123456789abcdef";

/** A GPU type as RunPod's catalog lists it. */
export interface FakeGpu {
  id: string;
  name: string;
  memory: number;
  secure: boolean;
  community?: boolean;
  price: { secure?: number | null; community?: number | null };
  availability?: string;
}

export const FAKE_GPUS: FakeGpu[] = [
  {
    id: "NVIDIA H100 80GB HBM3",
    name: "H100 SXM",
    memory: 80,
    secure: true,
    price: { secure: 2.69 },
    availability: "LOW",
  },
  {
    id: "NVIDIA RTX A4000",
    name: "RTX A4000",
    memory: 16,
    secure: true,
    community: true,
    price: { secure: 0.25, community: 0.17 },
    availability: "HIGH",
  },
];

/** What RunPod answers when it has no GPU free for a stopped pod's start (made up, in its style). */
export const NO_FREE_GPU = "There are not enough free GPUs on the host machine to start this pod.";

export interface FakePod {
  id: string;
  status: "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED";
  gpu: string;
  /** The GPUs it was made with, and those it has now (none while stopped). */
  count: number;
  gpus: number;
  cloud: "SECURE" | "COMMUNITY";
  datacenter: string;
  /** The body control made it with: image, ports, env, disk, volume. */
  body: Record<string, unknown>;
  env: Record<string, string>;
  /** Where its proxy addresses lead (a hook sets it); none: the test's `proxy`, or a 404. */
  upstream?: string | undefined;
}

export interface FakeRunpodOptions {
  /** The API key RunPod takes (default FAKE_RUNPOD_KEY). */
  key?: string | undefined;
  gpus?: FakeGpu[] | undefined;
  /** RunPod refuses every new pod: no capacity. */
  noCapacity?: boolean | undefined;
  /** RunPod has no GPU free to start a stopped pod (also settable later on the fake). */
  noGpuOnStart?: boolean | undefined;
  /** RunPod can't be reached at all. */
  down?: boolean | undefined;
  /** The key may not read billing. */
  noBilling?: boolean | undefined;
  /** Before RunPod answers: a pod made, started, stopped or terminated. A throw fails the call. */
  onCreate?: ((pod: FakePod) => void | Promise<void>) | undefined;
  onStart?: ((pod: FakePod) => void | Promise<void>) | undefined;
  onStop?: ((pod: FakePod) => void | Promise<void>) | undefined;
  onTerminate?: ((pod: FakePod) => void | Promise<void>) | undefined;
  /** A request to a running pod's proxy address with no upstream: the test answers it. */
  proxy?:
    | ((pod: FakePod, url: URL, init?: RequestInit) => Response | Promise<Response>)
    | undefined;
}

export interface FakeRunpod {
  /** Use as control's fetch for RunPod (cloudFetch) and for pull mode (the tunnels' fetch). */
  fetch: typeof fetch;
  calls: { method: string; host: string; path: string; body?: unknown }[];
  pods: Map<string, FakePod>;
  /** The bodies of every stop or start control asked for, in order. */
  actions(): { action: string }[];
  /** The stops only, as `{action: "stop"}`. */
  stops(): { action: string }[];
  /** The pods control removed. */
  terminated(): string[];
  /** RunPod has (or again has) no GPU free to start a stopped pod. */
  setNoGpuOnStart(on: boolean): void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeRunpod(o: FakeRunpodOptions = {}): FakeRunpod {
  const key = o.key ?? FAKE_RUNPOD_KEY;
  const gpus = o.gpus ?? FAKE_GPUS;
  const pods = new Map<string, FakePod>();
  const calls: FakeRunpod["calls"] = [];
  const gone: string[] = [];
  let noGpuOnStart = o.noGpuOnStart ?? false;
  let n = 0;
  const perGpu = (p: FakePod) => {
    const g = gpus.find((x) => x.id === p.gpu);
    return (p.cloud === "COMMUNITY" ? g?.price.community : g?.price.secure) ?? 0;
  };
  const podJson = (p: FakePod) => ({
    id: p.id,
    status: p.status,
    cost: p.status === "RUNNING" ? perGpu(p) * p.gpus : 0,
    gpu: { id: p.gpu, count: p.gpus },
    dataCenterId: p.datacenter,
  });

  const viaProxy = async (url: URL, init?: RequestInit): Promise<Response> => {
    const [podId] = url.host.split("-");
    const p = pods.get(podId ?? "");
    // RunPod's proxy answers 502 while nothing serves the pod's port.
    if (p?.status !== "RUNNING") return new Response("", { status: 502 });
    if (p.upstream) {
      try {
        return await fetch(`${p.upstream}${url.pathname}${url.search}`, init);
      } catch {
        return new Response("", { status: 502 });
      }
    }
    return o.proxy ? o.proxy(p, url, init) : new Response("", { status: 404 });
  };

  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const isProxy = url.host.endsWith(".proxy.runpod.net");
    let body: unknown;
    if (!isProxy && typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ method, host: url.host, path: url.pathname, ...(body ? { body } : {}) });
    if (isProxy) return viaProxy(url, init);
    if (url.host !== "api.runpod.io")
      throw new Error(`the fake RunPod answers only RunPod's API and proxy, not ${url.host}`);
    if (o.down) throw new Error("getaddrinfo ENOTFOUND api.runpod.io");
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${key}`)
      return json({ title: "Unauthorized" }, 401);
    const path = url.pathname;
    if (path === "/v2/catalog/gpus") return json({ gpus });
    if (path === "/v2/catalog/datacenters")
      return json({ dataCenters: [{ id: "EU-RO-1", name: "Romania", region: "Europe" }] });
    if (path === "/v2/network-volumes")
      return json({
        networkVolumes: [{ id: "v1", name: "kits", size: 50, dataCenter: "EU-RO-1" }],
      });
    if (path === "/v2/billing") {
      if (o.noBilling) return json({ title: "Forbidden" }, 403);
      return json({ records: [], metadata: { totals: { totalAmount: 0 } } });
    }
    if (path === "/v2/pods" && method === "GET")
      return json({ pods: [...pods.values()].map(podJson) });
    if (path === "/v2/pods" && method === "POST") {
      const b = body as {
        gpu: { id: string; count: number };
        cloud: "SECURE" | "COMMUNITY";
        dataCenterId?: string;
        env?: Record<string, string>;
      };
      if (o.noCapacity)
        return json({ title: "Bad Request", detail: "no capacity for that GPU" }, 400);
      const p: FakePod = {
        id: `pod${++n}`,
        status: "PROVISIONING",
        gpu: b.gpu.id,
        count: b.gpu.count,
        gpus: b.gpu.count,
        cloud: b.cloud,
        datacenter: b.dataCenterId ?? "EU-RO-1",
        body: body as Record<string, unknown>,
        env: b.env ?? {},
      };
      await o.onCreate?.(p);
      pods.set(p.id, p);
      return json(podJson(p), 201);
    }
    const m = /^\/v2\/pods\/([^/]+)(\/action)?$/.exec(path);
    const p = m ? pods.get(m[1] ?? "") : undefined;
    if (!m || !p) return json({ title: "Not Found" }, 404);
    if (method === "DELETE") {
      await o.onTerminate?.(p);
      pods.delete(p.id);
      gone.push(p.id);
      return new Response(null, { status: 204 });
    }
    if (m[2]) {
      const action = (body as { action?: string } | undefined)?.action;
      if (action === "stop") {
        if (p.status === "EXITED")
          return json({ title: "Conflict", detail: "already stopped" }, 409);
        await o.onStop?.(p);
        p.status = "EXITED";
        p.gpus = 0;
      } else if (action === "start") {
        if (p.status !== "EXITED") return json({ title: "Conflict", detail: "not stopped" }, 409);
        if (noGpuOnStart) return json({ title: "Bad Request", detail: NO_FREE_GPU }, 400);
        await o.onStart?.(p);
        p.status = "STARTING";
        p.gpus = p.count;
      } else return json({ title: "Bad Request", detail: `no action ${action}` }, 400);
      return json(podJson(p));
    }
    // Each read moves a pod that is being made or started on, as RunPod does in its own time.
    if (p.status === "PROVISIONING" || p.status === "STARTING") p.status = "RUNNING";
    return json(podJson(p));
  }) as typeof fetch;

  const actions = () =>
    calls
      .filter((c) => c.method === "POST" && c.path.endsWith("/action"))
      .map((c) => c.body as { action: string });
  return {
    fetch: f,
    calls,
    pods,
    actions,
    stops: () => actions().filter((a) => a.action === "stop"),
    terminated: () => [...gone],
    setNoGpuOnStart: (on) => {
      noGpuOnStart = on;
    },
  };
}
