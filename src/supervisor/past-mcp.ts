import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { PAST_SEARCH_DESCRIPTION, PAST_SEARCH_TOOL, SEARCH_MAX } from "../harness/knowledge.ts";

/**
 * The run's past research for an advisor in Claude Code (goal 065). Claude Code runs with none
 * of its own tools (the supervisor holds git and model credentials), so the supervisor serves the
 * one read-only search over MCP: on localhost, for the length of one call, behind a token made for
 * that call. Claude Code is given that server alone (`--strict-mcp-config`) and only its tool.
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
  close(): Promise<void>;
}

/** Starts the search's MCP server on a free local port. Close it when the call ends. */
export async function servePastSearch(search: PastSearch): Promise<PastSearchServer> {
  const token = randomBytes(24).toString("hex");
  const build = () => {
    const server = new McpServer({ name: "thermite-past-research", version: "1.0.0" });
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
          const found = await search(a.query, { kinds: a.kinds, limit: a.limit });
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
  app.all("/mcp", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${token}`)
      return c.json({ error: "unauthorized" }, 401);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await build().connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const config = {
    mcpServers: {
      [PAST_MCP_SERVER]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
    },
  };
  return {
    url,
    args: ["--mcp-config", JSON.stringify(config), "--allowedTools", PAST_MCP_TOOL],
    close: () =>
      new Promise<void>((r) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
