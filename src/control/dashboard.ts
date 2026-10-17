import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { COMMAND_KINDS, type CommandKind } from "../core/commands.ts";
import type { Credential } from "./credential.ts";
import { issueCommand, propagateChampion } from "./issue.ts";
import { advanceResets, cancelReset, confirmReset, type DeploymentDriver } from "./lifecycle.ts";
import { ANTHROPIC_BASE, isOpencodeOwn, listModels, providerBase } from "./providers.ts";
import { keyHint, type SecretBox } from "./secrets.ts";
import {
  type ControlStore,
  fingerprint,
  type Harness,
  type ModelProvider,
  type ProviderType,
} from "./store.ts";
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
import { STYLE } from "./ui/style.ts";
import { auditReason, clip, jobText, runStatusText, signed, span } from "./ui/words.ts";
import {
  type CampaignView,
  campaignViews,
  leaderboard,
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
      },
      cards || `<div class="card"><div class="empty">No campaign yet.</div></div>`,
      vs,
    );
  });

  app.get("/ui/campaigns/:campaign", (c) => {
    const now = Date.now();
    const vs = views();
    const name = c.req.param("campaign");
    const k = campaignViews(vs).find((x) => x.name === name);
    if (!k)
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
      `${summary ? `<div class="block" style="margin-bottom:8px">${summary}${goalMatrix}</div>` : ""}${tabs}${runSection(c, sel.rig, sel.run, vs, now, view)}`,
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
        active: "rigs",
      },
      cards || `<div class="card"><div class="empty">No rig has reported yet.</div></div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- one rig
  app.get("/ui/rigs/:rig", (c) => {
    const now = Date.now();
    const vs = views();
    const u = vs.find((x) => x.id === c.req.param("rig"));
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
    const actions = `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/live">${icon.terminal}Live</a>
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
${keyCard}
${runsNow ? `<div class="block"><div class="head"><h2>At work</h2><span class="n">${live.length}</span></div>${runsNow}</div>` : ""}
<div class="cols run-cols"><div>
<div class="block"><div class="head"><h2>Checks</h2><span class="right">run by the rig itself; each result also goes to its history</span></div><div class="card flat">${checkRows}</div></div>
<div class="block"><div class="head"><h2>Runs on this rig</h2><span class="n">${u.runs.length}</span></div>${runRows ? `<div class="card flat">${runRows}</div>` : `<div class="card"><div class="empty">No campaign assigned.</div></div>`}</div>
<div class="block"><div class="head"><h2>The judge's last jobs</h2></div>${jobs ? `<div class="card flat tl">${jobs}</div>` : `<div class="card"><div class="empty">No job yet.</div></div>`}</div>
</div><div class="side">
<div class="block"><div class="head"><h2>What it runs on</h2></div>${h ? `<div class="card"><dl class="facts">${hw}</dl></div><details class="card flat matrix" data-k="hw-${esc(u.id)}" style="margin-top:10px"><summary>Every detail</summary>${hardwareCard(h, now)}</details>` : hardwareCard(h, now)}</div>
<div class="block"><div class="head"><h2>The rig</h2></div><div class="card"><dl class="facts">${rigFacts}</dl>${sup ? `<div class="muted xs" style="margin-top:8px">The supervisor reports its figures itself (unsigned).</div>` : ""}</div></div>
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

  /** "· 48.2 s · exit 0" from a tool result line ("run (48210 ms): exit 0 ..."). */
  const resultHint = (text: string) => {
    const m = /^(\S+)( failed)? \((\d+) ms\): ?(.*)/s.exec(text);
    if (!m) return "";
    const ms = Number(m[3]);
    const first = (m[4] ?? "").split("\n")[0]?.slice(0, 60) ?? "";
    return `<span class="${m[2] ? "bad" : "muted"} xs">· ${ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`}${m[2] ? " · failed" : first ? ` · ${esc(first)}` : ""}</span>`;
  };
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
    // Server-rendered lines (the script appends new ones the same way).
    const out: string[] = [];
    let openTool = false;
    for (const e of lines) {
      const who = !source
        ? `<span class="muted xs">${esc(sourceName(e.source, e.lane))}${e.source.startsWith("trial:") ? ` · ${esc(e.source.slice(6))}` : ""}</span>`
        : "";
      if (e.kind === "result" && openTool) {
        out[out.length - 1] = (out[out.length - 1] as string)
          .replace("</summary>", `${resultHint(e.text)}</summary>`)
          .replace("</details>", `<pre>${esc(e.text)}</pre></details>`)
          .replace('<details class="tool">', '<details class="tool" data-done="1">');
        openTool = false;
        continue;
      }
      openTool = false;
      if (e.kind === "status") out.push(`<div class="status">${esc(e.text)}</div>`);
      else if (e.kind === "text") out.push(`${who}<div class="tx">${esc(e.text)}</div>`);
      else if (e.kind === "thinking")
        out.push(
          `<details class="think"><summary>Thinking</summary><pre>${esc(e.text)}</pre></details>`,
        );
      else if (e.kind === "tool") {
        const sp = e.text.indexOf(" ");
        out.push(
          `<details class="tool"><summary><span class="name">${esc(sp > 0 ? e.text.slice(0, sp) : e.text)}</span><span>${esc(sp > 0 ? e.text.slice(sp + 1, sp + 120) : "")}</span></summary><pre>${esc(e.text)}</pre></details>`,
        );
        openTool = true;
      } else if (e.kind === "result")
        out.push(
          `<details class="tool"><summary>result</summary><pre>${esc(e.text)}</pre></details>`,
        );
      else if (e.kind === "message")
        out.push(
          `<div class="msg"><div class="who">You</div>${esc(e.text.replace(/^Owner( to [^:]+)?: /, ""))}</div>`,
        );
      else
        out.push(
          `<div class="logline"><span class="t">${esc(e.at.slice(11, 19))}</span><span>${esc(e.text)}</span>${!source ? `<span class="muted">${esc(sourceName(e.source, e.lane))}</span>` : ""}</div>`,
        );
    }
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
<div class="transcript-wrap"><div class="transcript" id="transcript" data-rig="${esc(u.id)}" data-source="${esc(source)}" data-after="${after}">${out.join("") || `<div class="empty">No live lines yet. They appear here as the rig's agents and judge work.</div>`}</div>${composer}</div>`,
      vs,
    );
  });

  app.get("/ui/rigs/:rig/live.json", (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    return c.json({
      entries: store.live(c.req.param("rig"), after, 500, c.req.query("source") || undefined),
    });
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
  };
  const HARNESSES: Record<Harness, string> = { pi: "Pi", opencode: "OpenCode v2" };
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
    `<select name="type">${(Object.keys(TYPES) as ProviderType[]).map((t) => `<option value="${t}"${t === sel ? " selected" : ""}>${t === "opencode" ? "OpenCode (its own models)" : TYPES[t]}</option>`).join("")}</select>`;

  app.get("/ui/settings", (c) => {
    const now = Date.now();
    const vs = views();
    const t = csrf(c);
    const providers = store.providers();
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
    const providerRows = providers
      .map((p) => {
        const rigs = usersOf(p.name);
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
<span class="dq-kind route-name">${esc(TYPES[p.type])}</span>
<span class="dq-main"><span class="dq-head">${esc(p.name)}</span>${status}<span class="dq-sub"><span class="dq-where">${esc(p.base_url || ANTHROPIC_BASE)}</span><span class="chip">${p.key_hint ? `key ${esc(p.key_hint)}` : "no key: its free models"}</span>${p.type === "opencode" ? `<span class="chip info">runs in the OpenCode harness</span>` : isOpencodeOwn(p) ? `<span class="chip info">OpenCode's own: its free models run in the OpenCode harness</span>` : ""}${p.base_url.startsWith("http://") ? `<span class="chip warn">not HTTPS</span>` : ""}<span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
<span class="dq-side"><span class="dq-btns"><form class="inline" method="post" action="/ui/settings/providers/${pName}/refresh"><input type="hidden" name="csrf" value="${t}"><button>Refresh models</button></form></span></span>
</summary><div class="dq-body">${list}
<form method="post" action="/ui/settings/providers/${pName}/models" class="row" style="gap:8px"><input type="hidden" name="csrf" value="${t}"><input name="model" maxlength="200" placeholder="a model it does not list, by its name" style="width:320px"><button>Add it</button></form>
<form method="post" action="/ui/settings/providers" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="name" value="${esc(p.name)}">
<label>Type${typeSelect(p.type)}</label>
<label>Base URL<input name="base_url" maxlength="500" value="${esc(p.base_url)}"></label>
<label>API key<input name="api_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the key ending ${esc(p.key_hint)}"></label>
<div class="form-end row" style="gap:8px"><button class="primary">Save and list its models</button></div></form>
${
  rigs.length
    ? `<div class="muted small">In use: give its rigs another model before deleting it.</div>`
    : `<form class="inline" method="post" action="/ui/settings/providers/${pName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Delete this provider</button></form>`
}</div></details>`;
      })
      .join("");
    const addForm = `<form method="post" action="/ui/settings/providers" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}">
<label>Name<input name="name" required maxlength="64" placeholder="for example opencode"></label>
<label>Type${typeSelect()}</label>
<label>Base URL<input name="base_url" maxlength="500" placeholder="https://…/v1 (Anthropic and OpenCode: empty for their own)"></label>
<label>API key<input name="api_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again (OpenCode: empty for its free models)"></label>
<div class="form-end"><button class="primary">Add and list its models</button></div></form>`;
    const options = (want: { provider: string; model: string } | undefined) =>
      `<option value=""${want ? "" : " selected"}>its own settings</option>${providers
        .filter((p) => p.models.length)
        .map(
          (p) =>
            `<optgroup label="${esc(p.name)}${p.type === "opencode" ? " (OpenCode harness only)" : isOpencodeOwn(p) ? " (free models: OpenCode harness only)" : ""}">${p.models
              .map(
                (m) =>
                  `<option value="${esc(`${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`)}"${want?.provider === p.name && want.model === m.id ? " selected" : ""}>${esc(m.id)}</option>`,
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
      { title: "Settings", active: "settings" },
      `<p class="run-said">Add a provider once: its name, type, base URL and API key. Thermite lists its models from the provider itself. Then choose, for each rig, the harness its agents run in (Pi or OpenCode v2) and their model: any provider works with either harness, and OpenCode's own models need the OpenCode harness. Control keeps each key encrypted and never shows it again.</p>
${note}
<div class="block"><div class="head"><h2>Model providers</h2><span class="n">${providers.length}</span><span class="right">models come from each provider's own list</span></div>${providers.length ? `<div class="dqs">${providerRows}</div>` : `<div class="card"><div class="empty">No provider yet: add one below.</div></div>`}</div>
<div class="block"><div class="head"><h2>Add a provider</h2></div><div class="card">${addForm}</div></div>
<div class="block"><div class="head"><h2>Harness and model for each rig</h2><span class="right">a rig takes a change within a minute; then check it</span></div><div class="card flat">${rigRows || `<div class="empty">No rig has reported yet.</div>`}</div></div>`,
      vs,
    );
  });

  app.post("/ui/settings/providers", async (c) => {
    const f = await c.req.parseBody();
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = String(f.name ?? "").trim();
    if (!PROVIDER_NAME.test(name))
      return fail("A provider's name is lowercase letters, digits, dots, dashes and underscores.");
    const type = String(f.type ?? "") as ProviderType;
    if (!(type in TYPES)) return fail("A provider is OpenAI-compatible or Anthropic.");
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
  });

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
    const harness: Harness = f.harness === "opencode" ? "opencode" : "pi";
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
      return c.redirect(settingsUrl("error", "That provider does not list that model."), 303);
    // OpenCode's free models (and a keyless OpenCode provider) need its own client.
    if (
      harness !== "opencode" &&
      isOpencodeOwn(p) &&
      (p.type === "opencode" || !p.key_sealed || model.endsWith("-free"))
    )
      return c.redirect(
        settingsUrl(
          "error",
          "OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig.",
        ),
        303,
      );
    store.assignRigModel(rig, { provider, model, harness });
    store.audit("owner:ui", "rig_model_given", { rig, provider, model, harness });
    return c.redirect(
      settingsUrl(
        "ok",
        `${rig} takes ${model} from "${provider}" under ${HARNESSES[harness]} within a minute, and checks it.`,
      ),
      303,
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
    return c.redirect(backTo(f, `/ui/rigs/${encodeURIComponent(String(f.rig))}`), 303);
  });

  return app;
}
