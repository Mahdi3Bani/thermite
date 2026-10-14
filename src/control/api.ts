import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  COMMAND_KINDS,
  type CommandKind,
  CommandPayloads,
  signEnvelope,
} from "../core/commands.ts";
import type { ControlStore, IngestReport } from "./store.ts";

/**
 * Control HTTP API (v1 core). Admin tokens issue commands and read everything; each unit's token
 * may only report for its own unit, fetch its own pending commands and acknowledge them.
 */

export interface ControlTokens {
  admin: string;
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

export function createControlApi(
  store: ControlStore,
  tokens: ControlTokens,
  privateKeyPem: string,
): Hono {
  const app = new Hono();

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
      const body = IngestBody.parse(await c.req.json()) as IngestReport;
      if (body.unit !== c.req.param("unit")) return c.json({ error: "unit mismatch" }, 403);
      return c.json({ added: store.ingest(body) });
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

  app.get("/v1/units/:unit/events", admin, (c) => {
    const after = Number(c.req.query("after") ?? "0");
    const limit = Math.min(Number(c.req.query("limit") ?? "500"), 5000);
    return c.json({ events: store.events(c.req.param("unit"), after, limit) });
  });

  app.post("/v1/commands", admin, async (c) => {
    const body = IssueBody.parse(await c.req.json());
    const payload = CommandPayloads[body.kind].parse(body.payload);
    const now = Date.now();
    const signed = signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        unit: body.unit,
        kind: body.kind,
        issued_by: body.issued_by,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + body.ttl_minutes * 60_000).toISOString(),
        payload,
      },
      privateKeyPem,
    );
    store.enqueueCommand(signed);
    return c.json({ id: signed.envelope.id, status: "pending" }, 201);
  });

  app.get("/v1/commands/:id", admin, (c) => {
    const cmd = store.command(c.req.param("id"));
    return cmd ? c.json(cmd) : c.json({ error: "not found" }, 404);
  });

  return app;
}
