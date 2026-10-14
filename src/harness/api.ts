import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { laneLimits } from "../core/contract.ts";
import { Registry } from "./agents/registry.ts";
import { type Role, type Runner, RunRequest } from "./broker/runner.ts";
import { LedgerError } from "./ledger.ts";
import type { Research } from "./research/research.ts";
import { Reviews } from "./reviews.ts";
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

function allows(tokens: ApiTokens, scopes: Scope[], header: string | undefined): boolean {
  const h = header ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return scopes.some((s) => {
    const expected = tokens[s];
    return expected !== undefined && expected.length > 0 && tokenMatches(token, expected);
  });
}

function requireScope(tokens: ApiTokens, scopes: Scope[]): MiddlewareHandler {
  return async (c, next) => {
    if (!allows(tokens, scopes, c.req.header("authorization")))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

class Unauthorized extends Error {}

function statusFor(err: unknown): 400 | 401 | 404 | 409 | 500 {
  if (err instanceof Unauthorized) return 401;
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
  /**
   * Lane work for worker agents that run as their own users: the runner (the broker) and the
   * lane tool's argv. The agent names the tool as "lanetool"; the harness substitutes the argv.
   */
  lanes?: { runner: Runner; laneTool: string[] } | undefined;
  /** Agents' development runs on the device (judge first), bound to the calling trial. */
  devRuns?:
    | {
        run(
          input: unknown,
          trial: string,
          limits?: { rssMib: number; diskMib: number },
        ): Promise<unknown>;
      }
    | undefined;
  /** Research mode: the harness's fetcher, corpus and claim ledger. */
  research?: Research | undefined;
}

/** A worker's own trial token: `Authorization: Bearer trial.<token>`. */
function trialToken(header: string | undefined): string | undefined {
  const h = header ?? "";
  return h.startsWith("Bearer trial.") ? h.slice("Bearer trial.".length) : undefined;
}

const Strings = z.array(z.string().max(500)).max(50).default([]);

export function createHarnessApi(
  service: HarnessService,
  tokens: ApiTokens,
  extras: HarnessApiExtras = {},
): Hono {
  const app = new Hono();
  const supervisor = requireScope(tokens, ["supervisor"]);
  const registry = new Registry(service.ledger);
  /** The caller's open trial (its token binds the instance and lane). */
  const trialOf = (header: string | undefined) => {
    const token = trialToken(header);
    if (!token) throw new Unauthorized("unauthorized");
    try {
      return { token, trial: registry.openTrial(token) };
    } catch (err) {
      if (err instanceof LedgerError && err.code === "not_found")
        throw new Unauthorized("unauthorized");
      throw err;
    }
  };

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

  // The supervisor's deterministic inputs for its teacher pair, auditor and review panel, and
  // where their outputs go. None of these can set a verdict, a contract or a champion.
  app.get("/v1/instances", supervisor, (c) =>
    c.json({
      instances: service.ledger
        .listInstances()
        .map((i) => ({ id: i.id, campaign: i.campaign, mode: i.mode, status: i.status })),
    }),
  );

  app.get("/v1/brief", supervisor, (c) => {
    const instance = z.string().min(1).parse(c.req.query("instance"));
    return c.json(service.brief(instance) as object);
  });

  app.get("/v1/audits/pending", supervisor, async (c) =>
    c.json({ audits: await service.auditPackages() }),
  );

  app.post("/v1/audits", supervisor, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const body = z
      .strictObject({
        attempt: z.string().min(1).max(64),
        decision: z.enum(["clear", "block", "needs_owner"]),
        reasons: z.string().min(1).max(8000),
        citations: z.array(z.string().min(1).max(500)).max(20).default([]),
        auditor: z.string().min(1).max(100),
      })
      .parse(await c.req.json());
    return c.json(
      (await service.decideAudit({ ...body, auditor: `supervisor:${body.auditor}` })) as object,
    );
  });

  app.get("/v1/reviews/pending", supervisor, (c) =>
    c.json({ reviews: new Reviews(service.ledger).pending() }),
  );

  app.post("/v1/reviews/:id", supervisor, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const id = z.coerce.number().int().positive().parse(c.req.param("id"));
    const body = z
      .strictObject({
        results: z
          .array(
            z.strictObject({
              reviewer: z.string().min(1).max(100),
              pass: z.boolean(),
              reasons: z.string().min(1).max(8000),
            }),
          )
          .min(1)
          .max(8),
      })
      .parse(await c.req.json());
    return c.json({
      review: id,
      result: new Reviews(service.ledger).recordPanel(id, body.results, "supervisor"),
    });
  });

  app.post("/v1/exports/done", supervisor, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const body = z
      .object({ names: z.array(z.string().max(80)).max(5000) })
      .parse(await c.req.json());
    return c.json({ removed: service.removeExports(body.names) });
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

  // Workers submit with their trial token (the trial decides instance, lane and parent); the
  // proposer token is for the CLI and scripted proposers in development.
  app.post("/v1/attempts", bodyLimit({ maxSize: 32 * 1024 * 1024 }), async (c) => {
    if (trialToken(c.req.header("authorization"))) {
      const { token } = trialOf(c.req.header("authorization"));
      const body = SubmitRequest.pick({
        patch_base64: true,
        hypothesis: true,
        claim: true,
        known_flaws: true,
      }).parse(await c.req.json());
      return c.json(await service.submitForTrial(token, body), 201);
    }
    if (!allows(tokens, ["proposer"], c.req.header("authorization")))
      throw new Unauthorized("unauthorized");
    const req = SubmitRequest.parse(await c.req.json());
    return c.json(await service.submitAttempt(req, "proposer"), 201);
  });

  // A worker's lane work: only in its own trial's workspace, as its lane's user, with the lane
  // tool or a shell command, within the limits of a lane's run.
  app.post("/v1/lane/run", bodyLimit({ maxSize: 9 * 1024 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const lanes = extras.lanes;
    const ws = service.trialWorkspaces.get(trial.id);
    if (!lanes || !ws) return c.json({ error: "no workspace for this trial" }, 404);
    const req = RunRequest.parse(await c.req.json());
    const inside = (p: string) => {
      const full = resolve(p);
      return full === ws.root || full.startsWith(`${ws.root}/`);
    };
    if (req.role !== trial.lane) throw new Unauthorized("not this trial's lane");
    if (req.gpu) throw new Unauthorized("device runs go through dev_run");
    if (!inside(req.cwd) || (req.disk && !inside(req.disk.path)))
      throw new Unauthorized("outside the trial's workspace");
    // The contract's lane limits (defaults when it sets none) bound every lane command.
    const limits = laneLimits(service.contractFor(trial.instance));
    const rssCap = limits.runRssMib * 1024 ** 2;
    const diskCap = limits.workspaceMib * 1024 ** 2;
    let argv: string[];
    if (req.argv[0] === "lanetool") argv = [...lanes.laneTool, ...req.argv.slice(1)];
    else if (req.argv.length === 3 && req.argv[0] === "sh" && req.argv[1] === "-c") argv = req.argv;
    else throw new Unauthorized("only the lane tool or a shell command");
    const r = await lanes.runner.run({
      role: trial.lane as Role,
      argv,
      cwd: req.cwd,
      env: {},
      timeoutMs: Math.min(req.timeoutMs, limits.runTimeoutS * 1000),
      rssLimitBytes: Math.min(req.rssLimitBytes ?? rssCap, rssCap),
      ...(req.disk
        ? { disk: { path: req.disk.path, limitBytes: Math.min(req.disk.limitBytes, diskCap) } }
        : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      captureBytes: Math.min(req.captureBytes ?? 64 * 1024, 32 * 1024 * 1024),
    });
    return c.json(r as object);
  });

  app.post("/v1/dev-runs", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    if (!extras.devRuns) return c.json({ error: "dev runs are not available" }, 404);
    const body = z
      .object({ command: z.string(), timeout_s: z.number().optional(), cwd: z.string() })
      .parse(await c.req.json());
    const limits = laneLimits(service.contractFor(trial.instance));
    return c.json(
      (await extras.devRuns.run(
        {
          ...body,
          timeout_s: Math.min(Math.trunc(body.timeout_s ?? 120), limits.devRunTimeoutS),
          lane: trial.lane,
        },
        trial.id,
        { rssMib: limits.devRunRssMib, diskMib: limits.workspaceMib },
      )) as object,
    );
  });

  app.post("/v1/research/:op", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const r = extras.research;
    if (!r) return c.json({ error: "research is not available" }, 404);
    const body = (await c.req.json()) as Record<string, unknown>;
    // The trial decides where its work goes; instance and lane in the body are ignored.
    const { instance, lane } = trial;
    r.requireRunning(instance);
    const s = (k: string) => String(body[k] ?? "");
    switch (c.req.param("op")) {
      case "fetch":
        return c.json(await r.fetch(instance, lane, s("url")));
      case "read":
        return c.json(
          r.read(instance, s("source"), Number(body.offset ?? 0), Number(body.length ?? 6000)),
        );
      case "search":
        return c.json(r.search(instance, lane, s("query")));
      case "search-corpus":
        return c.json(r.searchCorpus(instance, s("text")));
      case "claim":
        return c.json(r.addClaim(instance, lane, body));
      case "note":
        return c.json(r.addNote(instance, lane, s("text"), Strings.parse(body.sources)));
      case "hypothesis":
        return c.json(
          r.proposeHypothesis(instance, lane, s("text"), Strings.parse(body.supporting)),
        );
      case "section":
        return c.json(r.updateSection(instance, lane, s("name"), s("body")));
      case "stats":
        return c.json({ ...r.stats(instance), clock: r.clock(instance) });
      default:
        return c.json({ error: "unknown research operation" }, 404);
    }
  });

  app.get("/v1/attempts/:id", async (c) => {
    const id = c.req.param("id");
    if (trialToken(c.req.header("authorization"))) {
      // A worker sees only its own lane's attempts.
      const { trial } = trialOf(c.req.header("authorization"));
      const a = service.ledger.getAttempt(id);
      if (!a || String(a.instance) !== trial.instance || String(a.lane) !== trial.lane)
        throw new LedgerError("not_found", `no attempt ${id} in this lane`);
      return c.json(service.attemptStatus(id) as object);
    }
    if (!allows(tokens, ["supervisor", "proposer"], c.req.header("authorization")))
      throw new Unauthorized("unauthorized");
    return c.json(service.attemptStatus(id) as object);
  });

  return app;
}
