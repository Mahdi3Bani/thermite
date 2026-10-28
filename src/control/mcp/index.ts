import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { buildInfo } from "../../core/version.ts";
import { registerRigModels } from "../mcp-rig-models.ts";
import { registerRigReads } from "../mcp-rig-reads.ts";
import type { ControlStore } from "../store/index.ts";
import { registerCampaignSettings, registerRunStarts } from "./campaigns.ts";
import { registerAddClusterRig, registerClusterRigs } from "./clusters.ts";
import { registerCommands } from "./commands.ts";
import { type McpOptions, type Role, toolContext } from "./context.ts";
import { registerControl, registerModelPrice } from "./control.ts";
import { registerKnowledgeBase } from "./kb.ts";
import { registerKits } from "./kits.ts";
import { registerReads } from "./reads.ts";
import { registerRetire, registerRigSettings } from "./rigs.ts";
import { registerRunpod } from "./runpod.ts";
import { registerMcpServers } from "./servers.ts";

export type { McpOptions } from "./context.ts";

/**
 * Control over MCP (streamable HTTP at /mcp, stateless). The admin token may read and issue
 * commands; a read token (optional) may only read. Every call is written to the audit log.
 * The same views and the same signed-command path as the dashboard and the REST API.
 *
 * Each group of tools is a module in mcp/ that registers them on the server, with what it takes
 * from the context built once for the request (mcp/context.ts: the caller's role, the kinds of
 * command it may issue, the audit of every call). They are registered in this order, the order of
 * the list an MCP client sees, and each module says which tokens get its tools.
 */
function buildServer(store: ControlStore, opts: McpOptions, actor: string, role: Role): McpServer {
  const server = new McpServer({
    name: "thermite-control",
    version: (opts.control ?? buildInfo()).version,
  });
  const tools = toolContext(server, store, opts, actor, role);
  const { audited, canCommand } = tools;

  registerReads(tools);
  registerCommands(tools);
  registerKnowledgeBase(tools);

  // Control itself, for whoever runs it (not the agents of a campaign): its log and its providers.
  if (role !== "agent") {
    registerRigReads(server, audited, store, opts.runpodRigs, role !== "reader");
    registerControl(tools);
    registerAddClusterRig(tools);
    // Each agent's model, as Edit rig's section "2 · The agents" (goal 029): read by every
    // token but the agent's, as Providers is; set by the owner's and an operator's.
    registerRigModels(server, audited, store, actor, canCommand);
    registerRigSettings(tools);
    registerModelPrice(tools);
    registerRunStarts(tools);
    registerKits(tools);
    registerCampaignSettings(tools);
    registerClusterRigs(tools);
    registerMcpServers(tools);
    registerRetire(tools);
    registerRunpod(tools);
  }

  return server;
}

export function mountMcp(app: Hono, store: ControlStore, opts: McpOptions): void {
  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const role: Role | undefined = opts.admin.matches(token)
      ? "owner"
      : opts.operator?.matches(token)
        ? "operator"
        : opts.agent?.matches(token)
          ? "agent"
          : opts.read?.matches(token)
            ? "reader"
            : undefined;
    if (!role) return c.json({ error: "unauthorized" }, 401);
    // Stateless: a fresh server and transport per request. The actor is what commands record as
    // their issuer, and only "owner:" issuers pass the harness's owner-only gates: an operator
    // acts for the owner (its kinds are limited above), an agent does not.
    const actor = {
      owner: "owner:mcp",
      operator: "owner:operator",
      agent: "agent:mcp",
      reader: "reader:mcp",
    }[role];
    const server = buildServer(store, { ...opts, requestUrl: c.req.url }, actor, role);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
