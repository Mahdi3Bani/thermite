import type { z } from "zod";
import { ApiError } from "../common/api/call.ts";
import { controlClient } from "../common/api/control.ts";
import { harnessClient } from "../common/api/harness.ts";
import { log } from "../common/env.ts";
import { MCP_SERVERS } from "../core/api/control/rigs.ts";
import { MCP_SERVERS_GET, MCP_SERVERS_PUT } from "../core/api/harness/supervisor.ts";

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

export type McpFromControl = z.infer<typeof MCP_SERVERS.answer>;

/** A call's answer, or undefined when the route answers 404: an older control, or no agents. */
async function unlessMissing<T>(call: Promise<T>): Promise<T | undefined> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") return undefined;
    throw err;
  }
}

/**
 * One round: read control's servers; hand the harness its share when it changed. Returns what
 * control gave (all of it: the advisors' share stays with the supervisor).
 */
export async function syncMcpServers(
  s: McpSync,
): Promise<McpFromControl & { handed: "unchanged" | "set" | "no_agents" }> {
  const control = controlClient({
    url: s.controlUrl,
    token: s.controlToken,
    rig: s.rig,
    fetchImpl: s.fetchImpl,
  });
  const harness = harnessClient({
    url: s.harnessUrl,
    token: s.harnessToken,
    fetchImpl: s.fetchImpl,
  });
  const answer = await unlessMissing(control.call(MCP_SERVERS));
  if (!answer) return { servers: [], unavailable: [], handed: "unchanged" };
  // With what control left out filled in: no kind of agent, nothing unavailable.
  const given = MCP_SERVERS.answer.parse(answer);
  // The harness gets only the servers its agents use: workers and the planner.
  const share = given.servers.filter((c) =>
    c.agents.some((a) => a === "workers" || a === "planner"),
  );
  const had = await unlessMissing(harness.call(MCP_SERVERS_GET));
  if (!had) return { ...given, handed: "no_agents" };
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
  await harness.call(MCP_SERVERS_PUT, { body: { servers: share, unavailable: given.unavailable } });
  log("supervisor", "MCP servers handed to the harness", {
    servers: share.map((c) => c.name),
    unavailable: given.unavailable.map((u) => u.name),
  });
  return { ...given, handed: "set" };
}
