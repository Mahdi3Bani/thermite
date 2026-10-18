import { timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { laneLimits } from "../core/contract.ts";
import { LIVE_KINDS } from "../core/live.ts";
import { ControlRoute } from "./agents/model-source.ts";
import { Registry } from "./agents/registry.ts";
import { laneCacheEnv } from "./agents/workspace.ts";
import { type Role, type Runner, RunRequest } from "./broker/runner.ts";
import { chatgptRequest, chatgptRouteAllowed } from "./chatgpt.ts";
import { LedgerError } from "./ledger.ts";
import type { Research } from "./research/research.ts";
import { Reviews } from "./reviews.ts";
import { type HarnessService, SubmitRequest } from "./service.ts";

/**
 * Harness HTTP API. Only the rig's own supervisor reaches it over the network; proposers
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
  /** The caller's open trial (its token binds the run and lane). */
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

  app.get("/v1/health", (c) => c.json({ ok: true, rig: service.rig }));

  // The model proxy: OpenCode reaches the rig's provider through here, so the provider's key never
  // reaches the lane. It takes a trial's token or one the harness minted for a check or a plan
  // (as a bearer token, or as Anthropic's x-api-key), adds the real key and streams the answer.
  const openTrial = (token: string) => {
    try {
      registry.openTrial(token);
      return true;
    } catch {
      return false;
    }
  };
  app.all("/v1/model-proxy/*", bodyLimit({ maxSize: 64 * 1024 * 1024 }), async (c) => {
    const bearer = c.req.header("authorization") ?? "";
    const given = bearer.startsWith("Bearer ")
      ? bearer.slice(7)
      : (c.req.header("x-api-key") ?? "");
    const ok = given.startsWith("trial.")
      ? openTrial(given.slice("trial.".length))
      : service.proxyTokenValid(given);
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    const m = service.models?.current();
    // OpenCode's own models need no proxy; a Claude subscription is used only by Claude Code.
    if (!m || m.api === "opencode" || m.api === "claude")
      return c.json({ error: "no provider to reach" }, 404);
    const rest = c.req.path.slice("/v1/model-proxy/".length);
    // A ChatGPT sign-in reaches only OpenAI's Responses API and the account's model list.
    const chatgpt = m.api === "chatgpt";
    if (chatgpt && !chatgptRouteAllowed(c.req.method, rest))
      return c.json(
        { error: "a ChatGPT sign-in reaches only POST /responses and GET /models" },
        403,
      );
    const target = new URL(`${m.baseUrl}/${rest}${new URL(c.req.url).search}`);
    const headers: Record<string, string> = {};
    for (const k of [
      "content-type",
      "accept",
      "anthropic-version",
      "anthropic-beta",
      "user-agent",
    ]) {
      const v = c.req.header(k);
      if (v) headers[k] = v;
    }
    if (m.api === "anthropic") headers["x-api-key"] = m.apiKey;
    else headers.authorization = `Bearer ${m.keyNow?.() ?? m.apiKey}`;
    const raw =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? undefined
        : Buffer.from(await c.req.arrayBuffer());
    let body: Buffer | undefined = raw;
    if (raw && chatgpt) {
      try {
        body = chatgptRequest(raw);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    if (body) headers["content-length"] = String(body.length);
    // node:http, not fetch: a long model call must not meet fetch's header timeout.
    return await new Promise<Response>((resolve) => {
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(target, { method: c.req.method, headers, agent: false }, (res) => {
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            res.on("data", (d: Buffer) => ctrl.enqueue(new Uint8Array(d)));
            res.on("end", () => ctrl.close());
            res.on("error", (e) => ctrl.error(e));
          },
          cancel() {
            res.destroy();
          },
        });
        const out = new Headers();
        for (const k of ["content-type", "cache-control"]) {
          const v = res.headers[k];
          if (typeof v === "string") out.set(k, v);
        }
        resolve(new Response(stream, { status: res.statusCode ?? 502, headers: out }));
      });
      req.on("error", (e) =>
        resolve(
          Response.json(
            { error: `the provider could not be reached: ${e.message}` },
            { status: 502 },
          ),
        ),
      );
      if (body) req.write(body);
      req.end();
    });
  });

  // The rig's settings (Edit rig), for the supervisor's own parts: its advisors.
  app.get("/v1/settings", supervisor, (c) => c.json(service.settings.get()));

  // The agents' model route, as control set it: the supervisor hands it over (key included) and
  // reads back which route is in use (never the key).
  app.get("/v1/model-route", supervisor, (c) =>
    service.models
      ? c.json({ ...service.models.info(), planner_revision: service.models.plannerRevision() })
      : c.json({ error: "no agents on this rig" }, 404),
  );
  app.put("/v1/model-route", supervisor, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    if (!service.models) return c.json({ error: "no agents on this rig" }, 404);
    const body = z
      .object({ route: ControlRoute.nullable(), planner: ControlRoute.nullable().optional() })
      .parse(await c.req.json());
    return c.json(service.setModelRoute(body.route, "supervisor", body.planner));
  });

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
      .object({ run: z.string().min(1), directives: z.unknown() })
      .parse(await c.req.json());
    return c.json({ ids: service.addDirectives(body.run, body.directives, "supervisor") });
  });

  // The supervisor's deterministic inputs for its teacher pair, auditor and review panel, and
  // where their outputs go. None of these can set a verdict, a contract or a champion.
  app.get("/v1/runs", supervisor, (c) =>
    c.json({
      runs: service.ledger
        .listRuns()
        .map((i) => ({ id: i.id, campaign: i.campaign, mode: i.mode, status: i.status })),
    }),
  );

  app.get("/v1/brief", supervisor, (c) => {
    const run = z.string().min(1).parse(c.req.query("run"));
    return c.json(service.brief(run) as object);
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

  // The live log, signed, for the supervisor to relay to control.
  app.get("/v1/live", supervisor, (c) => {
    const after = Number(c.req.query("after") ?? "0");
    const limit = Math.min(Number(c.req.query("limit") ?? "500"), 2000);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1) {
      return c.json({ error: "bad after or limit" }, 400);
    }
    return c.json(service.liveBatch(after, limit) as object);
  });

  // A worker's own lines for the live log: its trial decides the source, lane and run.
  app.post("/v1/trial/live", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const body = z
      .object({
        entries: z
          .array(z.object({ kind: z.enum(LIVE_KINDS), text: z.string().max(8000) }))
          .max(200),
        /** The session's counters so far (turns, tool calls, tokens). */
        progress: z
          .object({
            turns: z.number().int().min(0),
            tool_calls: z.number().int().min(0),
            tokens_in: z.number().int().min(0),
            tokens_out: z.number().int().min(0),
          })
          .optional(),
      })
      .parse(await c.req.json());
    if (body.progress) service.trialProgress.set(trial.id, body.progress);
    for (const e of body.entries) {
      service.live.append({
        source: `trial:${trial.id}`,
        kind: e.kind,
        text: e.text,
        lane: trial.lane,
        run: trial.run,
      });
    }
    return c.json({ ok: true });
  });

  // The owner's messages for this trial (sent to it or to its lane), each delivered once.
  app.get("/v1/trial/messages", (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    return c.json({
      messages: service.takeMessages({ id: trial.id, run: trial.run, lane: trial.lane }),
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

  // Workers submit with their trial token (the trial decides run, lane and parent); the
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
    // The contract's lane limits bound every lane command: memory and disk always (defaults
    // when it sets none), time only when it sets one.
    const limits = laneLimits(service.contractFor(trial.run));
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
      env: laneCacheEnv(service.paths.scratchDir, trial.lane),
      ...timeLimit(req.timeoutMs, limits.runTimeoutS),
      rssLimitBytes: Math.min(req.rssLimitBytes ?? rssCap, rssCap),
      ...(req.disk
        ? { disk: { path: req.disk.path, limitBytes: Math.min(req.disk.limitBytes, diskCap) } }
        : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      captureBytes: Math.min(req.captureBytes ?? 64 * 1024, 32 * 1024 * 1024),
      // As in a shell: what a command starts in the background runs on until the trial ends.
      keepBackground: true,
    });
    return c.json(r as object);
  });

  app.post("/v1/dev-runs", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    if (!extras.devRuns) return c.json({ error: "dev runs are not available" }, 404);
    const body = z
      .object({ command: z.string(), timeout_s: z.number().optional(), cwd: z.string() })
      .parse(await c.req.json());
    const limits = laneLimits(service.contractFor(trial.run));
    return c.json(
      (await extras.devRuns.run(
        {
          ...body,
          ...(body.timeout_s !== undefined
            ? { timeout_s: Math.max(1, Math.trunc(body.timeout_s)) }
            : {}),
          lane: trial.lane,
        },
        trial.id,
        {
          rssMib: limits.devRunRssMib,
          diskMib: limits.workspaceMib,
          ...(limits.devRunTimeoutS !== undefined ? { timeoutS: limits.devRunTimeoutS } : {}),
        },
      )) as object,
    );
  });

  app.post("/v1/research/:op", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const r = extras.research;
    if (!r) return c.json({ error: "research is not available" }, 404);
    const body = (await c.req.json()) as Record<string, unknown>;
    // The trial decides where its work goes; run and lane in the body are ignored.
    const { run, lane } = trial;
    r.requireRunning(run);
    const s = (k: string) => String(body[k] ?? "");
    switch (c.req.param("op")) {
      case "fetch":
        return c.json(await r.fetch(run, lane, s("url")));
      case "read":
        return c.json(
          r.read(run, s("source"), Number(body.offset ?? 0), Number(body.length ?? 6000)),
        );
      case "search":
        return c.json(r.search(run, lane, s("query")));
      case "search-corpus":
        return c.json(r.searchCorpus(run, s("text")));
      case "claim":
        return c.json(r.addClaim(run, lane, body));
      case "note":
        return c.json(r.addNote(run, lane, s("text"), Strings.parse(body.sources)));
      case "hypothesis":
        return c.json(r.proposeHypothesis(run, lane, s("text"), Strings.parse(body.supporting)));
      case "section":
        return c.json(r.updateSection(run, lane, s("name"), s("body")));
      case "stats":
        return c.json({ ...r.stats(run), clock: r.clock(run) });
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
      if (!a || String(a.run) !== trial.run || String(a.lane) !== trial.lane)
        throw new LedgerError("not_found", `no attempt ${id} in this lane`);
      return c.json(service.attemptStatus(id) as object);
    }
    if (!allows(tokens, ["supervisor", "proposer"], c.req.header("authorization")))
      throw new Unauthorized("unauthorized");
    return c.json(service.attemptStatus(id) as object);
  });

  return app;
}

/** A command's time limit: what it asked for, within the contract's limit if there is one. */
function timeLimit(
  askedMs: number | undefined,
  limitS: number | undefined,
): { timeoutMs?: number } {
  const capMs = limitS !== undefined ? limitS * 1000 : undefined;
  const ms =
    askedMs === undefined ? capMs : capMs === undefined ? askedMs : Math.min(askedMs, capMs);
  return ms !== undefined ? { timeoutMs: ms } : {};
}
