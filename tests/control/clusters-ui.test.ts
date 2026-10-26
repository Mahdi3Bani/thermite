import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createControlApi } from "../../src/control/api.ts";
import type { ClusterKubectl } from "../../src/control/clusters/kubectl.ts";
import { PRIVATE_RANGES } from "../../src/control/clusters/netcheck.ts";
import { SecretBox } from "../../src/control/secrets.ts";
import { ControlStore } from "../../src/control/store.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";

const ADMIN = "admin-token-abcdef";
const OPERATOR = "operator-token-abcdef";
const KUBECONFIG =
  "apiVersion: v1\nkind: Config\nusers: [{ name: u, user: { token: secret-kube-token-789 } }]\n";

/** A cluster behind a fake kubectl: what it answers, and every call it got. */
function fakeCluster(
  o: {
    canCreateNamespaces?: boolean;
    slots?: Record<string, boolean>;
    /** Slots whose operators wrote the network rule (default: thermite-slot-1). */
    ruled?: string[];
    quota?: Record<string, Record<string, string>>;
    /** The node's GPUs through the device plugin (default 2). */
    nodeGpus?: number;
    /** DRA device classes (default: the cluster has no DRA). */
    deviceClasses?: string[];
  } = {},
) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const k: ClusterKubectl = {
    contextsOf: async (config) => {
      if (!config.includes("kind: Config"))
        throw new Error("that is not a kubeconfig kubectl can read");
      return { contexts: ["kind-thermite", "other"], current: "kind-thermite" };
    },
    kubectl: async (_t, args, stdin) => {
      calls.push({ args, stdin });
      const a = args.join(" ");
      if (a === "config view --raw -o json")
        return ok(
          JSON.stringify(
            _t.kubeconfig.includes("exec:")
              ? {
                  clusters: [{ name: "c", cluster: { "certificate-authority": "/etc/ca.crt" } }],
                  users: [{ name: "u", user: { exec: { command: "sh" } } }],
                }
              : {
                  clusters: [{ name: "c", cluster: { server: "https://k.example.com" } }],
                  users: [{ name: "u", user: { token: "x" } }],
                },
          ),
        );
      if (a === "version -o json")
        return ok(JSON.stringify({ serverVersion: { gitVersion: "v1.35.2" } }));
      if (a === "get nodes -o json")
        return ok(
          JSON.stringify({
            items: [
              {
                metadata: { name: "gpu-node-1" },
                status: {
                  allocatable: {
                    cpu: "16",
                    memory: "64Gi",
                    "nvidia.com/gpu": String(o.nodeGpus ?? 2),
                  },
                  conditions: [{ type: "Ready", status: "True" }],
                },
              },
            ],
          }),
        );
      if (a === "get deviceclasses -o json")
        return o.deviceClasses
          ? ok(JSON.stringify({ items: o.deviceClasses.map((name) => ({ metadata: { name } })) }))
          : {
              code: 1,
              stdout: "",
              stderr: 'error: the server doesn\'t have a resource type "deviceclasses"',
            };
      if (a === "get storageclass -o json")
        return ok(
          JSON.stringify({
            items: [
              {
                metadata: {
                  name: "standard",
                  annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
                },
              },
            ],
          }),
        );
      if (a === "auth can-i create namespaces")
        return ok(o.canCreateNamespaces === false ? "no\n" : "yes\n");
      const slot = /^auth can-i create deployments -n (\S+)$/.exec(a);
      if (slot) return ok(o.slots?.[slot[1] as string] ? "yes\n" : "no\n");
      if (args[0] === "get" && args[1] === "deployments") return ok("");
      // One deployment by name: the supervisor, with the control address it was deployed with.
      if (args[0] === "get" && args[1] === "deployment" && args[3] === "-n")
        return ok(
          JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    { env: [{ name: "CONTROL_URL", value: "https://control.example.com" }] },
                  ],
                },
              },
            },
          }),
        );
      // A rig's two deployments, each running its newest pod.
      if (args[0] === "get" && args[1] === "deployment")
        return ok(
          JSON.stringify({
            items: args.slice(2, 4).map(() => ({
              metadata: { generation: 2 },
              spec: { replicas: 1 },
              status: {
                observedGeneration: 2,
                replicas: 1,
                updatedReplicas: 1,
                availableReplicas: 1,
              },
            })),
          }),
        );
      const rq = /^get resourcequota -n (\S+) -o json$/.exec(a);
      if (rq) {
        const hard = o.quota?.[rq[1] as string];
        return ok(JSON.stringify({ items: hard ? [{ status: { hard } }] : [] }));
      }
      // The operators' network rule in slot 1: DNS and the internet without private ranges.
      const np = /^get networkpolicy -n (\S+) -o json$/.exec(a);
      if (np)
        return ok(
          JSON.stringify({
            items: (o.ruled ?? ["thermite-slot-1"]).includes(np[1] as string)
              ? [
                  {
                    metadata: { name: "thermite-harness" },
                    spec: {
                      podSelector: { matchLabels: { "app.kubernetes.io/component": "harness" } },
                      policyTypes: ["Egress"],
                      egress: [
                        { ports: [{ port: 53, protocol: "UDP" }] },
                        {
                          to: [
                            {
                              ipBlock: {
                                cidr: "0.0.0.0/0",
                                except: PRIVATE_RANGES,
                              },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ]
              : [],
          }),
        );
      return ok("");
    },
  };
  return { k, calls };
}

/** Control over a fake cluster; `tag` names the rig images it deploys (another control, later). */
async function control(
  k: ClusterKubectl,
  o: {
    store?: ControlStore;
    secrets?: SecretBox;
    tag?: string;
    publicUrl?: string | null;
    drainWatchMs?: number;
  } = {},
) {
  const store = o.store ?? new ControlStore(":memory:");
  const secrets = o.secrets ?? SecretBox.ephemeral();
  const tag = o.tag ?? "1";
  const api = createControlApi(
    store,
    { admin: ADMIN, operator: OPERATOR, rigs: {} },
    generateSigningKeys().privateKeyPem,
    {
      staleAfterMs: 180_000,
      secrets,
      clusterKubectl: k,
      ...(o.drainWatchMs ? { drainWatchMs: o.drainWatchMs } : {}),
      publicUrl: o.publicUrl === null ? undefined : (o.publicUrl ?? "https://control.example.com"),
      rigImages: {
        harness: `registry.example.com/harness:${tag}`,
        harnessCuda: `registry.example.com/harness-cuda:${tag}`,
        supervisor: `registry.example.com/supervisor:${tag}`,
      },
    },
  );
  const login = await api.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: ADMIN }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = async (path: string) => (await api.request(path, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/settings"))?.[1] ?? "";
  const post = async (path: string, form: Record<string, string>) =>
    decodeURIComponent(
      String(
        (
          await api.request(path, {
            method: "POST",
            body: new URLSearchParams({ csrf, ...form }),
            headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
          })
        ).headers.get("location"),
      ),
    );
  return { store, secrets, page, post, api };
}

/** An MCP client on control with a token: each call's error flag and its JSON answer. */
async function mcpWith(api: ReturnType<typeof createControlApi>, token: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://control/mcp"), {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
      },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return {
      error: r.isError === true,
      body: JSON.parse(r.content[0]?.text ?? "null") as Record<string, unknown>,
    };
  };
  return { call, close: () => client.close() };
}

describe("clusters in Providers and Add a rig", () => {
  test("a cluster is added and checked; a rig is applied into a namespace of its own and managed", async () => {
    const f = fakeCluster();
    const s = await control(f.k);
    assert.match(
      await s.post("/ui/settings/add", { type: "k8s", name: "k8s-a", kubeconfig: "not yaml" }),
      /not a kubeconfig/,
    );
    // A kubeconfig that would run a command or read a file inside control is refused.
    assert.match(
      await s.post("/ui/settings/add", {
        type: "k8s",
        name: "k8s-a",
        kubeconfig: `${KUBECONFIG}# exec:`,
      }),
      /Not added: user "u" runs a command \(exec\) to log in.*cluster "c" reads a file \(certificate-authority\)/,
    );
    assert.match(
      await s.post("/ui/settings/add", {
        type: "k8s",
        name: "k8s-a",
        kubeconfig: KUBECONFIG,
        context: "nope",
      }),
      /has no context "nope"/,
    );
    assert.match(
      await s.post("/ui/settings/add", {
        type: "k8s",
        name: "k8s-a",
        kubeconfig: KUBECONFIG,
        placement: "created",
        namespace_pattern: "thermite-{rig}",
      }),
      /"k8s-a" is added and checked/,
    );
    const k = s.store.cluster("k8s-a");
    assert.equal(k?.context, "kind-thermite");
    assert.equal(s.secrets.open(k?.kubeconfig_sealed ?? ""), KUBECONFIG.trim());
    let page = await s.page("/ui/settings");
    assert.match(page, /class="kind r">Cluster</);
    assert.match(page, /Kubernetes v1\.35\.2 · 1 node, 1 with 2 GPUs · storage standard/);
    assert.match(page, /control may create namespaces/);
    assert.ok(!page.includes("secret-kube-token-789"));
    // Add a rig offers it, with its GPUs, nodes and storage.
    const add = await s.page("/ui/rigs/add");
    assert.match(add, /name="place" value="cluster:k8s-a"/);
    assert.match(add, /name="k_gpus__k8s-a"/);
    assert.match(add, /NVIDIA&#39;s device plugin|NVIDIA's device plugin/);
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-a",
        rig: "k8s-a-1",
        "k_gpus__k8s-a": "1",
        "k_mode__k8s-a": "device-plugin",
        "k_node__k8s-a": "gpu-node-1",
        "k_storage__k8s-a": "standard",
        "k_size__k8s-a": "50",
      }),
      "/ui/rigs/k8s-a-1",
    );
    await new Promise((r) => setTimeout(r, 20));
    const apply = f.calls.find((c) => c.args[0] === "apply");
    assert.deepEqual(apply?.args, ["apply", "-f", "-"]);
    const list = JSON.parse(apply?.stdin ?? "{}") as {
      items: { kind: string; metadata: { name: string; namespace?: string } }[];
    };
    assert.equal(list.items[0]?.kind, "Namespace");
    assert.equal(list.items[0]?.metadata.name, "thermite-k8s-a-1");
    assert.match(apply?.stdin ?? "", /"nvidia.com\/gpu":1/);
    assert.match(apply?.stdin ?? "", /registry\.example\.com\/harness-cuda:1/);
    assert.ok(s.store.enrolledRig("k8s-a-1"));
    page = await s.page("/ui/rigs/k8s-a-1");
    assert.match(page, /Control is setting k8s-a-1 up on k8s-a/);
    assert.match(page, /Its objects applied in the cluster/);
    assert.match(page, /1 through NVIDIA&#39;s device plugin|1 through NVIDIA's device plugin/);
    // Stop and start scale its deployments; remove deletes its namespace and retires its token.
    assert.match(await s.post("/ui/rigs/k8s-a-1/cluster/stop", {}), /ok=Stopped/);
    assert.ok(
      f.calls.some(
        (c) =>
          c.args.join(" ") ===
          "scale deployment -n thermite-k8s-a-1 -l app.kubernetes.io/instance=k8s-a-1 --replicas=0",
      ),
    );
    assert.match(
      await s.post("/ui/rigs/k8s-a-1/cluster/remove", { confirm: "remove k8s" }),
      /Type "remove k8s-a-1"/,
    );
    assert.match(
      await s.post("/ui/rigs/k8s-a-1/cluster/remove", { confirm: "remove k8s-a-1" }),
      /ok=Removed from the cluster/,
    );
    assert.ok(
      f.calls.some(
        (c) =>
          c.args.join(" ") === "delete namespace thermite-k8s-a-1 --wait=false --ignore-not-found",
      ),
    );
    assert.equal(s.store.clusterRig("k8s-a-1")?.status, "removed");
    assert.equal(s.store.enrolledRig("k8s-a-1"), undefined);
    assert.match(await s.post("/ui/settings/clusters/k8s-a/delete", {}), /"k8s-a" is deleted/);
  });

  test("slots: only free slots control may use; nothing created outside the slot", async () => {
    const f = fakeCluster({
      canCreateNamespaces: false,
      slots: { "thermite-slot-1": true, "thermite-slot-2": false, "thermite-slot-3": true },
    });
    const s = await control(f.k);
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-b",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1, thermite-slot-2, thermite-slot-3",
    });
    const page = await s.page("/ui/settings");
    assert.match(page, /thermite-slot-1: <span class="chip ok">free/);
    assert.match(page, /thermite-slot-2: <span class="chip warn">control may not deploy here/);
    // A slot whose rules don't keep the harness off the cluster is refused.
    assert.match(
      page,
      /thermite-slot-3: <span class="chip warn">refused: no network rule in the slot limits/,
    );
    assert.match(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-b",
        rig: "k8s-b-3",
        "k_gpus__k8s-b": "0",
        "k_slot__k8s-b": "thermite-slot-3",
      }),
      /Refused: in the slot thermite-slot-3, no network rule in the slot limits where the harness may connect/,
    );
    assert.match(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-b",
        rig: "k8s-b-1",
        "k_gpus__k8s-b": "0",
        "k_slot__k8s-b": "thermite-slot-2",
      }),
      /Choose a free slot/,
    );
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-b",
        rig: "k8s-b-1",
        "k_gpus__k8s-b": "0",
        "k_slot__k8s-b": "thermite-slot-1",
      }),
      "/ui/rigs/k8s-b-1",
    );
    await new Promise((r) => setTimeout(r, 20));
    const list = JSON.parse(f.calls.find((c) => c.args[0] === "apply")?.stdin ?? "{}") as {
      items: { kind: string; metadata: { namespace?: string } }[];
    };
    assert.ok(!list.items.some((o) => o.kind === "Namespace" || o.kind === "NetworkPolicy"));
    assert.ok(list.items.every((o) => o.metadata.namespace === "thermite-slot-1"));
    assert.match(
      await s.post("/ui/rigs/k8s-b-1/cluster/remove", { confirm: "remove k8s-b-1" }),
      /ok=Removed/,
    );
    assert.ok(
      f.calls.some((c) =>
        c.args
          .join(" ")
          .startsWith("delete deployment,service,persistentvolumeclaim,secret -n thermite-slot-1"),
      ),
    );
  });

  test("a rig moves onto the images control now deploys; its secret, volume and tokens stay", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    assert.equal(
      await before.post("/ui/rigs/add", {
        place: "cluster:k8s-c",
        rig: "cpu-1",
        "k_gpus__k8s-c": "0",
        "k_slot__k8s-c": "thermite-slot-1",
      }),
      "/ui/rigs/cpu-1",
    );
    await new Promise((r) => setTimeout(r, 20));
    // Its first report (the fake cluster has no rig to send one) makes it running.
    before.store.setClusterRigStatus("cpu-1", "running");
    assert.doesNotMatch(await before.page("/ui/rigs/cpu-1"), /Update to these images/);
    assert.match(
      await before.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 already runs control's images/,
    );
    // Control now deploys other images (after its own update): the rig's page offers them.
    const s = await control(f.k, { store: before.store, secrets: before.secrets, tag: "2" });
    let page = await s.page("/ui/rigs/cpu-1");
    assert.match(page, /Control now deploys other images:.*registry\.example\.com\/harness:2/s);
    assert.match(page, /Update to these images/);
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1's pods restart on the new images/,
    );
    type Items = {
      items: {
        kind: string;
        metadata: { namespace?: string };
        spec?: { replicas?: number; template?: { spec?: { containers: { image: string }[] } } };
      }[];
    };
    const applied = (): Items =>
      JSON.parse(f.calls.find((c) => c.args[0] === "apply")?.stdin ?? "{}") as Items;
    // Only the two deployments: the secret with its tokens, the volume claim and the service stay.
    let list = applied();
    assert.deepEqual(
      list.items.map((o) => o.kind),
      ["Deployment", "Deployment"],
    );
    assert.ok(list.items.every((o) => o.metadata.namespace === "thermite-slot-1"));
    assert.deepEqual(
      list.items.flatMap((d) => d.spec?.template?.spec?.containers.map((c) => c.image)),
      ["registry.example.com/harness:2", "registry.example.com/supervisor:2"],
    );
    assert.deepEqual(s.store.clusterRig("cpu-1")?.spec.images, {
      harness: "registry.example.com/harness:2",
      supervisor: "registry.example.com/supervisor:2",
    });
    await new Promise((r) => setTimeout(r, 20));
    page = await s.page("/ui/rigs/cpu-1");
    assert.match(
      page,
      /Its deployments applied with new images.*harness registry\.example\.com\/harness:1 → registry\.example\.com\/harness:2/s,
    );
    assert.match(page, /Its pods run the new images/);
    assert.doesNotMatch(page, /Update to these images/);
    // While it waits for a report from the new images, another change is refused; a report after
    // a failed wait shows it running again.
    assert.equal(s.store.clusterRig("cpu-1")?.status, "updating");
    const busy = await control(f.k, { store: s.store, secrets: s.secrets, tag: "9" });
    assert.match(
      await busy.post("/ui/rigs/cpu-1/cluster/images", {}),
      /error=cpu-1 is being updated/,
    );
    assert.match(await busy.post("/ui/rigs/cpu-1/cluster/restart", {}), /error=cpu-1 is updating/);
    // A stopped rig stays stopped: it runs the new images when it starts again.
    assert.match(await s.post("/ui/rigs/cpu-1/cluster/stop", {}), /ok=Stopped/);
    const later = await control(f.k, { store: s.store, secrets: s.secrets, tag: "3" });
    f.calls.length = 0;
    assert.match(
      await later.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 runs the new images when it starts again/,
    );
    list = applied();
    assert.deepEqual(
      list.items.map((d) => d.spec?.replicas),
      [0, 0],
    );
    assert.equal(later.store.clusterRig("cpu-1")?.status, "stopped");
    // Without control's address for rigs, the update is refused: the rig would lose its way back.
    const lost = await control(f.k, {
      store: s.store,
      secrets: s.secrets,
      tag: "4",
      publicUrl: null,
    });
    assert.match(
      await lost.post("/ui/rigs/cpu-1/cluster/images", {}),
      /error=Control's address for rigs is not set/,
    );
    // The same images, but control's address changed: the update carries the new address.
    const moved = await control(f.k, {
      store: s.store,
      secrets: s.secrets,
      tag: "3",
      publicUrl: "https://control2.example.com",
    });
    assert.match(
      await moved.page("/ui/rigs/cpu-1"),
      /Control's address for rigs changed: the rig reports to <span class="mono">https:\/\/control\.example\.com<\/span>, control is now at <span class="mono">https:\/\/control2\.example\.com<\/span>[\s\S]*Give it control's new address/,
    );
    f.calls.length = 0;
    assert.match(
      await moved.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 gets control's new address when it starts again/,
    );
    assert.equal(moved.store.clusterRig("cpu-1")?.spec.controlUrl, "https://control2.example.com");
    assert.doesNotMatch(await moved.page("/ui/rigs/cpu-1"), /Give it control/);
    // After a failed change, the same images are offered again as a retry.
    moved.store.setClusterRigStatus("cpu-1", "failed");
    assert.match(await moved.page("/ui/rigs/cpu-1"), /Try the update again/);
    moved.store.setClusterRigStatus("cpu-1", "stopped");
    assert.match(
      String(f.calls.find((c) => c.args[0] === "apply")?.stdin),
      /control2\.example\.com/,
    );
    // And with the same address, nothing to do.
    const same = await control(f.k, { store: s.store, secrets: s.secrets, tag: "3" });
    assert.match(
      await same.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 already runs control's images/,
    );
  });

  test("a busy rig drains before its update: its pods restart once nothing runs; Update now skips the wait (goal 079)", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    await before.post("/ui/rigs/add", {
      place: "cluster:k8s-c",
      rig: "cpu-1",
      "k_gpus__k8s-c": "0",
      "k_slot__k8s-c": "thermite-slot-1",
    });
    await new Promise((r) => setTimeout(r, 20));
    before.store.setClusterRigStatus("cpu-1", "running");
    // The rig reports what still runs: two trials and the judge's job.
    const report = (work: Record<string, unknown>) =>
      before.store.ingest({
        rig: "cpu-1",
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: { work },
      });
    report({ trials: 2, judge_jobs: 1, draining: null });
    const s = await control(f.k, { store: before.store, secrets: before.secrets, tag: "2" });
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1 drains first: it starts nothing new, and its pods restart on the new images once 2 trials and the judge's job finish/,
    );
    assert.equal(s.store.clusterRig("cpu-1")?.status, "draining");
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "no restart yet");
    const sent = s.store.pendingCommands("cpu-1").map((c) => c.envelope);
    assert.deepEqual(
      sent.filter((e) => e.kind === "drain_rig").map((e) => e.payload),
      [{ drain: true, reason: "its images are about to change" }],
    );
    // Its page says what it waits for, with the two ways out.
    const page = await s.page("/ui/rigs/cpu-1");
    assert.match(page, /Draining before its pods restart on control's images/);
    assert.match(page, /It waits for 2 trials and the judge's job to finish/);
    assert.match(page, /Update now, without waiting/);
    assert.match(page, /Call the update off/);
    // Asked again, it goes on waiting; called off, the rig goes back to work.
    assert.match(await s.post("/ui/rigs/cpu-1/cluster/images", {}), /ok=cpu-1 is draining/);
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/drain-cancel", {}),
      /ok=cpu-1 goes back to work on its images/,
    );
    assert.equal(s.store.clusterRig("cpu-1")?.status, "running");
    assert.deepEqual(
      s.store
        .pendingCommands("cpu-1")
        .map((c) => c.envelope)
        .filter((e) => e.kind === "drain_rig")
        .map((e) => (e.payload as { drain: boolean }).drain),
      [true, false],
    );
    // Drained again, then Update now: its pods restart at once, while work still runs.
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    assert.match(
      await s.post("/ui/rigs/cpu-1/cluster/images-now", {}),
      /ok=cpu-1's pods restart on the new images/,
    );
    assert.ok(f.calls.some((c) => c.args[0] === "apply"));
    // An idle rig is updated at once, with no drain.
    s.store.setClusterRigStatus("cpu-1", "running");
    report({ trials: 0, judge_jobs: 0, draining: null });
    const idle = await control(f.k, { store: s.store, secrets: s.secrets, tag: "3" });
    assert.match(
      await idle.post("/ui/rigs/cpu-1/cluster/images", {}),
      /ok=cpu-1's pods restart on the new images/,
    );
  });

  test("a draining rig's pods restart once its report says nothing runs (goal 079)", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    await before.post("/ui/rigs/add", {
      place: "cluster:k8s-c",
      rig: "cpu-1",
      "k_gpus__k8s-c": "0",
      "k_slot__k8s-c": "thermite-slot-1",
    });
    await new Promise((r) => setTimeout(r, 20));
    before.store.setClusterRigStatus("cpu-1", "running");
    const report = (work: Record<string, unknown>) =>
      before.store.ingest({
        rig: "cpu-1",
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: { work },
      });
    report({ trials: 1, judge_jobs: 0, draining: null });
    const s = await control(f.k, {
      store: before.store,
      secrets: before.secrets,
      tag: "2",
      drainWatchMs: 20,
    });
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    f.calls.length = 0;
    // The rig took the drain, and its trial still runs: no restart.
    report({ trials: 1, judge_jobs: 0, draining: { since: "x", reason: "r" } });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"));
    // Its trial ended and the judge has no job: the pods restart on the new images.
    report({ trials: 0, judge_jobs: 0, draining: { since: "x", reason: "r" } });
    for (let i = 0; i < 50 && !f.calls.some((c) => c.args[0] === "apply"); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      f.calls.some((c) => c.args[0] === "apply"),
      "restarted once nothing ran",
    );
    assert.equal(s.store.clusterRig("cpu-1")?.status, "updating");
  });

  test("a harness that started again while draining is asked to drain again, once (goal 079)", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    await before.post("/ui/rigs/add", {
      place: "cluster:k8s-c",
      rig: "cpu-1",
      "k_gpus__k8s-c": "0",
      "k_slot__k8s-c": "thermite-slot-1",
    });
    await new Promise((r) => setTimeout(r, 20));
    before.store.setClusterRigStatus("cpu-1", "running");
    const report = (work: Record<string, unknown>) =>
      before.store.ingest({
        rig: "cpu-1",
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: { work },
      });
    report({ trials: 1, judge_jobs: 0, draining: null });
    const s = await control(f.k, {
      store: before.store,
      secrets: before.secrets,
      tag: "2",
      drainWatchMs: 20,
    });
    await s.post("/ui/rigs/cpu-1/cluster/images", {});
    const drains = () =>
      s.store.latestCommands("cpu-1", "drain_rig").filter((c) => c.payload.drain === true);
    // Not yet taken: the report without a drain is not a reason to ask again.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(drains().length, 1);
    // Taken; one report after it without the drain may have been read before it took effect.
    const first = drains()[0];
    assert.ok(first);
    s.store.ackCommand("cpu-1", first.id, "delivered", {});
    await new Promise((r) => setTimeout(r, 5));
    report({ trials: 1, judge_jobs: 0, draining: null });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(drains().length, 1);
    // The next report has no drain either: the harness started again and forgot it.
    report({ trials: 1, judge_jobs: 0, draining: null });
    for (let i = 0; i < 50 && drains().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(drains().length, 2);
    assert.match(
      s.store
        .rigSetupEvents("cpu-1")
        .map((e) => e.detail ?? "")
        .join("\n"),
      /its harness started again and was not draining: asked again/,
    );
    // The new ask is on its way: not asked a third time, and no restart while the trial runs.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(drains().length, 2);
    assert.equal(s.store.clusterRig("cpu-1")?.status, "draining");
    // Its history names the step in words.
    assert.match(
      await s.page("/ui/rigs/cpu-1"),
      /Draining: it starts nothing new until its work ends/,
    );
  });

  test("Update to control's version moves a busy rig's pods at once: its runs are paused, so no drain (goal 079)", async () => {
    const f = fakeCluster({ canCreateNamespaces: false, slots: { "thermite-slot-1": true } });
    const before = await control(f.k);
    await before.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-c",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    await before.post("/ui/rigs/add", {
      place: "cluster:k8s-c",
      rig: "cpu-1",
      "k_gpus__k8s-c": "0",
      "k_slot__k8s-c": "thermite-slot-1",
    });
    await new Promise((r) => setTimeout(r, 20));
    before.store.setClusterRigStatus("cpu-1", "running");
    before.store.ingest({
      rig: "cpu-1",
      ledger_id: "l-1",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: { work: { trials: 2, judge_jobs: 1, draining: null } },
    });
    const s = await control(f.k, { store: before.store, secrets: before.secrets, tag: "2" });
    f.calls.length = 0;
    await s.post("/ui/rigs/cpu-1/update", {});
    for (let i = 0; i < 100 && !f.calls.some((c) => c.args[0] === "apply"); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      f.calls.some((c) => c.args[0] === "apply"),
      "its pods move now",
    );
    assert.equal(s.store.latestCommands("cpu-1", "drain_rig").length, 0);
    assert.notEqual(s.store.clusterRig("cpu-1")?.status, "draining");
  });

  test("CPU slots: the quota sets the rig's CPUs and memory; slots added later; a rig added over MCP", async () => {
    const quota = { "limits.cpu": "6", "limits.memory": "24Gi", "requests.storage": "200Gi" };
    const f = fakeCluster({
      canCreateNamespaces: false,
      slots: { "thermite-slot-2": true, "thermite-slot-3": true },
      ruled: ["thermite-slot-2", "thermite-slot-3"],
      quota: { "thermite-slot-2": quota, "thermite-slot-3": quota },
    });
    const store = new ControlStore(":memory:");
    const api = createControlApi(
      store,
      { admin: ADMIN, operator: "operator-token-abcdef", rigs: {} },
      generateSigningKeys().privateKeyPem,
      {
        staleAfterMs: 180_000,
        secrets: SecretBox.ephemeral(),
        clusterKubectl: f.k,
        publicUrl: "https://control.example.com",
        rigImages: {
          harness: "registry.example.com/harness:1",
          harnessCuda: "registry.example.com/harness-cuda:1",
          supervisor: "registry.example.com/supervisor:1",
        },
      },
    );
    const login = await api.request("/ui/login", {
      method: "POST",
      body: new URLSearchParams({ token: ADMIN }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = async (path: string) => (await api.request(path, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/settings"))?.[1] ?? "";
    const post = async (path: string, form: Record<string, string>) =>
      decodeURIComponent(
        String(
          (
            await api.request(path, {
              method: "POST",
              body: new URLSearchParams({ csrf, ...form }),
              headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
            })
          ).headers.get("location"),
        ),
      );
    await post("/ui/settings/add", {
      type: "k8s",
      name: "lab",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-2",
    });
    // A slot added later, from the cluster's row: read again with its rules and quota.
    assert.match(
      await post("/ui/settings/clusters/lab/slots", { slots: "thermite-slot-2, thermite-slot-3" }),
      /"lab" now has 2 slots, read again/,
    );
    const add = await page("/ui/rigs/add");
    assert.match(add, /name="k_cpus__lab" inputmode="decimal" value="6"/);
    assert.match(add, /name="k_mem__lab" inputmode="decimal" value="24"/);
    assert.match(add, /name="k_size__lab" value="200"/);

    // Over MCP, as an operator: a rig in each slot, sized by the quota.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://control/mcp"), {
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const headers = new Headers(init?.headers);
          headers.set("authorization", "Bearer operator-token-abcdef");
          return api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
        },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return { error: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") };
    };
    const tooBig = await call("add_cluster_rig", {
      rig: "cpu-2",
      cluster: "lab",
      slot: "thermite-slot-2",
      cpus: 8,
      memory_gib: 24,
    });
    assert.ok(tooBig.error);
    assert.match(String(tooBig.body.error), /The slot thermite-slot-2 allows 6 CPUs/);
    const added = await call("add_cluster_rig", {
      rig: "cpu-2",
      cluster: "lab",
      slot: "thermite-slot-2",
    });
    assert.deepEqual(added, { error: false, body: { rig: "cpu-2", status: "deploying" } });
    await new Promise((r) => setTimeout(r, 20));
    const list = JSON.parse(f.calls.find((c) => c.args[0] === "apply")?.stdin ?? "{}") as {
      items: {
        kind: string;
        metadata: { name: string };
        spec?: {
          template?: {
            spec?: {
              containers: { name: string; resources?: unknown }[];
              initContainers: { resources?: unknown }[];
            };
          };
        };
      }[];
    };
    const pods = list.items.filter((o) => o.kind === "Deployment");
    const res = (name: string) =>
      pods.flatMap((d) => d.spec?.template?.spec?.containers ?? []).find((c) => c.name === name)
        ?.resources;
    const both = (cpu: string, memory: string) => ({
      requests: { cpu, memory },
      limits: { cpu, memory },
    });
    assert.deepEqual(res("harness"), both("5500m", "22528Mi"));
    assert.deepEqual(res("supervisor"), both("500m", "2048Mi"));
    for (const d of pods)
      assert.deepEqual(d.spec?.template?.spec?.initContainers[0]?.resources, both("250m", "256Mi"));
    // The slot holding cpu-2 stays in the list.
    const dropped = await call("set_cluster_slots", { cluster: "lab", slots: ["thermite-slot-3"] });
    assert.ok(dropped.error);
    assert.match(String(dropped.body.error), /thermite-slot-2 still holds a rig \(cpu-2\)/);
    // An image update over MCP, as on the rig's page: refused while the rig still starts, then
    // nothing to do while the images match.
    assert.match(
      String((await call("update_rig_images", { rig: "cpu-2" })).body.error),
      /cpu-2 is starting: wait until its page shows it running, or failed/,
    );
    store.setClusterRigStatus("cpu-2", "running"); // its first report (the fake has no rig)
    assert.deepEqual(await call("update_rig_images", { rig: "cpu-2" }), {
      error: false,
      body: { rig: "cpu-2", said: "cpu-2 already runs control's images." },
    });
    const unknown = await call("update_rig_images", { rig: "cpu-9" });
    assert.ok(unknown.error);
    assert.match(String(unknown.body.error), /Control didn't set cpu-9 up on a cluster/);
    // Where the rig is, its status there and each step of its setup, over MCP.
    const setup = await call("rig_setup", { rig: "cpu-2" });
    assert.equal(setup.error, false);
    const body = setup.body as unknown as {
      on: string;
      namespace: string;
      steps: { step: string }[];
    };
    assert.equal(body.on, "cluster");
    assert.equal(body.namespace, "thermite-slot-2");
    assert.ok(body.steps.length > 0);
    assert.ok((await call("rig_setup", { rig: "cpu-9" })).error);
    await client.close();
  });
});

describe("a cluster rig's GPUs, CPUs and memory, changed from control (goal 118)", () => {
  type Container = {
    name: string;
    image: string;
    env?: { name: string; value: string }[];
    resources?: Record<string, Record<string, unknown>>;
  };
  type Items = {
    items: {
      kind: string;
      metadata: { name: string; namespace?: string };
      spec?: {
        replicas?: number;
        template?: { spec?: { containers: Container[] } };
        spec?: { devices?: { requests?: { exactly?: { count?: number } }[] } };
      };
    }[];
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const applied = (f: ReturnType<typeof fakeCluster>): Items =>
    JSON.parse(f.calls.find((c) => c.args[0] === "apply")?.stdin ?? "{}") as Items;
  const container = (list: Items, name: string) =>
    list.items
      .flatMap((d) => d.spec?.template?.spec?.containers ?? [])
      .find((c) => c.name === name);
  const envOf = (c: Container | undefined) =>
    Object.fromEntries((c?.env ?? []).map((e) => [e.name, e.value]));
  /** A cluster of one slot with a rig of `gpus` GPUs in it, running. */
  async function slotRig(
    rig: string,
    gpus: number,
    o: { quota?: Record<string, Record<string, string>>; drainWatchMs?: number } = {},
  ) {
    const f = fakeCluster({
      canCreateNamespaces: false,
      slots: { "thermite-slot-1": true },
      nodeGpus: 8,
      ...(o.quota ? { quota: o.quota } : {}),
    });
    const s = await control(f.k, o.drainWatchMs ? { drainWatchMs: o.drainWatchMs } : {});
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-g",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    });
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-g",
        rig,
        "k_gpus__k8s-g": String(gpus),
        "k_slot__k8s-g": "thermite-slot-1",
      }),
      `/ui/rigs/${rig}`,
    );
    await sleep(20);
    // Its first report (the fake cluster has no rig to send one) makes it running.
    s.store.setClusterRigStatus(rig, "running");
    const report = (summary: Record<string, unknown>) =>
      s.store.ingest({
        rig,
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary,
      });
    // Edit rig is for a rig that reported.
    report({});
    return { f, s, report };
  }

  test("Edit rig moves a slot rig from 3 GPUs to 4 and onto the slot's new quota; only its deployments are applied", async () => {
    const quota: Record<string, Record<string, string>> = {
      "thermite-slot-1": { "requests.nvidia.com/gpu": "3" },
    };
    const { f, s } = await slotRig("gpu-1", 3, { quota });
    assert.equal(s.store.clusterRig("gpu-1")?.spec.resources, undefined);
    // Edit rig: its GPUs, CPUs and memory, each label with its info icon, and what the slot allows.
    let edit = await s.page("/ui/rigs/gpu-1/edit");
    assert.match(
      edit,
      /<span class="lb">GPUs<i class="ii" tabindex="0" data-tip="How many GPUs the rig[^"]*harness pod asks for, through NVIDIA[^"]*device plugin: 1 to 16\./,
    );
    assert.match(edit, /name="k_gpus" type="number" min="1" max="16" step="1" value="3"/);
    assert.match(
      edit,
      /<span class="lb">CPUs<i class="ii" tabindex="0" data-tip="The rig[^"]*CPUs/,
    );
    assert.match(edit, /name="k_cpus" type="number" min="1.5" step="any" value=""/);
    assert.match(
      edit,
      /<span class="lb">Memory \(GiB\)<i class="ii" tabindex="0" data-tip="[^"]+"/,
    );
    assert.match(edit, /name="k_mem" type="number" min="6" step="any" value=""/);
    assert.match(edit, /The slot(&#39;|')s quota allows 3 GPUs, as control last read it/);
    assert.match(edit, /data-moves-say="Its pods restart with the new GPUs, CPUs and memory/);
    // The slot's operators give it a fourth GPU, 16 CPUs and 52 GiB.
    quota["thermite-slot-1"] = {
      "limits.cpu": "16",
      "limits.memory": "52Gi",
      "requests.nvidia.com/gpu": "4",
    };
    f.calls.length = 0;
    assert.equal(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "16", k_mem: "52" }),
      "/ui/rigs/gpu-1?ok=gpu-1's pods restart with 4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory.",
    );
    assert.ok(
      f.calls.some((c) => c.args.join(" ") === "get resourcequota -n thermite-slot-1 -o json"),
      "the quota is read again",
    );
    // Only the two deployments: the secret with its tokens, the volume claim and the service stay.
    const list = applied(f);
    assert.deepEqual(
      list.items.map((o) => o.kind),
      ["Deployment", "Deployment"],
    );
    assert.ok(list.items.every((o) => o.metadata.namespace === "thermite-slot-1"));
    const harness = container(list, "harness");
    assert.deepEqual(harness?.resources, {
      requests: { cpu: "15500m", memory: "51200Mi" },
      limits: { cpu: "15500m", memory: "51200Mi", "nvidia.com/gpu": 4 },
    });
    assert.equal(envOf(harness).THERMITE_GPUS, "0,1,2,3");
    assert.equal(envOf(harness).THERMITE_JUDGE_GPUS, "2");
    assert.deepEqual(container(list, "supervisor")?.resources, {
      requests: { cpu: "500m", memory: "2048Mi" },
      limits: { cpu: "500m", memory: "2048Mi" },
    });
    // The images it runs: a change of size is not an image update.
    assert.equal(harness?.image, "registry.example.com/harness-cuda:1");
    const spec = s.store.clusterRig("gpu-1")?.spec;
    assert.equal(spec?.gpus, 4);
    assert.equal(spec?.judgeGpus, 2);
    assert.deepEqual(spec?.resources, { cpus: 16, memoryGi: 52 });
    await sleep(20);
    let page = await s.page("/ui/rigs/gpu-1");
    assert.match(
      page,
      /Its deployments applied with new GPUs, CPUs or memory.*GPUs 3 → 4 \(2 for the judge, 2 for the agents\); CPUs and memory: namespace defaults → 16 CPUs, 52 GiB/s,
    );
    assert.match(page, /Its pods run with the new GPUs, CPUs or memory/);
    assert.match(page, /<dt>CPUs and memory<\/dt><dd>16 CPUs, 52 GiB/);
    assert.match(
      page,
      /4 through NVIDIA(&#39;|')s device plugin: 2 for the judge, 2 for the agents/,
    );
    // While it waits for a report from its new pods, another change is refused.
    assert.equal(s.store.clusterRig("gpu-1")?.status, "updating");
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "12", k_mem: "52" }),
      /error=Not saved: gpu-1 is being updated: wait until its page shows it running, or failed\./,
    );
    // Above the quota: refused in words, and nothing is applied.
    s.store.setClusterRigStatus("gpu-1", "running");
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "5", k_cpus: "16", k_mem: "52" }),
      /error=Not saved: The slot thermite-slot-1 allows 4 GPUs\./,
    );
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "17", k_mem: "52" }),
      /error=Not saved: The slot thermite-slot-1 allows 16 CPUs\./,
    );
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "0", k_cpus: "16", k_mem: "52" }),
      /error=Not saved: gpu-1 measures on GPUs, and can't move to none/,
    );
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"));
    // The same values: nothing to do.
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "16", k_mem: "52" }),
      /ok=Nothing changed\./,
    );
    // Both fields empty: back to the namespace's defaults.
    assert.match(
      await s.post("/ui/rigs/gpu-1/edit", { k_gpus: "4", k_cpus: "", k_mem: "" }),
      /ok=gpu-1's pods restart with 4 GPUs \(2 for the judge, 2 for the agents\), the namespace's default CPUs and memory\./,
    );
    assert.equal(s.store.clusterRig("gpu-1")?.spec.resources, undefined);
    s.store.setClusterRigStatus("gpu-1", "running");
    edit = await s.page("/ui/rigs/gpu-1/edit");
    assert.match(edit, /name="k_gpus" type="number" min="1" max="16" step="1" value="4"/);
    page = await s.page("/ui/rigs/gpu-1");
    assert.match(page, /<dt>CPUs and memory<\/dt><dd>the namespace(&#39;|')s defaults/);
  });

  test("an operator changes GPUs, CPUs and memory over MCP, not the judge's share; a share the rig kept follows; REST is the owner's twin", async () => {
    const { f, s, report } = await slotRig("gpu-2", 3);
    // The rig keeps a judge's share from Edit rig: 1 of its 3 GPUs.
    report({ settings: { judge_gpus: 1 }, gpu_split: { set: 3, judge: 1 } });
    const op = await mcpWith(s.api, OPERATOR);
    f.calls.length = 0;
    const refused = await op.call("set_cluster_rig_resources", {
      rig: "gpu-2",
      gpus: 4,
      judge_gpus: 1,
    });
    assert.ok(refused.error);
    assert.match(
      String(refused.body.error),
      /^Only the owner's token changes a rig's GPU split: leave out judge_gpus\./,
    );
    assert.equal(s.store.clusterRig("gpu-2")?.spec.gpus, 3);
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "nothing changed");
    f.calls.length = 0;
    assert.deepEqual(
      await op.call("set_cluster_rig_resources", {
        rig: "gpu-2",
        gpus: 4,
        cpus: 8,
        memory_gib: 32,
      }),
      {
        error: false,
        body: {
          rig: "gpu-2",
          said: "gpu-2's pods restart with 4 GPUs (2 for the judge, 2 for the agents), 8 CPUs and 32 GiB of memory.",
        },
      },
    );
    assert.equal(envOf(container(applied(f), "harness")).THERMITE_JUDGE_GPUS, "2");
    // The share it kept (1) would come first in its harness: it follows the new default, sent as
    // the one who asked (the operator acts for the owner).
    const sent = s.store
      .pendingCommands("gpu-2")
      .map((c) => c.envelope)
      .filter((e) => e.kind === "rig_settings");
    assert.deepEqual(
      sent.map((e) => [e.payload, e.issued_by]),
      [[{ judge_gpus: 2 }, "owner:operator"]],
    );
    assert.match(
      s.store
        .rigSetupEvents("gpu-2")
        .map((e) => e.detail ?? "")
        .join("\n"),
      /the judge's share it kept, 1, → 2/,
    );
    s.store.setClusterRigStatus("gpu-2", "running");
    const setup = await op.call("rig_setup", { rig: "gpu-2" });
    assert.equal(setup.body.gpus, 4);
    assert.equal(setup.body.judge_gpus, 2);
    assert.equal(setup.body.cpus, 8);
    assert.equal(setup.body.memory_gib, 32);
    assert.equal(setup.body.pending, null);
    // The owner gives the judge's share with a new number of GPUs; not without one.
    const own = await mcpWith(s.api, ADMIN);
    assert.equal(
      (await own.call("set_cluster_rig_resources", { rig: "gpu-2", gpus: 6, judge_gpus: 4 })).body
        .said,
      "gpu-2's pods restart with 6 GPUs (4 for the judge, 2 for the agents), 8 CPUs and 32 GiB of memory.",
    );
    s.store.setClusterRigStatus("gpu-2", "running");
    assert.match(
      String(
        (await own.call("set_cluster_rig_resources", { rig: "gpu-2", judge_gpus: 3 })).body.error,
      ),
      /^judge_gpus goes with a new number of GPUs\. To change the split of gpu-2's 6 GPUs alone, use GPUs for the judge on Edit rig, or set_rig_settings\./,
    );
    assert.match(
      String((await own.call("set_cluster_rig_resources", { rig: "nope", cpus: 8 })).body.error),
      /Control didn't set nope up on a cluster/,
    );
    await op.close();
    await own.close();
    // REST: the owner's token.
    const rest = (body: unknown, rig = "gpu-2", token = ADMIN) =>
      s.api.request(`/v1/rigs/${rig}/cluster/resources`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let r = await rest({ cpus: 12, memory_gib: 40 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      rig: "gpu-2",
      said: "gpu-2's pods restart with 6 GPUs (4 for the judge, 2 for the agents), 12 CPUs and 40 GiB of memory.",
    });
    r = await rest({ cpus: 8 });
    assert.equal(r.status, 409);
    assert.match(String(((await r.json()) as { error: string }).error), /gpu-2 is being updated/);
    s.store.setClusterRigStatus("gpu-2", "running");
    r = await rest({ gpus: 0 });
    assert.equal(r.status, 400);
    assert.match(String(((await r.json()) as { error: string }).error), /can't move to none/);
    assert.equal((await rest({ storage_gb: 200 })).status, 400);
    assert.equal((await rest({ cpus: 8 }, "nope")).status, 404);
    assert.equal((await rest({ cpus: 8 }, "gpu-2", OPERATOR)).status, 401);
  });

  test("a busy rig drains before its new size: Call the change off, Change now, and the watcher once nothing runs", async () => {
    const { f, s, report } = await slotRig("gpu-3", 3, { drainWatchMs: 20 });
    report({ work: { trials: 1, judge_jobs: 0, draining: null } });
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/gpu-3/edit", { k_gpus: "4", k_cpus: "", k_mem: "" }),
      /ok=gpu-3 drains first: it starts nothing new, and its pods restart with 4 GPUs \(2 for the judge, 2 for the agents\), the namespace's default CPUs and memory once 1 trial finishes\./,
    );
    let r = s.store.clusterRig("gpu-3");
    assert.equal(r?.status, "draining");
    assert.deepEqual(r?.pending, { gpus: 4, judgeGpus: 2, by: "owner:ui" });
    assert.equal(r?.spec.gpus, 3);
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "no restart yet");
    assert.deepEqual(
      s.store
        .pendingCommands("gpu-3")
        .map((c) => c.envelope)
        .filter((e) => e.kind === "drain_rig")
        .map((e) => e.payload),
      [{ drain: true, reason: "its GPUs, CPUs or memory are about to change" }],
    );
    const page = await s.page("/ui/rigs/gpu-3");
    assert.match(
      page,
      /Draining before its pods restart with 4 GPUs \(2 for the judge, 2 for the agents\)/,
    );
    assert.match(page, /It waits for 1 trial to finish, and starts nothing new/);
    assert.match(page, /Change now, without waiting/);
    assert.match(page, /Call the change off/);
    // An image update meanwhile is refused: the drain is the change's.
    assert.match(
      await s.post("/ui/rigs/gpu-3/cluster/images", {}),
      /error=gpu-3 is draining for a change to its GPUs, CPUs or memory/,
    );
    // Called off: back to work as it was.
    assert.match(
      await s.post("/ui/rigs/gpu-3/cluster/drain-cancel", {}),
      /ok=gpu-3 goes back to work with its GPUs, CPUs and memory as they were\./,
    );
    r = s.store.clusterRig("gpu-3");
    assert.equal(r?.status, "running");
    assert.equal(r?.pending, undefined);
    assert.equal(r?.spec.gpus, 3);
    // Again, then Change now: its pods restart at once, while the trial still runs.
    await s.post("/ui/rigs/gpu-3/edit", { k_gpus: "4", k_cpus: "", k_mem: "" });
    assert.equal(s.store.clusterRig("gpu-3")?.status, "draining");
    assert.match(
      await s.post("/ui/rigs/gpu-3/cluster/resources-now", {}),
      /ok=gpu-3's pods restart with 4 GPUs/,
    );
    assert.ok(f.calls.some((c) => c.args[0] === "apply"));
    r = s.store.clusterRig("gpu-3");
    assert.equal(r?.spec.gpus, 4);
    assert.equal(r?.status, "updating");
    assert.equal(r?.pending, undefined);
    // Once more, to 5 GPUs: applied by the watcher when its report says nothing runs.
    s.store.setClusterRigStatus("gpu-3", "running");
    await s.post("/ui/rigs/gpu-3/edit", { k_gpus: "5", k_cpus: "", k_mem: "" });
    assert.equal(s.store.clusterRig("gpu-3")?.status, "draining");
    f.calls.length = 0;
    report({ work: { trials: 1, judge_jobs: 0, draining: { since: "x", reason: "r" } } });
    await sleep(100);
    assert.ok(!f.calls.some((c) => c.args[0] === "apply"), "not while its trial runs");
    report({ work: { trials: 0, judge_jobs: 0, draining: { since: "x", reason: "r" } } });
    for (let i = 0; i < 50 && !f.calls.some((c) => c.args[0] === "apply"); i++) await sleep(20);
    assert.equal(f.calls.filter((c) => c.args[0] === "apply").length, 1, "applied once");
    assert.equal(s.store.clusterRig("gpu-3")?.spec.gpus, 5);
    assert.equal(s.store.clusterRig("gpu-3")?.status, "updating");
    assert.match(
      s.store
        .rigSetupEvents("gpu-3")
        .map((e) => `${e.step}: ${e.detail ?? ""}`)
        .join("\n"),
      /drain: nothing runs any more: its pods restart now\nresources: GPUs 4 → 5 \(3 for the judge, 2 for the agents\)/,
    );
  });

  test("DRA: a new claim template for the new count, the old one deleted first; a stopped rig stays stopped; a CPU rig takes no GPUs", async () => {
    const f = fakeCluster({ deviceClasses: ["gpu.nvidia.com"] });
    const s = await control(f.k);
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-d",
      kubeconfig: KUBECONFIG,
      placement: "created",
      namespace_pattern: "thermite-{rig}",
    });
    assert.equal(
      await s.post("/ui/rigs/add", {
        place: "cluster:k8s-d",
        rig: "dra-1",
        "k_gpus__k8s-d": "2",
        "k_mode__k8s-d": "dra:gpu.nvidia.com",
      }),
      "/ui/rigs/dra-1",
    );
    await sleep(20);
    s.store.setClusterRigStatus("dra-1", "running");
    const reported = (rig: string) =>
      s.store.ingest({
        rig,
        ledger_id: "l-1",
        cursor: 0,
        next: 0,
        generated_at: new Date().toISOString(),
        events: [],
        summary: {},
      });
    reported("dra-1");
    assert.match(await s.post("/ui/rigs/dra-1/cluster/stop", {}), /ok=Stopped/);
    assert.match(
      await s.page("/ui/rigs/dra-1/edit"),
      /through DRA, the device class gpu\.nvidia\.com: 1 to 16/,
    );
    f.calls.length = 0;
    assert.match(
      await s.post("/ui/rigs/dra-1/edit", { k_gpus: "4", k_cpus: "6", k_mem: "24" }),
      /ok=dra-1 has 4 GPUs \(2 for the judge, 2 for the agents\), 6 CPUs and 24 GiB of memory when it starts again\./,
    );
    const del = f.calls.findIndex(
      (c) =>
        c.args.join(" ") ===
        "delete resourceclaimtemplate thermite-dra-1-gpus -n thermite-dra-1 --ignore-not-found",
    );
    const apply = f.calls.findIndex((c) => c.args[0] === "apply");
    assert.ok(del >= 0 && apply > del, "the old template goes first");
    const list = applied(f);
    assert.deepEqual(
      list.items.map((o) => o.kind),
      ["ResourceClaimTemplate", "Deployment", "Deployment"],
    );
    assert.equal(list.items[0]?.spec?.spec?.devices?.requests?.[0]?.exactly?.count, 4);
    // Stopped, it stays stopped.
    assert.deepEqual(
      list.items.filter((o) => o.kind === "Deployment").map((o) => o.spec?.replicas),
      [0, 0],
    );
    assert.deepEqual(container(list, "harness")?.resources, {
      requests: { cpu: "5500m", memory: "22528Mi" },
      limits: { cpu: "5500m", memory: "22528Mi" },
      claims: [{ name: "gpus" }],
    });
    assert.equal(s.store.clusterRig("dra-1")?.status, "stopped");
    assert.match(
      s.store
        .rigSetupEvents("dra-1")
        .map((e) => e.detail ?? "")
        .join("\n"),
      /GPUs 2 → 4 \(2 for the judge, 2 for the agents\); CPUs and memory: namespace defaults → 6 CPUs, 24 GiB; at its next start/,
    );
    // Only CPUs and memory: the claim template stays.
    f.calls.length = 0;
    await s.post("/ui/rigs/dra-1/edit", { k_gpus: "4", k_cpus: "8", k_mem: "24" });
    assert.ok(!f.calls.some((c) => c.args[0] === "delete"));
    // A rig on the CPU has no GPUs field, and takes no GPUs.
    assert.equal(
      await s.post("/ui/rigs/add", { place: "cluster:k8s-d", rig: "cpu-5", "k_gpus__k8s-d": "0" }),
      "/ui/rigs/cpu-5",
    );
    await sleep(20);
    s.store.setClusterRigStatus("cpu-5", "running");
    reported("cpu-5");
    const edit = await s.page("/ui/rigs/cpu-5/edit");
    assert.doesNotMatch(edit, /name="k_gpus"/);
    assert.match(edit, /name="k_cpus"/);
    assert.match(edit, /It measures on the CPU: a rig on the CPU can(&#39;|')t take GPUs/);
    assert.match(
      await s.post("/ui/rigs/cpu-5/edit", { k_gpus: "1", k_cpus: "", k_mem: "" }),
      /error=Not saved: cpu-5 measures on the CPU, and can't take GPUs/,
    );
  });
});
