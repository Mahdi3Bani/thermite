import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { log } from "../common/env.ts";
import { issueCommand } from "./issue.ts";
import type { ControlStore } from "./store.ts";
import { unitView } from "./views.ts";

/**
 * Lifecycle: restarting a unit's containers, and the owner's full reset. Pause and resume are
 * app commands; restarts go through a deployment driver:
 *
 * - Kubernetes: control's service account deletes the unit's pods (its Role allows pods get,
 *   list and delete in the unit's namespace, nothing else); the Deployment recreates them.
 * - Compose: the container engine's API (Docker or Podman) restarts the unit's containers.
 *
 * A full reset: pause the unit's running instances, export, wait until the supervisor reports
 * that export pushed to the results repository, then the signed wipe_state (the harness and the
 * supervisor wipe their own state and restart), then a restart through the driver.
 */

export type Component = "harness" | "supervisor";

export interface DeploymentDriver {
  readonly kind: string;
  restart(unit: string, components: Component[]): Promise<string[]>;
}

/** One HTTP(S) request with a JSON body, over TCP or a Unix socket. */
function call(
  url: URL,
  method: string,
  opts: { headers?: Record<string, string>; ca?: string; socketPath?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = send(
      {
        protocol: url.protocol,
        hostname: opts.socketPath ? undefined : url.hostname,
        port: opts.socketPath ? undefined : url.port,
        socketPath: opts.socketPath,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        ...(opts.ca ? { ca: opts.ca } : {}),
        timeout: 30_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          text += d;
        });
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export interface KubernetesOptions {
  /** API server; in a pod, https://kubernetes.default.svc. */
  apiUrl: string;
  token: string;
  ca?: string | undefined;
  /** Namespace per unit, with {unit} replaced (default ar-{unit}). */
  namespaceTemplate: string;
  /** Label selector per component (default app.kubernetes.io/component=<component>). */
  selectors: Record<Component, string>;
}

export class KubernetesDriver implements DeploymentDriver {
  readonly kind = "kubernetes";
  private readonly o: KubernetesOptions;

  constructor(o: KubernetesOptions) {
    this.o = o;
  }

  /** In-cluster configuration from the pod's service account. */
  static inCluster(env: NodeJS.ProcessEnv = process.env): KubernetesDriver {
    const sa = "/var/run/secrets/kubernetes.io/serviceaccount";
    return new KubernetesDriver({
      apiUrl: env.THERMITE_K8S_API ?? "https://kubernetes.default.svc",
      token: readFileSync(env.THERMITE_K8S_TOKEN_FILE ?? `${sa}/token`, "utf8").trim(),
      ca: readFileSync(env.THERMITE_K8S_CA_FILE ?? `${sa}/ca.crt`, "utf8"),
      namespaceTemplate: env.THERMITE_K8S_NAMESPACE ?? "ar-{unit}",
      selectors: {
        harness: env.THERMITE_K8S_SELECTOR_HARNESS ?? "app.kubernetes.io/component=harness",
        supervisor:
          env.THERMITE_K8S_SELECTOR_SUPERVISOR ?? "app.kubernetes.io/component=supervisor",
      },
    });
  }

  async restart(unit: string, components: Component[]): Promise<string[]> {
    if (!/^[a-z0-9-]{1,40}$/.test(unit)) throw new Error(`not a unit name: ${unit}`);
    const ns = this.o.namespaceTemplate.replace("{unit}", unit);
    const headers = { authorization: `Bearer ${this.o.token}` };
    const deleted: string[] = [];
    for (const c of components) {
      const list = await call(
        new URL(
          `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(this.o.selectors[c])}`,
          this.o.apiUrl,
        ),
        "GET",
        { headers, ca: this.o.ca },
      );
      if (list.status !== 200) throw new Error(`listing ${c} pods in ${ns}: HTTP ${list.status}`);
      const pods = ((list.body as { items?: { metadata: { name: string } }[] }).items ?? []).map(
        (p) => p.metadata.name,
      );
      if (!pods.length) throw new Error(`no ${c} pod in ${ns}`);
      for (const name of pods) {
        const r = await call(
          new URL(`/api/v1/namespaces/${ns}/pods/${encodeURIComponent(name)}`, this.o.apiUrl),
          "DELETE",
          { headers, ca: this.o.ca },
        );
        if (r.status !== 200 && r.status !== 202)
          throw new Error(`deleting ${ns}/${name}: HTTP ${r.status}`);
        deleted.push(`${ns}/${name}`);
      }
    }
    return deleted;
  }
}

export interface ComposeOptions {
  /** The engine's API socket (Docker or Podman's Docker-compatible API). */
  socketPath: string;
  project: string;
  /** unit -> component -> compose service name. */
  services: Record<string, Partial<Record<Component, string>>>;
}

export class ComposeDriver implements DeploymentDriver {
  readonly kind = "compose";
  private readonly o: ComposeOptions;

  constructor(o: ComposeOptions) {
    this.o = o;
  }

  async restart(unit: string, components: Component[]): Promise<string[]> {
    const base = new URL("http://engine");
    const restarted: string[] = [];
    for (const c of components) {
      const service = this.o.services[unit]?.[c];
      if (!service) throw new Error(`no ${c} service configured for ${unit}`);
      const filters = JSON.stringify({
        label: [
          `com.docker.compose.project=${this.o.project}`,
          `com.docker.compose.service=${service}`,
        ],
      });
      const list = await call(
        new URL(`/containers/json?all=1&filters=${encodeURIComponent(filters)}`, base),
        "GET",
        { socketPath: this.o.socketPath },
      );
      if (list.status !== 200) throw new Error(`listing ${service}: HTTP ${list.status}`);
      const ids = ((list.body as { Id: string }[]) ?? []).map((x) => x.Id);
      if (!ids.length) throw new Error(`no container for service ${service}`);
      for (const id of ids) {
        const r = await call(new URL(`/containers/${id}/restart?t=10`, base), "POST", {
          socketPath: this.o.socketPath,
        });
        if (r.status !== 204 && r.status !== 200)
          throw new Error(`restarting ${service}: HTTP ${r.status}`);
        restarted.push(service);
      }
    }
    return restarted;
  }
}

/** The driver configured for this control, if any. */
export function driverFromEnv(env: NodeJS.ProcessEnv = process.env): DeploymentDriver | undefined {
  if (env.THERMITE_LIFECYCLE === "kubernetes") return KubernetesDriver.inCluster(env);
  if (env.THERMITE_LIFECYCLE === "compose") {
    return new ComposeDriver({
      socketPath: env.THERMITE_ENGINE_SOCKET ?? "/run/engine.sock",
      project: env.THERMITE_COMPOSE_PROJECT ?? "thermite",
      services: JSON.parse(env.THERMITE_COMPOSE_SERVICES ?? "{}") as ComposeOptions["services"],
    });
  }
  return undefined;
}

/**
 * Advances every open full reset by one step. Each step waits for evidence before the next:
 * the export's command result, the supervisor's report of that export pushed, the harness's
 * acceptance of the wipe and its new ledger.
 */
export async function advanceResets(input: {
  store: ControlStore;
  privateKeyPem: string;
  driver: DeploymentDriver | undefined;
  staleAfterMs: number;
}): Promise<void> {
  const { store } = input;
  for (const r of store.resets(50).filter((x) => !["done", "failed"].includes(String(x.state)))) {
    const id = Number(r.id);
    const unit = String(r.unit);
    const issue = (kind: "pause_instance" | "export_now" | "wipe_state", payload: unknown) =>
      issueCommand(store, input.privateKeyPem, {
        unit,
        kind,
        payload,
        ttlMinutes: 30,
        issuedBy: `reset:${String(r.requested_by)}`,
      }).id;
    const fail = (detail: string) => {
      store.updateReset(id, { state: "failed", detail });
      log("control", "reset failed", { unit, detail });
    };
    try {
      switch (String(r.state)) {
        case "start": {
          const v = unitView(store, unit, { staleAfterMs: input.staleAfterMs });
          for (const i of v?.instances.filter((x) => x.status === "running") ?? []) {
            issue("pause_instance", { instance: i.id, reason: "full reset" });
          }
          store.updateReset(id, { state: "exporting", command: issue("export_now", {}) });
          break;
        }
        case "exporting": {
          const c = store.command(String(r.command));
          if (!c || c.status === "pending") break;
          const out = (c.outcome ?? {}) as {
            result?: { export?: string; through_event?: number };
            accepted?: boolean;
          };
          const result = out.result ?? (c.outcome as { export?: string; through_event?: number });
          if (c.status !== "delivered" || !result?.export) {
            fail(`the export did not complete (${c.status})`);
            break;
          }
          store.updateReset(id, {
            state: "verifying",
            export_name: result.export,
            through_event: Number(result.through_event ?? 0),
          });
          break;
        }
        case "verifying": {
          // The supervisor reports what reached the results repository.
          const sup = store.supervisor(unit) as {
            export?: { remote?: boolean; pushed?: string[] };
          } | null;
          if (sup?.export && sup.export.remote === false) {
            fail("the unit has no results repository: its export cannot be verified (D24)");
            break;
          }
          if (!sup?.export?.pushed?.includes(String(r.export_name))) break;
          store.updateReset(id, {
            state: "wiping",
            command: issue("wipe_state", {
              confirm: "wipe",
              export: String(r.export_name),
              through_event: Number(r.through_event),
            }),
          });
          break;
        }
        case "wiping": {
          const c = store.command(String(r.command));
          if (!c || c.status === "pending") break;
          if (c.status !== "delivered") {
            fail(`the harness refused the wipe: ${JSON.stringify(c.outcome).slice(0, 300)}`);
            break;
          }
          let restarted: string[] = [];
          if (input.driver) restarted = await input.driver.restart(unit, ["harness", "supervisor"]);
          store.updateReset(id, {
            state: "done",
            detail: input.driver
              ? `wiped; restarted ${restarted.join(", ")}`
              : "wiped; the unit restarted itself (no deployment driver configured)",
          });
          break;
        }
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
}
