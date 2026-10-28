import { log } from "../../common/env.ts";
import type { ConfigKey } from "../../core/link/config.ts";
import type { McpConnection, McpUnavailable } from "../../core/mcp.ts";
import { handMcpServers, syncMcpServers } from "../mcp-sync.ts";
import { handModelRoute, syncModelRouteRound } from "../model-route.ts";
import type { RigConfig } from "./bus.ts";

/**
 * Keeps the rig's agents on control's config: the model route and the MCP servers, handed to the
 * harness, and the advisors' share of the servers. Without the message bus, the supervisor polls
 * control for them every THERMITE_MODEL_ROUTE_POLL_SECONDS, as before. With it, the polls go:
 * each value comes from the rig's config on the bus and is applied as it comes (bus.ts), and on
 * that beat the supervisor only looks at its own harness, handing over again what the harness
 * lost, as after the harness restarted.
 */

/** What keeping the config needs. */
export interface KeepConfig {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** The rig's config from the bus; none: the polls. */
  known?: RigConfig | undefined;
  /** The advisors' MCP servers, which the supervisor calls for them. */
  setAdvisorMcp: (servers: McpConnection[], unavailable: McpUnavailable[]) => void;
  /** How often to look, in milliseconds; 0: never. */
  everyMs: number;
  stopping: () => boolean;
  pause: (ms: number) => Promise<void>;
}

/** The servers the advisors use, of those control gave. */
const advisorsShare = (servers: McpConnection[]) =>
  servers.filter((c) => c.agents.includes("advisors"));

/**
 * Hands what the rig's config from the bus holds for `key` to where it is used: the route to the
 * harness, the MCP servers to the advisors and to the harness, each only when it changed. The
 * advisors' routes need nothing here: the advisors' next round reads them. A key with no value
 * yet changes nothing. Throws when the harness can't be reached.
 */
export async function applyConfig(k: KeepConfig, known: RigConfig, key: ConfigKey): Promise<void> {
  if (key === "model-route") {
    const given = known.get("model-route");
    if (given) await handModelRoute(k, given);
  } else if (key === "mcp-servers") {
    const given = known.get("mcp-servers");
    if (!given) return;
    k.setAdvisorMcp(advisorsShare(given.servers), given.unavailable);
    await handMcpServers(k, given);
  }
}

/** One look: the polls without the bus; with it, the harness against what the bus gave. */
async function lookOnce(k: KeepConfig, failing: { route: boolean; mcp: boolean }): Promise<void> {
  const said = (what: "route" | "mcp", err?: unknown) => {
    if (err === undefined) {
      failing[what] = false;
      return;
    }
    const error = String(err).slice(0, 300);
    if (!failing[what])
      log(
        "supervisor",
        what === "route" ? "model route error" : "MCP servers error",
        { error },
        "error",
      );
    failing[what] = true;
  };
  const { known, controlUrl, controlToken } = k;
  if (known) {
    await applyConfig(k, known, "model-route").then(
      () => said("route"),
      (err) => said("route", err),
    );
    await applyConfig(k, known, "mcp-servers").then(
      () => said("mcp"),
      (err) => said("mcp", err),
    );
    return;
  }
  if (!controlUrl || !controlToken) return;
  const poll = {
    rig: k.rig,
    controlUrl,
    controlToken,
    harnessUrl: k.harnessUrl,
    harnessToken: k.harnessToken,
    fetchImpl: k.fetchImpl,
  };
  // A failure is tried again after 5 s before it is logged (control may still be starting).
  await syncModelRouteRound(poll, Math.min(5000, k.everyMs), k.pause).then(
    () => said("route"),
    (err) => said("route", err),
  );
  // Control or the harness unreachable: the servers they gave last stay.
  await syncMcpServers(poll).then(
    (r) => {
      k.setAdvisorMcp(advisorsShare(r.servers), r.unavailable);
      said("mcp");
    },
    (err) => said("mcp", err),
  );
}

/** Looks every `everyMs` until the supervisor stops. */
export async function keepConfig(k: KeepConfig): Promise<void> {
  const failing = { route: false, mcp: false };
  while (!k.stopping() && k.everyMs > 0 && (k.known || (k.controlUrl && k.controlToken))) {
    await lookOnce(k, failing);
    await k.pause(k.everyMs);
  }
}
