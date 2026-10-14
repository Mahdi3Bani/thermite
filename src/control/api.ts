import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { COMMAND_KINDS, type CommandKind, reportBody, verifyJson } from "../core/commands.ts";
import { createDashboard } from "./dashboard.ts";
import { issueCommand } from "./issue.ts";
import { mountMcp } from "./mcp.ts";
import { metricsText } from "./metrics.ts";
import type { ControlStore, IngestReport } from "./store.ts";
import { unitView } from "./views.ts";

/**
 * Control HTTP API (v1 core). Admin tokens issue commands and read everything; each unit's token
 * may only report for its own unit, fetch its own pending commands and acknowledge them.
 */

export interface ControlTokens {
  admin: string;
  /** Optional read-only token (MCP and API reads for observers). */
  read?: string | undefined;
  /** unit id -> token */
  units: Record<string, string>;
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

const IngestBody = z.object({
  unit: z.string().min(1),
  ledger_id: z.string().min(1),
  cursor: z.number().int().min(0),
  next: z.number().int().min(0),
  events: z.array(
    z.object({
      id: z.number().int().positive(),
      at: z.string(),
      actor: z.string(),
      kind: z.string(),
      subject: z.string().nullable(),
      body: z.unknown(),
    }),
  ),
  summary: z.unknown(),
  unit_pubkey: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
});

const IssueBody = z.object({
  unit: z.string().min(1),
  kind: z.enum(COMMAND_KINDS as [CommandKind, ...CommandKind[]]),
  payload: z.unknown(),
  ttl_minutes: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60)
    .default(60),
  issued_by: z.string().min(1).default("owner"),
});

const AckBody = z.object({
  status: z.enum(["delivered", "rejected", "failed"]),
  outcome: z.unknown(),
});

export interface ControlOptions {
  /** A unit is shown stale after this long without a report (3 missed 60 s polls). */
  staleAfterMs: number;
}

export function createControlApi(
  store: ControlStore,
  tokens: ControlTokens,
  privateKeyPem: string,
  opts: ControlOptions = { staleAfterMs: 180_000 },
): Hono {
  const app = new Hono();
  store.setConfiguredUnits(Object.keys(tokens.units));

  const admin: MiddlewareHandler = async (c, next) => {
    if (!eq(bearer(c.req.header("authorization")), tokens.admin))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  const unitAuth: MiddlewareHandler = async (c, next) => {
    const unit = c.req.param("unit") ?? "";
    const expected = tokens.units[unit];
    if (!expected || !eq(bearer(c.req.header("authorization")), expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };

  app.onError((err, c) =>
    c.json(
      { error: err instanceof z.ZodError ? "invalid request" : err.message },
      err instanceof z.ZodError ? 400 : 500,
    ),
  );

  app.get("/v1/health", (c) => c.json({ ok: true }));

  app.post(
    "/v1/units/:unit/ingest",
    unitAuth,
    bodyLimit({ maxSize: 32 * 1024 * 1024 }),
    async (c) => {
      const body = IngestBody.parse(await c.req.json());
      const unit = c.req.param("unit");
      if (body.unit !== unit) return c.json({ error: "unit mismatch" }, 403);
      // Reports are signed by the harness: the supervisor relays them but cannot forge them.
      if (!body.signature || !body.unit_pubkey) return c.json({ error: "unsigned report" }, 400);
      const key = store.unitKey(unit);
      if (!key.pubkey) store.pinKey(unit, body.unit_pubkey);
      else if (key.pubkey.trim() !== body.unit_pubkey.trim()) {
        if (key.pending?.trim() !== body.unit_pubkey.trim()) store.holdKey(unit, body.unit_pubkey);
        return c.json({ error: "unit key changed: the owner must accept the new key" }, 409);
      }
      if (!verifyJson(reportBody(body), body.signature, store.unitKey(unit).pubkey as string)) {
        store.audit(`unit:${unit}`, "report_rejected", { reason: "bad signature" });
        return c.json({ error: "bad report signature" }, 403);
      }
      return c.json({ added: store.ingest(body as IngestReport) });
    },
  );

  app.get("/v1/units/:unit/commands/pending", unitAuth, (c) =>
    c.json({ commands: store.pendingCommands(c.req.param("unit")) }),
  );

  app.post("/v1/units/:unit/commands/:id/ack", unitAuth, async (c) => {
    const body = AckBody.parse(await c.req.json());
    const ok = store.ackCommand(c.req.param("unit"), c.req.param("id"), body.status, body.outcome);
    return ok ? c.json({ ok }) : c.json({ error: "no such pending command" }, 404);
  });

  app.get("/v1/units", admin, (c) => c.json({ units: store.units() }));

  app.get("/metrics", admin, (c) =>
    c.text(metricsText(store, opts.staleAfterMs), 200, {
      "content-type": "text/plain; version=0.0.4",
    }),
  );

  app.post("/v1/units/:unit/key/accept", admin, (c) =>
    store.acceptPendingKey(c.req.param("unit"), "owner:api")
      ? c.json({ accepted: true })
      : c.json({ error: "no pending key" }, 404),
  );

  app.get("/v1/units/:unit/events", admin, (c) => {
    const after = Number(c.req.query("after") ?? "0");
    const limit = Math.min(Number(c.req.query("limit") ?? "500"), 5000);
    return c.json({ events: store.events(c.req.param("unit"), after, limit) });
  });

  app.post("/v1/commands", admin, async (c) => {
    const body = IssueBody.parse(await c.req.json());
    const { id } = issueCommand(store, privateKeyPem, {
      unit: body.unit,
      kind: body.kind,
      payload: body.payload,
      ttlMinutes: body.ttl_minutes,
      issuedBy: body.issued_by,
    });
    return c.json({ id, status: "pending" }, 201);
  });

  app.get("/v1/commands", admin, (c) =>
    c.json({ commands: store.listCommands(Number(c.req.query("limit") ?? "100")) }),
  );

  app.get("/v1/audit", admin, (c) =>
    c.json({ audit: store.listAudit(Number(c.req.query("limit") ?? "200")) }),
  );

  app.get("/v1/units/:unit/view", admin, (c) => {
    const v = unitView(store, c.req.param("unit"), { staleAfterMs: opts.staleAfterMs });
    return v ? c.json(v) : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/commands/:id", admin, (c) => {
    const cmd = store.command(c.req.param("id"));
    return cmd ? c.json(cmd) : c.json({ error: "not found" }, 404);
  });

  app.route(
    "/",
    createDashboard(store, {
      adminToken: tokens.admin,
      privateKeyPem,
      staleAfterMs: opts.staleAfterMs,
    }),
  );
  app.get("/", (c) => c.redirect("/ui", 302));
  mountMcp(app, store, {
    adminToken: tokens.admin,
    readToken: tokens.read,
    privateKeyPem,
    staleAfterMs: opts.staleAfterMs,
  });

  return app;
}
