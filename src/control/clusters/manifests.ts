import { gpuSplit } from "../machines/deploy.ts";

/**
 * A rig on a Kubernetes cluster, as the objects control applies with `kubectl apply -f -`: the
 * same two parts as the compose rig (harness and supervisor, each its own pod, so network rules
 * can tell them apart), sharing one volume on one node for the inbox and outbox. Two placements:
 * a namespace control creates for the rig (with its own network rules), or a slot the cluster's
 * operators made in advance (their quotas, admission rules and network rules; control only
 * deploys into it). GPUs come through NVIDIA's device plugin or through DRA.
 */

export interface ClusterRigPlan {
  rig: string;
  /**
   * created: control makes the namespace and its network rules; slot: it exists already, with
   * the operators' rules; joined: it exists already, and the operator applies the rig's objects
   * with its network rules (join.ts).
   */
  placement: "created" | "slot" | "joined";
  namespace: string;
  controlUrl: string;
  images: { harness: string; supervisor: string };
  /** GPUs for the rig: 0 (CPU), 1 (shared by the judge and agents) or several (split). */
  gpus: number;
  /** With two or more GPUs, how many are the judge's (default: half, rounded up). */
  judgeGpus?: number | undefined;
  /** How GPUs are asked for. */
  gpuMode: "device-plugin" | "dra";
  /** The DRA device class, when gpuMode is dra. */
  deviceClass?: string | undefined;
  /** A node to keep the rig on, or any node with room. */
  node?: string | undefined;
  storageClass?: string | undefined;
  storageGi: number;
  controlPublicKey: string;
}

export interface ClusterRigSecrets {
  controlToken: string;
  harnessSupervisorToken: string;
}

type Obj = Record<string, unknown>;

export const clusterNames = (rig: string) => ({
  secret: `thermite-${rig}`,
  volume: `thermite-${rig}-data`,
  harness: `thermite-${rig}-harness`,
  supervisor: `thermite-${rig}-supervisor`,
  gpus: `thermite-${rig}-gpus`,
});

const labels = (rig: string, component?: "harness" | "supervisor") => ({
  "app.kubernetes.io/name": "thermite",
  "app.kubernetes.io/instance": rig,
  "app.kubernetes.io/managed-by": "thermite-control",
  ...(component ? { "app.kubernetes.io/component": component } : {}),
});

/** Prepares the shared volume's folders for both pods' users, as the compose images do. */
const prepare = (image: string): Obj => ({
  name: "prepare",
  image,
  imagePullPolicy: "IfNotPresent",
  command: [
    "sh",
    "-c",
    "mkdir -p /data/state /data/scratch /data/inbox/repos /data/inbox/models /data/outbox /data/supervisor && chown -R 10001:10001 /data/inbox /data/supervisor && chown 10010:10001 /data/outbox && chmod 2750 /data/outbox",
  ],
  securityContext: {
    runAsUser: 0,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
  },
  volumeMounts: [{ name: "data", mountPath: "/data" }],
});

/** The objects for one rig, in the order they are applied. */
export function clusterRigObjects(p: ClusterRigPlan, s: ClusterRigSecrets): Obj[] {
  const split = gpuSplit(p.gpus, p.judgeGpus);
  if (p.gpus > 0 && p.gpuMode === "dra" && !p.deviceClass)
    throw new Error("a DRA rig needs its device class");
  const n = clusterNames(p.rig);
  const ns = p.namespace;
  const meta = (name: string, component?: "harness" | "supervisor") => ({
    name,
    namespace: ns,
    labels: labels(p.rig, component),
  });
  const together = {
    // Both pods share one volume, so they run on one node.
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: { matchLabels: { "app.kubernetes.io/instance": p.rig } },
          topologyKey: "kubernetes.io/hostname",
        },
      ],
    },
  };
  const placement = p.node ? { nodeSelector: { "kubernetes.io/hostname": p.node } } : {};
  const env = (pairs: Record<string, string>) =>
    Object.entries(pairs).map(([name, value]) => ({ name, value }));
  const gpu = p.gpus > 0;
  const deployment = (component: "harness" | "supervisor", pod: Obj): Obj => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: meta(component === "harness" ? n.harness : n.supervisor, component),
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: {
        matchLabels: {
          "app.kubernetes.io/instance": p.rig,
          "app.kubernetes.io/component": component,
        },
      },
      template: { metadata: { labels: labels(p.rig, component) }, spec: pod },
    },
  });
  const objects: Obj[] = [];
  if (p.placement === "created")
    objects.push({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: ns, labels: labels(p.rig) },
    });
  objects.push(
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: meta(n.secret),
      type: "Opaque",
      stringData: {
        "control-rig-token": s.controlToken,
        "harness-supervisor-token": s.harnessSupervisorToken,
        "control-signing.pub": p.controlPublicKey,
      },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta(n.volume),
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: `${p.storageGi}Gi` } },
        ...(p.storageClass ? { storageClassName: p.storageClass } : {}),
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(n.harness, "harness"),
      spec: {
        selector: { "app.kubernetes.io/instance": p.rig, "app.kubernetes.io/component": "harness" },
        ports: [{ name: "api", port: 8700, targetPort: 8700 }],
      },
    },
  );
  if (gpu && p.gpuMode === "dra")
    objects.push({
      apiVersion: "resource.k8s.io/v1",
      kind: "ResourceClaimTemplate",
      metadata: meta(n.gpus, "harness"),
      spec: {
        spec: {
          devices: {
            requests: [
              { name: "gpus", exactly: { deviceClassName: p.deviceClass, count: p.gpus } },
            ],
          },
        },
      },
    });
  const secretFile = (key: string, path: string) => ({
    name: "secrets",
    mountPath: path,
    subPath: key,
    readOnly: true,
  });
  objects.push(
    deployment("harness", {
      affinity: together,
      ...placement,
      initContainers: [prepare(p.images.harness)],
      containers: [
        {
          name: "harness",
          image: p.images.harness,
          imagePullPolicy: "IfNotPresent",
          env: env({
            THERMITE_RIG_ID: p.rig,
            THERMITE_TARGET: gpu ? "cuda-gpu" : "cpu",
            ...split,
            THERMITE_CONTROL_PUBKEY_FILE: "/keys/control-signing.pub",
            THERMITE_SUPERVISOR_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
          }),
          ports: [{ containerPort: 8700, name: "api" }],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: {
              drop: ["ALL"],
              add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"],
            },
          },
          resources:
            gpu && p.gpuMode === "device-plugin"
              ? { limits: { "nvidia.com/gpu": p.gpus } }
              : gpu
                ? { claims: [{ name: "gpus" }] }
                : {},
          volumeMounts: [
            { name: "data", mountPath: "/var/lib/thermite", subPath: "state" },
            { name: "data", mountPath: "/scratch", subPath: "scratch" },
            { name: "data", mountPath: "/inbox", subPath: "inbox", readOnly: true },
            { name: "data", mountPath: "/outbox", subPath: "outbox" },
            secretFile("control-signing.pub", "/keys/control-signing.pub"),
            secretFile("harness-supervisor-token", "/run/secrets/harness-supervisor-token"),
          ],
        },
      ],
      ...(gpu && p.gpuMode === "dra"
        ? { resourceClaims: [{ name: "gpus", resourceClaimTemplateName: n.gpus }] }
        : {}),
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: n.volume } },
        { name: "secrets", secret: { secretName: n.secret, defaultMode: 0o444 } },
      ],
    }),
    deployment("supervisor", {
      affinity: together,
      ...placement,
      initContainers: [prepare(p.images.harness)],
      securityContext: { runAsUser: 10001, runAsGroup: 10001 },
      containers: [
        {
          name: "supervisor",
          image: p.images.supervisor,
          imagePullPolicy: "IfNotPresent",
          env: env({
            THERMITE_RIG_ID: p.rig,
            HARNESS_URL: `http://${n.harness}:8700`,
            CONTROL_URL: p.controlUrl.replace(/\/$/, ""),
            THERMITE_HARNESS_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
            THERMITE_CONTROL_TOKEN_FILE: "/run/secrets/control-rig-token",
          }),
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          volumeMounts: [
            { name: "data", mountPath: "/var/lib/thermite-supervisor", subPath: "supervisor" },
            { name: "data", mountPath: "/inbox", subPath: "inbox" },
            { name: "data", mountPath: "/outbox", subPath: "outbox", readOnly: true },
            secretFile("harness-supervisor-token", "/run/secrets/harness-supervisor-token"),
            secretFile("control-rig-token", "/run/secrets/control-rig-token"),
          ],
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: n.volume } },
        { name: "secrets", secret: { secretName: n.secret, defaultMode: 0o444 } },
      ],
    }),
  );
  if (p.placement === "created" || p.placement === "joined") {
    const cluster = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]; // public-check: allow (the RFC 1918 private ranges, not addresses of any network)
    objects.push(
      {
        // The harness reaches DNS and the internet, not the cluster or control; only its
        // supervisor reaches it.
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: meta(`${n.harness}-net`, "harness"),
        spec: {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/instance": p.rig,
              "app.kubernetes.io/component": "harness",
            },
          },
          policyTypes: ["Ingress", "Egress"],
          ingress: [
            {
              from: [
                {
                  podSelector: {
                    matchLabels: {
                      "app.kubernetes.io/instance": p.rig,
                      "app.kubernetes.io/component": "supervisor",
                    },
                  },
                },
              ],
              ports: [{ port: 8700, protocol: "TCP" }],
            },
          ],
          egress: [
            {
              ports: [
                { port: 53, protocol: "UDP" },
                { port: 53, protocol: "TCP" },
              ],
            },
            { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: cluster } }] },
          ],
        },
      },
      {
        // The supervisor takes no connections.
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: meta(`${n.supervisor}-net`, "supervisor"),
        spec: {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/instance": p.rig,
              "app.kubernetes.io/component": "supervisor",
            },
          },
          policyTypes: ["Ingress"],
          ingress: [],
        },
      },
    );
  }
  return objects;
}

/** The objects as one document `kubectl apply -f -` reads (JSON is YAML). */
export const asList = (items: Obj[]) => JSON.stringify({ apiVersion: "v1", kind: "List", items });
