import type { Hono } from "hono";
import {
  MCP_EVENTS,
  MCP_SERVERS_GET,
  MCP_SERVERS_PUT,
  MODEL_ROUTE_GET,
  MODEL_ROUTE_PUT,
  SETTINGS,
} from "../../core/api/harness/supervisor.ts";
import { type ApiContext, limitOf } from "./context.ts";

/**
 * What the supervisor hands the harness from control and reads back: the rig's settings, the
 * agents' model route, and the MCP servers control gave the rig, with how they fared for the
 * advisors.
 */
export function rigRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  // The rig's settings (Edit rig), for the supervisor's own parts: its advisors.
  app.get(SETTINGS.path, supervisor, (c) => c.json(service.settings.get()));

  // The agents' model route, as control set it: the supervisor hands it over (key included) and
  // reads back which route is in use (never the key).
  app.get(MODEL_ROUTE_GET.path, supervisor, (c) =>
    service.models
      ? c.json({ ...service.models.info(), planner_revision: service.models.plannerRevision() })
      : c.json({ error: "no agents on this rig" }, 404),
  );
  app.put(MODEL_ROUTE_PUT.path, supervisor, limitOf(MODEL_ROUTE_PUT), async (c) => {
    if (!service.models) return c.json({ error: "no agents on this rig" }, 404);
    const body = MODEL_ROUTE_PUT.body.parse(await c.req.json());
    return c.json(service.setModelRoute(body.route, "supervisor", body.planner));
  });

  // The MCP servers control gave the rig (goal 068), as the supervisor hands them over: their
  // sign-in stays in this process's memory, and only their revisions are read back.
  app.get(MCP_SERVERS_GET.path, supervisor, (c) => c.json(service.mcp.info()));
  app.put(MCP_SERVERS_PUT.path, supervisor, limitOf(MCP_SERVERS_PUT), async (c) => {
    const body = MCP_SERVERS_PUT.body.parse(await c.req.json());
    service.mcp.set(body.servers, body.unavailable);
    return c.json(service.mcp.info());
  });
  // The advisors' calls go through the supervisor: it says here when a server failed for them,
  // or works again, and the run's history records it as the gateway records its own.
  app.post(MCP_EVENTS.path, supervisor, async (c) => {
    const b = MCP_EVENTS.body.parse(await c.req.json());
    if (!service.ledger.runs.get(b.run)) return c.json({ error: `no run ${b.run}` }, 404);
    service.mcp.report(
      { run: b.run, kind: "advisors", source: "supervisor" },
      b.server,
      b.ok,
      b.error,
    );
    return c.json({ ok: true });
  });
}
