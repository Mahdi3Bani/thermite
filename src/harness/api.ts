import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { laneLimits } from "../core/contract.ts";
import { McpConnection, McpUnavailable } from "../core/mcp.ts";
import { AdvisorAgent, CallUsage, UsageHarness } from "../core/usage.ts";
import { ControlRoute } from "./agents/model-source.ts";
import { Registry } from "./agents/registry.ts";
import { USAGE_BATCH } from "./agents/usage-meter.ts";
import { laneCacheEnv } from "./agents/workspace.ts";
import { type Role, type Runner, RunRequest } from "./broker/runner.ts";
import { compactionOf, KEPT_MAX } from "./compactions.ts";
import { SEARCH_MAX } from "./knowledge.ts";
import { LedgerError } from "./ledger.ts";
import type { McpCaller } from "./mcp-gateway.ts";
import { forwardToProvider } from "./model-forward.ts";
import type { Research } from "./research/research.ts";
import { AdvisorQueueRequest, type HarnessService, SubmitRequest } from "./service.ts";

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
          limits?: { rssMib: number; diskMib: number; timeoutS?: number; processes?: number },
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

  // The model proxy: OpenCode and the Codex CLI reach the rig's provider through here, so the
  // provider's key (or a ChatGPT sign-in's access token) never reaches the lane. It takes a
  // trial's token or one the harness minted for a check or a plan (as a bearer token, or as
  // Anthropic's x-api-key), adds the real key and streams the answer. A minted token may name
  // its own route: the planner's, when control gave the planner a model of its own (goal 073).
  const openTrial = (token: string) => {
    try {
      return registry.openTrial(token).id;
    } catch {
      return undefined;
    }
  };
  app.all("/v1/model-proxy/*", bodyLimit({ maxSize: 64 * 1024 * 1024 }), async (c) => {
    const bearer = c.req.header("authorization") ?? "";
    const given = bearer.startsWith("Bearer ")
      ? bearer.slice(7)
      : (c.req.header("x-api-key") ?? "");
    const trial = given.startsWith("trial.");
    const trialId = trial ? openTrial(given.slice("trial.".length)) : undefined;
    const ok = trial ? trialId !== undefined : service.proxyTokenValid(given);
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    const m = (trial ? undefined : service.proxyTokenModel(given)) ?? service.models?.current();
    // OpenCode's own models need no proxy; a Claude subscription is used only by Claude Code.
    if (!m || m.api === "opencode" || m.api === "claude")
      return c.json({ error: "no provider to reach" }, 404);
    return forwardToProvider(
      {
        method: c.req.method,
        rest: c.req.path.slice("/v1/model-proxy/".length),
        search: new URL(c.req.url).search,
        header: (k) => c.req.header(k),
        body:
          c.req.method === "GET" || c.req.method === "HEAD"
            ? undefined
            : Buffer.from(await c.req.arrayBuffer()),
      },
      { api: m.api, baseUrl: m.baseUrl, key: m.keyNow?.() ?? m.apiKey },
      () => service.noteUsageLimit(),
      // Each error answer, for the trial (or the check or plan) to tell its kind (goal 079).
      (a) => service.noteProviderAnswer(trialId ?? "proxy", a),
    );
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

  // The MCP servers control gave the rig (goal 068), as the supervisor hands them over: their
  // sign-in stays in this process's memory, and only their revisions are read back.
  app.get("/v1/mcp-servers", supervisor, (c) => c.json(service.mcp.info()));
  app.put("/v1/mcp-servers", supervisor, bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const body = z
      .object({
        servers: z.array(McpConnection).max(50),
        unavailable: z.array(McpUnavailable).max(50).default([]),
      })
      .parse(await c.req.json());
    service.mcp.set(body.servers, body.unavailable);
    return c.json(service.mcp.info());
  });
  // The advisors' calls go through the supervisor: it says here when a server failed for them,
  // or works again, and the run's history records it as the gateway records its own.
  app.post("/v1/mcp-events", supervisor, async (c) => {
    const b = z
      .strictObject({
        run: z.string().min(1).max(200),
        server: z.string().min(1).max(64),
        ok: z.boolean(),
        error: z.string().max(500).optional(),
      })
      .parse(await c.req.json());
    if (!service.ledger.getRun(b.run)) return c.json({ error: `no run ${b.run}` }, 404);
    service.mcp.report(
      { run: b.run, kind: "advisors", source: "supervisor" },
      b.server,
      b.ok,
      b.error,
    );
    return c.json({ ok: true });
  });

  // The MCP gateway for workers (their trial's token) and the planner (a credential the harness
  // made for one plan): the tools their run's kit gives their kind of agent, never a secret.
  const mcpCaller = (header: string | undefined): McpCaller => {
    const h = header ?? "";
    const given = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (given.startsWith("trial.")) {
      const t = trialOf(h).trial;
      return { run: t.run, kind: "workers", source: `trial:${t.id}` };
    }
    const caller = given.startsWith("mcp.") ? service.mcpTokenCaller(given) : undefined;
    if (!caller) throw new Unauthorized("unauthorized");
    return caller;
  };
  app.get("/v1/mcp-tools", async (c) =>
    c.json(await service.mcp.tools(mcpCaller(c.req.header("authorization")))),
  );
  app.post("/v1/mcp-call", bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const caller = mcpCaller(c.req.header("authorization"));
    const b = z
      .strictObject({
        server: z.string().min(1).max(64),
        tool: z.string().min(1).max(128),
        arguments: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(await c.req.json());
    return c.json(await service.mcp.call(caller, b.server, b.tool, b.arguments));
  });
  // One server as an MCP endpoint (streamable HTTP, stateless), for OpenCode and Claude Code.
  app.all("/v1/mcp/:server", bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const caller = mcpCaller(c.req.header("authorization"));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await service.mcp.serverFor(caller, c.req.param("server")).connect(transport);
    return transport.handleRequest(c.req.raw);
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
    // Rules naming a direction the run doesn't have are left out, each with why (goal 066).
    return c.json(service.setAdvisorRules(body.run, body.directives, "supervisor"));
  });

  // The supervisor's deterministic inputs for its teachers, auditor and review panel, and
  // where their outputs go. None of these can set a verdict, a contract or a champion.
  app.get("/v1/runs", supervisor, (c) =>
    c.json({
      runs: service.ledger.listRuns().map((i) => ({
        id: i.id,
        campaign: i.campaign,
        mode: i.mode,
        status: i.status,
        // The owner's messages each advisor role has not read yet (their ids): a new one for the
        // teachers starts their round at once, not at the next hour.
        owner_messages_waiting: service.messages.waitingIds(i.id),
        // The MCP servers its kit names, with the agents that get each: the advisors' share is
        // the supervisor's to call (goal 068).
        mcp_servers: service.mcpUses(i.id),
        // The campaign's own context settings, which the advisors' calls for the run take too
        // (goal 070); null: none.
        agents_context: service.ledger.getContract(i.campaign, i.version)?.agents_context ?? null,
        // The planner's round left the queue below its target (goal 081): the teachers' round
        // starts at once, not on the clock. Null: the queue is at its target, or none applies.
        queue_low: service.queueLow(i.id),
      })),
    }),
  );

  app.get("/v1/brief", supervisor, (c) => {
    const run = z.string().min(1).parse(c.req.query("run"));
    return c.json(service.brief(run) as object);
  });

  // The teachers' reads of a run's code and evidence (goal 081), read only: the champion's tree,
  // one of its files by lines, an attempt's diff in parts, and the judge's public findings.
  // Nothing here reads the kit, a held-out cell or a measurement, and nothing writes: a failed
  // held-out check is only its kind in fixed words (goal 082).
  const runOf = (c: { req: { query(k: string): string | undefined } }) =>
    z.string().min(1).max(100).parse(c.req.query("run"));
  const numberOf = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  app.get("/v1/code/files", supervisor, async (c) =>
    c.json(await service.codeFiles(runOf(c), c.req.query("path") ?? "")),
  );
  app.get("/v1/code/file", supervisor, async (c) => {
    const q = z
      .object({
        path: z.string().min(1).max(500),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100_000).optional(),
      })
      .parse({
        path: c.req.query("path"),
        offset: numberOf(c.req.query("offset")),
        limit: numberOf(c.req.query("limit")),
      });
    return c.json(await service.codeFile(runOf(c), q.path, q.offset, q.limit));
  });
  app.get("/v1/code/diff", supervisor, async (c) => {
    const q = z
      .object({
        attempt: z.string().min(1).max(64),
        offset: z.number().int().min(0).optional(),
      })
      .parse({ attempt: c.req.query("attempt"), offset: numberOf(c.req.query("offset")) });
    return c.json(await service.attemptDiff(runOf(c), q.attempt, q.offset));
  });
  app.get("/v1/evidence", supervisor, (c) => {
    const attempt = z.string().min(1).max(64).optional().parse(c.req.query("attempt"));
    return c.json(service.evidence(runOf(c), attempt) as object);
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

  app.get("/v1/reviews/pending", supervisor, (c) => c.json({ reviews: service.reviewPackages() }));

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
    return c.json({ review: id, ...service.recordReviewPanel(id, body.results, "supervisor") });
  });

  // The supervisor says which advisors it has (goal 079): whether an auditor decides this rig's
  // audits, and its review panel's size. Without an auditor, the audits held go on by the run's
  // rules.
  app.put("/v1/advisors", supervisor, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const body = z
      .strictObject({ auditor: z.boolean(), panel: z.number().int().min(0).max(100) })
      .parse(await c.req.json());
    return c.json({ released: await service.setAdvisors(body, "supervisor") });
  });

  // The advisors' receipts and answers for the owner's messages: which messages an advisor role
  // was given (in its brief or package) and what it answered. Each message must be in the run and
  // addressed to that role.
  app.post("/v1/advisor-messages", supervisor, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const body = z
      .strictObject({
        run: z.string().min(1).max(100),
        role: z.enum(["teachers", "auditor", "panel"]),
        read: z.array(z.number().int().positive()).max(100).default([]),
        answers: z
          .array(
            z.strictObject({
              message: z.number().int().positive(),
              text: z.string().min(1).max(2000),
              advisor: z.string().min(1).max(100).optional(),
            }),
          )
          .max(100)
          .default([]),
      })
      .parse(await c.req.json());
    return c.json(service.advisorMessages(body));
  });

  // The advisors' additions and moves for a run's experiment queue, each recorded with the
  // advisor role as who made it. Advisors add and reorder; they don't drop or give out work.
  app.post("/v1/queue", supervisor, bodyLimit({ maxSize: 256 * 1024 }), async (c) =>
    c.json(service.advisorQueue(AdvisorQueueRequest.parse(await c.req.json()))),
  );

  // The advisors' field notes, posted after their review, audit or verdict: each recorded as
  // written by `<role>:<name>`. Each note is checked on its own; a refused one is said.
  app.post("/v1/journal", supervisor, bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    const body = z
      .strictObject({
        run: z.string().min(1).max(100),
        role: z.enum(["teachers", "auditor", "panel"]),
        by: z.string().trim().min(1).max(100),
        notes: z.array(z.unknown()),
      })
      .parse(await c.req.json());
    return c.json(service.advisorNotes(body));
  });

  // Past research for a run's folder, from control's knowledge base (the supervisor syncs it):
  // each item a file under the run's knowledge/. `folders` (the folders the run's campaign may
  // read now) removes a folder whose grant was revoked.
  app.post("/v1/kb", supervisor, bodyLimit({ maxSize: 32 * 1024 * 1024 }), async (c) => {
    const body = z
      .strictObject({
        run: z.string().min(1).max(100),
        items: z.array(z.unknown()),
        folders: z.array(z.string().min(1).max(200)).optional(),
      })
      .parse(await c.req.json());
    return c.json(service.writeKnowledge(body.run, body.items, body.folders));
  });

  // A search of a run's past research for its advisors, read only (the supervisor gives it to
  // them as a tool): the items of its knowledge/ with every word given, newest first, marked as
  // data. Nothing here writes.
  app.get("/v1/knowledge", supervisor, (c) => {
    const q = z
      .object({
        run: z.string().min(1).max(100),
        q: z.string().max(300).default(""),
        kinds: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(SEARCH_MAX).optional(),
      })
      .parse({
        run: c.req.query("run"),
        q: c.req.query("q") ?? undefined,
        kinds: c.req.query("kinds") ?? undefined,
        limit: c.req.query("limit") ?? undefined,
      });
    if (!service.ledger.getRun(q.run)) return c.json({ error: `no run ${q.run}` }, 404);
    return c.json(
      service.knowledge.search(q.run, q.q, {
        kinds: q.kinds ? q.kinds.split(",").map((k) => k.trim()) : undefined,
        limit: q.limit,
      }),
    );
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
          // What an agent's session produces; the owner's messages and their receipts are the
          // harness's own lines, never a worker's.
          .array(
            z.object({
              kind: z.enum(["text", "thinking", "tool", "result"]),
              text: z.string().max(8000),
            }),
          )
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
        /** The trial waits for its provider, then goes on in the same conversation (goal 079). */
        wait: z
          .object({
            until: z.iso.datetime(),
            kind: z.enum(["rate_limit", "server", "model", "context", "credits", "auth", "route"]),
            words: z.string().max(2000),
          })
          .optional(),
      })
      .parse(await c.req.json());
    service.trialReport(trial, body);
    if (body.wait) service.trialWait(trial, body.wait);
    return c.json({ ok: true });
  });

  // The owner's messages waiting for this trial (to it, its lane or everyone working). Fetching
  // them gives nothing to the agent: the worker confirms each one once its agent has it.
  app.get("/v1/trial/messages", (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    return c.json({
      messages: service.trialInbox({ id: trial.id, run: trial.run, lane: trial.lane }).waiting(),
    });
  });

  // The worker's receipt: these messages reached its agent (only messages waiting for it count).
  app.post("/v1/trial/messages/read", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const body = z
      .object({ ids: z.array(z.number().int().positive()).min(1).max(100) })
      .parse(await c.req.json());
    service.trialInbox({ id: trial.id, run: trial.run, lane: trial.lane }).given(body.ids);
    return c.json({ ok: true });
  });

  // A worker's idea for its run's queue: proposed by its lane (its trial decides run and lane).
  app.post("/v1/trial/idea", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { token } = trialOf(c.req.header("authorization"));
    return c.json(service.proposeIdea(token, await c.req.json()), 201);
  });

  // A worker's field note: its trial decides the run, the lane and who wrote it.
  app.post("/v1/trial/note", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { token } = trialOf(c.req.header("authorization"));
    return c.json(service.writeTrialNote(token, await c.req.json()), 201);
  });

  // A Pi worker compacts its conversation (goal 070): first the whole conversation, kept in the
  // run's research folder (the trial decides the run, the lane and the file's name), then the
  // record of the compaction. Both come from the worker's own code, never from its agent.
  app.post("/v1/trial/snapshot", bodyLimit({ maxSize: 2 * KEPT_MAX + 64 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    if (!service.compactions) return c.json({ error: "this harness keeps no compactions" }, 404);
    const body = z
      .strictObject({
        number: z.number().int().min(1).max(10_000),
        markdown: z.string().min(1).max(KEPT_MAX),
      })
      .parse(await c.req.json());
    return c.json(service.compactions.keep(compactionOf(trial), body.number, body.markdown), 201);
  });
  app.post("/v1/trial/compacted", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    if (!service.compactions) return c.json({ error: "this harness keeps no compactions" }, 404);
    const b = z
      .strictObject({
        number: z.number().int().min(1).max(10_000),
        tokens_before: z.number().int().min(0),
        tokens_after: z.number().int().min(0),
        how: z.enum(["summary", "trimmed"]),
        kept: z.boolean(),
        summary: z.string().max(32_000).optional(),
        error: z.string().max(2000).optional(),
      })
      .parse(await c.req.json());
    service.compactions.record(compactionOf(trial), {
      number: b.number,
      tokensBefore: b.tokens_before,
      tokensAfter: b.tokens_after,
      how: b.how,
      harness: "pi",
      summary: b.summary,
      error: b.error,
      kept: b.kept,
    });
    return c.json({ ok: true }, 201);
  });

  // A Pi worker's model usage (goal 075): what its own code measured of each model call, never
  // its agent. The trial decides the run, the trial and the route; only a trial whose worker hands
  // its usage over may (the harness reads the other programs' output itself).
  app.post("/v1/trial/usage", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const body = z
      .strictObject({ calls: z.array(CallUsage).min(1).max(USAGE_BATCH) })
      .parse(await c.req.json());
    return c.json({ recorded: service.usage.fromTrial(trial, body.calls) }, 201);
  });

  // The advisors' model usage (goal 075): one advisor's calls in a run, as the supervisor's code
  // measured them. Only the advisors' own kinds; the workers' and the planner's are the harness's.
  app.post("/v1/model-calls", supervisor, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const b = z
      .strictObject({
        run: z.string().min(1).max(100),
        round: z.string().min(1).max(200).nullable(),
        agent: AdvisorAgent,
        harness: UsageHarness,
        provider: z.string().min(1).max(100).nullable(),
        model: z.string().min(1).max(200),
        calls: z.array(CallUsage).min(1).max(500),
      })
      .parse(await c.req.json());
    const { run, calls, ...ctx } = b;
    return c.json(
      { recorded: service.usage.fromSupervisor(run, { trial: null, ...ctx }, calls) },
      201,
    );
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
      // From the contract, never from the request.
      nproc: limits.processes,
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
          processes: limits.processes,
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
    // The trial decides where its work goes; run and lane in the body are ignored. A hill-climb
    // or goal trial records sources, claims and notes too (goal 065); the rest is research's.
    const { run, lane } = trial;
    r.requireRunning(run, c.req.param("op"));
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
        return c.json(r.addNote(run, lane, s("text"), Strings.parse(body.sources), trial.id));
      case "hypothesis":
        return c.json(r.proposeHypothesis(run, lane, s("text"), Strings.parse(body.supporting)));
      case "finding":
        return c.json(r.addFinding(run, lane, body));
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
      // A worker reads any attempt of its own campaign on this rig: its lane's, another lane's
      // (a hand-out may name one), or an earlier run's (the knowledge base shows those). Its
      // brief still shows only its own lane's (goal 082).
      const { trial } = trialOf(c.req.header("authorization"));
      const a = service.ledger.getAttempt(id);
      const campaign = (run: unknown) => service.ledger.getRun(String(run))?.campaign;
      if (!a || campaign(a.run) !== campaign(trial.run))
        throw new LedgerError("not_found", `no attempt ${id} in this campaign`);
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
