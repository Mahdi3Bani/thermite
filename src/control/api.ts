import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { log, redact } from "../common/env.ts";
import { answerOf } from "../common/errors.ts";
import { campaignRoutes } from "./api/campaigns.ts";
import { commandRoutes, commandStatusRoutes } from "./api/commands.ts";
import { apiContext, type ControlOptions, type ControlTokens } from "./api/context.ts";
import { editRigRoutes } from "./api/edit-rig.ts";
import { gpuCloudRoutes } from "./api/gpu-clouds.ts";
import { kitRoutes } from "./api/kits.ts";
import { lifecycleRoutes } from "./api/lifecycle.ts";
import { modelRoutes } from "./api/model-routes.ts";
import { recordRoutes, rigRecordRoutes } from "./api/records.ts";
import { relayRoutes } from "./api/relay.ts";
import { resultRoutes } from "./api/results.ts";
import { rigRoutes } from "./api/rigs.ts";
import { usageRoutes } from "./api/usage.ts";
import { watchDrains } from "./clusters/drain.ts";
import { createDashboard } from "./dashboard.ts";
import { ExportFiles } from "./exports.ts";
import { mountMcp } from "./mcp.ts";
import { mountMcpServerRoutes } from "./mcp-server-routes.ts";
import type { ControlStore } from "./store.ts";

export type { ControlOptions, ControlTokens } from "./api/context.ts";

/**
 * Control HTTP API (v1 core). Admin tokens issue commands and read everything; each rig's token
 * may only report for its own rig, fetch its own pending commands and acknowledge them.
 *
 * Each section of the API is a module in api/ that adds its routes to the app, with what it takes
 * from the context built once here (api/context.ts: control's build and parts, and the guards of
 * the owner's, the rigs' and the reader's routes). They are added in this order, the order Hono
 * matches them in; then the dashboard's pages and MCP.
 */
export function createControlApi(
  store: ControlStore,
  tokens: ControlTokens,
  privateKeyPem: string,
  opts: ControlOptions = { staleAfterMs: 180_000 },
): Hono {
  const app = new Hono();
  const api = apiContext(app, store, tokens, privateKeyPem, opts);
  const { control, creds, parts, admin, rigAuth } = api;
  const owner = creds.owner;
  const { secrets, chatgpt, runpodTests, mcpServers, runpodRigs, runpodDriver } = parts;

  // Every refusal and bad input is answered in its own words and status, the same as MCP's. A
  // body past its route's limit keeps its own answer, 413: the rig's supervisor halves its page.
  app.onError((err, c) =>
    err instanceof HTTPException
      ? err.getResponse()
      : c.json({ error: answerOf(err).error }, answerOf(err).status),
  );

  // What fails goes to control's output and its audit log: the dashboard says why only once, in
  // the page it sends back, and whoever debugs control reads it again over MCP (control_log).
  app.use("*", async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    const status = c.res.status;
    if (c.error || status >= 500) {
      const error = redact(c.error?.message ?? `status ${status}`);
      log("control", "request failed", { method: c.req.method, path, status, error }, "error");
      store.audit("control", "failed", { method: c.req.method, path, status, error });
      return;
    }
    if (!path.startsWith("/ui/") || c.req.method !== "POST") return;
    const to = c.res.headers.get("location");
    // Pages send a refusal back as error, or as msgerror for a message to agents.
    const back = to ? new URL(to, "http://control").searchParams : undefined;
    const why = back?.get("error") ?? back?.get("msgerror") ?? null;
    if (why || status >= 400) {
      const reason = redact(why ?? `status ${status}`);
      log("control", "refused", { path, why: reason }, "warn");
      store.audit("owner:ui", "refused", { path, why: reason });
    }
  });

  app.get("/v1/health", (c) => c.json({ ok: true }));

  relayRoutes(app, api);
  modelRoutes(app, api);

  // MCP servers (goal 068): the owner's routes, the OAuth callback, and what a rig gets.
  mountMcpServerRoutes(app, {
    store,
    servers: mcpServers,
    admin,
    rigAuth,
    publicUrl: opts.publicUrl,
  });

  // Where control keeps the exports rigs without a results repository send it (api/results.ts
  // takes them; the dashboard's Exports page reads them).
  const exportFiles = opts.exportsDir ? new ExportFiles(opts.exportsDir) : undefined;
  resultRoutes(app, api, exportFiles);
  lifecycleRoutes(app, api);
  rigRoutes(app, api);
  usageRoutes(app, api);
  kitRoutes(app, api);
  rigRecordRoutes(app, api);
  commandRoutes(app, api);
  campaignRoutes(app, api);
  editRigRoutes(app, api);
  recordRoutes(app, api);
  gpuCloudRoutes(app, api);
  commandStatusRoutes(app, api);

  // A draining cluster rig's pods restart once nothing runs on it (clusters/drain.ts).
  watchDrains(parts, opts.drainWatchMs);
  app.route(
    "/",
    createDashboard(store, {
      admin: owner,
      privateKeyPem,
      staleAfterMs: opts.staleAfterMs,
      driver: opts.driver,
      sessionDays: opts.sessionDays,
      secrets,
      chatgpt,
      providerFetch: opts.providerFetch,
      kits: opts.kits,
      probeRepo: opts.probeRepo,
      readKit: opts.readKit,
      cloudFetch: opts.cloudFetch,
      runpodTests,
      parts,
      mcpServers,
      runpodRigs,
      runpodDriver,
      control,
      offlineAfterMs: opts.offlineAfterMs,
      rigUpdates: opts.rigUpdates,
      exportFiles,
    }),
  );
  app.get("/", (c) => c.redirect("/ui", 302));
  mountMcp(app, store, {
    admin: owner,
    operator: creds.operator,
    agent: creds.agent,
    read: creds.read,
    privateKeyPem,
    staleAfterMs: opts.staleAfterMs,
    offlineAfterMs: opts.offlineAfterMs,
    control,
    runpodTests,
    runpodRigs,
    runpodDriver,
    driver: opts.driver,
    parts,
    mcpServers,
    publicUrl: opts.publicUrl,
    kits: opts.kits,
  });

  return app;
}
