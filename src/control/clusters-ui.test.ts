import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { createControlApi } from "./api.ts";
import type { ClusterKubectl } from "./clusters/kubectl.ts";
import { PRIVATE_RANGES } from "./clusters/netcheck.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";

const ADMIN = "admin-token-abcdef";
const KUBECONFIG =
  "apiVersion: v1\nkind: Config\nusers: [{ name: u, user: { token: secret-kube-token-789 } }]\n";

/** A cluster behind a fake kubectl: what it answers, and every call it got. */
function fakeCluster(o: { canCreateNamespaces?: boolean; slots?: Record<string, boolean> } = {}) {
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
                  allocatable: { cpu: "16", memory: "64Gi", "nvidia.com/gpu": "2" },
                  conditions: [{ type: "Ready", status: "True" }],
                },
              },
            ],
          }),
        );
      if (a === "get deviceclasses -o json")
        return {
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
      // The operators' network rule in slot 1: DNS and the internet without private ranges.
      const np = /^get networkpolicy -n (\S+) -o json$/.exec(a);
      if (np)
        return ok(
          JSON.stringify({
            items:
              np[1] === "thermite-slot-1"
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

async function control(k: ClusterKubectl) {
  const store = new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  const api = createControlApi(
    store,
    { admin: ADMIN, rigs: {} },
    generateSigningKeys().privateKeyPem,
    {
      staleAfterMs: 180_000,
      secrets,
      clusterKubectl: k,
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
  return { store, secrets, page, post };
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
});
