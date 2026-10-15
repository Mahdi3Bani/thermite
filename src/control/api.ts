import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { COMMAND_KINDS, type CommandKind, reportBody, verifyJson } from "../core/commands.ts";
import { LiveBatch, LiveEntry, liveBody } from "../core/live.ts";
import { createDashboard } from "./dashboard.ts";
import { issueCommand, propagateChampion } from "./issue.ts";
import { advanceResets, cancelReset, confirmReset, type DeploymentDriver } from "./lifecycle.ts";
import { mountMcp } from "./mcp.ts";
import { metricsText } from "./metrics.ts";
import type { ControlStore, IngestReport } from "./store.ts";
import { leaderboard, unitView } from "./views.ts";

/**
 * Control HTTP API (v1 core). Admin tokens issue commands and read everything; each unit's token
 * may only report for its own unit, fetch its own pending commands and acknowledge them.
 */

export interface ControlTokens {
  admin: string;
  /** Optional read-only token (MCP and API reads for observers). */
  read?: string | undefined;
  /**
   * Optional token for agents on MCP (for example a coordinating agent): it may read and steer
   * (assign, pause, resume, redirect, reset workers, export, propagate), never approve, accept or
   * wipe. The admin token is the owner's.
   */
  agent?: string | undefined;
  /** unit id -> token */
  units: Record<string, string>;
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A list size from a query string: a whole number from 1 to 5000, or the default. */
function clampLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) ? Math.min(5000, Math.max(1, n)) : fallback;
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
      at: z.iso.datetime(),
      actor: z.string(),
      kind: z.string(),
      subject: z.string().nullable(),
      body: z.unknown(),
    }),
  ),
  summary: z.unknown(),
  generated_at: z.iso.datetime(),
  latest_event: z.number().int().min(0),
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
});

/** What a supervisor may say about itself: numbers and short strings only (it is unsigned). */
const Count = z.number().finite().min(0).max(1e12);
const Short = z.string().max(1000);
const SupervisorStats = z.strictObject({
  at: Short,
  relay: z.strictObject({ cursor: Count }).optional(),
  export: z
    .strictObject({
      remote: z.boolean(),
      exports: Count,
      pushed: z.array(z.string().regex(/^[0-9A-Za-z-]{1,80}$/)).max(50),
      pushed_commit: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/)
        .nullable()
        .optional(),
      last_push_at: Short.nullable(),
      last_error: Short.nullable(),
    })
    .optional(),
  advisors: z
    .strictObject({
      teacher_runs: Count,
      directive_sets: Count,
      directives: Count,
      audits: Count,
      reviews: Count,
      errors: Count,
      tokens_in: Count,
      tokens_out: Count,
      usd: Count,
      last_error: Short.optional(),
    })
    .nullable()
    .optional(),
});

const AckBody = z.object({
  status: z.enum(["delivered", "rejected", "failed"]),
  outcome: z.unknown(),
});

export interface ControlOptions {
  /** A unit is stale after this long without a report (3 missed 60 s polls). */
  staleAfterMs: number;
  /** Restarts containers (Kubernetes or compose); none configured: restarts are refused. */
  driver?: DeploymentDriver | undefined;
  /** Hold every unit's first report key for the owner's acceptance (no trust on first use). */
  requireKeyAcceptance?: boolean | undefined;
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
      const offered = body.unit_pubkey.trim();
      // A key is pinned or held only if the report it came with verifies under it.
      if (!verifyJson(reportBody(body), body.signature, offered)) {
        store.audit(`unit:${unit}`, "report_rejected", { reason: "bad signature" });
        return c.json({ error: "bad report signature" }, 403);
      }
      if (!key.pubkey) {
        // First contact: pinned, unless the owner must accept every unit's first key.
        if (opts.requireKeyAcceptance) {
          if (key.pending?.trim() !== offered) store.holdKey(unit, offered);
          return c.json({ error: "the unit's key waits for the owner's acceptance" }, 409);
        }
        store.pinKey(unit, offered);
      } else if (key.pubkey.trim() !== offered) {
        if (key.pending?.trim() !== offered) store.holdKey(unit, offered);
        return c.json({ error: "unit key changed: the owner must accept the new key" }, 409);
      }
      // Freshness and completeness: no report from a ledger this unit has left, no gap in the
      // event stream, and nothing older than the newest report already taken.
      const fresh = store.reportCheck(unit, {
        ledgerId: body.ledger_id,
        cursor: body.cursor,
        generatedAt: body.generated_at,
      });
      if (!fresh.ok) {
        store.audit(`unit:${unit}`, "report_refused", { reason: fresh.reason });
        return c.json({ error: fresh.reason, expected_cursor: fresh.expectedCursor }, 409);
      }
      if (Date.parse(body.generated_at) > Date.now() + 5 * 60_000)
        return c.json({ error: "report from the future" }, 409);
      return c.json({ added: store.ingest(body as IngestReport) });
    },
  );

  app.get("/v1/units/:unit/commands/pending", unitAuth, (c) =>
    c.json({ commands: store.pendingCommands(c.req.param("unit")) }),
  );

  app.post("/v1/commands/:id/cancel", admin, (c) =>
    store.cancelCommand(c.req.param("id"), "owner:api")
      ? c.json({ cancelled: true })
      : c.json({ error: "no such pending command" }, 404),
  );

  app.post(
    "/v1/units/:unit/commands/:id/ack",
    unitAuth,
    bodyLimit({ maxSize: 256 * 1024 }),
    async (c) => {
      const body = AckBody.parse(await c.req.json());
      const ok = store.ackCommand(
        c.req.param("unit"),
        c.req.param("id"),
        body.status,
        body.outcome,
      );
      return ok ? c.json({ ok }) : c.json({ error: "no such pending command" }, 404);
    },
  );

  // The supervisor's own figures and its daily report (unsigned: the supervisor reports itself).
  app.post(
    "/v1/units/:unit/supervisor",
    unitAuth,
    bodyLimit({ maxSize: 256 * 1024 }),
    async (c) => {
      store.setSupervisor(c.req.param("unit"), SupervisorStats.parse(await c.req.json()));
      return c.json({ ok: true });
    },
  );

  // The live view: the harness's lines, signed with the unit's pinned key (the supervisor relays
  // them but cannot forge them), and the supervisor's own lines, stored as unsigned.
  app.post("/v1/units/:unit/live", unitAuth, bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const unit = c.req.param("unit");
    const body = z
      .object({
        batch: LiveBatch,
        supervisor: z
          .object({ log_id: z.string().min(1).max(64), entries: z.array(LiveEntry).max(500) })
          .optional(),
      })
      .parse(await c.req.json());
    const b = body.batch;
    if (b.unit !== unit) return c.json({ error: "unit mismatch" }, 403);
    const pinned = store.unitKey(unit).pubkey;
    if (!pinned) return c.json({ error: "the unit's report key is not accepted yet" }, 409);
    if (!b.signature || !b.unit_pubkey || b.unit_pubkey.trim() !== pinned.trim())
      return c.json({ error: "live lines must be signed with the unit's pinned key" }, 409);
    if (!verifyJson(liveBody(b), b.signature, pinned))
      return c.json({ error: "bad live signature" }, 403);
    let added = store.addLive(unit, b.log_id, b.entries, true);
    if (body.supervisor) {
      const own = body.supervisor.entries.filter((e) => e.source === "supervisor");
      added += store.addLive(unit, `supervisor:${body.supervisor.log_id}`, own, false);
    }
    return c.json({ added });
  });

  app.post("/v1/units/:unit/reports", unitAuth, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const body = z
      .object({ kind: z.enum(["daily"]), body: z.string().min(1).max(200_000) })
      .parse(await c.req.json());
    return c.json({ id: store.addReport(c.req.param("unit"), body.kind, body.body) }, 201);
  });

  app.get("/v1/reports", admin, (c) =>
    c.json({
      reports: store.reports(
        clampLimit(c.req.query("limit"), 20),
        c.req.query("unit") || undefined,
      ),
    }),
  );

  app.get("/v1/leaderboard", admin, (c) =>
    c.json({ campaigns: leaderboard(store, { staleAfterMs: opts.staleAfterMs }) }),
  );

  app.post("/v1/propagate", admin, async (c) => {
    const body = z
      .object({
        from_unit: z.string().min(1),
        instance: z.string().min(1),
        to_unit: z.string().min(1),
        to_instance: z.string().min(1),
      })
      .parse(await c.req.json());
    const r = propagateChampion(store, privateKeyPem, {
      fromUnit: body.from_unit,
      instance: body.instance,
      toUnit: body.to_unit,
      toInstance: body.to_instance,
      issuedBy: "owner:api",
      staleAfterMs: opts.staleAfterMs,
    });
    return c.json(r, 201);
  });

  // Lifecycle (owner): restart through the deployment driver; the full reset with state wipe.
  app.post("/v1/units/:unit/restart", admin, async (c) => {
    if (!opts.driver) return c.json({ error: "no deployment driver is configured" }, 409);
    const body = z
      .object({
        components: z
          .array(z.enum(["harness", "supervisor"]))
          .min(1)
          .default(["harness", "supervisor"]),
      })
      .parse(await c.req.json().catch(() => ({})));
    const unit = c.req.param("unit");
    store.audit("owner:api", "restart", { unit, components: body.components });
    return c.json({ restarted: await opts.driver.restart(unit, body.components) });
  });

  app.post("/v1/units/:unit/reset", admin, async (c) => {
    const unit = c.req.param("unit");
    const body = z.object({ confirm: z.string() }).parse(await c.req.json());
    if (body.confirm !== `reset ${unit}`)
      return c.json({ error: `confirm with "reset ${unit}"` }, 400);
    const id = store.createReset(unit, "owner:api");
    await advanceResets({
      store,
      privateKeyPem,
      driver: opts.driver,
      staleAfterMs: opts.staleAfterMs,
    });
    return c.json({ reset: id }, 201);
  });

  app.get("/v1/resets", admin, (c) => c.json({ resets: store.resets() }));

  app.post("/v1/resets/:id/confirm", admin, async (c) => {
    confirmReset(store, Number(c.req.param("id")), "owner:api");
    await advanceResets({
      store,
      privateKeyPem,
      driver: opts.driver,
      staleAfterMs: opts.staleAfterMs,
    });
    return c.json({ ok: true });
  });

  app.post("/v1/resets/:id/cancel", admin, (c) => {
    cancelReset(store, Number(c.req.param("id")), "owner:api");
    return c.json({ ok: true });
  });

  app.get("/v1/units", admin, (c) => c.json({ units: store.units() }));

  // Metrics: the read token is enough (a scraper should not hold the owner's credential).
  const reader: MiddlewareHandler = async (c, next) => {
    const t = bearer(c.req.header("authorization"));
    if (!eq(t, tokens.admin) && !(tokens.read && eq(t, tokens.read)))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  app.get("/metrics", reader, (c) =>
    c.text(metricsText(store, opts.staleAfterMs), 200, {
      "content-type": "text/plain; version=0.0.4",
    }),
  );

  app.get("/v1/units/:unit/live", reader, (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const source = c.req.query("source") || undefined;
    const limit = clampLimit(c.req.query("limit"), 500);
    return c.json({
      sources: store.liveSources(c.req.param("unit")),
      entries: after
        ? store.live(c.req.param("unit"), after, limit, source)
        : store.liveTail(c.req.param("unit"), limit, source),
    });
  });

  app.post("/v1/units/:unit/key/accept", admin, (c) =>
    store.acceptPendingKey(c.req.param("unit"), "owner:api", c.req.query("fingerprint") ?? "")
      ? c.json({ accepted: true })
      : c.json({ error: "no pending key" }, 404),
  );

  app.get("/v1/units/:unit/events", admin, (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const limit = clampLimit(c.req.query("limit"), 500);
    return c.json({ events: store.events(c.req.param("unit"), after, limit) });
  });

  app.post("/v1/commands", admin, async (c) => {
    const body = IssueBody.parse(await c.req.json());
    // A wipe goes only through the full reset (export, verified push, the owner's confirmation).
    if (body.kind === "wipe_state")
      return c.json({ error: "wipe_state is issued only by a full reset" }, 400);
    const { id } = issueCommand(store, privateKeyPem, {
      unit: body.unit,
      kind: body.kind,
      payload: body.payload,
      ttlMinutes: body.ttl_minutes,
      // The admin token is the owner's; who issued a command is control's to say, not the client's.
      issuedBy: "owner:api",
    });
    return c.json({ id, status: "pending" }, 201);
  });

  app.get("/v1/commands", admin, (c) =>
    c.json({ commands: store.listCommands(clampLimit(c.req.query("limit"), 100)) }),
  );

  app.get("/v1/audit", admin, (c) =>
    c.json({ audit: store.listAudit(clampLimit(c.req.query("limit"), 200)) }),
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
      driver: opts.driver,
    }),
  );
  app.get("/", (c) => c.redirect("/ui", 302));
  mountMcp(app, store, {
    adminToken: tokens.admin,
    agentToken: tokens.agent,
    readToken: tokens.read,
    privateKeyPem,
    staleAfterMs: opts.staleAfterMs,
  });

  return app;
}
