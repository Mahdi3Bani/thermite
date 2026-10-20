import { z } from "zod";
import { log } from "../common/env.ts";
import { McpConnection, McpUnavailable } from "../core/mcp.ts";
import { buildHeaders } from "../core/version.ts";

/**
 * The MCP servers control gives the rig (goal 068): those the kits of the runs it assigned the
 * rig name, each with its sign-in as headers. The supervisor reads them with its own token as it
 * reads the model route, hands the harness the servers its workers and planner use (the harness
 * makes their calls), and keeps the advisors' in memory for the calls it makes for them. Nothing
 * here writes a secret to disk or a log. An older control, with no such route, gives none.
 */

export interface McpSync {
  rig: string;
  controlUrl: string;
  controlToken: string;
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
}

const FromControl = z.object({
  servers: z.array(McpConnection).max(50),
  unavailable: z.array(McpUnavailable).max(50).default([]),
});
export type McpFromControl = z.infer<typeof FromControl>;

/**
 * One round: read control's servers; hand the harness its share when it changed. Returns what
 * control gave (all of it: the advisors' share stays with the supervisor).
 */
export async function syncMcpServers(
  s: McpSync,
): Promise<McpFromControl & { handed: "unchanged" | "set" | "no_agents" }> {
  const fetch = s.fetchImpl ?? globalThis.fetch;
  const res = await fetch(`${s.controlUrl}/v1/rigs/${encodeURIComponent(s.rig)}/mcp-servers`, {
    headers: { authorization: `Bearer ${s.controlToken}`, ...buildHeaders() },
  });
  if (res.status === 404) return { servers: [], unavailable: [], handed: "unchanged" };
  if (!res.ok) throw new Error(`control's MCP servers: HTTP ${res.status}`);
  const given = FromControl.parse(await res.json());
  // The harness gets only the servers its agents use: workers and the planner.
  const share = given.servers.filter((c) =>
    c.agents.some((a) => a === "workers" || a === "planner"),
  );
  const harness = { authorization: `Bearer ${s.harnessToken}` };
  const cur = await fetch(`${s.harnessUrl}/v1/mcp-servers`, { headers: harness });
  if (cur.status === 404) return { ...given, handed: "no_agents" };
  if (!cur.ok) throw new Error(`the harness's MCP servers: HTTP ${cur.status}`);
  const had = (await cur.json()) as {
    servers: { name: string; revision: string }[];
    unavailable: { name: string; why: string }[];
  };
  const key = (x: {
    servers: { name: string; revision: string }[];
    unavailable: { name: string; why: string }[];
  }) =>
    JSON.stringify([
      x.servers.map((c) => `${c.name}@${c.revision}`).sort(),
      x.unavailable.map((u) => `${u.name}:${u.why}`).sort(),
    ]);
  if (key(had) === key({ servers: share, unavailable: given.unavailable }))
    return { ...given, handed: "unchanged" };
  const put = await fetch(`${s.harnessUrl}/v1/mcp-servers`, {
    method: "PUT",
    headers: { ...harness, "content-type": "application/json" },
    body: JSON.stringify({ servers: share, unavailable: given.unavailable }),
  });
  if (!put.ok) throw new Error(`handing the MCP servers to the harness: HTTP ${put.status}`);
  log("supervisor", "MCP servers handed to the harness", {
    servers: share.map((c) => c.name),
    unavailable: given.unavailable.map((u) => u.name),
  });
  return { ...given, handed: "set" };
}
