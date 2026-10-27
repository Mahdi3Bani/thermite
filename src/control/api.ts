import { createPublicKey } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { log, redact } from "../common/env.ts";
import { answerOf, errorText, jsonBody } from "../common/errors.ts";
import { sameSecret } from "../common/secrets.ts";
import { sha256Hex } from "../core/canonical.ts";
import { COMMAND_KINDS, type CommandKind, reportBody, verifyJson } from "../core/commands.ts";
import { RIG_ID_WORDS } from "../core/ids.ts";
import { POD_CONFIG_ENV } from "../core/tunnel.ts";
import { type BuildInfo, buildFromHeaders, buildInfo, readBuild } from "../core/version.ts";
import type { ControlActions } from "./actions.ts";
import { rigModels, setRigModel } from "./agent-models.ts";
import { runRoutes } from "./api/runs.ts";
import {
  CampaignContextBody,
  campaignContextAnswer,
  setCampaignContext,
} from "./campaign-context.ts";
import {
  archiveCampaign,
  campaignFoldersAnswer,
  createFolder,
  deleteFolder,
  FolderNameBody,
  MoveBody,
  moveCampaign,
  renameFolder,
  type ShelfOutcome,
  unarchiveCampaign,
} from "./campaign-folders.ts";
import { CHATGPT_API } from "./chatgpt.ts";
import { ClusterResourcesBody, clusterResourcesRequest } from "./cluster-resources.ts";
import type { ClusterKubectl } from "./clusters/kubectl.ts";
import { CopyCampaignBody, copyACampaign, copyCampaignAnswer } from "./copy-campaign.ts";
import { Credential, newToken } from "./credential.ts";
import { createDashboard, type RigImages } from "./dashboard.ts";
import { ExportFiles, mountExports } from "./exports.ts";
import { issueWaking, pendingFor, propagateChampion, WakeRefused } from "./issue.ts";
import { addKit, kitAnswer, kitsAnswer } from "./kit-add.ts";
import { KIT_BUNDLE_MAX, type KitRepos } from "./kit-repos.ts";
import { advanceResets, cancelReset, confirmReset, type DeploymentDriver } from "./lifecycle.ts";
import { takeLive } from "./live-in.ts";
import type { MachineSsh } from "./machines/ssh.ts";
import { mountMcp } from "./mcp.ts";
import { mountMcpServerRoutes } from "./mcp-server-routes.ts";
import type { McpServers } from "./mcp-servers.ts";
import { metricsText } from "./metrics.ts";
import { modelSteps } from "./model-steps.ts";
import { controlParts } from "./parts.ts";
import { cappedWindow, claudeModelName, isOpencodeOwn, providerBase } from "./providers.ts";
import { copiedFromRecords, untriedOf } from "./queue-copy.ts";
import type { probeRepository, readKitManifest } from "./repo-probe.ts";
import { resultsLeft } from "./results-left.ts";
import {
  AdvisorsFileSchema,
  neededHarness,
  RigModelBody,
  rigModelAnswer,
  rigModelRequest,
  rigModelsAnswer,
} from "./rig-model.ts";
import {
  RigSettingsBody,
  rigSettingsAnswer,
  rigSettingsRead,
  setRigSettings,
} from "./rig-settings.ts";
import type { RigUpdates } from "./rig-update.ts";
import { runpodResetRefusal } from "./runpod-lifecycle.ts";
import {
  type LaunchRequest,
  type LimitsChange,
  podLogQuery,
  type RunpodRigs,
} from "./runpod-rigs.ts";
import type { RunpodTests, TestRequest } from "./runpod-tests.ts";
import type { SecretBox } from "./secrets.ts";
import {
  bodyRefusal,
  StartRunBody,
  startARun,
  startRunAnswer,
  startRunRequest,
} from "./start-run.ts";
import {
  type AgentRole,
  type ControlStore,
  codexTakes,
  cursorOf,
  type Effort,
  fingerprint,
  type Harness,
  type IngestReport,
  type ModelProvider,
  RIG_ID,
} from "./store.ts";
import type { ControlTunnels } from "./tunnel.ts";
import { modelPrices, modelUsage, setModelPrice, usageQueryRefusal } from "./usage.ts";
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

/** A list size from a query string: a whole number from 1 to 5000, or the default. */
function clampLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) ? Math.min(5000, Math.max(1, n)) : fallback;
}

function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * The harness's signed report, as its supervisor relays it. A field this control does not know is
 * dropped, in the report or in an event, and the signature (over reportBody) is checked on what is
 * left. So the signed part stays exact: a field a newer harness signs there fails the check. New
 * data goes in an event's `body` or the `summary`, which are kept as they came (goal 012).
 */
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
      run: z.string().nullable().optional(),
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

/**
 * What a supervisor may say about itself: numbers and short strings only (it is unsigned). A field
 * this control does not know, at any level, is dropped, never stored or shown: a newer supervisor
 * that reports more still has the rest of its figures taken (goal 012). The fields it knows keep
 * their checks.
 */
const Count = z.number().finite().min(0).max(1e12);
const Bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Short = z.string().max(1000);
const ExportNames = z.array(z.string().regex(/^[0-9A-Za-z-]{1,80}$/)).max(50);
const SupervisorStats = z.object({
  at: Short,
  relay: z.object({ cursor: Count }).optional(),
  export: z
    .object({
      remote: z.boolean(),
      /** Where its exports go: the results repository, control, or nowhere off the rig. */
      to: z.enum(["repository", "control", "none"]).optional(),
      exports: Count,
      pushed: ExportNames,
      pushed_commit: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/)
        .nullable()
        .optional(),
      last_push_at: Short.nullable(),
      /** The newest exports it sent to control in full. */
      uploaded: ExportNames.optional(),
      last_upload_at: Short.nullable().optional(),
      /** Exports on the rig that have not left it yet, and champion patches not yet on control. */
      waiting: Count.optional(),
      champions_waiting: Count.optional(),
      last_error: Short.nullable(),
    })
    .optional(),
  /** Model files it downloads or downloaded for the harness (model-download.ts), newest first. */
  models: z
    .array(
      z.object({
        name: z.string().max(200),
        path: Short,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        from: z.string().max(300),
        state: z.enum(["downloading", "done", "refused", "failed"]),
        bytes: Bytes,
        total: Bytes.nullable(),
        resumed_from: Bytes,
        started_at: Short,
        updated_at: Short,
        error: Short.optional(),
        run: z.string().max(80).optional(),
      }),
    )
    .max(20)
    .optional(),
  advisors: z
    .object({
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
        .object({
          teachers: Count,
          merged_by: z.boolean(),
          auditor: z.boolean(),
          review_panel: Count,
        })
        .optional(),
      /**
       * What the rig's advisors file sets up for each role (goal 074): Edit rig says what an
       * advisor with no model from control uses. A malformed one is dropped, not the report.
       */
      file: AdvisorsFileSchema.optional().catch(undefined),
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
  /** Where control keeps the exports rigs send it (none: it takes none). */
  exportsDir?: string | undefined;
  /** How the new-campaign page reads a project's repository (tests give their own). */
  probeRepo?: typeof probeRepository | undefined;
  /** How the new-campaign page reads a kit's kit.json from its repository (tests give their own). */
  readKit?: typeof readKitManifest | undefined;
  /** Control's address as rigs and machines reach it (THERMITE_CONTROL_PUBLIC_URL). */
  publicUrl?: string | undefined;
  /** How control reaches machines over SSH (tests give their own). */
  machineSsh?: MachineSsh | undefined;
  /** The images control deploys rigs from on machines. */
  rigImages?: RigImages | undefined;
  /** How control reaches Kubernetes clusters (tests give their own). */
  clusterKubectl?: ClusterKubectl | undefined;
  /** How often a draining rig's report is looked at (goal 079; tests make it short). */
  drainWatchMs?: number | undefined;
  /** How control reaches GPU clouds' APIs (tests give their own). */
  cloudFetch?: typeof fetch | undefined;
  /** Test pods on GPU clouds; control's loop advances them (main.ts). Made here when not given. */
  runpodTests?: RunpodTests | undefined;
  /** The image a RunPod test pod runs when none is given (THERMITE_RUNPOD_TEST_IMAGE). */
  runpodTestImage?: string | undefined;
  /**
   * Rigs the owner launches on GPU clouds; control's loop follows them (main.ts). Made here when
   * not given.
   */
  runpodRigs?: RunpodRigs | undefined;
  /** The image a RunPod rig runs when none is given (THERMITE_RUNPOD_RIG_IMAGE). */
  runpodRigImage?: string | undefined;
  /**
   * Rigs in pull mode, which control connects to; control's loop advances them (main.ts). Made
   * here when not given. Their calls are answered by this API, in-process.
   */
  tunnels?: ControlTunnels | undefined;
  /**
   * MCP servers for the agents (goal 068): made here when not given. Tests give one that reaches
   * their fake servers.
   */
  mcpServers?: McpServers | undefined;
  /** Updates of rigs to control's version from their pages (tests give their own, with short waits). */
  rigUpdates?: RigUpdates | undefined;
  /**
   * What the dashboard does that others call too (MCP, control's loop in main.ts): the dashboard
   * fills it in. Made here when not given.
   */
  actions?: ControlActions | undefined;
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
  // Since when control runs this build: a rig's page says since when the two differ.
  store.noteControlBuild(control);
  const viewOpts = {
    staleAfterMs: opts.staleAfterMs,
    offlineAfterMs: opts.offlineAfterMs,
    control,
  };

  const owner = Credential.from(tokens.admin);
  // Filled in by the dashboard, offered by MCP too.
  const actions: ControlActions = opts.actions ?? {};
  // What the dashboard, REST and MCP share, made once (parts.ts).
  const parts = controlParts(store, privateKeyPem, opts, viewOpts);
  const { secrets, chatgpt, runpodTests, mcpServers, tunnels, runpodRigs, runpodDriver } = parts;
  tunnels.serveWith((rig, call) =>
    Promise.resolve(
      app.request(
        call.path,
        {
          method: call.method,
          headers: call.headers,
          ...(call.method === "GET" || call.method === "HEAD"
            ? {}
            : { body: new Uint8Array(call.body) }),
        },
        { tunnelRig: rig },
      ),
    ),
  );
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
      const ok =
        expected !== undefined ? sameSecret(token, expected) : store.rigTokenMatches(rig, token);
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
    if (refused) {
      // Counted, so the rig's page can say that it still calls.
      store.countRefusedCall(rig);
      return c.json({ error: refused }, 409);
    }
    await next();
  };

  // Every refusal and bad input is answered in its own words and status, the same as MCP's.
  app.onError((err, c) => c.json({ error: answerOf(err).error }, answerOf(err).status));

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

  app.post("/v1/rigs/:rig/ingest", rigAuth, bodyLimit({ maxSize: 32 * 1024 * 1024 }), async (c) => {
    const body = IngestBody.parse(await jsonBody(c.req));
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
    if (refused) {
      store.countRefusedCall(rig);
      return c.json({ error: refused }, 409);
    }
    const added = store.ingest(body as IngestReport);
    // Into the knowledge base now, while this report's ledger is the rig's (it reads only a rig's
    // current ledger). After a failure the next report or read catches up.
    try {
      store.kb();
    } catch (err) {
      const error = redact(errorText(err));
      log("control", "knowledge base catch-up failed", { rig, error }, "error");
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
            : failed === "resources" ||
                failed === "resources_running" ||
                failed === "report_after_resources"
              ? "report_after_resources"
              : "report_after_images";
      store.rigSetupEvent(rig, step, true, "it reported after the wait ended");
    }
    return c.json({ added });
  });

  app.get("/v1/rigs/:rig/commands/pending", rigAuth, (c) =>
    c.json(pendingFor(store, privateKeyPem, c.req.param("rig"), c.req.query())),
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
      const body = AckBody.parse(await jsonBody(c.req));
      const ok = store.ackCommand(c.req.param("rig"), c.req.param("id"), body.status, body.outcome);
      return ok ? c.json({ ok }) : c.json({ error: "no such pending command" }, 404);
    },
  );

  // The supervisor's own figures and its daily report (unsigned: the supervisor reports itself).
  // A model download that starts or ends is a step in the rig's history.
  app.post("/v1/rigs/:rig/supervisor", rigAuth, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const rig = c.req.param("rig");
    const stats = SupervisorStats.parse(await jsonBody(c.req));
    const before = store.supervisor(rig)?.models;
    store.setSupervisor(rig, stats);
    for (const s of modelSteps(before, stats.models))
      store.rigSetupEvent(rig, s.step, s.ok, s.detail);
    return c.json({ ok: true });
  });

  // The live view: the harness's signed lines, and the supervisor's own (live-in.ts).
  app.post("/v1/rigs/:rig/live", rigAuth, bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const [status, answer] = takeLive(store, c.req.param("rig"), await jsonBody(c.req));
    return c.json(answer, status);
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
   * it runs in. Undefined when the key can't be opened or the login renewed. `cap`: the owner's
   * cap on the model's context window (goal 070), which the route carries when it is the lower.
   */
  const routeOf = async (
    p: ModelProvider,
    model: string,
    harness: Harness,
    effort: Effort | null | undefined,
    cap?: number | undefined,
    compactAt?: number | undefined,
  ): Promise<Record<string, unknown> | undefined> => {
    // The compaction point (goal 070), only when the owner set one: a route without it keeps its
    // revision, and the harness applies its default.
    const compact = compactAt ? { compact_at: compactAt } : {};
    const compactRev = compactAt ? [`compact_at ${compactAt}`] : [];
    // Other providers take a reasoning effort up to high.
    const reasoning = effort ? (effort === "xhigh" || effort === "max" ? "high" : effort) : null;
    const contextWindow = cappedWindow(
      p.models.find((m) => m.id === model)?.context_window ?? 0,
      cap,
    );
    // The reply limit: the model's maximum output from the provider's list; 0, none sent and the
    // provider's own applies (goal 079).
    const maxOutput = p.models.find((m) => m.id === model)?.max_output ?? 0;
    const outputRev = maxOutput ? [`max_output ${maxOutput}`] : [];
    if (p.type === "chatgpt") {
      const access = await chatgpt.access(p);
      if (typeof access !== "string") return undefined;
      return {
        name: p.name,
        type: "chatgpt",
        harness: harness === "opencode" || harness === "codex" ? harness : "pi",
        version: p.version,
        base_url: CHATGPT_API,
        model,
        context_window: contextWindow,
        ...compact,
        max_tokens: maxOutput,
        reasoning,
        key_hint: p.key_hint,
        // A renewed token is a new revision: the rig takes it on its next round. So is a cap.
        revision: sha256Hex(
          [
            p.name,
            "chatgpt",
            p.version,
            harness,
            model,
            reasoning ?? "",
            access,
            ...(cap ? [contextWindow] : []),
            ...compactRev,
            ...outputRev,
          ].join("\n"),
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
        ...compact,
        max_tokens: maxOutput,
        reasoning: null,
        effort: effort ?? null,
        key_hint: p.key_hint,
        revision: sha256Hex(
          [
            p.name,
            "claude",
            p.version,
            model,
            contextWindow,
            effort ?? "",
            p.key_sealed,
            ...compactRev,
            ...outputRev,
          ].join("\n"),
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
      // Codex speaks only OpenAI's Responses API: an OpenAI-compatible key's provider.
      harness:
        harness === "claude-code" || (harness === "codex" && !codexTakes(p.type)) ? "pi" : harness,
      version: p.version,
      base_url: base,
      model,
      context_window: contextWindow,
      ...compact,
      max_tokens: maxOutput,
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
          ...compactRev,
          ...outputRev,
        ].join("\n"),
      ).slice(0, 16),
      api_key: key,
    };
  };
  /**
   * A rig's other agent's route (planner or an advisor), when the owner gave it a model, with the
   * agent's own cap on its window and its compaction point (goal 070), as the workers' route has.
   */
  const roleRouteOf = async (rig: string, role: AgentRole) => {
    const a = store.roleModels(rig)[role];
    const p = a ? store.provider(a.provider) : undefined;
    if (!a || !p) return null;
    // The harness the owner chose for the agent (goal 073), else what its model needs: Claude
    // Code for a subscription, OpenCode for OpenCode's own models, else Pi.
    const harness = a.harness ?? neededHarness(p, a.model);
    return (await routeOf(p, a.model, harness, a.effort, a.contextCap, a.compactAt)) ?? null;
  };

  app.get("/v1/rigs/:rig/model-route", rigAuth, async (c) => {
    c.header("cache-control", "no-store");
    const rig = c.req.param("rig");
    const r = store.rigModelFor(rig);
    const planner = await roleRouteOf(rig, "planner");
    if (!r) return c.json({ route: null, planner });
    const route = await routeOf(
      r.provider,
      r.model,
      r.harness,
      r.effort,
      r.contextCap,
      r.compactAt,
    );
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

  // The advisors' routes, by role, when the owner gave them models (each with its key or a
  // subscription's token). A role with none keeps the rig's advisors file: the supervisor's own
  // configuration. Goal 074: the teachers' one or two models (a second only with a first), their
  // merged by model, the auditor and the review panel.
  app.get("/v1/rigs/:rig/advisor-routes", rigAuth, async (c) => {
    c.header("cache-control", "no-store");
    const rig = c.req.param("rig");
    const first = await roleRouteOf(rig, "teachers");
    const second = first ? await roleRouteOf(rig, "second_teacher") : null;
    const mergedBy = await roleRouteOf(rig, "merged_by");
    const reviewPanel = await roleRouteOf(rig, "review_panel");
    return c.json({
      teacher_models: first ? [first, ...(second ? [second] : [])] : [],
      merged_by: mergedBy,
      auditor: await roleRouteOf(rig, "auditor"),
      review_panel: reviewPanel,
    });
  });

  // MCP servers (goal 068): the owner's routes, the OAuth callback, and what a rig gets.
  mountMcpServerRoutes(app, {
    store,
    servers: mcpServers,
    admin,
    rigAuth,
    publicUrl: opts.publicUrl,
  });

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

  // Exports a rig without a results repository sends to control, and the owner reads back.
  const exportFiles = opts.exportsDir ? new ExportFiles(opts.exportsDir) : undefined;
  mountExports(app, {
    store,
    files: exportFiles,
    rigAuth,
    admin,
  });
  // Have all of a rig's results left it? (What a terminate waits for: goal 023.)
  app.get("/v1/rigs/:rig/results-left", admin, (c) =>
    c.json(resultsLeft(store, c.req.param("rig"), { export: c.req.query("export") || undefined })),
  );

  app.post("/v1/rigs/:rig/reports", rigAuth, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const body = z
      .object({ kind: z.enum(["daily"]), body: z.string().min(1).max(200_000) })
      .parse(await jsonBody(c.req));
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
      .parse(await jsonBody(c.req));
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

  // Lifecycle (owner): restart through the deployment driver (RunPod's for a rig on RunPod); the
  // full reset with state wipe.
  app.post("/v1/rigs/:rig/restart", admin, async (c) => {
    const rig = c.req.param("rig");
    const onRunpod = runpodDriver.serves(rig);
    const driver = onRunpod ? runpodDriver : opts.driver;
    if (!driver) return c.json({ error: "no deployment driver is configured" }, 409);
    const body = z
      .object({
        components: z
          .array(z.enum(["harness", "supervisor"]))
          .min(1)
          .default(["harness", "supervisor"]),
      })
      .parse(await c.req.json().catch(() => ({})));
    store.audit("owner:api", "restart", { rig, components: body.components });
    if (!onRunpod) return c.json({ restarted: await driver.restart(rig, body.components) });
    try {
      return c.json({ restarted: await driver.restart(rig, body.components, "owner:api") });
    } catch (err) {
      return c.json({ error: errorText(err) }, 409);
    }
  });

  app.post("/v1/rigs/:rig/reset", admin, async (c) => {
    const rig = c.req.param("rig");
    const body = z.object({ confirm: z.string() }).parse(await jsonBody(c.req));
    if (body.confirm !== `reset ${rig}`)
      return c.json({ error: `confirm with "reset ${rig}"` }, 400);
    // A rig on RunPod: its pod must run, with no stop, start or terminate under way.
    const refused = runpodResetRefusal(store, rig);
    if (refused) return c.json({ error: refused }, 409);
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
      pull: store.tunnelRigs(),
      runpod: runpodRigs.list(),
    }),
  );

  // Enrollment: control makes a rig's token, shows it once and keeps only its SHA-256, so a new
  // rig needs no change to control's deployment and no restart.
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const RigName = z.strictObject({ rig: z.string().regex(RIG_ID, RIG_ID_WORDS) });
  const inFile = (rig: string) =>
    tokens.rigs[rig] !== undefined
      ? `rig ${rig} has its token in control's rig tokens file; change it there`
      : undefined;
  app.post("/v1/rigs", admin, async (c) => {
    const { rig } = RigName.parse(await jsonBody(c.req));
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

  // The agents' model usage (goal 075): a run's, a campaign's or the whole system's, for a period.
  app.get("/v1/usage", reader, (c) => {
    const q = Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== ""));
    const refused = usageQueryRefusal(q);
    if (refused) return c.json({ error: refused }, 400);
    return c.json(modelUsage(store, q));
  });

  // The models' prices that model usage costs calls at (goal 075): the providers' listed ones and
  // the owner's. The owner sets or clears a price for a model whose list gives none.
  app.get("/v1/model-prices", reader, (c) => c.json({ prices: modelPrices(store) }));
  app.post("/v1/model-prices", admin, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const out = setModelPrice(store, await jsonBody(c.req), "owner:api");
    return out.ok ? c.json(out.answer) : c.json({ error: out.error }, out.status);
  });

  // The kits control keeps, and a kit written elsewhere given as a git bundle of its repository:
  // kept with its commits, served to rigs as the kits the New campaign page writes are. The body
  // is the bundle's bytes; ?ref= names the head, ?force=true replaces a head it does not descend
  // from. The owner's token adds; the reader's reads too (MCP's kit_add takes an operator's).
  app.get("/v1/kits", reader, (c) =>
    opts.kits
      ? c.json(kitsAnswer(opts.kits))
      : c.json({ error: "this control keeps no kits" }, 404),
  );
  app.get("/v1/kits/:name", reader, (c) => {
    if (!opts.kits) return c.json({ error: "this control keeps no kits" }, 404);
    const out = kitAnswer(opts.kits, c.req.param("name"));
    return out.ok ? c.json(out.answer) : c.json({ error: out.error }, out.status);
  });
  app.post(
    "/v1/kits/:name",
    admin,
    bodyLimit({
      maxSize: KIT_BUNDLE_MAX,
      onError: (c) => {
        const error = `the bundle is above the ${KIT_BUNDLE_MAX} bytes (64 MiB) control takes`;
        store.audit("owner:api", "refused", { path: c.req.path, why: error });
        return c.json({ error }, 413);
      },
    }),
    async (c) => {
      const name = c.req.param("name");
      const path = `/v1/kits/${name}`;
      const refuse = (error: string, status: 400 | 404 | 409 | 413) => {
        store.audit("owner:api", "refused", { path, why: redact(error) });
        return c.json({ error }, status);
      };
      if (!opts.kits) return refuse("this control keeps no kits", 404);
      const force = c.req.query("force");
      if (force !== undefined && !["", "true", "false", "1", "0"].includes(force))
        return refuse("force is true or false", 400);
      const out = await addKit(
        store,
        opts.kits,
        {
          name,
          bundle: Buffer.from(await c.req.arrayBuffer()),
          ref: c.req.query("ref") || undefined,
          force: force === "true" || force === "1",
        },
        "owner:api",
      );
      if (!out.ok) return refuse(out.error, out.status);
      return c.json(out.answer, out.created ? 201 : 200);
    },
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
    const body = IssueBody.parse(await jsonBody(c.req));
    // A wipe goes only through the full reset (export, verified push, the owner's confirmation).
    if (body.kind === "wipe_state")
      return c.json({ error: "wipe_state is issued only by a full reset" }, 400);
    let issued: { id: string; woke: string | null };
    try {
      // A run assigned or resumed on a stopped RunPod pod starts the pod first.
      issued = await issueWaking(store, privateKeyPem, runpodRigs, {
        rig: body.rig,
        kind: body.kind,
        payload: body.payload,
        ttlMinutes: body.ttl_minutes,
        // The admin token is the owner's; who issued a command is control's to say, not the client's.
        issuedBy: "owner:api",
        owner: true,
      });
    } catch (err) {
      // A refused command (a bad payload, a message nothing would read) is the client's to fix,
      // and in the audit log as the dashboard's and MCP's refusals are.
      const error = errorText(err);
      store.audit("owner:api", "refused", {
        path: "/v1/commands",
        kind: body.kind,
        why: redact(error),
      });
      return c.json(
        { error },
        err instanceof WakeRefused ? 409 : error.startsWith("unknown rig") ? 404 : 400,
      );
    }
    // `woke` only when control started the rig's stopped pod first: other answers stay as they were.
    return c.json(
      { id: issued.id, status: "pending", ...(issued.woke ? { woke: issued.woke } : {}) },
      201,
    );
  });

  app.get("/v1/commands", admin, (c) =>
    c.json({ commands: store.listCommands(clampLimit(c.req.query("limit"), 100)) }),
  );

  // Start a run of a campaign control keeps (goal 029): the twin of a campaign page's Start a
  // run (start-run.ts), with its refusals in words. The owner's token, as on the dashboard; MCP's
  // start_run takes an operator's too.
  app.post("/v1/campaigns/:campaign/runs", admin, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const campaign = c.req.param("campaign");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = StartRunBody.safeParse(raw);
    const out = body.success
      ? await startARun(parts, startRunRequest(campaign, body.data), "owner:api", true)
      : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
    if (out.state === "refused") {
      // In the audit log, as the dashboard's and MCP's refusals are.
      store.audit("owner:api", "refused", {
        path: `/v1/campaigns/${campaign}/runs`,
        why: redact(out.error),
      });
      return c.json({ error: out.error }, out.status);
    }
    return c.json(startRunAnswer(out), out.state === "started" ? 201 : 202);
  });

  // Copy a campaign control keeps (goal 069): a new campaign with the same contract and kit
  // under another name, with its own empty folder in the knowledge base and no runs. Its own
  // brief may come with it (goal 078): room for as much as one command carries to a rig.
  app.post(
    "/v1/campaigns/:campaign/copy",
    admin,
    bodyLimit({ maxSize: 4 * 1024 * 1024 }),
    async (c) => {
      const from = c.req.param("campaign");
      const raw: unknown = await c.req.json().catch(() => undefined);
      const body = CopyCampaignBody.safeParse(raw);
      const out = body.success
        ? copyACampaign(parts, { from, ...body.data }, "owner:api")
        : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
      if (out.state === "refused") {
        store.audit("owner:api", "refused", {
          path: `/v1/campaigns/${from}/copy`,
          why: redact(out.error),
        });
        return c.json({ error: out.error }, out.status);
      }
      return c.json(copyCampaignAnswer(out), 201);
    },
  );

  // A campaign's own context window and compaction point for all its runs' agents (goal 070):
  // the twin of MCP's set_campaign_context. A new version of its contract; an empty body removes
  // them. 201 with a new version, 200 when the newest version has them already.
  app.post(
    "/v1/campaigns/:campaign/context",
    admin,
    bodyLimit({ maxSize: 16 * 1024 }),
    async (c) => {
      const campaign = c.req.param("campaign");
      const raw: unknown = await c.req.json().catch(() => undefined);
      const body = CampaignContextBody.safeParse(raw);
      const out = body.success
        ? setCampaignContext(
            store,
            {
              campaign,
              contextWindow: body.data.context_window,
              compactAt: body.data.compact_at,
            },
            "owner:api",
          )
        : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
      if (out.state === "refused") {
        store.audit("owner:api", "refused", {
          path: `/v1/campaigns/${campaign}/context`,
          why: redact(out.error),
        });
        return c.json({ error: out.error }, out.status);
      }
      return c.json(campaignContextAnswer(out), out.state === "saved" ? 201 : 200);
    },
  );

  // Archive a campaign, and the left navigation's folders (goal 077): the same functions as the
  // dashboard and MCP, with their refusals in words. The owner's token.
  const allViews = () =>
    store
      .rigs()
      .map((u) => rigView(store, u.id, viewOpts))
      .filter((v): v is NonNullable<typeof v> => v !== undefined);
  /** A shelf outcome as the answer, a refusal in the audit log as the other routes' are. */
  const shelf = <T>(c: Context, path: string, out: ShelfOutcome<T>, created = false) => {
    if (out.ok) return c.json(out.answer, created ? 201 : 200);
    store.audit("owner:api", "refused", { path, why: redact(out.error) });
    return c.json({ error: out.error }, out.status);
  };
  const refusedBody = (e: z.ZodError) =>
    ({ ok: false, error: bodyRefusal(e), status: 400 }) as const;
  const bodyOf = async <T>(c: Context, schema: z.ZodType<T>) => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    return schema.safeParse(raw);
  };
  app.post("/v1/campaigns/:campaign/archive", admin, (c) => {
    const campaign = c.req.param("campaign");
    return shelf(
      c,
      `/v1/campaigns/${campaign}/archive`,
      archiveCampaign(store, allViews(), campaign, "owner:api"),
    );
  });
  app.post("/v1/campaigns/:campaign/unarchive", admin, (c) => {
    const campaign = c.req.param("campaign");
    return shelf(
      c,
      `/v1/campaigns/${campaign}/unarchive`,
      unarchiveCampaign(store, allViews(), campaign, "owner:api"),
    );
  });
  app.post("/v1/campaigns/:campaign/folder", admin, bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const campaign = c.req.param("campaign");
    const path = `/v1/campaigns/${campaign}/folder`;
    const body = await bodyOf(c, MoveBody);
    if (!body.success) return shelf(c, path, refusedBody(body.error));
    return shelf(c, path, moveCampaign(store, allViews(), campaign, body.data.folder, "owner:api"));
  });
  app.get("/v1/campaign-folders", admin, (c) => c.json(campaignFoldersAnswer(store)));
  app.post("/v1/campaign-folders", admin, bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const body = await bodyOf(c, FolderNameBody);
    if (!body.success) return shelf(c, "/v1/campaign-folders", refusedBody(body.error));
    return shelf(c, "/v1/campaign-folders", createFolder(store, body.data.name, "owner:api"), true);
  });
  app.post(
    "/v1/campaign-folders/:folder/rename",
    admin,
    bodyLimit({ maxSize: 4 * 1024 }),
    async (c) => {
      const folder = c.req.param("folder");
      const path = `/v1/campaign-folders/${folder}/rename`;
      const body = await bodyOf(c, FolderNameBody);
      if (!body.success) return shelf(c, path, refusedBody(body.error));
      return shelf(c, path, renameFolder(store, folder, body.data.name, "owner:api"));
    },
  );
  app.post("/v1/campaign-folders/:folder/delete", admin, (c) => {
    const folder = c.req.param("folder");
    return shelf(
      c,
      `/v1/campaign-folders/${folder}/delete`,
      deleteFolder(store, folder, "owner:api"),
    );
  });

  // Give one of a rig's agents a model, or clear it (goals 029 and 070): the twin of MCP's
  // set_rig_model, through Edit rig's own code (agent-models.ts), with its refusals in words.
  // Each call sets the agent's context window cap and compaction point anew: none given, none kept.
  app.post("/v1/rigs/:rig/model", admin, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const rig = c.req.param("rig");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const refuse = (error: string) => {
      store.audit("owner:api", "refused", { path: `/v1/rigs/${rig}/model`, why: redact(error) });
      return c.json({ error }, error === `no rig ${rig}` ? 404 : 400);
    };
    const body = RigModelBody.safeParse(raw);
    if (!body.success) return refuse(bodyRefusal(body.error));
    const req = rigModelRequest(body.data);
    const out = await setRigModel(store, rig, req, "owner:api");
    if ("error" in out) return refuse(out.error);
    return c.json(rigModelAnswer(rig, req, out));
  });

  // Each of a rig's agents' models on control: the twin of MCP's rig_models.
  app.get("/v1/rigs/:rig/model", admin, (c) => {
    const rig = c.req.param("rig");
    const agents = rigModels(store, rig);
    if ("error" in agents) return c.json({ error: agents.error }, 404);
    return c.json(rigModelsAnswer(store, rig, agents));
  });

  // A rig's own settings (goal 029): the twin of Save changes on Edit rig and of MCP's
  // set_rig_settings. Only what differs from what the rig reports is sent, as one signed
  // rig_settings command; nothing differing sends nothing. Refused in Edit rig's words.
  app.post("/v1/rigs/:rig/settings", admin, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const rig = c.req.param("rig");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = RigSettingsBody.safeParse(raw);
    const out = body.success
      ? setRigSettings(store, privateKeyPem, rig, body.data, "owner:api", true)
      : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
    if (out.state === "refused") {
      store.audit("owner:api", "refused", {
        path: `/v1/rigs/${rig}/settings`,
        why: redact(out.error),
      });
      return c.json({ error: out.error }, out.status);
    }
    return c.json(rigSettingsAnswer(rig, out));
  });

  // A cluster rig's GPUs, CPUs and memory (goal 118): the twin of Edit rig's fields for a rig
  // control set up on a cluster and of MCP's set_cluster_rig_resources, with their refusals in
  // words. Its pods restart with the new size, draining first while it works.
  app.post(
    "/v1/rigs/:rig/cluster/resources",
    admin,
    bodyLimit({ maxSize: 16 * 1024 }),
    async (c) => {
      const resize = actions.setClusterRigResources;
      if (!resize) return c.json({ error: "this control sets no rigs up on clusters" }, 404);
      const rig = c.req.param("rig");
      const raw: unknown = await c.req.json().catch(() => undefined);
      const body = ClusterResourcesBody.safeParse(raw);
      const out = body.success
        ? await resize(rig, clusterResourcesRequest(body.data), "owner:api", {
            wait: body.data.wait,
            owner: true,
          })
        : ({ error: bodyRefusal(body.error), status: 400 } as const);
      if ("error" in out) {
        store.audit("owner:api", "refused", {
          path: `/v1/rigs/${rig}/cluster/resources`,
          why: redact(out.error),
        });
        return c.json({ error: out.error }, out.status);
      }
      return c.json({ rig, said: out.ok });
    },
  );

  // The settings a rig reports, and its GPU split: the twin of MCP's rig_settings.
  app.get("/v1/rigs/:rig/settings", admin, (c) => {
    const rig = c.req.param("rig");
    const read = rigSettingsRead(store, rig);
    return read ? c.json(read) : c.json({ error: `no rig ${rig}` }, 404);
  });

  // A page of the audit log, newest first; older and newer are the cursors for the next pages.
  app.get("/v1/audit", admin, (c) => {
    const raw = { before: c.req.query("before"), after: c.req.query("after") };
    const before = cursorOf(raw.before);
    const after = cursorOf(raw.after);
    // A cursor that is not a number (a script's "null") is refused: the newest page again would loop.
    if (
      (raw.before !== undefined && before === undefined) ||
      (raw.after !== undefined && after === undefined)
    )
      return c.json({ error: "before and after are whole numbers" }, 400);
    if (before !== undefined && after !== undefined)
      return c.json({ error: "give before or after, not both" }, 400);
    const p = store.auditPage(clampLimit(c.req.query("limit"), 200), {}, { before, after });
    return c.json({ audit: p.entries, older: p.older, newer: p.newer });
  });

  app.get("/v1/rigs/:rig/view", admin, (c) => {
    const v = rigView(store, c.req.param("rig"), viewOpts);
    return v ? c.json(v) : c.json({ error: "not found" }, 404);
  });

  // One run: the run itself, of a size an agent can read, its untried experiments and its
  // directions (src/control/api/runs.ts).
  runRoutes(app, admin, {
    find: (rig, run) => {
      const v = rigView(store, rig, viewOpts);
      const r = v?.runs.find((x) => x.id === run);
      return r ? { run: r } : { error: v ? `no run ${run} on ${rig}` : `no rig ${rig}` };
    },
    untried: (r, campaign) => copiedFromRecords(store, campaign, untriedOf(r).slice(0, 500)),
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
    const body: TestRequest = TestBody.parse(await jsonBody(c.req));
    try {
      return c.json(await runpodTests.start(c.req.param("name"), body, "owner:api"), 201);
    } catch (err) {
      return c.json({ error: errorText(err) }, 409);
    }
  });
  // Rigs on a GPU cloud: launched by the owner alone (this token; MCP's owner tools; never an
  // operator's or an agent's), billed by the hour. Limits apply only when the owner sets them.
  const LaunchBody = z.strictObject({
    gpu: z.string().min(1),
    gpu_count: z.number().int().optional(),
    cloud_type: z.enum(["SECURE", "COMMUNITY"]).optional(),
    datacenter: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
    container_disk_gb: z.number().int().optional(),
    volume_gb: z.number().int().optional(),
    rig: z.string().min(1).optional(),
    enroll_within_minutes: z.number().positive().optional(),
    settings: z.partialRecord(z.enum(POD_CONFIG_ENV), z.string()).optional(),
    spend_limit_usd: z.number().positive().optional(),
    idle_stop_minutes: z.number().nullable().optional(),
  });
  const LimitsBody = z.strictObject({
    spend_limit_usd: z.number().positive().nullable().optional(),
    idle_stop_minutes: z.number().nullable().optional(),
  });
  app.get("/v1/gpu-clouds/:name/rigs", admin, (c) => c.json(runpodRigs.list(c.req.param("name"))));
  app.post("/v1/gpu-clouds/:name/rigs", admin, async (c) => {
    const body: LaunchRequest = LaunchBody.parse(await jsonBody(c.req));
    try {
      return c.json(await runpodRigs.launch(c.req.param("name"), body, "owner:api"), 201);
    } catch (err) {
      return c.json({ error: errorText(err) }, 409);
    }
  });
  app.get("/v1/rigs/:rig/runpod", admin, (c) => {
    const rig = c.req.param("rig");
    const v = runpodRigs.view(rig);
    return v
      ? c.json({ ...v, history: runpodRigs.history(rig) })
      : c.json({ error: "not found" }, 404);
  });
  // A rig's pod log, read from RunPod with the cloud's key: the owner's, as the rig's other reads
  // here. It spends nothing; each line is redacted before it leaves control.
  app.get("/v1/rigs/:rig/runpod/logs", admin, async (c) => {
    const rig = c.req.param("rig");
    if (!runpodRigs.view(rig)) return c.json({ error: "not found" }, 404);
    const q = podLogQuery(c.req.query("tail"), c.req.query("source"));
    if ("error" in q) return c.json({ error: q.error }, 400);
    try {
      return c.json(await runpodRigs.logs(rig, q));
    } catch (err) {
      return c.json({ error: errorText(err) }, 502);
    }
  });
  // Stop, start and terminate a rig's pod (the owner's alone, as the launch). Restart and the full
  // reset are the routes every rig has: /v1/rigs/<rig>/restart and /v1/rigs/<rig>/reset.
  const lifecycleRefused = (err: unknown) => {
    const error = errorText(err);
    return { error, status: /^no rig /.test(error) ? (404 as const) : (409 as const) };
  };
  app.post("/v1/rigs/:rig/runpod/stop", admin, async (c) => {
    try {
      return c.json(await runpodDriver.stop(c.req.param("rig"), "owner:api"));
    } catch (err) {
      const r = lifecycleRefused(err);
      return c.json({ error: r.error }, r.status);
    }
  });
  app.post("/v1/rigs/:rig/runpod/start", admin, async (c) => {
    try {
      return c.json(await runpodDriver.start(c.req.param("rig"), "owner:api"));
    } catch (err) {
      const r = lifecycleRefused(err);
      return c.json({ error: r.error }, r.status);
    }
  });
  app.post("/v1/rigs/:rig/runpod/terminate", admin, async (c) => {
    const body = z.strictObject({ confirm: z.string() }).parse(await jsonBody(c.req));
    const rig = c.req.param("rig");
    if (body.confirm !== `terminate ${rig}`)
      return c.json({ error: `confirm with "terminate ${rig}"` }, 400);
    try {
      return c.json(await runpodDriver.terminate(rig, "owner:api", body.confirm));
    } catch (err) {
      const r = lifecycleRefused(err);
      return c.json({ error: r.error }, r.status);
    }
  });
  app.post("/v1/rigs/:rig/runpod/limits", admin, async (c) => {
    const body: LimitsChange = LimitsBody.parse(await jsonBody(c.req));
    try {
      return c.json(runpodRigs.limits(c.req.param("rig"), body, "owner:api"));
    } catch (err) {
      const error = errorText(err);
      return c.json({ error }, /^no rig /.test(error) ? 404 : 400);
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
      return c.json({ error: errorText(err) }, 404);
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
      readKit: opts.readKit,
      publicUrl: opts.publicUrl,
      machineSsh: opts.machineSsh,
      rigImages: opts.rigImages,
      clusterKubectl: opts.clusterKubectl,
      drainWatchMs: opts.drainWatchMs,
      cloudFetch: opts.cloudFetch,
      runpodTests,
      actions,
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
    actions,
    parts,
    mcpServers,
    publicUrl: opts.publicUrl,
    kits: opts.kits,
  });

  return app;
}
