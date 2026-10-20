import { createPublicKey, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { log, redact } from "../common/env.ts";
import { sha256Hex } from "../core/canonical.ts";
import { COMMAND_KINDS, type CommandKind, reportBody, verifyJson } from "../core/commands.ts";
import { LiveBatch, LiveEntry, liveBody } from "../core/live.ts";
import { type BuildInfo, buildFromHeaders, buildInfo, readBuild } from "../core/version.ts";
import type { ControlActions } from "./actions.ts";
import { CHATGPT_API, ChatGPTLogins } from "./chatgpt.ts";
import type { ClusterKubectl } from "./clusters/kubectl.ts";
import { Credential, newToken } from "./credential.ts";
import { createDashboard, type RigImages } from "./dashboard.ts";
import { issueCommand, propagateChampion } from "./issue.ts";
import type { KitRepos } from "./kit-repos.ts";
import { advanceResets, cancelReset, confirmReset, type DeploymentDriver } from "./lifecycle.ts";
import type { MachineSsh } from "./machines/ssh.ts";
import { mountMcp } from "./mcp.ts";
import { metricsText } from "./metrics.ts";
import { OutsideKbs } from "./outside-kb.ts";
import { claudeModelName, isOpencodeOwn, providerBase } from "./providers.ts";
import type { probeRepository } from "./repo-probe.ts";
import { RunpodTests, type TestRequest } from "./runpod-tests.ts";
import { SecretBox } from "./secrets.ts";
import {
  type AgentRole,
  type ControlStore,
  type Effort,
  fingerprint,
  type Harness,
  type IngestReport,
  type ModelProvider,
  RIG_ID,
} from "./store.ts";
import { checkRig, recheckRefusals, rigVersions } from "./versions.ts";
import { leaderboard, reportingState, rigView } from "./views.ts";

/**
 * Control HTTP API (v1 core). Admin tokens issue commands and read everything; each rig's token
 * may only report for its own rig, fetch its own pending commands and acknowledge them.
 */

/**
 * Control's credentials. Each is a token or, in deployment, a Credential holding only the
 * token's hash (the owner keeps the token; see credential.ts).
 */
export interface ControlTokens {
  /** The owner's. */
  admin: string | Credential;
  /** Optional read-only token (MCP and API reads for observers). */
  read?: string | Credential | undefined;
  /**
   * Optional token for agents on MCP (for example a coordinating agent): it may read and steer
   * (assign, pause, resume, redirect, reset workers, export), never message agents, approve,
   * accept or wipe.
   */
  agent?: string | Credential | undefined;
  /**
   * Optional token the owner gives an operating agent on MCP: what the agent token may do, and
   * message the run's agents on the owner's behalf. Approvals, acceptances, endings and wipes
   * stay the owner's.
   */
  operator?: string | Credential | undefined;
  /** rig id -> token */
  rigs: Record<string, string>;
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
  rig: z.string().min(1),
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
  rig_pubkey: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
});

const IssueBody = z.object({
  rig: z.string().min(1),
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
      /** Which advisor roles the rig has configured (so control knows if an auditor decides). */
      roles: z
        .strictObject({
          teachers: Count,
          combiner: z.boolean(),
          auditor: z.boolean(),
          panel: Count,
        })
        .optional(),
    })
    .nullable()
    .optional(),
});

const AckBody = z.object({
  status: z.enum(["delivered", "rejected", "failed"]),
  outcome: z.unknown(),
});

export interface ControlOptions {
  /** A rig is stale after this long without a report (3 missed 60 s polls). */
  staleAfterMs: number;
  /** A rig is offline after this long without a report (THERMITE_CONTROL_OFFLINE_SECONDS). */
  offlineAfterMs?: number | undefined;
  /** Control's own build, which rigs' builds are compared with (tests give their own). */
  build?: BuildInfo | undefined;
  /** Restarts containers (Kubernetes or compose); none configured: restarts are refused. */
  driver?: DeploymentDriver | undefined;
  /** Hold every rig's first report key for the owner's acceptance (no trust on first use). */
  requireKeyAcceptance?: boolean | undefined;
  /** Days a dashboard session lasts without use. */
  sessionDays?: number | undefined;
  /**
   * Seals the API keys of the model routes the owner sets. Without one, a box with a key in memory
   * only: routes then need their keys again after a restart.
   */
  secrets?: SecretBox | undefined;
  /** How control reaches model providers to list their models (tests give their own). */
  providerFetch?: typeof fetch | undefined;
  /** The kits control writes itself, served to rigs (none: no kits are served). */
  kits?: KitRepos | undefined;
  /** How the new-campaign page reads a project's repository (tests give their own). */
  probeRepo?: typeof probeRepository | undefined;
  /** Control's address as rigs and machines reach it (THERMITE_CONTROL_PUBLIC_URL). */
  publicUrl?: string | undefined;
  /** How control reaches machines over SSH (tests give their own). */
  machineSsh?: MachineSsh | undefined;
  /** The images control deploys rigs from on machines. */
  rigImages?: RigImages | undefined;
  /** How control reaches Kubernetes clusters (tests give their own). */
  clusterKubectl?: ClusterKubectl | undefined;
  /** How control reaches GPU clouds' APIs (tests give their own). */
  cloudFetch?: typeof fetch | undefined;
  /** Test pods on GPU clouds; control's loop advances them (main.ts). Made here when not given. */
  runpodTests?: RunpodTests | undefined;
  /** The image a RunPod test pod runs when none is given (THERMITE_RUNPOD_TEST_IMAGE). */
  runpodTestImage?: string | undefined;
  /**
   * Outside knowledge bases (optional); control's loop syncs their copies (main.ts). Made here
   * when not given.
   */
  outsideKb?: OutsideKbs | undefined;
}

export function createControlApi(
  store: ControlStore,
  tokens: ControlTokens,
  privateKeyPem: string,
  opts: ControlOptions = { staleAfterMs: 180_000 },
): Hono {
  const app = new Hono();
  store.setConfiguredRigs(Object.keys(tokens.rigs));
  const control = opts.build ?? buildInfo();
  // A rig refused by an earlier control may work with this one.
  recheckRefusals(store, control);
  const viewOpts = {
    staleAfterMs: opts.staleAfterMs,
    offlineAfterMs: opts.offlineAfterMs,
    control,
  };

  const owner = Credential.from(tokens.admin);
  const secrets = opts.secrets ?? SecretBox.ephemeral();
  // ChatGPT subscriptions' logins: control alone renews them (the dashboard signs them in).
  const chatgpt = new ChatGPTLogins(store, secrets, opts.providerFetch);
  // Filled in by the dashboard, offered by MCP too.
  const actions: ControlActions = {};
  const runpodTests =
    opts.runpodTests ??
    new RunpodTests(store, secrets, { fetch: opts.cloudFetch, image: opts.runpodTestImage });
  const outsideKb = opts.outsideKb ?? new OutsideKbs(store, store.kb(), secrets);
  const opt = (t: string | Credential | undefined) =>
    t === undefined ? undefined : Credential.from(t);
  const creds = {
    owner,
    read: opt(tokens.read),
    agent: opt(tokens.agent),
    operator: opt(tokens.operator),
  };
  // Each credential is distinct: the owner's, an operator's, an agent's and a reader's.
  const given = Object.values(creds).filter((x): x is Credential => x !== undefined);
  if (given.some((x, i) => given.slice(i + 1).some((y) => x.same(y))))
    throw new Error("the admin, operator, agent and read tokens must all be different");
  const admin: MiddlewareHandler = async (c, next) => {
    if (!owner.matches(bearer(c.req.header("authorization"))))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  // A rig's token is in the rig tokens file, or was made by control when the rig was enrolled.
  // A rig control reaches through a proxy has no token: its calls come in-process, from control's
  // own end of the tunnel (src/control/tunnel.ts), which verified them. Only an in-process call
  // can carry that binding; a request from the network never has it.
  const rigAuth: MiddlewareHandler = async (c, next) => {
    const rig = c.req.param("rig") ?? "";
    const via = (c.env as { tunnelRig?: unknown } | undefined)?.tunnelRig;
    if (typeof via === "string") {
      if (via !== rig || !store.tunnelRig(rig)?.enrolled_at || store.rigRetired(rig))
        return c.json({ error: "unauthorized" }, 401);
    } else {
      const token = bearer(c.req.header("authorization"));
      const expected = tokens.rigs[rig];
      const ok = expected !== undefined ? eq(token, expected) : store.rigTokenMatches(rig, token);
      if (!ok) return c.json({ error: "unauthorized" }, 401);
      // A retired rig is refused until the owner brings it back, whatever token it holds.
      if (store.rigRetired(rig)) return c.json({ error: "this rig is retired in control" }, 403);
    }
    // The supervisor's build, from its headers. A supervisor that sends none on the calls every
    // build makes is from before version checks: unknown, and never refused for it.
    const route = c.req.path.slice(`/v1/rigs/${encodeURIComponent(rig)}/`.length);
    const supervisorBuild = buildFromHeaders((h) => c.req.header(h));
    if (supervisorBuild || ["ingest", "supervisor", "commands/pending"].includes(route))
      store.setRigBuild(rig, "supervisor", supervisorBuild);
    // A report brings its harness's build: the ingest route checks that one, once it verifies.
    const refused =
      route === "ingest"
        ? checkRig(store, rig, control, { harness: null, endRefusal: false })
        : checkRig(store, rig, control);
    if (refused) return c.json({ error: refused }, 409);
    await next();
  };

  app.onError((err, c) =>
    c.json(
      { error: err instanceof z.ZodError ? "invalid request" : err.message },
      err instanceof z.ZodError ? 400 : 500,
    ),
  );

  // What fails goes to control's output and its audit log: the dashboard says why only once, in
  // the page it sends back, and whoever debugs control reads it again over MCP (control_log).
  app.use("*", async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    const status = c.res.status;
    if (c.error || status >= 500) {
      const error = redact(c.error?.message ?? `status ${status}`);
      log("control", "request failed", { method: c.req.method, path, status, error });
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
      log("control", "refused", { path, why: reason });
      store.audit("owner:ui", "refused", { path, why: reason });
    }
  });

  app.get("/v1/health", (c) => c.json({ ok: true }));

  app.post("/v1/rigs/:rig/ingest", rigAuth, bodyLimit({ maxSize: 32 * 1024 * 1024 }), async (c) => {
    const body = IngestBody.parse(await c.req.json());
    const rig = c.req.param("rig");
    if (body.rig !== rig) return c.json({ error: "rig mismatch" }, 403);
    // Reports are signed by the harness: the supervisor relays them but cannot forge them.
    if (!body.signature || !body.rig_pubkey) return c.json({ error: "unsigned report" }, 400);
    const key = store.rigKey(rig);
    const offered = body.rig_pubkey.trim();
    // A key is pinned or held only if the report it came with verifies under it.
    if (!verifyJson(reportBody(body), body.signature, offered)) {
      store.audit(`rig:${rig}`, "report_rejected", { reason: "bad signature" });
      return c.json({ error: "bad report signature" }, 403);
    }
    if (!key.pubkey) {
      // First contact: pinned, unless the owner must accept every rig's first key.
      if (opts.requireKeyAcceptance) {
        if (key.pending?.trim() !== offered) store.holdKey(rig, offered);
        return c.json({ error: "the rig's key waits for the owner's acceptance" }, 409);
      }
      store.pinKey(rig, offered);
    } else if (key.pubkey.trim() !== offered) {
      if (key.pending?.trim() !== offered) store.holdKey(rig, offered);
      return c.json({ error: "rig key changed: the owner must accept the new key" }, 409);
    }
    // Freshness and completeness: no report from a ledger this rig has left, no gap in the
    // event stream, and nothing older than the newest report already taken.
    const fresh = store.reportCheck(rig, {
      ledgerId: body.ledger_id,
      cursor: body.cursor,
      generatedAt: body.generated_at,
    });
    if (!fresh.ok) {
      store.audit(`rig:${rig}`, "report_refused", { reason: fresh.reason });
      return c.json({ error: fresh.reason, expected_cursor: fresh.expectedCursor }, 409);
    }
    if (Date.parse(body.generated_at) > Date.now() + 5 * 60_000)
      return c.json({ error: "report from the future" }, 409);
    // The harness's build, from the signed summary of a fresh report (none from a harness before
    // version checks): recorded, and the report refused while its protocol and control's do not
    // meet. A replayed old report never gets this far, so it cannot change the recorded build.
    store.setRigBuild(rig, "harness", readBuild((body.summary as { build?: unknown })?.build));
    const refused = checkRig(store, rig, control);
    if (refused) return c.json({ error: refused }, 409);
    const added = store.ingest(body as IngestReport);
    // Into the knowledge base now, while this report's ledger is the rig's (it reads only a rig's
    // current ledger). After a failure the next report or read catches up.
    try {
      store.kb();
    } catch (err) {
      const error = redact(err instanceof Error ? err.message : String(err));
      log("control", "knowledge base catch-up failed", { rig, error });
      store.audit("control", "kb_failed", { rig, error });
    }
    // A rig control marked failed (its update or start waited too long) that reports again
    // works: say so, and show it as running.
    const placed = store.clusterRig(rig);
    if (placed?.status === "failed") {
      store.setClusterRigStatus(rig, "running");
      // Named for the wait that ended: its first report, one after new images, or after a start.
      const failed = store
        .rigSetupEvents(rig)
        .filter((x) => !x.ok)
        .at(-1)?.step;
      const step =
        failed === "first_report"
          ? "first_report"
          : failed === "pods_running" || failed === "report_after_start"
            ? "report_after_start"
            : "report_after_images";
      store.rigSetupEvent(rig, step, true, "it reported after the wait ended");
    }
    return c.json({ added });
  });

  app.get("/v1/rigs/:rig/commands/pending", rigAuth, (c) =>
    c.json({ commands: store.pendingCommands(c.req.param("rig")) }),
  );

  app.post("/v1/commands/:id/cancel", admin, (c) =>
    store.cancelCommand(c.req.param("id"), "owner:api")
      ? c.json({ cancelled: true })
      : c.json({ error: "no such pending command" }, 404),
  );

  app.post(
    "/v1/rigs/:rig/commands/:id/ack",
    rigAuth,
    bodyLimit({ maxSize: 256 * 1024 }),
    async (c) => {
      const body = AckBody.parse(await c.req.json());
      const ok = store.ackCommand(c.req.param("rig"), c.req.param("id"), body.status, body.outcome);
      return ok ? c.json({ ok }) : c.json({ error: "no such pending command" }, 404);
    },
  );

  // The supervisor's own figures and its daily report (unsigned: the supervisor reports itself).
  app.post("/v1/rigs/:rig/supervisor", rigAuth, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    store.setSupervisor(c.req.param("rig"), SupervisorStats.parse(await c.req.json()));
    return c.json({ ok: true });
  });

  // The live view: the harness's lines, signed with the rig's pinned key (the supervisor relays
  // them but cannot forge them), and the supervisor's own lines, stored as unsigned.
  app.post("/v1/rigs/:rig/live", rigAuth, bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const rig = c.req.param("rig");
    const body = z
      .object({
        batch: LiveBatch,
        supervisor: z
          .object({ log_id: z.string().min(1).max(64), entries: z.array(LiveEntry).max(500) })
          .optional(),
      })
      .parse(await c.req.json());
    const b = body.batch;
    if (b.rig !== rig) return c.json({ error: "rig mismatch" }, 403);
    const pinned = store.rigKey(rig).pubkey;
    if (!pinned) return c.json({ error: "the rig's report key is not accepted yet" }, 409);
    if (!b.signature || !b.rig_pubkey || b.rig_pubkey.trim() !== pinned.trim())
      return c.json({ error: "live lines must be signed with the rig's pinned key" }, 409);
    if (!verifyJson(liveBody(b), b.signature, pinned))
      return c.json({ error: "bad live signature" }, 403);
    let added = store.addLive(rig, b.log_id, b.entries, true);
    if (body.supervisor) {
      const own = body.supervisor.entries.filter((e) => e.source === "supervisor");
      added += store.addLive(rig, `supervisor:${body.supervisor.log_id}`, own, false);
    }
    return c.json({ added });
  });

  // The provider and model this rig's agents use, with the provider's key, for the rig's supervisor
  // alone: it hands them to its harness. The key is opened only here, and nothing caches or logs it.
  // A kit control keeps, as plain-HTTP git for a rig's supervisor to fetch by commit. Only the
  // files such a fetch reads are served; the query git sends first (?service=...) is ignored,
  // which tells git to fetch the plain way.
  app.get("/v1/rigs/:rig/git/kits/:repo/*", rigAuth, (c) => {
    const m = /^(.+)\.git$/.exec(c.req.param("repo"));
    const rel = c.req.path.split(`/git/kits/${c.req.param("repo")}/`)[1] ?? "";
    const body = m && opts.kits ? opts.kits.file(m[1] as string, rel) : undefined;
    if (!body) return c.text("not found", 404);
    return c.body(new Uint8Array(body), 200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    });
  });

  // Git access for a private repository, to a rig whose assigned campaign names it; otherwise
  // refused. The secret leaves control only here, never in a signed command.
  app.get("/v1/rigs/:rig/git-access/:name", rigAuth, (c) => {
    const rig = c.req.param("rig");
    const name = c.req.param("name");
    const g = store.gitAccess(name);
    if (!g || !store.rigUsesGitAccess(rig, name))
      return c.json({ error: "no such Git access for this rig" }, 404);
    let secret: string;
    try {
      secret = secrets.open(g.secret_sealed);
    } catch {
      return c.json(
        { error: "the Git access could not be unsealed (control's secrets key?)" },
        500,
      );
    }
    store.audit(`rig:${rig}`, "git_access_handed", { name });
    c.header("cache-control", "no-store");
    return c.json(
      g.kind === "ssh"
        ? { kind: "ssh", private_key: secret }
        : { kind: "token", token: secret, username: g.username ?? undefined },
    );
  });

  /**
   * A route as a rig receives it: the provider's endpoint and key (or a subscription's token, for
   * Claude Code only; or a ChatGPT login's access token, renewed here), the model and the harness
   * it runs in. Undefined when the key can't be opened or the login renewed.
   */
  const routeOf = async (
    p: ModelProvider,
    model: string,
    harness: Harness,
    effort: Effort | null | undefined,
  ): Promise<Record<string, unknown> | undefined> => {
    // Other providers take a reasoning effort up to high.
    const reasoning = effort ? (effort === "xhigh" || effort === "max" ? "high" : effort) : null;
    if (p.type === "chatgpt") {
      const access = await chatgpt.access(p);
      if (typeof access !== "string") return undefined;
      return {
        name: p.name,
        type: "chatgpt",
        harness: harness === "opencode" ? "opencode" : "pi",
        version: p.version,
        base_url: CHATGPT_API,
        model,
        context_window: p.models.find((m) => m.id === model)?.context_window ?? 0,
        max_tokens: 0,
        reasoning,
        key_hint: p.key_hint,
        // A renewed token is a new revision: the rig takes it on its next round.
        revision: sha256Hex(
          [p.name, "chatgpt", p.version, harness, model, reasoning ?? "", access].join("\n"),
        ).slice(0, 16),
        api_key: access,
      };
    }
    let key = "";
    try {
      // OpenCode's own provider may have no key (its free models need none).
      if (p.key_sealed) key = secrets.open(p.key_sealed);
    } catch {
      return undefined;
    }
    const contextWindow = p.models.find((m) => m.id === model)?.context_window ?? 0;
    const base = providerBase(p.type, p.base_url);
    // A Claude subscription: its token, for Claude Code only, under Claude Code's model name.
    if (p.type === "claude")
      return {
        name: p.name,
        type: "claude",
        harness: "claude-code",
        version: p.version,
        base_url: base,
        model: claudeModelName(model),
        context_window: contextWindow,
        max_tokens: 0,
        reasoning: null,
        effort: effort ?? null,
        key_hint: p.key_hint,
        revision: sha256Hex(
          [p.name, "claude", p.version, model, contextWindow, effort ?? "", p.key_sealed].join(
            "\n",
          ),
        ).slice(0, 16),
        api_key: key,
      };
    // OpenCode's own provider, under the OpenCode harness, runs through OpenCode's built-in one:
    // it needs no key (its free models), so none is sent.
    const native = harness === "opencode" && isOpencodeOwn(p);
    if (native) key = "";
    return {
      name: p.name,
      type: native ? "opencode" : p.type === "opencode" ? "openai" : p.type,
      harness: harness === "claude-code" ? "pi" : harness,
      version: p.version,
      base_url: base,
      model,
      context_window: contextWindow,
      max_tokens: 0,
      reasoning,
      key_hint: p.key_hint,
      // Changes with anything about the route, even a provider deleted and made again.
      revision: sha256Hex(
        [
          p.name,
          p.type,
          native,
          harness,
          p.version,
          base,
          model,
          contextWindow,
          reasoning ?? "",
          p.key_sealed,
        ].join("\n"),
      ).slice(0, 16),
      api_key: key,
    };
  };
  /** A rig's other agent's route (planner or an advisor), when the owner gave it a model. */
  const roleRouteOf = async (rig: string, role: AgentRole) => {
    const a = store.roleModels(rig)[role];
    const p = a ? store.provider(a.provider) : undefined;
    if (!a || !p) return null;
    // A subscription runs in Claude Code; OpenCode's own service only through OpenCode (the
    // planner can; the dashboard gives it no advisor); every other provider through Pi.
    const opencodeOnly = isOpencodeOwn(p) && (p.type === "opencode" || !p.key_sealed);
    const harness = p.type === "claude" ? "claude-code" : opencodeOnly ? "opencode" : "pi";
    return (await routeOf(p, a.model, harness, a.effort)) ?? null;
  };

  app.get("/v1/rigs/:rig/model-route", rigAuth, async (c) => {
    c.header("cache-control", "no-store");
    const rig = c.req.param("rig");
    const r = store.rigModelFor(rig);
    const planner = await roleRouteOf(rig, "planner");
    if (!r) return c.json({ route: null, planner });
    const route = await routeOf(r.provider, r.model, r.harness, r.effort);
    if (!route)
      return c.json(
        {
          error:
            r.provider.type === "chatgpt"
              ? "the ChatGPT login could not be renewed: sign in again on the Providers page"
              : "the provider's key cannot be opened: enter it again",
        },
        409,
      );
    return c.json({ route, planner });
  });

  // The supervisor's advisors, by role, when the owner gave them models (each with its key or
  // a subscription's token). A role with none keeps the supervisor's own configuration. With
  // them, the outside knowledge bases granted to campaigns the rig runs (each with its token and
  // those campaigns): the supervisor gives their search only to those campaigns' advisors.
  app.get("/v1/rigs/:rig/advisor-routes", rigAuth, async (c) => {
    c.header("cache-control", "no-store");
    const rig = c.req.param("rig");
    return c.json({
      teachers: await roleRouteOf(rig, "teachers"),
      combiner: await roleRouteOf(rig, "combiner"),
      auditor: await roleRouteOf(rig, "auditor"),
      panel: await roleRouteOf(rig, "panel"),
      outside_kb: handOutsideKb(rig),
    });
  });
  /**
   * Outside knowledge bases' tokens leave control here: audited when what a rig gets changes,
   * to none too (kbs: []). What a rig got last is read back from the audit after a restart, so a
   * restart of control writes no entry of its own.
   */
  const handed = new Map<string, string>();
  const handedKey = (kbs: { name: string; campaigns: string[] }[]) =>
    kbs.map((g) => `${g.name}:${g.campaigns.join(",")}`).join(";");
  const handedBefore = (rig: string): string => {
    const body = store.lastAudit(`rig:${rig}`, "outside_kb_handed") as
      | { kbs?: { name?: unknown; campaigns?: unknown }[] }
      | undefined;
    return handedKey(
      (Array.isArray(body?.kbs) ? body.kbs : []).map((g) => ({
        name: String(g?.name ?? ""),
        campaigns: Array.isArray(g?.campaigns) ? g.campaigns.map(String) : [],
      })),
    );
  };
  const handOutsideKb = (rig: string) => {
    const grants = outsideKb.forRig(rig);
    const what = handedKey(grants);
    if (!handed.has(rig)) handed.set(rig, handedBefore(rig));
    if (handed.get(rig) !== what) {
      handed.set(rig, what);
      store.audit(`rig:${rig}`, "outside_kb_handed", {
        kbs: grants.map((g) => ({ name: g.name, campaigns: g.campaigns })),
      });
    }
    return grants;
  };

  // Past research for a run's agents (goal 065): the items of the folders the run's campaign may
  // read, after the supervisor's cursor. Only the rig's own runs; never a folder not granted.
  app.get("/v1/rigs/:rig/kb", rigAuth, (c) => {
    c.header("cache-control", "no-store");
    const run = c.req.query("run") ?? "";
    const after = Number(c.req.query("after") ?? "0");
    if (!run) return c.json({ error: "run is required" }, 400);
    if (!Number.isSafeInteger(after) || after < 0)
      return c.json({ error: "after is a whole number from 0" }, 400);
    // Only a run control assigned to this rig, of the campaign control assigned: a rig cannot
    // read another campaign's folders by naming it in its own events.
    const assigned = store.assignedCampaigns(c.req.param("rig")).get(run);
    if (!assigned) return c.json({ error: `control did not assign run ${run} to this rig` }, 404);
    const sync = store.kb().sync(c.req.param("rig"), run, after);
    if (!sync) return c.json({ error: `this rig has no run ${run}` }, 404);
    if (sync.campaign !== assigned)
      return c.json({ error: `run ${run} is not of the campaign control assigned` }, 409);
    return c.json(sync);
  });

  // A champion's patch, uploaded by the rig's supervisor once its export is published. It is
  // kept only if its sha256 is the one the rig's signed champion_published event names.
  app.post(
    "/v1/rigs/:rig/champions/:run/:seq/patch",
    rigAuth,
    bodyLimit({ maxSize: 64 * 1024 * 1024 }),
    async (c) => {
      const seq = Number(c.req.param("seq"));
      if (!Number.isInteger(seq) || seq < 1) return c.json({ error: "bad seq" }, 400);
      const patch = Buffer.from(await c.req.arrayBuffer());
      const r = store.putChampionPatch(c.req.param("rig"), c.req.param("run"), seq, patch);
      if (r === "not_published")
        return c.json({ error: "control has no champion_published event for it yet" }, 409);
      if (r === "mismatch")
        return c.json({ error: "the patch is not the one the rig published" }, 422);
      return c.json({ stored: true }, 201);
    },
  );
  app.get("/v1/rigs/:rig/champions/:run/:seq/patch", admin, (c) => {
    const p = store.championPatch(
      c.req.param("rig"),
      c.req.param("run"),
      Number(c.req.param("seq")),
    );
    if (!p) return c.json({ error: "no patch for that champion" }, 404);
    return c.body(new Uint8Array(p.patch), 200, {
      "content-type": "text/x-diff",
      "x-thermite-base-commit": p.base_commit,
      "x-thermite-sha256": p.sha256,
    });
  });

  app.post("/v1/rigs/:rig/reports", rigAuth, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const body = z
      .object({ kind: z.enum(["daily"]), body: z.string().min(1).max(200_000) })
      .parse(await c.req.json());
    return c.json({ id: store.addReport(c.req.param("rig"), body.kind, body.body) }, 201);
  });

  app.get("/v1/reports", admin, (c) =>
    c.json({
      reports: store.reports(clampLimit(c.req.query("limit"), 20), c.req.query("rig") || undefined),
    }),
  );

  app.get("/v1/leaderboard", admin, (c) =>
    c.json({ campaigns: leaderboard(store, { staleAfterMs: opts.staleAfterMs }) }),
  );

  app.post("/v1/propagate", admin, async (c) => {
    const body = z
      .object({
        from_rig: z.string().min(1),
        run: z.string().min(1),
        to_rig: z.string().min(1),
        to_run: z.string().min(1),
      })
      .parse(await c.req.json());
    const r = propagateChampion(store, privateKeyPem, {
      fromRig: body.from_rig,
      run: body.run,
      toRig: body.to_rig,
      toRun: body.to_run,
      issuedBy: "owner:api",
      staleAfterMs: opts.staleAfterMs,
    });
    return c.json(r, 201);
  });

  // Lifecycle (owner): restart through the deployment driver; the full reset with state wipe.
  app.post("/v1/rigs/:rig/restart", admin, async (c) => {
    if (!opts.driver) return c.json({ error: "no deployment driver is configured" }, 409);
    const body = z
      .object({
        components: z
          .array(z.enum(["harness", "supervisor"]))
          .min(1)
          .default(["harness", "supervisor"]),
      })
      .parse(await c.req.json().catch(() => ({})));
    const rig = c.req.param("rig");
    store.audit("owner:api", "restart", { rig, components: body.components });
    return c.json({ restarted: await opts.driver.restart(rig, body.components) });
  });

  app.post("/v1/rigs/:rig/reset", admin, async (c) => {
    const rig = c.req.param("rig");
    const body = z.object({ confirm: z.string() }).parse(await c.req.json());
    if (body.confirm !== `reset ${rig}`)
      return c.json({ error: `confirm with "reset ${rig}"` }, 400);
    const id = store.createReset(rig, "owner:api");
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

  app.get("/v1/rigs", admin, (c) =>
    c.json({
      control,
      rigs: store.rigs().map((u) => ({
        ...u,
        state: reportingState(u.last_seen, viewOpts),
        version: rigVersions(store, u.id, control),
      })),
      enrolled: store.enrolledRigs(),
    }),
  );

  // Enrollment: control makes a rig's token, shows it once and keeps only its SHA-256, so a new
  // rig needs no change to control's deployment and no restart.
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const RigName = z.strictObject({
    rig: z
      .string()
      .regex(
        RIG_ID,
        "a rig's name is 2 to 40 characters of a-z, 0-9 and -, starting and ending with a letter or digit",
      ),
  });
  const inFile = (rig: string) =>
    tokens.rigs[rig] !== undefined
      ? `rig ${rig} has its token in control's rig tokens file; change it there`
      : undefined;
  app.post("/v1/rigs", admin, async (c) => {
    const { rig } = RigName.parse(await c.req.json());
    const taken =
      inFile(rig) ?? (store.enrolledRig(rig) ? `rig ${rig} is already enrolled` : undefined);
    if (taken) return c.json({ error: taken }, 409);
    const t = newToken();
    store.enrollRig(rig, t.sha256, "owner:api");
    return c.json(
      {
        rig,
        token: t.token,
        control_public_key: publicKeyPem,
        control_fingerprint: fingerprint(publicKeyPem),
      },
      201,
    );
  });
  app.post("/v1/rigs/:rig/token", admin, (c) => {
    const rig = c.req.param("rig");
    const fixed = inFile(rig);
    if (fixed) return c.json({ error: fixed }, 409);
    if (!store.enrolledRig(rig)) return c.json({ error: `rig ${rig} is not enrolled` }, 404);
    const t = newToken();
    store.rotateRigToken(rig, t.sha256, "owner:api");
    return c.json({ rig, token: t.token });
  });
  // Any rig: one control enrolled (its token ends), one in the rig tokens file (its token is
  // refused while retired; take it out of the file too), or one that only ever reported.
  app.post("/v1/rigs/:rig/retire", admin, (c) => {
    const rig = c.req.param("rig");
    if (!store.rigs({ withRetired: true }).some((u) => u.id === rig) && !store.knownRig(rig))
      return c.json({ error: `no rig ${rig}` }, 404);
    store.retireAnyRig(rig, "owner:api");
    return c.json({
      rig,
      retired: true,
      ...(inFile(rig)
        ? { note: "its token is in control's rig tokens file: remove it there too" }
        : {}),
    });
  });
  app.post("/v1/rigs/:rig/bring-back", admin, (c) => {
    const rig = c.req.param("rig");
    return store.bringBackRig(rig, "owner:api")
      ? c.json({ rig, retired: false })
      : c.json({ error: `rig ${rig} is not retired` }, 404);
  });

  // Metrics: the read token is enough (a scraper should not hold the owner's credential).
  const reader: MiddlewareHandler = async (c, next) => {
    const t = bearer(c.req.header("authorization"));
    if (!owner.matches(t) && !creds.read?.matches(t)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  app.get("/metrics", reader, (c) =>
    c.text(metricsText(store, opts.staleAfterMs), 200, {
      "content-type": "text/plain; version=0.0.4",
    }),
  );

  app.get("/v1/rigs/:rig/live", reader, (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const source = c.req.query("source") || undefined;
    const limit = clampLimit(c.req.query("limit"), 500);
    return c.json({
      sources: store.liveSources(c.req.param("rig")),
      entries: after
        ? store.live(c.req.param("rig"), after, limit, source)
        : store.liveTail(c.req.param("rig"), limit, source),
    });
  });

  app.post("/v1/rigs/:rig/key/accept", admin, (c) =>
    store.acceptPendingKey(c.req.param("rig"), "owner:api", c.req.query("fingerprint") ?? "")
      ? c.json({ accepted: true })
      : c.json({ error: "no pending key" }, 404),
  );

  app.get("/v1/rigs/:rig/events", admin, (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const limit = clampLimit(c.req.query("limit"), 500);
    return c.json({ events: store.events(c.req.param("rig"), after, limit) });
  });

  app.post("/v1/commands", admin, async (c) => {
    const body = IssueBody.parse(await c.req.json());
    // A wipe goes only through the full reset (export, verified push, the owner's confirmation).
    if (body.kind === "wipe_state")
      return c.json({ error: "wipe_state is issued only by a full reset" }, 400);
    let id: string;
    try {
      ({ id } = issueCommand(store, privateKeyPem, {
        rig: body.rig,
        kind: body.kind,
        payload: body.payload,
        ttlMinutes: body.ttl_minutes,
        // The admin token is the owner's; who issued a command is control's to say, not the client's.
        issuedBy: "owner:api",
      }));
    } catch (err) {
      // A refused command (a bad payload, a message nothing would read) is the client's to fix,
      // and in the audit log as the dashboard's and MCP's refusals are.
      const error = err instanceof Error ? err.message : String(err);
      store.audit("owner:api", "refused", {
        path: "/v1/commands",
        kind: body.kind,
        why: redact(error),
      });
      return c.json({ error }, error.startsWith("unknown rig") ? 404 : 400);
    }
    return c.json({ id, status: "pending" }, 201);
  });

  app.get("/v1/commands", admin, (c) =>
    c.json({ commands: store.listCommands(clampLimit(c.req.query("limit"), 100)) }),
  );

  app.get("/v1/audit", admin, (c) =>
    c.json({ audit: store.listAudit(clampLimit(c.req.query("limit"), 200)) }),
  );

  app.get("/v1/rigs/:rig/view", admin, (c) => {
    const v = rigView(store, c.req.param("rig"), viewOpts);
    return v ? c.json(v) : c.json({ error: "not found" }, 404);
  });

  // Test pods on a GPU cloud (the owner's token; MCP gives operators the same).
  const TestBody = z.strictObject({
    gpu: z.string().min(1).optional(),
    cloud_type: z.enum(["SECURE", "COMMUNITY"]).optional(),
    image: z.string().min(1).optional(),
    disk_gb: z.number().int().optional(),
    restart: z.boolean().optional(),
    stop_after_minutes: z.number().positive().optional(),
  });
  app.get("/v1/gpu-clouds/:name/tests", admin, (c) =>
    c.json(runpodTests.list(c.req.param("name"))),
  );
  app.post("/v1/gpu-clouds/:name/tests", admin, async (c) => {
    const body: TestRequest = TestBody.parse(await c.req.json());
    try {
      return c.json(await runpodTests.start(c.req.param("name"), body, "owner:api"), 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });
  app.get("/v1/gpu-cloud-tests/:id", admin, (c) => {
    const t = runpodTests.view(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  });
  app.post("/v1/gpu-cloud-tests/:id/end", admin, async (c) => {
    try {
      return c.json(await runpodTests.end(c.req.param("id"), "owner:api"));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.get("/v1/commands/:id", admin, (c) => {
    const cmd = store.command(c.req.param("id"));
    return cmd ? c.json(cmd) : c.json({ error: "not found" }, 404);
  });

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
      publicUrl: opts.publicUrl,
      machineSsh: opts.machineSsh,
      rigImages: opts.rigImages,
      clusterKubectl: opts.clusterKubectl,
      cloudFetch: opts.cloudFetch,
      runpodTests,
      actions,
      outsideKb,
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
    actions,
    outsideKb,
  });

  return app;
}
