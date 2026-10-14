import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { LedgerError } from "./ledger.ts";
import { type HarnessService, SubmitRequest } from "./service.ts";

/**
 * Harness HTTP API. Only the unit's own supervisor reaches it over the network; proposers
 * (workers) reach it locally. Every route except /v1/health needs a bearer token whose scope
 * allows it.
 */

export type Scope = "supervisor" | "proposer";

export interface ApiTokens {
  supervisor: string;
  /** Token for local proposers (scripted proposer in development, workers later). */
  proposer?: string | undefined;
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireScope(tokens: ApiTokens, scopes: Scope[]): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const allowed = scopes.some((s) => {
      const expected = tokens[s];
      return expected !== undefined && expected.length > 0 && tokenMatches(token, expected);
    });
    if (!allowed) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

function statusFor(err: unknown): 400 | 404 | 409 | 500 {
  if (err instanceof LedgerError) {
    return err.code === "not_found"
      ? 404
      : err.code === "conflict" || err.code === "stale"
        ? 409
        : 400;
  }
  if (err instanceof z.ZodError) return 400;
  return 500;
}

export interface HarnessApiExtras {
  /** Agents' development runs on the device (judge first). */
  devRuns?: { run(input: unknown): Promise<unknown> } | undefined;
}

export function createHarnessApi(
  service: HarnessService,
  tokens: ApiTokens,
  extras: HarnessApiExtras = {},
): Hono {
  const app = new Hono();
  const supervisor = requireScope(tokens, ["supervisor"]);
  const proposer = requireScope(tokens, ["proposer"]);
  const either = requireScope(tokens, ["supervisor", "proposer"]);

  app.onError((err, c) => {
    const status = statusFor(err);
    return c.json({ error: err instanceof z.ZodError ? "invalid request" : err.message }, status);
  });

  app.get("/v1/health", (c) => c.json({ ok: true, unit: service.unit }));

  app.get("/v1/snapshot", supervisor, (c) => {
    const cursor = Number(c.req.query("cursor") ?? "0");
    const limit = Math.min(Number(c.req.query("limit") ?? "500"), 5000);
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1) {
      return c.json({ error: "bad cursor or limit" }, 400);
    }
    return c.json(service.snapshot(cursor, limit) as object);
  });

  app.post("/v1/commands", supervisor, bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const outcome = await service.applyCommand(await c.req.json());
    if (outcome.status === "rejected") return c.json(outcome, 403);
    return c.json(outcome);
  });

  app.post("/v1/directives", supervisor, async (c) => {
    const body = z
      .object({ instance: z.string().min(1), directives: z.unknown() })
      .parse(await c.req.json());
    return c.json({ ids: service.addDirectives(body.instance, body.directives, "supervisor") });
  });

  app.post("/v1/export", supervisor, async (c) => {
    const r = await service.export("supervisor");
    return c.json({
      export: r.id,
      dir: r.dir.split("/").pop(),
      attempts: r.attempts,
      events: r.events,
    });
  });

  app.post("/v1/attempts", proposer, bodyLimit({ maxSize: 32 * 1024 * 1024 }), async (c) => {
    const req = SubmitRequest.parse(await c.req.json());
    return c.json(await service.submitAttempt(req, "proposer"), 201);
  });

  app.post("/v1/dev-runs", proposer, async (c) => {
    if (!extras.devRuns) return c.json({ error: "dev runs are not available" }, 404);
    return c.json((await extras.devRuns.run(await c.req.json())) as object);
  });

  app.get("/v1/attempts/:id", either, (c) =>
    c.json(service.attemptStatus(c.req.param("id")) as object),
  );

  return app;
}
