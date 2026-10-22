import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { PAST_SEARCH_DESCRIPTION, PAST_SEARCH_TOOL, SEARCH_MAX } from "../harness/knowledge.ts";
import { type AdvisorCode, CODE_TOOL_NAMES, registerCodeTools } from "./code-tools.ts";
import {
  type AdvisorResearch,
  RESEARCH_TOOL_NAMES,
  registerResearchTools,
} from "./research-tools.ts";

/**
 * The run's past research for an advisor in Claude Code (goal 065), OpenCode or the Codex CLI
 * (goal 073). Each runs with none of its own tools (the supervisor holds git and model
 * credentials), so the supervisor serves the one read-only search over MCP: on localhost, for the
 * length of one call, behind a token made for that call. Claude Code is given that server alone
 * (`--strict-mcp-config`) and only its tool; OpenCode and Codex get it in their configuration for
 * the call (advisor-cli.ts), with the token in their environment.
 * The search reads the harness's copy of the run's knowledge/ through the harness API; nothing
 * here writes.
 */

/** The server's name in Claude Code's MCP config. */
export const PAST_MCP_SERVER = "thermite";
/** The tool's name as Claude Code calls it. */
export const PAST_MCP_TOOL = `mcp__${PAST_MCP_SERVER}__${PAST_SEARCH_TOOL}`;

/** A search of one run's past research: the query, and optionally the kinds and how many. */
export type PastSearch = (
  query: string,
  o?: { kinds?: string[] | undefined; limit?: number | undefined },
) => Promise<unknown>;

export interface PastSearchServer {
  /** The MCP address (no token in it). */
  url: string;
  /** Claude Code's flags: the server, and permission for its one tool. */
  args: string[];
  /**
   * Each server as another CLI's configuration names it (goal 073: OpenCode and Codex): its name
   * and its address, no token in it. The past-research search is PAST_MCP_SERVER.
   */
  servers: { name: string; url: string }[];
  /** The bearer token the servers take, made for this call alone. */
  token: string;
  close(): Promise<void>;
}

/** Starts the search's MCP server on a free local port. Close it when the call ends. */
export function servePastSearch(search: PastSearch): Promise<PastSearchServer> {
  return serveAdvisorTools({ pastSearch: search });
}

/**
 * An advisor's MCP servers for one call of Claude Code (goal 068): each server the run's kit
 * gives the advisors, as the supervisor serves it on localhost (each call goes through the
 * supervisor, which holds the sign-in), and the past-research search when there is one.
 */
export interface AdvisorServers {
  servers: string[];
  serverFor(server: string): Server;
}

/**
 * Starts the advisor's local MCP servers on a free port: the past-research search, the
 * teachers' code and evidence reads (goal 081) and their reads of the run's own research (goal
 * 098) at /mcp, the server named PAST_MCP_SERVER, and each MCP server the advisor gets at
 * /mcp/<name>. Claude Code is given them alone, and permission for their tools only. Close it
 * when the call ends.
 */
export async function serveAdvisorTools(o: {
  pastSearch?: PastSearch | undefined;
  mcp?: AdvisorServers | undefined;
  /** The teachers' read-only tools for the run's code and evidence (goal 081), on the same server. */
  code?: AdvisorCode | undefined;
  /** The teachers' read-only tools for the run's own research (goal 098), on the same server. */
  research?: AdvisorResearch | undefined;
}): Promise<PastSearchServer> {
  const token = randomBytes(24).toString("hex");
  const search = o.pastSearch;
  const code = o.code;
  const research = o.research;
  const build = () => {
    const server = new McpServer({ name: "thermite-past-research", version: "1.0.0" });
    if (code) registerCodeTools(server, code);
    if (research) registerResearchTools(server, research);
    if (search)
      server.registerTool(
        PAST_SEARCH_TOOL,
        {
          description: PAST_SEARCH_DESCRIPTION,
          inputSchema: {
            query: z
              .string()
              .max(300)
              .describe("Words that must all be in an item; empty: the newest"),
            kinds: z
              .array(z.string().max(20))
              .max(10)
              .optional()
              .describe(
                "Only these kinds: run, trial, experiment, attempt, note, doc, source, claim, hypothesis, finding, report",
              ),
            limit: z.number().int().min(1).max(SEARCH_MAX).optional().describe("How many items"),
          },
          annotations: { readOnlyHint: true },
        },
        async (a) => {
          try {
            const found = await (search as PastSearch)(a.query, { kinds: a.kinds, limit: a.limit });
            return { content: [{ type: "text" as const, text: JSON.stringify(found) }] };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `the search failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      );
    return server;
  };
  const app = new Hono();
  const serving = (make: () => McpServer | Server) => async (c: Context) => {
    if (c.req.header("authorization") !== `Bearer ${token}`)
      return c.json({ error: "unauthorized" }, 401);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await make().connect(transport);
    return transport.handleRequest(c.req.raw);
  };
  const thermite = Boolean(search || code || research);
  if (thermite) app.all("/mcp", serving(build));
  const mcp = o.mcp;
  if (mcp)
    app.all("/mcp/:server", async (c) => {
      const name = c.req.param("server");
      if (!mcp.servers.includes(name)) return c.json({ error: "not found" }, 404);
      return serving(() => mcp.serverFor(name))(c);
    });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const headers = { Authorization: `Bearer ${token}` };
  const servers = [
    ...(thermite ? [{ name: PAST_MCP_SERVER, url }] : []),
    ...(mcp?.servers ?? []).map((s) => ({ name: s, url: `${url}/${encodeURIComponent(s)}` })),
  ];
  const config = {
    mcpServers: Object.fromEntries(
      servers.map((s) => [s.name, { type: "http", url: s.url, headers }]),
    ),
  };
  return {
    url,
    servers,
    token,
    args: [
      "--mcp-config",
      JSON.stringify(config),
      "--allowedTools",
      ...(search ? [PAST_MCP_TOOL] : []),
      ...(code ? CODE_TOOL_NAMES.map((n) => `mcp__${PAST_MCP_SERVER}__${n}`) : []),
      ...(research ? RESEARCH_TOOL_NAMES.map((n) => `mcp__${PAST_MCP_SERVER}__${n}`) : []),
      // A server's name allows each of its tools.
      ...(mcp?.servers ?? []).map((s) => `mcp__${s}`),
    ],
    close: () =>
      new Promise<void>((r) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
