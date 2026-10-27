import { createHash, createHmac, createPublicKey, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { errorText } from "../common/errors.ts";
import { sameSecret } from "../common/secrets.ts";
import { KEY_PROVIDER_TYPES } from "../core/agents.ts";
import { type BriefingSeed, COMMAND_KINDS, type CommandKind } from "../core/commands.ts";
import {
  type AgentsContext,
  COMPACT_AT_DEFAULT,
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  compactAtRefusal,
  compactAtWords,
} from "../core/compaction.ts";
import { FolderSchema, MAX_LANES, parseContract } from "../core/contract.ts";
import { judgeGpusByDefault } from "../core/hardware.ts";
import { RIG_ID_SENTENCE } from "../core/ids.ts";
import { type McpUse, McpUses, sameUses } from "../core/mcp.ts";
import { queueTarget, queueTargetNote } from "../core/queue-target.ts";
import { RESEARCH_REVIEW } from "../core/research-check.ts";
import { isFree, knownTimeZone, sumUsage, type UsagePeriod } from "../core/usage.ts";
import { type BuildInfo, buildInfo } from "../core/version.ts";
import { type GoalChecks, goalChecks } from "../harness/goal-checks.ts";
import { KitSchema } from "../harness/kit.ts";
import type { ClusterRigRequest, ControlActions } from "./actions.ts";
import { inBackground } from "./background.ts";
import {
  campaignContract,
  contextApplies,
  contextAppliesWords,
  contractContext,
  ownModels,
  rigContext,
  setCampaignContext,
} from "./campaign-context.ts";
import {
  archiveCampaign,
  createFolder,
  deleteFolder,
  moveCampaign,
  renameFolder,
  type ShelfOutcome,
  unarchiveCampaign,
} from "./campaign-folders.ts";
import { CHATGPT_API, CHATGPT_REDIRECT, ChatGPTLogins } from "./chatgpt.ts";
import {
  asksNothing,
  type ClusterResourcesRequest,
  judgeShareOf,
  planClusterResize,
  quotaRefusal,
  type ResizeRefusal,
  resourcesWords,
  sizeChangeWords,
  sizeOf,
  sizeWords,
} from "./cluster-resources.ts";
import { type ClusterRigAction, clusterActionCalls } from "./clusters/actions.ts";
import { deploymentEnv } from "./clusters/deployment.ts";
import {
  type ClusterFacts,
  type ClusterSlot,
  checkCluster,
  clusterLine,
  HARNESS_LABELS,
  type SlotQuota,
  slotNetwork,
  slotQuota,
} from "./clusters/facts.ts";
import {
  type ClusterKubectl,
  inspectKubeconfig,
  KUBE_NAME,
  kubeError,
  realKubectl,
} from "./clusters/kubectl.ts";
import {
  asList,
  clusterNames,
  clusterRigDeployments,
  clusterRigObjects,
  clusterRigResized,
  rigResources,
} from "./clusters/manifests.ts";
import {
  checkProgress,
  checkRow,
  checkRows,
  checkRowsOf,
  checkWaits,
  clockUtc,
  commandFollowUrl,
  commandProgress,
  modelFollowUrl,
  modelProgress,
  notSent,
  type Progress,
  takingModel,
} from "./command-progress.ts";
import {
  type CopyCampaignOutcome,
  type CopyCampaignRequest,
  copiedFromWords,
  copiedMcpWords,
  copyCampaign,
} from "./copy-campaign.ts";
import type { Credential } from "./credential.ts";
import { newToken } from "./credential.ts";
import { archiveResponse, type ExportFiles } from "./exports.ts";
import { makeDeployKey } from "./git-keys.ts";
import {
  issueCommand,
  issueWaking,
  nobodyReads,
  panelReviews,
  propagateChampion,
} from "./issue.ts";
import {
  JOIN_HOURS,
  type JoinedSpec,
  type JoinForm,
  joinCommand,
  joinedCommands,
  joinMachineScript,
  joinNamespaceManifest,
} from "./join.ts";
import { briefingSeedOf, type KbItem, type KbKind, PICKABLE, queueSeedOf } from "./kb.ts";
import type { KitRepos } from "./kit-repos.ts";
import { kitSummary, unpackKit } from "./kit-upload.ts";
import {
  advanceResets,
  cancelReset,
  confirmReset,
  type DeploymentDriver,
  type RunpodDriver,
} from "./lifecycle.ts";
import {
  checkScript,
  deployScript,
  MAX_RIG_GPUS,
  manageScript,
  type RigAction,
  readCheck,
  updateScript,
} from "./machines/deploy.ts";
import {
  CHECK_SCRIPT,
  factsLine,
  type MachineFacts,
  missing,
  parseFacts,
} from "./machines/facts.ts";
import { RECIPES, type RecipeId, recipeScript, scriptSha } from "./machines/recipes.ts";
import {
  ADDRESS,
  fingerprint as fingerprintOf,
  type MachineSsh,
  openSsh,
  USER,
} from "./machines/ssh.ts";
import { campaignMcpServers, McpServers } from "./mcp-servers.ts";
import { mcpSettingsBlocks, mountMcpUi } from "./mcp-ui.ts";
import { askOwnerFrom, type QueueSeed, startCampaign, startRun } from "./new-campaign.ts";
import { PlanUsageReader, usageBlock, usageChips } from "./plan-usage.ts";
import {
  ANTHROPIC_BASE,
  CLAUDE_MODELS,
  cappedWindow,
  capWords,
  contextCapRefusal,
  isOpencodeOwn,
  listModels,
  providerBase,
  sameModel,
} from "./providers.ts";
import { untriedOf } from "./queue-copy.ts";
import { probeRepository, readKitManifest } from "./repo-probe.ts";
import { exportLeft, removeCheck, removeWords, resultsLeft } from "./results-left.ts";
import {
  advisorsFileOf,
  agentModelsOf,
  HARNESS_NAMES,
  harnessRefusal,
  neededHarness,
  OLD_AGENT_NAMES,
  opencodeOnly,
  ROLE_WORDS,
  rigModelChanges,
  rigModelShapeRefusal,
} from "./rig-model.ts";
import {
  QUIET_TIP,
  quietField,
  type RigPart,
  type RigSettingsChange,
  rigSettingsChange,
  SPLIT_RESTARTS,
  settingsCount,
} from "./rig-settings.ts";
import { RigUpdates } from "./rig-update.ts";
import { type RunpodFacts, readRunpod, runpodLine } from "./runpod.ts";
import { runpodResetRefusal } from "./runpod-lifecycle.ts";
import type { RunpodRigView } from "./runpod-rig-view.ts";
import {
  DEFAULT_VOLUME_GB,
  FORM_IDLE_STOP_MINUTES,
  type LaunchRequest,
  type LimitsChange,
  MIN_IDLE_STOP_MINUTES,
  type RunpodRigs,
} from "./runpod-rigs.ts";
import { cheapestGpu, DEFAULT_DISK_GB, type RunpodTests, type TestView } from "./runpod-tests.ts";
import { keyHint, type SecretBox } from "./secrets.ts";
import type { StartRunOutcome, StartRunRequest } from "./start-run.ts";
import {
  AGENT_ROLES,
  type AgentRole,
  type Cluster,
  type ClusterRig,
  type ClusterRigResize,
  type ClusterRigSize,
  type ControlStore,
  codexTakes,
  cursorOf,
  EFFORTS,
  type Effort,
  fingerprint,
  HARNESSES,
  type Harness,
  harnessOf,
  type JoinedRig,
  type Machine,
  type MachineRig,
  type ModelProvider,
  type ProviderType,
  RIG_ID,
  type TunnelRig,
} from "./store.ts";
import { ADD_RIG_JS } from "./ui/add-rig-client.ts";
import { campaignBriefBlock } from "./ui/campaign-brief.ts";
import { type ContextRig, contextBlock, startLine, startNote } from "./ui/campaign-context.ts";
import { CAMPAIGN_CONTEXT_JS } from "./ui/campaign-context-client.ts";
import {
  campaignFilter,
  campaignsListBody,
  earlierRuns,
  isRigCheck,
  lastActivity,
  type StartRig,
  startDrawer,
  workCard,
} from "./ui/campaigns.ts";
import { CLIENT_JS } from "./ui/client.ts";
import { formPayload } from "./ui/command-forms.ts";
import { commandRow } from "./ui/commands.ts";
import {
  ago,
  attemptHref,
  avatar,
  campaignHref,
  deltaCell,
  esc,
  fmtInt,
  gainChart,
  hardwareCard,
  hardwareLine,
  icon,
  JUDGE_ONLY_WORDS,
  kpi,
  meter,
  modeAvatar,
  modeName,
  moreText,
  num,
  pct,
  type RunTab,
  reportingTag,
  runCompleted,
  runHref,
  runKey,
  runLiveHref,
  runState,
  type Shell,
  shell,
  stackBar,
} from "./ui/components.ts";
import { copyDrawer, postedUses, suggestCopyName } from "./ui/copy-campaign.ts";
import { COPY_JS } from "./ui/copy-campaign-client.ts";
import { drainView } from "./ui/drain.ts";
import {
  type AgentLineId,
  type AgentLineNow,
  type AgentModelGroup,
  type AgentModelOption,
  agentsTable,
} from "./ui/edit-rig.ts";
import { EDIT_RIG_JS } from "./ui/edit-rig-client.ts";
import { EXPORT_WHERE, exportForm, exportMenu, exportsBody, exportsHref } from "./ui/exports.ts";
import { FOLLOW_JS } from "./ui/follow-client.ts";
import { bestGainWords, championCard, gainChip, startWords, valuesPairWords } from "./ui/gains.ts";
import { type ChecksSource, howChecked, howCheckedDetails } from "./ui/goal-checks.ts";
import { APPLE_TOUCH_ICON, FAVICON_ICO, FAVICON_SVG, ICON_LINKS } from "./ui/icons.ts";
import {
  campaignKnowledge,
  journalTab,
  knowledgePage,
  pastSection,
  pastWords,
  SEARCH_KINDS,
} from "./ui/knowledge.ts";
import { liveEntryHtml, liveLinesHtml, resultJoin, runEntryHtml, runLinesHtml } from "./ui/live.ts";
import { infoLabel, newCampaignBody, QUEUE_TARGET_TIP } from "./ui/new-campaign.ts";
import { NEW_CAMPAIGN_JS } from "./ui/new-campaign-client.ts";
import {
  attemptDetail,
  attemptRows,
  baselineBlock,
  baselineWords,
  cap,
  championHeldOutBlock,
  confirmingWords,
  type Forms,
  goalState,
  jobHtml,
  leftByClose,
  type Need,
  needs as operatorNeeds,
  runBrief,
  runRow,
  type TimelineRow,
  timeline,
  waitingOn,
} from "./ui/operator.ts";
import { PLANNER_JS } from "./ui/planner-client.ts";
import { PROVIDERS_JS } from "./ui/providers-client.ts";
import { experimentsTab, plannerTab } from "./ui/queue.ts";
import {
  campaignReviewsTab,
  hypothesesTab,
  type ReviewSources,
  researchBlock,
  reviewsTab,
} from "./ui/research.ts";
import { checkFollowUrl, checkRowHtml, modelCheckHtml } from "./ui/rig-checks.ts";
import {
  type RigPlace,
  stateBanners,
  stateRows,
  stateSummary,
  versionFact,
} from "./ui/rig-states.ts";
import {
  type RigsListRow,
  type RigWhere,
  rigFilter,
  rigsListBody,
  rigsSummary,
} from "./ui/rigs-list.ts";
import { type LaunchForm, launchBody } from "./ui/runpod-launch.ts";
import { RUNPOD_LAUNCH_JS } from "./ui/runpod-launch-client.ts";
import {
  HISTORY_FILTERS,
  podBlock,
  podLogBlock,
  podRows,
  podRuns,
  readySteps,
} from "./ui/runpod-rig.ts";
import { STEP_WORDS } from "./ui/setup-steps.ts";
import { STYLE } from "./ui/style.ts";
import {
  campaignUsageBlock,
  metricsBody,
  modelPricesBlock,
  PRICE_NUMBER,
  PRICE_WORDS,
  type RunUsage,
  runStateWord,
  runStatsTab,
  runUsageTop,
} from "./ui/usage.ts";
import { auditReason, clip, jobText, listText, runStatusText, signed, span } from "./ui/words.ts";
import { pricingOf, setModelPrice, usageData } from "./usage.ts";
import { championsInForce, currentChampion, runCampaign } from "./views/facts.ts";
import {
  type CampaignView,
  campaignModes,
  campaignViews,
  leaderboard,
  OFFLINE_AFTER_MS,
  podStopped,
  type RigView,
  type RunView,
  rigSettingsOf,
  rigView,
} from "./views.ts";

/**
 * The control dashboard: server-rendered pages over control's store, with forms that issue signed
 * commands. Login takes the admin token once and keeps a random session in an HttpOnly,
 * SameSite=Strict cookie. Sessions are kept in control's store (hashed), so a restart does not sign
 * the owner out; each use renews one, and a new admin token ends them all. Every form carries a
 * token derived from the session and the admin token (CSRF). The only script is control's own
 * (/ui/assets/app.js): it streams the live view, and follows the owner's actions to their outcome
 * (goal 080: it draws the page's parts again when one comes). Pages never reload by themselves
 * otherwise: the status bar says when the page was made and has a refresh link. The look follows
 * Magnesium's design.
 */

/** How long a dashboard session lasts without use; each day of use renews it. */
const SESSION_DAYS = 30;
const DAY_MS = 24 * 3_600_000;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
/** What Close run does, in its ⋯ menu on a run's page (goal 087). */
const CLOSE_RUN_WORDS =
  "The run ends for good: nothing more starts, and it can't be resumed. Its results stay.";
const CLOSE_WHY_TIP =
  "Why you close the run, up to 500 characters. The run keeps it: it shows wherever the run's state does, in its History and in the rig's export.";
// biome-ignore lint/suspicious/noExplicitAny: any route's context
type Ctx = Context<any, any, any>;
type RunViewName = RunTab;
/** A try of the Copy panel that control refused (goal 069): what it sent, and why not. */
interface CopyTry {
  name: string;
  picked?: McpUse[] | undefined;
  error: string;
  /** The copy's Agents' context as typed (goal 070). */
  context?: { cw: string; ca: string } | undefined;
}

export interface DashboardOptions {
  /** The owner's credential (the dashboard signs in with its token). */
  admin: Credential;
  privateKeyPem: string;
  staleAfterMs: number;
  driver?: DeploymentDriver | undefined;
  /** Days a dashboard session lasts without use (default 30). */
  sessionDays?: number | undefined;
  /** Seals the model providers' API keys (the settings page). */
  secrets: SecretBox;
  /** ChatGPT subscriptions' sign-ins and logins (shared with the API, which renews them). */
  chatgpt?: ChatGPTLogins | undefined;
  /** How control reaches model providers to list their models (tests give their own). */
  providerFetch?: typeof fetch | undefined;
  /** Kits control writes (the new-campaign page); none: campaigns cannot be created here. */
  kits?: KitRepos | undefined;
  /** How control reads a project's repository (tests give their own). */
  probeRepo?: typeof probeRepository | undefined;
  /** How control reads a kit's kit.json from its repository (tests give their own). */
  readKit?: typeof readKitManifest | undefined;
  /** Control's address as rigs and machines reach it. */
  publicUrl?: string | undefined;
  /** How control reaches machines over SSH (tests give their own). */
  machineSsh?: MachineSsh | undefined;
  /** The images control deploys rigs from (none: control can't set rigs up on machines). */
  rigImages?: RigImages | undefined;
  /** How control reaches Kubernetes clusters (tests give their own). */
  clusterKubectl?: ClusterKubectl | undefined;
  /** How often a draining rig's report is looked at (goal 079; default 10 s). */
  drainWatchMs?: number | undefined;
  /** How control reaches GPU clouds' APIs (tests give their own). */
  cloudFetch?: typeof fetch | undefined;
  /** Test pods on GPU clouds (made by createControlApi). */
  runpodTests?: RunpodTests | undefined;
  /** Actions MCP offers too: the dashboard fills them in (actions.ts). */
  actions?: ControlActions | undefined;
  /** MCP servers for the agents (goal 068; made by createControlApi). */
  mcpServers?: McpServers | undefined;
  /** Rigs the owner launches on GPU clouds (made by createControlApi): the launch form, their pods. */
  runpodRigs?: RunpodRigs | undefined;
  /** Their stop, start, restart and terminate (made by createControlApi). */
  runpodDriver?: RunpodDriver | undefined;
  /** Control's own build, which each rig's is compared with (default: this process's). */
  control?: BuildInfo | undefined;
  /** After this long without a report a rig is offline (default: views.ts's OFFLINE_AFTER_MS). */
  offlineAfterMs?: number | undefined;
  /** Updates of rigs to control's version (tests give their own, with short waits). */
  rigUpdates?: RigUpdates | undefined;
  /** The exports rigs send control (made by createControlApi); none: control keeps none. */
  exportFiles?: ExportFiles | undefined;
}

/** The images a rig control sets up runs: the harness (CPU, and CUDA for GPU rigs), the supervisor. */
export interface RigImages {
  harness: string;
  harnessCuda?: string | undefined;
  supervisor: string;
}

export function createDashboard(store: ControlStore, opts: DashboardOptions): Hono {
  const app = new Hono();
  const chatgpt = opts.chatgpt ?? new ChatGPTLogins(store, opts.secrets, opts.providerFetch);
  // Subscriptions' usage windows (goal 151), on Providers and over MCP.
  const planUsage = new PlanUsageReader(store, (p) => chatgpt.usage(p));
  if (opts.actions) opts.actions.planUsage = (p) => planUsage.of(p);
  const mcpServers = opts.mcpServers ?? new McpServers(store, opts.secrets);
  // Control's own build, which each rig's is compared with, and the window after which a rig
  // that does not report is offline.
  const control = opts.control ?? buildInfo();
  const offlineAfterMs = Math.max(opts.offlineAfterMs ?? OFFLINE_AFTER_MS, opts.staleAfterMs);
  // Update to control's version, from a rig's page: each runs on in the background.
  const updates =
    opts.rigUpdates ??
    new RigUpdates({
      store,
      privateKeyPem: opts.privateKeyPem,
      control,
      staleAfterMs: opts.staleAfterMs,
      offlineAfterMs: opts.offlineAfterMs,
    });
  updates.endUnfinished();
  // Only control's own script runs: even an escaping mistake cannot become code.
  app.use("/ui/*", async (c, next) => {
    await next();
    c.header("content-security-policy", CSP);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
  });
  app.use("/ui", async (c, next) => {
    await next();
    c.header("content-security-policy", CSP);
  });
  // Keyed by control's own signing key and the owner's credential: stable across restarts, void
  // once the token changes, and not derivable from the token's hash alone (which is not secret).
  const tokenKey = createHash("sha256")
    .update(`thermite-ui\0${opts.privateKeyPem}\0${opts.admin.hex}`)
    .digest();
  const tokenFp = createHmac("sha256", tokenKey).update("session-fingerprint").digest("hex");
  const csrfOf = (sid: string) =>
    createHmac("sha256", tokenKey).update(`csrf\0${sid}`).digest("hex");
  const hashOf = (sid: string) => createHash("sha256").update(sid).digest("hex");
  const sessionMs = (opts.sessionDays ?? SESSION_DAYS) * DAY_MS;
  const cookie = (c: Ctx, sid: string) =>
    setCookie(c, "thermite_session", sid, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/ui",
      maxAge: Math.floor(sessionMs / 1000),
      // Behind a proxy that ends TLS, the proxy's header says the owner's side is HTTPS.
      secure:
        new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    });
  const sessionOf = (c: Ctx) => {
    const sid = getCookie(c, "thermite_session");
    if (!sid) return undefined;
    const s = store.uiSession(hashOf(sid));
    const now = Date.now();
    if (!s || s.expiresAt <= now || !sameSecret(s.tokenFp, tokenFp)) return undefined;
    // Renewed at most once a day, so a session in use does not run out.
    if (s.expiresAt - now < sessionMs - DAY_MS) {
      store.extendUiSession(hashOf(sid), now + sessionMs);
      cookie(c, sid);
    }
    return sid;
  };

  // The dashboard's icons, at the root with no sign-in, so the sign-in page has them too.
  const iconRoute = (body: string | Buffer, type: string) => (c: Ctx) =>
    c.body(typeof body === "string" ? body : new Uint8Array(body), 200, {
      "content-type": type,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
  app.get("/favicon.svg", iconRoute(FAVICON_SVG, "image/svg+xml"));
  app.get("/favicon.ico", iconRoute(FAVICON_ICO, "image/x-icon"));
  app.get("/apple-touch-icon.png", iconRoute(APPLE_TOUCH_ICON, "image/png"));

  app.get("/ui/login", (c) =>
    c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Thermite</title>${ICON_LINKS}<style>${STYLE}
.login { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
.login .card { width: 100%; max-width: 380px; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
.login .brand { padding: 0; } .login input { width: 100%; height: 36px; } .login button { height: 36px; justify-content: center; }
</style></head><body><main class="login"><form class="card" method="post" action="/ui/login">
<div class="brand"><span class="mark">Th</span>Thermite control</div>
<div class="muted small">Sign in with the admin token. This browser stays signed in while you use it, and a session left unused for ${opts.sessionDays ?? SESSION_DAYS} days ends.</div>
<label class="small">Admin token<input type="password" name="token" autocomplete="current-password" autofocus style="margin-top:6px"></label>
<button class="primary">Sign in</button></form></main></body></html>`,
    ),
  );
  // Failed sign-ins in the last minute: past 20, sign-in waits (the token is random, so this
  // only slows a guesser and keeps the log readable).
  let failures: number[] = [];
  app.post("/ui/login", bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const now = Date.now();
    failures = failures.filter((t) => t > now - 60_000);
    if (failures.length >= 20) return c.text("too many failed sign-ins; wait a minute", 429);
    const form = await c.req.parseBody();
    const token = String(form.token ?? "");
    if (!opts.admin.matches(token)) {
      failures.push(now);
      if (failures.length === 20) store.audit("control", "login_throttled", {});
      return c.redirect("/ui/login", 303);
    }
    const sid = randomBytes(24).toString("base64url");
    store.createUiSession(hashOf(sid), tokenFp, Date.now() + sessionMs);
    cookie(c, sid);
    store.audit("owner:ui", "login", {});
    return c.redirect("/ui", 303);
  });

  // Everything else needs a session.
  app.use("/ui/*", async (c, next) => {
    if (c.req.path === "/ui/login") return next();
    const sid = sessionOf(c);
    if (!sid) return c.redirect("/ui/login", 303);
    // Logging out needs no form token: the worst a forged logout does is sign the owner out.
    if (c.req.method === "POST" && c.req.path !== "/ui/logout") {
      const form = await c.req.parseBody();
      if (!sameSecret(String(form.csrf ?? ""), csrfOf(sid))) return c.text("bad form token", 403);
    }
    await next();
  });
  app.get("/ui", async (c, next) => {
    if (!sessionOf(c)) return c.redirect("/ui/login", 303);
    await next();
  });

  app.post("/ui/logout", (c) => {
    const sid = sessionOf(c);
    if (sid) store.deleteUiSession(hashOf(sid));
    return c.redirect("/ui/login", 303);
  });

  app.get("/ui/assets/app.js", (c) =>
    c.body(`${CLIENT_JS}${FOLLOW_JS}`, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  const csrf = (c: Ctx) => csrfOf(sessionOf(c) ?? "");
  /** A rig that never reported (its first report may wait for its key): no last report time. */
  const neverReported = (u: RigView) => !(Date.parse(u.last_seen) > 0);
  const views = (): RigView[] =>
    store
      .rigs()
      .map((u) =>
        rigView(store, u.id, {
          staleAfterMs: opts.staleAfterMs,
          offlineAfterMs: opts.offlineAfterMs,
          control: opts.control,
        }),
      )
      .filter((v): v is RigView => v !== undefined);
  /** A form that issues a command; `back` is where the owner lands afterwards. */
  const cmdForm = (
    c: Ctx,
    f: {
      rig: string;
      kind: string;
      fields?: Record<string, string>;
      label: string;
      cls?: string;
      back?: string;
      extra?: string;
      /** Off while what it sent waits for the rig (a check's Sent, Running…). */
      disabled?: boolean;
    },
  ) =>
    `<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="rig" value="${esc(f.rig)}"><input type="hidden" name="kind" value="${esc(f.kind)}">${Object.entries(
      f.fields ?? {},
    )
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join(
        "",
      )}${f.back ? `<input type="hidden" name="back" value="${esc(f.back)}">` : ""}${f.extra ?? ""}<button class="${f.cls ?? ""}"${f.disabled ? " disabled" : ""}>${esc(f.label)}</button></form>`;

  /** Pause, with an optional reason the run keeps (it shows wherever the run's state does). */
  const pauseMenu = (c: Ctx, rig: string, run: string, back: string, cls = "") =>
    `<details class="menu"><summary class="btn${cls ? ` ${cls}` : ""}">Pause</summary><div class="menu-pop">${cmdForm(c, { rig, kind: "pause_run", fields: { run }, label: "Pause the run", cls: "sm", back, extra: `<input name="reason" maxlength="500" placeholder="why (optional)" aria-label="Why" style="width:100%;margin-bottom:6px">` })}<div class="muted small">The lanes' running trials stop and no new ones start. Its jobs waiting for the judge wait until you resume, so the judge's time goes to running runs. Resume picks up from the same champion.</div></div></details>`;
  /**
   * Close run (goal 087): the owner's reason, what closing does, and a typed confirmation, as
   * Retire and Full reset ask for. Control checks the typed words too (/ui/commands).
   */
  const closeForm = (c: Ctx, rig: string, run: string, back: string) =>
    `<form method="post" action="/ui/commands" class="stack close-run"><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="rig" value="${esc(rig)}"><input type="hidden" name="kind" value="close_run"><input type="hidden" name="run" value="${esc(run)}"><input type="hidden" name="back" value="${esc(back)}"><div class="small"><b>Close run.</b> <span class="muted">${CLOSE_RUN_WORDS}</span></div><label>${infoLabel("Why", CLOSE_WHY_TIP)}<input name="reason" required maxlength="500" placeholder="such as: another run finished the work"></label><input name="confirm" placeholder="type: close ${esc(run)}" data-confirm="close ${esc(run)}" aria-label="Type close ${esc(run)} to confirm"><button class="danger">Close the run</button></form>`;
  /**
   * ⋯ in a run's header: Restart the lanes, for a running run with agents (the run's header and
   * Live's), and, with `close` (the run's page), Close run for a run not closed yet (goal 087).
   */
  const moreMenu = (c: Ctx, rig: string, r: RunView, back: string, cls = "", close = false) => {
    const restart =
      r.status === "running" && r.has_agents !== false
        ? `${cmdForm(c, { rig, kind: "reset_workers", fields: { run: r.id }, label: "Restart the lanes", cls, back })}<div class="muted small">Ends the lanes' running trials now and the current round: every lane starts again from the champion. Nothing the judge decided is lost.</div>`
        : "";
    const closing = close && r.status !== "closed" ? closeForm(c, rig, r.id, back) : "";
    if (!restart && !closing) return "";
    return `<details class="menu"><summary class="btn${cls ? ` ${cls}` : ""}" title="More">⋯</summary><div class="menu-pop">${restart}${restart && closing ? `<div class="divider" style="margin:2px 0"></div>` : ""}${closing}</div></details>`;
  };
  const forms = (c: Ctx): Forms => ({
    cmd: (f) => cmdForm(c, f),
    csrf: csrf(c),
  });
  /**
   * Everything that waits for the owner, across rigs: the "Needs you" feed, with its evidence.
   * A decision already sent, and not refused, is left out at once; it comes back only if the
   * rig refuses it or the item needs the owner again.
   */
  const needs = (c: Ctx, vs: RigView[], now: number, back = "/ui"): Need[] =>
    operatorNeeds(store, vs, forms(c), now, back).filter((n) => !n.decided);
  /** The archived campaigns (goal 077): out of the navigation, Needs you and the Overview. */
  const archivedNames = () => new Set(store.archivedCampaigns().map((a) => a.campaign));
  /** A run's campaign, as the views name it (a run without one is its own). */
  const campaignOfRun = (vs: RigView[], rig: string, run: string) => {
    const r = vs.find((u) => u.id === rig)?.runs.find((x) => x.id === run);
    return r ? runCampaign(r) : undefined;
  };
  /** Leaves out what belongs to an archived campaign's runs: for Needs you and the lists. */
  const notArchived = <T extends { rig: string; run?: string | undefined }>(
    vs: RigView[],
    xs: T[],
    archived = archivedNames(),
  ) =>
    archived.size
      ? xs.filter((x) => !x.run || !archived.has(campaignOfRun(vs, x.rig, x.run) ?? ""))
      : xs;
  /** The run an event is about: its body's run, the run it names, or its attempt's run. */
  const eventRun = (u: RigView, e: RigView["recent"][number]): string | undefined => {
    const b = e.body?.run;
    if (typeof b === "string") return b;
    if (!e.subject) return undefined;
    if (u.runs.some((r) => r.id === e.subject)) return e.subject;
    return u.runs.find((r) => r.attempts.some((a) => a.id === e.subject))?.id;
  };
  /** Where a page's forms in the navigation return: the page, without the notes it showed. */
  const backHere = (c: Ctx) => {
    const u = new URL(c.req.url);
    for (const k of ["sent", "error", "on", "ok"]) u.searchParams.delete(k);
    return `${u.pathname}${u.search}`;
  };
  /** The page shell with the navigation's campaigns and their folders. */
  const page = (c: Ctx, s: Omit<Shell, "rigs" | "needs" | "now">, body: string, vs = views()) => {
    const now = Date.now();
    // A command just sent from this page (POST /ui/commands): say so at the top.
    const sent = c.req.query("sent");
    // What a folder's form or Archive refused (on=shelf): at the top, in words.
    const shelfError = c.req.query("on") === "shelf" ? c.req.query("error") : undefined;
    if (shelfError) {
      const [head, ...rest] = shelfError.split(/(?<=\.) /);
      body = `<div class="card warn" style="margin-bottom:16px"><b class="bad">${esc(head)}</b> ${esc(rest.join(" "))}</div>${body}`;
    } else if (sent)
      body = `<div class="card sent-note" style="margin-bottom:16px"><b class="ok">${esc(sent)}</b></div>${body}`;
    const archived = archivedNames();
    const path = new URL(c.req.url).pathname;
    const current = path.startsWith("/ui/campaigns/")
      ? decodeURIComponent(path.slice("/ui/campaigns/".length).split("/")[0] ?? "")
      : undefined;
    return c.html(
      shell(
        {
          ...s,
          rigs: vs,
          needs: notArchived(
            vs,
            needs(c, vs, now).filter((n) => n.kind !== "stale"),
            archived,
          ).length,
          now,
          nav: {
            folders: store.campaignFolders(),
            archived,
            csrf: csrf(c),
            back: backHere(c),
            current,
          },
        },
        body,
      ),
    );
  };

  /**
   * A run's model use and cost (goal 075), for the top of its page above the tabs and its Stats
   * tab: control's sums of its records on this rig, its rounds for the bars, its time, and a
   * RunPod rig's price an hour. The teachers' lines say "teacher 1" or "teacher 2" where the
   * rig's settings tell which. None: a run with no agents (a try of a kit) and nothing spent.
   */
  const runUsage = (u: RigView, i: RunView, now: number): RunUsage | undefined => {
    const d = usageData(store, { run: i.id, rig: u.id });
    if (!i.has_agents && !d.report.total.records && d.report.total.cost.pod_usd === null)
      return undefined;
    const roles = store.roleModels(u.id);
    const launched = store.runpodRig(u.id);
    const perHour = (launched?.state as { price_per_hr?: unknown } | null)?.price_per_hr;
    // The run's time: from its start to now, or to its last event once it is finished.
    const start = Date.parse(i.created_at ?? "");
    const end = i.status === "closed" ? Date.parse(i.timeline.at(-1)?.at ?? "") : now;
    return {
      report: d.report,
      rows: d.rows,
      roundStarts: store.roundStarts(u.id, i.id),
      trials: i.agents.trials,
      rounds: i.agents.epochs,
      wallMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
      rig: u.id,
      champion: championCard(i),
      pod: launched
        ? { perHour: typeof perHour === "number" && perHour > 0 ? perHour : null }
        : undefined,
      teacher: (provider, model) => {
        const is = (r: { provider: string; model: string } | undefined) =>
          r !== undefined && r.provider === provider && r.model === model;
        const one = is(roles.teachers);
        const two = is(roles.second_teacher);
        return one && !two ? "teacher 1" : two && !one ? "teacher 2" : "";
      },
    };
  };

  /**
   * What a research run's Reviews tab reads beyond the run's events (goal 116): each review's
   * model use, from the review panel's records (round "review N"), priced as Metrics prices them,
   * and the supervisor's lines for it in the run's Live view.
   */
  const reviewSources = (u: RigView, i: RunView): ReviewSources => {
    const rows = store.reviewUsageRows(u.id, i.id);
    const price = pricingOf(store);
    const lines = store.reviewLines(u.id, i.id);
    return {
      usage: (n) => {
        const rs = rows.get(n);
        if (!rs?.length) return undefined;
        const s = sumUsage(
          rs.map((r) => ({ ...r, pricing: price(r.provider, r.model, r.harness) })),
        );
        return {
          calls: s.calls,
          tokens_in: s.tokens_in,
          tokens_out: s.tokens_out,
          call_ms: s.call_ms,
          usd: s.cost.usd,
        };
      },
      lines: (n) => lines.filter((l) => l.review === n),
    };
  };

  /** A campaign's model use and cost over all its runs on every rig (goal 075), for its sidebar. */
  const campaignUsage = (k: CampaignView) =>
    campaignUsageBlock({
      report: usageData(store, { campaign: k.name }).report,
      run: (rig, run) => {
        const x = k.runs.find((y) => y.rig.id === rig && y.run.id === run);
        return x
          ? {
              href: runHref(rig, x.run),
              state: runCompleted(x.run) ? "completed" : runStateWord(x.run.status),
            }
          : undefined;
      },
    });

  /**
   * One run on its campaign's page, one view at a time: its overview (what waits for the owner,
   * what it is doing now, goals, what happened, latest attempts), all its attempts, its history
   * in words, or its steering. Command forms return to the same view.
   */
  const runSection = (
    c: Ctx,
    u: RigView,
    i: RunView,
    vs: RigView[],
    now: number,
    view: RunViewName,
  ) => {
    const t = csrf(c);
    const back = runHref(u.id, i, view);
    const others = vs.filter((x) => x.id !== u.id);
    // A research run's page has its Reviews and Hypotheses tabs (goals 116 and 117).
    const researchRun = i.mode === "research";
    const usage = runUsage(u, i, now);
    const decisions = needs(c, [u], now, back).filter((n) => n.run === i.id);
    // How each goal is really checked (goal 082): as this run's rig reported its kit, else as
    // control can read the campaign's kit or contract.
    const how = i.mode === "goal" ? goalChecksFor(runCampaign(i), vs, u.id, i) : undefined;
    const howFor = (goal: string) =>
      howCheckedDetails(
        how?.checks.goals.find((x) => x.goal === goal),
        how?.checks,
        how?.source,
      );
    const goals = i.goals.length
      ? `<div class="block"><div class="head"><h2>Goals</h2><span class="n">${i.goals.filter((g) => g.status === "met").length} of ${i.goals.length} met</span><span class="right">the judge's check of champion #${esc(i.goals_seq ?? "?")}${i.goals_at ? `, ${esc(ago(i.goals_at, now))} ago` : ""}</span></div><div class="card flat">${i.goals
          .map((g) => {
            const st = goalState(g);
            return `<div class="gl"><span class="gl-mark ${st.tone}">${st.mark}</span><span class="gl-main"><span><b>${esc(g.goal)}</b>${g.status === "met" ? "" : ` <span class="chip ${st.tone === "off" ? "" : st.tone}">${esc(st.word)}</span>`}</span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}<div class="gl-why ${st.tone}">${moreText(g.reasons, 400)}</div>${howFor(g.goal)}</span></div>`;
          })
          .join("")}</div></div>`
      : i.mode === "goal"
        ? `<div class="block"><div class="head"><h2>Goals</h2></div><div class="card${how?.checks.goals.length ? " flat" : ""}"><div class="empty">The judge has not checked the goals yet.</div>${(
            how?.checks.goals ?? []
          )
            .map(
              (g) =>
                `<div class="gl"><span class="gl-mark off">·</span><span class="gl-main"><span><b>${esc(g.goal)}</b></span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}${howFor(g.goal)}</span></div>`,
            )
            .join("")}</div></div>`
        : "";
    // A research run (goals 112, 116 and 117): each question with its answer card, its standing
    // decision, its gaps, its share of the work and whether it is saturated; the answer check and
    // the progress rule; the paper and the latest report.
    const research = i.mode === "research" || i.research ? researchBlock(u, i, now) : "";
    // The changes that waited when the run closed (goal 087): they left Needs you.
    const left = leftByClose(i, u).length;
    const leftWords = left
      ? ` When it closed, ${left} change${left === 1 ? "" : "s"} waited for a decision. ${left === 1 ? "It does" : "They do"} not become the champion, and nothing in this run waits for you.`
      : "";
    const now_ =
      i.status === "running"
        ? runBrief(store, u, i, now, { detail: true })
        : `<div class="card"><div class="small">This run is <b>${esc(runStatusText(i))}</b>. ${i.status === "paused" ? `Nothing new starts until it is resumed.` : `It is finished.${leftWords}`}</div></div>`;
    const recent = timeline(
      i.timeline.map((e) => ({ u, e })),
      now,
      { limit: 10 },
    );
    const newest = [...i.attempts].reverse();
    // Lane ▸ attempts: what each lane has tried and how the judge decided it.
    const lanes = [
      ...new Set(i.attempts.map((a) => a.lane).filter((l): l is string => !!l)),
    ].sort();
    const winKind = i.mode === "goal" ? "goal_progress" : "win_confirmed";
    const laneCard = lanes.length
      ? `<div class="card flat" style="margin-bottom:12px"><table><thead><tr><th>Lane</th><th class="num">Attempts</th><th class="num">${i.mode === "goal" ? "Goal progress" : "Confirmed wins"}</th><th class="num">Best change</th><th>Latest idea</th></tr></thead><tbody>${lanes
          .map((l) => {
            const xs = i.attempts.filter((a) => a.lane === l);
            const deltas = xs.map((a) => a.delta).filter((d): d is number => d !== null);
            return `<tr><td><span class="chip">${esc(l)}</span></td><td class="num">${xs.length}</td><td class="num">${xs.filter((a) => a.verdict === winKind).length}</td><td class="num">${deltas.length ? deltaCell(Math.max(...deltas)) : ""}</td><td class="clip">${esc(xs.at(-1)?.hypothesis ?? "")}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : "";
    const sub = (v: RunViewName, label: string, extra = "") =>
      `<a class="${view === v ? "on" : ""}" href="${runHref(u.id, i, v)}">${label}${extra}</a>`;
    // Steering: each control says what it does.
    const ctl = (button: string, does: string) =>
      `<div class="choice"><div class="btns">${button}</div><div class="does">${does}</div></div>`;
    const propagate =
      i.published && others.length
        ? ctl(
            `<form class="inline" method="post" action="/ui/propagate"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(i.id)}"><select name="target">${others
              .flatMap((o) =>
                o.runs
                  .filter((x) => x.campaign === i.campaign)
                  .map(
                    (x) =>
                      `<option value="${esc(`${o.id}|${x.id}`)}">${esc(o.id)} / ${esc(x.id)}</option>`,
                  ),
              )
              .join("")}</select><button>Send champion #${i.published.seq}</button></form>`,
            `Another rig's run of this campaign imports this run's champion, and its own judge tests it there. If it holds up, it counts as cross-verified.`,
          )
        : "";
    const audits = i.audits.slice(-8).reverse();
    const records = [
      audits.length
        ? `<div class="block"><div class="head"><h2>Audits</h2></div><div class="card flat"><table><thead><tr><th>Attempt</th><th>Why it was audited</th><th>Outcome</th></tr></thead><tbody>${audits
            .map(
              (x) =>
                `<tr><td><a href="${attemptHref(u.id, x.attempt)}"><code>${esc(x.attempt)}</code></a></td><td>${esc(auditReason(x.reason))}</td><td class="${x.decision === "block" ? "bad" : x.decision ? "ok" : "warn"}">${esc(x.decision === null ? (u.supervisor && (u.supervisor as { advisors?: unknown }).advisors ? "waiting for the auditor" : "waiting for you (no auditor configured)") : x.decision === "block" ? "blocked by the auditor" : x.decision === "clear" ? "cleared by the auditor" : x.decision === "needs_owner" ? "passed to you" : x.decision)}${x.reasons ? `<div class="muted xs">${esc(clip(x.reasons, 200))}</div>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div></div>`
        : "",
      // A research run's reviews (goal 112) are not goals': its Overview's Answer check says
      // where they stand.
      i.reviews.some((r) => r.goal !== RESEARCH_REVIEW)
        ? `<div class="block"><div class="head"><h2>Reviews of subjective goals</h2></div><div class="card flat"><table><thead><tr><th>Goal</th><th>Commit</th><th>Review panel</th><th>You</th></tr></thead><tbody>${i.reviews
            .filter((r) => r.goal !== RESEARCH_REVIEW)
            .slice(-8)
            .reverse()
            .map(
              (r) =>
                `<tr><td>${esc(r.goal)}</td><td><code>${esc(r.commit.slice(0, 8))}</code></td><td>${esc((r.panel ?? "waiting").replace(/_/g, " "))}</td><td>${esc(r.owner ?? "")}</td></tr>`,
            )
            .join("")}</tbody></table></div></div>`
        : "",
      i.propagations.length
        ? `<div class="block"><div class="head"><h2>Champions from other rigs</h2></div><div class="card flat"><table><thead><tr><th>From</th><th>Attempt here</th><th>Result here</th></tr></thead><tbody>${i.propagations
            .slice(-8)
            .reverse()
            .map(
              (p) =>
                `<tr><td>${esc(p.source_rig)} / ${esc(p.source_run)} champion #${p.source_seq}</td><td>${p.attempt ? `<a href="${attemptHref(u.id, p.attempt)}"><code>${esc(p.attempt)}</code></a>` : ""}</td><td class="${p.result === "accepted" ? "ok" : p.result.startsWith("rejected") ? "bad" : "muted"}">${esc(p.result)}</td></tr>`,
            )
            .join("")}</tbody></table></div></div>`
        : "",
    ]
      .filter(Boolean)
      .join("");
    const a = i.agents;
    const diagnostics = `<div class="block"><div class="head"><h2>Agent figures</h2><span class="right">for diagnosing the agents, not the research</span></div><div class="kpis">${[
      i.mode === "research"
        ? kpi(
            "Rounds",
            String(a.epochs),
            a.epochs
              ? `${a.planner_valid} by the model · ${a.fallbacks} by the gap-driven plan`
              : "",
          )
        : kpi(
            "Plans",
            String(a.epochs),
            a.epochs
              ? `${Math.round((100 * a.planner_valid) / a.epochs)}% by the model · ${a.fallbacks} fallbacks`
              : "",
          ),
      kpi("Trials", String(a.trials), `${a.submitted} submitted`),
      kpi("Tokens", fmtInt(a.tokens_in + a.tokens_out), `${fmtInt(a.tokens_out)} out`),
      kpi("Duplicates", String(a.duplicates), "the same change again"),
      ...(i.mode === "hill_climb"
        ? [
            kpi(
              "Rig noise",
              i.calibration ? `±${(i.calibration.sigma * 100).toFixed(2)}%` : "·",
              "per block (A/A)",
            ),
          ]
        : []),
    ].join("")}</div></div>`;
    const waiting = decisions.length;
    const champ = currentChampion(i);
    const met = i.goals.filter((g) => g.status === "met").length;
    const lanesAtWork = Object.keys(i.at_work).length;
    const judging =
      u.judge.now && (u.judge.now.run === i.id || u.judge.now.run === null) ? u.judge.now : null;
    // The run in one or two sentences: where it stands, who is at work, what waits for you.
    const said = [
      i.mode === "goal"
        ? i.goals.length
          ? `${met} of ${i.goals.length} goals met by champion #${champ?.seq ?? 1}.`
          : "The judge has not checked the goals yet."
        : i.mode === "hill_climb"
          ? `Champion #${champ?.seq ?? 1} is ${esc(signed((champ?.cumulative ?? 1) - 1))} against where the run started.`
          : `${num((i.research as Record<string, unknown> | null)?.verified)} verified claims so far.`,
      i.status === "running"
        ? lanesAtWork
          ? `${lanesAtWork} lane${lanesAtWork === 1 ? " is" : "s are"} at work.`
          : "No lane is at work."
        : `It is ${esc(runStatusText(i))}.`,
      i.status === "running" ? confirmingWords(i) : "",
      // A hill climb's baseline (goal 115): the judge measures the starting point first.
      i.status === "running" ? esc(baselineWords(i)) : "",
      judging
        ? `The judge is ${esc(jobText(judging).replace(/^[A-Z]/, (x) => x.toLowerCase()))}.`
        : "",
      waiting
        ? `<b class="warn">${waiting} decision${waiting === 1 ? " waits" : "s wait"} for you.</b>`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    // A project in a folder: the patch's paths start at that folder of the repository's commit.
    const appliesTo = i.seed_folder
      ? `applies to the folder ${esc(i.seed_folder.folder)} at ${esc(i.seed_folder.commit.slice(0, 8))}: git apply --directory=${esc(i.seed_folder.folder)}`
      : `applies to ${esc(i.published?.base_commit.slice(0, 8) ?? "")}`;
    const patch =
      i.published && store.championPatch(u.id, i.id, i.published.seq)
        ? `<a href="/ui/rigs/${encodeURIComponent(u.id)}/runs/${encodeURIComponent(i.id)}/champions/${i.published.seq}.patch">download champion #${i.published.seq} as a patch</a> <span class="muted small">(${appliesTo})</span>`
        : "";
    // The champions, newest first: what each one changed and what it gained.
    const ladder =
      i.mode === "hill_climb"
        ? `<div class="block"><div class="head"><h2>Champions</h2><span class="n">${championsInForce(i).length}</span><span class="right">gain over the starting point, measured on this rig</span></div><div class="card flat"><div class="ladder-chart">${gainChart(i)}</div>${i.champion
            .filter((x) => !x.reopened)
            .slice()
            .reverse()
            .slice(0, 12)
            .map((x) => {
              const a = x.attempt ? i.attempts.find((y) => y.id === x.attempt) : undefined;
              return `<div class="lad"><span class="lad-n">#${x.seq}</span><span class="lad-main">${x.attempt ? `<a href="${attemptHref(u.id, x.attempt)}">${esc(clip(a?.hypothesis ?? x.attempt, 140))}</a>` : `<span class="muted">the starting point</span>`}</span><span>${x.attempt ? gainChip(i, { delta: x.delta, values: a?.values }, "ok") : esc(startWords(i))}</span><b class="fig">${esc(signed(x.cumulative - 1))}</b><span class="lad-age">${esc(ago(x.at, now))}</span></div>`;
            })
            .join("")}</div></div>`
        : "";
    // Hands-off by default (goal 079): what the run asks you about, if anything.
    const asks = [
      typeof i.ask_owner.above_gain === "number"
        ? `a gain above ${(i.ask_owner.above_gain * 100).toFixed(1).replace(/\.0$/, "")}%`
        : "",
      i.ask_owner.declared_flaws ? "a change with declared flaws" : "",
      i.ask_owner.reviews ? "a review panel's pass" : "",
      i.ask_owner.not_possible ? 'a "not possible" ending' : "",
    ].filter(Boolean);
    const policyWord = `${
      i.promotion === "owner_approval"
        ? "Only with your approval"
        : i.promotion === "auto"
          ? "Automatic when the judge confirms, after the auditor's clear when an audit is called for"
          : "The rig's default (automatic unless it was set to ask you)"
    }${asks.length && i.promotion !== "owner_approval" ? `. It asks you about ${asks.join(", ")}` : ""}`;
    const settings = [
      [
        "Champion",
        `#${champ?.seq ?? 1}${champ?.attempt ? "" : " (the starting point)"}, since ${esc(ago(champ?.at, now))} ago${patch ? `<div>${patch}</div>` : ""}`,
      ],
      ["Promotion", esc(policyWord)],
      [
        "Mode",
        esc(
          i.mode === "goal"
            ? "Goal: work until every goal is met"
            : i.mode === "hill_climb"
              ? "Hill climb: keep improving the metric"
              : "Research: build a sourced corpus",
        ),
      ],
      [
        "Agents",
        i.agents.trials || i.epoch || lanesAtWork
          ? `${i.epoch?.assignments.length ?? lanesAtWork} lane${(i.epoch?.assignments.length ?? lanesAtWork) === 1 ? "" : "s"} · ${i.agents.trials} trial${i.agents.trials === 1 ? "" : "s"} done · ${i.agents.submitted} submitted`
          : i.has_agents
            ? "On: they start work at the first round"
            : "None: judge only. No workers run; changes come from people",
      ],
      [
        "Started",
        `${i.created_at ? `${esc(ago(i.created_at, now))} ago` : "?"}${i.seed_repo ? ` from ${esc(i.seed_repo)}` : ""}`,
      ],
    ]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
      .join("");
    const body =
      view === "attempts"
        ? `${i.attempts.length ? `<div class="card" style="margin-bottom:12px"><div class="card-head"><span class="title">How the judge decided</span><span class="right muted small">${i.attempts.length} attempts</span></div><div style="margin-top:10px">${stackBar(i.verdicts)}</div></div>` : ""}${laneCard}${attemptRows(u, i, newest.slice(0, 300), now)}${i.attempts.length > 300 ? `<div class="muted small" style="margin-top:8px">The newest 300 of ${i.attempts.length}.</div>` : ""}${records}`
        : view === "history"
          ? timeline(
              i.timeline.map((e) => ({ u, e })),
              now,
              { limit: 400 },
            )
          : view === "planner"
            ? plannerTab({
                u,
                r: i,
                now,
                csrf: t,
                back,
                cmd: (f) => cmdForm(c, f),
                model: (() => {
                  const own = store.roleModels(u.id).planner;
                  if (own) return `${own.model}, its own model (from ${own.provider})`;
                  return u.model
                    ? u.model.source === "none"
                      ? "No model: the lanes take the queue in order and keep to the rules."
                      : `${u.model.model}, the agents' model (Edit rig can give the planner its own)`
                    : "Not reported by this rig's harness.";
                })(),
                figures: diagnostics,
                propagate,
                // No model for the planner: an old rule in words waits to be converted (goal 066).
                noModel: !store.roleModels(u.id).planner && u.model?.source === "none",
                // A message to the planner that control or the rig refused.
                refused:
                  c.req.query("msgerror") ||
                  (() => {
                    const why = store.lastMessageToRun(u.id, i.id, "planner")?.refused;
                    return why ? `The rig refused your last message to the planner: ${why}` : "";
                  })(),
              })
            : view === "journal"
              ? journalTab({
                  u,
                  r: i,
                  now,
                  counts: u.ledger_id ? store.kb().runCounts(u.id, u.ledger_id, i.id) : {},
                  reads: i.campaign ? store.kb().reads(i.campaign) : [],
                })
              : view === "experiments"
                ? experimentsTab({
                    u,
                    r: i,
                    now,
                    csrf: t,
                    back,
                    cmd: (f) => cmdForm(c, f),
                    families: [
                      ...new Set([
                        ...i.queue.map((x) => x.family),
                        ...i.trials.map((x) => x.family ?? ""),
                        ...(i.epoch?.assignments.map((a) => a.family) ?? []),
                      ]),
                    ].filter(Boolean),
                  })
                : view === "reviews" && researchRun
                  ? reviewsTab({ u, r: i, now, ...reviewSources(u, i) })
                  : view === "hypotheses" && researchRun
                    ? hypothesesTab({ u, r: i, now, cmd: (f) => cmdForm(c, f), back })
                    : view === "stats"
                      ? usage
                        ? runStatsTab(usage)
                        : `<div class="card"><div class="empty">No model use: this run has no agents.</div></div>`
                      : `<p class="run-said" data-part="run-said">${said}</p>
<div data-part="run-needs">${waiting ? `<div class="block" id="needs"><div class="head"><h2>Needs you</h2><span class="n">${waiting}</span></div><div class="dqs">${decisions.map((n) => n.html).join("")}</div></div>` : ""}</div>
<div class="cols run-cols"><div>
${goals}${championHeldOutBlock(i, now)}${research}${baselineBlock(i, u, now)}${ladder}
<div class="block" data-part="attempts"><div class="head"><h2>Attempts</h2><span class="n">${i.attempts.length}</span><span class="right"><a href="${runHref(u.id, i, "attempts")}">All ${i.attempts.length}</a></span></div>${attemptRows(u, i, newest.slice(0, 8), now)}</div>
</div><div class="side">
<div class="block" data-part="now"><div class="head"><h2>Now</h2></div>${now_}</div>
<div class="block" data-part="facts"><div class="head"><h2>The run</h2></div><div class="card"><dl class="facts">${settings}</dl></div></div>
<div class="block" data-part="recent"><div class="head"><h2>Recent</h2><span class="right"><a href="${runHref(u.id, i, "history")}">Full history</a></span></div>${recent}</div>
</div></div>`;
    return `${usage ? runUsageTop(usage) : ""}<section class="block" id="${esc(runKey(u.id, i.id))}">
<nav class="tabs">${sub("overview", "Overview", waiting ? ` <span class="dot warn"></span>` : "")}${sub("experiments", researchRun ? "Tasks" : "Experiments", ` <span class="muted">${i.queue.filter((x) => x.state === "queued").length} up next</span>`)}${sub("journal", "Journal", ` <span class="muted">${((n) => `${n} note${n === 1 ? "" : "s"}`)(i.journal.filter((n) => n.id > 0).length)}</span>`)}${researchRun ? `${sub("reviews", "Reviews", ` <span class="muted">${i.reviews.filter((r) => r.goal === RESEARCH_REVIEW).length}</span>`)}${sub("hypotheses", "Hypotheses", ` <span class="muted">${i.hypotheses.length}</span>`)}` : ""}${sub("attempts", "Attempts", ` <span class="muted">${i.attempts.length}</span>`)}${sub("history", "History")}${sub("planner", "Planner")}${usage ? sub("stats", "Stats") : ""}</nav>
${body}
</section>`;
  };

  /** A campaign's headline figure: its best run's gain, goals met or verified claims. */
  const headline = (k: CampaignView): { value: string; sub: string; best?: RunView } => {
    const runs = k.runs.map((x) => x.run);
    if (k.mode === "hill_climb") {
      const gain = (i: RunView) => (currentChampion(i)?.cumulative ?? 1) - 1;
      const best = [...runs].sort((a, b) => gain(b) - gain(a))[0];
      return { value: best ? pct(gain(best), 1) : "·", sub: bestGainWords(best), best };
    }
    if (k.mode === "goal") {
      const met = (i: RunView) => i.goals.filter((g) => g.status === "met").length;
      const best = [...runs].sort((a, b) => met(b) - met(a))[0];
      return {
        value: best ? `${met(best)}/${best.goals.length || "?"}` : "·",
        sub: "goals met (best run)",
        best,
      };
    }
    const claims = (i: RunView) => num((i.research as Record<string, unknown> | null)?.verified);
    return { value: String(Math.max(0, ...runs.map(claims))), sub: "verified claims" };
  };
  const rigList = (k: CampaignView) => [...new Set(k.runs.map((x) => x.rig.id))];

  // ---------------------------------------------------------------- overview (Magnesium's Home)
  app.get("/ui", (c) => {
    const now = Date.now();
    const vs = views();
    // An archived campaign (goal 077) leaves Needs you and the lists here.
    const archived = archivedNames();
    const feed = notArchived(vs, needs(c, vs, now), archived);
    const urgent = feed.filter((n) => n.kind !== "stale");
    const camps = campaignViews(vs);
    const shelved = (u: RigView, run: string | undefined) =>
      run !== undefined && archived.has(campaignOfRun([u], u.id, run) ?? "");
    // What happened lately, across rigs, in words.
    const activity = timeline(
      vs.flatMap((u) =>
        u.recent
          .slice(0, 40)
          .filter((e) => !archived.size || !shelved(u, eventRun(u, e)))
          .map((e) => ({ u, e })),
      ),
      now,
      { limit: 10, showRig: true },
    );
    // One scan, top to bottom: what needs you, what is at work, what happened.
    const live = vs.flatMap((u) =>
      u.runs
        .filter((i) => i.status === "running" && !archived.has(runCampaign(i)))
        .map((i) =>
          runBrief(store, u, i, now, {
            heading: true,
            waiting: feed.filter((n) => n.rig === u.id && n.run === i.id).length,
          }),
        ),
    );
    const running = live.length;
    // A stopped RunPod pod can't report, and that is expected: it is counted apart.
    const stopped = vs.filter(podStopped).length;
    const expected = vs.length - stopped;
    const reporting = vs.filter((u) => !u.stale && !podStopped(u)).length;
    const judging = vs.filter((u) => u.judge.now).length;
    const tile = (n: string, label: string, tone: string, href = "") =>
      `<${href ? `a href="${href}"` : "div"} class="tally ${tone}"><b>${n}</b><span>${esc(label)}</span></${href ? "a" : "div"}>`;
    const tallies = `<div class="tallies">${tile(String(urgent.length), urgent.length === 1 ? "needs you" : "need you", urgent.length ? "warn" : "", urgent.length ? "#needs" : "")}${tile(String(running), running === 1 ? "run at work" : "runs at work", running ? "ok" : "")}${tile(String(judging), judging === 1 ? "judge measuring" : "judges measuring", "")}${tile(`${reporting}/${expected}`, `rigs reporting${stopped ? `, ${stopped} stopped` : ""}`, reporting < expected ? "bad" : "")}</div>`;
    return page(
      c,
      {
        title: "Overview",
        summary: `${urgent.length ? `<span class="warn">${urgent.length} need${urgent.length === 1 ? "s" : ""} you</span>` : "nothing needs you"} · ${running} run${running === 1 ? "" : "s"} at work · ${reporting} of ${expected} rigs reporting${stopped ? ` · ${stopped} stopped` : ""}`,
        active: "overview",
      },
      `<div data-part="tallies">${tallies}</div>
<div class="block" id="needs" data-part="needs"><div class="head"><h2>Needs you</h2><span class="n">${feed.length}</span><span class="right">open one for its evidence and what each choice does</span></div>
${feed.length ? `<div class="dqs">${feed.map((n) => n.html).join("")}</div>` : `<div class="card"><div class="empty">Nothing waits for you. The campaigns go on by themselves.</div></div>`}</div>
<div class="block" data-part="at-work"><div class="head"><h2>At work</h2><span class="n">${running}</span></div>
${live.length ? live.join("") : `<div class="card"><div class="empty">${camps.length ? "No run is running." : opts.kits ? "No campaign yet. Make one with New campaign on the Campaigns page, or assign one to a rig through control's API, MCP or the CLI." : "No campaign yet. Assign one to a rig through control's API, MCP or the CLI."}</div></div>`}</div>
<div class="block" data-part="happened"><div class="head"><h2>What happened</h2><span class="right">newest first</span></div>${activity}</div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- campaigns
  app.get("/ui/campaigns", (c) => {
    const now = Date.now();
    const vs = views();
    // Archived campaigns (goal 077) have their own filter, with Unarchive; one with no runs too.
    const shelf = new Map(store.archivedCampaigns().map((a) => [a.campaign, a]));
    const reported = campaignViews(vs);
    const modes = shelf.size ? campaignModes(store, vs) : new Map<string, string | null>();
    const camps: CampaignView[] = [
      ...reported,
      ...[...shelf.keys()]
        .filter((name) => !reported.some((k) => k.name === name))
        .map((name) => ({ name, mode: modes.get(name) ?? null, runs: [] })),
    ];
    const feed = notArchived(vs, needs(c, vs, now, "/ui/campaigns"), new Set(shelf.keys()));
    const waitingFor = (u: RigView, r: RunView) =>
      feed.filter((n) => n.rig === u.id && n.run === r.id).length;
    // Rig checks have their own filter: At work counts the campaigns' runs only.
    const atWork = vs.flatMap((u) =>
      u.runs
        .filter(
          (r) =>
            r.status === "running" && !isRigCheck(r.campaign ?? "") && !shelf.has(runCampaign(r)),
        )
        .map((r) => workCardFor(c, u, r, now, waitingFor(u, r), "/ui/campaigns")),
    );
    const waiting = vs
      .flatMap((u) => u.runs.map((r) => ({ rig: u, run: r, n: waitingFor(u, r) })))
      .filter((w) => w.n > 0);
    const shown = camps.length - shelf.size;
    return page(
      c,
      {
        title: "Campaigns",
        summary: `${atWork.length} at work · ${waiting.reduce((a, w) => a + w.n, 0)} decision${waiting.reduce((a, w) => a + w.n, 0) === 1 ? " waits" : "s wait"} for you · ${shown} campaign${shown === 1 ? "" : "s"}${shelf.size ? ` · ${shelf.size} archived` : ""}`,
        active: "campaigns",
        actions: opts.kits
          ? `<a class="btn primary" href="/ui/campaigns/new">New campaign</a>`
          : undefined,
      },
      camps.length
        ? campaignsListBody({
            camps,
            atWork,
            waiting,
            archived: new Map(
              [...shelf].map(([name, a]) => {
                const folder = store.campaignFolderOf(name);
                return [
                  name,
                  `${ago(a.at, now)} ago by ${copiedBy(a.by)}${folder ? ` · in ${folder.name}` : ""}`,
                ];
              }),
            ),
            unarchive: (name) =>
              `<form class="inline" method="post" action="${campaignHref(name)}/unarchive"><input type="hidden" name="csrf" value="${esc(csrf(c))}"><input type="hidden" name="back" value="/ui/campaigns?f=archived"><button class="sm">Unarchive</button></form>`,
            filter: campaignFilter(c.req.query("f")),
            query: c.req.query("q") ?? "",
            now,
            best: (k) => {
              const h = headline(k);
              return `${h.value} ${h.sub.replace(" (best run)", "").replace("best gain over its baseline", "gain")}`;
            },
            about: (k) => aboutOf(k.name),
          })
        : `<div class="card"><div class="empty">No campaign yet.${opts.kits ? ` <a href="/ui/campaigns/new">Start one.</a>` : ""}</div></div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- Metrics (goal 075)
  // The whole system's model use and cost, by model and by campaign: today, the last 7 days (the
  // default) or all. Today starts at midnight in the viewer's own time zone, which the page
  // script adds to the address (tz); without it, UTC, and the line under the title says so.
  app.get("/ui/metrics", (c) => {
    const now = Date.now();
    const vs = views();
    const p = c.req.query("period");
    const period: UsagePeriod = p === "today" || p === "all" ? p : "7d";
    const asked = (c.req.query("tz") ?? "").trim();
    const tz = asked && asked.length <= 64 && knownTimeZone(asked) ? asked : "UTC";
    const d = usageData(store, { period, tz }, new Date(now));
    const modes = new Map(campaignViews(vs).map((k) => [k.name, k.mode]));
    return page(
      c,
      {
        title: "Metrics",
        summary: `every campaign and rig · times in ${esc(tz)}`,
        active: "metrics",
      },
      metricsBody({
        report: d.report,
        rows: d.rows,
        podRigs: [...new Set(d.pods.map((x) => x.rig))],
        // A campaign no rig reports now: its mode as control saved it, when it did.
        mode: (k) => {
          const saved = (store.campaignVersions(k)[0]?.contract as { mode?: unknown } | undefined)
            ?.mode;
          return modes.get(k) ?? (typeof saved === "string" ? saved : null);
        },
        now,
      }),
      vs,
    );
  });

  // ---------------------------------------------------------------- a new campaign
  app.get("/ui/assets/new-campaign.js", (c) =>
    c.body(NEW_CAMPAIGN_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  app.get("/ui/assets/providers.js", (c) =>
    c.body(PROVIDERS_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  // The Planner tab's script: the `:` picker of the run's directions in Tell the planner.
  app.get("/ui/assets/planner.js", (c) =>
    c.body(PLANNER_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  // The Copy panel's script, on a campaign's page (goal 069).
  app.get("/ui/assets/copy.js", (c) =>
    c.body(COPY_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  const newCampaignPage = (
    c: Ctx,
    extra: { draft?: Record<string, unknown>; errors?: string[] } = {},
  ) =>
    page(
      c,
      {
        title: "New campaign",
        active: "campaigns",
        crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
      },
      newCampaignBody({
        csrf: csrf(c),
        rigs: views(),
        access: store.gitAccessList(),
        // The MCP servers in Settings, for the kit's MCP servers block (goal 068).
        mcp: mcpServers.list(),
        models: store
          .providers()
          .filter((p) => p.models.length)
          .map((p) => ({
            group: p.name,
            options: p.models.map((m) => ({
              value: `${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`,
              label: `${modelPrefix(p.type)}${m.id}`,
              window: m.context_window ?? 0,
            })),
          })),
        // The Agents' context checks a window against each rig's agents' models (goal 070).
        agentModels: Object.fromEntries(views().map((u) => [u.id, ownModels(store, u.id)])),
        ...extra,
      }),
    );
  /** Git access for control's own lookups: the secret unsealed, host keys pinned per access. */
  const accessFor = (name: string | undefined) => {
    if (!name) return undefined;
    const g = store.gitAccess(name);
    if (!g) throw new Error(`no Git access named ${name}`);
    const secret = opts.secrets.open(g.secret_sealed);
    return {
      auth:
        g.kind === "ssh"
          ? ({ kind: "ssh", privateKey: secret } as const)
          : ({ kind: "token", token: secret, username: g.username ?? undefined } as const),
      knownHostsFile: join(opts.kits?.dir ?? tmpdir(), "..", "known_hosts", name),
    };
  };
  app.get("/ui/campaigns/new", (c) =>
    opts.kits ? newCampaignPage(c) : c.text("This control keeps no kits.", 404),
  );
  // The project's head at a ref and its paths (not its contents), for the page's suggestions:
  // a project in a folder of its repository gets that folder's paths.
  app.get("/ui/campaigns/new/probe", async (c) => {
    const url = c.req.query("url") ?? "";
    const ref = c.req.query("ref") || "HEAD";
    const folder = c.req.query("folder") || undefined;
    if (folder && !FolderSchema.safeParse(folder).success)
      return c.json(
        {
          error:
            "The folder is a path in the repository, such as examples/matmul-cpu/project: no / at either end, and no part that starts with a dot.",
        },
        400,
      );
    try {
      return c.json(
        await (opts.probeRepo ?? probeRepository)(
          url,
          ref,
          accessFor(c.req.query("access")),
          folder,
        ),
      );
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });
  // A kit uploaded on the page: unpacked and checked now, its archive kept beside the kit
  // repositories (never served to rigs: only <name>.git is) until a campaign uses it.
  const uploadsDir = () => join(opts.kits?.dir ?? "", "uploads");
  app.post("/ui/campaigns/new/kit", async (c) => {
    const f = await c.req.parseBody();
    const file = f.archive;
    if (!opts.kits) return c.json({ error: "This control keeps no kits." }, 404);
    if (!(file instanceof File)) return c.json({ error: "Choose a kit archive." }, 400);
    try {
      const archive = Buffer.from(await file.arrayBuffer());
      const k = await unpackKit(file.name, archive);
      mkdirSync(uploadsDir(), { recursive: true });
      writeFileSync(join(uploadsDir(), k.id), archive);
      writeFileSync(join(uploadsDir(), `${k.id}.name`), file.name);
      return c.json({ id: k.id, ...kitSummary(k.kit) });
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });
  /** An uploaded kit, unpacked again from its kept archive. */
  const uploaded = async (id: string) => {
    if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
    const p = join(uploadsDir(), id);
    if (!existsSync(p)) return undefined;
    return unpackKit(readFileSync(`${p}.name`, "utf8"), readFileSync(p));
  };
  // A kit in a repository: the MCP servers its kit.json names at that commit (goal 068), for
  // the page to show beside Settings' servers. Control reads kit.json alone.
  app.get("/ui/campaigns/new/kit-repo", async (c) => {
    try {
      const manifest = (await (opts.readKit ?? readKitManifest)(
        c.req.query("url") ?? "",
        c.req.query("commit") ?? "",
        accessFor(c.req.query("access") || undefined),
      )) as { name?: unknown; mcp_servers?: unknown };
      const uses = McpUses.safeParse(manifest?.mcp_servers ?? []);
      if (!uses.success)
        return c.json(
          { error: `kit.json's mcp_servers: ${uses.error.issues[0]?.message ?? "not valid"}` },
          400,
        );
      return c.json({
        name: typeof manifest.name === "string" ? manifest.name : null,
        mcp_servers: uses.data,
      });
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });
  // What a page sent back with mistakes shows again about the kit it had uploaded.
  app.get("/ui/campaigns/new/kit/:id", async (c) => {
    const k = await uploaded(c.req.param("id")).catch(() => undefined);
    if (!k) return c.json({ error: "The uploaded kit is gone: upload it again." }, 404);
    return c.json({ id: k.id, ...kitSummary(k.kit) });
  });
  app.post("/ui/campaigns/new", async (c) => {
    const f = await c.req.parseBody();
    if (!opts.kits) return c.text("This control keeps no kits.", 404);
    let draft: Record<string, unknown>;
    try {
      draft = JSON.parse(String(f.draft ?? "")) as Record<string, unknown>;
    } catch {
      return newCampaignPage(c, { errors: ["The page sent no answers: is its script blocked?"] });
    }
    const vs = views();
    const rig = vs.find((u) => u.id === String(f.rig ?? ""));
    if (!rig) return newCampaignPage(c, { draft, errors: ["Choose a rig for the first run."] });
    const target = rig.hardware?.target;
    if (!target)
      return newCampaignPage(c, {
        draft,
        errors: [`${rig.id} has not reported its hardware yet, so its target is unknown.`],
      });
    // The project pinned to a commit: control looks the ref up when the page did not.
    const project = draft.project as
      | { url?: string; ref?: string; commit?: string; folder?: unknown }
      | undefined;
    if (project?.url && !project.commit) {
      // A folder that is not a valid path is refused below, with the builder's own words.
      const folder = FolderSchema.safeParse(project.folder);
      try {
        project.commit = (
          await (opts.probeRepo ?? probeRepository)(
            project.url,
            project.ref || "HEAD",
            accessFor((project as { access?: string }).access),
            folder.success ? folder.data : undefined,
          )
        ).commit;
      } catch (err) {
        return newCampaignPage(c, {
          draft,
          errors: [`The project: ${errorText(err)}`],
        });
      }
    }
    const promotion = String(f.promotion ?? "");
    const askOwner = askOwnerFrom(f);
    if (typeof askOwner === "string") return newCampaignPage(c, { draft, errors: [askOwner] });
    const split = splitFor(rig, String(f.judge_gpus ?? ""));
    if (typeof split === "string") return newCampaignPage(c, { draft, errors: [split] });
    // The agents' model: given here, or the rig's; agents never start on a rig with none.
    let startValue = String(f.start_value ?? "start");
    const chosen = String(f.agents_model ?? "").trim();
    let modelNote = "";
    // Checked before the rig is given anything: OpenCode's free models work only in OpenCode.
    const researchModel =
      draft.mode === "research" && startValue === "start"
        ? opencodeOnlyModel(rig, chosen || undefined, String(f.agents_harness ?? ""))
        : undefined;
    if (researchModel)
      return newCampaignPage(c, { draft, errors: [researchNeedsOpencode(rig.id, researchModel)] });
    if (chosen) {
      const given = giveRigModel(
        rig.id,
        chosen,
        harnessKept(rig.id, chosen, String(f.agents_harness ?? "")),
      );
      if ("error" in given) return newCampaignPage(c, { draft, errors: [given.error] });
      const [, mRaw] = chosen.split("|");
      const model = decodeURIComponent(mRaw ?? "");
      // Not on the rig yet: it arrives within a minute. Starting now would fail the first trials.
      if (startValue === "start" && !sameModel(rig.model?.model, model)) {
        startValue = "save";
        modelNote = `${rig.id} takes ${model} within a minute. Settings › Providers shows the rig taking it until then; then start the run here.`;
      }
    }
    // Control gave the rig a model it has not taken yet: saved now, started once it has.
    const pending = store.rigModels()[rig.id];
    if (
      !chosen &&
      startValue === "start" &&
      pending &&
      !sameModel(rig.model?.model, pending.model)
    ) {
      startValue = "save";
      modelNote = `${rig.id} has not taken ${pending.model} yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then). Then start the run here.`;
    }
    if (!chosen && startValue === "start" && agentsModelMissing(rig))
      return newCampaignPage(c, {
        draft,
        errors: [
          `${rig.id} has no model for its agents, so they could not work: choose one under "The agents' model".`,
        ],
      });
    const uploadId = (draft.kit as { source?: string; upload?: string } | undefined)?.upload;
    const upload = uploadId ? await uploaded(uploadId).catch(() => undefined) : undefined;
    let r: Awaited<ReturnType<typeof startCampaign>>;
    try {
      r = await startCampaign(
        {
          store,
          kits: opts.kits,
          privateKeyPem: opts.privateKeyPem,
          uploads: (id) => (id === uploadId ? upload?.files : undefined),
          runpodRigs: opts.runpodRigs,
        },
        {
          draft,
          rig: rig.id,
          target: { type: target.type, class: target.class },
          start: startValue === "save" ? false : startValue === "try" ? "try" : true,
          promotion: promotion === "auto" || promotion === "owner_approval" ? promotion : undefined,
          askOwner,
          by: "owner:ui",
        },
      );
    } catch (err) {
      r = { ok: false, errors: [errorText(err)] };
    }
    if (!r.ok) return newCampaignPage(c, { draft, errors: r.errors });
    if (r.run && split !== undefined) sendSplit(rig.id, split);
    return c.redirect(
      r.run
        ? `${campaignHref(r.campaign)}?run=${encodeURIComponent(runKey(rig.id, r.run))}${r.woke ? `&ok=${encodeURIComponent(r.woke)}` : ""}`
        : modelNote
          ? `${campaignHref(r.campaign)}?ok=${encodeURIComponent(`Saved. ${modelNote}`)}`
          : campaignHref(r.campaign),
      303,
    );
  });

  /**
   * A rig whose agents' model works only inside OpenCode (OpenCode's free models) while its
   * research workers would run in Pi: a research run there could not work. From the model and
   * harness chosen now, else control's record, else the rig's report.
   */
  const opencodeOnlyModel = (u: RigView, chosen?: string, picked = ""): string | undefined => {
    let provider: ReturnType<typeof store.provider>;
    let model: string | undefined;
    let harness: Harness | undefined;
    if (chosen) {
      const [pRaw, mRaw] = chosen.split("|");
      provider = store.provider(decodeURIComponent(pRaw ?? ""));
      model = decodeURIComponent(mRaw ?? "");
      harness = harnessKept(u.id, chosen, picked);
    } else {
      const given = store.rigModels()[u.id];
      if (given) {
        provider = store.provider(given.provider);
        model = given.model;
        harness = given.harness;
      } else if (u.model?.model) {
        const fake = { type: "openai" as const, base_url: u.model.base_url ?? "" };
        return isOpencodeOwn(fake) &&
          u.model.model.endsWith("-free") &&
          u.model.harness !== "opencode"
          ? u.model.model
          : undefined;
      }
    }
    if (!provider || !model || !isOpencodeOwn(provider) || harness === "opencode") return undefined;
    return provider.type === "opencode" || !provider.key_sealed || model.endsWith("-free")
      ? model
      : undefined;
  };
  const researchNeedsOpencode = (rig: string, model: string) =>
    `${model} is one of OpenCode's free models, which work only inside OpenCode, and ${rig}'s agents would run in Pi: a research run there could not work. Set the agents' harness to OpenCode, or give the rig a model Pi can use.`;
  /** A rig whose agents have no model: none from control, and the rig reports none. */
  const agentsModelMissing = (u: RigView) => !store.rigModels()[u.id] && u.model?.source === "none";
  /**
   * The harness a model needs when the owner leaves it to control: Claude Code for a Claude
   * subscription, OpenCode for OpenCode's free models, else Pi (a ChatGPT sign-in too, unless the
   * owner picks Codex).
   */
  const harnessFor = (choice: string, picked: string): Harness => {
    if (picked === "opencode" || picked === "pi" || picked === "codex") return picked;
    const [pRaw, mRaw] = choice.split("|");
    const p = store.provider(decodeURIComponent(pRaw ?? ""));
    return p ? neededHarness(p, decodeURIComponent(mRaw ?? "")) : "pi";
  };
  /**
   * The harness to give a rig with a model, when the owner names none (New campaign and Start a
   * run): the rig's own when control gave it this model already, so a rig on Codex or OpenCode
   * stays there; else what the model needs (harnessFor).
   */
  const harnessKept = (rig: string, choice: string, picked: string): Harness => {
    if (picked) return harnessFor(choice, picked);
    const [pRaw, mRaw] = choice.split("|");
    const had = store.rigModels()[rig];
    return had &&
      had.provider === decodeURIComponent(pRaw ?? "") &&
      had.model === decodeURIComponent(mRaw ?? "")
      ? had.harness
      : harnessFor(choice, "");
  };
  /**
   * The GPU split a campaign's deployment asks for on its rig (a rig is a set of GPUs; what is
   * deployed on it decides how they are used): undefined when it asks for none or the rig has it
   * already, the number to send, or why it can't be.
   */
  const splitFor = (rig: RigView, raw: string): number | string | undefined => {
    if (!raw.trim()) return undefined;
    const judge = Number(raw);
    const g = rig.gpu_split;
    if (!g || g.set < 2)
      return `${rig.id} has no GPU set to split: its GPUs are set where it is deployed.`;
    const top = Math.min(8, g.set - 1);
    if (!Number.isInteger(judge) || judge < 1 || judge > top || g.set - judge > 8)
      return `With ${g.set} GPUs the judge takes 1 to ${top} of them, and the agents at most 8.`;
    return judge === g.judge ? undefined : judge;
  };
  /** Sends the rig its new GPU split, signed for the owner; the rig restarts its harness to apply it. */
  const sendSplit = (rig: string, judge: number, by = "owner:ui") =>
    issueCommand(store, opts.privateKeyPem, {
      rig,
      kind: "rig_settings",
      payload: { judge_gpus: judge },
      issuedBy: by,
    });

  // ---------------------------------------------------------------- another run of a campaign
  /** Rigs for the Start a run panel: hardware, whether the campaign's kit fits, busy, the model. */
  const startRigs = (campaign: string, vs: RigView[]): StartRig[] => {
    const want =
      (store.campaignVersions(campaign)[0]?.contract as { target?: { type?: string } } | undefined)
        ?.target?.type ??
      (
        store.latestAssignments().get(campaign)?.payload.contract as
          | { target?: { type?: string } }
          | undefined
      )?.target?.type;
    const given = store.rigModels();
    return vs.map((u) => {
      const t = u.hardware?.target?.type;
      const busy = u.runs.find((r) => r.status === "running");
      return {
        id: u.id,
        hardware: u.hardware ? hardwareLine(u.hardware) : t ? t : "",
        off:
          want && t && t !== want
            ? `Other hardware: this campaign is measured on ${want}, this rig on ${t}.`
            : undefined,
        busy: busy ? busy.id : undefined,
        stale: u.stale,
        stopped: podStopped(u),
        model:
          given[u.id]?.model ??
          (u.model?.source !== "none" ? (u.model?.model ?? undefined) : undefined),
      };
    });
  };
  /** Whether control can start a run of a campaign: a saved version, or an earlier assignment. */
  const startFrom = (campaign: string): string | undefined => {
    const v = store.campaignVersions(campaign)[0];
    // A copy of a campaign known only by an assignment takes that assignment's imports: no kit here.
    if (v && (opts.kits || v.sources.assignment))
      return `Control signs an assignment of version ${v.version} (saved ${esc(ago(v.created_at, Date.now()))} ago) to the rig; the rig fetches the project and the kit, checks both, and starts the run.`;
    const past = store.latestAssignments().get(campaign);
    if (past)
      return `Control assigns the campaign again as it assigned ${esc(past.run)} on ${esc(past.rig)}: the same contract, starting point and imports, as a new run.`;
    return undefined;
  };
  /** Past research a new run of a campaign can start from: its readable folders' newest matches. */
  const pastResults = (campaign: string, q: string) => {
    const kb = store.kb();
    return kb.search(q, kb.readable(campaign), {
      kinds: (Object.keys(PICKABLE) as KbKind[]).filter((k) => PICKABLE[k]),
      limit: 40,
    });
  };
  /**
   * Start a run's rigs with what the campaign's Agents' context gives their workers (goal 070):
   * each one's note, its line when chosen, and whether control refuses the run there.
   */
  const startContext = (campaign: string, rigs: StartRig[]): StartRig[] => {
    if (isRigCheck(campaign)) return rigs;
    const contract = campaignContract(store, campaign) as { mode?: unknown } | undefined;
    const ctx = contractContext(contract);
    return rigs.map((r) => {
      if (r.off) return r;
      const now = rigContext(ownModels(store, r.id, contract?.mode), ctx);
      const note = startNote(now);
      return {
        ...r,
        context: {
          note: note.text,
          refused: note.bad,
          line: startLine(campaign, r.id, now, Boolean(ctx)),
        },
      };
    });
  };
  const startPanel = (c: Ctx, campaign: string, vs: RigView[], open: boolean) => {
    const from = startFrom(campaign);
    // An archived campaign starts no run (goal 077): its page offers Unarchive instead.
    if (!from || store.campaignArchived(campaign)) return "";
    const kb = store.kb();
    const pastQ = (c.req.query("past") ?? "").slice(0, 300);
    return startDrawer({
      past: pastSection({
        campaign,
        readable: kb.readable(campaign),
        q: pastQ,
        results: pastResults(campaign, pastQ),
        result: (x) => kb.resultOf(x),
      }),
      campaign,
      csrf: csrf(c),
      open,
      rigs: startContext(campaign, startRigs(campaign, vs)),
      models: store
        .providers()
        .filter((p) => p.models.length)
        .map((p) => ({
          group: p.name,
          options: p.models.map((m) => ({
            value: `${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`,
            label: `${modelPrefix(p.type)}${m.id}`,
          })),
        })),
      from,
      copyFrom: campaignViews(vs)
        .find((k) => k.name === campaign)
        ?.runs.map((x) => {
          const up = x.run.queue.filter((q) => q.state === "queued").length;
          const ideas = x.run.queue.filter((q) => q.state === "proposed").length;
          return { x, up, ideas };
        })
        .filter((y) => y.up + y.ideas > 0)
        .sort((a, b) => lastActivity(b.x.run).localeCompare(lastActivity(a.x.run)))
        .map(({ x, up, ideas }) => ({
          key: runKey(x.rig.id, x.run.id),
          label: `${x.run.id} (${up} up next${ideas ? `, ${ideas} lane idea${ideas === 1 ? "" : "s"}` : ""})`,
        })),
      // A judge-only run's queue links here with itself chosen (goal 099).
      copyPick: c.req.query("copy"),
    });
  };
  /**
   * Start a run: what the panel's form below, REST's POST /v1/campaigns/<name>/runs, MCP's
   * start_run and `thermite run start` all do (actions.startRun), with the same checks and the
   * same refusals in words. `by` is who asks; `owner`, whether the owner's token asks, which alone
   * starts a stopped RunPod pod.
   */
  const startARun = async (
    req: StartRunRequest,
    by: string,
    owner: boolean,
  ): Promise<StartRunOutcome> => {
    const refuse = (error: string, status: 400 | 404 | 409 = 409): StartRunOutcome => ({
      state: "refused",
      error,
      status,
    });
    const { campaign, agents } = req;
    if (!startFrom(campaign))
      return refuse("Control has no saved version or earlier assignment of this campaign.", 404);
    const vs = views();
    const rig = vs.find((u) => u.id === req.rig);
    if (!rig)
      return req.rig
        ? refuse(`No rig is called ${req.rig}. Choose a rig.`, 404)
        : refuse("Choose a rig.", 400);
    // The panel shows these only with agents on; a try (agents off) has no agents and no queue.
    if (!agents && (req.model || req.queueFrom || req.past?.length))
      return refuse(
        "A try (agents off) takes no model, no experiments and no background: leave them out, or start the run with agents.",
        400,
      );
    const chosen = req.model
      ? `${encodeURIComponent(req.model.provider)}|${encodeURIComponent(req.model.model)}`
      : "";
    const mode =
      (store.campaignVersions(campaign)[0]?.contract as { mode?: string } | undefined)?.mode ??
      (store.latestAssignments().get(campaign)?.payload.contract as { mode?: string } | undefined)
        ?.mode;
    const researchModel =
      mode === "research" && agents ? opencodeOnlyModel(rig, chosen || undefined) : undefined;
    if (researchModel) return refuse(researchNeedsOpencode(rig.id, researchModel));
    if (agents && req.model) {
      // The rig gets the model first; it arrives within a minute, and the run starts after that.
      const given = giveRigModel(rig.id, chosen, harnessKept(rig.id, chosen, ""), undefined, by);
      if ("error" in given) return refuse(given.error, 400);
      const model = req.model.model;
      if (!sameModel(rig.model?.model, model))
        return {
          state: "model_given",
          said: `${rig.id} takes ${model} within a minute; Settings › Providers shows it taking the model until then. Then start the run again.`,
        };
    }
    // Control gave the rig a model it has not taken yet: the agents would start with none.
    const given = store.rigModels()[rig.id];
    if (agents && !req.model && given && !sameModel(rig.model?.model, given.model))
      return refuse(
        `${rig.id} has not taken ${given.model} yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that.`,
      );
    if (agents && !req.model && agentsModelMissing(rig))
      return refuse(
        `${rig.id} has no model for its agents, so they could not work: choose one under "The agents' model", or give it one on its Edit rig page.`,
      );
    const split = splitFor(rig, String(req.judgeGpus ?? ""));
    if (typeof split === "string") return refuse(split, 400);
    // From past research (goal 065): only items of folders this campaign may read, looked up
    // here by id. Experiments join the queue; findings, claims, notes and reports brief the agents.
    const kb = store.kb();
    const readable = new Set(kb.readable(campaign));
    const picked = (req.past ?? []).map((x) => kb.item(x));
    if (picked.some((x) => !x || !readable.has(x.campaign) || !PICKABLE[x.kind]))
      return refuse(
        "An item from past research is not one this campaign may read and start from: search again.",
        400,
      );
    const past = picked.filter((x): x is KbItem => x !== undefined);
    const pastQueue = past
      .filter((x) => PICKABLE[x.kind] === "queue")
      .map((x) => queueSeedOf(x, kb.resultOf(x)))
      .filter((x): x is QueueSeed => x !== undefined);
    const briefing = past
      .filter((x) => PICKABLE[x.kind] === "briefing")
      .map(briefingSeedOf)
      .filter((x): x is BriefingSeed => x !== undefined);
    // The untried experiments of another run of this campaign, as the panel lists them.
    const notes: string[] = [];
    let copied: QueueSeed[] = [];
    if (req.queueFrom) {
      const { rig: on, run } = req.queueFrom;
      const from = vs
        .find((u) => u.id === on)
        ?.runs.find((r) => r.id === run && r.campaign === campaign);
      if (!from)
        return refuse(
          `${on} has no run ${run} of ${campaign}: copy from a run of this campaign.`,
          404,
        );
      copied = untriedOf(from);
      if (!copied.length)
        notes.push(`${run} on ${on} has no untried experiments: the new run's queue starts empty.`);
    }
    const busy = rig.runs.find((r) => r.status === "running");
    let r: Awaited<ReturnType<typeof startRun>>;
    try {
      r = await startRun(
        {
          store,
          kits: opts.kits as KitRepos,
          privateKeyPem: opts.privateKeyPem,
          runpodRigs: opts.runpodRigs,
        },
        {
          campaign,
          rig: rig.id,
          target: rig.hardware?.target
            ? { type: rig.hardware.target.type, class: rig.hardware.target.class }
            : undefined,
          agents,
          promotion: req.promotion,
          askOwner: req.askOwner,
          by,
          owner,
          // A command carries at most 500 experiments.
          queue:
            copied.length + pastQueue.length ? [...copied, ...pastQueue].slice(0, 500) : undefined,
          briefing: briefing.length ? briefing : undefined,
        },
      );
    } catch (err) {
      r = { ok: false, errors: [errorText(err)] };
    }
    if (!r.ok) return refuse(r.errors.join(" "));
    if (split !== undefined) sendSplit(rig.id, split, by);
    // The campaign's own context settings, and what each agent works with on this rig (goal 070).
    const context = agents
      ? contextApplies(store, rig.id, campaignContract(store, campaign))
      : undefined;
    if (context) notes.push(contextAppliesWords(context, rig.id));
    return {
      state: "started",
      campaign,
      rig: rig.id,
      run: r.run,
      command: r.command,
      woke: r.woke,
      pauses: busy?.id,
      notes,
      ...(context ? { context } : {}),
    };
  };
  if (opts.actions) opts.actions.startRun = startARun;
  // Copy a campaign (goal 069): the Copy panel on its page, REST, MCP and the command line.
  const copyACampaign = (req: CopyCampaignRequest, by: string) =>
    copyCampaign(store, req, by, campaignModes(store, views()));
  if (opts.actions) opts.actions.copyCampaign = copyACampaign;
  /** Who copied a campaign, as its page says it: the dashboard is the owner's, so "you". */
  const copiedBy = (by: string) =>
    by === "owner:operator"
      ? "the operator"
      : by === "owner" || by.startsWith("owner:")
        ? "you"
        : by;
  /** A copy's line on its page: where it came from, who copied it and when. */
  const copiedLine = (name: string): string => {
    const first = store.campaignVersions(name).at(-1);
    const f = first?.copied_from;
    if (!first || !f) return "";
    const now = Date.now();
    const when =
      now - Date.parse(first.created_at) < 60_000
        ? "just now"
        : `${ago(first.created_at, now)} ago`;
    return `<div class="card" style="margin-bottom:16px"><span class="muted">Copied from</span> <a href="${campaignHref(f.campaign)}">${esc(copiedFromWords(f))}</a> <span class="muted">by ${esc(copiedBy(first.created_by))}, ${esc(when)}. Its folder in the knowledge base started empty.${f.other_mcp_servers ? ` ${esc(copiedMcpWords(first.contract))}` : ""}</span></div>`;
  };
  /**
   * What a copy of a campaign takes, as copyCampaign takes it: whether it is research, what it
   * copies in words, and the servers its agents use. Undefined: control can't copy it.
   */
  const copySource = (name: string) => {
    if (isRigCheck(name)) return undefined;
    const saved = store.campaignVersions(name)[0];
    const assigned = saved ? undefined : store.latestAssignments().get(name);
    if (!saved && !assigned) return undefined;
    const contract = (saved?.contract ?? assigned?.payload.contract) as
      | { mode?: unknown }
      | undefined;
    return {
      research: contract?.mode === "research",
      what: saved
        ? `version ${saved.version} of ${name}`
        : copiedFromWords({ campaign: name, rig: assigned?.rig, run: assigned?.run }),
      servers: campaignMcpServers(store, name) ?? [],
    };
  };
  /**
   * The names a copy may not take (every campaign control knows, and each a grant names), and
   * of those, the ones only the knowledge base knows, which the panel names as such.
   */
  const copyNames = (vs: RigView[]) => {
    const taken = [
      ...new Set([...campaignModes(store, vs).keys(), ...store.kb().grantNames()]),
    ].sort();
    const ran = new Set([
      ...campaignViews(vs).map((k) => k.name),
      ...store.campaignVersions().map((v) => v.campaign),
      ...store.latestAssignments().keys(),
    ]);
    return { taken, folderOnly: taken.filter((n) => !ran.has(n)) };
  };
  /** The Copy panel of a campaign's page, or "" for a campaign control can't copy. */
  const copyPanel = (c: Ctx, name: string, vs: RigView[], tried?: CopyTry) => {
    const src = copySource(name);
    if (!src) return "";
    const names = copyNames(vs);
    return copyDrawer({
      campaign: name,
      research: src.research,
      what: src.what,
      csrf: csrf(c),
      open: tried !== undefined || c.req.query("copy") === "1",
      name: tried?.name ?? suggestCopyName(name, new Set(names.taken)),
      taken: names.taken,
      folderOnly: names.folderOnly,
      servers: mcpServers.list(),
      source: src.servers,
      picked: tried?.picked,
      error: tried?.error,
      context: contractContext(campaignContract(store, name)),
      typed: tried?.context,
    });
  };
  /**
   * A campaign's buttons at the top of its page: Copy, then Start a run, as control can, then ⋯
   * with Move to folder and Archive (goal 077). An archived campaign starts no run: its ⋯ has
   * Unarchive.
   */
  const campaignActions = (c: Ctx, name: string) => {
    const archived = store.campaignArchived(name);
    const hidden = `<input type="hidden" name="csrf" value="${esc(csrf(c))}">`;
    const folders = store.campaignFolders();
    const here = store.campaignFolderOf(name);
    const move = folders.length
      ? `<form class="sfd" method="post" action="${campaignHref(name)}/folder">${hidden}${infoLabel("Move to folder", archived ? "The folder this campaign keeps while it is archived, and comes back into when you unarchive it. Its runs, results and folder in the knowledge base do not change." : "Where this campaign shows in the left navigation. You can also drag it there. Its runs, results and folder in the knowledge base do not change.")}<span class="kmove"><select name="folder" aria-label="Folder"><option value=""${here ? "" : " selected"}>No folder</option>${folders.map((f) => `<option value="${f.id}"${f.id === here?.id ? " selected" : ""}>${esc(f.name)}</option>`).join("")}</select><button class="sm">Move</button></span></form>`
      : `<div class="sfd">${infoLabel("Move to folder", "Where this campaign shows in the left navigation. Make a folder with the folder button beside Campaigns there.")}<span class="muted small">No folder yet: make one with the folder button beside Campaigns in the navigation.</span></div>`;
    const more = `<details class="menu" data-campaign-more><summary class="btn" title="More" aria-label="More">${icon.dots}</summary><div class="menu-pop kmore-pop">${
      archived
        ? `${move}<div class="fsep"></div><form method="post" action="${campaignHref(name)}/unarchive">${hidden}<button class="sm">Unarchive</button></form><span class="muted small">It comes back to the navigation, ${here ? `in ${esc(here.name)}` : "in no folder"}.</span>`
        : `${move}<div class="fsep"></div><form method="post" action="${campaignHref(name)}/archive">${hidden}<button class="sm">${icon.archive}Archive</button></form><span class="muted small">Out of the navigation, Needs you and the Overview. Its runs, results and kits stay.</span>`
    }</div></details>`;
    return `${copySource(name) ? `<a class="btn" href="${campaignHref(name)}?copy=1" data-open="#copy">${icon.copy}Copy</a>` : ""}${!archived && startFrom(name) ? `<a class="btn primary" href="${campaignHref(name)}?start=1" data-open="#start">${icon.play}Start a run</a>` : ""}${more}`;
  };
  /** An archived campaign's line at the top of its page, with Unarchive. */
  const archivedLine = (c: Ctx, name: string) => {
    const a = store.campaignArchived(name);
    if (!a) return "";
    const folder = store.campaignFolderOf(name);
    return `<div class="card" style="margin-bottom:16px"><b>${icon.archive} Archived</b> ${esc(ago(a.at, Date.now()))} ago by ${esc(copiedBy(a.by))}. <span class="muted">It is out of the navigation, Needs you and the Overview. Its runs, results and kits stay${folder ? `, and it keeps its folder, ${esc(folder.name)}` : ""}. Control starts no run of it until you unarchive it.</span> <form class="inline" method="post" action="${campaignHref(name)}/unarchive"><input type="hidden" name="csrf" value="${esc(csrf(c))}"><button class="sm">Unarchive</button></form></div>`;
  };
  // The Copy panel's form: the copy's page, or the panel again with control's words.
  app.post("/ui/campaigns/:campaign/copy", async (c) => {
    const from = c.req.param("campaign");
    const src = copySource(from);
    const f = await c.req.parseBody({ all: true });
    const one = (k: string) => {
      const v = [f[k] ?? []].flat()[0];
      return typeof v === "string" ? v.trim() : "";
    };
    const name = one("name");
    let picked: McpUse[] | undefined;
    let mcp: McpUse[] | undefined;
    let problems: string[] = [];
    // A research copy's servers, as ticked: sent to control only when they are not the source's.
    if (src?.research && one("mcp") === "1") {
      const tools = new Map(
        mcpServers.list().map((s) => [s.name, s.tools ? s.tools.map((t) => t.name) : null]),
      );
      const p = postedUses(f, tools, src.servers);
      picked = p.uses;
      problems = p.problems;
      if (!sameUses(p.uses, src.servers)) mcp = p.uses;
    }
    // The copy's Agents' context (goal 070): sent only when it is not the source's.
    const typed = { cw: one("context_window"), ca: one("compact_at") };
    let agentsContext: CopyCampaignRequest["agents_context"];
    if ("context_window" in f || "compact_at" in f) {
      const cw = postedNumber(typed.cw, false);
      const at = postedNumber(typed.ca, true);
      if (Number.isNaN(cw)) problems.push("Write the number of tokens in digits, such as 131072.");
      else if (Number.isNaN(at))
        problems.push(compactAtRefusal(0) ?? "The compaction point is not valid.");
      else {
        const source = contractContext(campaignContract(store, from));
        if (cw !== source?.context_window || at !== source?.compact_at)
          agentsContext =
            cw || at
              ? { ...(cw ? { context_window: cw } : {}), ...(at ? { compact_at: at } : {}) }
              : null;
      }
    }
    const out: CopyCampaignOutcome = problems.length
      ? { state: "refused", error: problems.join(" "), status: 400 }
      : copyACampaign({ from, name, mcp_servers: mcp, agents_context: agentsContext }, "owner:ui");
    if (out.state === "copied")
      return c.redirect(
        `${campaignHref(out.campaign)}?ok=${encodeURIComponent(`Copied ${copiedFromWords(out.from)} as ${out.campaign}.${agentsContext !== undefined ? ` Agents' context: ${contextShort(out.context)}.` : ""}`)}`,
        303,
      );
    if (!src) return c.text(out.error, out.status);
    return campaignPage(c, { name, picked, error: out.error, context: typed });
  });
  app.post("/ui/campaigns/:campaign/runs", async (c) => {
    const f = await c.req.parseBody();
    const campaign = c.req.param("campaign");
    const back = (m: string) =>
      c.redirect(`${campaignHref(campaign)}?start=1&error=${encodeURIComponent(m)}`, 303);
    const agents = String(f.agents ?? "on") !== "off";
    const promotion = String(f.promotion ?? "");
    const askOwner = askOwnerFrom(f);
    if (typeof askOwner === "string") return back(askOwner);
    const choice = String(f.agents_model ?? "").trim();
    let model: StartRunRequest["model"];
    if (choice) {
      const [p, m] = choice.split("|");
      try {
        model = { provider: decodeURIComponent(p ?? ""), model: decodeURIComponent(m ?? "") };
      } catch {
        // A malformed choice names no provider's model: refused as one.
        model = { provider: "", model: "" };
      }
    }
    const key = String(f.copy_from ?? "");
    const slash = key.indexOf("/");
    const pastIds = [(await c.req.parseBody({ all: true })).past ?? []].flat().map(Number);
    const out = await startARun(
      {
        campaign,
        rig: String(f.rig ?? ""),
        agents,
        // The model, the copy box and past research show only with agents on: for a try they
        // are left out, whatever the form sent.
        model: agents ? model : undefined,
        promotion: promotion === "auto" || promotion === "owner_approval" ? promotion : undefined,
        askOwner,
        judgeGpus: String(f.judge_gpus ?? ""),
        queueFrom:
          agents && String(f.copy_queue ?? "") === "1" && slash > 0
            ? { rig: key.slice(0, slash), run: key.slice(slash + 1) }
            : undefined,
        past: agents ? pastIds : undefined,
      },
      "owner:ui",
      true,
    );
    if (out.state === "refused")
      return out.status === 404 && !startFrom(campaign) ? c.text(out.error, 404) : back(out.error);
    if (out.state === "model_given")
      return c.redirect(`${campaignHref(campaign)}?ok=${encodeURIComponent(out.said)}`, 303);
    // A try takes no queue and no briefing: say so when the owner ticked past research it showed
    // (the page hides it for a try, and sends none of it; without the page's script it shows).
    const notes = [
      out.woke ?? "",
      ...out.notes,
      !agents && pastIds.length
        ? "A try (agents off) takes no experiments and no background: what you ticked was left out."
        : "",
    ].filter(Boolean);
    const leftOut = notes.length ? `&ok=${encodeURIComponent(notes.join(" "))}` : "";
    return c.redirect(
      `${campaignHref(campaign)}?run=${encodeURIComponent(runKey(out.rig, out.run))}${leftOut}`,
      303,
    );
  });

  /** A run at work as a card: its brief, then Live, Message and Pause. */
  const workCardFor = (
    c: Ctx,
    u: RigView,
    r: RunView,
    now: number,
    waiting: number,
    back: string,
  ) =>
    workCard(
      runBrief(store, u, r, now, { heading: true }),
      // A run without agents (a try, a rig check) has no one to message.
      `<a class="btn sm" href="${runLiveHref(u.id, r.id)}">${icon.terminal}Live</a>${r.has_agents === false ? "" : `<a class="btn sm" href="${runLiveHref(u.id, r.id, "&compose=1")}">Message</a>`}${pauseMenu(c, u.id, r.id, back, "sm ghost")}`,
      waiting,
    );

  /**
   * How each goal of a goal campaign is really checked (goal 082), and where that comes from: a
   * run's own rig report first; then the kit control keeps, at the contract's commit; then, for
   * a campaign's page, the newest run whose rig reported it; else what the contract says. Undefined
   * when control has no goal contract for the campaign and no rig reported its checks.
   */
  const goalChecksFor = (
    name: string,
    vs: RigView[],
    rig?: string,
    run?: RunView,
  ): { checks: GoalChecks; source: ChecksSource } | undefined => {
    if (rig && run?.goal_checks) return { checks: run.goal_checks, source: { from: "rig", rig } };
    const v = store.campaignVersions(name)[0];
    const raw = v?.contract ?? store.latestAssignments().get(name)?.payload.contract;
    const parsed = raw ? parseContract(raw) : undefined;
    const contract = parsed?.ok && parsed.contract.mode === "goal" ? parsed.contract : undefined;
    const ref = contract?.project.kit;
    const kept = v?.sources.kit !== undefined && "control" in v.sources.kit;
    if (contract && ref && kept && opts.kits) {
      const kit = KitSchema.safeParse(opts.kits.manifest(ref.repo, ref.commit));
      if (kit.success)
        return {
          checks: goalChecks(contract, { kit: kit.data, repo: ref.repo, commit: ref.commit }),
          source: { from: "control" },
        };
    }
    if (!run) {
      const reported = vs
        .flatMap((u) => u.runs.map((r) => ({ u, r })))
        .filter((x) => (x.r.campaign || x.r.id) === name && x.r.goal_checks)
        .sort((a, b) => (b.r.created_at ?? "").localeCompare(a.r.created_at ?? ""))[0];
      if (reported?.r.goal_checks)
        return { checks: reported.r.goal_checks, source: { from: "rig", rig: reported.u.id } };
    }
    if (!contract) return undefined;
    return {
      checks: goalChecks(contract),
      source: {
        from: "contract",
        why: kept
          ? "Control can't read its copy of this campaign's kit at the contract's commit, so the cases' parameters and time limits are not shown."
          : "Control keeps no copy of this campaign's kit, which is in its repository, and no rig has reported its checks yet, so the cases' parameters and time limits are not shown.",
      },
    };
  };

  /** What a campaign is for, from its contract on control: its title, topic or objective. */
  const aboutOf = (name: string): string => {
    const contract = (store.campaignVersions(name)[0]?.contract ??
      store.latestAssignments().get(name)?.payload.contract) as
      | { title?: string; topic?: string; objective?: { description?: string } }
      | undefined;
    return contract?.title ?? contract?.topic ?? contract?.objective?.description ?? "";
  };

  // ---------------------------------------------------------------- the knowledge base (goal 065)
  /** A campaign's mode in words, for folders: hill climb, goal, research or rig check. */
  const modeWords =
    (modes: Map<string, string | null>) =>
    (name: string): string =>
      isRigCheck(name) ? "rig check" : modeName(modes.get(name) ?? null) || "campaign";
  /** A run's page, when a rig reports the run now (an item's run may be gone after a reset). */
  const runLinks = (vs: RigView[]) => {
    const live = new Map(
      vs.flatMap((u) => u.runs.map((r) => [runKey(u.id, r.id), runHref(u.id, r)] as const)),
    );
    return (rig: string, run: string) => live.get(runKey(rig, run));
  };
  /** A campaign's Knowledge section: its folder, the folders it reads, who reads it. */
  const knowledgeSection = (c: Ctx, name: string, vs: RigView[], error?: string) => {
    const kb = store.kb();
    const folders = kb.folders();
    const have = new Set(folders.map((f) => f.campaign));
    const modes = campaignModes(store, vs);
    return campaignKnowledge({
      campaign: name,
      folder: kb.folder(name, folders),
      folders: [
        ...folders,
        // Campaigns with no folder yet can be granted too: their items come as their runs report.
        ...[...modes.keys()].filter((x) => !have.has(x)).map((x) => kb.folder(x, folders)),
      ],
      mode: modeWords(modes),
      csrf: csrf(c),
      now: Date.now(),
      error,
    });
  };

  // ---------------------------------------------------------------- a campaign's agents' context
  // Goal 070: a campaign's own context window and compaction point for all its runs' agents, kept
  // in its contract (campaign-context.ts). Its page shows the two fields and what applies on each
  // rig that can run it; Save makes a new version, as set_campaign_context does.
  /** The rigs that can run a campaign, each with its agents' own models and what applies there. */
  const contextRigs = (
    name: string,
    vs: RigView[],
    ctx: AgentsContext | undefined,
    mode: unknown,
  ): ContextRig[] =>
    startRigs(name, vs)
      .filter((r) => !r.off)
      .map((r) => {
        const own = ownModels(store, r.id, mode);
        return { id: r.id, own, now: rigContext(own, ctx) };
      });
  /**
   * The campaign's Experiment queue block (goal 081): its target queue depth, the ideas kept
   * ready, from its newest contract. None for a rig check, a research campaign (its research
   * plan fills its queue) or a campaign with no contract.
   */
  const queueTargetSection = (name: string) => {
    if (isRigCheck(name)) return "";
    const contract = campaignContract(store, name) as
      | { mode?: unknown; lanes?: { count?: unknown; queue_target?: unknown } }
      | undefined;
    if (!contract || contract.mode === "research") return "";
    const count = Number(contract.lanes?.count) || 2;
    const own = contract.lanes?.queue_target;
    const lanes = {
      count,
      ...(typeof own === "number" ? { queue_target: own } : {}),
    };
    return `<div class="block" id="queue-target"><div class="head"><h2>Experiment queue</h2><span class="right">every run of ${esc(name)}</span></div>
<div class="card"><div>${infoLabel("Ideas kept ready", QUEUE_TARGET_TIP)} <b>${queueTarget({ lanes })}</b> <span class="muted">(${esc(queueTargetNote({ lanes }))})</span></div>
<div class="muted small">Set it in New campaign, or as <code>lanes.queue_target</code> in the campaign's contract. A run's Live view says when its queue falls below it, and the teachers are then asked for ideas at once.</div></div></div>`;
  };
  /** The campaign's Agents' context block; none for a rig check, or a campaign with no contract. */
  const contextSection = (c: Ctx, name: string, vs: RigView[], said: boolean) => {
    if (isRigCheck(name)) return "";
    const contract = campaignContract(store, name) as { mode?: unknown } | undefined;
    if (!contract) return "";
    const ctx = contractContext(contract);
    const error = said ? c.req.query("error") : undefined;
    return contextBlock({
      campaign: name,
      csrf: csrf(c),
      context: ctx,
      // After a refusal, the fields show what was typed: control checks it again on Save.
      typed: error ? { cw: c.req.query("cw") ?? "", at: c.req.query("ca") ?? "" } : undefined,
      rigs: contextRigs(name, vs, ctx, contract.mode),
      error,
      ok: said ? c.req.query("ok") : undefined,
    });
  };
  app.get("/ui/assets/campaign-context.js", (c) =>
    c.body(CAMPAIGN_CONTEXT_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  /** A campaign's numbers in a few words: "131,072 tokens at 70%". */
  const contextShort = (ctx: AgentsContext | undefined) => {
    const w = ctx?.context_window;
    const at = ctx?.compact_at;
    return w && at
      ? `${w.toLocaleString("en-US")} tokens at ${at}%`
      : w
        ? `${w.toLocaleString("en-US")} tokens`
        : at
          ? `compact at ${at}%`
          : "the rig's, for each agent";
  };
  /** A field of the Agents' context as posted: undefined when empty, NaN when not digits. */
  const postedNumber = (v: unknown, pct: boolean) => {
    let t = String(v ?? "")
      .trim()
      .replace(/[,_\s]/g, "");
    if (pct) t = t.replace(/%$/, "");
    return !t ? undefined : /^\d+$/.test(t) ? Number(t) : Number.NaN;
  };
  app.post("/ui/campaigns/:campaign/context", async (c) => {
    const campaign = c.req.param("campaign");
    const f = await c.req.parseBody();
    const raw = { cw: String(f.context_window ?? ""), ca: String(f.compact_at ?? "") };
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(
        `${campaignHref(campaign)}?on=context&${k}=${encodeURIComponent(m)}${k === "error" ? `&cw=${encodeURIComponent(raw.cw)}&ca=${encodeURIComponent(raw.ca)}` : ""}#agents-context`,
        303,
      );
    const contextWindow = postedNumber(raw.cw, false);
    const compactAt = postedNumber(raw.ca, true);
    if (Number.isNaN(contextWindow))
      return back("error", "Write the number of tokens in digits, such as 131072.");
    if (Number.isNaN(compactAt))
      return back("error", compactAtRefusal(0) ?? "The compaction point is not valid.");
    const out = setCampaignContext(store, { campaign, contextWindow, compactAt }, "owner:ui");
    if (out.state === "refused")
      return out.status === 404 ? c.text(out.error, 404) : back("error", out.error);
    if (out.state === "unchanged")
      return back("ok", `Nothing changed: version ${out.version} has these numbers already.`);
    const atWork = (campaignViews(views()).find((k) => k.name === campaign)?.runs ?? [])
      .filter((x) => x.run.status === "running")
      .map((x) => x.run.id);
    return back(
      "ok",
      `Saved as version ${out.version}: ${contextShort(out.context)}. New runs of ${campaign} take it.${atWork.length ? ` ${listText(atWork)} ${atWork.length === 1 ? "keeps what it" : "keep what they"} started with.` : ""}`,
    );
  });

  /**
   * A campaign's page: what it is for, its runs, its Knowledge section, and the Start a run and
   * Copy panels; or one run's page. `tried`: a Copy that control refused, to show in the panel.
   */
  const campaignPage = (c: Ctx, tried?: CopyTry) => {
    const now = Date.now();
    const vs = views();
    // Its own route's, or the Copy panel's form's (/ui/campaigns/:campaign/copy).
    const name = String(c.req.param("campaign") ?? "");
    const k = campaignViews(vs).find((x) => x.name === name);
    // A refused grant shows in the Knowledge section, not as a run that did not start.
    const kbFailed = c.req.query("on") === "kb" ? c.req.query("error") : undefined;
    // So does what the Agents' context's Save did, in its own block.
    const onContext = c.req.query("on") === "context";
    // Archive and Move to folder (on=shelf) say what they refused at the top of every page.
    const failed =
      kbFailed || onContext || c.req.query("on") === "shelf" ? undefined : c.req.query("error");
    const okNote = onContext ? undefined : c.req.query("ok");
    const context = () => contextSection(c, name, vs, onContext);
    // The campaign's brief from its contract (goal 078): what its agents know.
    const brief = () => (isRigCheck(name) ? "" : campaignBriefBlock(campaignContract(store, name)));
    const note = `${
      failed
        ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not started.</b> ${esc(failed)}</div>`
        : okNote
          ? `<div class="card" style="margin-bottom:16px"><b class="ok">${esc(okNote)}</b></div>`
          : ""
    }${archivedLine(c, name)}`;
    const canStart = Boolean(startFrom(name)) && !store.campaignArchived(name);
    const buttons = campaignActions(c, name);
    const drawer = `${startPanel(c, name, vs, c.req.query("start") === "1")}${copyPanel(c, name, vs, tried)}`;
    // A run just started (Start a run sends here with ?run=), until its rig reports it.
    // The card follows the run's command (goal 080): how the start goes, in words, and the run's
    // own page once the rig reports the run. A start that the rig refused says why.
    const startingCmd = (key: string) => {
      const slash = key.indexOf("/");
      const run = key.slice(slash + 1);
      return slash > 0
        ? store
            .latestCommands(key.slice(0, slash), "assign_campaign")
            .find(
              (x) =>
                x.payload.run === run &&
                (x.payload.contract as { campaign?: unknown } | undefined)?.campaign === name,
            )
        : undefined;
    };
    const startingCard = (key: string) => {
      const cmd = startingCmd(key);
      const p = cmd ? commandProgress(cmd, Date.now()) : undefined;
      const failed = p?.state === "refused" || p?.state === "expired";
      const follow =
        cmd && p && !p.final
          ? ` data-follow="${esc(commandFollowUrl(cmd.id))}" data-follow-state="${p.state}"`
          : "";
      return `<div class="card" style="margin-bottom:16px" data-part="starting"${follow}><b${failed ? ` class="bad"` : ""}>${failed ? "Not started:" : "Starting"} ${esc(key)}.</b>${p ? ` <span class="${p.tone}">${esc(p.said)}</span>` : ""}${failed ? "" : ` <span class="muted">The rig fetches the project and the kit, and checks both. The run's page opens here when the rig reports the run, usually within a minute.</span>`}</div>`;
    };
    if (!k) {
      // Saved on control, with no run reported yet: what was asked for, and a way to start one.
      const saved = store.campaignVersions(name);
      if (!saved.length && !startFrom(name) && !store.campaignArchived(name))
        return page(
          c,
          {
            title: "Not found",
            crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
            active: "campaigns",
          },
          `<div class="card"><div class="empty">No such campaign.</div></div>`,
          vs,
        );
      const waiting = c.req.query("run");
      // A goal campaign's goals, each with how it is checked (goal 082), before any run.
      const how = goalChecksFor(name, vs);
      const savedGoals = how?.checks.goals.length
        ? `<div class="block"><div class="head"><h2>Goals</h2><span class="n">${how.checks.goals.length}</span></div><div class="card flat">${how.checks.goals
            .map(
              (g) =>
                `<div class="gl"><span class="gl-mark off">·</span><span class="gl-main"><span><b>${esc(g.goal)}</b>${g.required ? "" : ` <span class="muted small">optional</span>`}</span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}${howCheckedDetails(g, how.checks, how.source)}</span></div>`,
            )
            .join("")}</div></div>`
        : "";
      return page(
        c,
        {
          title: name,
          crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
          summary: esc(aboutOf(name)),
          active: "campaigns",
          actions: buttons,
        },
        `${note}${copiedLine(name)}${
          waiting
            ? startingCard(waiting)
            : `<div class="card" style="margin-bottom:16px"><div class="empty">${saved.length ? "Saved on control, with no run yet." : "Assigned to a rig over the API, MCP or the CLI; no run of it reports now."}${canStart ? ` <a class="btn sm primary" href="${campaignHref(name)}?start=1" data-open="#start" style="margin-left:6px">${icon.play}Start a run of ${esc(name)}</a>` : ""}</div></div>`
        }${savedGoals}${brief()}${context()}${queueTargetSection(name)}${knowledgeSection(c, name, vs, kbFailed)}${drawer}`,
        vs,
      );
    }
    const h = headline(k);
    const feed = needs(c, vs, now, campaignHref(name));
    const waitingFor = (u: RigView, r: RunView) =>
      feed.filter((n) => n.rig === u.id && n.run === r.id).length;

    // ---------------------------------------- one run's page
    const wanted = c.req.query("run");
    const sel = wanted ? k.runs.find((x) => runKey(x.rig.id, x.run.id) === wanted) : undefined;
    if (sel) {
      const qv = c.req.query("view");
      const view: RunViewName =
        qv === "attempts" ||
        qv === "history" ||
        qv === "experiments" ||
        qv === "journal" ||
        qv === "stats" ||
        qv === "reviews" ||
        qv === "hypotheses"
          ? qv
          : qv === "planner" || qv === "steering"
            ? "planner"
            : "overview";
      const st = runState(sel.run);
      const back = runHref(sel.rig.id, sel.run, view);
      const quick =
        sel.run.status === "paused"
          ? cmdForm(c, {
              rig: sel.rig.id,
              kind: "resume_run",
              fields: { run: sel.run.id },
              label: "Resume",
              back,
            })
          : sel.run.status === "running"
            ? pauseMenu(c, sel.rig.id, sel.run.id, back)
            : "";
      // A run without agents (a try, a rig check) has no one to message and no lanes to restart.
      const agents = sel.run.has_agents !== false;
      const more = moreMenu(c, sel.rig.id, sel.run, back, "", true);
      return page(
        c,
        {
          title: sel.run.id,
          crumbs: [
            { href: "/ui/campaigns", text: "Campaigns" },
            { href: campaignHref(name), text: name },
          ],
          summary: `on <a href="/ui/rigs/${encodeURIComponent(sel.rig.id)}">${esc(sel.rig.id)}</a>${reportingTag(sel.rig)} · ${esc(modeName(sel.run.mode))}${agents ? "" : " · judge only"} · <span class="label ${st.cls}">${st.icon}${esc(st.text)}</span>`,
          active: "campaigns",
          actions: `<a class="btn" href="${runLiveHref(sel.rig.id, sel.run.id)}">${icon.terminal}Live</a>${agents ? `<a class="btn" href="${runLiveHref(sel.rig.id, sel.run.id, "&compose=1")}">Message</a>` : ""}${quick}${exportMenu({ csrf: csrf(c), rig: sel.rig.id, run: sel.run.id, back })}${more}`,
        },
        `${note}${
          /-try-\d+$/.test(sel.run.id)
            ? `<div class="card hl" style="margin-bottom:12px"><b>A try of the kit.</b> No agents work on this run: the judge builds the starting point and runs every case on its own. When the results look right, <a href="${campaignHref(name)}?start=1">start the campaign</a>.</div>`
            : agents || isRigCheck(name)
              ? ""
              : // Any other run started with its agents off (goal 099): say so plainly. A rig
                // check's smoke run is the rig page's to explain.
                `<div class="card hl" style="margin-bottom:12px"><b>Judge only:</b> ${esc(JUDGE_ONLY_WORDS)}</div>`
        }${runSection(c, sel.rig, sel.run, vs, now, view)}`,
        vs,
      );
    }

    // ---------------------------------------- the campaign
    // A new run of a campaign that has runs: Starting until its rig reports it (only the newest
    // assignment, so an old link to a run that never came says nothing).
    // An old link to a run that never came says nothing, unless the rig refused its start.
    const latest = wanted ? store.latestAssignments().get(name) : undefined;
    const startCmd = wanted ? startingCmd(wanted) : undefined;
    const starting =
      wanted &&
      ((latest && runKey(latest.rig, latest.run) === wanted) ||
        startCmd?.status === "failed" ||
        startCmd?.status === "rejected")
        ? startingCard(wanted)
        : "";
    const running = k.runs.filter((x) => x.run.status === "running");
    const earlier = k.runs
      .filter((x) => x.run.status !== "running")
      .sort((a, b) => lastActivity(b.run).localeCompare(lastActivity(a.run)));
    const waitingRuns = k.runs
      .map((x) => ({ ...x, n: waitingFor(x.rig, x.run) }))
      .filter((x) => x.n > 0);
    const bestRun = h.best;
    // How each goal is really checked (goal 082): from the kit control keeps, else from the
    // newest run whose rig reported it, else what the contract says.
    const how = k.mode === "goal" ? goalChecksFor(name, vs) : undefined;
    const goals =
      (k.mode === "goal" && bestRun?.goals.length
        ? `<div class="kgoals">${bestRun.goals
            .map((g) => {
              const s2 = goalState(g);
              return `<span class="kgoal ${s2.tone}" title="${esc(g.goal)}: ${esc(s2.word)}">${s2.tone === "ok" ? "✓ " : ""}${esc(g.goal)}</span>`;
            })
            .join("")}</div>`
        : "") +
      (how?.checks.goals.length
        ? `<details class="howcheck khow" data-k="how-goals"><summary>How each goal is checked</summary>${how.checks.goals
            .map(
              (g) =>
                `<div class="gl"><span class="gl-main"><span><b>${esc(g.goal)}</b>${g.required ? "" : ` <span class="muted small">optional</span>`}</span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}${howChecked(g, how.checks, how.source)}</span></div>`,
            )
            .join("")}</details>`
        : "");
    const about = aboutOf(name);
    const rigs = rigList(k);
    // A research campaign's page has a Reviews tab (goal 116): its runs' reviews, by run.
    const reviewCount = k.runs.reduce(
      (n, x) => n + x.run.reviews.filter((r) => r.goal === RESEARCH_REVIEW).length,
      0,
    );
    const campaignView =
      k.mode === "research" && c.req.query("view") === "reviews" ? "reviews" : "";
    const campaignTabs =
      k.mode === "research"
        ? `<nav class="tabs"><a class="${campaignView ? "" : "on"}" href="${campaignHref(name)}">Overview</a><a class="${campaignView ? "on" : ""}" href="${campaignHref(name)}?view=reviews">Reviews <span class="muted">${reviewCount}</span></a></nav>`
        : "";
    const verifiedBy = new Map(
      (leaderboard(store, { staleAfterMs: opts.staleAfterMs })[k.name] ?? []).map((r) => [
        runKey(r.rig, r.run),
        r.verified_by,
      ]),
    );
    return page(
      c,
      {
        title: k.name,
        crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
        summary: `${esc(isRigCheck(k.name) ? "rig check" : modeName(k.mode))} · ${k.runs.length} run${k.runs.length === 1 ? "" : "s"}${running.length ? ` · ${running.length} at work` : ""} · ${esc(h.value)} ${esc(h.sub)}${k.mode === "hill_climb" ? ` · <a href="/ui/leaderboard">leaderboard</a>` : ""}`,
        active: "campaigns",
        actions: buttons,
      },
      `${note}${starting}${copiedLine(k.name)}${
        about || goals
          ? `<div class="card khead"><div>${about ? `<div class="small muted">What it is for</div>` : `<div class="small muted">Goals of its best run</div>`}${about ? `<div class="kabout-big">${esc(about)}</div>` : ""}${goals}</div><div class="small muted right">on ${esc(rigs.join(", "))}${bestRun ? `<br>best: ${esc(bestRun.id)}, ${esc(h.value)} ${esc(h.sub)}` : ""}</div></div>`
          : ""
      }${campaignTabs}${
        campaignView === "reviews"
          ? campaignReviewsTab({
              runs: [...running, ...earlier].map((x) => ({
                u: x.rig,
                r: x.run,
                state: (() => {
                  const s = runState(x.run);
                  return `<span class="label ${s.cls}">${s.icon}${esc(s.text)}</span>`;
                })(),
              })),
              now,
              sources: reviewSources,
            })
          : `<div class="cols run-cols"><div>
<div class="block" data-part="at-work"><div class="head"><h2>At work now</h2><span class="n">${running.length}</span></div>${
              running.length
                ? `<div class="kwork one">${running.map((x) => workCardFor(c, x.rig, x.run, now, waitingFor(x.rig, x.run), campaignHref(name))).join("")}</div>`
                : `<div class="card"><div class="empty">No run is at work.${canStart ? ` <a href="${campaignHref(name)}?start=1" data-open="#start">Start one.</a>` : ""}</div></div>`
            }</div>
${waitingRuns.map((w) => `<div class="kneed">${icon.warn}<span class="grow"><b>${w.n} decision${w.n === 1 ? " waits" : "s wait"} for you</b> in ${esc(w.run.id)} on ${esc(w.rig.id)}.</span><a class="btn sm" href="${runHref(w.rig.id, w.run)}#needs">Review</a></div>`).join("")}
<div data-part="earlier">${
              earlier.length
                ? `<div class="block"><div class="head"><h2>Earlier runs</h2><span class="n">${earlier.length}</span><span class="right">paused, completed and finished, newest first; open one for its attempts and history</span></div>${earlierRuns(
                    earlier.map((x) => ({
                      ...x,
                      // A hill climb's champion that other rigs confirmed (cross-verified).
                      result: (() => {
                        const v = verifiedBy.get(runKey(x.rig.id, x.run.id)) ?? [];
                        return v.length
                          ? ` <span class="pill ok" title="other rigs' judges confirmed this run's champion">${icon.check}cross-verified on ${esc(v.join(", "))}</span>`
                          : "";
                      })(),
                      action:
                        x.run.status === "paused"
                          ? cmdForm(c, {
                              rig: x.rig.id,
                              kind: "resume_run",
                              fields: { run: x.run.id },
                              label: "Resume",
                              cls: "sm",
                              back: campaignHref(name),
                            })
                          : "",
                    })),
                    now,
                  )}</div>`
                : ""
            }</div>${brief()}${context()}${queueTargetSection(name)}${knowledgeSection(c, name, vs, kbFailed)}
</div><div class="side">${campaignUsage(k)}</div></div>`
      }${drawer}`,
      vs,
    );
  };
  app.get("/ui/campaigns/:campaign", (c) => campaignPage(c));

  // ---------------------------------------- Archive, and the navigation's folders (goal 077)
  /**
   * Where Archive or a folder's form returns: its page, with what control did (sent) or what it
   * refused (error, on=shelf), in words. The navigation's script asks for JSON instead.
   */
  const shelfAnswer = <T>(
    c: Ctx,
    f: Record<string, unknown>,
    out: ShelfOutcome<T>,
    done: (a: T) => string,
    not: string,
    fallback: string,
  ) => {
    if (c.req.header("accept")?.includes("application/json")) {
      if (out.ok) return c.json({ ...out.answer, said: done(out.answer) });
      // A redirect's refusal is audited from its address; this answer says it itself.
      store.audit("owner:ui", "refused", { path: new URL(c.req.url).pathname, why: out.error });
      return c.json({ error: `${not} ${out.error}` });
    }
    const to = backTo(f, fallback);
    const [path = fallback, hash] = to.split("#");
    const q = out.ok
      ? `sent=${encodeURIComponent(done(out.answer))}`
      : `error=${encodeURIComponent(`${not} ${out.error}`)}&on=shelf`;
    return c.redirect(`${path}${path.includes("?") ? "&" : "?"}${q}${hash ? `#${hash}` : ""}`, 303);
  };
  /** A folder of the navigation by the id its forms carry. */
  const folderById = (id: string) => store.campaignFolders().find((x) => String(x.id) === id);
  const goneFolder = {
    ok: false,
    error: "That folder is not there any more.",
    status: 404,
  } as const;
  app.post("/ui/campaigns/:campaign/archive", async (c) => {
    const name = c.req.param("campaign");
    return shelfAnswer(
      c,
      await c.req.parseBody(),
      archiveCampaign(store, views(), name, "owner:ui"),
      (a) =>
        a.changed
          ? `Archived ${name}. It left the navigation, Needs you and the Overview.`
          : `${name} is archived already.`,
      "Not archived.",
      campaignHref(name),
    );
  });
  app.post("/ui/campaigns/:campaign/unarchive", async (c) => {
    const name = c.req.param("campaign");
    return shelfAnswer(
      c,
      await c.req.parseBody(),
      unarchiveCampaign(store, views(), name, "owner:ui"),
      (a) =>
        a.changed
          ? `Unarchived ${name}. It is back in the navigation, ${a.folder ? `in ${a.folder}` : "in no folder"}.`
          : `${name} is not archived.`,
      "Not unarchived.",
      campaignHref(name),
    );
  });
  app.post("/ui/campaigns/:campaign/folder", async (c) => {
    const name = c.req.param("campaign");
    const f = await c.req.parseBody();
    const id = String(f.folder ?? "");
    const to = id ? folderById(id) : undefined;
    return shelfAnswer(
      c,
      f,
      id && !to ? goneFolder : moveCampaign(store, views(), name, to?.name ?? null, "owner:ui"),
      (a) =>
        !a.changed
          ? a.folder
            ? `${name} is in ${a.folder} already.`
            : `${name} is in no folder already.`
          : a.folder
            ? `Moved ${name} to ${a.folder}.`
            : `Moved ${name} out of its folder.`,
      "Not moved.",
      campaignHref(name),
    );
  });
  app.post("/ui/campaign-folders", async (c) => {
    const f = await c.req.parseBody();
    return shelfAnswer(
      c,
      f,
      createFolder(store, String(f.name ?? ""), "owner:ui"),
      (a) =>
        `Made the folder ${a.folder.name}. Drag a campaign onto it, or use Move to folder on a campaign's page.`,
      "No folder made.",
      "/ui/campaigns",
    );
  });
  app.post("/ui/campaign-folders/:id/rename", async (c) => {
    const f = await c.req.parseBody();
    const folder = folderById(c.req.param("id"));
    return shelfAnswer(
      c,
      f,
      folder ? renameFolder(store, folder.name, String(f.name ?? ""), "owner:ui") : goneFolder,
      (a) => (a.changed ? `Renamed ${a.was} to ${a.folder.name}.` : "Nothing to rename."),
      "Not renamed.",
      "/ui/campaigns",
    );
  });
  app.post("/ui/campaign-folders/:id/delete", async (c) => {
    const f = await c.req.parseBody();
    const folder = folderById(c.req.param("id"));
    return shelfAnswer(
      c,
      f,
      folder ? deleteFolder(store, folder.name, "owner:ui") : goneFolder,
      (a) => `Deleted the folder ${a.deleted}.`,
      "Not deleted.",
      "/ui/campaigns",
    );
  });

  // The folders a campaign's agents may read besides its own (goal 065): the owner's, any time.
  const grantBack = (c: Ctx, campaign: string, k: "ok" | "error", m: string) =>
    c.redirect(
      `${campaignHref(campaign)}?${k}=${encodeURIComponent(m)}${k === "error" ? "&on=kb" : ""}#knowledge`,
      303,
    );
  app.post("/ui/campaigns/:campaign/kb/grant", async (c) => {
    const campaign = c.req.param("campaign");
    const reads = String((await c.req.parseBody()).reads ?? "").trim();
    const known = campaignModes(store, views());
    if (!known.has(campaign)) return c.text("No such campaign.", 404);
    if (!reads) return grantBack(c, campaign, "error", "Choose a folder to add.");
    if (reads === campaign)
      return grantBack(
        c,
        campaign,
        "error",
        "A campaign always reads its own folder: choose another campaign's.",
      );
    if (!known.has(reads))
      return grantBack(c, campaign, "error", `Control has no campaign named ${reads}.`);
    if (!store.kb().grant(campaign, reads, "owner:ui"))
      return grantBack(c, campaign, "ok", `${campaign} reads ${reads} already.`);
    store.audit("owner:ui", "kb_grant", { campaign, reads });
    return grantBack(
      c,
      campaign,
      "ok",
      `${campaign}'s agents may now read ${reads}'s folder. Runs at work get it at their next sync.`,
    );
  });
  app.post("/ui/campaigns/:campaign/kb/revoke", async (c) => {
    const campaign = c.req.param("campaign");
    const reads = String((await c.req.parseBody()).reads ?? "").trim();
    if (!store.kb().revoke(campaign, reads))
      return grantBack(c, campaign, "error", `${campaign} does not read ${reads}.`);
    store.audit("owner:ui", "kb_revoke", { campaign, reads });
    return grantBack(
      c,
      campaign,
      "ok",
      `${campaign}'s agents no longer read ${reads}'s folder. Runs at work drop it at their next sync.`,
    );
  });

  // ---------------------------------------------------------------- the Knowledge page (goal 065)
  app.get("/ui/knowledge", (c) => {
    const vs = views();
    const kb = store.kb();
    const folders = kb.folders();
    const q = (c.req.query("q") ?? "").slice(0, 300);
    const kind = SEARCH_KINDS.find((k) => k === c.req.query("kind")) ?? "";
    const folder = folders.find((f) => f.campaign === c.req.query("folder"))?.campaign ?? "";
    const limit = 100;
    const results = kb.search(q, folder ? [folder] : folders.map((f) => f.campaign), {
      ...(kind ? { kinds: [kind] } : {}),
      limit,
    });
    return page(
      c,
      {
        title: "Knowledge",
        summary: "Thermite's knowledge base: a folder for each campaign, and what each may read",
        active: "knowledge",
      },
      knowledgePage({
        folders,
        mode: modeWords(campaignModes(store, vs)),
        q,
        kind,
        folder,
        results,
        limit,
        now: Date.now(),
        link: runLinks(vs),
        result: (x) => kb.resultOf(x),
      }),
      vs,
    );
  });

  /**
   * Start a run's "From past research": a search of the folders one campaign may read (its own
   * and those granted), of the kinds a new run can start from. Agents' text, sent as JSON data.
   */
  app.get("/ui/kb/search.json", (c) => {
    c.header("cache-control", "no-store");
    const campaign = c.req.query("campaign") ?? "";
    if (!campaignModes(store, views()).has(campaign))
      return c.json({ error: "no such campaign" }, 404);
    const kb = store.kb();
    const folders = kb.readable(campaign);
    const items = pastResults(campaign, (c.req.query("q") ?? "").slice(0, 300));
    return c.json({
      campaign,
      folders,
      items: items.map((x) => {
        const w = pastWords(x, kb.resultOf(x));
        return {
          id: x.id,
          kind: x.kind,
          label: w.label,
          title: x.title,
          line: w.line,
          campaign: x.campaign,
          run: x.run,
          by: x.by,
          at: x.updated_at,
          goes: PICKABLE[x.kind],
        };
      }),
    });
  });

  // ---------------------------------------------------------------- rigs (Magnesium's Fleet)
  // Retire a rig that is gone, whatever set it up; bring it back.
  app.post("/ui/rigs/:rig/retire", async (c) => {
    const rig = c.req.param("rig");
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}`, 303);
    const f = await c.req.parseBody();
    if (String(f.confirm ?? "").trim() !== `retire ${rig}`)
      return back("error", `Type "retire ${rig}" to retire it.`);
    if (!store.rigs().some((u) => u.id === rig)) return back("error", "No such rig.");
    store.retireAnyRig(rig, "owner:ui");
    return back(
      "ok",
      `${rig} is retired. ${store.enrolledRig(rig) ? "" : "If its token is in control's settings, take it out there too."}`.trim(),
    );
  });
  app.post("/ui/rigs/:rig/bring-back", (c) => {
    const rig = c.req.param("rig");
    const ok = store.bringBackRig(rig, "owner:ui");
    return c.redirect(
      `/ui/rigs/${encodeURIComponent(rig)}?${ok ? "ok" : "error"}=${encodeURIComponent(ok ? `${rig} is back.` : `${rig} is not retired.`)}`,
      303,
    );
  });

  /** Where a rig runs, for its row on the Rigs list: the kind of place and its name. */
  const whereOf = (rig: string, pod: RunpodRigView | undefined): RigWhere => {
    const gone = (status: string) => (status === "removed" ? ", removed" : "");
    const m = store.machineRig(rig);
    if (m) return { kind: "Machine", name: `${m.machine}${gone(m.status)}` };
    const k = store.clusterRig(rig);
    if (k) return { kind: "Cluster", name: `${k.cluster}${gone(k.status)}` };
    if (pod) return { kind: "RunPod", name: pod.datacenter ?? "" };
    const j = store.joinedRig(rig);
    if (j) return { kind: "Joined", name: j.form === "namespace" ? "a namespace" : "a machine" };
    return { kind: "Set up by you", name: "" };
  };
  app.get("/ui/rigs", (c) => {
    const now = Date.now();
    const vs = views();
    const gone = store.retiredRigs();
    const listed = new Set([...vs.map((u) => u.id), ...gone.map((r) => r.rig)]);
    const rows: RigsListRow[] = [
      ...vs.map((u) => ({
        id: u.id,
        u,
        where: whereOf(u.id, u.runpod),
        pod: u.runpod,
        keyPending: Boolean(store.rigKey(u.id).pending),
      })),
      // A pod costs from its launch: it is listed before its first report too.
      ...(opts.runpodRigs?.list() ?? [])
        .filter((p) => p.active && !listed.has(p.rig))
        .map((p) => ({ id: p.rig, where: whereOf(p.rig, p), pod: p, keyPending: false })),
    ];
    const launch =
      opts.runpodRigs && store.gpuClouds().length
        ? `<a class="btn" href="/ui/rigs/add/runpod">Launch on RunPod</a>`
        : "";
    return page(
      c,
      {
        title: "Rigs",
        summary: rigsSummary(rows),
        actions: `${launch}<a class="btn primary" href="/ui/rigs/add">Add a rig</a>`,
        active: "rigs",
      },
      `${rigsListBody({
        rows,
        filter: rigFilter(c.req.query("f")),
        control,
        staleAfterMs: opts.staleAfterMs,
        offlineAfterMs,
        now,
      })}${
        gone.length
          ? `<div class="block" style="margin-top:20px"><div class="head"><h2>Retired</h2><span class="n">${gone.length}</span><span class="right">out of the lists; their records stay</span></div><div class="card flat">${gone
              .map(
                (r) =>
                  `<div class="row" style="padding:6px 0"><a href="/ui/rigs/${encodeURIComponent(r.rig)}">${esc(r.rig)}</a><span class="muted small">retired ${esc(ago(r.at, now))} ago by ${esc(r.by)}</span></div>`,
              )
              .join("")}</div></div>`
          : ""
      }`,
      vs,
    );
  });

  // ---------------------------------------------------------------- one rig
  app.get("/ui/rigs/:rig", (c, next) => {
    // Rigs › Add a rig has its own page, registered further down.
    if (c.req.param("rig") === "add") return next();
    const now = Date.now();
    const vs = views();
    const u = vs.find((x) => x.id === c.req.param("rig"));
    const placed = store.machineRig(c.req.param("rig"));
    const onCluster = store.clusterRig(c.req.param("rig"));
    const joined = store.joinedRig(c.req.param("rig"));
    const pulled = store.tunnelRig(c.req.param("rig"));
    const flashOk = c.req.query("ok");
    const flashError = c.req.query("error");
    // A command the green line is about (Edit rig's settings): the page says how it stands.
    const flashCmd = flashOk ? store.commandRow(c.req.query("cmd") ?? "") : undefined;
    const flashing = flashCmd ? commandProgress(flashCmd, Date.now()) : undefined;
    const flash = flashError
      ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not done.</b> ${esc(flashError)}</div>`
      : flashOk
        ? `<div class="card" style="margin-bottom:16px"${flashCmd && flashing && !flashing.final ? ` data-follow="${esc(commandFollowUrl(flashCmd.id))}" data-follow-state="${flashing.state}" data-say` : ""}><b class="ok">${esc(flashOk)}</b>${flashing ? ` <span class="${flashing.tone}" data-say>${esc(flashing.said)}</span>` : ""}</div>`
        : "";
    const retired = store.rigRetired(c.req.param("rig"));
    const launched = opts.runpodRigs?.view(c.req.param("rig"));
    if (!u && retired)
      return page(
        c,
        {
          title: c.req.param("rig"),
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: launched
            ? `<span class="muted">${launched.active ? "retired" : "terminated"}</span> · RunPod`
            : `<span class="muted">retired</span>`,
          active: "rigs",
        },
        `${flash}<div class="card"><p>Retired ${esc(ago(retired.at, now))} ago by ${esc(retired.by)}. It is out of the rig lists, its campaigns' pages and Needs you, and control refuses its reports. Its records stay.${launched && !launched.active ? ` Its pod is terminated. It cost <b>$${(launched.spend_usd ?? launched.spent_usd).toFixed(2)}</b> while it ran, as control counted it.` : ""}</p>
<form method="post" action="/ui/rigs/${encodeURIComponent(c.req.param("rig"))}/bring-back" class="row" style="gap:8px"><input type="hidden" name="csrf" value="${csrf(c)}"><button>Bring it back</button><span class="muted small">It shows again, and its reports are taken again. A token control made for it stays ended: give it a new one if it needs one.</span></form></div>${launched ? `${podSection(c, c.req.param("rig"), now)}${podHistory(undefined, c.req.param("rig"), [], now)}` : ""}`,
        vs,
      );
    if (!u && onCluster)
      return page(
        c,
        {
          title: onCluster.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `on ${esc(onCluster.cluster)} · ${esc(onCluster.status)}`,
          active: "rigs",
        },
        `<p class="run-said">Control is setting ${esc(onCluster.rig)} up on ${esc(onCluster.cluster)}. Its page fills in once the rig reports for the first time.</p>${flash}${clusterPlacedBlock(onCluster, csrf(c))}`,
        vs,
      );
    if (!u && joined) return joinedPage(c, joined, flash);
    if (!u && pulled && launched)
      return page(
        c,
        {
          title: pulled.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `${podSummary(launched)} · ${pulled.enrolled_at ? "enrolled" : "not enrolled yet"}`,
          active: "rigs",
        },
        `<p class="run-said">${podSaid(launched, now)} Its page fills in once the rig reports for the first time.</p>${flash}<div class="card" style="margin-bottom:16px"><div class="card-head"><span class="title">Getting it ready</span></div>${readySteps(launched, false)}</div>${podLogSection(c, pulled.rig, now, true)}${podSection(c, pulled.rig, now)}<div class="cols run-cols"><div>${podHistory(undefined, pulled.rig, [], now)}</div><div class="side">${pullBlock(pulled, now)}</div></div>`,
        vs,
      );
    if (!u && pulled)
      return page(
        c,
        {
          title: pulled.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `pull mode · ${pulled.enrolled_at ? "enrolled" : "not enrolled"}`,
          active: "rigs",
        },
        `<p class="run-said">Control connects to ${esc(pulled.rig)} through RunPod's proxy. Its page fills in once the rig reports for the first time.</p>${flash}${pullBlock(pulled, now)}`,
        vs,
      );
    if (!u && placed)
      return page(
        c,
        {
          title: placed.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `on ${esc(placed.machine)} · ${esc(placed.status)}`,
          active: "rigs",
        },
        `<p class="run-said">Control is setting ${esc(placed.rig)} up on ${esc(placed.machine)}. Its page fills in once the rig reports for the first time.</p>${flash}${placedBlock(placed, csrf(c))}`,
        vs,
      );
    if (!u)
      return page(
        c,
        { title: "Not found", active: "rigs" },
        `<div class="card"><div class="empty">No such rig.</div></div>`,
        vs,
      );
    const t = csrf(c);
    const key = store.rigKey(u.id);
    const back = `/ui/rigs/${encodeURIComponent(u.id)}`;
    const place = placeOf(u.id);
    const rp = u.runpod;
    const podStopped = Boolean(rp?.active && rp.status === "EXITED");
    const steps = store.rigSetupEvents(u.id);
    const stateIn = {
      u,
      place,
      control,
      controlSince: store.controlBuildSince(),
      staleAfterMs: opts.staleAfterMs,
      offlineAfterMs,
      steps,
      updating: updates.waiting(u.id),
      podStopped,
      csrf: t,
      now,
    };
    const refusedNow = u.version.state === "refused";
    const sup = u.supervisor as Record<string, unknown> | null;
    const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
    const ex = obj(sup?.export);
    /** A model file the supervisor downloads or downloaded, as its report says. */
    const modelLine = (x: unknown) => {
      const m = obj(x);
      const size = (b: unknown) => {
        const n = Number(b);
        return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
      };
      const name = `<b>${esc(String(m.name ?? "?"))}</b>`;
      if (m.state === "done") return `${name}: ${size(m.bytes)}, its SHA-256 checked`;
      if (m.state === "refused")
        return `${name}: <span class="bad">refused. Its SHA-256 did not match. The file was deleted.</span>`;
      if (m.state === "failed")
        return `${name}: <span class="bad">stopped. ${esc(String(m.error ?? "").slice(0, 300))}</span>`;
      const total = typeof m.total === "number" ? m.total : null;
      return `${name}: downloading, ${size(m.bytes)}${total ? ` of ${size(total)} (${Math.floor((100 * Number(m.bytes)) / Math.max(1, total))}%)` : ""}`;
    };
    const adv = sup?.advisors ? obj(sup.advisors) : null;
    // A drain under way (goal 136): a sentence, a card, and each trial it waits for by its lane.
    const drain = drainView(u, {
      store,
      now,
      csrf: t,
      cluster: onCluster?.status === "draining",
      form: (f) => cmdForm(c, { rig: u.id, back, ...f }),
    });
    const live = u.runs.filter((i) => i.status === "running");
    const runsNow = live
      .map((i) =>
        runBrief(store, u, i, now, {
          heading: true,
          detail: true,
          waiting: waitingOn(i, u),
          lane: drain?.lanes(i.id),
        }),
      )
      .join("");
    const checks: [string, string, string][] = [
      [
        "model",
        "Model route",
        "One short request through the rig's model route, as its workers and planner make them; it must come back as a correct tool call. Run it after the model server or its settings change, before resuming runs.",
      ],
      [
        "isolation",
        "Isolation",
        "Each role's user tries to reach what it must not: the judge's files, secrets, other roles' work, devices outside its grant. Needs an idle rig: pause its runs first, because each probe ends that role's processes.",
      ],
      [
        "smoke",
        "Judge smoke",
        "Known candidates (a real win, a no-op, broken changes, ways to cheat) must each get their expected verdict on this rig's own target. Minutes on a CPU, up to an hour on a GPU; its running runs are paused for it and resumed after.",
      ],
    ];
    const failed = checks.filter(([k]) => u.checks[k]?.finished_at && u.checks[k]?.ok === false);
    const j = u.judge.now;
    const queued = u.judge.queued.length;
    // The rig in a few sentences: is it reporting, what runs on it, its judge, what is wrong.
    const said = [
      rp ? podSaid(rp, now) : "",
      refusedNow
        ? `<b class="bad">Control refuses ${esc(u.id)}: it takes none of its reports.</b>`
        : podStopped
          ? "Its pod is stopped: its runs are paused, and only its volume costs money."
          : u.stale
            ? `<b class="bad">${esc(u.id)} has ${neverReported(u) ? "not reported yet" : `not reported for ${esc(span(u.last_seen, now))}`}.</b>`
            : `${esc(u.id)} is live; it reported ${esc(ago(u.last_seen, now))} ago.`,
      drain?.said ?? "",
      live.length
        ? `It runs ${live.map((i) => `<a href="${runHref(u.id, i)}">${esc(runCampaign(i))} › ${esc(i.id)}</a>`).join(" and ")}.`
        : u.runs.length
          ? "No run is at work on it."
          : "No campaign is assigned to it.",
      j
        ? `The judge is ${jobHtml(u, j)}${queued ? `, with ${queued} more queued` : ""}.`
        : `The judge is idle${queued ? `, with ${queued} queued` : ""}.`,
      failed.length
        ? `<b class="bad">Its ${failed.map(([, n]) => n.toLowerCase()).join(" and ")} check${failed.length > 1 ? "s" : ""} failed.</b>`
        : "",
      key.pending ? `<b class="warn">Its report key waits for your acceptance.</b>` : "",
      pulled?.error
        ? `<b class="bad">Control's last connection to its pod failed: ${esc(pulled.error)}</b>`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    // Each check's row in its state now: sent, running, its result, or why it did not run (goal 080).
    const rows = checkRowsOf(store, u.id, u.checks, now);
    const checkRows = refusedNow
      ? `<div class="empty">Control sends no command to a refused rig, so its checks can't run. Update it first.</div>`
      : checks
          .map(([k, name, what]) =>
            checkRowHtml({
              rig: u.id,
              check: k,
              name,
              what,
              row: rows[k] ?? checkRow(k, undefined, undefined, now),
              now,
              button: (label, disabled) =>
                cmdForm(c, {
                  rig: u.id,
                  kind: "rig_check",
                  fields: { check: k },
                  label,
                  back,
                  disabled,
                }),
            }),
          )
          .join("");
    const runRows = u.runs.map((i) => runRow(u, i, now, "campaign")).join("");
    const jobs = u.judge.jobs
      .slice(-8)
      .reverse()
      .map((x) => {
        const tone =
          x.state === "running"
            ? "info"
            : x.state === "done"
              ? "ok"
              : x.state === "queued"
                ? ""
                : "bad";
        const tag =
          x.state === "running"
            ? ` <span class="chip info">now</span>`
            : x.state === "queued"
              ? ` <span class="chip">queued</span>`
              : x.state !== "done"
                ? ` <span class="chip bad">${esc(x.state ?? "?")}</span>`
                : "";
        return `<div class="tl-row"><span class="tl-t">${esc(ago(x.finished_at ?? x.started_at ?? x.queued_at, now))}</span><span class="dot ${tone}"></span><span class="tl-s">${cap(jobHtml(u, x))}${tag}</span></div>`;
      })
      .join("");
    const h = u.hardware;
    const gib = (mib: number) => `${Math.round(mib / 1024)} GiB`;
    const hw = h
      ? [
          [
            "Judge",
            esc(
              h.devices
                .filter((d) => d.role !== "dev")
                .map((d) => d.name)
                .join(", ") || "the CPU",
            ),
          ],
          [
            "Dev runs",
            esc(
              h.device_mode === "dedicated"
                ? h.devices
                    .filter((d) => d.role === "dev")
                    .map((d) => d.name)
                    .join(", ")
                : h.device_mode === "shared"
                  ? "share the judge's device, and wait for it"
                  : "on the CPU",
            ),
          ],
          ["CPU", esc(`${h.cpu.quota ?? h.cpu.usable} of the host's ${h.cpu.host}`)],
          ["Memory", esc(gib(h.memory.limit_mib ?? h.memory.host_mib))],
          [
            "Disk free",
            esc(h.disks.map((d) => `${d.name} ${d.free_gib} of ${d.total_gib} GiB`).join(" · ")),
          ],
        ]
          .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
          .join("")
      : "";
    const refusal = u.version.refused;
    const rigFacts = [
      [
        "Last report",
        neverReported(u)
          ? "none yet"
          : `${esc(ago(u.last_seen, now))} ago, at ${esc(u.last_seen.slice(11, 16))} UTC${refusedNow ? " (the last one control took)" : ""}`,
      ],
      ...(refusal
        ? [
            [
              "Calls refused",
              `${refusal.calls} in the last ${esc(span(refusal.since, now))}${refusal.last_at ? ` · the last one ${esc(ago(refusal.last_at, now))} ago` : ""}`,
            ],
          ]
        : []),
      ...(place.words ? [["Placed on", esc(place.words)]] : []),
      ["Key", `<code>${esc(key.pubkey ? fingerprint(key.pubkey) : "not pinned")}</code>`],
      ["Ledger", `<code>${esc(u.ledger_id ?? "")}</code>`],
      ...(sup
        ? [
            [
              "Results",
              `${num(ex.exports)} exports${
                ex.remote === true
                  ? ` · <span title="${esc(ex.last_push_at ?? "")}">pushed ${esc(ago(String(ex.last_push_at ?? ""), now) || "?")} ago</span>`
                  : ex.to === "control"
                    ? `${
                        ex.last_upload_at
                          ? ` · <span title="${esc(ex.last_upload_at)}">sent to control ${esc(ago(String(ex.last_upload_at), now) || "?")} ago</span>`
                          : " · sent to control: none yet"
                      } · <a href="${exportsHref(u.id)}">its exports on control</a>`
                    : " · no results repository"
              }${typeof ex.waiting === "number" && ex.waiting > 0 ? ` · ${num(ex.waiting)} waiting to leave the rig` : ""}${ex.last_error ? `<div class="bad xs">${esc(String(ex.last_error).slice(0, 300))}</div>` : ""}`,
            ],
            ...(Array.isArray(sup.models) && sup.models.length
              ? [["Models", (sup.models as unknown[]).slice(0, 5).map(modelLine).join("<br>")]]
              : []),
            [
              "Advisors",
              adv
                ? `${num(adv.teacher_runs)} teacher rounds · ${num(adv.directive_sets)} directive sets · ${num(adv.audits)} audits · ${num(adv.errors)} errors · $${num(adv.usd).toFixed(2)}`
                : "none configured",
            ],
          ]
        : []),
    ]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
      .join("");
    const events = rp
      ? podHistory(u, u.id, stateRows(stateIn), now)
      : `<div class="block"><div class="head"><h2>Recent</h2><span class="right">newest first</span></div>${timeline(
          u.recent.map((e) => ({ u, e })),
          now,
          { limit: 12, extra: stateRows(stateIn) },
        )}</div>`;
    const keyCard = key.pending
      ? `<div class="card warn" style="margin-bottom:16px"><div class="card-head">${icon.key}<span class="title">${key.pubkey ? "This rig now signs its reports with a different key" : "This rig's first report key waits for your acceptance"}</span></div>
<p class="small">Its reports are refused until you accept the key. A full reset keeps a rig's key: a change is expected only when the rig's identity was rebuilt on purpose. Check the fingerprint with the rig's deployment before accepting.</p>
<div class="row"><code>${esc(fingerprint(key.pending))}</code><span class="grow"></span><form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="fingerprint" value="${esc(fingerprint(key.pending))}"><button class="primary">Accept this key</button></form></div></div>`
      : "";
    const retireForm = `<form method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/retire" class="stack" style="gap:8px"><input type="hidden" name="csrf" value="${t}">
<div class="small"><b>Retire it.</b> <span class="muted">For a rig that is gone: it leaves the rig lists, its campaigns' pages and Needs you, and control refuses its reports. Its records stay, and you can bring it back. It stops nothing where the rig runs.</span>${rp?.active ? ` <b class="warn">Its pod keeps running at RunPod, and costs money: terminate it instead, under The pod.</b>` : ""}</div>
<input name="confirm" placeholder="type: retire ${esc(u.id)}" data-confirm="retire ${esc(u.id)}" aria-label="Type retire ${esc(u.id)} to confirm"><button class="danger" style="justify-content:center">Retire it</button></form>`;
    const actions = `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Edit rig</a><a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/live">${icon.terminal}Live</a>
${exportMenu({ csrf: t, rig: u.id, back })}
<details class="menu"><summary class="btn">${icon.dots}</summary><div class="menu-body">
${
  rp
    ? `<div class="muted small">Stop, start, restart, full reset and terminate are on the page, under The pod.</div>`
    : `${opts.driver ? `<form method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/restart"><input type="hidden" name="csrf" value="${t}"><button style="width:100%;justify-content:center">Restart the rig's containers</button></form>` : `<div class="muted small">No deployment driver: restarts are not available.</div>`}
<div class="divider" style="margin:2px 0"></div>
<form method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/reset" class="stack" style="gap:8px"><input type="hidden" name="csrf" value="${t}">
<div class="small"><b>Full reset.</b> <span class="muted">Pause, export, verify the push, then wipe after your confirmation.</span></div>
<input name="confirm" placeholder="type: reset ${esc(u.id)}" data-confirm="reset ${esc(u.id)}" aria-label="Type reset ${esc(u.id)} to confirm"><button class="danger" style="justify-content:center">Start the full reset</button></form>`
}
<div class="divider" style="margin:2px 0"></div>
${retireForm}</div></details>`;
    return page(
      c,
      {
        title: u.id,
        crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
        summary: `${stateSummary(stateIn)}${rp ? ` · RunPod${podRuns(rp) && rp.price_per_hr !== null ? ` · $${rp.price_per_hr.toFixed(2)}/h` : ""}` : ""}`,
        actions,
        active: "rigs",
      },
      `<p class="run-said" data-part="said">${said}</p>
${flash}<div data-part="banners"${stateIn.updating ? ` data-follow="${esc(updateFollowUrl(u.id))}" data-follow-state="${esc(updateProgress(u.id).state)}"` : ""}>${stateBanners(stateIn)}${drain?.banner ?? ""}</div>${keyCard}
${rp ? podSection(c, u.id, now) : ""}
<div data-part="at-work">${runsNow ? `<div class="block"><div class="head"><h2>At work</h2><span class="n">${live.length}</span></div>${runsNow}</div>` : ""}</div>
<div class="cols run-cols"><div>
<div class="block" data-part="checks"${takingModel(u.model, store.rigModels()[u.id]) ? ` data-follow="${esc(modelFollowUrl(u.id))}" data-follow-state="taking"` : ""}><div class="head"><h2>Checks</h2><span class="right">run by the rig itself; each result also goes to its history</span></div><div class="card flat cks">${checkRows}</div></div>
<div class="block" data-part="runs"><div class="head"><h2>Runs on this rig</h2><span class="n">${u.runs.length}</span>${u.state !== "reporting" || refusedNow ? `<span class="right">as of its last report${neverReported(u) ? "" : `, ${esc(ago(u.last_seen, now))} ago`}</span>` : ""}</div>${runRows ? `<div class="card flat">${runRows}</div>` : `<div class="card"><div class="empty">No campaign assigned.</div></div>`}</div>
${rp ? events : ""}
<div class="block" data-part="jobs"><div class="head"><h2>The judge's last jobs</h2></div>${jobs ? `<div class="card flat tl">${jobs}</div>` : `<div class="card"><div class="empty">No job yet.</div></div>`}</div>
${rp ? podLogSection(c, u.id, now, false) : ""}
</div><div class="side">
<div class="block"><div class="head"><h2>What it runs on</h2></div>${h ? `<div class="card"><dl class="facts">${hw}</dl></div><details class="card flat matrix" data-k="hw-${esc(u.id)}" style="margin-top:10px"><summary>Every detail</summary>${hardwareCard(h, now)}</details>` : hardwareCard(h, now)}</div>
<div class="block" data-part="rig"><div class="head"><h2>The rig</h2></div><div class="card"><dl class="facts">${versionFact(stateIn)}${rigFacts}</dl>${sup ? `<div class="muted xs" style="margin-top:8px">The supervisor reports its figures itself (unsigned).</div>` : ""}</div></div>
${placed ? placedBlock(placed, t) : ""}${onCluster ? clusterPlacedBlock(onCluster, t) : ""}${joined ? joinedBlock(joined, t, undefined, true) : ""}${pulled ? pullBlock(pulled, now) : ""}
${rp ? "" : events}
</div></div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- one attempt
  // A champion as a patch file: the result an operator takes away (it applies to the base commit).
  app.get("/ui/rigs/:rig/runs/:run/champions/:file", (c) => {
    const m = /^(\d+)\.patch$/.exec(c.req.param("file"));
    const p = m
      ? store.championPatch(c.req.param("rig"), c.req.param("run"), Number(m[1]))
      : undefined;
    if (!m || !p) return c.text("No patch for that champion yet.", 404);
    // A project in a folder: named after the repository's commit, the one its owner has.
    const folder = views()
      .find((u) => u.id === c.req.param("rig"))
      ?.runs.find((r) => r.id === c.req.param("run"))?.seed_folder;
    const name = `${c.req.param("run")}-champion-${m[1]}-on-${(folder?.commit ?? p.base_commit).slice(0, 8)}.patch`;
    return c.body(new Uint8Array(p.patch), 200, {
      "content-type": "text/x-diff; charset=utf-8",
      "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
    });
  });

  // A research run's paper (goal 112), as its rig's report carries it: the Markdown file, with
  // the references the harness appended (the same text is paper.md in the run's research folder).
  // Shown as plain text: it is the agents' writing.
  app.get("/ui/rigs/:rig/runs/:run/paper.md", (c) => {
    const run = c.req.param("run");
    const p = views()
      .find((u) => u.id === c.req.param("rig"))
      ?.runs.find((r) => r.id === run)?.paper;
    if (p?.state !== "in" || !p.text) return c.text("No research paper for that run yet.", 404);
    return c.body(p.text, 200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `inline; filename="${`${run}-paper.md`.replace(/[^\w.-]/g, "_")}"`,
    });
  });

  /** The follow of the owner's newest decision on a change, while the rig has not done it. */
  const followDecision = (rig: string, attempt: string, now: number) => {
    const d = store.decisions().find((x) => x.rig === rig && x.attempt === attempt);
    const cmd = d ? store.commandRow(d.id) : undefined;
    const p = cmd ? commandProgress(cmd, now) : undefined;
    return cmd && p && !p.final
      ? ` data-follow="${esc(commandFollowUrl(cmd.id))}" data-follow-state="${esc(p.state)}"`
      : "";
  };
  app.get("/ui/rigs/:rig/attempts/:attempt", (c) => {
    const now = Date.now();
    const vs = views();
    const u = vs.find((x) => x.id === c.req.param("rig"));
    const id = c.req.param("attempt");
    const r = u?.runs.find((x) => x.attempts.some((a) => a.id === id));
    const a = r?.attempts.find((x) => x.id === id);
    if (!u || !r || !a)
      return page(
        c,
        { title: "Not found", active: "campaigns" },
        `<div class="card"><div class="empty">No such attempt on this rig.</div></div>`,
        vs,
      );
    const back = attemptHref(u.id, a.id);
    // The change's own page keeps its decision after the owner chose: it says what the rig did.
    const decision = operatorNeeds(store, [u], forms(c), now, back).find((n) => n.attempt === a.id);
    // A champion's patch, once the rig has published it.
    const champ = r.champion.find((x) => x.attempt === a.id && !x.reopened);
    const patch =
      champ && store.championPatch(u.id, r.id, champ.seq)
        ? `<a href="/ui/rigs/${encodeURIComponent(u.id)}/runs/${encodeURIComponent(r.id)}/champions/${champ.seq}.patch">Download champion #${champ.seq} as a patch</a>`
        : undefined;
    return page(
      c,
      {
        title: a.id,
        crumbs: [
          { href: "/ui/campaigns", text: "Campaigns" },
          { href: campaignHref(runCampaign(r)), text: runCampaign(r) },
          { href: runHref(u.id, r), text: `${r.id} on ${u.id}` },
        ],
        active: "campaigns",
      },
      // One part: the owner's decision and what the rig did show without a refresh (goal 080),
      // followed while the rig has not done it.
      `<div data-part="attempt"${followDecision(u.id, a.id, now)}>${attemptDetail(u, r, a, now, { decision, patch })}</div>`,
      vs,
    );
  });

  app.post("/ui/rigs/:rig/key/accept", async (c) => {
    const f = await c.req.parseBody();
    // Only the key whose fingerprint the owner saw: a key swapped in meanwhile is not accepted.
    store.acceptPendingKey(c.req.param("rig"), "owner:ui", String(f.fingerprint ?? ""));
    return c.redirect(`/ui/rigs/${encodeURIComponent(c.req.param("rig"))}`, 303);
  });

  // ---------------------------------------------------------------- live, one run at a time (goal 063)
  /**
   * Live: the runs at work on the left; one run's stream in the middle, with filters for each
   * lane, the planner, the judge, the advisors and the owner's own messages; under it, one
   * message box that writes to the lane being watched.
   */
  app.get("/ui/live", (c) => {
    const vs = views();
    const now = Date.now();
    const all = vs.flatMap((u) => u.runs.map((r) => ({ u, r })));
    const atWork = all.filter((x) => x.r.status === "running");
    const wanted = c.req.query("run");
    const sel =
      (wanted ? all.find((x) => runKey(x.u.id, x.r.id) === wanted) : undefined) ?? atWork[0];
    const day = now - 24 * 3600_000;
    const ended = all
      .filter((x) => x.r.status !== "running" && Date.parse(lastActivity(x.r)) > day)
      .sort((a, b) => lastActivity(b.r).localeCompare(lastActivity(a.r)));
    const idle = vs.filter((u) => !u.runs.some((r) => r.status === "running"));
    const runLink = (x: { u: RigView; r: RunView }, sub: string, cls = "") =>
      `<a class="lr${sel && x.u.id === sel.u.id && x.r.id === sel.r.id ? " on" : ""}${cls}" href="${runLiveHref(x.u.id, x.r.id)}"><span class="t">${x.r.status === "running" ? `<span class="dot ok pulse"></span>` : ""}${esc(x.r.id)}</span><span class="s">${sub}</span></a>`;
    const nav = `<nav class="lruns" aria-label="Runs" data-part="lruns">
<div class="hd">At work</div>${atWork.map((x) => runLink(x, `${esc(x.u.id)} · ${esc(modeName(x.r.mode))} · ${Object.keys(x.r.at_work).length} working${waitingOn(x.r, x.u) ? ` · <span class="warn">${waitingOn(x.r, x.u)} wait for you</span>` : ""}`)).join("") || `<div class="lempty">No run is at work.</div>`}
${idle.length ? `<div class="hd">Idle rigs</div>${idle.map((u) => `<a class="lr idle" href="/ui/rigs/${encodeURIComponent(u.id)}"><span class="t">${esc(u.id)}</span><span class="s">no run at work${podStopped(u) ? " · its pod is stopped" : u.stale ? " · not reporting" : ""}</span></a>`).join("")}` : ""}
${ended.length ? `<details class="lended"${sel && sel.r.status !== "running" ? " open" : ""}><summary class="hd">Ended in the last day (${ended.length})</summary>${ended.map((x) => runLink(x, `${esc(x.u.id)} · ${runCompleted(x.r) ? "completed" : x.r.status === "closed" ? "finished" : esc(x.r.status)}`, " idle")).join("")}</details>` : ""}
</nav>`;
    if (!sel)
      return page(
        c,
        { title: "Live", summary: "no run at work", active: "live", flush: true },
        `<div class="lwrap">${nav}<section class="lcol"><div class="empty" style="margin:auto">${ended.length ? "No run is at work. Pick one from the list to see its lines." : "No run to watch yet. Runs show here as soon as a rig reports one."}</div></section></div>`,
        vs,
      );
    const { u, r } = sel;
    const research = r.mode === "research";
    const trials = store.liveTrials(u.id).filter((t) => t.run === r.id);
    const lanes = [
      ...new Set([
        ...Object.keys(r.at_work),
        ...(r.epoch?.assignments.map((a) => a.lane) ?? []),
        ...trials.map((t) => t.lane).filter((l): l is string => !!l),
      ]),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const lines = store.liveRunTail(u.id, r.id, 600);
    const after = lines.at(-1)?.id ?? 0;
    const w = c.req.query("w") || "all";
    // The filters: everyone, each lane (working or not), the planner, the judge, the advisors, you.
    const chip = (key: string, label: string, title = "", working = false) =>
      `<a class="lchip${w === key ? " on" : ""}" data-w="${esc(key)}" href="${runLiveHref(u.id, r.id, key === "all" ? "" : `&w=${encodeURIComponent(key)}`)}"${title ? ` title="${esc(title)}"` : ""}>${working ? `<span class="dot ok"></span>` : ""}${esc(label)}</a>`;
    const chips = [
      chip("all", "Everyone"),
      ...lanes.map((l) => {
        const work = r.at_work[l];
        return chip(
          l,
          l,
          work ? `${work.family}: ${work.focus}` : "between trials",
          Boolean(work) && r.status === "running",
        );
      }),
      chip("planner", "Planner"),
      ...(research ? [] : [chip("judge", "Judge")]),
      chip("advisors", "Advisors"),
      chip("you", "You", "your messages, and who read them"),
    ].join("");
    const kept = r.messages.filter((m) => m.keep && !m.unkept);
    const keptBox = kept.length
      ? `<details class="lkept"><summary class="lchip" title="Your messages kept in force">📌 ${kept.length} kept</summary><div class="menu-pop"><div class="muted small">Every new trial gets these, until you remove them.</div>${kept
          .map(
            (m) =>
              `<div class="krow"><span class="small"><b>To ${esc(m.to === "all" ? "everyone" : m.to)}:</b> ${esc(clip(m.text, 200))}</span>${cmdForm(c, { rig: u.id, kind: "unkeep_message", fields: { run: r.id, message: String(m.id) }, label: "Remove", cls: "sm ghost", back: runLiveHref(u.id, r.id) })}</div>`,
          )
          .join("")}</div></details>`
      : "";
    // The message box: who it goes to, and when they read it (the placeholder says).
    // When they read it depends on the agents' harness: Pi between steps; OpenCode, Claude Code
    // and Codex when their current run ends (or in the lane's next trial). A research run's
    // workers on a Codex rig run in Pi.
    const harness = u.model?.harness;
    const pi = harness === "pi" || (research && harness === "codex");
    const when =
      harness === undefined
        ? "when it can (this rig hasn't said which program runs its agents)"
        : pi
          ? "at its next step"
          : "when its current run ends, or in its next trial";
    const hint = (to: string) =>
      to === "all"
        ? `Each agent reads it ${harness === undefined ? "when it can" : pi ? "at its next step" : "when its current run ends"}; the planner at its next plan`
        : to.startsWith("lane-")
          ? `${to}${r.at_work[to] ? ` (on ${r.at_work[to]?.family})` : ""} reads it ${when}`
          : to === "planner"
            ? "The planner reads it when it plans the next round"
            : to === "teachers"
              ? "The teachers read it in their next round and answer here"
              : to === "auditor"
                ? "The auditor reads it before its next audit and answers here"
                : to === "panel"
                  ? "The review panel reads it before its next review and answers here"
                  : "The advisors read it and answer here";
    // A run without agents has no one working: the box starts on the advisors.
    const to =
      lanes.includes(w) || w === "planner"
        ? w
        : w === "advisors" || r.has_agents === false
          ? "advisors"
          : "all";
    // The review panel reads only for a goal it reviews (a goal checked by review) or a research
    // run's questions (goal 112).
    const reviewed = panelReviews(store, runCampaign(r));
    // Who would read nothing: off on the rig, or not set up on its supervisor. Control refuses
    // a message to them with the same words (issue.ts).
    const off = (v: string) => nobodyReads(u, v, r);
    const opt = (v: string, label: string, off = "") =>
      `<option value="${esc(v)}" data-hint="${esc(hint(v))}"${v === to ? " selected" : ""}${off ? ` disabled title="${esc(off)}"` : ""}>${esc(label)}</option>`;
    // A message control refused, or the rig refused (its newest one to this run).
    const refused = c.req.query("msgerror");
    const rigRefused = store.lastMessageToRun(u.id, r.id)?.refused ?? "";
    const notice =
      refused || rigRefused
        ? `<div class="lnotice">${icon.warn}<span><b>Not sent.</b> ${esc(refused || `The rig refused your last message: ${rigRefused}`)}</span></div>`
        : "";
    const box =
      r.status === "closed"
        ? `<div class="lcomposer off">This run has finished: its agents take no more messages.</div>`
        : `<form class="lcomposer" method="post" action="/ui/live/message" data-act><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="w" value="${esc(w)}">
<select name="to" aria-label="To" class="lto">${opt("all", "To everyone working", off("all"))}${lanes.map((l) => opt(l, `To ${l}`, off(l))).join("")}${opt("planner", "To the planner", off("planner"))}<optgroup label="Advisors">${opt("advisors", "To all advisors", off("advisors"))}${opt("teachers", "To the teachers", off("teachers"))}${opt("auditor", "To the auditor", off("auditor"))}${opt("panel", "To the review panel", off("panel") || (!reviewed ? "This run has no goal the review panel reviews." : ""))}</optgroup></select>
<textarea name="text" rows="1" required data-words maxlength="4000" aria-label="Message" placeholder="${esc(hint(to))} · ⌘↩ sends"${c.req.query("compose") ? " autofocus" : ""}></textarea>
<label class="lpin" title="Keep it in force: every new trial gets it too, until you remove it"><input type="checkbox" name="keep" value="1">📌</label>
<button class="primary">${icon.send}Send</button></form>`;
    const meta = [
      esc(u.id),
      r.epoch ? `round ${r.epoch.n}` : "",
      research
        ? `${num((r.research as Record<string, unknown> | null)?.verified)} verified claims`
        : r.mode === "goal"
          ? `${r.goals.filter((g) => g.status === "met").length} of ${r.goals.length} goals met`
          : signed((currentChampion(r)?.cumulative ?? 1) - 1),
      waitingOn(r, u)
        ? `<a class="warn" href="${runHref(u.id, r)}#needs">${waitingOn(r, u)} wait${waitingOn(r, u) === 1 ? "s" : ""} for you</a>`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const st = runState(r);
    const head = `<div data-part="lhead"><div class="lhead"><button class="ghost sm lnav-btn" type="button" title="Show or hide the list of runs" aria-label="Runs">☰</button>${modeAvatar(r.mode)}<span class="t">${esc(r.id)}</span><span class="label ${st.cls}">${st.icon}${esc(st.text)}</span><span class="lmeta">${meta}</span><a class="btn sm" href="${runHref(u.id, r)}">Open the run</a>${
      r.status === "running"
        ? pauseMenu(c, u.id, r.id, runLiveHref(u.id, r.id), "sm") +
          moreMenu(c, u.id, r, runLiveHref(u.id, r.id), "sm")
        : r.status === "paused"
          ? cmdForm(c, {
              rig: u.id,
              kind: "resume_run",
              fields: { run: r.id },
              label: "Resume",
              cls: "sm",
              back: runLiveHref(u.id, r.id),
            })
          : ""
    }</div></div>`;
    return page(
      c,
      {
        title: "Live",
        summary: `${atWork.length} run${atWork.length === 1 ? "" : "s"} at work`,
        active: "live",
        flush: true,
      },
      `<div class="lwrap" id="lwrap">${nav}<section class="lcol">${head}<div data-fw-top></div><div class="lchips">${chips}<span class="grow"></span><span data-part="lkept">${keptBox}</span><button class="lchip on lfollow" type="button" aria-pressed="true" title="Follow new lines">↓ Follow</button></div>
<div class="transcript lstream" id="transcript" data-rig="${esc(u.id)}" data-run="${esc(r.id)}" data-w="${esc(w)}" data-after="${after}">${runLinesHtml(lines, now, store.runMessages(u.id, r.id)) || `<div class="empty">No live lines yet. They appear here as the run's agents and judge work.</div>`}</div>
<div data-part="lnotice">${notice}</div>${box}</section></div>`,
      vs,
    );
  });

  app.get("/ui/live.json", (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const [rig, run] = String(c.req.query("run") ?? "").split("/");
    if (!rig || !run) return c.json({ entries: [] });
    const now = Date.now();
    const messages = store.runMessages(rig, run);
    const entries = store.liveRun(rig, run, after, 500).map((e) => ({
      id: e.id,
      kind: e.kind,
      src: e.source,
      html: runEntryHtml(e, now, messages),
      ...(e.kind === "result" ? { join: resultJoin(e) } : {}),
    }));
    // Lines drawn before their event came (recheck=ids), drawn again once it has.
    const ids = String(c.req.query("recheck") ?? "")
      .split(",")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 50);
    const redrawn = ids.length
      ? store
          .liveRun(rig, run, 0, 50, ids)
          .map((e) => ({ id: e.id, html: runEntryHtml(e, now, messages) }))
          .filter((x) => !x.html.includes('data-recheck="1"'))
      : [];
    return c.json({ entries, redrawn });
  });

  app.post("/ui/live/message", async (c) => {
    const f = await c.req.parseBody();
    const rig = String(f.rig ?? "");
    const run = String(f.run ?? "");
    const w = String(f.w ?? "");
    // From the Planner tab, back there; from Live, to the same filter.
    const from = String(f.back ?? "");
    const back = (more = "") =>
      c.redirect(
        from.startsWith("/ui/")
          ? `${from}${from.includes("?") ? "&" : "?"}${more ? more.slice(1) : `sent=${encodeURIComponent("Sent to the rig. The planner reads it when it next gives out work; Commands shows whether the rig took it.")}`}`
          : runLiveHref(
              rig,
              run,
              `${w && w !== "all" ? `&w=${encodeURIComponent(w)}` : ""}${more}`,
            ),
        303,
      );
    const to = String(f.to ?? "all");
    const keep = String(f.keep ?? "") === "1" && (to === "all" || to.startsWith("lane-"));
    // From the page's script (goal 080): JSON, and the message is followed until the rig took it.
    const json = wantsJson(c);
    let id: string;
    try {
      ({ id } = issueCommand(store, opts.privateKeyPem, {
        rig,
        kind: "message_agent",
        payload: { run, to, text: String(f.text ?? "").trim(), ...(keep ? { keep: true } : {}) },
        issuedBy: "owner:ui",
      }));
    } catch (err) {
      const why = errorText(err);
      return json ? c.json(notSent(why), 400) : back(`&msgerror=${encodeURIComponent(why)}`);
    }
    const cmd = json ? store.commandRow(id) : undefined;
    if (cmd) return c.json({ ...commandProgress(cmd, Date.now()), follow: commandFollowUrl(id) });
    return back();
  });

  // ---------------------------------------------------------------- one rig's sessions, every run
  const sourceName = (s: string, lane?: string | null) =>
    s === "planner"
      ? "Planner"
      : s === "judge"
        ? "Judge"
        : s === "supervisor"
          ? "Supervisor"
          : `Worker${lane ? ` · ${lane}` : ""}`;
  const sourceAvatar = (s: string) =>
    s === "planner"
      ? `<span class="av c5">PL</span>`
      : s === "judge"
        ? `<span class="av c4">JG</span>`
        : s === "supervisor"
          ? `<span class="av c3">SV</span>`
          : `<span class="av c1">WK</span>`;

  app.get("/ui/rigs/:rig/live", (c) => {
    const vs = views();
    const now = Date.now();
    const u = vs.find((x) => x.id === c.req.param("rig"));
    if (!u)
      return page(
        c,
        { title: "Not found", active: "live" },
        `<div class="card"><div class="empty">No such rig.</div></div>`,
        vs,
      );
    const sources = store.liveSources(u.id);
    const intros = new Map(
      store
        .liveTrials(u.id)
        .map((x) => [x.source, x.intro.replace(/^(research )?trial on [^:]+: /, "")]),
    );
    const source = c.req.query("source") || "";
    const sel = sources.find((x) => x.source === source);
    const lines = store.liveTail(u.id, 400, source || undefined);
    const after = lines.at(-1)?.id ?? 0;
    // A trial works while the ledger has it at work; its "trial ended" line may never come (a
    // restart cuts it off, and the harness closes it as interrupted when it starts again).
    const atWork = new Set(
      u.runs.flatMap((r) => Object.values(r.at_work).map((w) => `trial:${w.trial}`)),
    );
    const ended = new Map(sources.map((x) => [x.source, x.ended || !atWork.has(x.source)]));
    const list = [
      `<a class="side-row${source ? "" : " on"}" href="/ui/rigs/${encodeURIComponent(u.id)}/live">${icon.live}<span class="two"><span class="name"><b>Everything</b></span><span class="muted xs">all sessions, interleaved</span></span></a>`,
      ...sources.map(
        (s) =>
          `<a class="side-row${s.source === source ? " on" : ""}" href="/ui/rigs/${encodeURIComponent(u.id)}/live?source=${encodeURIComponent(s.source)}">${sourceAvatar(s.source)}<span class="two"><span class="name"><b>${esc(sourceName(s.source, s.lane))}</b></span><span class="muted xs clip">${esc([intros.get(s.source) || (s.source.startsWith("trial:") ? s.source.slice(6) : (s.run ?? "")), `${ago(s.last_at, now)} ago`].filter(Boolean).join(" · "))}</span></span>${s.source.startsWith("trial:") ? `<span class="right">${ended.get(s.source) ? `<span class="muted xs">ended</span>` : `<span class="label info xs"><span class="dot info pulse"></span>working</span>`}</span>` : ""}</a>`,
      ),
    ].join("");
    // Lines with their times, formatted once (ui/live.ts); the script adds new ones the same way.
    const out = [liveLinesHtml(lines, { showWho: !source, name: sourceName, now })];
    // Who is at work: for one worker, its agent, task, start and last activity.
    const agent = u.model
      ? u.model.source === "control"
        ? `${HARNESS_NAMES[u.model.harness] ?? u.model.harness} · ${u.model.model} (from ${u.model.name})`
        : u.model.source === "environment"
          ? `${HARNESS_NAMES[u.model.harness] ?? u.model.harness} · ${u.model.model} (the rig's own settings)`
          : "no model: the agents wait"
      : "not reported by this rig's harness";
    const trial = source.startsWith("trial:")
      ? store.liveTrials(u.id).find((x) => x.source === source)
      : undefined;
    const whenAt = (at: string) =>
      `${esc(at.slice(11, 19))} UTC <span class="muted">(${esc(ago(at, now))} ago)</span>`;
    const head = trial
      ? `<div class="lv-head"><dl class="facts"><dt>Agent</dt><dd>${esc(agent)}</dd><dt>Task</dt><dd>${esc(intros.get(source) || "not given")}</dd><dt>Started</dt><dd>${whenAt(trial.started_at)}</dd><dt>Last activity</dt><dd>${whenAt(trial.last_at)} ${trial.ended ? `<span class="chip">ended</span>` : `<span class="chip info">working</span>`}</dd></dl></div>`
      : !source
        ? `<div class="lv-head"><dl class="facts"><dt>Agents</dt><dd>${esc(agent)}</dd><dt>Last activity</dt><dd>${sources[0] ? whenAt(sources[0].last_at) : "none yet"}</dd></dl></div>`
        : "";
    // Messages go from a run's own Live page, where each recipient says when it reads them.
    const composer = u.runs.filter((x) => x.status !== "closed").length
      ? `<div class="composer off">To message an agent, open its run's Live: ${u.runs
          .filter((x) => x.status !== "closed")
          .map((x) => `<a href="${runLiveHref(u.id, x.id)}">${esc(x.id)}</a>`)
          .join(", ")}.</div>`
      : `<div class="composer off">No run on this rig to message.</div>`;
    const title = source ? sourceName(source, sel?.lane) : "Everything";
    return page(
      c,
      {
        title,
        crumbs: [
          { href: "/ui/live", text: "Live" },
          { href: `/ui/rigs/${encodeURIComponent(u.id)}`, text: u.id },
        ],
        summary: source.startsWith("trial:")
          ? (() => {
              // Where this session sits: Campaign › Run › Lane › Trial.
              const run = sel?.run ? u.runs.find((i) => i.id === sel.run) : undefined;
              return [
                run
                  ? `<a href="${runHref(u.id, run)}">${esc(runCampaign(run))} › ${esc(run.id)}</a>`
                  : esc(sel?.run ?? ""),
                esc(sel?.lane ?? ""),
                esc(source.slice(6)),
              ]
                .filter(Boolean)
                .join(" › ");
            })()
          : source === "supervisor"
            ? "relayed by the supervisor, unsigned"
            : `${sources.length} sessions`,
        active: "live",
        flush: true,
      },
      `<aside class="sessions"><div class="section" style="margin-top:4px">Sessions</div>${list}</aside>
<div class="transcript-wrap">${head}<div class="transcript" id="transcript" data-rig="${esc(u.id)}" data-source="${esc(source)}" data-after="${after}">${out.join("") || `<div class="empty">No live lines yet. They appear here as the rig's agents and judge work.</div>`}</div>${composer}</div>`,
      vs,
    );
  });

  app.get("/ui/rigs/:rig/live.json", (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const source = c.req.query("source") || undefined;
    const now = Date.now();
    // Each line as the page shows it; a result also as the part it adds to its call's row.
    const entries = store.live(c.req.param("rig"), after, 500, source).map((e) => ({
      id: e.id,
      kind: e.kind,
      html: liveEntryHtml(e, { showWho: !source, name: sourceName, now }),
      ...(e.kind === "result" ? { join: resultJoin(e) } : {}),
    }));
    return c.json({ entries });
  });

  app.post("/ui/rigs/:rig/message", async (c) => {
    const rig = c.req.param("rig");
    const f = await c.req.parseBody();
    const source = String(f.source ?? "");
    try {
      issueCommand(store, opts.privateKeyPem, {
        rig,
        kind: "message_agent",
        payload: {
          run: String(f.run ?? ""),
          to: String(f.to ?? ""),
          text: String(f.text ?? "").trim(),
        },
        issuedBy: "owner:ui",
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect(
      `/ui/rigs/${encodeURIComponent(rig)}/live${source ? `?source=${encodeURIComponent(source)}` : ""}`,
      303,
    );
  });

  // ---------------------------------------------------------------- commands, audit, leaderboard, reports
  app.get("/ui/commands", (c) => {
    const now = Date.now();
    const rows = store
      .listCommands(200)
      .map((x) => commandRow(x, now))
      .join("");
    return page(
      c,
      {
        title: "Commands",
        summary: "every signed command control issued, newest first",
        active: "commands",
      },
      `<div class="card flat"><table><thead><tr><th>Issued</th><th>Rig</th><th>Kind</th><th>By</th><th>Status</th><th>Outcome</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty">No command yet.</td></tr>`}</tbody></table></div>`,
    );
  });

  app.get("/ui/audit", (c) => {
    const now = Date.now();
    // 300 entries a page, newest first; Older and Newer page through every entry (goal 015).
    const before = cursorOf(c.req.query("before"));
    const p = store.auditPage(
      300,
      {},
      before !== undefined ? { before } : { after: cursorOf(c.req.query("after")) },
    );
    const rows = p.entries
      .map(
        (x) =>
          `<tr><td class="muted nowrap">${esc(ago(x.at, now))} ago</td><td>${esc(x.actor)}</td><td><b>${esc(x.action.replace(/_/g, " "))}</b> <span class="muted xs">${esc(x.action)}</span></td><td class="clip"><code class="muted">${esc(JSON.stringify(x.body).slice(0, 200))}</code></td></tr>`,
      )
      .join("");
    const links = [
      p.newer !== null ? `<a href="/ui/audit?after=${p.newer}">Newer</a>` : "",
      p.older !== null ? `<a href="/ui/audit?before=${p.older}">Older</a>` : "",
    ].filter(Boolean);
    return page(
      c,
      { title: "Audit log", summary: "who did what through control", active: "audit" },
      `<div class="card flat"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty">No entry here.</td></tr>`}</tbody></table></div>${links.length ? `<div class="pager">${links.join("")}</div>` : ""}`,
    );
  });

  app.get("/ui/leaderboard", (c) => {
    const board = leaderboard(store, { staleAfterMs: opts.staleAfterMs });
    const body = Object.entries(board)
      .map(([campaign, rows]) => {
        const best = Math.max(0.0001, ...rows.map((r) => r.gain));
        return `<div class="block"><div class="head"><h2>${esc(campaign)}</h2><span class="n">${rows.length} rig${rows.length > 1 ? "s" : ""}</span></div><div class="card flat"><table><thead><tr><th style="width:40px">#</th><th>Rig / run</th><th>Champion</th><th style="width:40%">Gain over its baseline</th><th>Cross-verified</th></tr></thead><tbody>${rows
          .map(
            (r, n) =>
              `<tr><td class="muted">${n + 1}</td><td>${avatar(r.rig)} <a href="${runHref(r.rig, { id: r.run, campaign })}"><b>${esc(r.rig)}</b> / ${esc(r.run)}</a></td><td class="muted">seq ${r.champion_seq}</td><td>${meter("", pct(r.gain, 2), r.gain / best, "primary")}${r.values ? `<div class="muted small">${esc(valuesPairWords(r.values))}</div>` : ""}</td>
<td>${r.verified_by.length ? `<span class="pill ok">${icon.check}by ${esc(r.verified_by.join(", "))}</span>` : `<span class="muted small">not yet</span>`}</td></tr>`,
          )
          .join("")}</tbody></table></div></div>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Leaderboard",
        summary:
          "gains against each run's own baseline, measured on its own rig; cross-verified once another rig's judge accepted it",
        active: "campaigns",
      },
      body || `<div class="card"><div class="empty">No hill climb yet.</div></div>`,
    );
  });

  // ---------------------------------------------------------------- exports (goal 103)
  // Every export control keeps, for every rig, newest first; a complete one downloads as one
  // .tar.gz. Owner only, as the whole dashboard is (its session is the owner's).
  app.get("/ui/exports", (c) => {
    const vs = views();
    const all = store.allRigExports(1000);
    const rig = c.req.query("rig") || undefined;
    const rigs = [...new Set([...all.map((e) => e.rig), ...vs.map((u) => u.id)])].sort();
    if (rig && !rigs.includes(rig)) rigs.push(rig);
    return page(
      c,
      {
        title: "Exports",
        summary: rig
          ? `the exports <a href="/ui/rigs/${encodeURIComponent(rig)}">${esc(rig)}</a> sent to control, newest first`
          : "the exports rigs sent to control, newest first",
        active: "exports",
      },
      exportsBody({
        exports: all,
        rigs,
        rig,
        kept: opts.exportFiles !== undefined,
        now: Date.now(),
      }),
      vs,
    );
  });
  app.get("/ui/exports/:rig/:name/archive", (c) =>
    archiveResponse(
      c,
      { store, files: opts.exportFiles, by: "owner:ui" },
      c.req.param("rig"),
      c.req.param("name"),
    ),
  );

  app.get("/ui/reports", (c) => {
    const now = Date.now();
    const t = csrf(c);
    const act = (id: unknown, what: string, label2: string, primary = false) =>
      `<form class="inline" method="post" action="/ui/resets/${esc(id)}/${what}"><input type="hidden" name="csrf" value="${t}"><button class="sm${primary ? " primary" : ""}">${label2}</button></form>`;
    const resets = store
      .resets(20)
      .map(
        (r) =>
          `<tr><td><b>${esc(r.rig)}</b></td><td><span class="chip ${String(r.state) === "done" ? "ok" : String(r.state) === "failed" ? "bad" : "warn"}">${esc(r.state)}</span></td><td class="clip">${esc(r.detail ?? "")}</td><td class="muted nowrap">${esc(ago(String(r.updated_at), now))} ago</td>
<td class="num">${String(r.state) === "awaiting_owner" ? act(r.id, "confirm", "Confirm the wipe", true) : ""} ${["start", "quiescing", "exporting", "verifying", "awaiting_owner"].includes(String(r.state)) ? act(r.id, "cancel", "Cancel") : ""}</td></tr>`,
      )
      .join("");
    const rows = store
      .reports(30)
      .map(
        (r) =>
          `<div class="card"><div class="card-head">${avatar(r.rig)}<span class="title">${esc(r.rig)}</span><span class="sub">${esc(r.kind)} report</span><span class="right muted small">${esc(ago(r.at, now))} ago</span></div><pre class="report" style="margin-top:10px">${esc(r.body)}</pre></div>`,
      )
      .join("");
    return page(
      c,
      {
        title: "Reports",
        summary: "daily reports from each rig's supervisor, and full resets",
        active: "reports",
      },
      `${resets ? `<div class="block"><div class="head"><h2>Full resets</h2></div><div class="card flat"><table><thead><tr><th>Rig</th><th>State</th><th>Detail</th><th>Updated</th><th></th></tr></thead><tbody>${resets}</tbody></table></div></div>` : ""}
<div class="block"><div class="head"><h2>Daily reports</h2></div>${rows || `<div class="card"><div class="empty">No daily report yet.</div></div>`}</div>`,
    );
  });

  // ---------------------------------------------------------------- actions
  /** Where a form returns: a path under /ui only (never another site). */
  const backTo = (f: Record<string, unknown>, fallback: string) => {
    const b = String(f.back ?? "");
    return b.startsWith("/ui") && !b.startsWith("//") ? b : fallback;
  };

  // ---------------------------------------------------------------- following an action (goal 080)
  // The page's script sends an action's form with fetch, asking for JSON, then follows it on these
  // routes until its outcome: a Progress (command-progress.ts) each time.
  const wantsJson = (c: Ctx) => (c.req.header("accept") ?? "").includes("application/json");
  app.get("/ui/commands/:file{.+\\.json}", (c) => {
    const cmd = store.commandRow(c.req.param("file").replace(/\.json$/, ""));
    return cmd ? c.json(commandProgress(cmd, Date.now())) : c.json({ error: "not found" }, 404);
  });
  app.get("/ui/rigs/:rig/checks/:file{.+\\.json}", (c) => {
    const rig = c.req.param("rig");
    const check = c.req.param("file").replace(/\.json$/, "");
    const known = store.rigs().find((x) => x.id === rig);
    if (!known) return c.json({ error: "not found" }, 404);
    const row = checkRows(store, rig, Date.now())[check];
    return row
      ? c.json(checkProgress(row, known.last_cursor))
      : c.json({ error: "not found" }, 404);
  });
  app.get("/ui/rigs/:rig/model.json", (c) => {
    const rig = c.req.param("rig");
    return store.rigs().some((x) => x.id === rig)
      ? c.json(modelProgress(store, rig, Date.now()))
      : c.json({ error: "not found" }, 404);
  });

  app.post("/ui/resets/:id/confirm", async (c) => {
    try {
      confirmReset(store, Number(c.req.param("id")), "owner:ui");
      await advanceResets({
        store,
        privateKeyPem: opts.privateKeyPem,
        driver: opts.driver,
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  app.post("/ui/resets/:id/cancel", (c) => {
    try {
      cancelReset(store, Number(c.req.param("id")), "owner:ui");
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  // A stuck trial the owner leaves running (goal 143): its card stays away until it is stuck again.
  app.post("/ui/trials/leave", async (c) => {
    const f = await c.req.parseBody();
    const [rig, trial, kind, since] = ["rig", "trial", "kind", "since"].map((k) =>
      String(f[k] ?? ""),
    );
    if (
      !RIG_ID.test(rig ?? "") ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(trial ?? "") ||
      // A quiet or repeating spell is known by a time; a refused page's by its address.
      !(kind === "refused"
        ? (since ?? "").length >= 1 && (since ?? "").length <= 2000
        : (kind === "quiet" || kind === "repeating") && !Number.isNaN(Date.parse(since ?? "")))
    )
      return c.text("refused: that is not a stuck trial's card", 400);
    store.leaveTrial({
      rig: String(rig),
      trial: String(trial),
      kind: String(kind),
      since: String(since),
      by: "owner:ui",
    });
    store.audit("owner:ui", "trial_left", { rig, run: String(f.run ?? ""), trial, kind, since });
    return c.redirect(backTo(f, "/ui"), 303);
  });

  app.post("/ui/propagate", async (c) => {
    const f = await c.req.parseBody();
    const [toRig, toRun] = String(f.target ?? "").split("|");
    try {
      propagateChampion(store, opts.privateKeyPem, {
        fromRig: String(f.rig),
        run: String(f.run),
        toRig: String(toRig),
        toRun: String(toRun),
        issuedBy: "owner:ui",
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    const target = views()
      .find((x) => x.id === toRig)
      ?.runs.find((x) => x.id === toRun);
    return c.redirect(
      target ? runHref(String(toRig), target) : `/ui/rigs/${encodeURIComponent(String(toRig))}`,
      303,
    );
  });

  app.post("/ui/rigs/:rig/restart", async (c) => {
    const rig = c.req.param("rig");
    // A rig on RunPod: RunPod's own driver, whatever THERMITE_LIFECYCLE says.
    if (opts.runpodDriver?.serves(rig)) {
      store.audit("owner:ui", "restart", { rig });
      const to = (k: "ok" | "error", m: string) =>
        c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}#pod`, 303);
      try {
        await opts.runpodDriver.restart(rig, ["harness", "supervisor"], "owner:ui");
      } catch (err) {
        return to("error", errorText(err));
      }
      return to("ok", "Restarting: the pod stops, then starts again.");
    }
    if (!opts.driver) return c.text("no deployment driver is configured", 409);
    store.audit("owner:ui", "restart", { rig });
    try {
      await opts.driver.restart(rig, ["harness", "supervisor"]);
    } catch (err) {
      return c.text(`restart failed: ${errorText(err)}`, 500);
    }
    return c.redirect(`/ui/rigs/${encodeURIComponent(rig)}`, 303);
  });

  app.post("/ui/rigs/:rig/reset", async (c) => {
    const rig = c.req.param("rig");
    const f = await c.req.parseBody();
    if (String(f.confirm ?? "") !== `reset ${rig}`)
      return c.text(`type "reset ${rig}" to confirm a full reset`, 400);
    // A rig on RunPod: its pod must run, with no stop, start or terminate under way.
    const onRunpod = runpodResetRefusal(store, rig);
    if (onRunpod)
      return c.redirect(
        `/ui/rigs/${encodeURIComponent(rig)}?error=${encodeURIComponent(onRunpod)}#pod`,
        303,
      );
    try {
      store.createReset(rig, "owner:ui");
      await advanceResets({
        store,
        privateKeyPem: opts.privateKeyPem,
        driver: opts.driver,
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  // ---------------------------------------------------------------- settings: model providers
  // A provider is entered once: its name, type, base URL and API key. Control lists its models from
  // the provider itself, and the owner gives each rig one of them. Control seals each key (its
  // secret box) and never shows it again; a rig receives a provider's key only when it is given
  // one of its models, through its supervisor's authenticated channel.
  const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  /** A name as the owner typed it, made to fit the rule: lowercase, with dashes for spaces. */
  const newName = (v: unknown) =>
    String(v ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");
  const TYPES: Record<ProviderType, string> = {
    openai: "OpenAI-compatible",
    anthropic: "Anthropic",
    opencode: "OpenCode",
    claude: "Claude subscription",
    chatgpt: "ChatGPT subscription",
  };
  /** How a provider's models show in the model lists: a subscription's with its program. */
  const modelPrefix = (type: ProviderType) =>
    type === "claude" ? "claude-code:" : type === "chatgpt" ? "chatgpt:" : "";
  /** The types reached with an API key (a subscription is added differently). */
  const KEY_TYPES = KEY_PROVIDER_TYPES;
  const TYPE_TIP =
    "What kind of provider it is. OpenAI-compatible covers most model servers (vLLM, LiteLLM, OpenRouter, Ollama). Anthropic is Anthropic's own API. OpenCode is OpenCode's own service, whose free models need the OpenCode harness.";
  const BASE_TIP =
    "Where the provider's API is: for an OpenAI-compatible server, the address ending in /v1. Anthropic and OpenCode: leave it empty for their own.";
  /** The add form's button and what it says happens, by type (the page script shows them). */
  const ADD_SAYS = {
    openai: [
      "Add and list its models",
      "Control seals the key and reads the provider's model list at once, and again when you press Refresh models.",
    ],
    anthropic: [
      "Add and list its models",
      "Control seals the key and reads Anthropic's model list with it.",
    ],
    opencode: [
      "Add and list its models",
      "OpenCode's free models need no key, and run only in the OpenCode harness. Control reads its model list at once.",
    ],
    gitkey: [
      "Make the key",
      "Control makes an SSH key pair and shows its public half: add it to the repository (or the account) as a read-only deploy key. The private half stays sealed in control and goes only to rigs running a campaign that uses it.",
    ],
    ssh: [
      "Add and read its host key",
      "Control reads the machine's host key for you to compare and trust. Then it logs in and reads the machine: its system, GPUs, container engine and NVIDIA's toolkit, and whether it reaches control. It changes nothing, and installs nothing unless you allow it.",
    ],
    k8s: [
      "Add and check the cluster",
      "Control reads the cluster with this kubeconfig: its version, its nodes and their GPUs, DRA device classes, storage classes, and whether it may create namespaces or deploy into the slots you name. It changes nothing.",
    ],
    runpod: [
      "Add and read the account",
      "Control seals the key and reads, with it, RunPod's GPU types with their prices and stock, its data centers, your network volumes and your pods. It starts nothing and spends nothing.",
    ],
    chatgpt: [
      "Finish the sign-in",
      "Control exchanges the code for the login, seals it and renews it from now on (only control does). Rigs whose agents use one of its models get a token that lasts one hour, renewed while they use it. Its models then show in each rig's model list as chatgpt:<model>.",
    ],
    claude: [
      "Add the subscription",
      "Control seals the token. It makes no call to Anthropic with it: only Claude Code, on the rigs whose agents use one of its models, uses it. Its models then show in each rig's model list as claude-code:<model>.",
    ],
    gittoken: [
      "Add the token",
      "Control seals the token. It goes only to rigs running a campaign that uses it. Use a token that can only read the repositories you need.",
    ],
  } satisfies Record<string, [string, string]>;
  const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
  const settingsUrl = (k: "ok" | "error", m: string) =>
    `/ui/settings?${k}=${encodeURIComponent(m)}`;
  /** Reads the provider's model list now and keeps it (or why it could not). */
  const listInto = async (p: ModelProvider): Promise<string | null> => {
    if (p.type === "chatgpt") {
      const listed = await chatgpt.models(p);
      store.setProviderModels(p.name, listed);
      return "error" in listed ? listed.error : null;
    }
    let key = "";
    try {
      // OpenCode's own provider may have no key: its list and free models need none.
      if (p.key_sealed) key = opts.secrets.open(p.key_sealed);
    } catch {
      store.setProviderModels(p.name, { error: "its key cannot be opened: enter it again" });
      return "its key cannot be opened: enter it again";
    }
    const listed = await listModels(p.type, p.base_url, key, opts.providerFetch);
    store.setProviderModels(p.name, listed);
    return "error" in listed ? listed.error : null;
  };
  const typeSelect = (sel?: ProviderType) =>
    `<select name="type">${KEY_TYPES.map((t) => `<option value="${t}"${t === sel ? " selected" : ""}>${t === "opencode" ? "OpenCode (its own models)" : TYPES[t]}</option>`).join("")}</select>`;

  app.get("/ui/settings", async (c) => {
    const now = Date.now();
    const vs = views();
    const t = csrf(c);
    const providers = store.providers();
    const usage = new Map(
      await Promise.all(providers.map(async (p) => [p.name, await planUsage.of(p)] as const)),
    );
    const gitCount =
      store.gitAccessList().length +
      store.machines().length +
      store.clusters().length +
      store.gpuClouds().length;
    const given = store.rigModels();
    /** The rigs whose workers or other agents use one of the provider's models. */
    const usersOf = (name: string) =>
      vs
        .map((u) => u.id)
        .filter(
          (rig) =>
            given[rig]?.provider === name ||
            Object.values(store.roleModels(rig)).some((r) => r?.provider === name),
        );
    // What an MCP server's form did is said in its own block (at=mcp), where the page opens.
    const atMcp = c.req.query("at") === "mcp";
    // So is what Save prices did (at=prices), in Model prices.
    const atPrices = c.req.query("at") === "prices";
    const ok = atMcp || atPrices ? undefined : c.req.query("ok");
    const error = atMcp || atPrices ? undefined : c.req.query("error");
    // Model prices (goal 075): one table under the providers, for every model not on a plan.
    const prices = modelPricesBlock({
      providers,
      owner: store.modelPrices(),
      csrf: t,
      flash: !atPrices
        ? undefined
        : c.req.query("error")
          ? { kind: "bad", text: String(c.req.query("error")) }
          : c.req.query("ok") === "saved"
            ? { kind: "saved" }
            : c.req.query("ok") === "same"
              ? { kind: "same" }
              : undefined,
    });
    const allFree = (p: ModelProvider) =>
      p.models.length > 0 && p.models.every((m) => m.price && isFree(m.price));
    const PLAN_LINE = `<div class="muted small" style="margin-top:10px">On a plan: its calls show their tokens, and “on a plan” for cost.</div>`;
    const note = error
      ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not done.</b> ${esc(error)}</div>`
      : ok
        ? `<div class="card" style="margin-bottom:16px"><b class="ok">${esc(ok)}</b></div>`
        : "";
    /** A Claude subscription: its token's hint, its models, what its rigs report of its usage. */
    const claudeRow = (p: (typeof providers)[number], rigs: string[]) => {
      const pName = encodeURIComponent(p.name);
      const windows = usageBlock("claude", usage.get(p.name), now);
      return `<details class="dq" data-k="provider-${esc(p.name)}"><summary>
<span class="dq-kind"><span class="kind m">Subscription</span></span>
<span class="dq-main"><span class="dq-head">${esc(p.name)} <span class="muted" style="font-weight:400">· Claude subscription</span></span><span class="dq-why">${p.models.length} models · runs only in Claude Code, Anthropic's own program</span><span class="dq-sub"><span class="chip">token ${esc(p.key_hint)}</span>${usageChips(usage.get(p.name))}<span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
</summary><div class="dq-body">${windows}${PLAN_LINE}
<div class="chips" style="margin:12px 0">${p.models.map((m) => `<span class="chip">claude-code:${esc(m.id)}</span>`).join("")}</div>
<form method="post" action="/ui/settings/providers" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="name" value="${esc(p.name)}"><input type="hidden" name="type" value="claude">
<label>${infoLabel("New token from claude setup-token", "A new token replaces the old one at once; control seals it and never shows it again. Tokens from claude setup-token last one year.")}<input name="claude_token" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the token ending ${esc(p.key_hint)}"></label>
<div class="form-end row" style="gap:8px"><button class="primary">Replace the token</button></div></form>
${
  rigs.length
    ? `<div class="muted small">In use: give its rigs another model before deleting it.</div>`
    : `<form class="inline" method="post" action="/ui/settings/providers/${pName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Delete this subscription</button></form>`
}</div></details>`;
    };
    /** A ChatGPT subscription: its sign-in, its models, and how to sign in again. */
    const chatgptRow = (p: (typeof providers)[number], rigs: string[]) => {
      const pName = encodeURIComponent(p.name);
      const status = p.models_error
        ? `<span class="dq-why bad">${esc(p.models_error)}</span>`
        : `<span class="dq-why">${p.models.length} model${p.models.length === 1 ? "" : "s"} · runs in Pi, OpenCode v2 or Codex · control renews the login</span>`;
      return `<details class="dq${p.models_error ? " dq-bad" : ""}" data-k="provider-${esc(p.name)}"><summary>
<span class="dq-kind"><span class="kind m">Subscription</span></span>
<span class="dq-main"><span class="dq-head">${esc(p.name)} <span class="muted" style="font-weight:400">· ChatGPT subscription</span></span>${status}<span class="dq-sub"><span class="chip">sign-in ${esc(p.key_hint)}</span>${usageChips(usage.get(p.name))}<span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
<span class="dq-side"><span class="dq-btns"><form class="inline" method="post" action="/ui/settings/providers/${pName}/refresh"><input type="hidden" name="csrf" value="${t}"><button>Refresh models</button></form></span></span>
</summary><div class="dq-body">${usageBlock("chatgpt", usage.get(p.name), now)}${PLAN_LINE}
<div class="chips" style="margin:12px 0">${p.models.map((m) => `<span class="chip">chatgpt:${esc(m.id)}</span>`).join("")}</div>
<form method="post" action="/ui/settings/add" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="name" value="${esc(p.name)}"><input type="hidden" name="type" value="chatgpt"><input type="hidden" name="chatgpt_consent" value="1">
<div style="grid-column:1/-1" class="small">To sign in again (for example after the login ended): <a href="/ui/settings/chatgpt/start?name=${pName}" target="_blank" rel="noopener">Sign in with ChatGPT ↗</a>, then paste the address the tab goes to.</div>
<label style="grid-column:1/-1">${infoLabel("The address the tab went to", `After the sign-in, the tab goes to an address that starts with ${CHATGPT_REDIRECT} and shows an error. Copy that whole address and paste it here.`)}<input name="chatgpt_url" maxlength="4096" placeholder="${esc(CHATGPT_REDIRECT)}?code=…"></label>
<div class="form-end row" style="gap:8px"><button class="primary">Finish the sign-in</button></div></form>
${
  rigs.length
    ? `<div class="muted small">In use: give its rigs another model before deleting it.</div>`
    : `<form class="inline" method="post" action="/ui/settings/providers/${pName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Sign out and delete</button></form>`
}</div></details>`;
    };
    const providerRows = providers
      .map((p) => {
        const rigs = usersOf(p.name);
        if (p.type === "claude") return claudeRow(p, rigs);
        if (p.type === "chatgpt") return chatgptRow(p, rigs);
        const status = p.models_error
          ? `<span class="dq-why bad">${esc(p.models_error)}${p.models.length ? ` (keeping its last list of ${p.models.length})` : ""}</span>`
          : `<span class="dq-why">${p.models.length} model${p.models.length === 1 ? "" : "s"}${allFree(p) ? " · free, from the provider" : ""}${p.models_at ? ` · listed ${esc(ago(p.models_at, now))} ago` : ""}</span>`;
        const list = p.models.length
          ? `<div class="chips">${p.models
              .map(
                (m) =>
                  `<span class="chip"${m.added ? ' title="added by you; the provider does not list it"' : ""}>${esc(m.id)}${m.context_window ? ` <span class="muted">· ${Math.round(m.context_window / 1000)}k</span>` : ""}${m.added ? ` <span class="muted">· yours</span>` : ""}</span>`,
              )
              .join("")}</div>`
          : "";
        const pName = encodeURIComponent(p.name);
        return `<details class="dq${p.models_error ? " dq-bad" : ""}" data-k="provider-${esc(p.name)}"><summary>
<span class="dq-kind"><span class="kind m">Models</span></span>
<span class="dq-main"><span class="dq-head">${esc(p.name)} <span class="muted" style="font-weight:400">· ${esc(TYPES[p.type])}</span></span>${status}<span class="dq-sub"><span class="dq-where">${esc(p.base_url || ANTHROPIC_BASE)}</span><span class="chip">${p.key_hint ? `key ${esc(p.key_hint)}` : "no key: its free models"}</span>${p.type === "opencode" ? `<span class="chip info">runs in the OpenCode harness</span>` : isOpencodeOwn(p) ? `<span class="chip info">OpenCode's own: its free models run in the OpenCode harness</span>` : ""}${p.base_url.startsWith("http://") ? `<span class="chip warn">not HTTPS</span>` : ""}<span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
<span class="dq-side"><span class="dq-btns"><form class="inline" method="post" action="/ui/settings/providers/${pName}/refresh"><input type="hidden" name="csrf" value="${t}"><button>Refresh models</button></form></span></span>
</summary><div class="dq-body">${list}
<form method="post" action="/ui/settings/providers/${pName}/models" class="form-grid"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("A model it does not list", "Some providers serve models their list leaves out. Add one by its id at the provider; it shows as yours.")}<input name="model" maxlength="200" placeholder="its id at the provider"></label><div class="form-end"><button>Add it</button></div></form>
<form method="post" action="/ui/settings/providers" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="name" value="${esc(p.name)}">
<label>${infoLabel("Type", TYPE_TIP)}${typeSelect(p.type)}</label>
<label>${infoLabel("Base URL", BASE_TIP)}<input name="base_url" maxlength="500" value="${esc(p.base_url)}"></label>
<label>${infoLabel("API key", "Control seals a new key at once and never shows it again. Leave it empty to keep the current one.")}<input name="api_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the key ending ${esc(p.key_hint)}"></label>
<div class="form-end row" style="gap:8px"><button class="primary">Save and list its models</button></div></form>
${
  rigs.length
    ? `<div class="muted small">In use: give its rigs another model before deleting it.</div>`
    : `<form class="inline" method="post" action="/ui/settings/providers/${pName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Delete this provider</button></form>`
}</div></details>`;
      })
      .join("");
    const models = "openai anthropic opencode";
    const addForm = `<form method="post" action="/ui/settings/add" class="form-grid" autocomplete="off" id="prov-add" data-says="${esc(JSON.stringify(ADD_SAYS))}"><input type="hidden" name="csrf" value="${t}">
<label>${infoLabel("Type", `${TYPE_TIP} Git access lets rigs fetch private repositories: a deploy key control makes, or an HTTPS token you paste. MCP servers have their own block, below.`)}<select name="type" id="ptype"><optgroup label="Models by API key">${KEY_TYPES.map((x) => `<option value="${x}">${x === "opencode" ? "OpenCode (its own models)" : TYPES[x]}</option>`).join("")}</optgroup><optgroup label="Subscriptions"><option value="claude">Claude subscription (Pro or Max)</option><option value="chatgpt">ChatGPT subscription (Plus or Pro)</option></optgroup><optgroup label="Git access"><option value="gitkey">A deploy key (control makes it)</option><option value="gittoken">An access token (HTTPS)</option></optgroup><optgroup label="Where rigs run"><option value="ssh">A machine over SSH</option><option value="k8s">A Kubernetes cluster</option><option value="runpod">RunPod (a GPU cloud)</option></optgroup></select></label>
<label>${infoLabel("Name", "How it shows in Thermite, and how rigs and campaigns refer to it: for example my-litellm or github-deploy. Letters, digits, dots, dashes and underscores: capitals become lowercase and spaces become dashes.")}<input name="name" required maxlength="64" pattern="\\s*[A-Za-z0-9][A-Za-z0-9._ \\-]*\\s*" title="Letters, digits, dots, dashes, underscores and spaces" placeholder="for example my-litellm"></label>
<label data-for="${models}">${infoLabel("Base URL", BASE_TIP)}<input name="base_url" maxlength="500" placeholder="https://…/v1 (Anthropic and OpenCode: empty for their own)"></label>
<label data-for="${models}">${infoLabel("API key", "The provider's key. Control seals it at once and never shows it again. OpenCode: leave it empty for its free models.")}<input name="api_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again"></label>
<label data-for="gittoken" hidden>${infoLabel("Token", "An access token for the Git host, read-only if the host allows. Control seals it at once and never shows it again.")}<input name="token" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again"></label>
<label data-for="gittoken" hidden>${infoLabel("User name", "The name the host expects with the token. GitHub takes x-access-token (the default); GitLab takes oauth2.")}<input name="username" maxlength="100" placeholder="x-access-token"></label>
<label data-for="ssh" hidden>${infoLabel("Address", "The machine's host name or IP address, as control reaches it.")}<input name="address" maxlength="253" placeholder="gpu-box.example.com"></label>
<label data-for="ssh" hidden>${infoLabel("SSH port", "The port its SSH server listens on: usually 22.")}<input name="port" value="22" maxlength="5"></label>
<label data-for="ssh" hidden>${infoLabel("User", "The account control logs in as. Give Thermite an account of its own if you can. It needs sudo without a password only to install what is missing, and only when you allow each install; rigs run as this user with rootless Podman.")}<input name="user" maxlength="32" placeholder="thermite"></label>
<label data-for="k8s" hidden style="grid-column:1/-1">${infoLabel("Kubeconfig", "A kubeconfig for the cluster. Control seals it at once and never shows it again. Give it only the rights the placement needs: to create namespaces and, in them, deployments, services, secrets, volume claims and network policies; or, for slots, a role in each slot.")}<textarea name="kubeconfig" class="mono" rows="4" maxlength="262144" placeholder="apiVersion: v1&#10;kind: Config&#10;…"></textarea></label>
<label data-for="k8s" hidden>${infoLabel("Context", "Which cluster and user in the kubeconfig to use. Empty: its current context.")}<input name="context" maxlength="253" placeholder="its current context"></label>
<label data-for="k8s" hidden>${infoLabel("Placement", "Where each rig goes. Namespaces control creates: one namespace per rig, with its own network rules. Slots: namespaces the cluster's operators made for Thermite, with their own quotas and rules; control only deploys into a free one.")}<select name="placement"><option value="created">A namespace control creates for each rig</option><option value="slot">Slots the cluster's operators made</option></select></label>
<label data-for="k8s" hidden>${infoLabel("Namespace for each rig", "For created namespaces: the name of each rig's namespace. {rig} becomes the rig's name.")}<input name="namespace_pattern" maxlength="63" value="thermite-{rig}"></label>
<label data-for="k8s" hidden>${infoLabel("Slots", "For slots: the slot namespaces, separated by commas. Control checks that it may deploy into each one.")}<input name="slots" maxlength="2000" placeholder="thermite-slot-1, thermite-slot-2"></label>
<div data-for="claude" hidden class="card flat" style="grid-column:1/-1;padding:12px 14px"><b>Get the token on your own computer.</b> <span class="muted small">Control cannot open Anthropic's sign-in page for you.</span><ol class="small" style="margin:8px 0 0 18px;line-height:1.7"><li>Install Claude Code there, if it is not installed: <code>npm install -g @anthropic-ai/claude-code</code></li><li>Run <code>claude setup-token</code> and sign in with your Claude account in the browser.</li><li>Copy the token it prints, and paste it below. It is good for one year.</li></ol></div>
<label data-for="claude" hidden style="grid-column:1/-1">${infoLabel("Token from claude setup-token", "The long-lived token that Claude Code prints. Control seals it at once and never shows it again. Only Claude Code, Anthropic's own program, uses it on the rigs: Anthropic does not allow other programs to use a subscription.")}<input name="claude_token" type="password" autocomplete="new-password" maxlength="4096" placeholder="sk-ant-oat01-… never shown again"></label>
<div data-for="chatgpt" hidden class="card flat" style="grid-column:1/-1;padding:12px 14px"><b>Sign in with ChatGPT, then paste one address.</b> <span class="muted small">For your own use only: a Thermite that several people use takes API keys.</span><ol class="small" style="margin:8px 0 0 18px;line-height:1.7"><li>Press <b>Sign in with ChatGPT</b>. A ChatGPT page opens in a new tab. Sign in there and allow Thermite.</li><li>The tab then goes to an address that starts with <code>${esc(CHATGPT_REDIRECT)}</code> and shows an error. That is expected: the address is for an app on your own computer.</li><li>Copy that whole address from the tab's address bar, and paste it below.</li></ol><div class="act" style="margin-top:10px"><a class="btn sm" href="/ui/settings/chatgpt/start" target="_blank" rel="noopener">Sign in with ChatGPT ↗</a></div></div>
<label data-for="chatgpt" hidden style="grid-column:1/-1">${infoLabel("The address the tab went to", `After the sign-in, the tab goes to an address that starts with ${CHATGPT_REDIRECT} and shows an error. Copy that whole address and paste it here. It holds a one-time code that control exchanges for the login; it works for a few minutes only.`)}<input name="chatgpt_url" maxlength="4096" placeholder="${esc(CHATGPT_REDIRECT)}?code=…"></label>
<label data-for="chatgpt" hidden style="grid-column:1/-1">${infoLabel("Unattended use", "OpenAI asks apps to get your consent before they use your plan when you are not there. Thermite's agents work for hours without you: workers, the planner and the advisors, on the rigs you give its models.")}<span class="row small" style="gap:8px"><input type="checkbox" name="chatgpt_consent" value="1" style="height:auto;width:auto"> I allow Thermite's agents to use my ChatGPT plan when I am not there, for my own research.</span></label>
<label data-for="runpod" hidden>${infoLabel("RunPod API key", "A key from RunPod's console (Settings, API Keys). Control seals it at once and never shows it again. Control reads the account with it, and starts test pods only when you ask: for those the key must be allowed to write.")}<input name="runpod_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again"></label>
<label data-for="ssh" hidden style="grid-column:1/-1">${infoLabel("Private key", "The SSH private key for that user, without a passphrase. Control seals it at once and never shows it again. Leave it empty and control makes a key: add its public half, shown next, to the user's ~/.ssh/authorized_keys on the machine.")}<textarea name="private_key" class="mono" rows="4" maxlength="16384" placeholder="empty: control makes a key"></textarea></label>
<div class="nc-does" id="pdo" style="grid-column:1/-1"><b>What happens.</b> ${ADD_SAYS.openai[1]}</div>
<div class="form-end"><button class="primary" id="padd">${ADD_SAYS.openai[0]}</button></div></form>`;
    const options = (want: { provider: string; model: string } | undefined) =>
      `<option value=""${want ? "" : " selected"}>its own settings</option>${providers
        .filter((p) => p.models.length)
        .map(
          (p) =>
            `<optgroup label="${esc(p.name)}${p.type === "claude" ? " (Claude subscription: runs in Claude Code)" : p.type === "chatgpt" ? " (ChatGPT subscription: Pi, OpenCode or Codex)" : p.type === "opencode" ? " (OpenCode harness only)" : isOpencodeOwn(p) ? " (free models: OpenCode harness only)" : ""}">${p.models
              .map(
                (m) =>
                  `<option value="${esc(`${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`)}"${want?.provider === p.name && want.model === m.id ? " selected" : ""}>${modelPrefix(p.type)}${esc(m.id)}</option>`,
              )
              .join("")}</optgroup>`,
        )
        .join("")}`;
    const rigRows = vs
      .map((u) => {
        const m = u.model;
        const want = given[u.id];
        // A cap on the model's context window (goal 070), once the rig runs that model.
        const capped =
          want?.contextCap && m?.name === want.provider && m.model === want.model
            ? capWords(
                store.provider(want.provider)?.models.find((x) => x.id === want.model)
                  ?.context_window ?? 0,
                want.contextCap,
              )
            : undefined;
        // Its compaction point (goal 070), with the model it was set with.
        const compacts =
          want && m?.name === want.provider && m.model === want.model
            ? ` Its conversations are compacted at ${compactAtWords(want.compactAt)}.`
            : "";
        const uses = !m
          ? "Its harness does not report its model (it needs a newer image)."
          : m.source === "control"
            ? `Its agents run under ${HARNESS_NAMES[m.harness]} with ${m.model} from ${m.name}.${capped ? ` Its context window: ${capped}.` : ""}${compacts}`
            : m.source === "environment"
              ? `Its agents use the rig's own settings (${m.model}, under ${HARNESS_NAMES[m.harness]}).`
              : "Its agents have no model: they wait.";
        const taking = takingModel(m, want);
        const moving = !taking
          ? ""
          : want
            ? ` <span class="chip info">taking ${esc(want.model)} under ${esc(HARNESS_NAMES[want.harness])}</span>`
            : ` <span class="chip info">going back to its own settings</span>`;
        // The model check in its state now: sent, running, its result, or why it did not run.
        const chk =
          checkRowsOf(store, u.id, u.checks, now).model ??
          checkRow("model", undefined, undefined, now);
        const waits = checkWaits(chk);
        const bad = chk.state === "failed" || chk.state === "refused" || chk.state === "expired";
        // The page follows the rig while it takes the model, then its check (goal 080).
        const follow = taking
          ? ` data-follow="${esc(modelFollowUrl(u.id))}" data-follow-state="taking"`
          : waits
            ? ` data-follow="${esc(checkFollowUrl(u.id, "model"))}" data-follow-state="${chk.state}"`
            : "";
        return `<div class="ck rr-route"${follow}><span class="ck-res"><a href="/ui/rigs/${encodeURIComponent(u.id)}"><b>${esc(u.id)}</b></a></span><span class="ck-main"><span>${esc(uses)}${moving}</span><span class="ck-sum ${bad ? "bad" : ""}">${modelCheckHtml(chk, now)}</span></span><span class="route-acts"><form class="inline" method="post" action="/ui/settings/rigs" data-act><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="rig" value="${esc(u.id)}"><select name="harness" class="harness" aria-label="harness for ${esc(u.id)}">${HARNESSES.map((h) => `<option value="${h}"${(want?.harness ?? "pi") === h ? " selected" : ""}>${HARNESS_NAMES[h]}</option>`).join("")}</select><select name="choice" aria-label="model for ${esc(u.id)}">${options(want)}</select><button>Use</button></form>${cmdForm(c, { rig: u.id, kind: "rig_check", fields: { check: "model" }, label: "Check", back: "/ui/settings", disabled: waits })}</span></div>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Providers",
        active: "settings",
        crumbs: [{ href: "/ui/settings", text: "Settings" }],
      },
      `<p class="run-said">Providers are what Thermite uses: model providers serve the agents' models, Git access lets rigs fetch private repositories, and machines, clusters and GPU clouds are where rigs run. MCP servers give the agents tools from outside Thermite. Add each once with its sign-in or key. Control seals every secret, never shows it again, and gives a rig only what it uses. Then choose, for each rig, the harness its agents run in (Pi, OpenCode v2, Claude Code or Codex) and their model.</p>
${note}
<div class="block"><div class="head"><h2>Providers</h2><span class="n">${providers.length + gitCount}</span><span class="right">models are read from each provider itself</span></div>${providers.length + gitCount ? `<div class="dqs">${providerRows}${gitRows(t)}${machineRows(t)}${clusterRows(t)}${cloudRows(t)}</div>` : `<div class="card"><div class="empty">No provider yet: add one below.</div></div>`}</div>
${prices}
<div class="block"><div class="head"><h2>Add a provider</h2></div><div class="card">${addForm}</div></div>
${mcpSettingsBlocks(store, mcpServers, t, now, (k) => c.req.query(k))}
<div class="block" data-part="routes"><div class="head"><h2>Harness and model for each rig</h2><span class="right">a rig takes a change within a minute; then check it</span></div><div class="card flat">${rigRows || `<div class="empty">No rig has reported yet.</div>`}</div></div>
<script src="/ui/assets/providers.js" defer></script>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- Git access (Settings)
  const ACCESS_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const gitRows = (t: string) =>
    store
      .gitAccessList()
      .map((g) => {
        const users = store.campaignsUsingGitAccess(g.name);
        const gName = encodeURIComponent(g.name);
        const ssh = g.kind === "ssh";
        return `<details class="dq" data-k="git-${esc(g.name)}"><summary>
<span class="dq-kind"><span class="kind g">Git access</span></span>
<span class="dq-main"><span class="dq-head">${esc(g.name)} <span class="muted" style="font-weight:400">· ${ssh ? "SSH deploy key" : "HTTPS token"}</span></span><span class="dq-why">${ssh ? `fingerprint ${esc(g.fingerprint ?? "")}` : `token ${esc(g.hint)}${g.username ? ` · user ${esc(g.username)}` : ""}`}</span><span class="dq-sub"><span class="dq-where">${ssh ? "for ssh:// and git@host:path addresses" : "for https:// addresses"}</span><span class="dq-where">${users.length ? `used by ${users.map((x) => esc(x)).join(", ")}` : "no campaign uses it"}</span></span></span>
</summary><div class="dq-body">${
          ssh && g.public_key
            ? `<div class="muted small" style="margin:0 0 4px">Add this public key to the repository (or the account) as a <b>read-only</b> deploy key. Its private half stays sealed in control.</div><pre class="json" style="white-space:pre-wrap;word-break:break-all">${esc(g.public_key)}</pre>`
            : ""
        }
<form method="post" action="/ui/settings/git/${gName}/test" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("Try it on a repository", `Control reads the repository's branches with this ${ssh ? "key" : "token"}, as a rig would fetch it, and says what it found. Nothing is changed or kept.`)}<input name="url" required maxlength="500" placeholder="${ssh ? "git@github.com:you/project.git" : "https://github.com/you/project.git"}"></label><div class="form-end"><button>Try it</button></div></form>${
          ssh
            ? ""
            : `
<form method="post" action="/ui/settings/git/${gName}/token" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("New token", "Replaces the token under the same name, so campaigns that use it keep working. Control seals it at once and never shows it again.")}<input name="token" type="password" autocomplete="new-password" maxlength="4096" required placeholder="replaces the token ending ${esc(g.hint)}"></label><div class="form-end"><button class="primary">Replace the token</button></div></form>`
        }
${
  users.length
    ? `<div class="muted small">In use by ${users.map((x) => esc(x)).join(", ")}: their runs fetch with it, so it can't be deleted.</div>`
    : `<form class="inline" method="post" action="/ui/settings/git/${gName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Delete this Git access</button></form>`
}</div></details>`;
      })
      .join("");
  // ---------------------------------------------------------------- machines (Providers)
  // A machine control sets rigs up on, over SSH. Its host key is trusted once by the owner;
  // its facts come from a read-only check (machines/facts.ts).
  const ssh = opts.machineSsh ?? openSsh;
  const kib = (n: number) => `${Math.round(n / 1024 / 1024)} GB`;
  const machineFacts = (m: Machine, t: string) => {
    const f = m.facts as MachineFacts | null;
    if (!f) return "";
    const need = missing(f);
    const installs = store.machineInstalls(m.name);
    const running = installs.find((i) => i.started_at && !i.finished_at);
    const last = installs.find((i) => i.finished_at);
    const mName = encodeURIComponent(m.name);
    // Each missing piece: what control would run, and the owner's yes or no.
    const asks = running
      ? `<div class="card" style="margin-top:10px"><b>Installing ${esc(RECIPES[running.recipe as RecipeId]?.title ?? running.recipe)}</b>, as ${esc(running.approved_by)} allowed ${esc(ago(running.approved_at, Date.now()))} ago. This page shows when it is done.</div>`
      : need
          .map((id) => {
            const r = RECIPES[id];
            const s = recipeScript(id, f);
            if ("error" in s)
              return `<div class="card warn" style="margin-top:10px"><b>${esc(r.title)} is missing.</b> ${esc(r.why)} Control won't install it: ${esc(s.error)}.</div>`;
            return `<div class="card warn" style="margin-top:10px"><b>May control install ${esc(r.title)}?</b> ${esc(r.why)} Control would run exactly this on ${esc(m.name)}, and nothing else:<pre class="json" style="white-space:pre-wrap;margin:8px 0">${esc(s.script)}</pre><div class="act"><form class="inline" method="post" action="/ui/settings/machines/${mName}/install"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="recipe" value="${id}"><input type="hidden" name="sha" value="${scriptSha(s.script)}"><button class="sm primary">Install it</button></form><form class="inline" method="post" action="/ui/settings/machines/${mName}/decline"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="recipe" value="${id}"><button class="sm">Don't install: I'll do it myself</button></form></div><div class="muted small" style="margin-top:6px">Your yes is recorded with your name, for this script on this machine, and used once.</div></div>`;
          })
          .join("");
    const lastRun = last
      ? `<div class="muted small" style="margin-top:10px">Last install: ${esc(RECIPES[last.recipe as RecipeId]?.title ?? last.recipe)}, allowed by ${esc(last.approved_by)}, ${last.ok ? `<span class="chip ok">done</span>` : `<span class="chip bad">failed</span>`} ${esc(ago(last.finished_at ?? "", Date.now()))} ago.${last.ok ? "" : `</div><pre class="json" style="white-space:pre-wrap;max-height:200px;overflow:auto">${esc(last.output ?? "")}</pre><div>`}</div>`
      : "";
    const yes = (ok: boolean, text: string) =>
      `<span class="chip ${ok ? "ok" : "warn"}">${esc(text)}</span>`;
    const control = !opts.publicUrl
      ? `<span class="muted">control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL), so this was not checked</span>`
      : `${esc(opts.publicUrl)} ${yes(f.reaches_control === "200", f.reaches_control === "200" ? "reached" : `not reached (${f.reaches_control ?? "no answer"})`)}`;
    return `<dl class="facts" style="margin-top:4px">
<dt>System</dt><dd>${esc(f.os)} · kernel ${esc(f.kernel)} · ${esc(f.arch)} · ${f.cpus} CPUs · ${kib(f.mem_kib)} memory · ${kib(f.disk_free_kib)} free for ${esc(f.user)}</dd>
<dt>GPUs</dt><dd>${
      f.gpus.length
        ? `${f.gpus.map((g) => `GPU ${g.index}: ${esc(g.name)}, ${Math.round(g.memory_mib / 1024)} GB, ${g.busy_pct}% busy, ${g.used_mib} MiB in use`).join("<br>")}<br><span class="muted">driver ${esc(f.driver ?? "?")} · CUDA ${esc(f.cuda ?? "?")}</span>`
        : `none: rigs here measure on the CPU`
    }</dd>
<dt>Containers</dt><dd>${f.podman ? yes(true, `Podman ${f.podman}`) : yes(false, "Podman missing")}${f.docker ? ` <span class="muted">Docker ${esc(f.docker)} (rigs use Podman)</span>` : ""}${f.gpus.length ? ` ${yes(Boolean(f.nvidia_ctk && f.cdi), f.nvidia_ctk ? (f.cdi ? `NVIDIA container toolkit ${f.nvidia_ctk} · CDI` : "NVIDIA container toolkit, no CDI spec") : "NVIDIA container toolkit missing")}` : ""}</dd>
<dt>Services</dt><dd>${f.systemd ? `systemd ${esc(f.systemd)}` : yes(false, "no systemd: control runs rigs as systemd services, so a rig can't run here")}${f.root || f.linger === undefined ? "" : ` · ${f.linger ? yes(true, "lingering on") : yes(false, "lingering off: rigs would stop when the user logs out")}`}</dd>
<dt>Rights</dt><dd>${f.root ? "root" : f.sudo ? "sudo without a password (used only for installs you allow)" : "no sudo: control can't install anything, only report what is missing"}</dd>
<dt>Reaches control</dt><dd>${control}</dd>
</dl>${need.length ? `<div class="muted" style="margin-top:10px"><b>Missing for a rig:</b> ${need.map((x) => esc(RECIPES[x].title)).join("; ")}.</div>` : ""}${asks}${lastRun}`;
  };
  const machineRows = (t: string) =>
    store
      .machines()
      .map((m) => {
        const mName = encodeURIComponent(m.name);
        const trusted = m.host_keys.length > 0;
        const f = m.facts as MachineFacts | null;
        const changed =
          trusted &&
          m.seen_host_keys.length > 0 &&
          m.seen_host_keys.join("\n") !== m.host_keys.join("\n");
        const keyList = (lines: string[]) =>
          lines
            .map((l) => {
              const [, type, key] = l.split(/\s+/);
              return `<code>${esc(fingerprintOf(key ?? ""))}</code> <span class="muted">(${esc((type ?? "").replace(/^ssh-/, "").toUpperCase())})</span>`;
            })
            .join("<br>");
        const status = !trusted
          ? `<span class="dq-why bad">its host key is not trusted yet: open it to compare and trust it</span>`
          : m.check_error
            ? `<span class="dq-why bad">${esc(m.check_error)}${f ? " (showing the last check)" : ""}</span>`
            : f
              ? `<span class="dq-why">${esc(factsLine(f))}${m.checked_at ? ` · checked ${esc(ago(m.checked_at, Date.now()))} ago` : ""}</span>`
              : `<span class="dq-why">not checked yet</span>`;
        const form = (action: string, label: string, primary = false, extra = "") =>
          `<form class="inline" method="post" action="/ui/settings/machines/${mName}/${action}"><input type="hidden" name="csrf" value="${t}">${extra}<button class="sm${primary ? " primary" : ""}">${label}</button></form>`;
        const trust = (lines: string[], label: string) =>
          form(
            "trust",
            label,
            true,
            `<input type="hidden" name="seen" value="${esc(lines.join("\n"))}">`,
          );
        const hostKey = !trusted
          ? m.seen_host_keys.length
            ? `<div class="card warn" style="margin-bottom:10px"><b>Check the host key.</b> The machine presented:<br>${keyList(m.seen_host_keys)}<br>If you know its fingerprint (on the machine: <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>), compare it. Control pins these keys, and later refuses a machine that presents another. <div class="act" style="margin-top:8px">${trust(m.seen_host_keys, "It matches: trust it")}${form("scan", "Read it again")}</div></div>`
            : `<div class="card warn" style="margin-bottom:10px"><b>No SSH server answered</b> at ${esc(m.address)} port ${m.port}. <div class="act" style="margin-top:8px">${form("scan", "Read its host key again")}</div></div>`
          : changed
            ? `<div class="card warn" style="margin-bottom:10px"><b>The machine now presents a different host key:</b><br>${keyList(m.seen_host_keys)}<br>If the machine was reinstalled, compare it and trust the new key. If not, someone may be in between: don't. <div class="act" style="margin-top:8px">${trust(m.seen_host_keys, "Trust the new key")}</div></div>`
            : "";
        return `<details class="dq${!trusted || m.check_error ? " dq-bad" : ""}" data-k="machine-${esc(m.name)}"${!trusted ? " open" : ""}><summary>
<span class="dq-kind"><span class="kind r">Machine</span></span>
<span class="dq-main"><span class="dq-head">${esc(m.name)} <span class="muted" style="font-weight:400">· SSH</span></span>${status}<span class="dq-sub"><span class="dq-where">${esc(m.user)}@${esc(m.address)}${m.port === 22 ? "" : `:${m.port}`}</span><span class="chip">key ${esc(m.key_fingerprint.slice(-6))}</span>${trusted ? `<span class="dq-where">host key ${esc(fingerprintOf(m.host_keys[0]?.split(/\s+/)[2] ?? "").slice(0, 19))}…</span>` : ""}</span></span>
<span class="dq-side"><span class="dq-btns">${trusted ? form("check", "Check again") : ""}</span></span>
</summary><div class="dq-body">${hostKey}${machineFacts(m, t)}
<div class="muted small" style="margin:10px 0 4px">Control logs in as ${esc(m.user)} with this key. Put this line in that user's <code>~/.ssh/authorized_keys</code> on the machine: <code>restrict</code> turns off forwarding and terminals, which control does not use.</div><pre class="json" style="white-space:pre-wrap;word-break:break-all">restrict ${esc(m.public_key)}</pre>
${form("delete", "Delete this machine", false).replace('class="sm"', 'class="sm danger"')}</div></details>`;
      })
      .join("");
  const machineUrl = (k: "ok" | "error", m: string) => settingsUrl(k, m);

  // ---------------------------------------------------------------- clusters (Providers)
  // A Kubernetes cluster control sets rigs up on, with its kubeconfig sealed. Its facts come from
  // a read-only check (clusters/facts.ts).
  const kube = opts.clusterKubectl ?? realKubectl;
  const NS = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const clusterTarget = (c: Cluster & { kubeconfig_sealed: string }) => ({
    kubeconfig: opts.secrets.open(c.kubeconfig_sealed),
    context: c.context || undefined,
  });
  const checkClusterNow = async (name: string): Promise<string | null> => {
    const c = store.cluster(name);
    if (!c) return "no such cluster";
    try {
      store.setClusterFacts(name, { facts: await checkCluster(kube, clusterTarget(c), c.slots) });
      return null;
    } catch (err) {
      const why = errorText(err);
      store.setClusterFacts(name, { error: why });
      return why;
    }
  };
  const clusterRows = (t: string) =>
    store
      .clusters()
      .map((k) => {
        const f = k.facts as ClusterFacts | null;
        const kName = encodeURIComponent(k.name);
        const rigsHere = store.clusterRigs(k.name).filter((r) => r.status !== "removed");
        const status = k.check_error
          ? `<span class="dq-why bad">${esc(k.check_error)}${f ? " (showing the last check)" : ""}</span>`
          : f
            ? `<span class="dq-why">${esc(clusterLine(f))}${k.checked_at ? ` · checked ${esc(ago(k.checked_at, Date.now()))} ago` : ""}</span>`
            : `<span class="dq-why">not checked yet</span>`;
        const where =
          k.placement === "created"
            ? `a namespace for each rig: ${k.namespace_pattern}`
            : `slots: ${k.slots.join(", ") || "none named"}`;
        const yes = (ok: boolean, text: string) =>
          `<span class="chip ${ok ? "ok" : "warn"}">${esc(text)}</span>`;
        const facts = f
          ? `<dl class="facts"><dt>Version</dt><dd>${esc(f.version)}</dd><dt>Nodes</dt><dd>${
              f.nodes
                .map(
                  (n) =>
                    `${esc(n.name)}: ${n.ready ? "ready" : `<span class="bad">not ready</span>`}, ${esc(n.cpu)} CPUs, ${esc(n.memory)} memory${n.gpus ? `, <b>${n.gpus} GPU${n.gpus === 1 ? "" : "s"}</b>${n.gpu_product ? ` (${esc(n.gpu_product)})` : ""}` : ""}`,
                )
                .join("<br>") || "none listed (the kubeconfig may not read nodes)"
            }</dd><dt>GPUs</dt><dd>${f.nodes.some((n) => n.gpus) ? yes(true, "NVIDIA's device plugin") : yes(false, "no device-plugin GPUs")} ${f.device_classes.length ? yes(true, `DRA: ${f.device_classes.join(", ")}`) : `<span class="muted">no DRA device classes</span>`}</dd><dt>Storage</dt><dd>${f.storage_classes.map((s) => `${esc(s.name)}${s.default ? " (default)" : ""}`).join(", ") || yes(false, "no storage class")}</dd><dt>Placement</dt><dd>${
              k.placement === "created"
                ? f.can_create_namespaces
                  ? yes(true, "control may create namespaces")
                  : yes(
                      false,
                      "control may not create namespaces: use slots, or give the kubeconfig that right",
                    )
                : f.slots
                    .map(
                      (s) =>
                        `${esc(s.namespace)}: ${s.usable ? (s.used_by ? `used by rig ${esc(s.used_by)}` : s.network_ok === false ? yes(false, `refused: ${s.network_why ?? "its network rules don't keep the harness off the cluster"}`) : yes(true, "free")) : yes(false, "control may not deploy here")}`,
                    )
                    .join("<br>") || "no slots named"
            }</dd></dl>`
          : "";
        const form = (action: string, label: string, cls = "sm") =>
          `<form class="inline" method="post" action="/ui/settings/clusters/${kName}/${action}"><input type="hidden" name="csrf" value="${t}"><button class="${cls}">${label}</button></form>`;
        return `<details class="dq${k.check_error ? " dq-bad" : ""}" data-k="cluster-${esc(k.name)}"><summary>
<span class="dq-kind"><span class="kind r">Cluster</span></span>
<span class="dq-main"><span class="dq-head">${esc(k.name)} <span class="muted" style="font-weight:400">· Kubernetes</span></span>${status}<span class="dq-sub"><span class="dq-where">${esc(k.context || "its current context")}</span><span class="dq-where">${esc(where)}</span><span class="dq-where">${rigsHere.length ? `runs ${rigsHere.map((r) => esc(r.rig)).join(", ")}` : "no rig yet"}</span></span></span>
<span class="dq-side"><span class="dq-btns">${form("check", "Check again")}</span></span>
</summary><div class="dq-body">${facts}${
          k.placement === "slot"
            ? `<form method="post" action="/ui/settings/clusters/${kName}/slots" class="form-grid" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}"><label style="grid-column:1/-1">${infoLabel("Slots", "The namespaces the cluster's operators made for Thermite, which control may use, one rig each: names separated by commas or spaces. Control reads each one again when you save.")}<input name="slots" value="${esc(k.slots.join(", "))}"></label><div class="form-end"><button>Save the slots</button></div></form>`
            : ""
        }${
          rigsHere.length
            ? `<div class="muted small" style="margin-top:10px">In use by ${rigsHere.map((r) => esc(r.rig)).join(", ")}: remove those rigs before deleting it.</div>`
            : `<div style="margin-top:10px">${form("delete", "Delete this cluster", "sm danger")}</div>`
        }</div></details>`;
      })
      .join("");
  const addCluster = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = newName(f.name);
    const kubeconfig = String(f.kubeconfig ?? "").trim();
    let context = String(f.context ?? "").trim();
    const placement = f.placement === "slot" ? "slot" : "created";
    const pattern = String(f.namespace_pattern ?? "").trim() || "thermite-{rig}";
    const slots = String(f.slots ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (!ACCESS_NAME.test(name))
      return fail("A cluster's name is lowercase letters, digits, dots and dashes.");
    if (store.cluster(name)) return fail(`"${name}" exists already.`);
    if (!kubeconfig) return fail("Paste the cluster's kubeconfig.");
    if (!pattern.includes("{rig}") || !NS.test(pattern.replace("{rig}", "rig")))
      return fail("The namespace for each rig must contain {rig} and make a valid namespace name.");
    if (placement === "slot" && !slots.length) return fail("Name the slots, separated by commas.");
    const bad = slots.find((s) => !NS.test(s));
    if (bad) return fail(`"${bad}" is not a namespace name.`);
    let contexts: { contexts: string[]; current: string };
    try {
      contexts = await kube.contextsOf(kubeconfig);
    } catch (err) {
      return fail(errorText(err));
    }
    const seen = await inspectKubeconfig(kube, kubeconfig);
    if (seen.problems.length) return fail(`Not added: ${seen.problems.join("; ")}.`);
    if (context && !contexts.contexts.includes(context))
      return fail(
        `The kubeconfig has no context "${context}": it has ${contexts.contexts.join(", ") || "none"}.`,
      );
    if (!context) context = contexts.current;
    if (!context || !KUBE_NAME.test(context))
      return fail("The kubeconfig has no current context: name one.");
    store.addCluster({
      name,
      kubeconfig_sealed: opts.secrets.seal(kubeconfig),
      context,
      placement,
      namespace_pattern: pattern,
      slots,
      by: "owner:ui",
    });
    const why = await checkClusterNow(name);
    const careful = seen.warnings.length ? ` Note: ${seen.warnings.join("; ")}.` : "";
    return c.redirect(
      why
        ? settingsUrl("error", `"${name}" is added, but the check failed: ${why}${careful}`)
        : settingsUrl(
            "ok",
            `"${name}" is added and checked: see what control found below.${careful}`,
          ),
      303,
    );
  };
  app.post("/ui/settings/clusters/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!store.cluster(name)) return c.redirect(settingsUrl("error", "No such cluster."), 303);
    const why = await checkClusterNow(name);
    return c.redirect(
      why ? settingsUrl("error", `"${name}": ${why}`) : settingsUrl("ok", `Read "${name}" again.`),
      303,
    );
  });
  /** A cluster of slots gets a new list of slots, and is read again. */
  const setClusterSlots = async (name: string, slots: string[], by: string) => {
    const k = store.cluster(name);
    if (!k) return "no such cluster";
    if (k.placement !== "slot")
      return `${name} puts rigs in namespaces control creates, not in slots`;
    const bad = slots.find((x) => !NS.test(x));
    if (bad) return `"${bad}" is not a namespace name`;
    const using = store
      .clusterRigs(name)
      .filter((r) => r.status !== "removed" && !slots.includes(r.namespace));
    if (using.length)
      return `${using.map((r) => r.namespace).join(", ")} still holds a rig (${using.map((r) => r.rig).join(", ")}): keep it in the list`;
    store.setClusterSlots(name, [...new Set(slots)], by);
    return await checkClusterNow(name);
  };
  if (opts.actions) opts.actions.setClusterSlots = setClusterSlots;
  if (opts.actions) {
    // One agent's model over MCP and REST (goal 029), through Edit rig's own code for its row.
    opts.actions.setRigModel = async (rig, r, by) => {
      if (!views().some((u) => u.id === rig)) return { error: `no rig ${rig}` };
      const shape = rigModelShapeRefusal(r);
      if (shape) return { error: shape };
      const agent = r.agent ?? "workers";
      const choice = r.clear
        ? ""
        : `${encodeURIComponent(r.provider ?? "")}|${encodeURIComponent(r.model ?? "")}`;
      if (agent === "workers") {
        if (!choice) {
          clearRigModel(rig, by);
          return {
            ok: `${rig} goes back to its own settings within a minute.`,
            contextWindow: null,
            agents: agentModelsOf(store, rig),
          };
        }
        // A harness named is refused in words when it cannot run the model (goal 073); none,
        // what the model needs.
        const wp = store.provider(r.provider ?? "");
        if (wp && r.harness) {
          const refused = harnessRefusal(wp, r.model ?? "", r.harness, "the workers");
          if (refused) return { error: refused };
        }
        // MCP and REST set what they are asked: no context_window removes a cap, and no
        // compact_at a compaction point (the default applies).
        const given = giveRigModel(
          rig,
          choice,
          r.harness ?? harnessFor(choice, ""),
          r.effort,
          by,
          r.contextWindow ?? null,
          r.compactAt ?? null,
        );
        if ("error" in given) return given;
        return {
          ok: given.ok,
          contextWindow: given.contextWindow || null,
          compactAt: given.compactAt ?? null,
          agents: agentModelsOf(store, rig),
        };
      }
      // The other agents (goal 074): each place the request changes, the teachers' second and
      // merged by models too, all checked before any is saved. The harness named, else what the
      // model needs (goal 073): MCP and REST set what they are asked. So are each model's own cap
      // and point, set anew by each call as the workers' are (goal 070).
      const plans: AgentModelPlan[] = [];
      for (const change of rigModelChanges(r)) {
        if (change.role === "workers") continue;
        const c = change.choice;
        const cp = c ? store.provider(c.provider) : undefined;
        const plan = c
          ? checkAgentModel(
              rig,
              change.role,
              `${encodeURIComponent(c.provider)}|${encodeURIComponent(c.model)}`,
              c.effort,
              c.harness ?? (cp ? neededHarness(cp, c.model) : undefined),
              c.contextWindow ?? null,
              c.compactAt ?? null,
            )
          : checkAgentModel(rig, change.role, "", undefined);
        if ("error" in plan) return plan;
        plans.push(plan);
      }
      // A second teacher needs a first one: given in this call, or one the teachers have.
      if (
        plans.some((p) => p.role === "second_teacher" && !p.clear) &&
        !plans.some((p) => p.role === "teachers" && !p.clear) &&
        !store.roleModels(rig).teachers
      )
        return {
          error:
            "The teachers have no model of their own yet: give a provider and a model for the first teacher too.",
        };
      // Several models in one call: the words say whose window and point each one is.
      const several = plans.filter((p) => !p.clear).length > 1;
      const given = plans.map((p) =>
        applyAgentModel(rig, p, by, several ? ROLE_WORDS[p.role].whose : "Its"),
      );
      // The model the call gave the agent itself (the first teacher's, for the teachers).
      const own = r.clear || !r.provider ? undefined : given[0];
      const said =
        r.agent === "teachers" && r.clear ? [ROLE_WORDS.teachers.cleared] : given.map((g) => g.ok);
      const old =
        r.agent === "combiner" || r.agent === "panel" ? `${OLD_AGENT_NAMES[r.agent]} ` : "";
      return {
        ok: `${old}Control sent ${listText(said)} to ${rig}. The rig takes the change in less than one minute.${given.map((g) => g.words).join("")}`,
        contextWindow: own?.contextWindow || null,
        compactAt: own?.compactAt ?? null,
        agents: agentModelsOf(store, rig),
      };
    };
    opts.actions.rigModels = (rig) =>
      views().some((u) => u.id === rig) ? agentModelsOf(store, rig) : { error: `no rig ${rig}` };
  }
  app.post("/ui/settings/clusters/:name/slots", async (c) => {
    const name = c.req.param("name");
    const f = await c.req.parseBody();
    const slots = String(f.slots ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const why = await setClusterSlots(name, slots, "owner:ui");
    return c.redirect(
      why
        ? settingsUrl("error", `"${name}": ${why}.`)
        : settingsUrl(
            "ok",
            `"${name}" now has ${slots.length} slot${slots.length === 1 ? "" : "s"}, read again.`,
          ),
      303,
    );
  });
  app.post("/ui/settings/clusters/:name/delete", (c) => {
    const name = c.req.param("name");
    if (store.clusterRigs(name).some((r) => r.status !== "removed"))
      return c.redirect(settingsUrl("error", `"${name}" still runs rigs: remove them first.`), 303);
    return c.redirect(
      store.deleteCluster(name, "owner:ui")
        ? settingsUrl("ok", `"${name}" is deleted: control keeps nothing of its kubeconfig.`)
        : settingsUrl("error", "No such cluster."),
      303,
    );
  });

  // ---------------------------------------------------------------- GPU clouds (Providers)
  // RunPod, read with the owner's key (runpod.ts): GPU types, prices and stock, data centers,
  // network volumes and pods. Control starts nothing there yet.
  const checkCloudNow = async (name: string): Promise<string | null> => {
    const g = store.gpuCloud(name);
    if (!g) return "no such GPU cloud";
    let key: string;
    try {
      key = opts.secrets.open(g.key_sealed);
    } catch {
      store.setGpuCloudFacts(name, { error: "its key cannot be opened: enter it again" });
      return "its key cannot be opened: enter it again";
    }
    try {
      store.setGpuCloudFacts(name, { facts: await readRunpod(key, opts.cloudFetch) });
      return null;
    } catch (err) {
      const why = errorText(err);
      store.setGpuCloudFacts(name, { error: why });
      return why;
    }
  };
  const usd = (n: number | null) => (n === null ? "–" : `$${n.toFixed(2)}`);
  const STOCK: Record<string, string> = {
    HIGH: "high",
    MEDIUM: "medium",
    LOW: "low",
    NONE: "none",
  };
  // Test pods: the quick form, and each test with what it found.
  const testPodForm = (gName: string, f: RunpodFacts | null, t: string) => {
    const cheapest = f ? cheapestGpu(f, "SECURE") : undefined;
    const options = (f?.gpus ?? [])
      .filter((x) => x.secure || x.community)
      .map(
        (x) =>
          `<option value="${esc(x.id)}" data-secure="${x.secure ? (x.price_secure ?? "") : ""}" data-community="${x.community ? (x.price_community ?? "") : ""}">${esc(x.name)} · ${x.memory_gb} GB · Secure ${x.secure ? usd(x.price_secure) : "–"}, Community ${x.community ? usd(x.price_community) : "–"}${x.availability ? ` · Secure stock ${esc(STOCK[x.availability] ?? x.availability)}` : ""}</option>`,
      )
      .join("");
    return `<form method="post" action="/ui/settings/clouds/${gName}/test" class="form-grid" data-test-pod autocomplete="off" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}">
<label>${infoLabel("GPU", "The GPU type of the test pod. The cheapest in stock is enough: the test checks the platform, not speed.")}<select name="gpu"><option value="" data-secure="${cheapest?.price_secure ?? ""}" data-community="">${cheapest ? `The cheapest in stock: ${esc(cheapest.name)}` : "The cheapest in stock"}</option>${options}</select></label>
<label>${infoLabel("Cloud", "Secure cloud runs in RunPod's own data centers. Community cloud runs on hosts other people rent out: cheaper, less predictable. Rigs whose judge times code belong on Secure.")}<select name="cloud_type"><option value="SECURE">Secure</option><option value="COMMUNITY">Community</option></select></label>
<label style="grid-column:1/-1">${infoLabel("Image", "What the pod runs: Thermite's CUDA harness image, or the one-container rig image that a rig on RunPod starts from. Its isolation self-test then also checks the supervisor's places. The image must be at a registry RunPod can pull from. Control's THERMITE_RUNPOD_TEST_IMAGE setting fills it in.")}<input name="image" required maxlength="300" value="${esc(opts.runpodTests?.defaultImage() ?? "")}" placeholder="for example ghcr.io/you/thermite-harness:1a2b3c4d5e6f-cuda"></label>
<label>${infoLabel("Disk (GB)", "The pod's container disk, gone with the pod. The harness image needs about 15 GB.")}<input name="disk_gb" type="number" min="10" max="2000" value="${DEFAULT_DISK_GB}"></label>
<label>${infoLabel("End it after (minutes)", "Optional. Control removes the pod after this many minutes, whatever the test is doing. Empty: the pod runs until the test ends, or until you end it here.")}<input name="stop_after_minutes" type="number" min="5" placeholder="no limit"></label>
<label style="grid-column:1/-1">${infoLabel("Stop and start it again", "After the first report, control stops the pod and starts it again, to see that it gets its GPU back. RunPod can start a stopped pod without a GPU when someone took it meanwhile.")}<span class="row small" style="gap:8px"><input type="checkbox" name="restart" value="1" checked style="height:auto;width:auto"> Stop the pod after its report, start it again, and read its report once more</span></label>
<div class="nc-does" style="grid-column:1/-1" data-test-say><b>What happens.</b> Control starts one pod of the image on the chosen GPU, billed by RunPod by the second. The pod checks root, capabilities, the GPU device nodes, RunPod's variables and outbound HTTPS, then runs Thermite's isolation self-test. Control reads its report, and removes the pod when the test ends.</div>
<div class="form-end"><button>Start a test pod</button></div></form>`;
  };
  const testCard = (x: TestView, gName: string, t: string) =>
    `<div class="card flat" style="margin-top:8px"><div><b>Test ${esc(x.id)}</b> · ${esc(x.gpu_name)}, ${x.cloud_type === "SECURE" ? "Secure" : "Community"} · ${usd(x.price_per_hr)}/h <span class="chip ${x.outcome === "passed" ? "ok" : x.outcome === "running" ? "info" : "warn"}">${esc(x.outcome)}</span></div>
<div class="muted small">${esc(x.phase_words)} · cost ${x.active ? "so far " : ""}${usd(x.cost_usd)} · started ${esc(ago(x.started_at, Date.now()))} ago by ${esc(x.created_by)}${x.datacenter ? ` · ${esc(x.datacenter)}` : ""} · pod ${esc(x.pod_id)}</div>
${x.error ? `<div class="dq-why bad">${esc(x.error)}</div>` : ""}${x.findings.length ? `<ul class="small" style="margin:6px 0 0 18px">${x.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}${x.notes.length ? `<div class="muted small">${x.notes.map(esc).join(" ")}</div>` : ""}
<div class="small" style="margin-top:6px"><a href="/ui/settings/clouds/${gName}/tests/${encodeURIComponent(x.id)}.json">The whole report (JSON)</a>${x.active ? ` <form class="inline" method="post" action="/ui/settings/clouds/${gName}/tests/${encodeURIComponent(x.id)}/end"><input type="hidden" name="csrf" value="${t}"><button class="sm danger">End it now: remove the pod</button></form>` : ""}</div></div>`;
  const testSection = (gName: string, cloud: string, f: RunpodFacts | null, t: string) => {
    const tests = opts.runpodTests?.list(cloud, 5) ?? [];
    const busy = tests.some((x) => x.active);
    return `<h4 style="margin:14px 0 4px">Test pods</h4><div class="muted small">A test pod checks that a rig can run on RunPod. One at a time.</div>${tests.map((x) => testCard(x, gName, t)).join("")}${busy ? "" : testPodForm(gName, f, t)}`;
  };
  const cloudRows = (t: string) =>
    store
      .gpuClouds()
      .map((g) => {
        const f = g.facts as RunpodFacts | null;
        const gName = encodeURIComponent(g.name);
        const status = g.check_error
          ? `<span class="dq-why bad">${esc(g.check_error)}${f ? " (showing the last read)" : ""}</span>`
          : f
            ? `<span class="dq-why">${esc(runpodLine(f))}${g.checked_at ? ` · read ${esc(ago(g.checked_at, Date.now()))} ago` : ""}</span>`
            : `<span class="dq-why">not read yet</span>`;
        const running = f?.pods.filter((p) => p.cost_per_hr > 0) ?? [];
        const form = (action: string, label: string, cls = "sm", extra = "") =>
          `<form class="inline" method="post" action="/ui/settings/clouds/${gName}/${action}"><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
        const gpus = f?.gpus.length
          ? `<div class="card flat" style="margin-top:6px;max-height:340px;overflow:auto"><table><thead><tr><th>GPU</th><th class="num">Memory</th><th class="num">Secure, per GPU-hour</th><th class="num">Community, per GPU-hour</th><th>Secure stock</th></tr></thead><tbody>${f.gpus
              .map(
                (x) =>
                  `<tr><td>${esc(x.name)}</td><td class="num">${x.memory_gb} GB</td><td class="num">${x.secure ? usd(x.price_secure) : "–"}</td><td class="num">${x.community ? usd(x.price_community) : "–"}</td><td>${x.availability ? esc(STOCK[x.availability] ?? x.availability.toLowerCase()) : "–"}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : "";
        const sp = f?.spend;
        const tests = opts.runpodTests?.list(g.name, 200) ?? [];
        const testCost = tests.reduce((t, x) => t + (x.cost_usd ?? 0), 0);
        const spendFacts = sp
          ? `<dt>${infoLabel("Spend", "What this RunPod account spent, from RunPod's billing: pods, storage and the rest, in US dollars. Read with the rest of the account, every 15 minutes and on Read again.")}</dt><dd>${
              sp.error
                ? `<span class="bad">${esc(sp.error)}</span>`
                : `today <b>${usd(sp.today)}</b> · this month <b>${usd(sp.month)}</b> · last 30 days <b>${usd(sp.last30)}</b>${running.length ? ` · running now <b>${usd(running.reduce((t, x) => t + x.cost_per_hr, 0))}/h</b>` : ""}${
                    sp.days.length
                      ? `<br><span class="muted small">${sp.days.map((d) => `${esc(d.day.slice(5))} ${usd(d.usd)}`).join(" · ")}</span>`
                      : ""
                  }`
            }</dd>`
          : "";
        const testFacts = tests.length
          ? `<dt>${infoLabel("Thermite's test pods", "What the test pods started from this account cost, from their run times and RunPod's price for each.")}</dt><dd>${usd(Math.round(testCost * 100) / 100)} over ${tests.length} test${tests.length === 1 ? "" : "s"}</dd>`
          : "";
        const facts = f
          ? `<dl class="facts">${spendFacts}${testFacts}<dt>Pods</dt><dd>${
              f.pods
                .map(
                  (p) =>
                    `${esc(p.name || p.id)}: ${esc(p.status.toLowerCase())}${p.gpus ? `, ${p.gpus} GPU${p.gpus === 1 ? "" : "s"}` : ""}${p.cost_per_hr ? `, <b>${usd(p.cost_per_hr)}/h</b>` : ""}`,
                )
                .join("<br>") || "none"
            }</dd><dt>Network volumes</dt><dd>${f.volumes.map((v) => `${esc(v.name || v.id)}: ${v.size_gb} GB in ${esc(v.datacenter)}`).join("<br>") || "none"}</dd><dt>Data centers</dt><dd>${f.datacenters.map((d) => esc(d.id)).join(", ") || "none listed"}</dd></dl>${gpus}<div class="muted small" style="margin-top:6px">Prices are RunPod's list prices when control last read them. RunPod bills a pod while it runs, and storage while it exists.</div>`
          : "";
        return `<details class="dq${g.check_error ? " dq-bad" : ""}" data-k="cloud-${esc(g.name)}"><summary>
<span class="dq-kind"><span class="kind r">GPU cloud</span></span>
<span class="dq-main"><span class="dq-head">${esc(g.name)} <span class="muted" style="font-weight:400">· RunPod</span></span>${status}<span class="dq-sub"><span class="chip">key ${esc(g.key_hint)}</span><span class="chip info">control starts only the pods you ask for</span>${opts.runpodTests?.list(g.name, 1).some((x) => x.active) ? `<span class="chip warn">a test pod is running</span>` : ""}${running.length ? `<span class="chip warn">${running.length} pod${running.length === 1 ? "" : "s"} running: billed while they run</span>` : ""}</span></span>
<span class="dq-side"><span class="dq-btns">${form("check", "Read again")}<a class="btn sm" href="/ui/rigs/add/runpod?cloud=${gName}">Launch a rig</a></span></span>
</summary><div class="dq-body">${facts}${testSection(gName, g.name, f, t)}
<form method="post" action="/ui/settings/clouds/${gName}/key" class="form-grid" autocomplete="off" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("New API key", "Control seals the new key, reads the account with it, and forgets the old one.")}<input name="runpod_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the key ending ${esc(g.key_hint)}"></label><div class="form-end"><button>Replace the key</button></div></form>
<div style="margin-top:10px">${form("delete", "Delete this GPU cloud", "sm danger")} <span class="muted small">Control forgets the key. Nothing at RunPod changes.</span></div></div></details>`;
      })
      .join("");
  const addRunpod = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = newName(f.name);
    const key = String(f.runpod_key ?? "").trim();
    if (!ACCESS_NAME.test(name))
      return fail("A GPU cloud's name is lowercase letters, digits, dots and dashes.");
    if (store.gpuCloud(name)) return fail(`"${name}" exists already.`);
    if (!key) return fail("Paste the RunPod API key.");
    // A key that RunPod refuses is not kept.
    try {
      const facts = await readRunpod(key, opts.cloudFetch);
      store.addGpuCloud({
        name,
        kind: "runpod",
        key_sealed: opts.secrets.seal(key),
        key_hint: keyHint(key),
        by: "owner:ui",
      });
      store.setGpuCloudFacts(name, { facts });
    } catch (err) {
      return fail(`Not added: ${errorText(err)}.`);
    }
    return c.redirect(
      settingsUrl("ok", `"${name}" is added and read: see what control found below.`),
      303,
    );
  };
  app.post("/ui/settings/clouds/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!store.gpuCloud(name)) return c.redirect(settingsUrl("error", "No such GPU cloud."), 303);
    const why = await checkCloudNow(name);
    return c.redirect(
      why ? settingsUrl("error", `"${name}": ${why}`) : settingsUrl("ok", `Read "${name}" again.`),
      303,
    );
  });
  app.post("/ui/settings/clouds/:name/key", async (c) => {
    const name = c.req.param("name");
    const key = String((await c.req.parseBody()).runpod_key ?? "").trim();
    if (!store.gpuCloud(name)) return c.redirect(settingsUrl("error", "No such GPU cloud."), 303);
    if (!key) return c.redirect(settingsUrl("error", "Paste the new key."), 303);
    try {
      const facts = await readRunpod(key, opts.cloudFetch);
      store.replaceGpuCloudKey(name, opts.secrets.seal(key), keyHint(key), "owner:ui");
      store.setGpuCloudFacts(name, { facts });
    } catch (err) {
      return c.redirect(settingsUrl("error", `Kept the old key: ${errorText(err)}.`), 303);
    }
    return c.redirect(settingsUrl("ok", `"${name}" has its new key, and is read again.`), 303);
  });
  app.post("/ui/settings/clouds/:name/test", async (c) => {
    const name = c.req.param("name");
    const f = await c.req.parseBody();
    if (!opts.runpodTests) return c.redirect(settingsUrl("error", "Test pods are off."), 303);
    const num = (v: unknown) => (String(v ?? "").trim() ? Number(String(v).trim()) : undefined);
    try {
      const x = await opts.runpodTests.start(
        name,
        {
          gpu: String(f.gpu ?? "").trim() || undefined,
          cloud_type: f.cloud_type === "COMMUNITY" ? "COMMUNITY" : "SECURE",
          image: String(f.image ?? "").trim() || undefined,
          disk_gb: num(f.disk_gb),
          restart: f.restart === "1",
          stop_after_minutes: num(f.stop_after_minutes),
        },
        "owner:ui",
      );
      return c.redirect(
        settingsUrl(
          "ok",
          `Test ${x.id} started: a ${x.gpu_name} pod at ${usd(x.price_per_hr)}/h. Its report shows below when it comes.`,
        ),
        303,
      );
    } catch (err) {
      return c.redirect(settingsUrl("error", `No test pod: ${errorText(err)}.`), 303);
    }
  });
  app.post("/ui/settings/clouds/:name/tests/:id/end", async (c) => {
    if (!opts.runpodTests) return c.redirect(settingsUrl("error", "Test pods are off."), 303);
    try {
      const x = await opts.runpodTests.end(c.req.param("id"), "owner:ui");
      return c.redirect(
        settingsUrl(
          x.active ? "error" : "ok",
          x.active
            ? `Test ${x.id}: ${x.error ?? "the pod is not removed yet"}`
            : `Test ${x.id} ended: the pod is removed.`,
        ),
        303,
      );
    } catch (err) {
      return c.redirect(settingsUrl("error", errorText(err)), 303);
    }
  });
  app.get("/ui/settings/clouds/:name/tests/:id{.+\\.json}", (c) => {
    const x = opts.runpodTests?.view(c.req.param("id").replace(/\.json$/, ""));
    return x && x.cloud === c.req.param("name") ? c.json(x) : c.json({ error: "not found" }, 404);
  });
  app.post("/ui/settings/clouds/:name/delete", (c) => {
    const name = c.req.param("name");
    if (opts.runpodTests?.list(name, 1).some((x) => x.active))
      return c.redirect(
        settingsUrl("error", "A test pod is running there: end it first, so its pod is removed."),
        303,
      );
    return c.redirect(
      store.deleteGpuCloud(name, "owner:ui")
        ? settingsUrl("ok", `"${name}" is deleted: control keeps nothing of its key.`)
        : settingsUrl("error", "No such GPU cloud."),
      303,
    );
  });

  // ---------------------------------------------------------------- rigs on machines
  // Rigs › Add a rig: control enrolls the rig, writes its files and Quadlet units over SSH, and
  // starts it (machines/deploy.ts). Every step is a setup event on the rig's page.
  const controlPublicKey = createPublicKey(opts.privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const rigTaken = (rig: string) =>
    rig === "add" ||
    store.knownRig(rig) ||
    Boolean(store.machineRig(rig)) ||
    Boolean(store.clusterRig(rig)) ||
    Boolean(store.joinedRig(rig)) ||
    views().some((u) => u.id === rig);
  /** GPUs of a machine that rigs control set up there use, by index. */
  const gpusInUse = (machine: string) =>
    new Map(
      store
        .machineRigs(machine)
        .filter((r) => r.status !== "removed")
        .flatMap((r) => r.gpus.map((g) => [g, r.rig] as const)),
    );
  /** Why a machine can't take a rig now, or nothing. */
  const notReady = (m: Machine): string | undefined => {
    const f = m.facts as MachineFacts | null;
    if (!m.host_keys.length) return "its host key is not trusted yet";
    if (!f) return "it has not been checked yet";
    if (m.check_error) return `its last check failed: ${m.check_error}`;
    if (!f.podman) return "Podman is missing";
    if (!f.systemd) return "it has no systemd";
    if (!f.root && f.linger === false) return "lingering is off for its user";
    return undefined;
  };
  const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  // The wait for a new rig's first report never keeps control (or a test) from exiting.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());
  /**
   * Waits for a new rig's first report (or, with `after`, a report after that time), for at most
   * 10 minutes; a setup event either way.
   */
  const awaitFirstReport = async (
    rig: string,
    setStatus: (s: string) => void,
    minutes = 10,
    after?: number,
    o: { step?: string; still?: () => boolean } = {},
  ) => {
    const step = o.step ?? (after === undefined ? "first_report" : "report_after_images");
    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() < deadline) {
      // Stopped or removed meanwhile: the wait ends with nothing to say.
      if (o.still && !o.still()) return;
      if (
        views().some(
          (u) => u.id === rig && (after === undefined || Date.parse(u.last_seen) > after),
        )
      ) {
        store.rigSetupEvent(rig, step, true);
        setStatus("running");
        return;
      }
      await sleep(5000);
    }
    if (o.still && !o.still()) return;
    store.rigSetupEvent(
      rig,
      step,
      false,
      `no report after ${minutes} minutes: it may not have started`,
    );
    setStatus("failed");
  };
  const setupSteps = (rig: string) =>
    store
      .rigSetupEvents(rig)
      .map(
        (e) =>
          `<div class="tl-row"><span class="muted small">${esc(ago(e.at, Date.now()))} ago</span><span class="${e.ok ? "ok" : "bad"}">${e.ok ? "✓" : "✕"}</span><span>${esc(STEP_WORDS[e.step] ?? e.step)}${e.detail ? ` <span class="muted small">· ${esc(e.detail)}</span>` : ""}</span></div>`,
      )
      .join("");
  /** How a rig's GPUs are used, in words: "2 for the judge, 2 for the agents", or shared. */
  const splitWords = (n: number, judge?: number | undefined) => {
    if (n < 2) return "shared by the judge and the agents";
    const j = judge ?? judgeGpusByDefault(n);
    return `${j} for the judge, ${n - j} for the agents`;
  };
  /** Which of a machine rig's GPUs are the judge's (the first ones) and which the agents'. */
  const gpuRoles = (gpus: number[], judge?: number | undefined) =>
    gpus
      .map((g, i) =>
        gpus.length < 2
          ? `GPU ${g} (shared)`
          : `GPU ${g} (${i < (judge ?? judgeGpusByDefault(gpus.length)) ? "judge" : "agents"})`,
      )
      .join(", ");
  /** The judge's share of `n` GPUs from a form field: a number from 1 to n-1, or the default. */
  // The judge's share as typed in a form, by the one rule of cluster-resources.ts.
  const judgeShare = (raw: string, n: number) => judgeShareOf(raw ? Number(raw) : undefined, n);
  /** The images control deploys for a rig with these GPUs, or why it has none. */
  const controlImages = (gpus: number): ClusterRig["spec"]["images"] | string => {
    if (!opts.rigImages) return "Control has no rig images configured.";
    if (gpus && !opts.rigImages.harnessCuda)
      return "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).";
    return {
      harness: gpus ? (opts.rigImages.harnessCuda as string) : opts.rigImages.harness,
      supervisor: opts.rigImages.supervisor,
    };
  };
  /** Control's address for rigs, as a supervisor's CONTROL_URL has it. */
  const controlAddress = () => opts.publicUrl?.replace(/\/$/, "");
  /** A rig control set up on a cluster: where, its setup history, and its controls. */
  const clusterPlacedBlock = (r: ClusterRig, t: string) => {
    const rName = encodeURIComponent(r.rig);
    const act = (action: string, label: string, extra = "", cls = "sm") =>
      `<form class="inline" method="post" action="/ui/rigs/${rName}/cluster/${action}"${action === "remove" ? "" : " data-act"}><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
    const s = r.spec;
    const manage =
      r.status === "removed" || r.status === "deploying"
        ? ""
        : `<div class="act" style="margin-top:10px">${r.status === "stopped" ? act("start", "Start its pods") : act("stop", "Stop its pods")}${act("restart", "Restart them")}</div>
<details style="margin-top:8px"><summary class="small">Remove it from ${esc(r.cluster)}</summary><div class="small muted" style="margin:6px 0">${r.placement === "created" ? "Deletes its namespace, with everything in it," : "Deletes its deployments, service, volume claim and secret from the slot,"} and retires its token. ${esc(removeWords(r.rig))}</div>${act("remove", "Remove the rig", `<input name="confirm" placeholder="type: remove ${esc(r.rig)}" style="margin-right:6px">`, "sm danger")}</details>`;
    const want = controlImages(s.gpus);
    const keeps =
      "Its volume, tokens, runs and results stay. Running trials and the judge's job under way finish first: the rig starts nothing new meanwhile. Update now skips the wait: a trial in progress then stops, and its experiment goes back to the queue.";
    // New images; or the same ones after a failed update (a retry); or a new address for control.
    // Draining for an update (goal 079): what it waits for, and the two ways out.
    const work = rigWork(r.rig);
    const waits = `${work ? `It waits for ${esc(workWords(work))} to finish, and starts nothing new.` : "It waits for its next report."} Its pods restart as soon as nothing runs.`;
    const draining =
      r.status === "draining" && r.pending
        ? `<div class="small" style="margin-top:12px">Draining before its pods restart with ${esc(sizeWords(r.pending))}.</div><div class="small muted" style="margin:4px 0 6px">${waits} Its volume, tokens, runs and results stay.</div>${act("resources-now", "Change now, without waiting")}${act("drain-cancel", "Call the change off")}`
        : r.status === "draining" && typeof want !== "string"
          ? `<div class="small" style="margin-top:12px">Draining before its pods restart on control's images:<div class="mono">${esc(want.harness)}<br>${esc(want.supervisor)}</div></div><div class="small muted" style="margin:4px 0 6px">${waits}</div>${act("images-now", "Update now, without waiting")}${act("drain-cancel", "Call the update off")}`
          : "";
    const update = draining
      ? draining
      : !manage || typeof want === "string"
        ? ""
        : want.harness !== s.images.harness || want.supervisor !== s.images.supervisor
          ? `<div class="small" style="margin-top:12px">Control now deploys other images:<div class="mono">${esc(want.harness)}<br>${esc(want.supervisor)}</div></div><div class="small muted" style="margin:4px 0 6px">Its pods restart on these images. ${keeps} After a newer harness has opened its ledger, an older image may not open it.</div>${act("images", "Update to these images")}`
          : r.status === "failed"
            ? `<div class="small" style="margin-top:12px">The last change to its pods failed (see the steps above). Try it again on control's images:<div class="mono">${esc(want.harness)}<br>${esc(want.supervisor)}</div></div><div class="small muted" style="margin:4px 0 6px">${keeps}</div>${act("images", "Try the update again")}`
            : s.controlUrl && controlAddress() && s.controlUrl !== controlAddress()
              ? `<div class="small" style="margin-top:12px">Control's address for rigs changed: the rig reports to <span class="mono">${esc(s.controlUrl)}</span>, control is now at <span class="mono">${esc(controlAddress() ?? "")}</span>.</div><div class="small muted" style="margin:4px 0 6px">Its pods restart with the new address, on the same images. ${keeps}</div>${act("images", "Give it control's new address")}`
              : "";
    return `<div class="block" ${placeAttrs(r.rig, r.status)}><div class="head"><h2>Set up by control</h2><span class="right">${esc(r.status)}</span></div><div class="card"><dl class="facts"><dt>Cluster</dt><dd><a href="/ui/settings">${esc(r.cluster)}</a> (Providers)</dd><dt>Namespace</dt><dd>${esc(r.namespace)} <span class="muted">(${r.placement === "created" ? "made by control" : "a slot"})</span></dd><dt>GPUs</dt><dd>${s.gpus ? `${s.gpus} through ${s.gpuMode === "dra" ? `DRA (${esc(s.deviceClass ?? "")})` : "NVIDIA's device plugin"}: ${splitWords(s.gpus, s.judgeGpus)}` : "none: it measures on the CPU"}${s.node ? ` · on ${esc(s.node)}` : ""}</dd><dt>CPUs and memory</dt><dd>${s.resources ? esc(resourcesWords(s.resources)) : "the namespace's defaults"}${manage ? ` · <a href="/ui/rigs/${rName}/edit">change on Edit rig</a>` : ""}</dd><dt>Storage</dt><dd>${s.storageGi} GB${s.storageClass ? ` · ${esc(s.storageClass)}` : ""}</dd><dt>Images</dt><dd class="mono small">${esc(s.images.harness)}<br>${esc(s.images.supervisor)}</dd></dl>
<div class="tl" style="margin-top:10px">${setupSteps(r.rig) || `<div class="muted small">No step yet.</div>`}</div>${manage}${update}</div></div>`;
  };
  /** What the place of a rig control set up on a cluster allows it, as control last read it. */
  const clusterLimits = (r: ClusterRig): string => {
    const f = store.cluster(r.cluster)?.facts as ClusterFacts | null | undefined;
    const s = r.spec;
    const n = (x: number) => String(Math.round(x * 1000) / 1000);
    if (r.placement === "slot") {
      const q = f?.slots.find((x) => x.namespace === r.namespace)?.quota;
      const devices = s.deviceClass ? q?.devices?.[s.deviceClass] : undefined;
      const allows = [
        q?.cpus !== undefined ? `${n(q.cpus)} CPUs` : "",
        q?.memoryGi !== undefined ? `${n(q.memoryGi)} GiB of memory` : "",
        s.gpus === 0
          ? ""
          : s.gpuMode === "dra"
            ? devices !== undefined
              ? `${devices} device${devices === 1 ? "" : "s"} of the class ${s.deviceClass}`
              : ""
            : q?.gpus !== undefined
              ? `${q.gpus} GPU${q.gpus === 1 ? "" : "s"}`
              : "",
      ].filter(Boolean);
      return allows.length
        ? `The slot's quota allows ${listText(allows)}, as control last read it. Save reads it again first.`
        : "Control read no limit for this in the slot's quota: the cluster's own rules decide.";
    }
    if (s.gpus > 0 && s.gpuMode !== "dra" && f?.nodes.length) {
      const nodes = f.nodes.filter((x) => !s.node || x.name === s.node);
      const most = Math.max(0, ...nodes.map((x) => x.gpus));
      return `${s.node ? `The node ${s.node}` : "Its largest node"} offers ${most} GPU${most === 1 ? "" : "s"} through the device plugin, as control last read the cluster.`;
    }
    return "";
  };
  /**
   * Edit rig's fields for a rig control set up on a cluster (goal 118): its GPUs (a GPU rig only:
   * none and some don't mix), its CPUs and its memory, with what its place allows. Save changes
   * them as set_cluster_rig_resources does.
   */
  const clusterSizeFields = (r: ClusterRig): string => {
    if (r.status === "removed" || r.status === "deploying") return "";
    const s = r.spec;
    const way =
      s.gpuMode === "dra"
        ? `DRA, the device class ${s.deviceClass ?? ""}`
        : "NVIDIA's device plugin";
    const gpus = s.gpus
      ? `<label class="fd">${infoLabel("GPUs", `How many GPUs the rig's harness pod asks for, through ${way}: 1 to ${MAX_RIG_GPUS}. With two or more, some are the judge's and the rest the agents': half each, rounded up for the judge, unless you set GPUs for the judge below. A rig on GPUs can't move to none: add a rig on the CPU for that.`)}<input name="k_gpus" type="number" min="1" max="${MAX_RIG_GPUS}" step="1" value="${s.gpus}" data-label="its GPUs" data-moves></label>`
      : "";
    const limits = clusterLimits(r);
    const moves =
      "Its pods restart with the new GPUs, CPUs and memory, on the images it runs. A rig at work drains first: running trials and the judge's job finish, and it starts nothing new meanwhile. Its volume, tokens, runs and results stay.";
    return `<div class="g3" style="margin-top:10px" data-moves-say="${esc(moves)}">${gpus}
<label class="fd">${infoLabel("CPUs", "The rig's CPUs: the supervisor gets half a CPU, the harness the rest. At least 1.5. Empty, with Memory empty too: the namespace's defaults apply.")}<input name="k_cpus" type="number" min="1.5" step="any" value="${s.resources?.cpus ?? ""}" placeholder="the namespace's defaults" data-label="its CPUs" data-empty="the namespace's defaults" data-moves></label>
<label class="fd">${infoLabel("Memory (GiB)", "The rig's memory: the supervisor gets 2 GiB, the harness the rest. At least 6 GiB. Empty, with CPUs empty too: the namespace's defaults apply.")}<input name="k_mem" type="number" min="6" step="any" value="${s.resources?.memoryGi ?? ""}" placeholder="the namespace's defaults" data-label="its memory" data-unit=" GiB" data-empty="the namespace's defaults" data-moves></label>
</div><div class="muted small" style="margin-top:6px">${s.gpus ? "" : "It measures on the CPU: a rig on the CPU can't take GPUs, so add a rig with GPUs for that. "}${limits ? `${esc(limits)} ` : ""}A change here restarts its pods; a rig at work drains first.</div>`;
  };
  /** A rig in pull mode: its pod, its enrollment, control's last connection and the refusals. */
  const pullBlock = (r: TunnelRig, now: number) => {
    const state = !r.pod
      ? "waiting for its pod"
      : r.enrolled_at
        ? "enrolled"
        : "waiting for enrollment";
    const enrollment = r.enrolled_at
      ? `Enrolled ${esc(ago(r.enrolled_at, now))} ago. Control pinned the pod's keys, and the code is spent.`
      : r.code_expires_at
        ? Date.parse(r.code_expires_at) < now
          ? `<span class="bad">The code expired ${esc(ago(r.code_expires_at, now))} ago. Launch the rig again.</span>`
          : `Not yet. The code expires in ${esc(span(new Date(now).toISOString(), Date.parse(r.code_expires_at)))}.`
        : "Not yet. The code does not expire.";
    return `<div class="block"><div class="head"><h2>Pull mode</h2><span class="right">${esc(state)}</span></div><div class="card"><p class="small" style="margin-top:0">Control connects to this rig through RunPod's proxy. The rig never connects to control. The pod answers only requests that control signed.</p><dl class="facts"><dt>Pod</dt><dd>${r.pod ? esc(r.pod) : `<span class="muted">not launched yet</span>`}</dd>${r.url ? `<dt>Address</dt><dd class="mono small">${esc(r.url)}</dd>` : ""}<dt>Enrollment</dt><dd>${enrollment}</dd><dt>Last exchange</dt><dd>${r.last_exchange_at ? `${esc(ago(r.last_exchange_at, now))} ago` : `<span class="muted">none yet</span>`}</dd><dt>Refused requests</dt><dd>${r.refused_total}${r.refused_total ? ` <span class="muted small">Requests that control did not sign. The pod gave each one an empty 404.</span>` : ""}</dd>${r.error ? `<dt>Last error</dt><dd class="bad">${esc(r.error)}</dd>` : ""}</dl></div></div>`;
  };
  /** What a rig control set up on a cluster is deployed with, with its images or others. */
  const clusterPlan = (r: ClusterRig, images = r.spec.images) => ({
    rig: r.rig,
    placement: r.placement,
    namespace: r.namespace,
    controlUrl: opts.publicUrl ?? "",
    images,
    gpus: r.spec.gpus,
    judgeGpus: r.spec.judgeGpus,
    gpuMode: r.spec.gpuMode,
    deviceClass: r.spec.deviceClass,
    node: r.spec.node,
    storageClass: r.spec.storageClass,
    storageGi: r.spec.storageGi,
    resources: r.spec.resources,
    controlPublicKey,
  });
  /** Sets a rig up on a cluster, in the background: one apply, then the first report. */
  const deployClusterRig = async (
    r: ClusterRig,
    k: Cluster & { kubeconfig_sealed: string },
    controlToken: string,
  ) => {
    try {
      const objects = clusterRigObjects(clusterPlan(r), {
        controlToken,
        harnessSupervisorToken: newToken().token,
      });
      const out = await kube.kubectl(
        clusterTarget(k),
        ["apply", "-f", "-"],
        asList(objects),
        120_000,
      );
      if (out.code !== 0) throw new Error(kubeError(out));
      store.rigSetupEvent(r.rig, "applied", true, `namespace ${r.namespace}`);
      store.setClusterRigStatus(r.rig, "starting");
    } catch (err) {
      store.rigSetupEvent(r.rig, "deploy", false, errorText(err));
      store.setClusterRigStatus(r.rig, "failed");
      return;
    }
    await awaitFirstReport(r.rig, (s) => store.setClusterRigStatus(r.rig, s));
  };
  /** A rig control set up: where, its setup history, and stop, start, restart and remove. */
  /**
   * A rig control set up, on a machine or a cluster, while a change to it is under way (goal 080):
   * its block follows the change's steps until it ends. Its buttons, but Remove, are sent by the
   * page's script (data-act).
   */
  const PLACE_BUSY = new Set(["deploying", "starting", "updating"]);
  const placeProgress = (rig: string): Progress => {
    const status = store.clusterRig(rig)?.status ?? store.machineRig(rig)?.status ?? "removed";
    return {
      state: `${status}:${store.rigSetupEvents(rig).length}`,
      final: !PLACE_BUSY.has(status),
      said: "",
      tone: "",
    };
  };
  const placeFollowUrl = (rig: string) => `/ui/rigs/${encodeURIComponent(rig)}/place.json`;
  const placeAttrs = (rig: string, status: string) =>
    `data-part="placed"${PLACE_BUSY.has(status) ? ` data-follow="${esc(placeFollowUrl(rig))}" data-follow-state="${esc(placeProgress(rig).state)}"` : ""}`;
  /** A form's answer: JSON for the page's script, else the rig's page with the words. */
  const placeBack = (c: Ctx, rig: string, k: "ok" | "error", msg: string) =>
    wantsJson(c)
      ? k === "ok"
        ? c.json({ ...placeProgress(rig), said: msg, tone: "ok", follow: placeFollowUrl(rig) })
        : c.json(notSent(msg), 400)
      : c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(msg)}`, 303);
  const placedBlock = (r: MachineRig, t: string) => {
    const rName = encodeURIComponent(r.rig);
    const steps = setupSteps(r.rig);
    const act = (action: string, label: string, extra = "", cls = "sm") =>
      `<form class="inline" method="post" action="/ui/rigs/${rName}/machine/${action}"${action === "remove" ? "" : " data-act"}><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
    const manage =
      r.status === "removed" || r.status === "deploying"
        ? ""
        : `<div class="act" style="margin-top:10px">${r.status === "stopped" ? act("start", "Start its services") : act("stop", "Stop its services")}${act("restart", "Restart them")}</div>
<details style="margin-top:8px"><summary class="small">Remove it from ${esc(r.machine)}</summary><div class="small muted" style="margin:6px 0">Stops its services and deletes its units, files and volumes on the machine, and retires its token. ${esc(removeWords(r.rig))}</div>${act("remove", "Remove the rig", `<input name="confirm" placeholder="type: remove ${esc(r.rig)}" style="margin-right:6px">`, "sm danger")}</details>`;
    return `<div class="block" ${placeAttrs(r.rig, r.status)}><div class="head"><h2>Set up by control</h2><span class="right">${esc(r.status)}</span></div><div class="card"><dl class="facts"><dt>Machine</dt><dd><a href="/ui/settings">${esc(r.machine)}</a> (Providers)</dd><dt>GPUs</dt><dd>${r.gpus.length ? gpuRoles(r.gpus, r.judge_gpus) : "none: it measures on the CPU"}</dd><dt>Images</dt><dd class="mono small">${esc(r.images.harness)}<br>${esc(r.images.supervisor)}</dd></dl>
<div class="tl" style="margin-top:10px">${steps || `<div class="muted small">No step yet.</div>`}</div>${manage}</div></div>`;
  };
  /** Sets a rig up on a machine, in the background: each step becomes a setup event. */
  const deployRig = async (
    r: MachineRig,
    m: Machine & { key_sealed: string },
    controlToken: string,
  ) => {
    const target = {
      address: m.address,
      port: m.port,
      user: m.user,
      privateKey: opts.secrets.open(m.key_sealed),
      hostKeys: m.host_keys,
    };
    try {
      const out = await ssh.sshScript(
        target,
        deployScript(
          {
            rig: r.rig,
            controlUrl: opts.publicUrl ?? "",
            images: r.images,
            gpus: r.gpus,
            judgeGpus: r.judge_gpus,
            root: r.root,
            controlPublicKey,
            controlFingerprint: fingerprint(controlPublicKey),
          },
          { controlToken, harnessSupervisorToken: newToken().token },
        ),
        [],
        30 * 60_000,
      );
      if (out.code !== 0) throw new Error(tail(out.stderr) || `the deploy exited ${out.code}`);
      store.rigSetupEvent(r.rig, "deployed", true);
      store.setMachineRigStatus(r.rig, "starting");
    } catch (err) {
      store.rigSetupEvent(r.rig, "deploy", false, errorText(err));
      store.setMachineRigStatus(r.rig, "failed");
      return;
    }
    await awaitFirstReport(r.rig, (s) => store.setMachineRigStatus(r.rig, s));
  };
  app.get("/ui/assets/add-rig.js", (c) =>
    c.body(ADD_RIG_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  app.get("/ui/rigs/add", (c) => {
    const t = csrf(c);
    const error = c.req.query("error");
    const machines = store.machines();
    const cards = machines
      .map((m, i) => {
        const why = notReady(m);
        const f = m.facts as MachineFacts | null;
        const used = gpusInUse(m.name);
        const free = (f?.gpus ?? []).filter((g) => !used.has(g.index)).length;
        const rigsHere = store.machineRigs(m.name).filter((r) => r.status !== "removed");
        const sub = why
          ? `Not ready: ${why}. Fix it under Settings › Providers.`
          : `${factsLine(f as MachineFacts)}${rigsHere.length ? ` · runs ${rigsHere.map((r) => r.rig).join(", ")}` : ""}${f?.gpus.length ? ` · ${free} GPU${free === 1 ? "" : "s"} free` : ""}`;
        return `<label class="ch${why ? " dis" : ""}"><input type="radio" name="place" value="machine:${esc(m.name)}"${why ? " disabled" : i === 0 ? " checked" : ""} style="margin:2px 8px 0 0"><span><b>${esc(m.name)} · a machine over SSH</b><br><span class="muted small">${esc(sub)}</span></span></label>`;
      })
      .join("");
    const gpuLists = machines
      .map((m) => {
        const f = m.facts as MachineFacts | null;
        const used = gpusInUse(m.name);
        const rows = (f?.gpus ?? [])
          .map((g) => {
            const by = used.get(g.index);
            return `<label class="gr${by ? " used" : ""}"><input type="checkbox" name="gpus" value="${g.index}"${by ? " disabled" : ""}><span><b>GPU ${g.index}</b> · ${esc(g.name)} ${Math.round(g.memory_mib / 1024)} GB</span><span class="muted small">${by ? `used by rig ${esc(by)}` : `free · ${g.busy_pct}% busy · ${g.used_mib} MiB in use`}</span></label>`;
          })
          .join("");
        return `<div data-place="machine:${esc(m.name)}" hidden>${rows ? `<div class="card flat">${rows}</div>` : `<div class="card"><div class="muted">This machine has no NVIDIA GPU: the rig measures on its CPUs.</div></div>`}</div>`;
      })
      .join("");
    // Clusters: how many GPUs and how, which node, which storage, and (for slots) which slot.
    const clusters = store.clusters();
    const clusterReady = (k: Cluster) => {
      const f = k.facts as ClusterFacts | null;
      if (!f) return "it has not been checked yet";
      if (k.check_error) return `its last check failed: ${k.check_error}`;
      if (k.placement === "created" && !f.can_create_namespaces)
        return "control may not create namespaces there";
      if (k.placement === "slot" && !f.slots.some((s) => s.usable && !s.used_by))
        return "it has no free slot";
      return undefined;
    };
    const clusterCards = clusters
      .map((k) => {
        const why = clusterReady(k);
        const f = k.facts as ClusterFacts | null;
        const sub = why
          ? `Not ready: ${why}. Check it under Settings › Providers.`
          : `${clusterLine(f as ClusterFacts)} · ${k.placement === "created" ? `rigs get namespace ${k.namespace_pattern}` : `${(f as ClusterFacts).slots.filter((s) => s.usable && !s.used_by).length} free slot(s)`}`;
        return `<label class="ch${why ? " dis" : ""}"><input type="radio" name="place" value="cluster:${esc(k.name)}"${why ? " disabled" : ""} style="margin:2px 8px 0 0"><span><b>${esc(k.name)} · Kubernetes</b><br><span class="muted small">${esc(sub)}</span></span></label>`;
      })
      .join("");
    const clusterSections = clusters
      .map((k) => {
        const f = (k.facts as ClusterFacts | null) ?? {
          version: "?",
          nodes: [],
          device_classes: [],
          storage_classes: [],
          can_create_namespaces: false,
          slots: [],
        };
        const kn = esc(k.name);
        // The free slots' quota fills in the rig's CPUs, memory and volume (the first free one's).
        const freeQuota = f.slots.find((x) => x.usable && !x.used_by)?.quota;
        // A slot's role usually can't list nodes or device classes: then the choices are offered
        // as asked, and the cluster's own rules decide.
        const restricted = !f.nodes.length;
        const plugin = restricted || f.nodes.some((n) => n.gpus > 0);
        const maxGpus = restricted
          ? 8
          : Math.min(
              MAX_RIG_GPUS,
              Math.max(0, ...f.nodes.map((n) => n.gpus), f.device_classes.length ? 8 : 0),
            );
        const opt = (v: string, text: string, on = false) =>
          `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(text)}</option>`;
        const def = f.storage_classes.find((s) => s.default)?.name;
        return `<div data-place="cluster:${kn}" hidden><div class="g3">
<label class="fd">${infoLabel("GPUs", "How many GPUs the rig's harness pod asks for. One is shared by the judge and the agents; with more, you choose how many are the judge's and the rest are the agents'.")}<select name="k_gpus__${kn}">${Array.from({ length: maxGpus + 1 }, (_, n) => opt(String(n), n === 0 ? "none: the CPU" : String(n), n === Math.min(1, maxGpus))).join("")}</select></label>
<label class="fd" data-judge-for="k_gpus__${kn}" hidden>${infoLabel("GPUs for the judge", "How many of the rig's GPUs the judge measures on; the rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. Default: half, rounded up.")}<input name="k_judge__${kn}" inputmode="numeric" maxlength="2" placeholder="half"></label>
<label class="fd">${infoLabel("GPUs through", "NVIDIA's device plugin (nvidia.com/gpu) or DRA (a device class), as the cluster offers them.")}<select name="k_mode__${kn}">${plugin ? opt("device-plugin", "NVIDIA's device plugin") : ""}${f.device_classes.map((d) => opt(`dra:${d}`, `DRA: ${d}`)).join("")}${restricted ? opt("dra", "DRA: a device class you name") : ""}${!plugin && !f.device_classes.length ? opt("device-plugin", "no GPUs offered") : ""}</select></label>
${restricted ? `<label class="fd">${infoLabel("DRA device class", "Only for DRA in a cluster whose classes control can't list: the device class the cluster's operators named, such as gpu.nvidia.com.")}<input name="k_class__${kn}" maxlength="253" placeholder="gpu.nvidia.com"></label>` : ""}
<label class="fd">${infoLabel("Node", "Any lets Kubernetes choose. A fixed node keeps the rig on a known machine, which keeps timings comparable between runs.")}<select name="k_node__${kn}">${opt("", "any node with room")}${f.nodes
          .filter((n) => n.ready)
          .map((n) =>
            opt(n.name, `${n.name}${n.gpus ? ` (${n.gpus} GPU${n.gpus === 1 ? "" : "s"})` : ""}`),
          )
          .join("")}</select></label>
<label class="fd">${infoLabel("Storage class", "The class for the rig's volume (its state, builds, inbox and outbox).")}<select name="k_storage__${kn}">${def ? "" : opt("", "the cluster's default")}${f.storage_classes.map((s) => opt(s.name, `${s.name}${s.default ? " (default)" : ""}`, s.name === def)).join("")}</select></label>
<label class="fd">${infoLabel("Volume size (GB)", "The rig's volume: builds and model files can be large.")}<input name="k_size__${kn}" value="${freeQuota?.storageGi !== undefined ? Math.floor(freeQuota.storageGi) : 100}"></label>
<label class="fd">${infoLabel("CPUs", "The rig's CPUs: the supervisor gets half a CPU, the harness the rest. Filled in from the slot's quota when control can read it; empty: the namespace's defaults apply.")}<input name="k_cpus__${kn}" inputmode="decimal" value="${freeQuota?.cpus ?? ""}" placeholder="the namespace's defaults"></label>
<label class="fd">${infoLabel("Memory (GiB)", "The rig's memory: the supervisor gets 2 GiB, the harness the rest. Filled in from the slot's quota when control can read it; empty: the namespace's defaults apply.")}<input name="k_mem__${kn}" inputmode="decimal" value="${freeQuota?.memoryGi !== undefined ? Math.floor(freeQuota.memoryGi) : ""}" placeholder="the namespace's defaults"></label>
${
  k.placement === "slot"
    ? `<label class="fd">${infoLabel("Slot", "One of the free slots the cluster's operators made for Thermite.")}<select name="k_slot__${kn}">${f.slots
        .filter((s) => s.usable && !s.used_by)
        .map((s) => opt(s.namespace, s.namespace))
        .join("")}</select></label>`
    : `<div class="fd">${infoLabel("Namespace", "Control creates it for this rig, with its own network rules.")}<span class="mono small">${esc(k.namespace_pattern)}</span></div>`
}
</div></div>`;
      })
      .join("");
    // Rigs you run yourself: one command where the rig goes, for places control can't reach.
    const joinCards = `<label class="ch"><input type="radio" name="place" value="join:machine" style="margin:2px 8px 0 0"><span><b>A machine you set it up on yourself</b><br><span class="muted small">For a machine control can't reach over SSH, such as one behind NAT. You run one command there; it fetches the rig's files from control and starts it. Control can't reach the machine afterwards, so you stop and remove it there too.</span></span></label>
<label class="ch"><input type="radio" name="place" value="join:namespace" style="margin:2px 8px 0 0"><span><b>A Kubernetes namespace you apply it to yourself</b><br><span class="muted small">For a cluster whose operators give Thermite no kubeconfig. You run one kubectl apply, with your own rights, in a namespace you have. Control holds no credential for the cluster.</span></span></label>`;
    const joinSections = `<div data-place="join:machine" hidden><div class="g3">
<label class="fd">${infoLabel("GPUs on the machine", "The numbers of the machine's NVIDIA GPUs the rig uses, as nvidia-smi lists them. Empty: none, the rig measures on the CPU. One GPU is shared by the judge and the agents; with more, the lowest-numbered are the judge's.")}<input name="j_gpus" maxlength="40" placeholder="empty, 0, or 0,1"></label>
<label class="fd">${infoLabel("GPUs for the judge", "With two or more GPUs: how many the judge measures on (the lowest-numbered); the rest are the agents'. Default: half, rounded up.")}<input name="j_judge" inputmode="numeric" maxlength="2" placeholder="half"></label>
</div></div>
<div data-place="join:namespace" hidden><div class="g3">
<label class="fd">${infoLabel("Namespace", "The namespace the rig goes in. It must exist, and you need rights there to create deployments, services, secrets, volume claims and network policies.")}<input name="j_namespace" maxlength="63" placeholder="thermite-rig-1"></label>
<label class="fd">${infoLabel("GPUs", "How many GPUs the rig's harness pod asks for. One is shared by the judge and the agents; with more, you choose how many are the judge's.")}<select name="j_k_gpus">${Array.from({ length: 9 }, (_, n) => `<option value="${n}"${n === 1 ? " selected" : ""}>${n === 0 ? "none: the CPU" : n}</option>`).join("")}</select></label>
<label class="fd">${infoLabel("GPUs for the judge", "With two or more GPUs: how many the judge measures on; the rest are the agents'. Default: half, rounded up.")}<input name="j_k_judge" inputmode="numeric" maxlength="2" placeholder="half"></label>
<label class="fd">${infoLabel("GPUs through", "NVIDIA's device plugin (nvidia.com/gpu) or DRA (a device class), as the cluster offers them.")}<select name="j_mode"><option value="device-plugin">NVIDIA's device plugin</option><option value="dra">DRA: a device class you name</option></select></label>
<label class="fd">${infoLabel("DRA device class", "Only for DRA: the device class the cluster offers, such as gpu.nvidia.com.")}<input name="j_class" maxlength="253" placeholder="gpu.nvidia.com"></label>
<label class="fd">${infoLabel("Storage class", "The class for the rig's volume (its state, builds, inbox and outbox). Empty: the cluster's default.")}<input name="j_storage" maxlength="63" placeholder="the cluster's default"></label>
<label class="fd">${infoLabel("Volume size (GB)", "The rig's volume: builds and model files can be large.")}<input name="j_size" value="100"></label>
</div></div>`;
    const images = opts.rigImages;
    const blocked = !images
      ? "Control has no rig images configured (THERMITE_RIG_HARNESS_IMAGE, THERMITE_RIG_SUPERVISOR_IMAGE), so it can't set rigs up yet."
      : !opts.publicUrl
        ? "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL), so a rig would not know where to report."
        : "";
    return page(
      c,
      {
        title: "Add a rig",
        crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
        active: "rigs",
      },
      `<p class="run-said">Choose where the rig runs. On a machine or cluster control knows, control connects with the credentials you gave it once, writes the rig's files and services, starts it and looks after it: stop, start, restart, remove. Where control can't connect, you run one command it gives you.</p>
${error ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not created.</b> ${esc(error)}</div>` : ""}${blocked ? `<div class="card warn" style="margin-bottom:16px">${esc(blocked)}</div>` : ""}
<form id="add-rig" method="post" action="/ui/rigs/add" autocomplete="off"><input type="hidden" name="csrf" value="${t}">
<div class="sec"><h2>1 · Where</h2><p class="lead">A machine or a cluster control knows. They are added, checked and prepared under <a href="/ui/settings">Settings › Providers</a>.</p>
<div class="stack">${cards}${clusterCards}${cards || clusterCards ? "" : `<div class="card"><div class="empty">No machine or cluster yet.</div></div>`}<a class="ch" href="/ui/settings"><span><b>+ A new machine or cluster</b><br><span class="muted small">A Linux machine control can reach with an SSH key, or a Kubernetes cluster through a kubeconfig. Add it in Providers, then come back.</span></span></a></div>
<p class="lead" style="margin-top:14px">Or run it yourself, where control can't connect:</p><div class="stack">${joinCards}</div>
<p class="lead" style="margin-top:14px">Or launch it on a GPU you rent by the hour:</p><div class="stack">${
        store
          .gpuClouds()
          .map(
            (g) =>
              `<a class="ch" href="/ui/rigs/add/runpod?cloud=${encodeURIComponent(g.name)}"><span><b>${esc(g.name)} · RunPod</b><br><span class="muted small">Control starts a pod with Thermite's rig image, enrolls it and follows its price. RunPod bills it by the second while it runs. Opens Launch on RunPod.</span></span></a>`,
          )
          .join("") ||
        `<a class="ch" href="/ui/settings"><span><b>+ A RunPod account</b><br><span class="muted small">Add it in Providers with an API key that may start pods, then come back to launch a rig on it.</span></span></a>`
      }</div></div>
<div class="sec"><h2>2 · GPUs and resources</h2><p class="lead">As control last read the place. One GPU is shared by the judge and the agents. With more, some are the judge's and the rest the agents': half each by default, and on a machine the lowest-numbered GPUs are the judge's.</p>${gpuLists}<label class="fd" id="judge-pick" hidden style="max-width:280px;margin-top:10px">${infoLabel("GPUs for the judge", "How many of the chosen GPUs the judge measures on: the lowest-numbered ones. The rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. Default: half, rounded up.")}<input name="judge_gpus" inputmode="numeric" maxlength="2" placeholder="half"></label>${clusterSections}${joinSections}<div class="nc-does" id="gpu-note"></div></div>
<div class="sec"><h2>3 · Name and start</h2><div class="g3">
<label class="fd">${infoLabel("Rig name", "The rig's name in Thermite: 2 to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit. It names the rig's runs, history and files, so it can't change later.")}<input name="rig" required maxlength="40" placeholder="gpu-box-1-a"></label>
<label class="fd" style="grid-column:span 2">${infoLabel("Images", "The Thermite images control deploys, as set where control is deployed. A GPU rig uses the CUDA harness image.")}<span class="mono small">${images ? `${esc(images.harness)}${images.harnessCuda ? `<br>${esc(images.harnessCuda)} (GPU rigs)` : ""}<br>${esc(images.supervisor)}` : "none configured"}</span></label>
</div>
<div class="card hl"><p class="sum" id="add-sum">Control will enroll the rig, write its files and services on the machine, start it, and wait for its first report.</p><div class="act"><button class="primary big"${blocked ? " disabled" : ""}>Create the rig</button></div></div></div>
</form>
<script src="/ui/assets/add-rig.js" defer></script>`,
    );
  });
  app.post("/ui/rigs/add", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const fail = (why: string) => c.redirect(`/ui/rigs/add?error=${encodeURIComponent(why)}`, 303);
    const rig = String(f.rig ?? "").trim();
    const place = String(f.place ?? (f.machine ? `machine:${String(f.machine)}` : ""));
    if (place.startsWith("cluster:")) return addClusterRigFrom(c, f, rig, place.slice(8), fail);
    if (place.startsWith("join:")) return addJoinedRigFrom(c, f, rig, place.slice(5), fail);
    const m = store.machine(place.startsWith("machine:") ? place.slice(8) : "");
    const gpus = [f.gpus ?? []]
      .flat()
      .map((x) => Number(x))
      .sort((a, b) => a - b);
    if (!opts.rigImages) return fail("Control has no rig images configured.");
    if (!opts.publicUrl) return fail("Control's address for rigs is not set.");
    if (!RIG_ID.test(rig)) return fail(RIG_ID_SENTENCE);
    if (rigTaken(rig)) return fail(`There is a rig named ${rig} already.`);
    if (!m) return fail("Choose a machine.");
    const why = notReady(m);
    if (why) return fail(`${m.name} is not ready: ${why}.`);
    const facts = m.facts as MachineFacts;
    const used = gpusInUse(m.name);
    for (const g of gpus) {
      if (!facts.gpus.some((x) => x.index === g)) return fail(`${m.name} has no GPU ${g}.`);
      if (used.has(g)) return fail(`GPU ${g} is used by rig ${used.get(g)}.`);
    }
    if (new Set(gpus).size !== gpus.length) return fail("Name each GPU once.");
    if (gpus.length > MAX_RIG_GPUS) return fail(`A rig takes at most ${MAX_RIG_GPUS} GPUs.`);
    const judge = judgeShare(String(f.judge_gpus ?? "").trim(), gpus.length);
    if (typeof judge === "string") return fail(judge);
    if (gpus.length && !(facts.nvidia_ctk && facts.cdi))
      return fail(`${m.name} needs NVIDIA's container toolkit first: install it under Providers.`);
    if (gpus.length && !opts.rigImages.harnessCuda)
      return fail(
        "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).",
      );
    const images = {
      harness: gpus.length ? (opts.rigImages.harnessCuda as string) : opts.rigImages.harness,
      supervisor: opts.rigImages.supervisor,
    };
    const token = newToken();
    store.enrollRig(rig, token.sha256, "owner:ui");
    const placed = {
      rig,
      machine: m.name,
      gpus,
      judge_gpus: judge,
      images,
      root: facts.root,
      created_by: "owner:ui",
    };
    store.addMachineRig(placed);
    store.rigSetupEvent(rig, "enrolled", true);
    const r = store.machineRig(rig) as MachineRig;
    void inBackground(store, "machine", rig, "deploy", deployRig(r, m, token.token));
    return c.redirect(`/ui/rigs/${encodeURIComponent(rig)}`, 303);
  });
  /** Add a rig on a cluster: checks the choices, enrolls the rig, then applies its objects. */
  /**
   * Adds a rig on a cluster control knows and sets it up in the background: from Add a rig's
   * form, or over MCP (add_cluster_rig). Says why in words when it can't.
   */
  const addClusterRig = async (
    i: ClusterRigRequest,
    by: string,
  ): Promise<{ rig: string } | { error: string }> => {
    const fail = (error: string) => ({ error });
    const { rig } = i;
    const k = store.cluster(i.cluster);
    if (!opts.rigImages) return fail("Control has no rig images configured.");
    if (!opts.publicUrl) return fail("Control's address for rigs is not set.");
    if (!RIG_ID.test(rig)) return fail(RIG_ID_SENTENCE);
    if (rigTaken(rig)) return fail(`There is a rig named ${rig} already.`);
    if (!k) return fail("Choose a machine or a cluster.");
    const facts = k.facts as ClusterFacts | null;
    if (!facts || k.check_error) return fail(`${k.name} is not ready: check it under Providers.`);
    const gpus = i.gpus;
    if (!Number.isInteger(gpus) || gpus < 0 || gpus > MAX_RIG_GPUS)
      return fail(`A rig takes from none to ${MAX_RIG_GPUS} GPUs.`);
    const judgeGpus = judgeShare(i.judgeGpus === undefined ? "" : String(i.judgeGpus), gpus);
    if (typeof judgeGpus === "string") return fail(judgeGpus);
    // Control checks only what it could see: a slot's role may not list nodes, classes or storage.
    const mode = i.mode || "device-plugin";
    const deviceClass = mode.startsWith("dra:")
      ? mode.slice(4)
      : mode === "dra"
        ? i.deviceClass
        : undefined;
    if (gpus && mode === "dra" && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(deviceClass ?? ""))
      return fail("Name the DRA device class, such as gpu.nvidia.com.");
    if (gpus && mode.startsWith("dra:") && !facts.device_classes.includes(deviceClass ?? ""))
      return fail(`${k.name} has no DRA device class ${deviceClass}.`);
    if (gpus && !deviceClass && facts.nodes.length && !facts.nodes.some((n) => n.gpus >= gpus))
      return fail(
        `No node of ${k.name} offers ${gpus} GPU${gpus === 1 ? "" : "s"} through the device plugin.`,
      );
    const node = i.node || undefined;
    if (node && facts.nodes.length && !facts.nodes.some((n) => n.name === node))
      return fail(`${k.name} has no node ${node} that control can see.`);
    const storageClass = i.storageClass || undefined;
    if (
      storageClass &&
      facts.storage_classes.length &&
      !facts.storage_classes.some((s) => s.name === storageClass)
    )
      return fail(`${k.name} has no storage class ${storageClass}.`);
    if (storageClass && !NS.test(storageClass)) return fail("That is not a storage class name.");
    const storageGi = i.storageGi ?? 100;
    if (!Number.isInteger(storageGi) || storageGi < 1 || storageGi > 10_000)
      return fail("The volume size is a whole number of GB, from 1 to 10000.");
    let namespace: string;
    let slotQuota: ClusterSlot["quota"];
    if (k.placement === "slot") {
      namespace = i.slot ?? "";
      const slot = facts.slots.find((s) => s.namespace === namespace && s.usable && !s.used_by);
      if (!slot) return fail("Choose a free slot.");
      slotQuota = slot.quota;
      if (
        store.clusterRigs(k.name).some((r) => r.namespace === namespace && r.status !== "removed")
      )
        return fail(`The slot ${namespace} is in use.`);
      // Refuse a slot whose rules don't keep this harness off the cluster.
      const net = await slotNetwork(kube, clusterTarget(k), namespace, {
        ...HARNESS_LABELS,
        "app.kubernetes.io/instance": rig,
      });
      if (!net.ok)
        return fail(
          `Refused: in the slot ${namespace}, ${net.why}. A rig's harness may reach only DNS, the internet and its model: ask the cluster's operators for a network rule that keeps it off the cluster.`,
        );
    } else {
      namespace = k.namespace_pattern.replace("{rig}", rig);
      if (!NS.test(namespace)) return fail(`"${namespace}" is not a namespace name.`);
    }
    // CPUs and memory: as given, else what the slot's quota allows; none: the namespace's defaults.
    const cpus = i.cpus ?? slotQuota?.cpus;
    const memoryGi = i.memoryGi ?? slotQuota?.memoryGi;
    let resources: { cpus: number; memoryGi: number } | undefined;
    if (cpus !== undefined || memoryGi !== undefined) {
      if (cpus === undefined || memoryGi === undefined)
        return fail("Give the rig both its CPUs and its memory, or neither.");
      try {
        rigResources({ cpus, memoryGi });
      } catch (err) {
        return fail(errorText(err));
      }
      if (slotQuota?.cpus !== undefined && cpus > slotQuota.cpus + 1e-9)
        return fail(`The slot ${namespace} allows ${slotQuota.cpus} CPUs.`);
      if (slotQuota?.memoryGi !== undefined && memoryGi > slotQuota.memoryGi + 1e-9)
        return fail(`The slot ${namespace} allows ${slotQuota.memoryGi} GiB of memory.`);
      resources = { cpus, memoryGi };
    }
    if (slotQuota?.storageGi !== undefined && storageGi > slotQuota.storageGi + 1e-9)
      return fail(`The slot ${namespace} allows ${slotQuota.storageGi} GB of storage.`);
    // GPUs: what the slot's quota allows through the device plugin, or of the DRA device class.
    const devices = quotaRefusal(namespace, slotQuota, { gpus, deviceClass });
    if (devices) return fail(devices);
    if (gpus && !opts.rigImages.harnessCuda)
      return fail(
        "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).",
      );
    const token = newToken();
    store.enrollRig(rig, token.sha256, by);
    store.addClusterRig({
      rig,
      cluster: k.name,
      namespace,
      placement: k.placement,
      spec: {
        gpus,
        judgeGpus,
        gpuMode: deviceClass ? "dra" : "device-plugin",
        deviceClass,
        node,
        storageClass,
        storageGi,
        resources,
        images: {
          harness: gpus ? (opts.rigImages.harnessCuda as string) : opts.rigImages.harness,
          supervisor: opts.rigImages.supervisor,
        },
        controlUrl: controlAddress(),
      },
      created_by: by,
    });
    store.rigSetupEvent(rig, "enrolled", true);
    const deploy = deployClusterRig(store.clusterRig(rig) as ClusterRig, k, token.token);
    void inBackground(store, "cluster", rig, "applied", deploy);
    return { rig };
  };
  if (opts.actions) opts.actions.addClusterRig = addClusterRig;
  /** Whether both of a rig's deployments (kubectl get -o json) run only their newest pods. */
  const rolledOut = (json: string) => {
    type D = {
      metadata?: { generation?: number };
      spec?: { replicas?: number };
      status?: {
        observedGeneration?: number;
        replicas?: number;
        updatedReplicas?: number;
        availableReplicas?: number;
      };
    };
    try {
      const items = (JSON.parse(json) as { items?: D[] }).items ?? [];
      return (
        items.length === 2 &&
        items.every((d) => {
          const want = d.spec?.replicas ?? 1;
          const st = d.status ?? {};
          return (
            (st.observedGeneration ?? 0) >= (d.metadata?.generation ?? 1) &&
            (st.replicas ?? 0) === want &&
            (st.updatedReplicas ?? 0) === want &&
            (st.availableReplicas ?? 0) === want
          );
        })
      );
    } catch {
      return false;
    }
  };
  /** Waits for a rig's new pods, for at most 15 minutes, then for a report from them. */
  const awaitNewPods = async (
    r: ClusterRig,
    k: Cluster & { kubeconfig_sealed: string },
    why: "images" | "start" | "resources" = "images",
  ) => {
    const n = clusterNames(r.rig);
    const set = (st: string) => store.setClusterRigStatus(r.rig, st);
    // The status this wait is for: a stop or a removal meanwhile ends it.
    const waiting = why === "start" ? "starting" : "updating";
    const still = () => store.clusterRig(r.rig)?.status === waiting;
    const [pods, report] =
      why === "images"
        ? ["images_running", "report_after_images"]
        : why === "resources"
          ? ["resources_running", "report_after_resources"]
          : ["pods_running", "report_after_start"];
    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
      if (!still()) return;
      const out = await kube.kubectl(
        clusterTarget(k),
        ["get", "deployment", n.harness, n.supervisor, "-n", r.namespace, "-o", "json"],
        undefined,
        60_000,
      );
      if (out.code === 0 && rolledOut(out.stdout)) break;
      if (Date.now() > deadline) {
        if (!still()) return;
        const err = out.code === 0 ? "" : `: ${kubeError(out)}`;
        store.rigSetupEvent(r.rig, pods, false, `not running after 15 minutes${err}`);
        set("failed");
        return;
      }
      await sleep(5000);
    }
    if (!still()) return;
    store.rigSetupEvent(r.rig, pods, true);
    await awaitFirstReport(r.rig, set, 10, Date.now(), { step: report, still });
  };
  /**
   * Moves a rig control set up on a cluster onto control's current images (its page, or MCP's
   * update_rig_images): its two deployments are applied again, and its secret (so its tokens),
   * volume claim, service and network rules stay. Then, in the background, waits for its new pods
   * and a report from them.
   */
  const updateClusterRigImages = async (
    rig: string,
    by: string,
    o: { wait?: boolean | undefined } = {},
  ): Promise<{ ok: string } | { error: string }> => {
    const r = store.clusterRig(rig);
    if (!r || r.status === "removed")
      return { error: `Control didn't set ${rig} up on a cluster.` };
    if (r.status === "deploying") return { error: `${rig} is still being set up.` };
    // The supervisor's CONTROL_URL comes from here: without it the rig would lose its way back.
    if (!opts.publicUrl)
      return {
        error:
          "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.",
      };
    const images = controlImages(r.spec.gpus);
    if (typeof images === "string") return { error: images };
    const old = r.spec.images;
    const k = store.cluster(r.cluster);
    if (!k) return { error: `The cluster ${r.cluster} is no longer in Providers.` };
    // A drain for a change to its GPUs, CPUs or memory (goal 118) is that change's.
    if (r.status === "draining" && r.pending)
      return {
        error: `${rig} is draining for a change to its GPUs, CPUs or memory: wait until its page shows it running, or call the change off first.`,
      };
    // A drain under way (goal 079): asked again, it goes on waiting; asked not to wait, the
    // update goes ahead now.
    if (r.status === "draining" && o.wait !== false)
      return {
        ok: `${rig} is draining: its pods restart on the new images once its trials and the judge's job end. Update now skips the wait.`,
      };
    // One change at a time: an update or a start still waiting for its pods is not overlapped.
    if (r.status === "updating" || r.status === "starting")
      return {
        error: `${rig} is ${r.status === "updating" ? "being updated" : "starting"}: wait until its page shows it running, or failed.`,
      };
    const addressOnly = old.harness === images.harness && old.supervisor === images.supervisor;
    // After a failed update the images are already recorded: applying them again retries it.
    const retry = addressOnly && r.status === "failed";
    if (addressOnly && !retry) {
      // Same images: only a changed address for control is worth a restart.
      const now = await kube.kubectl(
        clusterTarget(k),
        ["get", "deployment", clusterNames(rig).supervisor, "-n", r.namespace, "-o", "json"],
        undefined,
        30_000,
      );
      // An answer that is not a deployment is no answer: never take it for an unchanged rig.
      const env = now.code === 0 ? deploymentEnv(now.stdout) : null;
      if (!env)
        return {
          error: `Control could not read ${rig}'s deployment to compare control's address: ${now.code === 0 ? "kubectl's answer is not a deployment" : kubeError(now)}`,
        };
      const was = env.find((x) => x.name === "CONTROL_URL")?.value;
      if (was === undefined || was === opts.publicUrl.replace(/\/$/, ""))
        return { ok: `${rig} already runs control's images.` };
    }
    const stopped = r.status === "stopped";
    // Drain first (goal 079): while trials run or the judge has a job under way, the rig starts
    // nothing new and lets those end; the watcher below restarts its pods once nothing runs.
    // A harness too old to report its work is updated at once, as before.
    const work = rigWork(rig);
    if (
      o.wait !== false &&
      !stopped &&
      r.status !== "draining" &&
      work &&
      (work.trials > 0 || work.judge_jobs > 0)
    ) {
      issueCommand(store, opts.privateKeyPem, {
        rig,
        kind: "drain_rig",
        payload: { drain: true, reason: IMAGES_REASON },
        issuedBy: by,
      });
      store.setClusterRigStatus(rig, "draining");
      store.rigSetupEvent(rig, "drain", true, `waiting for ${workWords(work)} to finish`);
      store.audit(by, "cluster_rig_drain", { rig, to: images });
      return {
        ok: `${rig} drains first: it starts nothing new, and its pods restart on the new images once ${workWords(work)} ${work.trials + work.judge_jobs === 1 ? "finishes" : "finish"}. Update now, on its page or with update_rig_images and wait false, skips the wait.`,
      };
    }
    const out = await kube.kubectl(
      clusterTarget(k),
      ["apply", "-f", "-"],
      asList(clusterRigDeployments(clusterPlan(r, images), stopped)),
      120_000,
    );
    if (out.code !== 0) {
      store.rigSetupEvent(rig, "images", false, kubeError(out));
      // A rig that drained for it goes back to work: the update did not happen.
      if (r.status === "draining") {
        undrain(rig, by);
        store.setClusterRigStatus(rig, "failed");
      }
      return { error: kubeError(out) };
    }
    store.setClusterRigImages(rig, images, controlAddress());
    const changed =
      [
        old.harness !== images.harness ? `harness ${old.harness} → ${images.harness}` : "",
        old.supervisor !== images.supervisor
          ? `supervisor ${old.supervisor} → ${images.supervisor}`
          : "",
      ]
        .filter(Boolean)
        .join("; ") ||
      (retry
        ? "the same images again, after a failed change"
        : `control's address for rigs → ${opts.publicUrl}`);
    store.rigSetupEvent(rig, "images", true, stopped ? `${changed}; at its next start` : changed);
    store.audit(by, "cluster_rig_images", { rig, from: old, to: images });
    if (stopped)
      return {
        ok: addressOnly
          ? `${rig} gets control's new address when it starts again.`
          : `${rig} runs the new images when it starts again.`,
      };
    store.setClusterRigStatus(rig, "updating");
    void inBackground(store, "cluster", r.rig, "images_running", awaitNewPods(r, k));
    return {
      ok: retry
        ? `${rig}'s pods restart on control's images again (a retry).`
        : addressOnly
          ? `${rig}'s pods restart with control's new address.`
          : `${rig}'s pods restart on the new images.`,
    };
  };
  if (opts.actions) opts.actions.updateRigImages = updateClusterRigImages;
  const IMAGES_REASON = "its images are about to change";
  const RESIZE_REASON = "its GPUs, CPUs or memory are about to change";
  /** What a slot's quota allows now, read again; the last check's when control can't read it. */
  const slotQuotaNow = async (
    r: ClusterRig,
    k: Cluster & { kubeconfig_sealed: string },
  ): Promise<SlotQuota | undefined> => {
    if (r.placement !== "slot") return undefined;
    const out = await kube.kubectl(
      clusterTarget(k),
      ["get", "resourcequota", "-n", r.namespace, "-o", "json"],
      undefined,
      30_000,
    );
    if (out.code === 0) return slotQuota(out.stdout);
    return (k.facts as ClusterFacts | null)?.slots.find((x) => x.namespace === r.namespace)?.quota;
  };
  type Resize = { ok: string } | ResizeRefusal;
  /**
   * Checks a change to the GPUs, CPUs or memory of a rig control set up on a cluster (goal 118),
   * with the slot's quota read again, and says what it would do: a refusal in words, words with
   * nothing to do, or `go`, which drains the rig first while it works, else applies the change.
   * Edit rig checks everything before it saves anything, so the check and the change are apart.
   */
  const prepareResize = async (
    rig: string,
    want: ClusterResourcesRequest,
    by: string,
    o: { wait?: boolean | undefined; owner: boolean },
  ): Promise<Resize | { go: () => Promise<Resize> }> => {
    const r = store.clusterRig(rig);
    if (!r || r.status === "removed")
      return { error: `Control didn't set ${rig} up on a cluster.`, status: 404 };
    if (r.status === "deploying") return { error: `${rig} is still being set up.`, status: 409 };
    // The supervisor's CONTROL_URL comes from here, as in an image update.
    if (!opts.publicUrl)
      return {
        error:
          "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.",
        status: 409,
      };
    const k = store.cluster(r.cluster);
    if (!k) return { error: `The cluster ${r.cluster} is no longer in Providers.`, status: 409 };
    if (r.status === "updating" || r.status === "starting")
      return {
        error: `${rig} is ${r.status === "updating" ? "being updated" : "starting"}: wait until its page shows it running, or failed.`,
        status: 409,
      };
    if (r.status === "draining" && !r.pending)
      return {
        error: `${rig} is draining for an image update: wait until its page shows it running, or call the update off first.`,
        status: 409,
      };
    const pending = r.status === "draining" ? r.pending : undefined;
    // During its own drain, a call that names nothing goes on with the change it waits for.
    if (pending && asksNothing(want))
      return o.wait === false
        ? { go: () => applyResize(rig, pending, by) }
        : {
            ok: `${rig} is draining: its pods restart with ${sizeWords(pending)} once its trials and the judge's job end. Change now skips the wait.`,
          };
    const plan = planClusterResize(r, want, {
      owner: o.owner,
      facts: k.facts as ClusterFacts | null,
      quota: await slotQuotaNow(r, k),
    });
    if ("error" in plan) return plan;
    if ("same" in plan)
      return { ok: `Nothing changed: ${rig} has these GPUs, CPUs and memory already.` };
    const next: ClusterRigResize = { ...plan.size, by };
    return {
      go: async () => {
        const now = store.clusterRig(rig);
        if (!now || now.status === "removed")
          return { error: `Control didn't set ${rig} up on a cluster.`, status: 404 };
        const work = rigWork(rig);
        if (
          o.wait === false ||
          now.status === "stopped" ||
          (now.status !== "draining" && !(work && (work.trials > 0 || work.judge_jobs > 0)))
        )
          return applyResize(rig, next, by);
        // Drain first (goal 079): the rig starts nothing new, and the watcher below applies the
        // change once nothing runs. A drain under way takes the new size instead.
        store.setClusterRigPending(rig, next);
        if (now.status === "draining" || !work) {
          store.rigSetupEvent(rig, "drain", true, `now for ${sizeChangeWords(sizeOf(now), next)}`);
          return {
            ok: `${rig} is draining: its pods restart with ${sizeWords(next)} once its trials and the judge's job end. Change now skips the wait.`,
          };
        }
        issueCommand(store, opts.privateKeyPem, {
          rig,
          kind: "drain_rig",
          payload: { drain: true, reason: RESIZE_REASON },
          issuedBy: by,
        });
        store.setClusterRigStatus(rig, "draining");
        store.rigSetupEvent(rig, "drain", true, `waiting for ${workWords(work)} to finish`);
        store.audit(by, "cluster_rig_drain", { rig, to: sizeChangeWords(sizeOf(now), next) });
        return {
          ok: `${rig} drains first: it starts nothing new, and its pods restart with ${sizeWords(next)} once ${workWords(work)} ${work.trials + work.judge_jobs === 1 ? "finishes" : "finish"}. Change now, on its page or with set_cluster_rig_resources and wait false, skips the wait.`,
        };
      },
    };
  };
  /**
   * Applies a new size to a rig control set up on a cluster: its two deployments again, on the
   * images it runs (for DRA, with a new claim template: a template can't change, so the old one is
   * deleted first). Its secret (so its tokens), volume claim, service and network rules stay. A
   * stopped rig stays stopped. Then, in the background, waits for its new pods and a report.
   */
  const applyResize = async (rig: string, size: ClusterRigResize, by: string): Promise<Resize> => {
    const r = store.clusterRig(rig);
    if (!r || r.status === "removed")
      return { error: `Control didn't set ${rig} up on a cluster.`, status: 404 };
    const k = store.cluster(r.cluster);
    if (!k) return { error: `The cluster ${r.cluster} is no longer in Providers.`, status: 409 };
    const from = sizeOf(r);
    const to: ClusterRigSize = {
      gpus: size.gpus,
      judgeGpus: size.judgeGpus,
      resources: size.resources,
    };
    const stopped = r.status === "stopped";
    const draining = r.status === "draining";
    const target = clusterTarget(k);
    const failed = (why: string): ResizeRefusal => {
      store.rigSetupEvent(rig, "resources", false, why);
      // A rig that drained for it goes back to work: the change did not happen.
      if (draining) {
        undrain(rig, by);
        store.setClusterRigStatus(rig, "failed");
      }
      return { error: why, status: 409 };
    };
    const newClaim = r.spec.gpuMode === "dra" && to.gpus > 0 && to.gpus !== from.gpus;
    let objects: string;
    try {
      objects = asList(
        clusterRigResized(clusterPlan({ ...r, spec: { ...r.spec, ...to } }), stopped),
      );
    } catch (err) {
      return failed(errorText(err));
    }
    if (newClaim) {
      const del = await kube.kubectl(
        target,
        [
          "delete",
          "resourceclaimtemplate",
          clusterNames(rig).gpus,
          "-n",
          r.namespace,
          "--ignore-not-found",
        ],
        undefined,
        60_000,
      );
      if (del.code !== 0) return failed(kubeError(del));
    }
    const out = await kube.kubectl(target, ["apply", "-f", "-"], objects, 120_000);
    if (out.code !== 0) {
      // The old claim template back, so that its pods start as before.
      if (newClaim) {
        const back = await kube.kubectl(
          target,
          ["apply", "-f", "-"],
          asList(
            clusterRigResized(clusterPlan(r), stopped).filter(
              (x) => x.kind === "ResourceClaimTemplate",
            ),
          ),
          60_000,
        );
        if (back.code !== 0)
          return failed(
            `${kubeError(out)}; its old claim template could not be put back either: ${kubeError(back)}`,
          );
      }
      return failed(kubeError(out));
    }
    store.setClusterRigSize(rig, to, controlAddress());
    let words = sizeChangeWords(from, to);
    // The judge's share a rig keeps from Edit rig comes before its deployment's, so it follows the
    // new size. Its harness takes it only from an owner: issuer: the one who asked.
    const kept = rigSettingsOf(store, rig)?.settings?.judge_gpus;
    if (
      to.gpus >= 2 &&
      to.gpus !== from.gpus &&
      to.judgeGpus !== undefined &&
      typeof kept === "number" &&
      kept !== to.judgeGpus
    ) {
      try {
        issueCommand(store, opts.privateKeyPem, {
          rig,
          kind: "rig_settings",
          payload: { judge_gpus: to.judgeGpus },
          issuedBy: size.by,
        });
        words += `; the judge's share it kept, ${kept}, → ${to.judgeGpus}`;
      } catch (err) {
        words += `; the judge's share it keeps, ${kept}, did not change: ${errorText(err)}`;
      }
    }
    store.rigSetupEvent(rig, "resources", true, stopped ? `${words}; at its next start` : words);
    store.audit(by, "cluster_rig_resources", { rig, from, to });
    if (stopped) return { ok: `${rig} has ${sizeWords(to)} when it starts again.` };
    store.setClusterRigStatus(rig, "updating");
    void inBackground(
      store,
      "cluster",
      r.rig,
      "resources_running",
      awaitNewPods(r, k, "resources"),
    );
    return { ok: `${rig}'s pods restart with ${sizeWords(to)}.` };
  };
  /** Checks and makes a change to a cluster rig's GPUs, CPUs or memory (REST and MCP). */
  const resizeClusterRig = async (
    rig: string,
    want: ClusterResourcesRequest,
    by: string,
    o: { wait?: boolean | undefined; owner: boolean },
  ): Promise<Resize> => {
    const p = await prepareResize(rig, want, by, o);
    return "go" in p ? p.go() : p;
  };
  if (opts.actions) opts.actions.setClusterRigResources = resizeClusterRig;
  /** What a rig still runs, as its last report says (goal 079); none from an older harness. */
  const rigWork = (
    rig: string,
  ): { trials: number; judge_jobs: number; draining: unknown } | undefined => {
    const w = (store.rigs().find((x) => x.id === rig)?.summary as { work?: unknown } | undefined)
      ?.work as { trials?: unknown; judge_jobs?: unknown; draining?: unknown } | undefined;
    if (!w || typeof w.trials !== "number" || typeof w.judge_jobs !== "number") return undefined;
    return { trials: w.trials, judge_jobs: w.judge_jobs, draining: w.draining ?? null };
  };
  const workWords = (w: { trials: number; judge_jobs: number }) =>
    [
      w.trials ? `${w.trials} trial${w.trials === 1 ? "" : "s"}` : "",
      w.judge_jobs ? `the judge's job${w.judge_jobs === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" and ") || "its work";
  /** A drain ends: the rig starts work again (its images did not change). */
  const undrain = (rig: string, by: string) =>
    issueCommand(store, opts.privateKeyPem, {
      rig,
      kind: "drain_rig",
      payload: { drain: false, reason: "the update did not happen" },
      issuedBy: by,
    });
  /**
   * A harness keeps its drain in memory only: one that started again since it took the drain
   * reports none, and goes back to work. Asked again, it drains again: once the last ask is taken
   * and two reports after it say no drain. One is not enough: a report's summary can be read
   * before the drain took effect and reach control after the ask was taken.
   */
  const undrained = new Map<string, { ask: string; seen: string }>();
  const redrain = (rig: string) => {
    const last = store.latestCommands(rig, "drain_rig", 1)[0];
    if (last?.payload.drain !== true || last.status === "pending" || !last.acked_at) return;
    const seen = store.rigs().find((x) => x.id === rig)?.last_seen;
    if (!seen || Date.parse(seen) <= Date.parse(last.acked_at)) return;
    const first = undrained.get(rig);
    if (first?.ask !== last.id) {
      undrained.set(rig, { ask: last.id, seen });
      return;
    }
    if (first.seen === seen) return;
    undrained.delete(rig);
    issueCommand(store, opts.privateKeyPem, {
      rig,
      kind: "drain_rig",
      payload: {
        drain: true,
        reason: store.clusterRig(rig)?.pending ? RESIZE_REASON : IMAGES_REASON,
      },
      issuedBy: "control:drain",
    });
    store.rigSetupEvent(
      rig,
      "drain",
      true,
      "its harness started again and was not draining: asked again",
    );
  };
  /** The owner calls the update off: the rig goes back to work on its images. */
  const cancelDrain = (rig: string, by: string): { ok: string } | { error: string } => {
    const r = store.clusterRig(rig);
    if (r?.status !== "draining") return { error: `${rig} is not draining.` };
    undrain(rig, by);
    store.setClusterRigStatus(rig, "running");
    if (r.pending) {
      store.rigSetupEvent(
        rig,
        "drain",
        true,
        "called off: the rig goes back to work with its GPUs, CPUs and memory as they were",
      );
      return { ok: `${rig} goes back to work with its GPUs, CPUs and memory as they were.` };
    }
    store.rigSetupEvent(rig, "drain", true, "called off: the rig goes back to work on its images");
    return { ok: `${rig} goes back to work on its images.` };
  };
  // A draining rig's pods restart once its report says nothing runs any more (goal 079), on new
  // images or with the new size it waits for (goal 118). A rig whose change is still being
  // applied is not applied again.
  const moving = new Set<string>();
  const drainWatch = setInterval(() => {
    for (const r of store.clusterRigs().filter((x) => x.status === "draining")) {
      if (moving.has(r.rig)) continue;
      const w = rigWork(r.rig);
      if (w && w.draining === null) redrain(r.rig);
      else undrained.delete(r.rig);
      if (!w || w.draining === null || w.trials > 0 || w.judge_jobs > 0) continue;
      store.rigSetupEvent(r.rig, "drain", true, "nothing runs any more: its pods restart now");
      moving.add(r.rig);
      const move = r.pending
        ? applyResize(r.rig, r.pending, "control:drain")
        : updateClusterRigImages(r.rig, "control:drain", { wait: false });
      void inBackground(store, "cluster", r.rig, r.pending ? "resources" : "images", move).finally(
        () => moving.delete(r.rig),
      );
    }
  }, opts.drainWatchMs ?? 10_000);
  drainWatch.unref?.();
  const addClusterRigFrom = async (
    c: Ctx,
    f: Record<string, unknown>,
    rig: string,
    name: string,
    fail: (why: string) => Response,
  ) => {
    const one = (key: string) => {
      const v = f[`${key}__${name}`];
      return String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
    };
    const num = (key: string) => (one(key) ? Number(one(key)) : undefined);
    const r = await addClusterRig(
      {
        rig,
        cluster: name,
        slot: one("k_slot") || undefined,
        gpus: Number(one("k_gpus") || "0"),
        judgeGpus: one("k_judge") || undefined,
        mode: one("k_mode") || "device-plugin",
        deviceClass: one("k_class") || undefined,
        node: one("k_node") || undefined,
        storageClass: one("k_storage") || undefined,
        storageGi: Number(one("k_size") || "100"),
        cpus: num("k_cpus"),
        memoryGi: num("k_mem"),
      },
      "owner:ui",
    );
    if ("error" in r) return fail(r.error);
    return c.redirect(`/ui/rigs/${encodeURIComponent(r.rig)}`, 303);
  };
  // ---------------------------------------------------------------- rigs you join yourself
  // For a place control can't connect to (join.ts): control mints a one-time join command; run
  // there, it fetches the rig's files or manifest from /v1/join. Control keeps only its hash.
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const mintJoin = (rig: string): string => {
    const t = newToken();
    const expires = Date.now() + JOIN_HOURS * 3_600_000;
    store.setJoinToken(rig, t.sha256, new Date(expires).toISOString(), "owner:ui");
    store.rigSetupEvent(rig, "join_made", true, `works once, until ${hhmm(expires)} UTC`);
    return t.token;
  };
  const JOIN_STATUS: Record<string, string> = {
    waiting: "waiting for you to run the join command",
    joining: "fetched its files; waiting for its first report",
    running: "running",
    failed: "no first report yet",
    retired: "retired",
  };
  /** A rig you join yourself: where, the join command, and the commands control can't run. */
  const joinedBlock = (r: JoinedRig, t: string, token?: string, reporting = false) => {
    const rName = encodeURIComponent(r.rig);
    const act = (action: string, label: string, extra = "", cls = "sm") =>
      `<form class="inline" method="post" action="/ui/rigs/${rName}/join/${action}"><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
    const s = r.spec;
    const now = Date.now();
    const status =
      reporting && (r.status === "joining" || r.status === "failed") ? "running" : r.status;
    const expires = r.join_expires_at ? Date.parse(r.join_expires_at) : 0;
    const machine = r.form === "machine";
    const gpuList = machine ? (s.gpus as number[]) : [];
    const gpuCount = machine ? gpuList.length : (s.gpus as number);
    const gpus = machine
      ? gpuList.length
        ? gpuRoles(gpuList, s.judgeGpus)
        : "none: it measures on the CPU"
      : gpuCount
        ? `${gpuCount} through ${s.gpuMode === "dra" ? `DRA (${esc(s.deviceClass ?? "")})` : "NVIDIA's device plugin"}: ${splitWords(gpuCount, s.judgeGpus)}`
        : "none: it measures on the CPU";
    const cmd = token
      ? joinCommand(r.form, {
          controlUrl: opts.publicUrl ?? "",
          rig: r.rig,
          token,
          namespace: s.namespace,
        })
      : "";
    const joinCard =
      status === "retired"
        ? ""
        : token
          ? `<div class="card hl" style="margin-top:10px"><p class="sum">${machine ? "Run this on the machine, as the user the rig should run as. Root works too, but a user with rootless Podman is safer." : `Run this where kubectl reaches the cluster, with rights in the namespace ${esc(s.namespace)}.`}</p><pre class="json" style="white-space:pre-wrap;word-break:break-all">${esc(cmd)}</pre><div class="muted small">Shown once: copy it now. It works once, until ${hhmm(expires)} UTC. Control keeps only a hash of it, so it can't show it again; if you lose it, make a new one.</div></div>`
          : !r.join_used_at && expires > now
            ? `<div class="card" style="margin-top:10px"><div class="small">A join command waits, until ${hhmm(expires)} UTC. Control can't show it again.</div><div class="act" style="margin-top:8px">${act("new", "Make a new join command")}${act("revoke", "Revoke it")}</div></div>`
            : `<div class="card" style="margin-top:10px"><div class="small">${r.join_used_at ? `The join command was used ${esc(ago(r.join_used_at, now))} ago. To set the rig up again, remove it there first (below), then make a new one; its old token then stops working.` : r.join_expires_at ? "The join command expired unused." : "No join command waits."}</div><div class="act" style="margin-top:8px">${act("new", "Make a new join command")}</div></div>`;
    const needs = machine
      ? `<div class="small" style="margin-top:10px"><b>What the machine needs.</b> The command checks these first and writes nothing if one is missing.<ul style="margin:4px 0 0 18px"><li>Linux with systemd, and Podman 4.4 or later.</li><li>For a user: lingering on, so the rig's services outlive your login: <code>sudo loginctl enable-linger $USER</code>.</li>${gpuCount ? `<li>NVIDIA's container toolkit, with a CDI spec: <code>sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml</code>.</li>` : ""}<li>A way to control (${esc(opts.publicUrl ?? "")}) and to the image registry. Control never connects to the machine.</li></ul></div>`
      : `<div class="small" style="margin-top:10px"><b>What the namespace needs.</b><ul style="margin:4px 0 0 18px"><li>Your rights there to create deployments, services, secrets, volume claims and network policies${s.gpuMode === "dra" && gpuCount ? ", and resource claim templates" : ""}.</li><li>Its pods reach control (${esc(opts.publicUrl ?? "")}) and the image registry.</li></ul>The manifest has the rig's network rules: the harness reaches DNS and the internet, not the cluster, and only its supervisor reaches the harness.</div>`;
    const cmds = joinedCommands(r.form, r.rig, s);
    const pre = (label: string, text: string) =>
      `<div class="small" style="margin-top:8px">${label}</div><pre class="json" style="white-space:pre-wrap;word-break:break-all">${esc(text)}</pre>`;
    const yours =
      status === "waiting"
        ? ""
        : `<details style="margin-top:10px"><summary class="small">Stop, start, restart or remove it: you run these there</summary><div class="muted small" style="margin-top:6px">Control can't reach this place, so these are yours to run${machine ? `, as ${s.root ? "root" : "the user the rig runs as"}` : ""}. Remove deletes the rig's ${machine ? "units, files and volumes" : "objects in the namespace"}; results it has not exported are lost.</div>${pre("Stop", cmds.stop)}${pre("Start", cmds.start)}${pre("Restart", cmds.restart)}${pre("Remove", cmds.remove)}</details>`;
    const retire =
      status === "retired"
        ? ""
        : `<details style="margin-top:8px"><summary class="small">Retire it</summary><div class="small muted" style="margin:6px 0">Its token stops working at once, so it can't report or take commands, and any join command stops working. Its files stay there until you remove them with the command above.</div>${act("retire", "Retire the rig", `<input name="confirm" placeholder="type: retire ${esc(r.rig)}" style="margin-right:6px">`, "sm danger")}</details>`;
    return `<div class="block"><div class="head"><h2>You run it yourself</h2><span class="right">${esc(JOIN_STATUS[status] ?? status)}</span></div><div class="card"><dl class="facts"><dt>Where</dt><dd>${machine ? "a machine you set it up on" : `the namespace ${esc(s.namespace)}, applied by you`}</dd><dt>GPUs</dt><dd>${gpus}</dd>${machine ? "" : `<dt>Storage</dt><dd>${s.storageGi} GB${s.storageClass ? ` · ${esc(s.storageClass)}` : ""}</dd>`}<dt>Images</dt><dd class="mono small">${esc(s.images.harness)}<br>${esc(s.images.supervisor)}</dd></dl>${joinCard}
<div class="tl" style="margin-top:10px">${setupSteps(r.rig) || `<div class="muted small">No step yet.</div>`}</div>${status === "waiting" ? needs : ""}${yours}${retire}</div></div>`;
  };
  /** The page of a joined rig that has not reported yet. */
  const joinedPage = (c: Ctx, r: JoinedRig, flash: string, token?: string) =>
    page(
      c,
      {
        title: r.rig,
        crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
        summary: `you run it yourself · ${esc(JOIN_STATUS[r.status] ?? r.status)}`,
        active: "rigs",
        // A page showing the join command never reloads itself: the command is shown once.
      },
      `<p class="run-said">${
        r.status === "retired"
          ? `${esc(r.rig)} is retired.`
          : r.join_used_at
            ? `${esc(r.rig)} fetched its files from control ${esc(ago(r.join_used_at, Date.now()))} ago. Its page fills in once it reports for the first time.`
            : `Run the join command ${r.form === "machine" ? "on the machine" : "against the cluster"}. It fetches the rig's ${r.form === "machine" ? "files and services" : "objects"} from control and starts it; the page fills in once the rig reports for the first time.`
      }</p>${flash}${joinedBlock(r, csrf(c), token)}`,
    );
  const DRA_CLASS = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
  /** Add a rig you join yourself: checks the choices, then shows its join command once. */
  const addJoinedRigFrom = (
    c: Ctx,
    f: Record<string, unknown>,
    rig: string,
    form: string,
    fail: (why: string) => Response,
  ) => {
    const one = (key: string) => {
      const v = f[key];
      return String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
    };
    if (!opts.rigImages) return fail("Control has no rig images configured.");
    if (!opts.publicUrl) return fail("Control's address for rigs is not set.");
    if (!RIG_ID.test(rig)) return fail(RIG_ID_SENTENCE);
    if (rigTaken(rig)) return fail(`There is a rig named ${rig} already.`);
    if (form !== "machine" && form !== "namespace") return fail("Choose where the rig runs.");
    const cuda = "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).";
    const imagesFor = (gpu: boolean) => ({
      harness: gpu ? (opts.rigImages?.harnessCuda as string) : (opts.rigImages?.harness as string),
      supervisor: opts.rigImages?.supervisor as string,
    });
    let spec: JoinedSpec;
    if (form === "machine") {
      const raw = one("j_gpus");
      const gpus = raw
        ? raw
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number)
        : [];
      if (gpus.some((g) => !Number.isInteger(g) || g < 0 || g > 63))
        return fail("GPUs are the machine's GPU numbers, as nvidia-smi lists them: 0, or 0,1.");
      if (new Set(gpus).size !== gpus.length) return fail("Name each GPU once.");
      if (gpus.length > MAX_RIG_GPUS) return fail(`A rig takes at most ${MAX_RIG_GPUS} GPUs.`);
      const judgeGpus = judgeShare(one("j_judge"), gpus.length);
      if (typeof judgeGpus === "string") return fail(judgeGpus);
      if (gpus.length && !opts.rigImages.harnessCuda) return fail(cuda);
      spec = { gpus: gpus.sort((a, b) => a - b), judgeGpus, images: imagesFor(gpus.length > 0) };
    } else {
      const namespace = one("j_namespace");
      if (!NS.test(namespace)) return fail("Name the namespace the rig goes in.");
      const gpus = Number(one("j_k_gpus") || "0");
      if (!Number.isInteger(gpus) || gpus < 0 || gpus > 8)
        return fail("A rig in a namespace takes from none to 8 GPUs.");
      const judgeGpus = judgeShare(one("j_k_judge"), gpus);
      if (typeof judgeGpus === "string") return fail(judgeGpus);
      const dra = one("j_mode") === "dra";
      const deviceClass = gpus && dra ? one("j_class") : undefined;
      if (gpus && dra && !DRA_CLASS.test(deviceClass ?? ""))
        return fail("Name the DRA device class, such as gpu.nvidia.com.");
      const storageClass = one("j_storage") || undefined;
      if (storageClass && !NS.test(storageClass)) return fail("That is not a storage class name.");
      const storageGi = Number(one("j_size") || "100");
      if (!Number.isInteger(storageGi) || storageGi < 1 || storageGi > 10_000)
        return fail("The volume size is a whole number of GB, from 1 to 10000.");
      if (gpus && !opts.rigImages.harnessCuda) return fail(cuda);
      spec = {
        gpus,
        judgeGpus,
        images: imagesFor(gpus > 0),
        namespace,
        gpuMode: deviceClass ? "dra" : "device-plugin",
        deviceClass,
        storageClass,
        storageGi,
      };
    }
    store.addJoinedRig({ rig, form: form as JoinForm, spec, by: "owner:ui" });
    const token = mintJoin(rig);
    return joinedPage(c, store.joinedRig(rig) as JoinedRig, "", token);
  };
  app.post("/ui/rigs/:rig/join/:action", async (c) => {
    const r = store.joinedRig(c.req.param("rig"));
    const action = c.req.param("action");
    const back = (k: "ok" | "error", msg: string) =>
      c.redirect(
        `/ui/rigs/${encodeURIComponent(c.req.param("rig"))}?${k}=${encodeURIComponent(msg)}`,
        303,
      );
    if (!r || r.status === "retired")
      return back("error", "This is not a rig you run yourself, or it is retired.");
    const f = await c.req.parseBody();
    if (action === "new") return joinedPage(c, r, "", mintJoin(r.rig));
    if (action === "revoke") {
      store.revokeJoinToken(r.rig, "owner:ui");
      store.rigSetupEvent(r.rig, "join_revoked", true);
      return back("ok", "The join command no longer works.");
    }
    if (action === "retire") {
      if (String(f.confirm ?? "").trim() !== `retire ${r.rig}`)
        return back("error", `Type "retire ${r.rig}" to retire it.`);
      store.revokeJoinToken(r.rig, "owner:ui");
      if (store.enrolledRig(r.rig)) store.retireRig(r.rig, "owner:ui");
      store.setJoinedRig(r.rig, { status: "retired" });
      store.rigSetupEvent(r.rig, "retired", true);
      return back(
        "ok",
        `${r.rig} is retired: its token no longer works. Remove its files there with the command on this page.`,
      );
    }
    return back("error", "No such action.");
  });
  // The join command's request: no session, only the one-time join token. Control mints the rig's
  // own token now, so the files it serves are the only copy of it.
  app.get("/v1/join/:rig/:what", (c) => {
    const rig = c.req.param("rig");
    const what = c.req.param("what");
    const r = store.joinedRig(rig);
    const no = (status: 401 | 404 | 409, msg: string) =>
      c.text(`thermite: ${msg}\n`, status, { "cache-control": "no-store" });
    if (!r || what !== (r.form === "machine" ? "script" : "manifest"))
      return no(404, "no such join command");
    if (!opts.publicUrl) return no(409, "control's address for rigs is not set");
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!store.useJoinToken(rig, token))
      return no(
        401,
        "this join command does not work: it was used, revoked or expired. Make a new one on the rig's page in Thermite.",
      );
    const rigToken = newToken();
    if (store.enrolledRig(rig)) store.rotateRigToken(rig, rigToken.sha256, `rig:${rig}`);
    else store.enrollRig(rig, rigToken.sha256, "owner:ui");
    const secrets = { controlToken: rigToken.token, harnessSupervisorToken: newToken().token };
    const s = r.spec;
    let body: string;
    let detail: string;
    if (r.form === "machine") {
      const root = c.req.query("uid") === "0";
      body = joinMachineScript(
        {
          rig,
          controlUrl: opts.publicUrl,
          images: s.images,
          gpus: s.gpus as number[],
          judgeGpus: s.judgeGpus,
          root,
          controlPublicKey,
          controlFingerprint: fingerprint(controlPublicKey),
        },
        secrets,
      );
      store.setJoinedRig(rig, { status: "joining", spec: { ...s, root } });
      detail = root ? "as root" : "as a user, with rootless Podman";
    } else {
      body = joinNamespaceManifest(
        {
          rig,
          namespace: s.namespace as string,
          controlUrl: opts.publicUrl,
          images: s.images,
          gpus: s.gpus as number,
          judgeGpus: s.judgeGpus,
          gpuMode: s.gpuMode ?? "device-plugin",
          deviceClass: s.deviceClass,
          storageClass: s.storageClass,
          storageGi: s.storageGi ?? 100,
          controlPublicKey,
        },
        secrets,
      );
      store.setJoinedRig(rig, { status: "joining" });
      detail = `namespace ${s.namespace}`;
    }
    store.rigSetupEvent(rig, "join_used", true, detail);
    // Pulling the images can take a while on a new machine: wait up to an hour.
    const first = awaitFirstReport(rig, (st) => store.setJoinedRig(rig, { status: st }), 60);
    void inBackground(store, "joined", rig, "first_report", first);
    return c.text(body, 200, { "cache-control": "no-store" });
  });

  /**
   * Stop, start, restart or remove a rig control set up on a cluster (its page, or MCP); `said`
   * goes in the audit log with it.
   */
  const clusterRigAction = async (
    r: ClusterRig,
    action: ClusterRigAction,
    by: string,
    said: Record<string, unknown> = {},
  ): Promise<{ ok: string } | { error: string }> => {
    if (
      // Stop and remove always work; a start or restart waits for the change under way.
      (action === "start" || action === "restart") &&
      (r.status === "updating" || r.status === "starting" || r.status === "deploying")
    )
      return { error: `${r.rig} is ${r.status}: wait until its page shows it running, or failed.` };
    const k = store.cluster(r.cluster);
    if (!k) return { error: `The cluster ${r.cluster} is no longer in Providers.` };
    const runs = clusterActionCalls(r, action);
    for (const [i, args] of runs.entries()) {
      const out = await kube.kubectl(clusterTarget(k), args, undefined, 120_000);
      // A cluster without DRA has no resourceclaimtemplates: that last delete may fail harmlessly.
      if (out.code !== 0 && !(action === "remove" && i === 1)) {
        store.rigSetupEvent(
          r.rig,
          action === "remove" ? "remove_cluster" : action,
          false,
          kubeError(out),
        );
        return { error: kubeError(out) };
      }
    }
    const step = action === "remove" ? "remove_cluster" : action;
    store.rigSetupEvent(r.rig, step, true);
    if (action === "start" || action === "restart") {
      // Running once its pods are and it has reported, as after an update.
      store.setClusterRigStatus(r.rig, "starting");
      void inBackground(store, "cluster", r.rig, "pods_running", awaitNewPods(r, k, "start"));
    } else store.setClusterRigStatus(r.rig, action === "stop" ? "stopped" : "removed");
    if (action === "remove") store.retireRig(r.rig, by);
    store.audit(by, `cluster_rig_${action}`, { rig: r.rig, cluster: r.cluster, ...said });
    return { ok: `${STEP_WORDS[step]}.` };
  };

  if (opts.actions)
    opts.actions.clusterRigAction = async (rig, action, by) => {
      const r = store.clusterRig(rig);
      if (!r || r.status === "removed")
        return { error: `Control didn't set ${rig} up on a cluster.` };
      return clusterRigAction(r, action, by);
    };
  app.get("/ui/rigs/:rig/place.json", (c) => {
    const rig = c.req.param("rig");
    return store.clusterRig(rig) || store.machineRig(rig)
      ? c.json(placeProgress(rig))
      : c.json({ error: "not found" }, 404);
  });
  app.post("/ui/rigs/:rig/cluster/:action", async (c) => {
    const r = store.clusterRig(c.req.param("rig"));
    const action = c.req.param("action");
    const back = (k: "ok" | "error", msg: string) => placeBack(c, c.req.param("rig"), k, msg);
    if (!r || r.status === "removed") return back("error", "Control didn't set this rig up.");
    if (action === "images" || action === "images-now") {
      const done = await updateClusterRigImages(r.rig, "owner:ui", {
        wait: action !== "images-now",
      });
      return "error" in done ? back("error", done.error) : back("ok", done.ok);
    }
    if (action === "drain-cancel") {
      const done = cancelDrain(r.rig, "owner:ui");
      return "error" in done ? back("error", done.error) : back("ok", done.ok);
    }
    // A change to its GPUs, CPUs or memory that waits for its drain, made now (goal 118).
    if (action === "resources-now") {
      if (r.status !== "draining" || !r.pending)
        return back("error", `${r.rig} has no change to its GPUs, CPUs or memory waiting.`);
      const done = await resizeClusterRig(r.rig, {}, "owner:ui", { wait: false, owner: true });
      return "error" in done ? back("error", done.error) : back("ok", done.ok);
    }
    if (!["stop", "start", "restart", "remove"].includes(action))
      return back("error", "No such action.");
    const f = await c.req.parseBody();
    const removing =
      action === "remove" ? removeCheck(store, r.rig, String(f.confirm ?? "").trim()) : null;
    if (removing && "refused" in removing) return back("error", removing.refused);
    const done = await clusterRigAction(r, action as ClusterRigAction, "owner:ui", { ...removing });
    return "error" in done ? back("error", done.error) : back("ok", done.ok);
  });
  app.post("/ui/rigs/:rig/machine/:action", async (c) => {
    const r = store.machineRig(c.req.param("rig"));
    const action = c.req.param("action") as RigAction;
    const back = (k: "ok" | "error", msg: string) => placeBack(c, c.req.param("rig"), k, msg);
    if (!r || r.status === "removed") return back("error", "Control didn't set this rig up.");
    if (!["stop", "start", "restart", "remove"].includes(action))
      return back("error", "No such action.");
    const f = await c.req.parseBody();
    const removing =
      action === "remove" ? removeCheck(store, r.rig, String(f.confirm ?? "").trim()) : null;
    if (removing && "refused" in removing) return back("error", removing.refused);
    const m = store.machine(r.machine);
    if (!m) return back("error", `The machine ${r.machine} is no longer in Providers.`);
    try {
      const out = await ssh.sshScript(
        {
          address: m.address,
          port: m.port,
          user: m.user,
          privateKey: opts.secrets.open(m.key_sealed),
          hostKeys: m.host_keys,
        },
        manageScript(r, action),
        [],
        5 * 60_000,
      );
      if (out.code !== 0) throw new Error(tail(out.stderr) || `exit ${out.code}`);
    } catch (err) {
      const why = errorText(err);
      store.rigSetupEvent(r.rig, action, false, why);
      return back("error", why);
    }
    store.rigSetupEvent(r.rig, action, true);
    store.setMachineRigStatus(
      r.rig,
      action === "stop" ? "stopped" : action === "remove" ? "removed" : "running",
    );
    if (action === "remove") store.retireRig(r.rig, "owner:ui");
    store.audit("owner:ui", `machine_rig_${action}`, {
      rig: r.rig,
      machine: r.machine,
      ...removing,
    });
    return back("ok", `${STEP_WORDS[action]}.`);
  });
  // ---------------------------------------------------------------- a rig's state (goal 012)
  /** Where a rig runs, and what control can do there: update it, check it, restart it. */
  const placeOf = (rig: string): RigPlace => {
    const r = encodeURIComponent(rig);
    const m = store.machineRig(rig);
    if (m && m.status !== "removed") {
      const known = store.machine(m.machine);
      const images = controlImages(m.gpus.length);
      const noUpdate = !known
        ? `The machine ${m.machine} is no longer in Settings › Providers, so control can't reach it.`
        : typeof images === "string"
          ? images
          : !opts.publicUrl
            ? "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report."
            : m.status === "deploying"
              ? `${rig} is still being set up.`
              : undefined;
      return {
        kind: "machine",
        words: `${m.machine}, a machine over SSH · Podman · systemd`,
        update: !noUpdate,
        noUpdate,
        check: Boolean(known),
        checkWhat: "its machine",
        restart: known ? `/ui/rigs/${r}/machine/restart` : null,
      };
    }
    const k = store.clusterRig(rig);
    if (k && k.status !== "removed") {
      const known = store.cluster(k.cluster);
      const images = controlImages(k.spec.gpus);
      const noUpdate = !known
        ? `The cluster ${k.cluster} is no longer in Settings › Providers, so control can't reach it.`
        : typeof images === "string"
          ? images
          : !opts.publicUrl
            ? "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report."
            : k.status === "deploying"
              ? `${rig} is still being set up.`
              : undefined;
      return {
        kind: "cluster",
        words: `${k.cluster}, namespace ${k.namespace}`,
        update: !noUpdate,
        noUpdate,
        check: Boolean(known),
        checkWhat: "the cluster",
        restart: known ? `/ui/rigs/${r}/cluster/restart` : null,
      };
    }
    const pod = opts.runpodRigs?.view(rig);
    if (pod)
      return {
        kind: "runpod",
        words: `RunPod, pod ${pod.pod}${pod.datacenter ? ` in ${pod.datacenter}` : ""}`,
        update: false,
        check: false,
        checkWhat: "its pod",
        restart: pod.active && podRuns(pod) ? `/ui/rigs/${r}/runpod/restart` : null,
      };
    if (store.joinedRig(rig))
      return {
        kind: "joined",
        words: "a place you set it up on yourself",
        update: false,
        check: false,
        checkWhat: "where it runs",
        restart: null,
      };
    return {
      kind: "other",
      words: "",
      update: false,
      check: false,
      checkWhat: "where it runs",
      restart: opts.driver ? `/ui/rigs/${r}/restart` : null,
    };
  };
  /** Moves a rig control set up on a machine onto control's images, over SSH; what changed. */
  const updateMachineRig = async (rig: string): Promise<string> => {
    const r = store.machineRig(rig);
    if (!r || r.status === "removed") throw new Error(`Control didn't set ${rig} up on a machine.`);
    const m = store.machine(r.machine);
    if (!m) throw new Error(`The machine ${r.machine} is no longer in Settings › Providers.`);
    const images = controlImages(r.gpus.length);
    if (typeof images === "string") throw new Error(images);
    if (!opts.publicUrl)
      throw new Error("Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL).");
    store.setMachineRigStatus(rig, "updating");
    const out = await ssh.sshScript(
      {
        address: m.address,
        port: m.port,
        user: m.user,
        privateKey: opts.secrets.open(m.key_sealed),
        hostKeys: m.host_keys,
      },
      updateScript({
        rig,
        controlUrl: opts.publicUrl,
        images,
        gpus: r.gpus,
        judgeGpus: r.judge_gpus,
        root: r.root,
      }),
      [],
      30 * 60_000,
    );
    if (out.code !== 0) {
      store.setMachineRigStatus(rig, "failed");
      throw new Error(tail(out.stderr) || `the update exited ${out.code}`);
    }
    store.setMachineRigImages(rig, images);
    store.setMachineRigStatus(rig, "running");
    store.audit("owner:ui", "machine_rig_images", { rig, from: r.images, to: images });
    const changed = [
      r.images.harness !== images.harness ? `harness ${r.images.harness} → ${images.harness}` : "",
      r.images.supervisor !== images.supervisor
        ? `supervisor ${r.images.supervisor} → ${images.supervisor}`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    return `${changed || `the same image names, pulled again: ${images.harness}, ${images.supervisor}`}; its services restarted`;
  };
  /** Moves a rig control set up on a cluster onto control's images; what changed. */
  const updateClusterRig = async (rig: string): Promise<string> => {
    const k = store.clusterRig(rig);
    const want = k ? controlImages(k.spec.gpus) : undefined;
    if (
      k &&
      want &&
      typeof want !== "string" &&
      want.harness === k.spec.images.harness &&
      want.supervisor === k.spec.images.supervisor &&
      k.status !== "failed"
    )
      throw new Error(
        `${rig} runs the images control deploys already (${want.harness}, ${want.supervisor}), and they are not Thermite ${control.version}'s: set control's rig images to ${control.version}'s, then update again`,
      );
    // The update has paused the rig's runs at a safe point already: its containers move now, and
    // a drain would only report them moved before they did.
    const done = await updateClusterRigImages(rig, "owner:ui", { wait: false });
    if ("error" in done) throw new Error(done.error);
    return done.ok;
  };
  /**
   * How an update stands, for the page's script (goal 080): a new state with each step, so the
   * rig's page draws its steps as they come; final once it ended.
   */
  const updateProgress = (rig: string): Progress => {
    const waiting = updates.waiting(rig);
    const steps = store.rigSetupEvents(rig);
    const from = steps.map((s) => s.step).lastIndexOf("update_started");
    const n = from < 0 ? 0 : steps.length - from;
    return { state: `${n}:${waiting ?? "ended"}`, final: !waiting, said: "", tone: "" };
  };
  const updateFollowUrl = (rig: string) => `/ui/rigs/${encodeURIComponent(rig)}/update.json`;
  app.get("/ui/rigs/:rig/update.json", (c) => {
    const rig = c.req.param("rig");
    return store.rigs().some((x) => x.id === rig)
      ? c.json(updateProgress(rig))
      : c.json({ error: "not found" }, 404);
  });
  app.post("/ui/rigs/:rig/update", (c) => {
    const rig = c.req.param("rig");
    const json = wantsJson(c);
    const back = (k: "ok" | "error", m: string) =>
      json
        ? c.json(
            k === "ok"
              ? { ...updateProgress(rig), said: m, tone: "ok", follow: updateFollowUrl(rig) }
              : notSent(m),
            k === "ok" ? 200 : 400,
          )
        : c.redirect(
            `/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}#version`,
            303,
          );
    const place = placeOf(rig);
    if (!place.update)
      return back(
        "error",
        place.noUpdate ??
          `Control didn't set ${rig} up on a machine or a cluster, so it can't move it onto its images. Pull the ${control.version} images where it runs, and start it again with them.`,
      );
    try {
      void updates.begin(rig, "owner:ui", {
        apply: () => (place.kind === "machine" ? updateMachineRig(rig) : updateClusterRig(rig)),
      });
    } catch (err) {
      return back("error", errorText(err));
    }
    store.audit("owner:ui", "rig_update", { rig, to: control.version });
    return back(
      "ok",
      `The update of ${rig} to ${control.version} began. Its steps show below as they happen.`,
    );
  });
  /** What a cluster's API says about a rig's two deployments, in words: ok when both run. */
  const checkClusterRig = async (rig: string): Promise<{ ok: boolean; words: string }> => {
    const r = store.clusterRig(rig);
    const k = r ? store.cluster(r.cluster) : undefined;
    if (!r || !k) return { ok: false, words: "The cluster is no longer in Settings › Providers." };
    const n = clusterNames(rig);
    const out = await kube.kubectl(
      clusterTarget(k),
      ["get", "deployment", n.harness, n.supervisor, "-n", r.namespace, "-o", "json"],
      undefined,
      60_000,
    );
    if (out.code !== 0)
      return { ok: false, words: `${r.cluster}'s API did not answer: ${kubeError(out)}` };
    type D = {
      metadata?: { name?: string };
      spec?: { replicas?: number };
      status?: { readyReplicas?: number };
    };
    let items: D[] = [];
    try {
      items = (JSON.parse(out.stdout) as { items?: D[] }).items ?? [];
    } catch {
      return { ok: false, words: `${r.cluster}'s API gave an answer control can't read.` };
    }
    const part = (name: string, word: string) => {
      const d = items.find((x) => x.metadata?.name === name);
      if (!d) return { ok: false, text: `the ${word} has no deployment` };
      const want = d.spec?.replicas ?? 1;
      const ready = d.status?.readyReplicas ?? 0;
      return {
        ok: want > 0 && ready >= want,
        text: `the ${word} has ${ready} of ${want} pod${want === 1 ? "" : "s"} ready`,
      };
    };
    const h = part(n.harness, "harness");
    const s = part(n.supervisor, "supervisor");
    return {
      ok: h.ok && s.ok,
      words: `${h.ok && s.ok ? "Both deployments run" : "Not both deployments run"}: ${h.text}, ${s.text}.`,
    };
  };
  /**
   * Checks where a rig control set up runs (Check again on its page, and control by itself when the
   * rig turns stale and offline: rig-watch.ts): over SSH on a machine, through the cluster's API on
   * a cluster. What it found is a step in the rig's history. Null when control can't reach it.
   */
  const checkPlace = async (
    rig: string,
    by: string,
  ): Promise<{ ok: boolean; words: string } | null> => {
    const place = placeOf(rig);
    if (!place.check) return null;
    let found: { ok: boolean; words: string };
    if (place.kind === "machine") {
      const r = store.machineRig(rig);
      const m = r ? store.machine(r.machine) : undefined;
      if (!r || !m) return null;
      try {
        const out = await ssh.sshScript(
          {
            address: m.address,
            port: m.port,
            user: m.user,
            privateKey: opts.secrets.open(m.key_sealed),
            hostKeys: m.host_keys,
          },
          checkScript(r),
          [],
          60_000,
        );
        found =
          out.code === 0
            ? readCheck(rig, out.stdout)
            : {
                ok: false,
                words: `The check on ${r.machine} failed: ${tail(out.stderr) || `exit ${out.code}`}`,
              };
      } catch (err) {
        found = {
          ok: false,
          words: `Control could not log in to ${r.machine} over SSH: ${errorText(err)}`,
        };
      }
    } else found = await checkClusterRig(rig);
    store.rigSetupEvent(rig, "check", found.ok, found.words);
    store.audit(by, "rig_check_place", { rig, ok: found.ok });
    return found;
  };
  if (opts.actions) opts.actions.checkRigPlace = checkPlace;
  app.post("/ui/rigs/:rig/check", async (c) => {
    const rig = c.req.param("rig");
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}`, 303);
    const found = await checkPlace(rig, "owner:ui");
    if (!found) return back("error", "Control can't reach where this rig runs.");
    return back(found.ok ? "ok" : "error", found.words);
  });

  // ---------------------------------------------------------------- RunPod rigs (goals 022, 023)
  /** "rp-1 is a RunPod pod with 1 × A100 PCIe, on Secure cloud in EU-RO-1. It has cost $9.80…" */
  const podSaid = (v: NonNullable<RigView["runpod"]>, now: number) => {
    const spent = v.spend_usd ?? v.spent_usd;
    if (!v.active || v.status === "TERMINATED")
      return `${esc(v.rig)}'s pod is terminated. It cost <b>$${spent.toFixed(2)}</b> in all.`;
    return `${esc(v.rig)} is a RunPod pod with ${v.gpu_count} × ${esc(v.gpu_name)}, on ${v.cloud_type === "SECURE" ? "Secure" : "Community"} cloud${v.datacenter ? ` in ${esc(v.datacenter)}` : ""}. It has cost <b>$${spent.toFixed(2)}</b> since it was launched ${esc(ago(v.launched_at, now))} ago.`;
  };
  const podSummary = (v: NonNullable<RigView["runpod"]>) =>
    !v.active || v.status === "TERMINATED"
      ? `<span class="muted">terminated</span> · RunPod`
      : v.status === "EXITED"
        ? `<span class="muted">stopped</span> · RunPod`
        : `<span class="${v.status === "RUNNING" ? "ok" : "warn"}">${esc(v.status.toLowerCase())}</span> · RunPod${v.price_per_hr !== null ? ` · $${v.price_per_hr.toFixed(2)}/h` : ""}`;
  /** A RunPod rig's pod block: its cost, limits, lifecycle and the results still in it. */
  const podSection = (c: Ctx, rig: string, now: number) => {
    const v = opts.runpodRigs?.view(rig);
    if (!v) return "";
    const name = v.op?.export ?? v.last_export ?? null;
    return podBlock({
      v,
      t: csrf(c),
      now,
      results: resultsLeft(store, rig),
      lastExport: name ? { name, left: exportLeft(store, rig, name) } : null,
      resetOpen: Boolean(store.openReset(rig)),
      minIdle: MIN_IDLE_STOP_MINUTES,
    });
  };
  /**
   * A RunPod rig's pod log, as last read (Read again reads it now). `auto`: before the rig's first
   * report, the page reads it once as it opens when nothing was read yet. None for a pod that is
   * gone: RunPod keeps no log of it.
   */
  const podLogSection = (c: Ctx, rig: string, now: number, auto: boolean) => {
    const v = opts.runpodRigs?.view(rig);
    if (!v?.active || v.status === "TERMINATED") return "";
    return podLogBlock({ rig, kept: opts.runpodRigs?.lastLog(rig), t: csrf(c), now, auto });
  };
  // Reads the pod log now (Read again): JSON for the page's script, which then draws the block
  // again; else the rig's page at the block.
  app.post("/ui/rigs/:rig/runpod/logs", async (c) => {
    const rig = c.req.param("rig");
    const rigs = opts.runpodRigs;
    const follow = `/ui/rigs/${encodeURIComponent(rig)}/runpod/logs`;
    const answer = (ok: boolean, said: string) =>
      wantsJson(c)
        ? c.json({
            state: `read:${Date.now()}`,
            final: true,
            said,
            tone: ok ? "ok" : "bad",
            follow,
          })
        : c.redirect(
            `/ui/rigs/${encodeURIComponent(rig)}?${ok ? "ok" : "error"}=${encodeURIComponent(said)}#podlog`,
            303,
          );
    if (!rigs?.view(rig)) return answer(false, `${rig} is not a rig control launched on RunPod.`);
    try {
      const r = await rigs.logs(rig);
      return answer(
        true,
        `Read ${r.lines.length} line${r.lines.length === 1 ? "" : "s"} of pod ${r.pod}'s log from RunPod.`,
      );
    } catch (err) {
      return answer(false, `Not read: ${errorText(err)}`);
    }
  });
  /** A RunPod rig's history: the pod's steps, the rig's events and its state's lines, filtered. */
  const podHistory = (u: RigView | undefined, rig: string, extra: TimelineRow[], now: number) =>
    `<div class="block"><div class="head"><h2>History</h2><span class="right">newest first</span></div>${HISTORY_FILTERS}${timeline(
      u ? u.recent.map((e) => ({ u, e })) : [],
      now,
      {
        limit: 40,
        kinds: true,
        extra: [...podRows(store.rigSetupEvents(rig)), ...extra],
        id: "hist",
      },
    )}</div>`;
  const podActions = {
    stop: "Stopping: its runs are paused and its results go out first, then the pod stops.",
    start: "Starting: RunPod starts the pod, and its paused runs resume once it runs.",
    restart: "Restarting: the pod stops, then starts again.",
    terminate:
      "Terminating: its runs are paused, and the pod is removed only once every result has left it.",
  } as const;
  /** A number from a form field: empty is null (none), anything else must be a number. */
  const amount = (raw: unknown): number | null | "bad" => {
    const v = String(raw ?? "")
      .trim()
      .replace(/^\$/, "");
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : "bad";
  };
  app.post("/ui/rigs/:rig/runpod/:action", async (c) => {
    const rig = c.req.param("rig");
    const action = c.req.param("action");
    const back = (k: "ok" | "error", m: string, at = "#pod") =>
      c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}${at}`, 303);
    const rigs = opts.runpodRigs;
    if (!rigs?.view(rig)) return back("error", `${rig} is not a rig control launched on RunPod.`);
    const f = await c.req.parseBody();
    try {
      if (action === "limits") {
        const lim = amount(f.spend_limit_usd);
        const idle = amount(f.idle_stop_minutes);
        if (lim === "bad" || (lim !== null && !(lim > 0)))
          return back("error", "A spend limit is an amount in US dollars above 0, such as 40.");
        if (
          idle === "bad" ||
          (idle !== null && !(Number.isInteger(idle) && idle >= MIN_IDLE_STOP_MINUTES))
        )
          return back(
            "error",
            `An idle stop is a whole number of minutes, ${MIN_IDLE_STOP_MINUTES} or more.`,
          );
        const change: LimitsChange = { spend_limit_usd: lim, idle_stop_minutes: idle };
        const v = rigs.limits(rig, change, "owner:ui");
        return back(
          "ok",
          `Saved. ${v.spend_limit_usd === null ? "No spend limit." : `Control stops the pod at $${v.spend_limit_usd.toFixed(2)}.`} ${v.idle_stop_minutes === null ? "It never stops by itself." : `It stops after ${v.idle_stop_minutes} minutes with no run at work.`}`,
        );
      }
      if (action === "stop") await rigs.stop(rig, "owner:ui");
      else if (action === "start") await rigs.start(rig, "owner:ui");
      else if (action === "restart") await rigs.restart(rig, "owner:ui");
      else if (action === "terminate") {
        const confirm = String(f.confirm ?? "").trim();
        if (confirm !== `terminate ${rig}`)
          return back("error", `Type "terminate ${rig}" to terminate it.`);
        await rigs.terminate(rig, "owner:ui", confirm);
      } else return back("error", "No such action.");
    } catch (err) {
      return back("error", errorText(err));
    }
    return back("ok", podActions[action as keyof typeof podActions]);
  });
  app.get("/ui/assets/runpod-launch.js", (c) =>
    c.body(RUNPOD_LAUNCH_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  /** The launch form, for one RunPod account in Providers, maybe with what was typed and why not. */
  const launchPage = (c: Ctx, form: LaunchForm, error?: string) => {
    const clouds = store.gpuClouds().map((g) => ({
      name: g.name,
      key_hint: g.key_hint,
      facts: g.facts as RunpodFacts | null,
      checked_at: g.checked_at,
      error: g.check_error,
    }));
    const cloud = clouds.find((g) => g.name === form.cloud) ?? clouds[0];
    const crumbs = [
      { href: "/ui/rigs", text: "Rigs" },
      { href: "/ui/rigs/add", text: "Add a rig" },
    ];
    if (!cloud || !opts.runpodRigs)
      return page(
        c,
        { title: "Launch on RunPod", crumbs, active: "rigs" },
        `<div class="card"><p>Control has no RunPod account yet. Add one under <a href="/ui/settings">Settings › Providers</a>, with an API key that may start pods, then come back.</p></div>`,
      );
    return page(
      c,
      { title: "Launch on RunPod", crumbs, active: "rigs" },
      `${launchBody({
        clouds,
        cloud,
        image: opts.runpodRigs.defaultImage(),
        idleFill: Math.max(FORM_IDLE_STOP_MINUTES, MIN_IDLE_STOP_MINUTES),
        minIdle: MIN_IDLE_STOP_MINUTES,
        volumeGb: DEFAULT_VOLUME_GB,
        csrf: csrf(c),
        now: Date.now(),
        form,
        error,
      })}<script src="/ui/assets/runpod-launch.js" defer></script>`,
    );
  };
  app.get("/ui/rigs/add/runpod", (c) =>
    launchPage(c, { cloud: c.req.query("cloud") }, c.req.query("error") || undefined),
  );
  app.post("/ui/rigs/add/runpod", async (c) => {
    const f = await c.req.parseBody();
    const one = (k: string) => String(f[k] ?? "").trim();
    const form: LaunchForm = {
      cloud: one("cloud"),
      gpu: one("gpu"),
      gpu_count: one("gpu_count"),
      judge_gpus: one("judge_gpus"),
      datacenter: one("datacenter"),
      volume_gb: one("volume_gb"),
      image_choice: one("image_choice"),
      image: one("image"),
      spend_limit_usd: one("spend_limit_usd"),
      idle_stop_minutes: one("idle_stop_minutes"),
      rig: one("rig"),
    };
    // Read again: the account's prices and stock, then the form as it was.
    if (one("read")) {
      const why = await checkCloudNow(form.cloud ?? "");
      return c.redirect(
        `/ui/rigs/add/runpod?cloud=${encodeURIComponent(form.cloud ?? "")}${why ? `&error=${encodeURIComponent(why)}` : ""}`,
        303,
      );
    }
    const rigs = opts.runpodRigs;
    if (!rigs || !store.gpuCloud(form.cloud ?? ""))
      return launchPage(c, form, "Choose a RunPod account from Settings › Providers.");
    const count = Number(form.gpu_count || "1");
    if (!(Number.isInteger(count) && count >= 1 && count <= 8))
      return launchPage(c, form, "A pod has 1 to 8 GPUs.");
    const judge = form.judge_gpus ? Number(form.judge_gpus) : undefined;
    if (
      count >= 2 &&
      judge !== undefined &&
      !(Number.isInteger(judge) && judge >= 1 && judge < count)
    )
      return launchPage(c, form, `With ${count} GPUs, the judge takes 1 to ${count - 1} of them.`);
    const volume = Number(form.volume_gb || String(DEFAULT_VOLUME_GB));
    if (!(Number.isInteger(volume) && volume >= 10 && volume <= 10_000))
      return launchPage(c, form, "The volume is 10 to 10000 GB.");
    const lim = amount(form.spend_limit_usd);
    if (lim === "bad" || (lim !== null && !(lim > 0)))
      return launchPage(c, form, "A spend limit is an amount in US dollars above 0, such as 40.");
    const idle = amount(form.idle_stop_minutes);
    if (
      idle === "bad" ||
      (idle !== null && !(Number.isInteger(idle) && idle >= MIN_IDLE_STOP_MINUTES))
    )
      return launchPage(
        c,
        form,
        `An idle stop is a whole number of minutes, ${MIN_IDLE_STOP_MINUTES} or more.`,
      );
    const own = form.image_choice === "own" || !rigs.defaultImage();
    if (own && !form.image) return launchPage(c, form, "Give your image's name and tag.");
    const req: LaunchRequest = {
      gpu: form.gpu ?? "",
      gpu_count: count,
      cloud_type: "SECURE",
      datacenter: form.datacenter || undefined,
      volume_gb: volume,
      image: own ? form.image : undefined,
      rig: form.rig || undefined,
      ...(lim !== null ? { spend_limit_usd: lim } : {}),
      // Cleared by the owner: none, whatever control's default is.
      idle_stop_minutes: idle,
      ...(count >= 2 && judge !== undefined
        ? { settings: { THERMITE_JUDGE_GPUS: String(judge) } }
        : {}),
    };
    if (!req.gpu) return launchPage(c, form, "Choose a GPU.");
    try {
      const v = await rigs.launch(form.cloud ?? "", req, "owner:ui");
      return c.redirect(
        `/ui/rigs/${encodeURIComponent(v.rig)}?ok=${encodeURIComponent(`Launched: RunPod bills pod ${v.pod} from now${v.price_per_hr !== null ? ` at $${v.price_per_hr.toFixed(2)} an hour` : ""}. Control enrolls it once it runs.`)}`,
        303,
      );
    } catch (err) {
      return launchPage(c, form, errorText(err));
    }
  });

  /** Reads the machine's facts now (read-only), and keeps them or why it could not. */
  const checkMachine = async (name: string): Promise<string | null> => {
    const m = store.machine(name);
    if (!m) return "no such machine";
    try {
      const r = await ssh.sshScript(
        {
          address: m.address,
          port: m.port,
          user: m.user,
          privateKey: opts.secrets.open(m.key_sealed),
          hostKeys: m.host_keys,
        },
        CHECK_SCRIPT,
        [opts.publicUrl ? `${opts.publicUrl.replace(/\/$/, "")}/v1/health` : ""],
        60_000,
      );
      if (r.code !== 0)
        throw new Error(`the check exited ${r.code}: ${r.stderr.trim().split("\n").pop() ?? ""}`);
      store.setMachineFacts(name, { facts: parseFacts(r.stdout) });
      return null;
    } catch (err) {
      const why = errorText(err);
      store.setMachineFacts(name, { error: why });
      // A changed host key: read what it presents now, for the owner to compare.
      if (/different host key/.test(why))
        await ssh
          .scanHostKeys(m.address, m.port)
          .then((keys) =>
            store.seeMachineHostKeys(
              name,
              keys.map((k) => k.line),
            ),
          )
          .catch(() => {});
      return why;
    }
  };
  const addMachine = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(machineUrl("error", m), 303);
    const name = newName(f.name);
    const address = String(f.address ?? "").trim();
    const port = Number(String(f.port ?? "22").trim() || "22");
    const user = String(f.user ?? "").trim();
    let privateKey = String(f.private_key ?? "").trim();
    if (!ACCESS_NAME.test(name))
      return fail("A machine's name is lowercase letters, digits, dots and dashes.");
    if (store.machine(name)) return fail(`"${name}" exists already.`);
    if (!ADDRESS.test(address)) return fail("The address is a host name or an IP address.");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return fail("The port is a number from 1 to 65535.");
    if (!USER.test(user)) return fail("The user is a Unix account name, such as thermite.");
    let pub: { line: string; fingerprint: string };
    if (privateKey) {
      try {
        pub = await ssh.publicKeyOf(privateKey);
      } catch (err) {
        return fail(errorText(err));
      }
    } else {
      const k = makeDeployKey(`thermite ${name}`);
      privateKey = k.privateKey;
      pub = { line: k.publicKey, fingerprint: k.fingerprint };
    }
    const seen = await ssh.scanHostKeys(address, port).catch(() => []);
    store.addMachine({
      name,
      address,
      port,
      user,
      key_sealed: opts.secrets.seal(privateKey),
      public_key: pub.line,
      key_fingerprint: pub.fingerprint,
      seen_host_keys: seen.map((k) => k.line),
      by: "owner:ui",
    });
    return c.redirect(
      seen.length
        ? machineUrl(
            "ok",
            `"${name}" is added. Compare its host key below, then trust it: control connects only after that.`,
          )
        : machineUrl(
            "error",
            `"${name}" is added, but no SSH server answered at ${address} port ${port}. Read its host key again when it is up.`,
          ),
      303,
    );
  };
  app.post("/ui/settings/machines/:name/scan", async (c) => {
    const m = store.machine(c.req.param("name"));
    if (!m) return c.redirect(machineUrl("error", "No such machine."), 303);
    const keys = await ssh.scanHostKeys(m.address, m.port).catch(() => []);
    store.seeMachineHostKeys(
      m.name,
      keys.map((k) => k.line),
    );
    return c.redirect(
      keys.length
        ? machineUrl("ok", `Read "${m.name}"'s host key: compare it below.`)
        : machineUrl("error", `No SSH server answered at ${m.address} port ${m.port}.`),
      303,
    );
  });
  // The owner trusts exactly the keys they were shown (the form carries them back).
  app.post("/ui/settings/machines/:name/trust", async (c) => {
    const m = store.machine(c.req.param("name"));
    const seen = String((await c.req.parseBody()).seen ?? "");
    if (!m) return c.redirect(machineUrl("error", "No such machine."), 303);
    if (!m.seen_host_keys.length || seen !== m.seen_host_keys.join("\n"))
      return c.redirect(
        machineUrl("error", "The host key changed since the page showed it: compare it again."),
        303,
      );
    store.trustMachineHostKeys(m.name, m.seen_host_keys, "owner:ui");
    const why = await checkMachine(m.name);
    return c.redirect(
      why
        ? machineUrl("error", `Trusted "${m.name}"'s host key, but the check failed: ${why}`)
        : machineUrl(
            "ok",
            `Trusted "${m.name}"'s host key and read the machine: see what it found below.`,
          ),
      303,
    );
  });
  app.post("/ui/settings/machines/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!store.machine(name)?.host_keys.length)
      return c.redirect(machineUrl("error", "Trust the machine's host key first."), 303);
    const why = await checkMachine(name);
    return c.redirect(
      why ? machineUrl("error", `"${name}": ${why}`) : machineUrl("ok", `Read "${name}" again.`),
      303,
    );
  });
  // An install the owner allowed: bound to the exact script the page showed, used once, now.
  app.post("/ui/settings/machines/:name/install", async (c) => {
    const f = await c.req.parseBody();
    const m = store.machine(c.req.param("name"));
    const id = String(f.recipe ?? "") as RecipeId;
    const fail = (why: string) => c.redirect(machineUrl("error", why), 303);
    if (!m) return fail("No such machine.");
    const facts = m.facts as MachineFacts | null;
    if (!m.host_keys.length || !facts) return fail("Trust and check the machine first.");
    if (!(id in RECIPES) || !missing(facts).includes(id))
      return fail("That isn't missing on this machine any more: press Check again.");
    if (store.machineInstalls(m.name).some((i) => i.started_at && !i.finished_at))
      return fail(`An install is already running on "${m.name}".`);
    const s = recipeScript(id, facts);
    if ("error" in s) return fail(s.error);
    const sha = scriptSha(s.script);
    if (String(f.sha ?? "") !== sha)
      return fail("What control would run changed since the page showed it: read it again.");
    const approval = store.approveInstall({
      machine: m.name,
      recipe: id,
      script_sha: sha,
      by: "owner:ui",
      ttlMs: 30 * 60_000,
    });
    if (!store.startInstall(approval, m.name, id, sha)) return fail("That approval can't be used.");
    const target = {
      address: m.address,
      port: m.port,
      user: m.user,
      privateKey: opts.secrets.open(m.key_sealed),
      hostKeys: m.host_keys,
    };
    // It runs on: the page shows it running, then its outcome and the machine read again.
    void ssh
      .sshScript(target, s.script, [], 30 * 60_000)
      .then(
        (r) => store.finishInstall(approval, r.code === 0, `${r.stdout}\n${r.stderr}`.trim()),
        (err) => store.finishInstall(approval, false, errorText(err)),
      )
      .then(() => checkMachine(m.name))
      .catch(() => {});
    return c.redirect(
      machineUrl(
        "ok",
        `Installing ${RECIPES[id].title} on "${m.name}", as you allowed: this page shows when it is done.`,
      ),
      303,
    );
  });
  app.post("/ui/settings/machines/:name/decline", async (c) => {
    const id = String((await c.req.parseBody()).recipe ?? "") as RecipeId;
    const title = RECIPES[id]?.title ?? "it";
    return c.redirect(
      machineUrl(
        "ok",
        `Control won't install ${title}. Install it yourself (the commands are shown below), then press Check again.`,
      ),
      303,
    );
  });
  app.post("/ui/settings/machines/:name/delete", (c) => {
    const name = c.req.param("name");
    return c.redirect(
      store.deleteMachine(name, "owner:ui")
        ? machineUrl("ok", `"${name}" is deleted: control keeps nothing of its key.`)
        : machineUrl("error", "No such machine."),
      303,
    );
  });

  /** Git access added from the add form (or the older Git access form). */
  const addGit = (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = newName(f.name);
    if (!ACCESS_NAME.test(name))
      return fail("A Git access name is lowercase letters, digits, dots and dashes.");
    if (store.gitAccess(name)) return fail(`"${name}" exists already: delete it first.`);
    if (f.kind === "token") {
      const token = String(f.token ?? "").trim();
      if (!token || /\s/.test(token) || token.length > 4096)
        return fail("Paste the token, without spaces.");
      const username = String(f.username ?? "").trim() || null;
      store.putGitAccess({
        name,
        kind: "token",
        public_key: null,
        fingerprint: null,
        secret_sealed: opts.secrets.seal(token),
        hint: keyHint(token),
        username,
        by: "owner:ui",
      });
      return c.redirect(
        settingsUrl("ok", `"${name}" is kept, sealed: choose it on the new-campaign page.`),
        303,
      );
    }
    const key = makeDeployKey(`thermite ${name}`);
    store.putGitAccess({
      name,
      kind: "ssh",
      public_key: key.publicKey,
      fingerprint: key.fingerprint,
      secret_sealed: opts.secrets.seal(key.privateKey),
      hint: key.fingerprint.slice(-6),
      username: null,
      by: "owner:ui",
    });
    return c.redirect(
      settingsUrl(
        "ok",
        `Made the deploy key "${name}": add its public key, below, to the repository as a read-only deploy key.`,
      ),
      303,
    );
  };
  app.post("/ui/settings/git", async (c) => addGit(c, await c.req.parseBody()));
  // Reads a repository's branches with this access, as a rig would fetch it; nothing is kept.
  app.post("/ui/settings/git/:name/test", async (c) => {
    const name = c.req.param("name");
    const url = String((await c.req.parseBody()).url ?? "").trim();
    if (!store.gitAccess(name)) return c.redirect(settingsUrl("error", "No such Git access."), 303);
    try {
      const found = await (opts.probeRepo ?? probeRepository)(url, "HEAD", accessFor(name));
      return c.redirect(
        settingsUrl(
          "ok",
          `"${name}" reads ${url}: its default branch is at ${found.commit.slice(0, 7)}, with ${found.files} files.`,
        ),
        303,
      );
    } catch (err) {
      const why = errorText(err);
      return c.redirect(settingsUrl("error", `"${name}" could not read ${url}: ${why}`), 303);
    }
  });
  app.post("/ui/settings/git/:name/token", async (c) => {
    const name = c.req.param("name");
    const token = String((await c.req.parseBody()).token ?? "").trim();
    if (!token || /\s/.test(token) || token.length > 4096)
      return c.redirect(settingsUrl("error", "Paste the token, without spaces."), 303);
    return c.redirect(
      store.replaceGitToken(name, opts.secrets.seal(token), keyHint(token), "owner:ui")
        ? settingsUrl("ok", `"${name}" has its new token; campaigns that use it keep working.`)
        : settingsUrl("error", "No such token."),
      303,
    );
  });
  app.post("/ui/settings/git/:name/delete", (c) => {
    const name = c.req.param("name");
    const users = store.campaignsUsingGitAccess(name);
    if (users.length)
      return c.redirect(
        settingsUrl("error", `"${name}" is used by ${users.join(", ")}: their runs fetch with it.`),
        303,
      );
    return c.redirect(
      store.deleteGitAccess(name, "owner:ui")
        ? settingsUrl("ok", `"${name}" is deleted. Rigs that ran with it keep nothing of it.`)
        : settingsUrl("error", "No such Git access."),
      303,
    );
  });

  // The add form: a model provider or Git access, by its type.
  app.post("/ui/settings/add", async (c) => {
    const f = await c.req.parseBody();
    if (f.type === "ssh") return addMachine(c, f);
    if (f.type === "k8s") return addCluster(c, f);
    if (f.type === "runpod") return addRunpod(c, f);
    if (f.type === "gitkey" || f.type === "gittoken")
      return addGit(c, { ...f, kind: f.type === "gittoken" ? "token" : "ssh" });
    return saveProvider(c, f);
  });
  app.post("/ui/settings/providers", async (c) => saveProvider(c, await c.req.parseBody()));
  // MCP servers: their block on Providers, and its routes.
  mountMcpUi(app, { store, servers: mcpServers, publicUrl: opts.publicUrl });
  /**
   * A Claude subscription added or its token replaced: the token sealed, the fixed model list, and
   * no call to Anthropic (only Claude Code may use the token).
   */
  const saveClaude = (c: Ctx, name: string, token: string) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    if (token && (token.length > 4096 || /\s/.test(token)))
      return fail(
        "The token has spaces or is too long: paste only what claude setup-token printed.",
      );
    if (token && !token.startsWith("sk-ant-"))
      return fail("That is not a token from claude setup-token: it starts with sk-ant-.");
    const old = store.provider(name);
    if (old && old.type !== "claude")
      return fail(`"${name}" is a provider of another kind: choose another name.`);
    const r = store.putProvider({
      name,
      type: "claude",
      base_url: providerBase("claude", ""),
      key: token ? { sealed: opts.secrets.seal(token), hint: keyHint(token) } : undefined,
    });
    if (r === "needs_key") return fail("Paste the token from claude setup-token.");
    store.audit("owner:ui", r === "created" ? "model_provider_added" : "model_provider_changed", {
      name,
      type: "claude",
      key: token ? `replaced (${keyHint(token)})` : "kept",
    });
    store.setProviderModels(
      name,
      CLAUDE_MODELS.map((m) => ({ id: m.id, context_window: m.context_window })),
    );
    return c.redirect(
      settingsUrl(
        "ok",
        `"${name}" is saved: its ${CLAUDE_MODELS.length} models run only in Claude Code. Choose one for a rig below.`,
      ),
      303,
    );
  };
  // Sign in with ChatGPT: control starts the sign-in (it keeps the PKCE secret) and sends the
  // owner's browser to OpenAI's page. Signing in again to a provider keeps its client and host IDs.
  app.get("/ui/settings/chatgpt/start", (c) => {
    const name = newName(c.req.query("name"));
    return c.redirect(chatgpt.start(name && PROVIDER_NAME.test(name) ? name : undefined), 302);
  });
  /**
   * A ChatGPT subscription signed in (or again): the code in the address the owner pasted is
   * exchanged for the login, which control seals and renews; its models are listed with it.
   */
  const saveChatGPT = async (c: Ctx, name: string, pasted: string, consent: boolean) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const old = store.provider(name);
    if (old && old.type !== "chatgpt")
      return fail(`"${name}" is a provider of another kind: choose another name.`);
    if (!consent)
      return fail(
        "Tick the box that allows Thermite's agents to use your plan when you are not there: OpenAI asks apps for your consent.",
      );
    if (!pasted) return fail("Paste the address the tab went to after the sign-in.");
    const login = await chatgpt.finish(pasted);
    if ("error" in login) return fail(login.error);
    const r = store.putProvider({
      name,
      type: "chatgpt",
      base_url: CHATGPT_API,
      key: { sealed: chatgpt.seal(login), hint: keyHint(login.client_id) },
    });
    store.audit("owner:ui", r === "created" ? "model_provider_added" : "model_provider_changed", {
      name,
      type: "chatgpt",
      login: "signed in with ChatGPT",
      unattended_use: "allowed by the owner",
    });
    const p = store.provider(name);
    const listError = p ? await listInto(p) : "it was not saved";
    const n = store.provider(name)?.models.length ?? 0;
    return c.redirect(
      listError
        ? settingsUrl("error", `"${name}" is signed in, but ${listError}.`)
        : settingsUrl(
            "ok",
            `"${name}" is signed in: its ${n} model${n === 1 ? "" : "s"} run in Pi, OpenCode v2 or Codex. Choose one for a rig below.`,
          ),
      303,
    );
  };
  /** A model provider added or changed. */
  const saveProvider = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = newName(f.name);
    if (!PROVIDER_NAME.test(name))
      return fail("A provider's name is lowercase letters, digits, dots, dashes and underscores.");
    const type = String(f.type ?? "") as ProviderType;
    if (!(type in TYPES)) return fail("A provider is OpenAI-compatible or Anthropic.");
    if (type === "claude")
      return saveClaude(c, name, String(f.claude_token ?? f.api_key ?? "").trim());
    if (type === "chatgpt")
      return saveChatGPT(
        c,
        name,
        String(f.chatgpt_url ?? "").trim(),
        String(f.chatgpt_consent ?? "") === "1",
      );
    const raw = String(f.base_url ?? "").trim();
    if (!raw && type === "openai") return fail("An OpenAI-compatible provider needs its base URL.");
    const base = providerBase(type, raw);
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      return fail("The base URL is not a URL.");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
      return fail("The base URL is http or https, with no credentials, query or fragment in it.");
    const key = String(f.api_key ?? "").trim();
    if (key.length > 4096 || /\s/.test(key)) return fail("The API key has spaces or is too long.");
    const r = store.putProvider({
      name,
      type,
      base_url: base,
      key: key ? { sealed: opts.secrets.seal(key), hint: keyHint(key) } : undefined,
    });
    if (r === "needs_key") return fail("A new provider needs its API key.");
    // The audit names the provider and the key's hint, never the key.
    store.audit("owner:ui", r === "created" ? "model_provider_added" : "model_provider_changed", {
      name,
      type,
      base_url: base,
      key: key ? `replaced (${keyHint(key)})` : "kept",
    });
    const p = store.provider(name);
    const listError = p ? await listInto(p) : null;
    const listed = store.provider(name)?.models.length ?? 0;
    return c.redirect(
      listError
        ? settingsUrl(
            "error",
            `"${name}" is saved, but it ${listError.replace(/^could not/, "could not")}.`,
          )
        : settingsUrl(
            "ok",
            `"${name}" is saved and lists ${listed} model${listed === 1 ? "" : "s"}. Choose one for a rig below.`,
          ),
      303,
    );
  };

  app.post("/ui/settings/providers/:name/refresh", async (c) => {
    const p = store.provider(c.req.param("name"));
    if (!p) return c.redirect(settingsUrl("error", "No such provider."), 303);
    const listError = await listInto(p);
    const n = store.provider(p.name)?.models.length ?? 0;
    return c.redirect(
      listError
        ? settingsUrl("error", `"${p.name}" ${listError}.`)
        : settingsUrl("ok", `"${p.name}" lists ${n} model${n === 1 ? "" : "s"}.`),
      303,
    );
  });

  app.post("/ui/settings/providers/:name/models", async (c) => {
    const f = await c.req.parseBody();
    const name = c.req.param("name");
    const model = String(f.model ?? "").trim();
    if (!store.provider(name)) return c.redirect(settingsUrl("error", "No such provider."), 303);
    if (!MODEL_ID.test(model))
      return c.redirect(
        settingsUrl("error", "A model's name is its id at the provider, without spaces."),
        303,
      );
    store.addProviderModel(name, model);
    store.audit("owner:ui", "model_provider_model_added", { name, model });
    return c.redirect(settingsUrl("ok", `${model} added to "${name}".`), 303);
  });

  // Model prices (goal 075): one table under the providers, one Save. A model the provider's list
  // prices is left as it is; all three fields empty removes the owner's price; In and Out set it.
  // Each change goes through setModelPrice, as POST /v1/model-prices does, and is audited.
  app.post("/ui/settings/prices", async (c) => {
    const f = await c.req.parseBody();
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(`/ui/settings?at=prices&${k}=${encodeURIComponent(m)}#model-prices`, 303);
    const owner = new Map(
      store.modelPrices().map((x) => [JSON.stringify([x.provider, x.model]), x.price]),
    );
    const rows = Object.keys(f)
      .map((k) => /^m(\d{1,4})$/.exec(k)?.[1])
      .filter((i): i is string => i !== undefined)
      .sort((a, b) => Number(a) - Number(b));
    const problems: string[] = [];
    let changed = 0;
    for (const i of rows) {
      const id = f[`m${i}`];
      const name = f[`p${i}`];
      if (typeof id !== "string" || typeof name !== "string") continue;
      const p = store.provider(name);
      const m = p?.models.find((x) => x.id === id);
      if (!p || !m || m.price) continue;
      const read = (k: string) => {
        const v = String(f[`${k}${i}`] ?? "").trim();
        return v === "" ? null : PRICE_NUMBER.test(v) ? Number(v) : Number.NaN;
      };
      const [input, cached, output] = [read("in"), read("cached"), read("out")];
      const who = `${id} of ${p.name}`;
      if ([input, cached, output].some((x) => Number.isNaN(x))) {
        problems.push(`${who}: ${PRICE_WORDS.number}`);
        continue;
      }
      const was = owner.get(JSON.stringify([p.name, id]));
      if (input === null && output === null && cached === null) {
        if (!was) continue;
        const r = setModelPrice(store, { provider: p.name, model: id, clear: true }, "owner:ui");
        if (r.ok) changed++;
        else problems.push(r.error);
        continue;
      }
      if (input === null || output === null) {
        problems.push(`${who}: ${PRICE_WORDS.pair}`);
        continue;
      }
      if (was && was.input === input && was.output === output && was.cached_input === cached)
        continue;
      const r = setModelPrice(
        store,
        { provider: p.name, model: id, input, cached_input: cached, output },
        "owner:ui",
      );
      if (r.ok) changed++;
      else problems.push(r.error);
    }
    if (problems.length)
      return back(
        "error",
        `${problems.join(" ")}${changed ? ` The other ${changed} change${changed === 1 ? " is" : "s are"} saved.` : ""}`,
      );
    return back("ok", changed ? "saved" : "same");
  });

  app.post("/ui/settings/providers/:name/delete", async (c) => {
    const name = c.req.param("name");
    const was = store.provider(name);
    const r = store.deleteProvider(name);
    // A ChatGPT login is ended at OpenAI too (signed out), with the login control had.
    const signedOut =
      r === "deleted" && was?.type === "chatgpt" ? await chatgpt.revoke(was) : undefined;
    if (r === "deleted")
      store.audit("owner:ui", "model_provider_deleted", {
        name,
        ...(signedOut === undefined ? {} : { signed_out_at_openai: signedOut }),
      });
    return c.redirect(
      r === "deleted"
        ? settingsUrl(
            "ok",
            `"${name}" deleted.${signedOut === undefined ? "" : signedOut ? " OpenAI confirmed the sign-out." : " OpenAI did not confirm the sign-out: disconnect Thermite in ChatGPT, Settings › Security and login › Sign in with ChatGPT."}`,
          )
        : settingsUrl("error", r === "in_use" ? `"${name}" is still in use.` : "No such provider."),
      303,
    );
  });

  app.post("/ui/settings/rigs", async (c) => {
    const f = await c.req.parseBody();
    const rig = String(f.rig ?? "");
    const choice = String(f.choice ?? "");
    const harness = harnessOf(f.harness);
    // From the page's script (goal 080): JSON, and the row follows the rig as it takes the model.
    const answer = (k: "ok" | "error", m: string) =>
      wantsJson(c)
        ? k === "ok"
          ? c.json({
              ...modelProgress(store, rig, Date.now()),
              said: m,
              tone: "ok",
              follow: modelFollowUrl(rig),
            })
          : c.json(notSent(m), 400)
        : c.redirect(settingsUrl(k, m), 303);
    if (!store.rigs().some((x) => x.id === rig)) return answer("error", "No such rig.");
    if (!choice) {
      clearRigModel(rig);
      return answer("ok", `${rig} goes back to its own settings within a minute.`);
    }
    const given = giveRigModel(rig, choice, harness);
    return "error" in given ? answer("error", given.error) : answer("ok", given.ok);
  });
  /**
   * Gives a rig a provider's model under a harness, as Providers and Edit rig both do. `cap`: a cap
   * on the model's context window in tokens (goal 070), or null for none. Left out (Providers' form,
   * which has no field for it, or a form without Edit rig's Context fields), a cap the rig has
   * stays while it keeps the same model.
   */
  const giveRigModel = (
    rig: string,
    choice: string,
    picked: Harness,
    effort?: Effort | undefined,
    by = "owner:ui",
    cap?: number | null,
    at?: number | null,
  ): { ok: string; contextWindow: number; compactAt: number | undefined } | { error: string } => {
    let harness = picked;
    const [pRaw, mRaw] = choice.split("|");
    let provider = "";
    let model = "";
    try {
      provider = decodeURIComponent(pRaw ?? "");
      model = decodeURIComponent(mRaw ?? "");
    } catch {
      // A malformed choice lists no model.
    }
    const p = store.provider(provider);
    if (!p?.models.some((m) => m.id === model))
      return { error: "That provider does not list that model." };
    // A Claude subscription runs only in Claude Code, and Claude Code only on one.
    if (p.type === "claude") harness = "claude-code";
    else if (harness === "claude-code")
      return {
        // Codex too, where the provider is one Codex takes.
        error: `Claude Code runs only with a Claude subscription here: choose ${codexTakes(p.type) ? "Pi, OpenCode v2 or Codex" : "Pi or OpenCode v2"} for this provider.`,
      };
    // The Codex CLI speaks only OpenAI's Responses API.
    if (harness === "codex" && !codexTakes(p.type))
      return {
        error:
          "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.",
      };
    // OpenCode's free models (and a keyless OpenCode provider) need its own client.
    if (
      harness !== "opencode" &&
      isOpencodeOwn(p) &&
      (p.type === "opencode" || !p.key_sealed || model.endsWith("-free"))
    )
      return {
        error:
          "OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig.",
      };
    const listed = p.models.find((m) => m.id === model)?.context_window ?? 0;
    const had = store.rigModels()[rig];
    const contextCap =
      cap === undefined
        ? had?.provider === provider && had.model === model
          ? had.contextCap
          : undefined
        : (cap ?? undefined);
    if (typeof cap === "number") {
      const refused = contextCapRefusal(model, listed, cap);
      if (refused) return { error: refused };
    }
    // The compaction point (goal 070), kept as the cap is.
    const compactAt =
      at === undefined
        ? had?.provider === provider && had.model === model
          ? had.compactAt
          : undefined
        : (at ?? undefined);
    if (typeof at === "number") {
      const refused = compactAtRefusal(at);
      if (refused) return { error: refused };
    }
    store.assignRigModel(rig, { provider, model, harness, effort, contextCap, compactAt });
    store.audit(by, "rig_model_given", {
      rig,
      provider,
      model,
      harness,
      effort: effort ?? null,
      context_cap: contextCap ?? null,
      compact_at: compactAt ?? null,
    });
    const capped = capWords(listed, contextCap);
    return {
      ok: `${rig} takes ${model} from "${provider}" under ${HARNESS_NAMES[harness]} within a minute, and checks it.${capped ? ` Its context window: ${capped}.` : ""}${compactAt ? ` Its conversations are compacted at ${compactAtWords(compactAt)}.` : ""}`,
      contextWindow: cappedWindow(listed, contextCap),
      compactAt,
    };
  };
  /** Returns a rig's workers to the rig's own settings, as Providers and Edit rig both do. */
  const clearRigModel = (rig: string, by = "owner:ui") => {
    store.assignRigModel(rig, null);
    store.audit(by, "rig_model_given", { rig, provider: null, model: null });
  };
  /**
   * Checks a model for one of a rig's other agents (or one of the teachers' models), as its row on
   * Edit rig does, or (an empty choice) its default again: the workers' model for the planner,
   * the one in the rig's advisors file for an advisor. Nothing changes here: applyAgentModel saves what this
   * allows. `harness` (goal 073): where it runs; left out (a line's Runs in on its empty choice, or
   * a form without it), the one it has while it keeps the same model, else what the model needs.
   * `cap` and `at`: the agent's own cap on its model's window and its compaction point (goal 070),
   * or null for none; left out (a form without the line's Context fields), the agent keeps its own
   * while it keeps the same model, as giveRigModel does for the workers.
   */
  type AgentModelPlan =
    | { role: AgentRole; clear: true }
    | {
        role: AgentRole;
        clear: false;
        provider: string;
        model: string;
        effort: Effort | undefined;
        harness: Harness;
        contextCap: number | undefined;
        compactAt: number | undefined;
        listed: number;
      };
  const checkAgentModel = (
    rig: string,
    role: AgentRole,
    choice: string,
    effort: Effort | undefined,
    picked?: Harness | undefined,
    cap?: number | null,
    at?: number | null,
  ): AgentModelPlan | { error: string } => {
    if (!choice) return { role, clear: true };
    const [pRaw, mRaw] = choice.split("|");
    let provider = "";
    let model = "";
    try {
      provider = decodeURIComponent(pRaw ?? "");
      model = decodeURIComponent(mRaw ?? "");
    } catch {
      // A malformed choice lists no model.
    }
    const p = store.provider(provider);
    if (!p?.models.some((m) => m.id === model))
      return { error: `That provider does not list that model (${ROLE_WORDS[role].label}).` };
    const had = store.roleModels(rig)[role];
    const same = had?.provider === provider && had.model === model;
    const harness = picked ?? (had?.harness && same ? had.harness : neededHarness(p, model));
    const refusedHarness = harnessRefusal(p, model, harness, ROLE_WORDS[role].who);
    if (refusedHarness) return { error: refusedHarness };
    // The agent's own cap and compaction point (goal 070), checked and kept as the workers' are.
    const listed = p.models.find((m) => m.id === model)?.context_window ?? 0;
    const contextCap = cap === undefined ? (same ? had.contextCap : undefined) : (cap ?? undefined);
    if (typeof cap === "number") {
      const refused = contextCapRefusal(model, listed, cap);
      if (refused) return { error: refused };
    }
    const compactAt = at === undefined ? (same ? had.compactAt : undefined) : (at ?? undefined);
    if (typeof at === "number") {
      const refused = compactAtRefusal(at);
      if (refused) return { error: refused };
    }
    return {
      role,
      clear: false,
      provider,
      model,
      effort,
      harness,
      contextCap,
      compactAt,
      listed,
    };
  };
  /**
   * Saves what checkAgentModel allowed, with its record in the audit log. `ok` is Edit rig's words
   * for the change; `words` say the window and point in sentences, of `whose` model ("Its").
   */
  const applyAgentModel = (
    rig: string,
    plan: AgentModelPlan,
    by = "owner:ui",
    whose = "Its",
  ): { ok: string; contextWindow: number; compactAt: number | undefined; words: string } => {
    const role = plan.role;
    if (plan.clear) {
      store.assignRoleModel(rig, role, null);
      store.audit(by, "agent_model_given", { rig, role, provider: null, model: null });
      return { ok: ROLE_WORDS[role].cleared, contextWindow: 0, compactAt: undefined, words: "" };
    }
    const { provider, model, effort, harness, contextCap, compactAt, listed } = plan;
    store.assignRoleModel(rig, role, { provider, model, effort, harness, contextCap, compactAt });
    store.audit(by, "agent_model_given", {
      rig,
      role,
      provider,
      model,
      effort: effort ?? null,
      harness,
      context_cap: contextCap ?? null,
      compact_at: compactAt ?? null,
    });
    const capped = capWords(listed, contextCap);
    return {
      ok: ROLE_WORDS[role].given,
      contextWindow: cappedWindow(listed, contextCap),
      compactAt,
      words: `${capped ? ` ${whose} context window: ${capped}.` : ""}${compactAt ? ` ${whose} conversations are compacted at ${compactAtWords(compactAt)}.` : ""}`,
    };
  };
  /** A model as a form's choice names it: "provider|model", each part URI-encoded. */
  const modelValue = (provider: string, model: string) =>
    `${encodeURIComponent(provider)}|${encodeURIComponent(model)}`;

  // ---------------------------------------------------------------- Edit rig
  // What runs on a rig and how, from its page: parts on or off, workers at once, limits, the
  // workers' model, the promotion policy. The harness parts go as one signed owner command
  // (rig_settings) with only what changed; the rig reports the settings it runs with.
  const PARTS: { id: RigPart; name: string; does: string; off: string }[] = [
    {
      id: "judge",
      name: "Judge",
      does: "It builds and measures each change that the agents submit, and it does the goal checks. Agents cannot change it.",
      off: "Changes wait in its queue. Nothing is measured, thus no change becomes the champion.",
    },
    {
      id: "workers",
      name: "Workers",
      does: "They change the code, one trial each, and submit each change to the judge.",
      off: "No new trial starts. A trial that runs at this time continues to its end.",
    },
    {
      id: "planner",
      name: "Planner",
      does: "It picks what each worker tries next.",
      off: "Lanes take queued experiments in order, by the fixed rules. Rules that name a direction still apply; free-word rules need the planner's model.",
    },
    {
      id: "teachers",
      name: "Teachers",
      does: "One or two models read recent trials and suggest next steps. Used only if the rig has them.",
      off: "The planner works without their suggestions.",
    },
    {
      id: "auditor",
      name: "Auditor",
      does: "It checks a win before it is kept, when the campaign asks for an audit. Used only if the rig has one.",
      off: "Audits wait for you in Needs you.",
    },
    {
      id: "review",
      name: "Review panel",
      does: "It scores goals that code can't measure. Used only if the rig has one.",
      off: "Those goals stay open: a goal that needs judgement is met only when the Review panel passes it and you accept it.",
    },
    {
      id: "exports",
      name: "Exports",
      does: "Every hour, the rig writes its results for the supervisor to send to the results repository, or to control when the rig has none.",
      off: "Results stay on the rig only. If the rig is lost, its results are lost.",
    },
  ];
  app.get("/ui/assets/edit-rig.js", (c) =>
    c.body(EDIT_RIG_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  app.get("/ui/rigs/:rig/edit", (c) => {
    const vs = views();
    const u = vs.find((x) => x.id === c.req.param("rig"));
    if (!u)
      return page(
        c,
        { title: "Not found", active: "rigs" },
        `<div class="card"><div class="empty">No such rig.</div></div>`,
        vs,
      );
    const s = u.settings;
    const t = csrf(c);
    const rName = encodeURIComponent(u.id);
    const providers = store.providers().filter((p) => p.models.length);
    const want = store.rigModels()[u.id];
    const sw = (p: (typeof PARTS)[number]) => `<div class="pt">
<label class="sw"><input type="checkbox" name="${p.id}" value="1" data-part data-name="${esc(p.name)}"${s?.[p.id] ? " checked" : ""}${s ? "" : " disabled"}><span class="knob"></span></label>
<div><div><b>${esc(p.name)}</b> <span class="pt-state ${s?.[p.id] ? "on" : "off"}">${s ? (s[p.id] ? "on" : "off") : "?"}</span></div><div class="muted small">${esc(p.does)}</div><div class="small pt-off"><b>When it is off:</b> ${esc(p.off)}</div>${p.id === "workers" ? `<label class="fd" style="max-width:220px;margin-top:8px">${infoLabel("Workers at a time", `How many agents work at the same time: 1 to ${MAX_LANES}. Each one uses its own CPUs, memory and disk, and the same model.`)}<input name="lanes" type="number" min="1" max="${MAX_LANES}" value="${s?.lanes ?? 1}"${s ? "" : " disabled"}></label>` : ""}</div></div>`;
    /** Where a provider's model runs: a subscription in Claude Code, OpenCode's own only in OpenCode. */
    const kindOf = (p: ModelProvider, model: string): AgentModelOption["kind"] =>
      p.type === "claude"
        ? "claude"
        : p.type === "chatgpt"
          ? "chatgpt"
          : opencodeOnly(p, model)
            ? "opencode"
            : "key";
    const groups: AgentModelGroup[] = providers.map((p) => ({
      label: `${p.name}${p.type === "claude" ? " (Claude subscription: runs in Claude Code)" : p.type === "chatgpt" ? " (ChatGPT subscription)" : isOpencodeOwn(p) && (p.type === "opencode" || !p.key_sealed) ? " (OpenCode's own free models: OpenCode only)" : ""}`,
      options: p.models.map((m) => ({
        value: modelValue(p.name, m.id),
        label: `${modelPrefix(p.type)}${m.id}`,
        provider: p.name,
        model: m.id,
        kind: kindOf(p, m.id),
        codex: codexTakes(p.type),
        window: m.context_window ?? 0,
      })),
    }));
    const roles = store.roleModels(u.id);
    const none: AgentLineNow = { picked: "", effort: null, harness: null, cap: null, at: null };
    const roleNow = (role: AgentRole): AgentLineNow => {
      const r = roles[role];
      if (!r) return none;
      const p = store.provider(r.provider);
      return {
        picked: modelValue(r.provider, r.model),
        effort: r.effort,
        harness: r.harness ?? (p ? neededHarness(p, r.model) : "pi"),
        cap: r.contextCap ?? null,
        at: r.compactAt ?? null,
      };
    };
    const now = Object.fromEntries(AGENT_ROLES.map((r) => [r, roleNow(r)])) as Record<
      AgentLineId,
      AgentLineNow
    >;
    now.workers = want
      ? {
          picked: modelValue(want.provider, want.model),
          effort: want.effort ?? null,
          harness: want.harness,
          cap: want.contextCap ?? null,
          at: want.compactAt ?? null,
        }
      : { ...none, harness: u.model?.harness ?? "pi" };
    // The second teacher's lines: shown with a second teacher, or after "+ second teacher"; after
    // ×, shown emptied, so that Save removes them (goal 074).
    const second = c.req.query("teachers");
    const hasSecond = Boolean(roles.teachers && roles.second_teacher);
    if (second === "1")
      for (const r of ["second_teacher", "merged_by"] as const)
        if (now[r].picked) now[r] = { ...none, was: now[r].picked };
    const agents = agentsTable({
      groups,
      now,
      two: second === "2" || (second !== "1" && hasSecond),
      href: `/ui/rigs/${rName}/edit`,
      // What an agent with no model uses (goal 074): the rig's own model, as its harness reports
      // it, and its advisors file, as its supervisor reports it.
      defaults: {
        workers:
          u.model?.source === "environment"
            ? (u.model.model ?? undefined)
            : u.model?.source === "none"
              ? null
              : undefined,
        advisors: advisorsFileOf(u.supervisor),
      },
    });
    const placed = store.machineRig(u.id) ?? store.clusterRig(u.id);
    const where = placed
      ? "machine" in placed
        ? `The machine ${esc(placed.machine)}, set up by control. Stop, start or remove it from the rig's page.`
        : `The cluster ${esc(placed.cluster)}, namespace ${esc(placed.namespace)}, set up by control.`
      : "Set up outside control (for example by your own infrastructure tooling). Its GPUs and version change with a roll.";
    const sized = placed && !("machine" in placed) ? clusterSizeFields(placed) : "";
    return page(
      c,
      {
        title: `Edit ${u.id}`,
        crumbs: [
          { href: "/ui/rigs", text: "Rigs" },
          { href: `/ui/rigs/${rName}`, text: u.id },
        ],
        active: "rigs",
      },
      `<p class="run-said">Change what ${esc(u.id)} runs. Control sends the change to the rig as a signed command, and the rig takes it in less than one minute. A part that you turn off keeps all its data.</p>
${s ? "" : `<div class="card warn" style="margin-bottom:16px">This rig's harness is older: it does not report its settings and cannot take them. They work after its next roll. The workers' model works at this time.</div>`}
<form id="edit-rig" method="post" action="/ui/rigs/${rName}/edit"><input type="hidden" name="csrf" value="${t}">
<div class="sec"><h2>1 · Parts of the rig</h2><div class="card flat">${PARTS.map(sw).join("")}
<div class="pt locked"><label class="sw"><input type="checkbox" checked disabled><span class="knob"></span></label><div><div><b>Supervisor</b> <span class="pt-state on">on</span></div><div class="muted small">It relays reports to control, fetches projects and kits, and does all git work for the rig.</div><div class="small pt-off"><b>Always on.</b> It connects the rig to control. Without it, control cannot see or steer the rig.</div></div></div></div></div>
<div class="sec" id="agents"><h2>2 · The agents</h2><p class="lead">Each agent runs in the harness you choose, with its own context. With no model here, the workers use the rig's own settings, and the planner uses the workers' model. An advisor uses the model in the rig's advisors file. If the file has none, that advisor is off.</p>
<div class="card">${agents}</div>
<div class="g3" style="margin-top:14px">
<label class="fd">${infoLabel("One trial lasts (minutes)", "How long a worker can work on one idea before it must submit, when the campaign sets no limit. Empty: no limit; a trial lasts until the worker submits or stops.")}<input name="trial_minutes" type="number" min="1" value="${s?.trial_minutes ?? ""}" placeholder="no limit"${s ? "" : " disabled"}></label>
<label class="fd">${infoLabel("Turns per trial", "How many model turns a worker can take in one trial. Empty: no limit.")}<input name="max_turns" type="number" min="1" value="${s?.max_turns ?? ""}" placeholder="no limit"${s ? "" : " disabled"}></label>
<label class="fd">${infoLabel("Ask me after a quiet spell of (minutes)", QUIET_TIP)}${quietField(u, s?.quiet_minutes ?? null)}</label>
</div></div>
<div class="sec"><h2>3 · When a change becomes the champion</h2><div class="g2">
<label class="ch${s?.promotion === "auto" ? " on" : ""}"><input type="radio" name="promotion" value="auto"${s?.promotion === "auto" ? " checked" : ""}${s ? "" : " disabled"} style="margin:2px 8px 0 0"><span><b>Automatically</b><br><span class="muted small">The judge confirms the change on new runs, and it becomes the champion with no step of yours. When the campaign calls for an audit and this rig has an auditor, the auditor's clear comes first; its block stops the change. A run can still ask you about some changes (Ask me first, when you start it).</span></span></label>
<label class="ch${s?.promotion === "owner_approval" ? " on" : ""}"><input type="radio" name="promotion" value="owner_approval"${s?.promotion === "owner_approval" ? " checked" : ""}${s ? "" : " disabled"} style="margin:2px 8px 0 0"><span><b>Ask me for each change</b><br><span class="muted small">Each confirmed change waits for you in Needs you.</span></span></label>
</div><div class="muted small" style="margin-top:6px">A campaign can set its own rule when it starts; that rule comes first for its runs.</div></div>
<div class="sec"><h2>4 · Where it runs</h2><div class="card"><dl class="facts"><dt>Place</dt><dd>${where}</dd>${u.hardware ? `<dt>Hardware</dt><dd>${hardwareLine(u.hardware)}</dd>` : ""}</dl>${sized}${
        u.gpu_split && u.gpu_split.set >= 2
          ? `<label class="fd" style="max-width:260px;margin-top:10px" data-judge-field>${infoLabel("GPUs for the judge", `How many of the rig's ${u.gpu_split.set} GPUs the judge measures on; the rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. A campaign started on this rig can set it too.${sized ? " With a new number of GPUs above, it is the judge's share of the new ones." : ""}`)}<input name="judge_gpus" type="number" min="1" max="${Math.min(8, u.gpu_split.set - 1)}" value="${u.gpu_split.judge}" data-restarts></label><div class="muted small" data-judge-now>Now: ${u.gpu_split.judge} for the judge, ${u.gpu_split.set - u.gpu_split.judge} for the agents. ${SPLIT_RESTARTS}</div>`
          : ""
      }</div></div>
<div class="card hl" style="margin-top:16px"><b>What changes when you save</b><ul class="chg" id="chg"><li>Nothing changes.</li></ul><div class="act"><button class="primary big" id="save">Save changes</button><a class="btn" href="/ui/rigs/${rName}">Cancel</a></div></div>
</form>
<script src="/ui/assets/edit-rig.js" defer></script>`,
      vs,
    );
  });
  app.post("/ui/rigs/:rig/edit", async (c) => {
    const rig = c.req.param("rig");
    const u = views().find((x) => x.id === rig);
    const back = (k: "ok" | "error", msg: string) =>
      c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(msg)}`, 303);
    if (!u) return back("error", "No such rig.");
    const f = await c.req.parseBody();
    const said: string[] = [];
    const effortOf = (k: string): Effort | undefined =>
      EFFORTS.find((e) => e === String(f[k] ?? ""));
    // Every line is checked before anything is saved, and the settings before any model: a
    // refusal changes nothing.
    // A line's window or point as typed (goal 070): undefined without its field (a form without
    // it keeps what control has), null when empty, else the number; "" when it is not one.
    const typed = (k: string, pct: boolean): number | null | undefined | "" => {
      if (!(k in f)) return undefined;
      let t = String(f[k] ?? "")
        .trim()
        .replace(/[,_\s]/g, "");
      if (pct) t = t.replace(/%$/, "");
      if (!t) return null;
      return /^\d+$/.test(t) ? Number(t) : "";
    };
    /** The window its provider lists for a choice's model, in tokens (0: none). */
    const listedOf = (choice: string) => {
      const [pRaw, mRaw] = choice.split("|");
      try {
        const model = decodeURIComponent(mRaw ?? "");
        return (
          store.provider(decodeURIComponent(pRaw ?? ""))?.models.find((m) => m.id === model)
            ?.context_window ?? 0
        );
      } catch {
        return 0;
      }
    };
    /**
     * A line's cap and point as the form gives them: the provider's own window is no cap, and 80%
     * no point of its own (the default), as the line's Context cell says; or why not, in words.
     */
    const contextOf = (
      id: AgentLineId,
      choice: string,
    ): { cap: number | null | undefined; at: number | null | undefined } | { error: string } => {
      const cap = typed(id === "workers" ? "context_workers" : `context_${id}`, false);
      const at = typed(id === "workers" ? "compact_workers" : `compact_${id}`, true);
      if (cap === "") return { error: "write the number of tokens in digits, such as 131072." };
      if (at === "")
        return {
          error: `the compaction point is a whole percent of the context window, from ${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}.`,
        };
      return {
        cap: typeof cap === "number" && cap === listedOf(choice) ? null : cap,
        at: at === COMPACT_AT_DEFAULT ? null : at,
      };
    };
    /** Each line's name, as the page shows it, for its refusals. */
    const twoTeachers = String(f.role_second_teacher ?? "") !== "";
    const LINE: Record<AgentLineId, string> = {
      workers: "Workers",
      planner: "Planner",
      teachers: twoTeachers ? "Teacher 1" : "Teachers",
      second_teacher: "Teacher 2",
      merged_by: "Merged by",
      auditor: "Auditor",
      review_panel: "Review panel",
    };
    const refuse = (id: AgentLineId, why: string) => back("error", `${LINE[id]}: ${why}`);

    // The other agents' lines (goals 070, 073 and 074): each one's model, effort, harness, window
    // and point. Only the lines the form has: a line it lacks keeps its model. The first teacher
    // with no model (the advisors file's) takes the second teacher and the merged by model with
    // it, as set_rig_model's clear does; a second teacher needs a first.
    const roles = store.roleModels(rig);
    const noTeachers = "role_teachers" in f && !String(f.role_teachers ?? "");
    if (noTeachers && twoTeachers)
      return refuse(
        "second_teacher",
        "a second teacher needs a first. Choose the first teacher's model, or remove the second teacher.",
      );
    const plans: AgentModelPlan[] = [];
    for (const role of AGENT_ROLES) {
      if (noTeachers && (role === "second_teacher" || role === "merged_by")) {
        if (roles[role]) plans.push({ role, clear: true });
        continue;
      }
      if (!(`role_${role}` in f)) continue;
      const raw = String(f[`role_${role}`] ?? "");
      const cur = roles[role];
      if (!raw && !cur) continue;
      const roleEffort = effortOf(`effort_${role}`);
      const picked = HARNESSES.find((h) => h === String(f[`harness_${role}`] ?? ""));
      const ctx = contextOf(role, raw);
      if ("error" in ctx) return refuse(role, ctx.error);
      if (cur && raw === modelValue(cur.provider, cur.model)) {
        const p = store.provider(cur.provider);
        const curHarness = cur.harness ?? (p ? neededHarness(p, cur.model) : "pi");
        if (
          (roleEffort ?? null) === cur.effort &&
          (picked === undefined || picked === curHarness) &&
          (ctx.cap === undefined || ctx.cap === (cur.contextCap ?? null)) &&
          (ctx.at === undefined || ctx.at === (cur.compactAt ?? null))
        )
          continue;
      }
      const plan = checkAgentModel(rig, role, raw, roleEffort, picked, ctx.cap, ctx.at);
      if ("error" in plan) return refuse(role, plan.error);
      plans.push(plan);
    }

    // The workers' line: as in Providers, with its own window and point.
    const choice = String(f.choice ?? "");
    const want = store.rigModels()[rig];
    // A form without the harness (the line had no model) keeps the one control has.
    const harness = "harness" in f ? harnessOf(f.harness) : (want?.harness ?? "pi");
    const effort = effortOf("effort");
    const wCtx = contextOf("workers", choice);
    if ("error" in wCtx) return refuse("workers", wCtx.error);
    const workersChange =
      choice !== (want ? modelValue(want.provider, want.model) : "") ||
      (choice !== "" &&
        (harness !== want?.harness ||
          (effort ?? null) !== (want?.effort ?? null) ||
          (wCtx.cap !== undefined && wCtx.cap !== (want?.contextCap ?? null)) ||
          (wCtx.at !== undefined && wCtx.at !== (want?.compactAt ?? null))));
    // Checked now, given below with the rest: the window and the point as giveRigModel checks them.
    if (workersChange && choice) {
      const [, mRaw] = choice.split("|");
      const why =
        (typeof wCtx.cap === "number"
          ? contextCapRefusal(decodeURIComponent(mRaw ?? ""), listedOf(choice), wCtx.cap)
          : undefined) ?? (typeof wCtx.at === "number" ? compactAtRefusal(wCtx.at) : undefined);
      if (why) return refuse("workers", why);
    }

    // A rig control set up on a cluster: its GPUs, CPUs and memory (goal 118), checked here with
    // the rest, against the slot's quota read again, and changed last. With a new number of GPUs,
    // GPUs for the judge is the judge's share of them, not a split of the old ones.
    const onCluster = store.clusterRig(rig);
    let resize: Awaited<ReturnType<typeof prepareResize>> | undefined;
    let gpusMoved = false;
    if (onCluster && ("k_gpus" in f || "k_cpus" in f || "k_mem" in f)) {
      const field = (k: string) => {
        if (!(k in f)) return undefined;
        const v = String(f[k] ?? "").trim();
        return v === "" ? null : Number(v);
      };
      const cur = onCluster.spec;
      const want: ClusterResourcesRequest = {};
      const gpus = field("k_gpus");
      if (typeof gpus === "number" && gpus !== cur.gpus) {
        want.gpus = gpus;
        gpusMoved = true;
        const judge = u.gpu_split ? field("judge_gpus") : undefined;
        if (typeof judge === "number") want.judgeGpus = judge;
      }
      const cpus = field("k_cpus");
      const memoryGi = field("k_mem");
      if (
        cpus !== undefined &&
        memoryGi !== undefined &&
        (cpus !== (cur.resources?.cpus ?? null) || memoryGi !== (cur.resources?.memoryGi ?? null))
      ) {
        want.cpus = cpus;
        want.memoryGi = memoryGi;
      }
      if (!asksNothing(want)) {
        resize = await prepareResize(rig, want, "owner:ui", { owner: true });
        if ("error" in resize) return back("error", `Not saved: ${resize.error}`);
      }
    }

    // The harness's settings: only what changed, checked here (as REST's and MCP's twins check
    // them: rig-settings.ts) and sent below as one signed command. An empty Workers at a time
    // keeps what the rig has; an empty One trial lasts or Turns per trial is no limit.
    const s = u.settings;
    let settings: RigSettingsChange | undefined;
    if (s) {
      const num = (k: string) => {
        const v = String(f[k] ?? "").trim();
        return v === "" ? null : Number(v);
      };
      const out = rigSettingsChange(rig, s, u.gpu_split, {
        ...Object.fromEntries(PARTS.map((p) => [p.id, f[p.id] === "1"])),
        lanes: num("lanes") ?? undefined,
        // Empty: no limit (goal 079).
        trial_minutes: num("trial_minutes"),
        max_turns: num("max_turns"),
        quiet_minutes: num("quiet_minutes"),
        promotion: String(f.promotion ?? s.promotion),
        // The field shows only on a rig with a GPU set. With a new number of GPUs, it goes with
        // the change to them.
        judge_gpus: u.gpu_split && !gpusMoved ? (num("judge_gpus") ?? undefined) : undefined,
      });
      if ("error" in out) return back("error", out.error);
      settings = out.change;
    }

    // Everything is checked: save the models, then send the settings.
    if (workersChange) {
      if (!choice) {
        clearRigModel(rig);
        said.push("its own model settings");
      } else {
        const given = giveRigModel(rig, choice, harness, effort, "owner:ui", wCtx.cap, wCtx.at);
        if ("error" in given) return refuse("workers", given.error);
        said.push("a new model");
      }
    }
    const teachersCleared = plans.some((p) => p.role === "teachers" && p.clear);
    for (const plan of plans) {
      const ok = applyAgentModel(rig, plan).ok;
      // The teachers back to the advisors file: said once, for their three models.
      if (!(teachersCleared && plan.clear && plan.role !== "teachers")) said.push(ok);
    }
    let sent: string | undefined;
    if (settings) {
      sent = issueCommand(store, opts.privateKeyPem, {
        rig,
        kind: "rig_settings",
        payload: settings,
        issuedBy: "owner:ui",
      }).id;
      said.push(settingsCount(Object.keys(settings).length));
    }
    // Last, its GPUs, CPUs and memory: its pods restart (or it drains first).
    let resized = "";
    if (resize && !("error" in resize)) {
      const done = "go" in resize ? await resize.go() : resize;
      if ("error" in done)
        return back(
          "error",
          `${said.length ? `Control sent ${said.join(" and ")} to ${rig}, but its` : "Its"} GPUs, CPUs and memory did not change: ${done.error}`,
        );
      resized = done.ok;
    }
    if (!said.length) return back("ok", resized || "Nothing changed.");
    // The rig's page follows the settings' command, and the rig as it takes a model (goal 080).
    return c.redirect(
      `/ui/rigs/${encodeURIComponent(rig)}?ok=${encodeURIComponent(`Control sent ${said.join(" and ")} to ${rig}. The rig takes the change in less than one minute.${resized ? ` ${resized}` : ""}`)}${sent ? `&cmd=${encodeURIComponent(sent)}` : ""}`,
      303,
    );
  });

  app.post("/ui/commands", async (c) => {
    const f = await c.req.parseBody();
    const kind = String(f.kind) as CommandKind;
    if (!COMMAND_KINDS.includes(kind)) return c.text("unknown command", 400);
    const run = String(f.run ?? "");
    // Kinds the rig's harness doesn't know yet are refused above (COMMAND_KINDS).
    const payload = formPayload(kind, f);
    // The page's script sends the form with fetch and follows the command (goal 080): it takes
    // JSON. A plain form post gets the page again, which says "Sent".
    const json = wantsJson(c);
    if (payload === undefined) {
      const why = "this command is not available from the dashboard";
      return json ? c.json(notSent(why), 400) : c.text(why, 400);
    }
    // Close run (goal 087) takes the owner's reason and the typed words, as its form asks.
    const closing =
      kind === "hypothesis_status"
        ? String(f.reason ?? "").trim()
          ? ""
          : "write why you change the hypothesis first"
        : kind !== "close_run"
          ? ""
          : !String(f.reason ?? "").trim()
            ? "write why you close the run first"
            : String(f.confirm ?? "").trim() !== `close ${run}`
              ? `type close ${run} to confirm`
              : "";
    if (closing) return json ? c.json(notSent(closing), 400) : c.text(`refused: ${closing}`, 400);
    let woke: string | null;
    let id: string;
    try {
      // A run resumed on a stopped RunPod pod starts the pod first.
      ({ id, woke } = await issueWaking(store, opts.privateKeyPem, opts.runpodRigs, {
        rig: String(f.rig),
        kind,
        payload,
        issuedBy: "owner:ui",
        owner: true,
      }));
    } catch (err) {
      const why = errorText(err);
      return json ? c.json(notSent(why), 400) : c.text(`refused: ${why}`, 400);
    }
    const now = Date.now();
    const cmd = store.commandRow(id);
    // A check's row says how it stands itself; any other command says it beside its button.
    const check = kind === "rig_check" ? String(f.check ?? "") : "";
    const progress: Progress = check
      ? checkProgress(
          checkRows(store, String(f.rig), now)[check] ?? checkRow(check, undefined, cmd, now),
        )
      : cmd
        ? commandProgress(cmd, now)
        : { state: "sent", final: false, said: "", tone: "" };
    if (json)
      return c.json({
        ...progress,
        said: [woke ?? "", progress.said].filter(Boolean).join(" "),
        follow: check ? checkFollowUrl(String(f.rig), check) : commandFollowUrl(id),
      });
    // The page says the command went; the rig's answer shows where the command was given.
    const to = backTo(f, `/ui/rigs/${encodeURIComponent(String(f.rig))}`);
    const [path, hash] = to.split("#");
    const sent = `${woke ? `${woke} ` : ""}Sent to ${String(f.rig)} at ${clockUtc(cmd?.issued_at ?? new Date(now).toISOString())}.${kind === "export_now" ? ` ${exportForm(f).asked} ${EXPORT_WHERE}` : ""}`;
    return c.redirect(
      `${path}${path?.includes("?") ? "&" : "?"}sent=${encodeURIComponent(sent)}${hash ? `#${hash}` : ""}`,
      303,
    );
  });

  return app;
}
