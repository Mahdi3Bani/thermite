import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { CommandKind } from "../core/commands.ts";
import { issueCommand } from "./issue.ts";
import type { ControlStore } from "./store.ts";
import { unitView } from "./views.ts";

/**
 * Control over MCP (streamable HTTP at /mcp, stateless). The admin token may read and issue
 * commands; a read token (optional) may only read. Every call is written to the audit log.
 * The same views and the same signed-command path as the dashboard and the REST API.
 */

/** Commands agents may issue through MCP. Wiping state stays with the owner. */
const MCP_COMMANDS = [
  "assign_campaign",
  "pause_instance",
  "resume_instance",
  "redirect",
  "reset_workers",
  "propagate",
  "export_now",
  "approve_promotion",
] as const satisfies readonly CommandKind[];

export interface McpOptions {
  adminToken: string;
  readToken?: string | undefined;
  privateKeyPem: string;
  staleAfterMs: number;
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function buildServer(
  store: ControlStore,
  opts: McpOptions,
  actor: string,
  canCommand: boolean,
): McpServer {
  const server = new McpServer({ name: "thermite-control", version: "1.0.0" });
  const audited = <A>(tool: string, fn: (args: A) => unknown) => {
    return async (args: A) => {
      store.audit(actor, `mcp:${tool}`, args ?? {});
      try {
        return json(await fn(args));
      } catch (err) {
        return {
          ...json({ error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    };
  };
  const view = (unit: string) => {
    const v = unitView(store, unit, { staleAfterMs: opts.staleAfterMs });
    if (!v) throw new Error(`no unit ${unit}`);
    return v;
  };

  server.registerTool(
    "list_units",
    {
      title: "List units",
      description:
        "Every unit: live or stale, last report, and for each campaign instance its mode, status, champion and relative gain over the baseline.",
      inputSchema: {},
    },
    audited("list_units", () =>
      store.units().map((u) => {
        const v = view(u.id);
        return {
          unit: v.id,
          stale: v.stale,
          last_seen: v.last_seen,
          jobs: v.jobs,
          instances: v.instances.map((i) => {
            const champ = i.champion.filter((c) => !c.reopened).at(-1);
            return {
              instance: i.id,
              campaign: i.campaign,
              mode: i.mode,
              status: i.status,
              champion_seq: champ?.seq ?? 1,
              gain_over_baseline: (champ?.cumulative ?? 1) - 1,
              verdicts: i.verdicts,
              pending_promotions: i.pending_promotions,
            };
          }),
        };
      }),
    ),
  );

  server.registerTool(
    "get_instance",
    {
      title: "Campaign instance detail",
      description:
        "One instance on one unit: champion history (hill climb), recent attempts with verdicts and deltas, calibration noise.",
      inputSchema: {
        unit: z.string().min(1),
        instance: z.string().min(1),
        attempts: z.number().int().min(1).max(500).default(50),
      },
    },
    audited("get_instance", (a: { unit: string; instance: string; attempts: number }) => {
      const i = view(a.unit).instances.find((x) => x.id === a.instance);
      if (!i) throw new Error(`no instance ${a.instance} on ${a.unit}`);
      return { ...i, attempts: i.attempts.slice(-a.attempts).reverse() };
    }),
  );

  server.registerTool(
    "recent_events",
    {
      title: "Recent events",
      description: "The newest events a unit reported (judge, commands, imports, lifecycle).",
      inputSchema: { unit: z.string().min(1), limit: z.number().int().min(1).max(500).default(50) },
    },
    audited("recent_events", (a: { unit: string; limit: number }) =>
      view(a.unit).recent.slice(0, a.limit),
    ),
  );

  server.registerTool(
    "list_commands",
    {
      title: "Commands",
      description: "Recently issued commands and their delivery status and outcome.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
    },
    audited("list_commands", (a: { limit: number }) => store.listCommands(a.limit)),
  );

  if (canCommand) {
    server.registerTool(
      "issue_command",
      {
        title: "Issue a signed command",
        description: `Queue a command for a unit; control signs it and the unit's supervisor relays it. Kinds: ${MCP_COMMANDS.join(", ")}. The payload must match the kind (for example pause_instance {instance, reason}; redirect {instance, directives:[{kind: avoid|try|mandate|priority|lane_count, family?, value?, rationale, citations}]}; approve_promotion {instance, attempt}). Returns the command id; poll command_status.`,
        inputSchema: {
          unit: z.string().min(1),
          kind: z.enum(MCP_COMMANDS),
          payload: z.record(z.string(), z.unknown()),
          ttl_minutes: z.number().int().min(1).max(10080).default(60),
        },
      },
      audited(
        "issue_command",
        (a: { unit: string; kind: CommandKind; payload: unknown; ttl_minutes: number }) =>
          issueCommand(store, opts.privateKeyPem, {
            unit: a.unit,
            kind: a.kind,
            payload: a.payload,
            ttlMinutes: a.ttl_minutes,
            issuedBy: actor,
          }),
      ),
    );
  }

  server.registerTool(
    "command_status",
    {
      title: "Command status",
      description: "Delivery status and outcome of one command.",
      inputSchema: { id: z.string().min(1) },
    },
    audited("command_status", (a: { id: string }) => {
      const c = store.command(a.id);
      if (!c) throw new Error(`no command ${a.id}`);
      return c;
    }),
  );

  return server;
}

export function mountMcp(app: Hono, store: ControlStore, opts: McpOptions): void {
  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const admin = token.length > 0 && same(token, opts.adminToken);
    const reader =
      !admin && opts.readToken !== undefined && token.length > 0 && same(token, opts.readToken);
    if (!admin && !reader) return c.json({ error: "unauthorized" }, 401);
    // Stateless: a fresh server and transport per request.
    const server = buildServer(store, opts, admin ? "mcp:admin" : "mcp:reader", admin);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
