import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { McpCaller } from "../mcp-gateway.ts";
import { type ApiContext, Unauthorized } from "./context.ts";

/** The MCP gateway, through which the workers and the planner call their run's MCP servers. */
export function mcpRoutes(app: Hono, { service, trialOf }: ApiContext): void {
  // The MCP gateway for workers (their trial's token) and the planner (a credential the harness
  // made for one plan): the tools their run's kit gives their kind of agent, never a secret.
  const mcpCaller = (header: string | undefined): McpCaller => {
    const h = header ?? "";
    const given = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (given.startsWith("trial.")) {
      const t = trialOf(h).trial;
      return { run: t.run, kind: "workers", source: `trial:${t.id}` };
    }
    const caller = given.startsWith("mcp.") ? service.mcpTokenCaller(given) : undefined;
    if (!caller) throw new Unauthorized("unauthorized");
    return caller;
  };
  app.get("/v1/mcp-tools", async (c) =>
    c.json(await service.mcp.tools(mcpCaller(c.req.header("authorization")))),
  );
  app.post("/v1/mcp-call", bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const caller = mcpCaller(c.req.header("authorization"));
    const b = z
      .strictObject({
        server: z.string().min(1).max(64),
        tool: z.string().min(1).max(128),
        arguments: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(await c.req.json());
    return c.json(await service.mcp.call(caller, b.server, b.tool, b.arguments));
  });
  // One server as an MCP endpoint (streamable HTTP, stateless), for OpenCode and Claude Code.
  app.all("/v1/mcp/:server", bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const caller = mcpCaller(c.req.header("authorization"));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await service.mcp.serverFor(caller, c.req.param("server")).connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
