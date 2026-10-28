import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { log } from "../common/env.ts";
import { HEALTH } from "../core/api/harness/supervisor.ts";
import { advisorRoutes } from "./api/advisors.ts";
import { type ApiTokens, apiContext, type HarnessApiExtras, statusFor } from "./api/context.ts";
import { mcpRoutes } from "./api/mcp.ts";
import { proxyRoutes } from "./api/proxy.ts";
import { refusalWords } from "./api/refusal.ts";
import { exportRoutes, liveRoutes, reportRoutes } from "./api/relay.ts";
import { rigRoutes } from "./api/rig.ts";
import { trialRoutes } from "./api/trials.ts";
import { usageRoutes } from "./api/usage.ts";
import { workRoutes } from "./api/work.ts";
import type { HarnessService } from "./service.ts";

export type { ApiTokens, HarnessApiExtras, Scope } from "./api/context.ts";

/**
 * Harness HTTP API. Only the rig's own supervisor reaches it over the network; proposers
 * (workers) reach it locally. Every route except /v1/health needs a bearer token whose scope
 * allows it.
 *
 * Each section of the API is a module in api/ that adds its routes to the app, with what it takes
 * from the context built once here (api/context.ts: the scopes, the caller's trial, how an error
 * becomes a status). They are added in this order, the order Hono matches them in.
 */
export function createHarnessApi(
  service: HarnessService,
  tokens: ApiTokens,
  extras: HarnessApiExtras = {},
): Hono {
  const app = new Hono();
  const api = apiContext(service, tokens, extras);

  // A request the schema refused says which field and why (goal 143), from the body it sent. A
  // body past its route's limit keeps its own answer, 413.
  app.onError(async (err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const status = statusFor(err);
    if (!(err instanceof z.ZodError)) return c.json({ error: err.message }, status);
    const body = await c.req.json().catch(() => undefined);
    const why = refusalWords(err, body);
    log("harness", "request refused", { method: c.req.method, path: c.req.path, why }, "warn");
    return c.json({ error: `invalid request: ${why}` }, status);
  });

  app.get(HEALTH.path, (c) => c.json({ ok: true, rig: service.rig }));

  proxyRoutes(app, api);
  rigRoutes(app, api);
  mcpRoutes(app, api);
  reportRoutes(app, api);
  advisorRoutes(app, api);
  liveRoutes(app, api);
  trialRoutes(app, api);
  usageRoutes(app, api);
  exportRoutes(app, api);
  workRoutes(app, api);

  return app;
}
