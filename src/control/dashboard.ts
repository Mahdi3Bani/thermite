import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { COMMAND_KINDS, type CommandKind, CommandPayloads } from "../core/commands.ts";
import {
  type ClusterFacts,
  checkCluster,
  clusterLine,
  HARNESS_LABELS,
  slotNetwork,
} from "./clusters/facts.ts";
import {
  type ClusterKubectl,
  inspectKubeconfig,
  KUBE_NAME,
  kubeError,
  realKubectl,
} from "./clusters/kubectl.ts";
import { asList, clusterRigObjects } from "./clusters/manifests.ts";
import type { Credential } from "./credential.ts";
import { newToken } from "./credential.ts";
import { makeDeployKey } from "./git-keys.ts";
import { issueCommand, propagateChampion } from "./issue.ts";
import {
  JOIN_HOURS,
  type JoinedSpec,
  type JoinForm,
  joinCommand,
  joinedCommands,
  joinMachineScript,
  joinNamespaceManifest,
} from "./join.ts";
import type { KitRepos } from "./kit-repos.ts";
import { kitSummary, unpackKit } from "./kit-upload.ts";
import { advanceResets, cancelReset, confirmReset, type DeploymentDriver } from "./lifecycle.ts";
import {
  deployScript,
  MAX_RIG_GPUS,
  manageScript,
  RIG_NAME,
  type RigAction,
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
import { startCampaign, startRun } from "./new-campaign.ts";
import {
  ANTHROPIC_BASE,
  CLAUDE_MODELS,
  isOpencodeOwn,
  listModels,
  providerBase,
} from "./providers.ts";
import { probeRepository } from "./repo-probe.ts";
import { type RunpodFacts, readRunpod, runpodLine } from "./runpod.ts";
import { keyHint, type SecretBox } from "./secrets.ts";
import {
  type Cluster,
  type ClusterRig,
  type ControlStore,
  fingerprint,
  type Harness,
  type JoinedRig,
  type Machine,
  type MachineRig,
  type ModelProvider,
  type ProviderType,
} from "./store.ts";
import { ADD_RIG_JS } from "./ui/add-rig-client.ts";
import { CLIENT_JS } from "./ui/client.ts";
import {
  ago,
  avatar,
  campaignHref,
  campaignState,
  deltaCell,
  esc,
  fmtInt,
  gainChart,
  hardwareCard,
  hardwareLine,
  icon,
  kpi,
  meter,
  modeAvatar,
  modeName,
  num,
  pct,
  runHref,
  runKey,
  runState,
  type Shell,
  shell,
  stackBar,
} from "./ui/components.ts";
import { EDIT_RIG_JS } from "./ui/edit-rig-client.ts";
import { liveEntryHtml, liveLinesHtml, resultJoin } from "./ui/live.ts";
import { infoLabel, newCampaignBody } from "./ui/new-campaign.ts";
import { NEW_CAMPAIGN_JS } from "./ui/new-campaign-client.ts";
import {
  attemptDetail,
  attemptHref,
  attemptRows,
  cap,
  type Forms,
  goalState,
  jobHtml,
  liveHref,
  type Need,
  needs as operatorNeeds,
  runBrief,
  runRow,
  runStateHtml,
  timeline,
  waitingOn,
} from "./ui/operator.ts";
import { PROVIDERS_JS } from "./ui/providers-client.ts";
import { STYLE } from "./ui/style.ts";
import { auditReason, clip, jobText, runStatusText, signed, span } from "./ui/words.ts";
import {
  type CampaignView,
  campaignViews,
  leaderboard,
  type RigSettingsView,
  type RigView,
  type RunView,
  rigView,
} from "./views.ts";

/**
 * The control dashboard: server-rendered pages over control's store, with forms that issue
 * signed commands. Login takes the admin token once and keeps a random session in an HttpOnly,
 * SameSite=Strict cookie. Sessions are kept in control's store (hashed), so a restart does not
 * sign the owner out; each use renews one, and a new admin token ends them all. Every form
 * carries a token derived from the session and the admin token (CSRF). The only
 * script is control's own (/ui/assets/app.js): it refreshes pages and streams the live view.
 * The look follows Magnesium's design.
 */

/** How long a dashboard session lasts without use; each day of use renews it. */
const SESSION_DAYS = 30;
const DAY_MS = 24 * 3_600_000;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
// biome-ignore lint/suspicious/noExplicitAny: any route's context
type Ctx = Context<any, any, any>;
type RunViewName = "overview" | "attempts" | "history" | "steering";

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
  /** How control reaches model providers to list their models (tests give their own). */
  providerFetch?: typeof fetch | undefined;
  /** Kits control writes (the new-campaign page); none: campaigns cannot be created here. */
  kits?: KitRepos | undefined;
  /** How control reads a project's repository (tests give their own). */
  probeRepo?: typeof probeRepository | undefined;
  /** Control's address as rigs and machines reach it. */
  publicUrl?: string | undefined;
  /** How control reaches machines over SSH (tests give their own). */
  machineSsh?: MachineSsh | undefined;
  /** The images control deploys rigs from (none: control can't set rigs up on machines). */
  rigImages?: RigImages | undefined;
  /** How control reaches Kubernetes clusters (tests give their own). */
  clusterKubectl?: ClusterKubectl | undefined;
  /** How control reaches GPU clouds' APIs (tests give their own). */
  cloudFetch?: typeof fetch | undefined;
}

/** The images a rig control sets up runs: the harness (CPU, and CUDA for GPU rigs), the supervisor. */
export interface RigImages {
  harness: string;
  harnessCuda?: string | undefined;
  supervisor: string;
}

export function createDashboard(store: ControlStore, opts: DashboardOptions): Hono {
  const app = new Hono();
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
  const sameBytes = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
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
    if (!s || s.expiresAt <= now || !sameBytes(s.tokenFp, tokenFp)) return undefined;
    // Renewed at most once a day, so a session in use does not run out.
    if (s.expiresAt - now < sessionMs - DAY_MS) {
      store.extendUiSession(hashOf(sid), now + sessionMs);
      cookie(c, sid);
    }
    return sid;
  };

  app.get("/ui/login", (c) =>
    c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Thermite</title><style>${STYLE}
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
      if (!sameBytes(String(form.csrf ?? ""), csrfOf(sid))) return c.text("bad form token", 403);
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
    c.body(CLIENT_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  const csrf = (c: Ctx) => csrfOf(sessionOf(c) ?? "");
  const views = (): RigView[] =>
    store
      .rigs()
      .map((u) => rigView(store, u.id, { staleAfterMs: opts.staleAfterMs }))
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
    },
  ) =>
    `<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="rig" value="${esc(f.rig)}"><input type="hidden" name="kind" value="${esc(f.kind)}">${Object.entries(
      f.fields ?? {},
    )
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join(
        "",
      )}${f.back ? `<input type="hidden" name="back" value="${esc(f.back)}">` : ""}${f.extra ?? ""}<button class="${f.cls ?? ""}">${esc(f.label)}</button></form>`;

  const forms = (c: Ctx): Forms => ({
    cmd: (f) => cmdForm(c, f),
    csrf: csrf(c),
  });
  /** Everything that waits for the owner, across rigs: the "Needs you" feed, with its evidence. */
  const needs = (c: Ctx, vs: RigView[], now: number, back = "/ui"): Need[] =>
    operatorNeeds(store, vs, forms(c), now, back);
  /** The page shell with the sidebar's rigs and campaigns. */
  const page = (c: Ctx, s: Omit<Shell, "rigs" | "needs" | "now">, body: string, vs = views()) => {
    const now = Date.now();
    // A command just sent from this page (POST /ui/commands): say so at the top.
    const sent = c.req.query("sent");
    if (sent)
      body = `<div class="card sent-note" style="margin-bottom:16px"><b class="ok">${esc(sent)}</b></div>${body}`;
    return c.html(
      shell(
        {
          ...s,
          rigs: vs,
          needs: needs(c, vs, now).filter((n) => n.kind !== "stale").length,
          now,
          refresh: s.refresh ?? 15,
        },
        body,
      ),
    );
  };

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
    const decisions = needs(c, [u], now, back).filter((n) => n.run === i.id);
    const goals = i.goals.length
      ? `<div class="block"><div class="head"><h2>Goals</h2><span class="n">${i.goals.filter((g) => g.status === "met").length} of ${i.goals.length} met</span><span class="right">the judge's check of champion #${esc(i.goals_seq ?? "?")}${i.goals_at ? `, ${esc(ago(i.goals_at, now))} ago` : ""}</span></div><div class="card flat">${i.goals
          .map((g) => {
            const st = goalState(g);
            return `<div class="gl"><span class="gl-mark ${st.tone}">${st.mark}</span><span class="gl-main"><span><b>${esc(g.goal)}</b>${g.status === "met" ? "" : ` <span class="chip ${st.tone === "off" ? "" : st.tone}">${esc(st.word)}</span>`}</span>${g.description ? `<span class="muted">${esc(clip(g.description, 200))}</span>` : ""}${g.status === "met" ? "" : `<span class="gl-why ${st.tone}">${esc(g.reasons.slice(0, 400))}</span>`}</span></div>`;
          })
          .join("")}</div></div>`
      : i.mode === "goal"
        ? `<div class="block"><div class="head"><h2>Goals</h2></div><div class="card"><div class="empty">The judge has not checked the goals yet.</div></div></div>`
        : "";
    const research = i.research
      ? (() => {
          const r = i.research as Record<string, unknown>;
          const qs = Array.isArray(r.questions)
            ? (r.questions as { q?: unknown; verified?: unknown }[])
            : [];
          const most = Math.max(1, ...qs.map((q) => num(q.verified)));
          return `<div class="block"><div class="head"><h2>Research questions</h2><span class="right">${esc(String(r.kind ?? ""))} · ${esc(ago(String(r.at ?? ""), now))} ago</span></div><div class="card"><div class="stack">${
            qs
              .map((q) =>
                meter(String(q.q ?? ""), `${num(q.verified)} claims`, num(q.verified) / most, "ok"),
              )
              .join("") || `<div class="muted small">No question coverage yet.</div>`
          }</div>${num(r.unsupported_numbers) ? `<div class="note warn">${num(r.unsupported_numbers)} numbers in the report have no source.</div>` : ""}<details data-k="report-${esc(i.id)}" style="margin-top:12px"><summary class="small muted" style="cursor:pointer">Latest report</summary><pre class="report" style="margin-top:8px">${esc(String(r.report ?? ""))}</pre></details></div></div>`;
        })()
      : "";
    const now_ =
      i.status === "running"
        ? runBrief(store, u, i, now, { detail: true })
        : `<div class="card"><div class="small">This run is <b>${esc(runStatusText(i))}</b>. ${i.status === "paused" ? `Nothing new starts until it is resumed.` : "It is finished."}</div></div>`;
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
    // The run's promotion policy, as it was assigned: what a confirmed win does here.
    const policy =
      i.promotion === "auto"
        ? "Promotion: <b>automatic</b>. A confirmed win becomes the champion; an audit still holds a surprising gain or declared flaws, and a gain above the absolute trigger waits for you."
        : i.promotion === "owner_approval"
          ? "Promotion: <b>your approval</b>. Every confirmed win waits for you before it becomes the champion."
          : "Promotion: <b>the rig's default</b> (set where the rig is deployed). A run assigned with its own policy shows it here.";
    const steer = `<div class="card"><div class="card-head"><span class="title">Steer this run</span><span class="right muted small">${i.directives} directive${i.directives === 1 ? "" : "s"} in force</span></div>
<div class="small" style="margin-top:6px">${policy}</div>
<div class="dc-choices" style="border:0;padding-top:10px">
${
  i.status === "paused"
    ? ctl(
        cmdForm(c, {
          rig: u.id,
          kind: "resume_run",
          fields: { run: i.id },
          label: "Resume",
          cls: "primary",
          back,
        }),
        "New trials start again, and the planner plans the next epoch.",
      )
    : ctl(
        cmdForm(c, {
          rig: u.id,
          kind: "pause_run",
          fields: { run: i.id },
          extra: `<input name="reason" placeholder="why (optional)" style="width:120px">`,
          label: "Pause",
          back,
        }),
        "The lanes' running trials stop and no new ones start. The judge still finishes the jobs already queued. Resume picks up from the same champion.",
      )
}
${ctl(cmdForm(c, { rig: u.id, kind: "reset_workers", fields: { run: i.id }, label: "Reset workers", back }), "Ends the lanes' running trials now and the current epoch: the planner plans afresh, and every lane starts again from the champion. Nothing the judge decided is lost.")}
${ctl(`<a class="btn" href="${liveHref(u.id)}">${icon.terminal}Live sessions</a>`, "Watch the agents and the judge as they work, and message a lane, a trial or the planner.")}
${propagate}
${ctl(
  `<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(i.id)}"><input type="hidden" name="kind" value="redirect"><input type="hidden" name="back" value="${esc(back)}">
<select name="directive"><option value="avoid">avoid</option><option value="try">try</option><option value="mandate">always assign</option></select>
<input name="family" placeholder="direction" required style="width:120px"><input name="rationale" placeholder="why, with a source" required style="width:150px">
<label class="muted small row"><input type="checkbox" name="add" value="1" style="height:auto"> keep my earlier ones</label><button>Steer</button></form>`,
  "Tells the planner, from its next plan on, to avoid a direction family, to try it, or to always assign it. It cannot change a verdict. Unless you keep them, your earlier directives are replaced.",
)}
</div></div>`;
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
      i.reviews.length
        ? `<div class="block"><div class="head"><h2>Reviews of subjective goals</h2></div><div class="card flat"><table><thead><tr><th>Goal</th><th>Commit</th><th>Panel</th><th>You</th></tr></thead><tbody>${i.reviews
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
      kpi(
        "Plans",
        String(a.epochs),
        a.epochs
          ? `${Math.round((100 * a.planner_valid) / a.epochs)}% valid · ${a.fallbacks} fallbacks`
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
    const champ = i.champion.filter((x) => !x.reopened).at(-1);
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
      judging
        ? `The judge is ${esc(jobText(judging).replace(/^[A-Z]/, (x) => x.toLowerCase()))}.`
        : "",
      waiting
        ? `<b class="warn">${waiting} decision${waiting === 1 ? " waits" : "s wait"} for you.</b>`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const patch =
      i.published && store.championPatch(u.id, i.id, i.published.seq)
        ? `<a href="/ui/rigs/${encodeURIComponent(u.id)}/runs/${encodeURIComponent(i.id)}/champions/${i.published.seq}.patch">download champion #${i.published.seq} as a patch</a> <span class="muted small">(applies to ${esc(i.published.base_commit.slice(0, 8))})</span>`
        : "";
    // The champions, newest first: what each one changed and what it gained.
    const ladder =
      i.mode === "hill_climb"
        ? `<div class="block"><div class="head"><h2>Champions</h2><span class="n">${i.champion.filter((x) => !x.reopened).length}</span><span class="right">gain over the starting point, measured on this rig</span></div><div class="card flat"><div class="ladder-chart">${gainChart(i)}</div>${i.champion
            .filter((x) => !x.reopened)
            .slice()
            .reverse()
            .slice(0, 12)
            .map((x) => {
              const a = x.attempt ? i.attempts.find((y) => y.id === x.attempt) : undefined;
              return `<div class="lad"><span class="lad-n">#${x.seq}</span><span class="lad-main">${x.attempt ? `<a href="${attemptHref(u.id, x.attempt)}">${esc(clip(a?.hypothesis ?? x.attempt, 140))}</a>` : `<span class="muted">the starting point</span>`}</span><span>${typeof x.delta === "number" ? `<span class="chip ok">${esc(signed(x.delta))}</span>` : ""}</span><b class="fig">${esc(signed(x.cumulative - 1))}</b><span class="lad-age">${esc(ago(x.at, now))}</span></div>`;
            })
            .join("")}</div></div>`
        : "";
    const policyWord =
      i.promotion === "auto"
        ? "Automatic when the judge confirms; audits and big gains still wait for you"
        : i.promotion === "owner_approval"
          ? "Only with your approval"
          : "The rig's default (set where the rig is deployed)";
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
          : "None: changes come from people",
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
        ? `${i.attempts.length ? `<div class="card" style="margin-bottom:12px"><div class="card-head"><span class="title">How the judge decided</span><span class="right muted small">${i.attempts.length} attempts</span></div><div style="margin-top:10px">${stackBar(i.verdicts)}</div></div>` : ""}${laneCard}${attemptRows(u, i, newest.slice(0, 300), now)}${i.attempts.length > 300 ? `<div class="muted small" style="margin-top:8px">The newest 300 of ${i.attempts.length}.</div>` : ""}`
        : view === "history"
          ? timeline(
              i.timeline.map((e) => ({ u, e })),
              now,
              { limit: 400 },
            )
          : view === "steering"
            ? `<div class="block">${steer}</div>${records}${diagnostics}`
            : `<p class="run-said">${said}</p>
${waiting ? `<div class="block" id="needs"><div class="head"><h2>Needs you</h2><span class="n">${waiting}</span></div><div class="dqs">${decisions.map((n) => n.html).join("")}</div></div>` : ""}
<div class="cols run-cols"><div>
${goals}${research}${ladder}
<div class="block"><div class="head"><h2>Attempts</h2><span class="n">${i.attempts.length}</span><span class="right"><a href="${runHref(u.id, i, "attempts")}">All ${i.attempts.length}</a></span></div>${attemptRows(u, i, newest.slice(0, 8), now)}</div>
</div><div class="side">
<div class="block"><div class="head"><h2>Now</h2></div>${now_}</div>
<div class="block"><div class="head"><h2>The run</h2></div><div class="card"><dl class="facts">${settings}</dl></div></div>
<div class="block"><div class="head"><h2>Recent</h2><span class="right"><a href="${runHref(u.id, i, "history")}">Full history</a></span></div>${recent}</div>
</div></div>`;
    const st = runState(i);
    const quick =
      i.status === "paused"
        ? cmdForm(c, {
            rig: u.id,
            kind: "resume_run",
            fields: { run: i.id },
            label: "Resume",
            back,
          })
        : i.status === "running"
          ? cmdForm(c, {
              rig: u.id,
              kind: "pause_run",
              fields: { run: i.id },
              label: "Pause",
              back,
            })
          : "";
    return `<section class="block" id="${esc(runKey(u.id, i.id))}">
<div class="run-head">${modeAvatar(i.mode)}<div class="grow"><div class="run-title">Run ${esc(i.id)} <span class="muted small">on rig <a href="/ui/rigs/${encodeURIComponent(u.id)}">${esc(u.id)}</a>${u.stale ? ` <span class="bad">(not reporting)</span>` : ""}</span> <span class="label ${st.cls}">${st.icon}${esc(st.text)}</span></div></div>
<div class="seg">${sub("overview", "Overview", waiting ? ` <span class="dot warn"></span>` : "")}${sub("attempts", "Attempts", ` <span class="muted">${i.attempts.length}</span>`)}${sub("history", "History")}${sub("steering", "Steering")}</div>
<a class="btn" href="${liveHref(u.id)}">${icon.terminal}Live</a>${quick}</div>
${body}
</section>`;
  };

  /** A campaign's headline figure: its best run's gain, goals met or verified claims. */
  const headline = (k: CampaignView): { value: string; sub: string; best?: RunView } => {
    const runs = k.runs.map((x) => x.run);
    if (k.mode === "hill_climb") {
      const gain = (i: RunView) =>
        (i.champion.filter((s) => !s.reopened).at(-1)?.cumulative ?? 1) - 1;
      const best = [...runs].sort((a, b) => gain(b) - gain(a))[0];
      return { value: best ? pct(gain(best), 1) : "·", sub: "best gain over its baseline", best };
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
  const runMetric = (i: RunView) =>
    i.mode === "hill_climb"
      ? pct((i.champion.filter((s) => !s.reopened).at(-1)?.cumulative ?? 1) - 1, 1)
      : i.mode === "goal"
        ? `${i.goals.filter((g) => g.status === "met").length}/${i.goals.length} goals`
        : `${num((i.research as Record<string, unknown> | null)?.verified)} claims`;

  // ---------------------------------------------------------------- overview (Magnesium's Home)
  app.get("/ui", (c) => {
    const now = Date.now();
    const vs = views();
    const feed = needs(c, vs, now);
    const urgent = feed.filter((n) => n.kind !== "stale");
    const camps = campaignViews(vs);
    // What happened lately, across rigs, in words.
    const activity = timeline(
      vs.flatMap((u) => u.recent.slice(0, 40).map((e) => ({ u, e }))),
      now,
      { limit: 10, showRig: true },
    );
    // One scan, top to bottom: what needs you, what is at work, what happened.
    const live = vs.flatMap((u) =>
      u.runs
        .filter((i) => i.status === "running")
        .map((i) =>
          runBrief(store, u, i, now, {
            heading: true,
            waiting: feed.filter((n) => n.rig === u.id && n.run === i.id).length,
          }),
        ),
    );
    const running = live.length;
    const reporting = vs.filter((u) => !u.stale).length;
    const judging = vs.filter((u) => u.judge.now).length;
    const tile = (n: string, label: string, tone: string, href = "") =>
      `<${href ? `a href="${href}"` : "div"} class="tally ${tone}"><b>${n}</b><span>${esc(label)}</span></${href ? "a" : "div"}>`;
    const tallies = `<div class="tallies">${tile(String(urgent.length), urgent.length === 1 ? "needs you" : "need you", urgent.length ? "warn" : "", urgent.length ? "#needs" : "")}${tile(String(running), running === 1 ? "run at work" : "runs at work", running ? "ok" : "")}${tile(String(judging), judging === 1 ? "judge measuring" : "judges measuring", "")}${tile(`${reporting}/${vs.length}`, "rigs reporting", reporting < vs.length ? "bad" : "")}</div>`;
    return page(
      c,
      {
        title: "Overview",
        summary: `${urgent.length ? `<span class="warn">${urgent.length} need${urgent.length === 1 ? "s" : ""} you</span>` : "nothing needs you"} · ${running} run${running === 1 ? "" : "s"} at work · ${reporting} of ${vs.length} rigs reporting`,
        active: "overview",
      },
      `${tallies}
<div class="block" id="needs"><div class="head"><h2>Needs you</h2><span class="n">${feed.length}</span><span class="right">open one for its evidence and what each choice does</span></div>
${feed.length ? `<div class="dqs">${feed.map((n) => n.html).join("")}</div>` : `<div class="card"><div class="empty">Nothing waits for you. The campaigns go on by themselves.</div></div>`}</div>
<div class="block"><div class="head"><h2>At work</h2><span class="n">${running}</span></div>
${live.length ? live.join("") : `<div class="card"><div class="empty">${camps.length ? "No run is running." : "No campaign yet. Assign one to a rig through control's API or MCP."}</div></div>`}</div>
<div class="block"><div class="head"><h2>What happened</h2><span class="right">newest first</span></div>${activity}</div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- campaigns
  app.get("/ui/campaigns", (c) => {
    const now = Date.now();
    const vs = views();
    const camps = campaignViews(vs);
    // Each campaign in a sentence (its best run, what is at work, what waits), then its runs.
    const cards = camps
      .map((k) => {
        const h = headline(k);
        const live = k.runs.filter((x) => x.run.status === "running").length;
        const waiting = k.runs.reduce((n, x) => n + waitingOn(x.run), 0);
        const best = h.best;
        const said = [
          k.mode === "goal"
            ? best?.goals.length
              ? `Its best run meets ${best.goals.filter((g) => g.status === "met").length} of ${best.goals.length} goals.`
              : "The judge has not checked its goals yet."
            : k.mode === "hill_climb"
              ? `Its best run is ${esc(h.value)} over where it started.`
              : `${esc(h.value)} verified claims.`,
          live ? `${live} run${live === 1 ? " is" : "s are"} at work.` : "No run is at work.",
          waiting
            ? `<b class="warn">${waiting} decision${waiting === 1 ? " waits" : "s wait"} for you.</b>`
            : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<div class="card flat camp"><div class="camp-top">${modeAvatar(k.mode)}<div class="grow"><a class="camp-name" href="${campaignHref(k.name)}">${esc(k.name)}</a> <span class="muted small">${esc(modeName(k.mode))}</span><div class="small camp-said">${said}</div></div></div>${k.runs.map((x) => runRow(x.rig, x.run, now, "rig")).join("")}</div>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Campaigns",
        summary: `${camps.length} campaign${camps.length === 1 ? "" : "s"}; open one for its runs, lanes and attempts`,
        active: "campaigns",
        actions: opts.kits
          ? `<a class="btn primary" href="/ui/campaigns/new">New campaign</a>`
          : undefined,
      },
      cards ||
        `<div class="card"><div class="empty">No campaign yet.${opts.kits ? ` <a href="/ui/campaigns/new">Start one.</a>` : ""}</div></div>`,
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
      newCampaignBody({ csrf: csrf(c), rigs: views(), access: store.gitAccessList(), ...extra }),
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
  // The project's head at a ref and its paths (not its contents), for the page's suggestions.
  app.get("/ui/campaigns/new/probe", async (c) => {
    const url = c.req.query("url") ?? "";
    const ref = c.req.query("ref") || "HEAD";
    try {
      return c.json(
        await (opts.probeRepo ?? probeRepository)(url, ref, accessFor(c.req.query("access"))),
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
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
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
  /** An uploaded kit, unpacked again from its kept archive. */
  const uploaded = async (id: string) => {
    if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
    const p = join(uploadsDir(), id);
    if (!existsSync(p)) return undefined;
    return unpackKit(readFileSync(`${p}.name`, "utf8"), readFileSync(p));
  };
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
    const project = draft.project as { url?: string; ref?: string; commit?: string } | undefined;
    if (project?.url && !project.commit) {
      try {
        project.commit = (
          await (opts.probeRepo ?? probeRepository)(
            project.url,
            project.ref || "HEAD",
            accessFor((project as { access?: string }).access),
          )
        ).commit;
      } catch (err) {
        return newCampaignPage(c, {
          draft,
          errors: [`The project: ${err instanceof Error ? err.message : String(err)}`],
        });
      }
    }
    const promotion = String(f.promotion ?? "");
    const split = splitFor(rig, String(f.judge_gpus ?? ""));
    if (typeof split === "string") return newCampaignPage(c, { draft, errors: [split] });
    const uploadId = (draft.kit as { source?: string; upload?: string } | undefined)?.upload;
    const upload = uploadId ? await uploaded(uploadId).catch(() => undefined) : undefined;
    let r: ReturnType<typeof startCampaign>;
    try {
      r = startCampaign(
        {
          store,
          kits: opts.kits,
          privateKeyPem: opts.privateKeyPem,
          uploads: (id) => (id === uploadId ? upload?.files : undefined),
        },
        {
          draft,
          rig: rig.id,
          target: { type: target.type, class: target.class },
          start:
            String(f.start_value ?? "start") === "save"
              ? false
              : String(f.start_value) === "try"
                ? "try"
                : true,
          promotion: promotion === "auto" || promotion === "owner_approval" ? promotion : undefined,
          by: "owner:ui",
        },
      );
    } catch (err) {
      r = { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
    if (!r.ok) return newCampaignPage(c, { draft, errors: r.errors });
    if (r.run && split !== undefined) sendSplit(rig.id, split);
    return c.redirect(
      r.run
        ? `${campaignHref(r.campaign)}?run=${encodeURIComponent(runKey(rig.id, r.run))}`
        : campaignHref(r.campaign),
      303,
    );
  });

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
  const sendSplit = (rig: string, judge: number) =>
    issueCommand(store, opts.privateKeyPem, {
      rig,
      kind: "rig_settings",
      payload: { judge_gpus: judge },
      issuedBy: "owner:ui",
    });

  // ---------------------------------------------------------------- another run of a campaign
  /** The form that starts a run of a campaign created here: which rig, with or without agents. */
  const startRunCard = (c: Ctx, campaign: string, vs: RigView[], heading: string) => {
    const versions = store.campaignVersions(campaign);
    if (!versions.length || !opts.kits) return "";
    const want = (versions[0]?.contract as { target?: { type?: string } } | undefined)?.target
      ?.type;
    const rigOptions = vs
      .map((u) => {
        const t = u.hardware?.target?.type;
        const fits = !want || !t || t === want;
        return `<option value="${esc(u.id)}"${fits ? "" : " disabled"}>${esc(u.id)}${t ? ` · ${esc(t)}` : ""}${fits ? "" : " (other hardware)"}${u.stale ? " · not reporting" : ""}</option>`;
      })
      .join("");
    return `<div class="block"><div class="head"><h2>${esc(heading)}</h2><span class="right">version ${versions[0]?.version} · saved ${esc(ago(versions[0]?.created_at ?? "", Date.now()))} ago</span></div><div class="card"><form method="post" action="/ui/campaigns/${encodeURIComponent(campaign)}/runs" class="form-grid"><input type="hidden" name="csrf" value="${csrf(c)}">
<label>${infoLabel("Rig", "Where the run goes. Rigs whose hardware differs from the kit's are greyed out.")}<select name="rig">${rigOptions}</select></label>
<label>${infoLabel("Agents", "With agents: they propose changes and the judge measures each one. A try of the kit: no agents; the judge builds the starting point and runs every case on its own, so you see the kit work before anything else runs.")}<select name="agents"><option value="on">with agents</option><option value="off">a try of the kit: no agents</option></select></label>
<label>${infoLabel("When a change is confirmed better", "Keep it at once as the new best, or wait for you. The rig's default is set where the rig is deployed.")}<select name="promotion"><option value="">the rig's default</option><option value="auto">always keep it</option><option value="owner_approval">ask me every time</option></select></label>
<label>${infoLabel("GPUs for the judge", "For a rig with several GPUs: how many the judge measures on; the rest are the agents'. It changes the rig's split for every run on it, and the rig's harness restarts to apply it. Empty: the rig's current split.")}<input name="judge_gpus" inputmode="numeric" placeholder="the rig's current split"></label>
<div class="form-end"><button class="primary">Start the run</button></div></form>
<div class="nc-does"><b>What happens.</b> Control signs an assignment of version ${versions[0]?.version} to the rig; the rig fetches the project and the kit, checks both, and starts the run.</div></div></div>`;
  };
  app.post("/ui/campaigns/:campaign/runs", async (c) => {
    const f = await c.req.parseBody();
    const campaign = c.req.param("campaign");
    const vs = views();
    const rig = vs.find((u) => u.id === String(f.rig ?? ""));
    const back = (m: string) =>
      c.redirect(`${campaignHref(campaign)}?error=${encodeURIComponent(m)}`, 303);
    if (!opts.kits) return c.text("This control keeps no campaigns.", 404);
    if (!rig) return back("Choose a rig.");
    const promotion = String(f.promotion ?? "");
    const split = splitFor(rig, String(f.judge_gpus ?? ""));
    if (typeof split === "string") return back(split);
    let r: ReturnType<typeof startRun>;
    try {
      r = startRun(
        { store, kits: opts.kits, privateKeyPem: opts.privateKeyPem },
        {
          campaign,
          rig: rig.id,
          target: rig.hardware?.target
            ? { type: rig.hardware.target.type, class: rig.hardware.target.class }
            : undefined,
          agents: String(f.agents ?? "on") !== "off",
          promotion: promotion === "auto" || promotion === "owner_approval" ? promotion : undefined,
          by: "owner:ui",
        },
      );
    } catch (err) {
      r = { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
    if (!r.ok) return back(r.errors.join(" "));
    if (split !== undefined) sendSplit(rig.id, split);
    return c.redirect(
      `${campaignHref(campaign)}?run=${encodeURIComponent(runKey(rig.id, r.run))}`,
      303,
    );
  });

  app.get("/ui/campaigns/:campaign", (c) => {
    const now = Date.now();
    const vs = views();
    const name = c.req.param("campaign");
    const k = campaignViews(vs).find((x) => x.name === name);
    const failed = c.req.query("error");
    const note = failed
      ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not started.</b> ${esc(failed)}</div>`
      : "";
    if (!k) {
      // Saved on control, with no run reported yet: what was asked for, and a way to start one.
      const saved = store.campaignVersions(name);
      if (!saved.length)
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
      const title = (saved[0]?.contract as { title?: string } | undefined)?.title ?? name;
      return page(
        c,
        {
          title: name,
          crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
          summary: esc(title),
          active: "campaigns",
          refresh: waiting ? 5 : undefined,
        },
        `${note}${
          waiting
            ? `<div class="card" style="margin-bottom:16px"><b>Starting ${esc(waiting)}.</b> <span class="muted">The rig fetches the project and the kit and checks both; the run shows here once the rig reports it, usually within a minute.</span></div>`
            : `<div class="card" style="margin-bottom:16px"><div class="empty">Saved, with no run yet.</div></div>`
        }${startRunCard(c, name, vs, "Start a run")}`,
        vs,
      );
    }
    const st = campaignState(k);
    const rigs = rigList(k);
    const h = headline(k);
    // The selected run: from the link, else a running one, else the one that needs the owner.
    const urgent = ["Approval", "Decision", "Review", "Audit"];
    const sel =
      k.runs.find((x) => runKey(x.rig.id, x.run.id) === c.req.query("run")) ??
      k.runs.find((x) => x.run.status === "running") ??
      urgent
        .map((u) => k.runs.find((x) => runState(x.run).text === u))
        .find((x) => x !== undefined) ??
      (k.runs[0] as CampaignView["runs"][number]);
    const qv = c.req.query("view");
    const view: RunViewName =
      qv === "attempts" || qv === "steering" || qv === "history" ? qv : "overview";
    // Across runs: one row per run, then (goal campaigns) the goals by run.
    const board = leaderboard(store, { staleAfterMs: opts.staleAfterMs })[k.name] ?? [];
    const verified = new Map(board.map((r) => [runKey(r.rig, r.run), r.verified_by]));
    const gainOf = (i: RunView) =>
      (i.champion.filter((s) => !s.reopened).at(-1)?.cumulative ?? 1) - 1;
    const best = Math.max(0.0001, ...k.runs.map((x) => gainOf(x.run)));
    const winKind = k.mode === "goal" ? "goal_progress" : "win_confirmed";
    const summaryRows = k.runs
      .map(({ rig, run }) => {
        const on = rig.id === sel.rig.id && run.id === sel.run.id;
        const last = run.attempts.at(-1)?.updated_at;
        const v = verified.get(runKey(rig.id, run.id)) ?? [];
        const head =
          k.mode === "hill_climb"
            ? meter("", pct(gainOf(run), 1), gainOf(run) / best, "primary")
            : esc(runMetric(run));
        return `<tr${on ? ` class="on"` : ""}><td><a href="${runHref(rig.id, run)}"><b>${esc(run.id)}</b></a></td><td>${avatar(rig.id)} ${esc(rig.id)}${rig.stale ? ` <span class="bad xs">stale</span>` : ""}</td><td>${runStateHtml(run)}</td><td style="width:30%">${head}</td><td class="num">${run.attempts.length}</td><td class="num">${run.attempts.filter((a) => a.verdict === winKind).length}</td><td class="num muted">${last ? `${esc(ago(last, now))} ago` : ""}</td>${k.mode === "hill_climb" ? `<td>${v.length ? `<span class="pill ok">${icon.check}${esc(v.join(", "))}</span>` : `<span class="muted small">not yet</span>`}</td>` : ""}</tr>`;
      })
      .join("");
    const summary =
      k.runs.length > 1
        ? `<div class="card flat"><table><thead><tr><th>Run</th><th>Rig</th><th>State</th><th>${esc(h.sub.replace(" (best run)", ""))}</th><th class="num">Attempts</th><th class="num">${k.mode === "goal" ? "Progress" : "Wins"}</th><th class="num">Last attempt</th>${k.mode === "hill_climb" ? "<th>Cross-verified</th>" : ""}</tr></thead><tbody>${summaryRows}</tbody></table></div>`
        : "";
    const goalNames = [...new Set(k.runs.flatMap((x) => x.run.goals.map((g) => g.goal)))];
    const goalMatrix =
      k.mode === "goal" && k.runs.length > 1 && goalNames.length
        ? `<details class="card flat matrix" data-k="matrix-${esc(k.name)}" style="margin-top:12px"><summary>Goals by run <span class="muted small">which run's champion meets which goal</span></summary><table><thead><tr><th>Goal</th>${k.runs.map((x) => `<th class="goalcell">${esc(x.run.id)}</th>`).join("")}</tr></thead><tbody>${goalNames
            .map(
              (g) =>
                `<tr><td>${esc(g)}</td>${k.runs
                  .map((x) => {
                    const s2 = x.run.goals.find((y) => y.goal === g)?.status;
                    return s2 === "met"
                      ? `<td class="goalcell ok" title="met">✓</td>`
                      : s2 === "unmet"
                        ? `<td class="goalcell bad" title="unmet">✕</td>`
                        : `<td class="goalcell muted" title="${esc(s2 ?? "not validated")}">·</td>`;
                  })
                  .join("")}</tr>`,
            )
            .join("")}</tbody></table></details>`
        : "";
    const tabs =
      k.runs.length > 1
        ? `<nav class="tabs">${k.runs
            .map(({ rig, run }) => {
              const rs = runState(run);
              const on = rig.id === sel.rig.id && run.id === sel.run.id;
              return `<a class="${on ? "on" : ""}" href="${runHref(rig.id, run, view)}"><span class="dot ${rs.cls === "info" ? "ok" : rs.cls === "muted" ? "" : rs.cls}"></span>${esc(run.id)}<span class="sub">${esc(rig.id)}</span></a>`;
            })
            .join("")}</nav>`
        : "";
    return page(
      c,
      {
        title: k.name,
        crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
        summary: `${esc(modeName(k.mode))} · ${k.runs.length} run${k.runs.length > 1 ? "s" : ""} on ${esc(rigs.join(", "))} · <span class="${st.cls}">${esc(st.text)}</span> · ${esc(h.value)} ${esc(h.sub)}`,
        active: "campaigns",
      },
      `${note}${summary ? `<div class="block" style="margin-bottom:8px">${summary}${goalMatrix}</div>` : ""}${tabs}${
        /-try-\d+$/.test(sel.run.id)
          ? `<div class="card hl" style="margin-bottom:12px"><b>A try of the kit.</b> No agents work on this run: the judge builds the starting point and runs every case on its own. Its results are below. When they look right, start the campaign below.</div>`
          : ""
      }${runSection(c, sel.rig, sel.run, vs, now, view)}${startRunCard(c, k.name, vs, /-try-\d+$/.test(sel.run.id) ? "Start the campaign" : "Start another run")}`,
      vs,
    );
  });

  // ---------------------------------------------------------------- rigs (Magnesium's Fleet)
  app.get("/ui/rigs", (c) => {
    const now = Date.now();
    const vs = views();
    // Each rig: whether it reports, what it runs on, its judge, its checks, then its runs.
    const checks: [string, string][] = [
      ["model", "model route"],
      ["isolation", "isolation"],
      ["smoke", "judge smoke"],
    ];
    const cards = vs
      .map((u) => {
        const key = store.rigKey(u.id);
        const status = key.pending
          ? `<span class="chip warn">Key to accept</span>`
          : u.stale
            ? `<span class="chip bad">Not reporting</span>`
            : `<span class="chip ok">Live</span>`;
        const queued = u.judge.queued.length;
        const sup = u.supervisor as Record<string, unknown> | null;
        const ex =
          sup?.export && typeof sup.export === "object"
            ? (sup.export as Record<string, unknown>)
            : null;
        const said = [
          u.stale
            ? `<b class="bad">No report for ${esc(span(u.last_seen, now))}.</b>`
            : `Reported ${esc(ago(u.last_seen, now))} ago.`,
          u.judge.now
            ? `The judge is ${jobHtml(u, u.judge.now)}${queued ? `, with ${queued} more queued` : ""}.`
            : `The judge is idle${queued ? `, with ${queued} queued` : ""}.`,
          ex?.last_error
            ? `<span class="bad">Its last export failed: ${esc(clip(String(ex.last_error), 120))}</span>`
            : "",
        ]
          .filter(Boolean)
          .join(" ");
        const marks = checks
          .map(([k, name]) => {
            const r = u.checks[k];
            const [tone, mark, word] = !r
              ? ["", "·", "not run yet"]
              : r.finished_at === null
                ? ["info", "…", "running"]
                : r.ok
                  ? ["ok", "✓", `passed ${ago(r.finished_at, now)} ago`]
                  : ["bad", "✕", `failed ${ago(r.finished_at, now)} ago`];
            return `<span class="chip ${tone}" title="${esc(word)}">${mark} ${esc(name)}</span>`;
          })
          .join("");
        return `<div class="card flat camp"><div class="camp-top"><span class="iconbox">${icon.cpu}</span><div class="grow"><div><a class="camp-name" href="/ui/rigs/${encodeURIComponent(u.id)}">${esc(u.id)}</a> ${status} <span class="muted small">${hardwareLine(u.hardware)}</span></div><div class="small camp-said">${said}</div><div class="chips">${marks}</div></div></div>${u.runs.map((i) => runRow(u, i, now, "campaign")).join("") || `<div class="empty">No campaign assigned.</div>`}</div>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Rigs",
        summary: `${vs.length} rig${vs.length === 1 ? "" : "s"} · ${vs.filter((u) => u.stale).length} not reporting · ${vs.reduce((n, u) => n + u.runs.filter((i) => i.status === "running").length, 0)} runs at work`,
        actions: `<a class="btn primary" href="/ui/rigs/add">Add a rig</a>`,
        active: "rigs",
      },
      cards || `<div class="card"><div class="empty">No rig has reported yet.</div></div>`,
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
    const flashOk = c.req.query("ok");
    const flashError = c.req.query("error");
    const flash = flashError
      ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not done.</b> ${esc(flashError)}</div>`
      : flashOk
        ? `<div class="card" style="margin-bottom:16px"><b class="ok">${esc(flashOk)}</b></div>`
        : "";
    if (!u && onCluster)
      return page(
        c,
        {
          title: onCluster.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `on ${esc(onCluster.cluster)} · ${esc(onCluster.status)}`,
          active: "rigs",
          refresh: onCluster.status === "deploying" || onCluster.status === "starting" ? 5 : 15,
        },
        `<p class="run-said">Control is setting ${esc(onCluster.rig)} up on ${esc(onCluster.cluster)}. Its page fills in once the rig reports for the first time.</p>${flash}${clusterPlacedBlock(onCluster, csrf(c))}`,
        vs,
      );
    if (!u && joined) return joinedPage(c, joined, flash);
    if (!u && placed)
      return page(
        c,
        {
          title: placed.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `on ${esc(placed.machine)} · ${esc(placed.status)}`,
          active: "rigs",
          refresh: placed.status === "deploying" || placed.status === "starting" ? 5 : 15,
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
    const sup = u.supervisor as Record<string, unknown> | null;
    const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
    const ex = obj(sup?.export);
    const adv = sup?.advisors ? obj(sup.advisors) : null;
    const live = u.runs.filter((i) => i.status === "running");
    const runsNow = live
      .map((i) =>
        runBrief(store, u, i, now, { heading: true, detail: true, waiting: waitingOn(i) }),
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
      u.stale
        ? `<b class="bad">${esc(u.id)} has not reported for ${esc(span(u.last_seen, now))}.</b>`
        : `${esc(u.id)} is live; it reported ${esc(ago(u.last_seen, now))} ago.`,
      live.length
        ? `It runs ${live.map((i) => `<a href="${runHref(u.id, i)}">${esc(i.campaign || i.id)} › ${esc(i.id)}</a>`).join(" and ")}.`
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
    ]
      .filter(Boolean)
      .join(" ");
    const checkRows = checks
      .map(([k, name, what]) => {
        const r = u.checks[k];
        const res = !r
          ? `<span class="chip">not run yet</span>`
          : r.finished_at === null
            ? `<span class="chip info">running</span>`
            : r.ok
              ? `<span class="chip ok">passed</span>`
              : `<span class="chip bad">failed</span>`;
        const when = !r
          ? ""
          : r.finished_at === null
            ? `started ${esc(ago(r.started_at, now))} ago`
            : `${esc(ago(r.finished_at, now))} ago`;
        return `<div class="ck"><span class="ck-res">${res}</span><span class="ck-main"><span><b>${esc(name)}</b> <span class="muted small">${when}</span></span>${r?.finished_at && r.summary ? `<span class="ck-sum ${r.ok ? "" : "bad"}">${esc(r.summary)}</span>` : ""}<span class="ck-what">${esc(what)}</span></span>${cmdForm(c, { rig: u.id, kind: "rig_check", fields: { check: k }, label: r && r.finished_at === null ? "Running…" : "Run it", back })}</div>`;
      })
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
    const rigFacts = [
      ["Key", `<code>${esc(key.pubkey ? fingerprint(key.pubkey) : "not pinned")}</code>`],
      ["Ledger", `<code>${esc(u.ledger_id ?? "")}</code>`],
      ...(sup
        ? [
            [
              "Results",
              `${num(ex.exports)} exports${ex.remote === true ? ` · <span title="${esc(ex.last_push_at ?? "")}">pushed ${esc(ago(String(ex.last_push_at ?? ""), now) || "?")} ago</span>` : " · no results repository"}${ex.last_error ? `<div class="bad xs">${esc(String(ex.last_error).slice(0, 300))}</div>` : ""}`,
            ],
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
    const events = timeline(
      u.recent.map((e) => ({ u, e })),
      now,
      { limit: 12 },
    );
    const keyCard = key.pending
      ? `<div class="card warn" style="margin-bottom:16px"><div class="card-head">${icon.key}<span class="title">${key.pubkey ? "This rig now signs its reports with a different key" : "This rig's first report key waits for your acceptance"}</span></div>
<p class="small">Its reports are refused until you accept the key. A full reset keeps a rig's key: a change is expected only when the rig's identity was rebuilt on purpose. Check the fingerprint with the rig's deployment before accepting.</p>
<div class="row"><code>${esc(fingerprint(key.pending))}</code><span class="grow"></span><form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="fingerprint" value="${esc(fingerprint(key.pending))}"><button class="primary">Accept this key</button></form></div></div>`
      : "";
    const actions = `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Edit rig</a><a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/live">${icon.terminal}Live</a>
${cmdForm(c, { rig: u.id, kind: "export_now", label: "Export now", back })}
<details class="menu"><summary class="btn">${icon.dots}</summary><div class="menu-body">
${opts.driver ? `<form method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/restart"><input type="hidden" name="csrf" value="${t}"><button style="width:100%;justify-content:center">Restart the rig's containers</button></form>` : `<div class="muted small">No deployment driver: restarts are not available.</div>`}
<div class="divider" style="margin:2px 0"></div>
<form method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/reset" class="stack" style="gap:8px"><input type="hidden" name="csrf" value="${t}">
<div class="small"><b>Full reset.</b> <span class="muted">Pause, export, verify the push, then wipe after your confirmation.</span></div>
<input name="confirm" placeholder="type: reset ${esc(u.id)}"><button class="danger" style="justify-content:center">Start the full reset</button></form></div></details>`;
    return page(
      c,
      {
        title: u.id,
        crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
        summary: u.stale
          ? `<span class="bad">not reporting</span>`
          : `<span class="ok">live</span>`,
        actions,
        active: "rigs",
      },
      `<p class="run-said">${said}</p>
${flash}${keyCard}
${runsNow ? `<div class="block"><div class="head"><h2>At work</h2><span class="n">${live.length}</span></div>${runsNow}</div>` : ""}
<div class="cols run-cols"><div>
<div class="block"><div class="head"><h2>Checks</h2><span class="right">run by the rig itself; each result also goes to its history</span></div><div class="card flat">${checkRows}</div></div>
<div class="block"><div class="head"><h2>Runs on this rig</h2><span class="n">${u.runs.length}</span></div>${runRows ? `<div class="card flat">${runRows}</div>` : `<div class="card"><div class="empty">No campaign assigned.</div></div>`}</div>
<div class="block"><div class="head"><h2>The judge's last jobs</h2></div>${jobs ? `<div class="card flat tl">${jobs}</div>` : `<div class="card"><div class="empty">No job yet.</div></div>`}</div>
</div><div class="side">
<div class="block"><div class="head"><h2>What it runs on</h2></div>${h ? `<div class="card"><dl class="facts">${hw}</dl></div><details class="card flat matrix" data-k="hw-${esc(u.id)}" style="margin-top:10px"><summary>Every detail</summary>${hardwareCard(h, now)}</details>` : hardwareCard(h, now)}</div>
<div class="block"><div class="head"><h2>The rig</h2></div><div class="card"><dl class="facts">${rigFacts}</dl>${sup ? `<div class="muted xs" style="margin-top:8px">The supervisor reports its figures itself (unsigned).</div>` : ""}</div></div>
${placed ? placedBlock(placed, t) : ""}${onCluster ? clusterPlacedBlock(onCluster, t) : ""}${joined ? joinedBlock(joined, t, undefined, true) : ""}
<div class="block"><div class="head"><h2>Recent</h2><span class="right">newest first</span></div>${events}</div>
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
    const name = `${c.req.param("run")}-champion-${m[1]}-on-${p.base_commit.slice(0, 8)}.patch`;
    return c.body(new Uint8Array(p.patch), 200, {
      "content-type": "text/x-diff; charset=utf-8",
      "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
    });
  });

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
    const decision = needs(c, [u], now, back).find((n) => n.attempt === a.id);
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
          { href: campaignHref(r.campaign || r.id), text: r.campaign || r.id },
          { href: runHref(u.id, r), text: `${r.id} on ${u.id}` },
        ],
        active: "campaigns",
      },
      attemptDetail(u, r, a, now, { decision, patch }),
      vs,
    );
  });

  app.post("/ui/rigs/:rig/key/accept", async (c) => {
    const f = await c.req.parseBody();
    // Only the key whose fingerprint the owner saw: a key swapped in meanwhile is not accepted.
    store.acceptPendingKey(c.req.param("rig"), "owner:ui", String(f.fingerprint ?? ""));
    return c.redirect(`/ui/rigs/${encodeURIComponent(c.req.param("rig"))}`, 303);
  });

  // ---------------------------------------------------------------- live sessions (Magnesium's Session)
  app.get("/ui/live", (c) => {
    const vs = views();
    const now = Date.now();
    const rows = vs
      .map((u) => {
        const srcs = store.liveSources(u.id);
        return `<a class="card tight row" style="text-decoration:none" href="/ui/rigs/${encodeURIComponent(u.id)}/live"><span class="dot ${u.stale ? "bad" : "ok"}"></span><b>${esc(u.id)}</b><span class="muted small grow">${srcs.length ? `${srcs.length} sessions · last line ${esc(ago(srcs[0]?.last_at, now))} ago` : "no live lines yet"}</span>${icon.terminal}</a>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Live",
        summary: "what each rig's agents and judge are doing now",
        active: "live",
        refresh: 10,
      },
      rows
        ? `<div class="stack" style="max-width:720px">${rows}</div>`
        : `<div class="card"><div class="empty">No rig has reported yet.</div></div>`,
      vs,
    );
  });

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
    const ended = new Map(sources.map((x) => [x.source, x.ended]));
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
        ? `${HARNESSES[u.model.harness] ?? u.model.harness} · ${u.model.model} (from ${u.model.name})`
        : u.model.source === "environment"
          ? `${HARNESSES[u.model.harness] ?? u.model.harness} · ${u.model.model} (the rig's own settings)`
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
    // The composer: who can receive a message from here.
    const running = u.runs.filter((i) => i.status === "running");
    const inst = (sel?.run && u.runs.find((i) => i.id === sel.run)) || running[0] || u.runs[0];
    const targets: { to: string; label: string }[] = [];
    if (source.startsWith("trial:"))
      targets.push({ to: source, label: `this worker (${source.slice(6)})` });
    if (sel?.lane) targets.push({ to: sel.lane, label: `${sel.lane}: its running or next trial` });
    targets.push({ to: "planner", label: "the planner (next plan)" });
    for (let n = 1; n <= 4; n++)
      if (!targets.some((x) => x.to === `lane-${n}`))
        targets.push({ to: `lane-${n}`, label: `lane-${n}: its running or next trial` });
    targets.push({ to: "advisors", label: "the advisors (next brief)" });
    const composer =
      source === "judge"
        ? `<div class="composer off">The judge is code, not an agent: it takes no messages. That is what keeps agents from judging.</div>`
        : !inst
          ? `<div class="composer off">No campaign on this rig: nothing to message.</div>`
          : `<form class="composer" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/message"><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="source" value="${esc(source)}">
<textarea name="text" required maxlength="4000" placeholder="Message ${esc(targets[0]?.label ?? "an agent")}…  (⌘/Ctrl+Enter to send)"></textarea>
<div class="bar2"><select name="to">${targets.map((x) => `<option value="${esc(x.to)}">${esc(x.label)}</option>`).join("")}</select>
<select name="run">${u.runs.map((i) => `<option value="${esc(i.id)}"${i.id === inst.id ? " selected" : ""}>${esc(i.id)}</option>`).join("")}</select>
<span class="hint grow">A signed owner command. Workers get it after their current turn.</span><button class="primary" aria-label="Send">${icon.send}</button></div></form>`;
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
                  ? `<a href="${runHref(u.id, run)}">${esc(run.campaign || run.id)} › ${esc(run.id)}</a>`
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
        refresh: 0,
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
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
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
      .map((x) => {
        const cls =
          x.status === "delivered"
            ? "ok"
            : x.status === "pending"
              ? "info"
              : x.status === "expired" || x.status === "cancelled"
                ? ""
                : "bad";
        return `<tr><td class="muted nowrap">${esc(ago(x.issued_at, now))} ago</td><td>${esc(x.rig)}</td><td><b>${esc(x.kind.replace(/_/g, " "))}</b></td><td class="muted">${esc(x.issued_by)}</td><td><span class="chip ${cls}">${esc(x.status)}</span></td><td class="clip"><code class="muted">${esc(JSON.stringify(x.outcome ?? "").slice(0, 200))}</code></td></tr>`;
      })
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
    const rows = store
      .listAudit(300)
      .map(
        (x) =>
          `<tr><td class="muted nowrap">${esc(ago(x.at, now))} ago</td><td>${esc(x.actor)}</td><td><b>${esc(x.action.replace(/_/g, " "))}</b> <span class="muted xs">${esc(x.action)}</span></td><td class="clip"><code class="muted">${esc(JSON.stringify(x.body).slice(0, 200))}</code></td></tr>`,
      )
      .join("");
    return page(
      c,
      { title: "Audit log", summary: "who did what through control", active: "audit" },
      `<div class="card flat"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>`,
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
              `<tr><td class="muted">${n + 1}</td><td>${avatar(r.rig)} <a href="${runHref(r.rig, { id: r.run, campaign })}"><b>${esc(r.rig)}</b> / ${esc(r.run)}</a></td><td class="muted">seq ${r.champion_seq}</td><td>${meter("", pct(r.gain, 2), r.gain / best, "primary")}</td>
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
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  app.post("/ui/resets/:id/cancel", (c) => {
    try {
      cancelReset(store, Number(c.req.param("id")), "owner:ui");
    } catch (err) {
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
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
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
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
    if (!opts.driver) return c.text("no deployment driver is configured", 409);
    store.audit("owner:ui", "restart", { rig });
    try {
      await opts.driver.restart(rig, ["harness", "supervisor"]);
    } catch (err) {
      return c.text(`restart failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    return c.redirect(`/ui/rigs/${encodeURIComponent(rig)}`, 303);
  });

  app.post("/ui/rigs/:rig/reset", async (c) => {
    const rig = c.req.param("rig");
    const f = await c.req.parseBody();
    if (String(f.confirm ?? "") !== `reset ${rig}`)
      return c.text(`type "reset ${rig}" to confirm a full reset`, 400);
    try {
      store.createReset(rig, "owner:ui");
      await advanceResets({
        store,
        privateKeyPem: opts.privateKeyPem,
        driver: opts.driver,
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  // ---------------------------------------------------------------- settings: model providers
  // A provider is entered once: its name, type, base URL and API key. Control lists its models from
  // the provider itself, and the owner gives each rig one of them. Control seals each key (its
  // secret box) and never shows it again; a rig receives a provider's key only when it is given
  // one of its models, through its supervisor's authenticated channel.
  const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const TYPES: Record<ProviderType, string> = {
    openai: "OpenAI-compatible",
    anthropic: "Anthropic",
    opencode: "OpenCode",
    claude: "Claude subscription",
  };
  /** The types reached with an API key (a subscription is added differently). */
  const KEY_TYPES: ProviderType[] = ["openai", "anthropic", "opencode"];
  const HARNESSES: Record<Harness, string> = {
    pi: "Pi",
    opencode: "OpenCode v2",
    "claude-code": "Claude Code",
  };
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

  app.get("/ui/settings", (c) => {
    const now = Date.now();
    const vs = views();
    const t = csrf(c);
    const providers = store.providers();
    const gitCount =
      store.gitAccessList().length +
      store.machines().length +
      store.clusters().length +
      store.gpuClouds().length;
    const given = store.rigModels();
    const usersOf = (name: string) =>
      Object.entries(given)
        .filter(([, g]) => g.provider === name)
        .map(([rig]) => rig);
    const ok = c.req.query("ok");
    const error = c.req.query("error");
    const note = error
      ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not done.</b> ${esc(error)}</div>`
      : ok
        ? `<div class="card" style="margin-bottom:16px"><b class="ok">${esc(ok)}</b></div>`
        : "";
    /** A subscription's latest usage windows, as its rigs' runtime reported them. */
    const usageOf = (name: string) => {
      type W = { utilization: number; resets_at: string };
      let best: { five_hour?: W; seven_day?: W; at: string; rig: string } | undefined;
      for (const u of vs) {
        const r = (u.summary as { subscription_usage?: { provider?: string; at?: string } } | null)
          ?.subscription_usage;
        if (r?.provider === name && r.at && (!best || r.at > best.at))
          best = { ...(r as { five_hour?: W; seven_day?: W; at: string }), rig: u.id };
      }
      return best;
    };
    const bar = (label: string, w: { utilization: number; resets_at: string } | undefined) =>
      w
        ? `<div><div class="small"><b>${esc(label)}</b> · ${Math.round(w.utilization * 100)}% used · resets ${esc(w.resets_at.slice(0, 16).replace("T", " "))} UTC</div><div class="ubar${w.utilization >= 0.8 ? " warn" : ""}"><div style="width:${Math.min(100, Math.round(w.utilization * 100))}%"></div></div></div>`
        : "";
    /** A Claude subscription: its token's hint, its models, what its rigs report of its usage. */
    const claudeRow = (p: (typeof providers)[number], rigs: string[]) => {
      const pName = encodeURIComponent(p.name);
      const use = usageOf(p.name);
      const windows = use
        ? `<div class="use">${bar("5-hour window", use.five_hour)}${bar("Weekly window", use.seven_day)}</div><div class="muted small" style="margin-top:4px">As Claude Code on ${esc(use.rig)} reported it ${esc(ago(use.at, now))} ago. When a window is full, the agents on this subscription wait for its reset; nothing pays for more.</div>`
        : `<div class="muted small">No usage reported yet: Claude Code on a rig reports the 5-hour and weekly windows once an agent uses this subscription.</div>`;
      return `<details class="dq" data-k="provider-${esc(p.name)}"><summary>
<span class="dq-kind"><span class="kind m">Subscription</span></span>
<span class="dq-main"><span class="dq-head">${esc(p.name)} <span class="muted" style="font-weight:400">· Claude subscription</span></span><span class="dq-why">${p.models.length} models · runs only in Claude Code, Anthropic's own program</span><span class="dq-sub"><span class="chip">token ${esc(p.key_hint)}</span><span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
</summary><div class="dq-body">${windows}
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
    const providerRows = providers
      .map((p) => {
        const rigs = usersOf(p.name);
        if (p.type === "claude") return claudeRow(p, rigs);
        const status = p.models_error
          ? `<span class="dq-why bad">${esc(p.models_error)}${p.models.length ? ` (keeping its last list of ${p.models.length})` : ""}</span>`
          : `<span class="dq-why">${p.models.length} model${p.models.length === 1 ? "" : "s"}${p.models_at ? ` · listed ${esc(ago(p.models_at, now))} ago` : ""}</span>`;
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
<label>${infoLabel("Type", `${TYPE_TIP} Git access lets rigs fetch private repositories: a deploy key control makes, or an HTTPS token you paste.`)}<select name="type" id="ptype"><optgroup label="Models by API key">${KEY_TYPES.map((x) => `<option value="${x}">${x === "opencode" ? "OpenCode (its own models)" : TYPES[x]}</option>`).join("")}</optgroup><optgroup label="Subscriptions"><option value="claude">Claude subscription (Pro or Max)</option></optgroup><optgroup label="Git access"><option value="gitkey">A deploy key (control makes it)</option><option value="gittoken">An access token (HTTPS)</option></optgroup><optgroup label="Where rigs run"><option value="ssh">A machine over SSH</option><option value="k8s">A Kubernetes cluster</option><option value="runpod">RunPod (a GPU cloud)</option></optgroup></select></label>
<label>${infoLabel("Name", "How it shows in Thermite, and how rigs and campaigns refer to it: for example my-litellm or github-deploy. Lowercase letters, digits, dots and dashes.")}<input name="name" required maxlength="64" placeholder="for example my-litellm"></label>
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
<label data-for="runpod" hidden>${infoLabel("RunPod API key", "A key from RunPod's console (Settings, API Keys). Control seals it at once and never shows it again. For now control only reads with it; a read-only key is enough.")}<input name="runpod_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again"></label>
<label data-for="ssh" hidden style="grid-column:1/-1">${infoLabel("Private key", "The SSH private key for that user, without a passphrase. Control seals it at once and never shows it again. Leave it empty and control makes a key: add its public half, shown next, to the user's ~/.ssh/authorized_keys on the machine.")}<textarea name="private_key" class="mono" rows="4" maxlength="16384" placeholder="empty: control makes a key"></textarea></label>
<div class="nc-does" id="pdo" style="grid-column:1/-1"><b>What happens.</b> ${ADD_SAYS.openai[1]}</div>
<div class="form-end"><button class="primary" id="padd">${ADD_SAYS.openai[0]}</button></div></form>`;
    const options = (want: { provider: string; model: string } | undefined) =>
      `<option value=""${want ? "" : " selected"}>its own settings</option>${providers
        .filter((p) => p.models.length)
        .map(
          (p) =>
            `<optgroup label="${esc(p.name)}${p.type === "claude" ? " (Claude subscription: runs in Claude Code)" : p.type === "opencode" ? " (OpenCode harness only)" : isOpencodeOwn(p) ? " (free models: OpenCode harness only)" : ""}">${p.models
              .map(
                (m) =>
                  `<option value="${esc(`${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`)}"${want?.provider === p.name && want.model === m.id ? " selected" : ""}>${p.type === "claude" ? "claude-code:" : ""}${esc(m.id)}</option>`,
              )
              .join("")}</optgroup>`,
        )
        .join("")}`;
    const rigRows = vs
      .map((u) => {
        const m = u.model;
        const want = given[u.id];
        const uses = !m
          ? "Its harness does not report its model (it needs a newer image)."
          : m.source === "control"
            ? `Its agents run under ${HARNESSES[m.harness]} with ${m.model} from ${m.name}.`
            : m.source === "environment"
              ? `Its agents use the rig's own settings (${m.model}, under ${HARNESSES[m.harness]}).`
              : "Its agents have no model: they wait.";
        const moving =
          m &&
          want &&
          !(
            m.source === "control" &&
            m.name === want.provider &&
            m.model === want.model &&
            m.harness === want.harness
          )
            ? ` <span class="chip info">taking ${esc(want.model)} under ${esc(HARNESSES[want.harness])}</span>`
            : m && !want && m.source === "control"
              ? ` <span class="chip info">going back to its own settings</span>`
              : "";
        const chk = u.checks.model;
        const checked = !chk
          ? "Its model check has not run."
          : chk.finished_at === null
            ? "Its model check is running."
            : `Its model check ${chk.ok ? "passed" : "FAILED"} ${ago(chk.finished_at, now)} ago: ${chk.summary ?? ""}`;
        return `<div class="ck rr-route"><span class="ck-res"><a href="/ui/rigs/${encodeURIComponent(u.id)}"><b>${esc(u.id)}</b></a></span><span class="ck-main"><span>${esc(uses)}${moving}</span><span class="ck-sum ${chk?.finished_at && !chk.ok ? "bad" : ""}">${esc(checked)}</span></span><span class="route-acts"><form class="inline" method="post" action="/ui/settings/rigs"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="rig" value="${esc(u.id)}"><select name="harness" class="harness" aria-label="harness for ${esc(u.id)}">${(Object.keys(HARNESSES) as Harness[]).map((h) => `<option value="${h}"${(want?.harness ?? "pi") === h ? " selected" : ""}>${HARNESSES[h]}</option>`).join("")}</select><select name="choice" aria-label="model for ${esc(u.id)}">${options(want)}</select><button>Use</button></form>${cmdForm(c, { rig: u.id, kind: "rig_check", fields: { check: "model" }, label: "Check", back: "/ui/settings" })}</span></div>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Providers",
        active: "settings",
        crumbs: [{ href: "/ui/settings", text: "Settings" }],
      },
      `<p class="run-said">Providers are what Thermite uses: model providers serve the agents' models, Git access lets rigs fetch private repositories, and machines, clusters and GPU clouds are where rigs run. Add each once with its key. Control seals every key, never shows it again, and gives a rig only what it uses. Then choose, for each rig, the harness its agents run in (Pi or OpenCode v2) and their model.</p>
${note}
<div class="block"><div class="head"><h2>Providers</h2><span class="n">${providers.length + gitCount}</span><span class="right">models are read from each provider itself</span></div>${providers.length + gitCount ? `<div class="dqs">${providerRows}${gitRows(t)}${machineRows(t)}${clusterRows(t)}${cloudRows(t)}</div>` : `<div class="card"><div class="empty">No provider yet: add one below.</div></div>`}</div>
<div class="block"><div class="head"><h2>Add a provider</h2></div><div class="card">${addForm}</div></div>
<div class="block"><div class="head"><h2>Harness and model for each rig</h2><span class="right">a rig takes a change within a minute; then check it</span></div><div class="card flat">${rigRows || `<div class="empty">No rig has reported yet.</div>`}</div></div>
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
      const why = err instanceof Error ? err.message : String(err);
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
          rigsHere.length
            ? `<div class="muted small" style="margin-top:10px">In use by ${rigsHere.map((r) => esc(r.rig)).join(", ")}: remove those rigs before deleting it.</div>`
            : `<div style="margin-top:10px">${form("delete", "Delete this cluster", "sm danger")}</div>`
        }</div></details>`;
      })
      .join("");
  const addCluster = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = String(f.name ?? "").trim();
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
      return fail(err instanceof Error ? err.message : String(err));
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
      const why = err instanceof Error ? err.message : String(err);
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
        const facts = f
          ? `<dl class="facts"><dt>Pods</dt><dd>${
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
<span class="dq-main"><span class="dq-head">${esc(g.name)} <span class="muted" style="font-weight:400">· RunPod</span></span>${status}<span class="dq-sub"><span class="chip">key ${esc(g.key_hint)}</span><span class="chip info">control only reads: it starts nothing</span>${running.length ? `<span class="chip warn">${running.length} pod${running.length === 1 ? "" : "s"} running: billed while they run</span>` : ""}</span></span>
<span class="dq-side"><span class="dq-btns">${form("check", "Read again")}</span></span>
</summary><div class="dq-body">${facts}
<form method="post" action="/ui/settings/clouds/${gName}/key" class="form-grid" autocomplete="off" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("New API key", "Control seals the new key, reads the account with it, and forgets the old one.")}<input name="runpod_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the key ending ${esc(g.key_hint)}"></label><div class="form-end"><button>Replace the key</button></div></form>
<div style="margin-top:10px">${form("delete", "Delete this GPU cloud", "sm danger")} <span class="muted small">Control forgets the key. Nothing at RunPod changes.</span></div></div></details>`;
      })
      .join("");
  const addRunpod = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = String(f.name ?? "").trim();
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
      return fail(`Not added: ${err instanceof Error ? err.message : String(err)}.`);
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
      return c.redirect(
        settingsUrl(
          "error",
          `Kept the old key: ${err instanceof Error ? err.message : String(err)}.`,
        ),
        303,
      );
    }
    return c.redirect(settingsUrl("ok", `"${name}" has its new key, and is read again.`), 303);
  });
  app.post("/ui/settings/clouds/:name/delete", (c) => {
    const name = c.req.param("name");
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
  const STEP_WORDS: Record<string, string> = {
    enrolled: "Enrolled with control: a token of its own",
    deployed: "Files and units written, images ready, services started",
    first_report: "First report reached control",
    deploy: "Setting it up",
    stop: "Stopped",
    start: "Started",
    restart: "Restarted",
    remove: "Removed from the machine",
    applied: "Its objects applied in the cluster: namespace, secret, volume, deployments",
    remove_cluster: "Removed from the cluster",
    join_made: "Join command made",
    join_revoked: "Join command revoked",
    join_used: "Join command used: the rig fetched its files from control",
    retired: "Retired: its token no longer works",
  };
  /** Waits for a new rig's first report, for at most 10 minutes; a setup event either way. */
  const awaitFirstReport = async (rig: string, setStatus: (s: string) => void, minutes = 10) => {
    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() < deadline) {
      if (views().some((u) => u.id === rig)) {
        store.rigSetupEvent(rig, "first_report", true);
        setStatus("running");
        return;
      }
      await sleep(5000);
    }
    store.rigSetupEvent(
      rig,
      "first_report",
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
    const j = judge ?? Math.ceil(n / 2);
    return `${j} for the judge, ${n - j} for the agents`;
  };
  /** Which of a machine rig's GPUs are the judge's (the first ones) and which the agents'. */
  const gpuRoles = (gpus: number[], judge?: number | undefined) =>
    gpus
      .map((g, i) =>
        gpus.length < 2
          ? `GPU ${g} (shared)`
          : `GPU ${g} (${i < (judge ?? Math.ceil(gpus.length / 2)) ? "judge" : "agents"})`,
      )
      .join(", ");
  /** The judge's share of `n` GPUs from a form field: a number from 1 to n-1, or the default. */
  const judgeShare = (raw: string, n: number): number | string | undefined => {
    if (n < 2) return undefined;
    if (!raw) return Math.ceil(n / 2);
    const j = Number(raw);
    if (!Number.isInteger(j) || j < 1 || j > n - 1 || j > 8 || n - j > 8)
      return `With ${n} GPUs the judge takes 1 to ${Math.min(8, n - 1)} of them, and the agents at most 8.`;
    return j;
  };
  /** A rig control set up on a cluster: where, its setup history, and its controls. */
  const clusterPlacedBlock = (r: ClusterRig, t: string) => {
    const rName = encodeURIComponent(r.rig);
    const act = (action: string, label: string, extra = "", cls = "sm") =>
      `<form class="inline" method="post" action="/ui/rigs/${rName}/cluster/${action}"><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
    const s = r.spec;
    const manage =
      r.status === "removed" || r.status === "deploying"
        ? ""
        : `<div class="act" style="margin-top:10px">${r.status === "stopped" ? act("start", "Start its pods") : act("stop", "Stop its pods")}${act("restart", "Restart them")}</div>
<details style="margin-top:8px"><summary class="small">Remove it from ${esc(r.cluster)}</summary><div class="small muted" style="margin:6px 0">${r.placement === "created" ? "Deletes its namespace, with everything in it," : "Deletes its deployments, service, volume claim and secret from the slot,"} and retires its token. Results it has not exported are lost.</div>${act("remove", "Remove the rig", `<input name="confirm" placeholder="type: remove ${esc(r.rig)}" style="margin-right:6px">`, "sm danger")}</details>`;
    return `<div class="block"><div class="head"><h2>Set up by control</h2><span class="right">${esc(r.status)}</span></div><div class="card"><dl class="facts"><dt>Cluster</dt><dd><a href="/ui/settings">${esc(r.cluster)}</a> (Providers)</dd><dt>Namespace</dt><dd>${esc(r.namespace)} <span class="muted">(${r.placement === "created" ? "made by control" : "a slot"})</span></dd><dt>GPUs</dt><dd>${s.gpus ? `${s.gpus} through ${s.gpuMode === "dra" ? `DRA (${esc(s.deviceClass ?? "")})` : "NVIDIA's device plugin"}: ${splitWords(s.gpus, s.judgeGpus)}` : "none: it measures on the CPU"}${s.node ? ` · on ${esc(s.node)}` : ""}</dd><dt>Storage</dt><dd>${s.storageGi} GB${s.storageClass ? ` · ${esc(s.storageClass)}` : ""}</dd><dt>Images</dt><dd class="mono small">${esc(s.images.harness)}<br>${esc(s.images.supervisor)}</dd></dl>
<div class="tl" style="margin-top:10px">${setupSteps(r.rig) || `<div class="muted small">No step yet.</div>`}</div>${manage}</div></div>`;
  };
  /** Sets a rig up on a cluster, in the background: one apply, then the first report. */
  const deployClusterRig = async (
    r: ClusterRig,
    k: Cluster & { kubeconfig_sealed: string },
    controlToken: string,
  ) => {
    try {
      const objects = clusterRigObjects(
        {
          rig: r.rig,
          placement: r.placement,
          namespace: r.namespace,
          controlUrl: opts.publicUrl ?? "",
          images: r.spec.images,
          gpus: r.spec.gpus,
          judgeGpus: r.spec.judgeGpus,
          gpuMode: r.spec.gpuMode,
          deviceClass: r.spec.deviceClass,
          node: r.spec.node,
          storageClass: r.spec.storageClass,
          storageGi: r.spec.storageGi,
          controlPublicKey,
        },
        { controlToken, harnessSupervisorToken: newToken().token },
      );
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
      store.rigSetupEvent(r.rig, "deploy", false, err instanceof Error ? err.message : String(err));
      store.setClusterRigStatus(r.rig, "failed");
      return;
    }
    await awaitFirstReport(r.rig, (s) => store.setClusterRigStatus(r.rig, s));
  };
  /** A rig control set up: where, its setup history, and stop, start, restart and remove. */
  const placedBlock = (r: MachineRig, t: string) => {
    const rName = encodeURIComponent(r.rig);
    const steps = setupSteps(r.rig);
    const act = (action: string, label: string, extra = "", cls = "sm") =>
      `<form class="inline" method="post" action="/ui/rigs/${rName}/machine/${action}"><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
    const manage =
      r.status === "removed" || r.status === "deploying"
        ? ""
        : `<div class="act" style="margin-top:10px">${r.status === "stopped" ? act("start", "Start its services") : act("stop", "Stop its services")}${act("restart", "Restart them")}</div>
<details style="margin-top:8px"><summary class="small">Remove it from ${esc(r.machine)}</summary><div class="small muted" style="margin:6px 0">Stops its services and deletes its units, files and volumes on the machine, and retires its token. Results it has not exported are lost.</div>${act("remove", "Remove the rig", `<input name="confirm" placeholder="type: remove ${esc(r.rig)}" style="margin-right:6px">`, "sm danger")}</details>`;
    return `<div class="block"><div class="head"><h2>Set up by control</h2><span class="right">${esc(r.status)}</span></div><div class="card"><dl class="facts"><dt>Machine</dt><dd><a href="/ui/settings">${esc(r.machine)}</a> (Providers)</dd><dt>GPUs</dt><dd>${r.gpus.length ? gpuRoles(r.gpus, r.judge_gpus) : "none: it measures on the CPU"}</dd><dt>Images</dt><dd class="mono small">${esc(r.images.harness)}<br>${esc(r.images.supervisor)}</dd></dl>
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
      store.rigSetupEvent(r.rig, "deploy", false, err instanceof Error ? err.message : String(err));
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
<label class="fd">${infoLabel("Volume size (GB)", "The rig's volume: builds and model files can be large.")}<input name="k_size__${kn}" value="100"></label>
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
      { title: "Add a rig", crumbs: [{ href: "/ui/rigs", text: "Rigs" }], active: "rigs" },
      `<p class="run-said">Choose where the rig runs. On a machine or cluster control knows, control connects with the credentials you gave it once, writes the rig's files and services, starts it and looks after it: stop, start, restart, remove. Where control can't connect, you run one command it gives you.</p>
${error ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not created.</b> ${esc(error)}</div>` : ""}${blocked ? `<div class="card warn" style="margin-bottom:16px">${esc(blocked)}</div>` : ""}
<form id="add-rig" method="post" action="/ui/rigs/add" autocomplete="off"><input type="hidden" name="csrf" value="${t}">
<div class="sec"><h2>1 · Where</h2><p class="lead">A machine or a cluster control knows. They are added, checked and prepared under <a href="/ui/settings">Settings › Providers</a>.</p>
<div class="stack">${cards}${clusterCards}${cards || clusterCards ? "" : `<div class="card"><div class="empty">No machine or cluster yet.</div></div>`}<a class="ch" href="/ui/settings"><span><b>+ A new machine or cluster</b><br><span class="muted small">A Linux machine control can reach with an SSH key, or a Kubernetes cluster through a kubeconfig. Add it in Providers, then come back.</span></span></a></div>
<p class="lead" style="margin-top:14px">Or run it yourself, where control can't connect:</p><div class="stack">${joinCards}</div></div>
<div class="sec"><h2>2 · GPUs and resources</h2><p class="lead">As control last read the place. One GPU is shared by the judge and the agents. With more, some are the judge's and the rest the agents': half each by default, and on a machine the lowest-numbered GPUs are the judge's.</p>${gpuLists}<label class="fd" id="judge-pick" hidden style="max-width:280px;margin-top:10px">${infoLabel("GPUs for the judge", "How many of the chosen GPUs the judge measures on: the lowest-numbered ones. The rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. Default: half, rounded up.")}<input name="judge_gpus" inputmode="numeric" maxlength="2" placeholder="half"></label>${clusterSections}${joinSections}<div class="nc-does" id="gpu-note"></div></div>
<div class="sec"><h2>3 · Name and start</h2><div class="g3">
<label class="fd">${infoLabel("Rig name", "The rig's name in Thermite: lowercase letters, digits and dashes. It names the rig's runs, history and files, so it can't change later.")}<input name="rig" required maxlength="63" placeholder="gpu-box-1-a"></label>
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
    if (!RIG_NAME.test(rig)) return fail("A rig's name is lowercase letters, digits and dashes.");
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
    void deployRig(r, m, token.token).catch(() => {});
    return c.redirect(`/ui/rigs/${encodeURIComponent(rig)}`, 303);
  });
  /** Add a rig on a cluster: checks the choices, enrolls the rig, then applies its objects. */
  const addClusterRigFrom = async (
    c: Ctx,
    f: Record<string, unknown>,
    rig: string,
    name: string,
    fail: (why: string) => Response,
  ) => {
    const k = store.cluster(name);
    const one = (key: string) => {
      const v = f[`${key}__${name}`];
      return String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
    };
    if (!opts.rigImages) return fail("Control has no rig images configured.");
    if (!opts.publicUrl) return fail("Control's address for rigs is not set.");
    if (!RIG_NAME.test(rig)) return fail("A rig's name is lowercase letters, digits and dashes.");
    if (rigTaken(rig)) return fail(`There is a rig named ${rig} already.`);
    if (!k) return fail("Choose a machine or a cluster.");
    const facts = k.facts as ClusterFacts | null;
    if (!facts || k.check_error) return fail(`${k.name} is not ready: check it under Providers.`);
    const gpus = Number(one("k_gpus") || "0");
    if (!Number.isInteger(gpus) || gpus < 0 || gpus > MAX_RIG_GPUS)
      return fail(`A rig takes from none to ${MAX_RIG_GPUS} GPUs.`);
    const judgeGpus = judgeShare(one("k_judge"), gpus);
    if (typeof judgeGpus === "string") return fail(judgeGpus);
    // Control checks only what it could see: a slot's role may not list nodes, classes or storage.
    const mode = one("k_mode") || "device-plugin";
    const deviceClass = mode.startsWith("dra:")
      ? mode.slice(4)
      : mode === "dra"
        ? one("k_class")
        : undefined;
    if (gpus && mode === "dra" && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(deviceClass ?? ""))
      return fail("Name the DRA device class, such as gpu.nvidia.com.");
    if (gpus && mode.startsWith("dra:") && !facts.device_classes.includes(deviceClass ?? ""))
      return fail(`${k.name} has no DRA device class ${deviceClass}.`);
    if (gpus && !deviceClass && facts.nodes.length && !facts.nodes.some((n) => n.gpus >= gpus))
      return fail(
        `No node of ${k.name} offers ${gpus} GPU${gpus === 1 ? "" : "s"} through the device plugin.`,
      );
    const node = one("k_node") || undefined;
    if (node && !facts.nodes.some((n) => n.name === node))
      return fail(`${k.name} has no node ${node} that control can see.`);
    const storageClass = one("k_storage") || undefined;
    if (
      storageClass &&
      facts.storage_classes.length &&
      !facts.storage_classes.some((s) => s.name === storageClass)
    )
      return fail(`${k.name} has no storage class ${storageClass}.`);
    if (storageClass && !NS.test(storageClass)) return fail("That is not a storage class name.");
    const storageGi = Number(one("k_size") || "100");
    if (!Number.isInteger(storageGi) || storageGi < 1 || storageGi > 10_000)
      return fail("The volume size is a whole number of GB, from 1 to 10000.");
    let namespace: string;
    if (k.placement === "slot") {
      namespace = one("k_slot");
      if (!facts.slots.some((s) => s.namespace === namespace && s.usable && !s.used_by))
        return fail("Choose a free slot.");
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
    if (gpus && !opts.rigImages.harnessCuda)
      return fail(
        "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).",
      );
    const token = newToken();
    store.enrollRig(rig, token.sha256, "owner:ui");
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
        images: {
          harness: gpus ? (opts.rigImages.harnessCuda as string) : opts.rigImages.harness,
          supervisor: opts.rigImages.supervisor,
        },
      },
      created_by: "owner:ui",
    });
    store.rigSetupEvent(rig, "enrolled", true);
    void deployClusterRig(store.clusterRig(rig) as ClusterRig, k, token.token).catch(() => {});
    return c.redirect(`/ui/rigs/${encodeURIComponent(rig)}`, 303);
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
        refresh: token ? 3600 : r.status === "joining" ? 5 : 30,
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
    if (!RIG_NAME.test(rig)) return fail("A rig's name is lowercase letters, digits and dashes.");
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
    void awaitFirstReport(rig, (st) => store.setJoinedRig(rig, { status: st }), 60).catch(() => {});
    return c.text(body, 200, { "cache-control": "no-store" });
  });

  app.post("/ui/rigs/:rig/cluster/:action", async (c) => {
    const r = store.clusterRig(c.req.param("rig"));
    const action = c.req.param("action");
    const back = (k: "ok" | "error", msg: string) =>
      c.redirect(
        `/ui/rigs/${encodeURIComponent(c.req.param("rig"))}?${k}=${encodeURIComponent(msg)}`,
        303,
      );
    if (!r || r.status === "removed") return back("error", "Control didn't set this rig up.");
    if (!["stop", "start", "restart", "remove"].includes(action))
      return back("error", "No such action.");
    const f = await c.req.parseBody();
    if (action === "remove" && String(f.confirm ?? "").trim() !== `remove ${r.rig}`)
      return back("error", `Type "remove ${r.rig}" to remove it.`);
    const k = store.cluster(r.cluster);
    if (!k) return back("error", `The cluster ${r.cluster} is no longer in Providers.`);
    const sel = `app.kubernetes.io/instance=${r.rig}`;
    const runs: string[][] =
      action === "stop" || action === "start"
        ? [
            [
              "scale",
              "deployment",
              "-n",
              r.namespace,
              "-l",
              sel,
              `--replicas=${action === "stop" ? 0 : 1}`,
            ],
          ]
        : action === "restart"
          ? [["rollout", "restart", "deployment", "-n", r.namespace, "-l", sel]]
          : r.placement === "created"
            ? [["delete", "namespace", r.namespace, "--wait=false", "--ignore-not-found"]]
            : [
                [
                  "delete",
                  "deployment,service,persistentvolumeclaim,secret",
                  "-n",
                  r.namespace,
                  "-l",
                  sel,
                  "--ignore-not-found",
                ],
                [
                  "delete",
                  "resourceclaimtemplates",
                  "-n",
                  r.namespace,
                  "-l",
                  sel,
                  "--ignore-not-found",
                ],
              ];
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
        return back("error", kubeError(out));
      }
    }
    const step = action === "remove" ? "remove_cluster" : action;
    store.rigSetupEvent(r.rig, step, true);
    store.setClusterRigStatus(
      r.rig,
      action === "stop" ? "stopped" : action === "remove" ? "removed" : "running",
    );
    if (action === "remove") store.retireRig(r.rig, "owner:ui");
    store.audit("owner:ui", `cluster_rig_${action}`, { rig: r.rig, cluster: r.cluster });
    return back("ok", `${STEP_WORDS[step]}.`);
  });
  app.post("/ui/rigs/:rig/machine/:action", async (c) => {
    const r = store.machineRig(c.req.param("rig"));
    const action = c.req.param("action") as RigAction;
    const back = (k: "ok" | "error", msg: string) =>
      c.redirect(
        `/ui/rigs/${encodeURIComponent(c.req.param("rig"))}?${k}=${encodeURIComponent(msg)}`,
        303,
      );
    if (!r || r.status === "removed") return back("error", "Control didn't set this rig up.");
    if (!["stop", "start", "restart", "remove"].includes(action))
      return back("error", "No such action.");
    const f = await c.req.parseBody();
    if (action === "remove" && String(f.confirm ?? "").trim() !== `remove ${r.rig}`)
      return back("error", `Type "remove ${r.rig}" to remove it.`);
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
      const why = err instanceof Error ? err.message : String(err);
      store.rigSetupEvent(r.rig, action, false, why);
      return back("error", why);
    }
    store.rigSetupEvent(r.rig, action, true);
    store.setMachineRigStatus(
      r.rig,
      action === "stop" ? "stopped" : action === "remove" ? "removed" : "running",
    );
    if (action === "remove") store.retireRig(r.rig, "owner:ui");
    store.audit("owner:ui", `machine_rig_${action}`, { rig: r.rig, machine: r.machine });
    return back("ok", `${STEP_WORDS[action]}.`);
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
      const why = err instanceof Error ? err.message : String(err);
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
    const name = String(f.name ?? "").trim();
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
        return fail(err instanceof Error ? err.message : String(err));
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
        (err) =>
          store.finishInstall(approval, false, err instanceof Error ? err.message : String(err)),
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
    const name = String(f.name ?? "").trim();
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
      const why = err instanceof Error ? err.message : String(err);
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
  /** A model provider added or changed. */
  const saveProvider = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = String(f.name ?? "").trim();
    if (!PROVIDER_NAME.test(name))
      return fail("A provider's name is lowercase letters, digits, dots, dashes and underscores.");
    const type = String(f.type ?? "") as ProviderType;
    if (!(type in TYPES)) return fail("A provider is OpenAI-compatible or Anthropic.");
    if (type === "claude")
      return saveClaude(c, name, String(f.claude_token ?? f.api_key ?? "").trim());
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

  app.post("/ui/settings/providers/:name/delete", (c) => {
    const name = c.req.param("name");
    const r = store.deleteProvider(name);
    if (r === "deleted") store.audit("owner:ui", "model_provider_deleted", { name });
    return c.redirect(
      r === "deleted"
        ? settingsUrl("ok", `"${name}" deleted.`)
        : settingsUrl("error", r === "in_use" ? `"${name}" is still in use.` : "No such provider."),
      303,
    );
  });

  app.post("/ui/settings/rigs", async (c) => {
    const f = await c.req.parseBody();
    const rig = String(f.rig ?? "");
    const choice = String(f.choice ?? "");
    const harness: Harness =
      f.harness === "opencode" || f.harness === "claude-code" ? f.harness : "pi";
    if (!store.rigs().some((x) => x.id === rig))
      return c.redirect(settingsUrl("error", "No such rig."), 303);
    if (!choice) {
      store.assignRigModel(rig, null);
      store.audit("owner:ui", "rig_model_given", { rig, provider: null, model: null });
      return c.redirect(
        settingsUrl("ok", `${rig} goes back to its own settings within a minute.`),
        303,
      );
    }
    const given = giveRigModel(rig, choice, harness);
    return c.redirect(
      "error" in given ? settingsUrl("error", given.error) : settingsUrl("ok", given.ok),
      303,
    );
  });
  /** Gives a rig a provider's model under a harness, as Providers and Edit rig both do. */
  const giveRigModel = (
    rig: string,
    choice: string,
    picked: Harness,
  ): { ok: string } | { error: string } => {
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
        error:
          "Claude Code runs only with a Claude subscription here: choose Pi or OpenCode v2 for this provider.",
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
    store.assignRigModel(rig, { provider, model, harness });
    store.audit("owner:ui", "rig_model_given", { rig, provider, model, harness });
    return {
      ok: `${rig} takes ${model} from "${provider}" under ${HARNESSES[harness]} within a minute, and checks it.`,
    };
  };

  // ---------------------------------------------------------------- Edit rig
  // What runs on a rig and how, from its page: parts on or off, workers at once, limits, the
  // workers' model, the promotion policy. The harness parts go as one signed owner command
  // (rig_settings) with only what changed; the rig reports the settings it runs with.
  const PARTS: { id: keyof RigSettingsView; name: string; does: string; off: string }[] = [
    {
      id: "judge",
      name: "Judge",
      does: "It builds and measures each change that the agents submit, and it does the goal checks. Agents cannot change it.",
      off: "Changes wait in its queue. Nothing is measured, thus no change becomes the champion.",
    },
    {
      id: "workers",
      name: "Workers (agents)",
      does: "Each worker is an agent that tries one idea in its own copy of the code, then submits a change to the judge.",
      off: "No new trial starts. A trial that runs at this time continues to its end.",
    },
    {
      id: "planner",
      name: "Planner",
      does: "Before each round of trials, it reads what the agents found and gives each worker its next direction.",
      off: "Workers get the fixed plan that Thermite makes without a model.",
    },
    {
      id: "auditor",
      name: "Auditor",
      does: "It reads a change before it becomes the champion, when the campaign asks for an audit. Used only if the rig has one configured.",
      off: "Audits wait for you in Needs you.",
    },
    {
      id: "teachers",
      name: "Teacher pair",
      does: "Two strong models review the work of the agents and give advice to the planner. Used only if the rig has them configured.",
      off: "The planner works without their advice.",
    },
    {
      id: "review",
      name: "Review panel",
      does: "It decides goals that code cannot check. Used only if the rig has one configured.",
      off: "Those goals wait for your decision.",
    },
    {
      id: "exports",
      name: "Exports",
      does: "Every hour, the rig writes its results for the supervisor to send to the results repository.",
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
<div><div><b>${esc(p.name)}</b> <span class="pt-state ${s?.[p.id] ? "on" : "off"}">${s ? (s[p.id] ? "on" : "off") : "?"}</span></div><div class="muted small">${esc(p.does)}</div><div class="small pt-off"><b>When it is off:</b> ${esc(p.off)}</div>${p.id === "workers" ? `<label class="fd" style="max-width:220px;margin-top:8px">${infoLabel("Workers at a time", "How many agents work at the same time. Each one uses its own CPUs, memory and disk, and the same model.")}<input name="lanes" type="number" min="1" max="16" value="${s?.lanes ?? 1}"${s ? "" : " disabled"}></label>` : ""}</div></div>`;
    const modelOptions = `<option value="">its own settings</option>${providers
      .map(
        (p) =>
          `<optgroup label="${esc(p.name)}${p.type === "claude" ? " (Claude subscription: runs in Claude Code)" : ""}">${p.models
            .map(
              (m) =>
                `<option value="${esc(`${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`)}"${want?.provider === p.name && want.model === m.id ? " selected" : ""}>${p.type === "claude" ? "claude-code:" : ""}${esc(m.id)}</option>`,
            )
            .join("")}</optgroup>`,
      )
      .join("")}`;
    const placed = store.machineRig(u.id) ?? store.clusterRig(u.id);
    const where = placed
      ? "machine" in placed
        ? `The machine ${esc(placed.machine)}, set up by control. Stop, start or remove it from the rig's page.`
        : `The cluster ${esc(placed.cluster)}, namespace ${esc(placed.namespace)}, set up by control.`
      : "Set up outside control (for example by your own infrastructure tooling). Its GPUs and version change with a roll.";
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
<div class="sec"><h2>2 · The agents</h2><div class="g3">
<label class="fd">${infoLabel("Workers' model", "The model that the workers use, from Settings › Providers.")}<select name="choice">${modelOptions}</select></label>
<label class="fd">${infoLabel("Harness", "The program that runs each worker: Pi, OpenCode v2 or Claude Code. OpenCode's own free models need OpenCode v2. A Claude subscription runs only in Claude Code, which control chooses for it.")}<select name="harness"><option value="pi"${!want?.harness || want.harness === "pi" ? " selected" : ""}>Pi</option><option value="opencode"${want?.harness === "opencode" ? " selected" : ""}>OpenCode v2</option><option value="claude-code"${want?.harness === "claude-code" ? " selected" : ""}>Claude Code</option></select></label>
<label class="fd">${infoLabel("One trial lasts (minutes)", "How long a worker can work on one idea before it must submit, when the campaign sets no limit.")}<input name="trial_minutes" type="number" min="1" value="${s?.trial_minutes ?? ""}"${s ? "" : " disabled"}></label>
<label class="fd">${infoLabel("Turns per trial", "How many model turns a worker can take in one trial. Empty: no limit.")}<input name="max_turns" type="number" min="1" value="${s?.max_turns ?? ""}" placeholder="no limit"${s ? "" : " disabled"}></label>
</div></div>
<div class="sec"><h2>3 · When a change becomes the champion</h2><div class="g2">
<label class="ch${s?.promotion === "auto" ? " on" : ""}"><input type="radio" name="promotion" value="auto"${s?.promotion === "auto" ? " checked" : ""}${s ? "" : " disabled"} style="margin:2px 8px 0 0"><span><b>Automatically</b><br><span class="muted small">The judge confirms the change on new runs, and it becomes the champion. A change that the campaign sends to an audit still waits for the audit.</span></span></label>
<label class="ch${s?.promotion === "owner_approval" ? " on" : ""}"><input type="radio" name="promotion" value="owner_approval"${s?.promotion === "owner_approval" ? " checked" : ""}${s ? "" : " disabled"} style="margin:2px 8px 0 0"><span><b>Ask me for each change</b><br><span class="muted small">Each confirmed change waits for you in Needs you.</span></span></label>
</div><div class="muted small" style="margin-top:6px">A campaign can set its own rule when it starts; that rule comes first for its runs.</div></div>
<div class="sec"><h2>4 · Where it runs</h2><div class="card"><dl class="facts"><dt>Place</dt><dd>${where}</dd>${u.hardware ? `<dt>Hardware</dt><dd>${hardwareLine(u.hardware)}</dd>` : ""}</dl>${
        u.gpu_split && u.gpu_split.set >= 2
          ? `<label class="fd" style="max-width:260px;margin-top:10px">${infoLabel("GPUs for the judge", `How many of the rig's ${u.gpu_split.set} GPUs the judge measures on; the rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. A campaign started on this rig can set it too.`)}<input name="judge_gpus" type="number" min="1" max="${Math.min(8, u.gpu_split.set - 1)}" value="${u.gpu_split.judge}" data-restarts></label><div class="muted small">Now: ${u.gpu_split.judge} for the judge, ${u.gpu_split.set - u.gpu_split.judge} for the agents. A new split restarts the rig's harness to regroup the GPUs: running trials and judge jobs start again.</div>`
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
    // The workers' model: as in Providers.
    const choice = String(f.choice ?? "");
    const harness: Harness =
      f.harness === "opencode" || f.harness === "claude-code" ? f.harness : "pi";
    const want = store.rigModels()[rig];
    const was = want
      ? `${encodeURIComponent(want.provider)}|${encodeURIComponent(want.model)}`
      : "";
    if (choice !== was || (choice && harness !== want?.harness)) {
      if (!choice) {
        store.assignRigModel(rig, null);
        store.audit("owner:ui", "rig_model_given", { rig, provider: null, model: null });
        said.push("its own model settings");
      } else {
        const given = giveRigModel(rig, choice, harness);
        if ("error" in given) return back("error", given.error);
        said.push("a new model");
      }
    }
    // The harness's settings: only what changed, as one signed command.
    const s = u.settings;
    if (s) {
      const change: Record<string, unknown> = {};
      for (const p of PARTS) {
        const on = f[p.id] === "1";
        if (on !== s[p.id]) change[p.id] = on;
      }
      const num = (k: string) => {
        const v = String(f[k] ?? "").trim();
        return v === "" ? null : Number(v);
      };
      const lanes = num("lanes");
      if (lanes !== null && lanes !== s.lanes) change.lanes = lanes;
      const minutes = num("trial_minutes");
      if (minutes !== null && minutes !== s.trial_minutes) change.trial_minutes = minutes;
      const turns = num("max_turns");
      if (turns !== s.max_turns) change.max_turns = turns;
      const promotion = String(f.promotion ?? s.promotion);
      if (promotion !== s.promotion) change.promotion = promotion;
      const judge = num("judge_gpus");
      if (u.gpu_split && judge !== null && judge !== u.gpu_split.judge) {
        const top = Math.min(8, u.gpu_split.set - 1);
        if (!Number.isInteger(judge) || judge < 1 || judge > top || u.gpu_split.set - judge > 8)
          return back(
            "error",
            `Not saved: with ${u.gpu_split.set} GPUs the judge takes 1 to ${top} of them, and the agents at most 8.`,
          );
        change.judge_gpus = judge;
      }
      if (Object.keys(change).length) {
        const parsed = CommandPayloads.rig_settings.safeParse(change);
        if (!parsed.success)
          return back(
            "error",
            `Not saved: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          );
        issueCommand(store, opts.privateKeyPem, {
          rig,
          kind: "rig_settings",
          payload: parsed.data,
          issuedBy: "owner:ui",
        });
        said.push(
          `${Object.keys(change).length} setting${Object.keys(change).length === 1 ? "" : "s"}`,
        );
      }
    }
    return back(
      "ok",
      said.length
        ? `Control sent ${said.join(" and ")} to ${rig}. The rig takes the change in less than one minute.`
        : "Nothing changed.",
    );
  });

  app.post("/ui/commands", async (c) => {
    const f = await c.req.parseBody();
    const kind = String(f.kind) as CommandKind;
    if (!COMMAND_KINDS.includes(kind)) return c.text("unknown command", 400);
    const run = String(f.run ?? "");
    const payloads: Partial<Record<CommandKind, unknown>> = {
      pause_run: { run, reason: String(f.reason || "paused from the dashboard") },
      resume_run: { run },
      reset_workers: { run },
      export_now: {},
      rig_check: { check: String(f.check ?? ""), ...(f.force === "true" ? { force: true } : {}) },
      approve_promotion: { run, attempt: String(f.attempt ?? "") },
      decline_promotion: { run, attempt: String(f.attempt ?? "") },
      accept_review: { run, review: Number(f.review), accept: f.accept === "true" },
      conclude: { run, proposal: Number(f.proposal), accept: f.accept === "true" },
      redirect: {
        run,
        directives: [
          {
            kind: String(f.directive ?? "avoid"),
            family: String(f.family ?? ""),
            rationale: String(f.rationale ?? ""),
            citations: [],
          },
        ],
        replace: f.add !== "1",
      },
    };
    if (!(kind in payloads)) return c.text("this command is not available from the dashboard", 400);
    try {
      issueCommand(store, opts.privateKeyPem, {
        rig: String(f.rig),
        kind,
        payload: payloads[kind],
        issuedBy: "owner:ui",
      });
    } catch (err) {
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    // The page says the command went; the rig's answer shows where the command was given.
    const to = backTo(f, `/ui/rigs/${encodeURIComponent(String(f.rig))}`);
    const [path, hash] = to.split("#");
    const sent = `Control sent the command to ${String(f.rig)}. The rig does it in less than 10 seconds. This page shows the result.`;
    return c.redirect(
      `${path}${path?.includes("?") ? "&" : "?"}sent=${encodeURIComponent(sent)}${hash ? `#${hash}` : ""}`,
      303,
    );
  });

  return app;
}
