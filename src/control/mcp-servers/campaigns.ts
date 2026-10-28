import type { DatabaseSync } from "node:sqlite";
import { AGENT_KINDS, type AgentKind, type McpUse, McpUses } from "../../core/mcp.ts";
import type { ControlStore } from "../store.ts";
import { ensureMcpTables, type McpTool, mcpServerNames, type Row, str } from "./table.ts";

/**
 * Which servers campaigns and runs name: why an assignment or a research campaign can't name
 * them, the servers a campaign names, what names a server, and what each run of a rig names.
 */

/**
 * Why an assignment naming these servers can't start, in words, or "" when every server it names
 * is in Settings. A server that fails later never stops a run: only a missing one stops the start.
 */
export function mcpRefusal(db: DatabaseSync, uses: readonly McpUse[] | undefined): string {
  if (!uses?.length) return "";
  const have = mcpServerNames(db);
  const missing = uses.map((u) => u.name).filter((n) => !have.has(n));
  if (!missing.length) return "";
  const list = missing.join(", ");
  return missing.length === 1
    ? `The kit names the MCP server ${list}, and Settings has no server of that name. Add an MCP server named ${list} in Settings › Providers, or take it out of the kit. Then start the campaign again.`
    : `The kit names the MCP servers ${list}, and Settings has none of these names. Add them in Settings › Providers, or take them out of the kit. Then start the campaign again.`;
}

/**
 * The kinds of agent of a research run that MCP servers may go to: its workers and its advisors
 * (the teachers). Its planner (goals 047 and 117) plans from the run's own records, and takes
 * none.
 */
export const RESEARCH_AGENT_KINDS: readonly AgentKind[] = ["workers", "advisors"];

/**
 * Why a research campaign's contract can't name these servers, in words, or "": a server Settings
 * lacks, a tool its server does not list (or a server whose tools control has not read yet), or a
 * kind of agent a research run doesn't have. Copy a campaign (goal 069) checks a new list with it.
 */
export function researchMcpRefusal(db: DatabaseSync, uses: readonly McpUse[]): string {
  ensureMcpTables(db);
  const servers = new Map(
    (db.prepare("select name, tools from mcp_server").all() as Row[]).map((r) => {
      let tools: string[] | null = null;
      try {
        tools = r.tools ? (JSON.parse(str(r.tools)) as McpTool[]).map((t) => t.name) : null;
      } catch {
        tools = null;
      }
      return [str(r.name), tools] as const;
    }),
  );
  for (const u of uses) {
    if (!servers.has(u.name))
      return `Settings has no MCP server named ${u.name}. Add it in Settings › MCP servers, or take it out of mcp_servers.`;
    const kind = u.agents.find((k) => !RESEARCH_AGENT_KINDS.includes(k));
    if (kind)
      return `A research run's ${kind} takes no MCP server: it plans from the run's own records. Give ${u.name} to the workers or the advisors.`;
    const listed = servers.get(u.name);
    for (const k of AGENT_KINDS) {
      const named = u.tools?.[k];
      if (!named) continue;
      if (!listed)
        return `Control has not read the tools of ${u.name} yet. Read them in Settings › MCP servers, or give the ${k} all its tools.`;
      const unknown = named.filter((t) => !listed.includes(t));
      if (unknown.length)
        return `${u.name} has no tool named ${unknown.join(", ")}. Its tools are ${listed.slice(0, 30).join(", ") || "none"}${listed.length > 30 ? ", and more" : ""}.`;
    }
  }
  return "";
}

/**
 * The servers a campaign names, from its newest version saved on control (its kit's list, or a
 * research contract's), else its newest assignment. Undefined: control does not know the campaign.
 */
export function campaignMcpServers(store: ControlStore, campaign: string): McpUse[] | undefined {
  const v = store.campaignVersions(campaign)[0];
  if (v) {
    const contract = v.contract as { mode?: string; mcp_servers?: unknown };
    // A copy of a campaign known only by an assignment keeps that assignment's (goal 069).
    const raw =
      contract.mode === "research"
        ? contract.mcp_servers
        : (v.sources.mcp_servers ?? v.sources.assignment?.mcp_servers);
    return McpUses.safeParse(raw ?? []).data ?? [];
  }
  const past = store.latestAssignments().get(campaign);
  if (!past) return undefined;
  return McpUses.safeParse(past.payload.mcp_servers ?? []).data ?? [];
}

/** What names a server: each campaign whose newest version or assignment names it, with its kit. */
export function namedBy(store: ControlStore, name: string): { campaign: string; kit: string }[] {
  const campaigns = new Set([
    ...store.campaignVersions().map((v) => v.campaign),
    ...store.latestAssignments().keys(),
  ]);
  const out: { campaign: string; kit: string }[] = [];
  for (const c of [...campaigns].sort()) {
    if (!campaignMcpServers(store, c)?.some((u) => u.name === name)) continue;
    const v = store.campaignVersions(c)[0];
    const contract = (v?.contract ?? store.latestAssignments().get(c)?.payload.contract) as
      | { project?: { kit?: { repo?: string } } }
      | undefined;
    out.push({ campaign: c, kit: contract?.project?.kit?.repo ?? c });
  }
  return out;
}

/** The servers each run control assigned a rig names (its own signed commands, never the rig's reports). */
export function assignedMcpServers(db: DatabaseSync, rig: string): Map<string, McpUse[]> {
  const out = new Map<string, McpUse[]>();
  for (const r of db
    .prepare(
      "select signed from command where rig = ? and kind = 'assign_campaign' and status not in ('failed', 'rejected', 'expired') order by issued_at",
    )
    .all(rig) as { signed: string }[]) {
    try {
      const p = (
        JSON.parse(r.signed) as {
          envelope?: { payload?: { run?: unknown; mcp_servers?: unknown } };
        }
      ).envelope?.payload;
      const uses = McpUses.safeParse(p?.mcp_servers ?? []).data ?? [];
      if (typeof p?.run === "string" && uses.length) out.set(p.run, uses);
    } catch {
      // not a command this store wrote
    }
  }
  return out;
}
