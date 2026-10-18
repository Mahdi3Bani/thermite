#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Cluster acceptance: control sets rigs up on a Kubernetes cluster, and they report. A local kind
// cluster on Podman stands in for the cluster (never a real cluster). Control runs from its image
// on kind's network at a fixed address the rig pods reach. It is tested both ways:
//   created: an admin kubeconfig; control creates a namespace for the rig and its network rules;
//   slot:    a kubeconfig for a service account with a Role in one pre-made namespace only, as a
//            cluster's operators would give it; control deploys into that slot and nothing else.
// Each rig is a CPU rig and must report to control; then it is stopped, started and removed.
// Usage: COMPOSE="podman compose" node scripts/cluster-acceptance.mjs (Podman and kind needed).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEngine, compose, dc, secret, sh, until } from "./lib/smoke-env.mjs";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
  );
};
if (compose[0] !== "podman") {
  console.log("cluster acceptance: needs Podman (kind's Podman provider)");
  process.exit(1);
}
const cluster = "thermite-accept";
const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]; // public-check: allow (the RFC 1918 private ranges)
const ctl = "thermite-kind-control";
const kindEnv = { ...process.env, KIND_EXPERIMENTAL_PROVIDER: "podman" };
const kind = (...a) =>
  execFileSync("kind", a, { env: kindEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const kc = (...a) => sh("kubectl", ["--context", `kind-${cluster}`, ...a]);
const harnessImage = "docker.io/library/thermite-harness:latest";
const supervisorImage = "docker.io/library/thermite-supervisor:latest";
const work = mkdtempSync(join(tmpdir(), "thermite-cluster-"));

const cleanup = () => {
  try {
    sh("podman", ["rm", "-f", "-t", "3", ctl]);
  } catch {}
  try {
    kind("delete", "cluster", "--name", cluster);
  } catch {}
  rmSync(work, { recursive: true, force: true });
  cleanEngine();
};

sh("node", ["scripts/dev-init.mjs"]);
console.log("build the images; create the kind cluster; load the rig images into it");
dc({}, "build", "control", "harness", "supervisor");
try {
  kind("delete", "cluster", "--name", cluster);
} catch {}
try {
  kind("create", "cluster", "--name", cluster, "--wait", "180s");
  for (const image of [harnessImage, supervisorImage]) {
    const tar = join(work, "image.tar");
    sh("podman", ["save", "-o", tar, image]);
    kind("load", "image-archive", tar, "--name", cluster);
    rmSync(tar);
  }
  // Control on kind's network, at an address in its subnet the pods can reach.
  const subnet = sh("podman", [
    "network",
    "inspect",
    "kind",
    "--format",
    "{{range .Subnets}}{{.Subnet}} {{end}}",
  ])
    .split(" ")
    .find((s) => /^\d+\.\d+\.\d+\.0\/24$/.test(s));
  if (!subnet) throw new Error("kind's network has no IPv4 /24 subnet");
  const ip = subnet.replace(/\.0\/24$/, ".250");
  const admin = secret("control-admin-token");
  sh("podman", [
    "run",
    "-d",
    "--name",
    ctl,
    "--network",
    "kind",
    "--ip",
    ip,
    "-p",
    "127.0.0.1:8802:8800",
    "-e",
    "THERMITE_CONTROL_DIR=/var/lib/thermite-control",
    "-e",
    "THERMITE_CONTROL_LISTEN=0.0.0.0:8800",
    "-e",
    `THERMITE_CONTROL_ADMIN_TOKEN_SHA256=${createHash("sha256").update(admin).digest("hex")}`,
    "-e",
    `THERMITE_CONTROL_PUBLIC_URL=http://${ip}:8800`,
    "-e",
    `THERMITE_RIG_HARNESS_IMAGE=${harnessImage}`,
    "-e",
    `THERMITE_RIG_SUPERVISOR_IMAGE=${supervisorImage}`,
    "docker.io/library/thermite-control:latest",
  ]);
  const control = "http://127.0.0.1:8802";
  await until("control answers", async () => (await fetch(`${control}/v1/health`)).ok, 120_000);
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: admin }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const get = async (path) => (await fetch(`${control}${path}`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await get("/ui/settings"))?.[1] ?? "";
  const post = async (path, form) => {
    const r = await fetch(`${control}${path}`, {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: { cookie },
      redirect: "manual",
    });
    return decodeURIComponent(String(r.headers.get("location")));
  };
  /** Adds a rig and waits until its page says its first report arrived (or a step failed). */
  const rigUp = async (form, rig) => {
    const made = await post("/ui/rigs/add", { ...form, rig });
    if (made !== `/ui/rigs/${rig}`) return `not taken: ${made}`;
    return until(
      `${rig} reports`,
      async () => {
        const h = await get(`/ui/rigs/${rig}`);
        if (/First report reached control/.test(h)) return "reported";
        const failed =
          /<span class="bad">✕<\/span><span>([^<]*)(?:<span class="muted small">· ([^<]*)<\/span>)?/.exec(
            h,
          );
        if (failed) return `failed: ${failed[1]} ${failed[2] ?? ""}`;
        return undefined;
      },
      900_000,
      5000,
    ).catch((e) => String(e?.message ?? e));
  };

  // ---------------------------------------------------------------- created namespaces
  const internal = kind("get", "kubeconfig", "--internal", "--name", cluster);
  const added = await post("/ui/settings/add", {
    type: "k8s",
    name: "kind-admin",
    kubeconfig: internal,
    placement: "created",
    namespace_pattern: "thermite-{rig}",
  });
  check(
    "control read the cluster with kubectl from its image",
    /is added and checked/.test(added),
    added,
  );
  const html = await get("/ui/settings");
  check(
    "the check found the version, the node, the storage class and the right to create namespaces",
    /Kubernetes v1\.\d+/.test(html) &&
      /standard \(default\)/.test(html) &&
      /control may create namespaces/.test(html),
    html
      .match(/<div class="dq-body"><dl class="facts"><dt>Version[\s\S]*?<\/dl>/)?.[0]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  );
  const created = await rigUp(
    {
      place: "cluster:kind-admin",
      "k_gpus__kind-admin": "0",
      "k_storage__kind-admin": "standard",
      "k_size__kind-admin": "5",
    },
    "kind-rig-1",
  );
  check(
    "a rig in a namespace of its own was applied, started and reported",
    created === "reported",
    created,
  );
  check(
    "its namespace holds its two deployments and network rules",
    /thermite-kind-rig-1-harness/.test(
      kc("get", "deploy,networkpolicy", "-n", "thermite-kind-rig-1", "-o", "name"),
    ),
    kc("get", "deploy,networkpolicy", "-n", "thermite-kind-rig-1", "-o", "name").trim(),
  );
  check(
    "stop scales it to nothing",
    /ok=Stopped/.test(await post("/ui/rigs/kind-rig-1/cluster/stop", {})) &&
      kc(
        "get",
        "deploy",
        "-n",
        "thermite-kind-rig-1",
        "-o",
        "jsonpath={.items[*].spec.replicas}",
      ).trim() === "0 0",
  );
  check(
    "start brings it back",
    /ok=Started/.test(await post("/ui/rigs/kind-rig-1/cluster/start", {})),
  );
  check(
    "remove deletes its namespace",
    /ok=Removed from the cluster/.test(
      await post("/ui/rigs/kind-rig-1/cluster/remove", { confirm: "remove kind-rig-1" }),
    ),
  );

  // ---------------------------------------------------------------- a pre-made slot
  kc("create", "namespace", "thermite-slot-1");
  kc("create", "serviceaccount", "thermite-control", "-n", "thermite-slot-1");
  kc(
    "create",
    "role",
    "thermite-control",
    "-n",
    "thermite-slot-1",
    "--verb=get,list,watch,create,update,patch,delete",
    "--resource=deployments.apps,services,persistentvolumeclaims,secrets,pods,resourceclaimtemplates.resource.k8s.io",
  );
  kc(
    "create",
    "rolebinding",
    "thermite-control",
    "-n",
    "thermite-slot-1",
    "--role=thermite-control",
    "--serviceaccount=thermite-slot-1:thermite-control",
  );
  // Control reads the slot's network rules, and writes none.
  kc(
    "create",
    "role",
    "thermite-control-read",
    "-n",
    "thermite-slot-1",
    "--verb=get,list",
    "--resource=networkpolicies.networking.k8s.io",
  );
  kc(
    "create",
    "rolebinding",
    "thermite-control-read",
    "-n",
    "thermite-slot-1",
    "--role=thermite-control-read",
    "--serviceaccount=thermite-slot-1:thermite-control",
  );
  const token = kc(
    "create",
    "token",
    "thermite-control",
    "-n",
    "thermite-slot-1",
    "--duration=2h",
  ).trim();
  const ca = /certificate-authority-data: (\S+)/.exec(internal)?.[1];
  const server = /server: (\S+)/.exec(internal)?.[1];
  const slotConfig = `apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: ${server}\n    certificate-authority-data: ${ca}\nusers:\n- name: u\n  user:\n    token: ${token}\ncontexts:\n- name: slot\n  context: {cluster: c, user: u}\ncurrent-context: slot\n`;
  writeFileSync(join(work, "slot.kubeconfig"), slotConfig, { mode: 0o600 });
  await post("/ui/settings/add", {
    type: "k8s",
    name: "kind-slots",
    kubeconfig: slotConfig,
    placement: "slot",
    slots: "thermite-slot-1, thermite-slot-2",
  });
  let slots = await get("/ui/settings");
  check(
    "with a namespaced role, control may deploy into its slot and nowhere else",
    /thermite-slot-2: <span class="chip warn">control may not deploy here/.test(slots),
  );
  // Without a rule that keeps the harness off the cluster, the slot is refused.
  check(
    "a slot whose network rules don't keep the harness off the cluster is refused",
    /thermite-slot-1: <span class="chip warn">refused: no network rule/.test(slots) &&
      /Refused: in the slot thermite-slot-1/.test(
        await post("/ui/rigs/add", {
          place: "cluster:kind-slots",
          rig: "slot-rig-0",
          "k_gpus__kind-slots": "0",
          "k_slot__kind-slots": "thermite-slot-1",
        }),
      ),
  );
  // The operators' rule: the harness reaches DNS and the internet, not private addresses.
  const rule = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "thermite-harness", namespace: "thermite-slot-1" },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/component": "harness" } },
      policyTypes: ["Egress"],
      egress: [
        {
          ports: [
            { port: 53, protocol: "UDP" },
            { port: 53, protocol: "TCP" },
          ],
        },
        {
          to: [
            {
              ipBlock: {
                cidr: "0.0.0.0/0",
                except: privateRanges,
              },
            },
          ],
        },
      ],
    },
  };
  sh("kubectl", ["--context", `kind-${cluster}`, "apply", "-f", "-"], {
    input: JSON.stringify(rule),
    stdio: ["pipe", "pipe", "inherit"],
  });
  await post("/ui/settings/clusters/kind-slots/check", {});
  slots = await get("/ui/settings");
  check(
    "with the operators' rule, the slot is free",
    /thermite-slot-1: <span class="chip ok">free/.test(slots),
  );
  const inSlot = await rigUp(
    {
      place: "cluster:kind-slots",
      "k_gpus__kind-slots": "0",
      "k_slot__kind-slots": "thermite-slot-1",
      "k_storage__kind-slots": "standard",
      "k_size__kind-slots": "5",
    },
    "slot-rig-1",
  );
  check("a rig in the slot was applied, started and reported", inSlot === "reported", inSlot);
  check(
    "remove takes its objects out of the slot, and leaves the slot",
    /ok=Removed from the cluster/.test(
      await post("/ui/rigs/slot-rig-1/cluster/remove", { confirm: "remove slot-rig-1" }),
    ) && /thermite-slot-1/.test(kc("get", "namespace", "thermite-slot-1", "-o", "name")),
  );
} catch (err) {
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  cleanup();
}
const ok = results.every((r) => r.ok);
console.log(ok ? "cluster acceptance: OK" : "cluster acceptance: FAILED");
process.exit(ok ? 0 : 1);
