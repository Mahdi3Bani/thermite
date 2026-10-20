import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";

/**
 * A stand-in for an outside knowledge base (a GBrain-style brain) for tests: an MCP server over
 * streamable HTTP at /mcp, on a free local port, that takes one bearer token. It has a search tool
 * and a page-writing tool shaped like GBrain's put_page (slug, content, force, request_id), and
 * keeps what it was given so a test can look.
 */

export interface FakeKb {
  /** The MCP URL (no token in it). */
  url: string;
  /** Pages written, by slug. */
  pages: Map<string, string>;
  /** Every tool call, with its arguments. */
  calls: { tool: string; args: Record<string, unknown> }[];
  /** Every request's path and query, and its authorization header. */
  requests: { path: string; authorization: string | null }[];
  /** When set, the write tool refuses every page with these words. */
  failWrites: string | null;
  close(): Promise<void>;
}

export async function startFakeKb(o: {
  token: string;
  /** The write tool's name, or none. Default put_page. */
  writeTool?: string | null | undefined;
  /** A write tool that takes path and text instead of slug and content. */
  oddWriter?: boolean | undefined;
}): Promise<FakeKb> {
  const kb: FakeKb = {
    url: "",
    pages: new Map(),
    calls: [],
    requests: [],
    failWrites: null,
    close: async () => {},
  };
  const writeTool = o.writeTool === undefined ? "put_page" : o.writeTool;
  const text = (t: string, isError = false) => ({
    content: [{ type: "text" as const, text: t }],
    ...(isError ? { isError: true } : {}),
  });
  const build = () => {
    const server = new McpServer({ name: "fake-kb", version: "1.0.0" });
    server.registerTool(
      "search",
      { description: "Search the pages.", inputSchema: { query: z.string() } },
      async (args) => {
        kb.calls.push({ tool: "search", args });
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = [...kb.pages.entries()]
          .filter(([, c]) => words.every((w) => c.toLowerCase().includes(w)))
          .map(([slug]) => slug);
        return text(JSON.stringify({ hits: hits.length ? hits : ["notes/outside-fact"] }));
      },
    );
    if (writeTool && o.oddWriter)
      server.registerTool(
        writeTool,
        { description: "Write a file.", inputSchema: { path: z.string(), text: z.string() } },
        async (args) => {
          kb.calls.push({ tool: writeTool, args });
          return text("written");
        },
      );
    else if (writeTool)
      server.registerTool(
        writeTool,
        {
          description: "Write a whole page.",
          inputSchema: {
            slug: z.string(),
            content: z.string(),
            force: z.boolean().optional(),
            request_id: z.string().optional(),
          },
        },
        async (args) => {
          kb.calls.push({ tool: writeTool, args });
          if (kb.failWrites) return text(kb.failWrites, true);
          kb.pages.set(args.slug, args.content);
          return text(JSON.stringify({ slug: args.slug, revision: String(kb.calls.length) }));
        },
      );
    return server;
  };
  const app = new Hono();
  app.all("/mcp", async (c) => {
    const u = new URL(c.req.url);
    const authorization = c.req.header("authorization") ?? null;
    kb.requests.push({ path: `${u.pathname}${u.search}`, authorization });
    if (authorization !== `Bearer ${o.token}`) return c.json({ error: "unauthorized" }, 401);
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
  const port = (server.address() as AddressInfo).port;
  kb.url = `http://127.0.0.1:${port}/mcp`;
  kb.close = () =>
    new Promise<void>((r) => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close(() => r());
    });
  return kb;
}
