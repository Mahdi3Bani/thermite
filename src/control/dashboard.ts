import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { COMMAND_KINDS, type CommandKind } from "../core/commands.ts";
import { issueCommand, propagateChampion } from "./issue.ts";
import { advanceResets, cancelReset, confirmReset, type DeploymentDriver } from "./lifecycle.ts";
import { type ControlStore, fingerprint } from "./store.ts";
import { CLIENT_JS } from "./ui/client.ts";
import {
  ago,
  avatar,
  deltaCell,
  esc,
  fmtInt,
  gainChart,
  icon,
  instanceState,
  kpi,
  meter,
  modeAvatar,
  modeName,
  num,
  pct,
  type Shell,
  shell,
  sparkline,
  stackBar,
  verdictChip,
} from "./ui/components.ts";
import { STYLE } from "./ui/style.ts";
import { type InstanceView, leaderboard, type UnitView, unitView } from "./views.ts";

/**
 * The control dashboard: server-rendered pages over control's store, with forms that issue
 * signed commands. Login takes the admin token once and keeps a random session in an HttpOnly,
 * SameSite=Strict cookie; every form carries a token derived from the session (CSRF). The only
 * script is control's own (/ui/assets/app.js): it refreshes pages and streams the live view.
 * The look follows Magnesium's design.
 */

const SESSION_MS = 12 * 3_600_000;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
// biome-ignore lint/suspicious/noExplicitAny: any route's context
type Ctx = Context<any, any, any>;

export interface DashboardOptions {
  adminToken: string;
  privateKeyPem: string;
  staleAfterMs: number;
  driver?: DeploymentDriver | undefined;
}

/** Something on a unit that waits for the owner. */
interface Need {
  kind: "promotion" | "audit" | "key" | "reset" | "review" | "conclusion" | "stale";
  unit: string;
  instance?: string | undefined;
  at?: string | undefined;
  html: string;
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
  const secret = randomBytes(32);
  const sessions = new Map<string, number>();
  const csrfOf = (sid: string) => createHmac("sha256", secret).update(sid).digest("hex");
  const sessionOf = (c: Ctx) => {
    const sid = getCookie(c, "thermite_session");
    const until = sid ? sessions.get(sid) : undefined;
    return sid && until && until > Date.now() ? sid : undefined;
  };
  const sameBytes = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
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
<div class="muted small">Sign in with the admin token. The session lasts 12 hours.</div>
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
    if (!sameBytes(token, opts.adminToken)) {
      failures.push(now);
      if (failures.length === 20) store.audit("control", "login_throttled", {});
      return c.redirect("/ui/login", 303);
    }
    const sid = randomBytes(24).toString("base64url");
    sessions.set(sid, Date.now() + SESSION_MS);
    setCookie(c, "thermite_session", sid, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/ui",
      maxAge: SESSION_MS / 1000,
      // Behind a proxy that ends TLS, the proxy's header says the owner's side is HTTPS.
      secure:
        new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    });
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
    if (sid) sessions.delete(sid);
    return c.redirect("/ui/login", 303);
  });

  app.get("/ui/assets/app.js", (c) =>
    c.body(CLIENT_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  const csrf = (c: Ctx) => csrfOf(sessionOf(c) ?? "");
  const views = (): UnitView[] =>
    store
      .units()
      .map((u) => unitView(store, u.id, { staleAfterMs: opts.staleAfterMs }))
      .filter((v): v is UnitView => v !== undefined);
  /** A form that issues a command; `back` is where the owner lands afterwards. */
  const cmdForm = (
    c: Ctx,
    f: {
      unit: string;
      kind: string;
      fields?: Record<string, string>;
      label: string;
      cls?: string;
      back?: string;
      extra?: string;
    },
  ) =>
    `<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="unit" value="${esc(f.unit)}"><input type="hidden" name="kind" value="${esc(f.kind)}">${Object.entries(
      f.fields ?? {},
    )
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join(
        "",
      )}${f.back ? `<input type="hidden" name="back" value="${esc(f.back)}">` : ""}${f.extra ?? ""}<button class="${f.cls ?? ""}">${esc(f.label)}</button></form>`;

  /** Everything that waits for the owner, across units: the "Needs you" feed. */
  const needs = (c: Ctx, vs: UnitView[], now: number): Need[] => {
    const out: Need[] = [];
    const t = csrf(c);
    const head = (u: string, i: InstanceView | undefined, when?: string) =>
      `<div class="fc-head">${avatar(u)}<b>${esc(u)}</b>${i ? `<a class="link" href="/ui/units/${encodeURIComponent(u)}#${encodeURIComponent(i.id)}">${esc(i.id)} · ${esc(i.campaign ?? "")}</a>` : ""}<span class="meta">${when ? `${esc(ago(when, now))} ago` : ""}</span></div>`;
    for (const u of vs) {
      const key = store.unitKey(u.id);
      if (key.pending) {
        out.push({
          kind: "key",
          unit: u.id,
          html: `<div class="fc">${head(u.id, undefined)}<div class="fc-kind warn">${icon.key}${key.pubkey ? "The unit's report key changed" : "A new unit's report key"}</div>
<div class="fc-body">Its reports are refused until you accept the key. Check this fingerprint against the unit's deployment first.</div>
<div class="fc-box">${esc(fingerprint(key.pending))}</div>
<div class="fc-actions"><form class="inline" method="post" action="/ui/units/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="fingerprint" value="${esc(fingerprint(key.pending))}"><button class="primary">Accept this key</button></form></div></div>`,
        });
      }
      for (const i of u.instances) {
        for (const a of i.pending_promotions) {
          const att = i.attempts.find((x) => x.id === a);
          out.push({
            kind: "promotion",
            unit: u.id,
            instance: i.id,
            at: att?.updated_at,
            html: `<div class="fc">${head(u.id, i, att?.updated_at)}<div class="fc-kind warn">${icon.warn}Promotion waiting for approval</div>
<div class="fc-body">${esc(att?.hypothesis ?? "A confirmed win")}</div>
<div class="fc-box">${esc(a)}${att?.delta !== undefined && att.delta !== null ? ` · confirmed ${pct(att.delta)}` : ""}${att?.lane ? ` · ${esc(att.lane)}` : ""}</div>
<div class="fc-actions"><a class="btn" href="/ui/units/${encodeURIComponent(u.id)}#${encodeURIComponent(i.id)}">Open</a>${cmdForm(c, { unit: u.id, kind: "approve_promotion", fields: { instance: i.id, attempt: a }, label: "Approve", cls: "primary", back: "/ui" })}</div></div>`,
          });
        }
        for (const a of i.audits.filter((x) => x.decision === null || x.decision === "block")) {
          out.push({
            kind: "audit",
            unit: u.id,
            instance: i.id,
            at: a.at,
            html: `<div class="fc">${head(u.id, i, a.at)}<div class="fc-kind ${a.decision ? "bad" : "warn"}">${icon.shield}${a.decision ? "Blocked by the auditor" : "Held for an audit"}</div>
<div class="fc-body">${esc(a.reason)}</div><div class="fc-box">${esc(a.attempt)}</div>
<div class="fc-actions"><a class="btn" href="/ui/units/${encodeURIComponent(u.id)}#${encodeURIComponent(i.id)}">Open</a>${cmdForm(c, { unit: u.id, kind: "approve_promotion", fields: { instance: i.id, attempt: a.attempt }, label: "Override and approve", back: "/ui" })}</div></div>`,
          });
        }
        for (const r of i.reviews.filter((x) => x.panel === "review_passed" && !x.owner)) {
          out.push({
            kind: "review",
            unit: u.id,
            instance: i.id,
            html: `<div class="fc">${head(u.id, i)}<div class="fc-kind violet">${icon.check}Review panel passed a subjective goal</div>
<div class="fc-body">Goal <b>${esc(r.goal)}</b> on commit <code>${esc(r.commit.slice(0, 12))}</code>. It is met only with your acceptance.</div>
<div class="fc-actions">${cmdForm(c, { unit: u.id, kind: "accept_review", fields: { instance: i.id, review: String(r.review), accept: "false" }, label: "Reject", back: "/ui" })}${cmdForm(c, { unit: u.id, kind: "accept_review", fields: { instance: i.id, review: String(r.review), accept: "true" }, label: "Accept", cls: "primary", back: "/ui" })}</div></div>`,
          });
        }
        for (const k of i.conclusions.filter((x) => x.decision === null)) {
          out.push({
            kind: "conclusion",
            unit: u.id,
            instance: i.id,
            at: k.at,
            html: `<div class="fc">${head(u.id, i, k.at)}<div class="fc-kind warn">${icon.warn}End this campaign as not possible?</div>
<div class="fc-body">${k.approaches} approach families are refuted with receipts. Only you can end the campaign.</div>
<div class="fc-actions">${cmdForm(c, { unit: u.id, kind: "conclude", fields: { instance: i.id, proposal: String(k.proposal), accept: "false" }, label: "Keep going", back: "/ui" })}${cmdForm(c, { unit: u.id, kind: "conclude", fields: { instance: i.id, proposal: String(k.proposal), accept: "true" }, label: "Accept: not possible", cls: "primary", back: "/ui" })}</div></div>`,
          });
        }
      }
      if (u.stale) {
        out.push({
          kind: "stale",
          unit: u.id,
          at: u.last_seen,
          html: `<div class="fc">${head(u.id, undefined, u.last_seen)}<div class="fc-kind bad">${icon.x}Not reporting</div>
<div class="fc-body">No report for ${esc(ago(u.last_seen, now))}. Check the unit's supervisor and harness.</div>
<div class="fc-actions"><a class="btn" href="/ui/units/${encodeURIComponent(u.id)}">Open unit</a></div></div>`,
        });
      }
    }
    for (const r of store.resets(20).filter((x) => String(x.state) === "awaiting_owner")) {
      out.push({
        kind: "reset",
        unit: String(r.unit),
        html: `<div class="fc">${head(String(r.unit), undefined, String(r.updated_at))}<div class="fc-kind bad">${icon.warn}Full reset: confirm the wipe</div>
<div class="fc-body">The export is pushed${r.export_name ? ` (<code>${esc(r.export_name)}</code>)` : ""}. Check it in the results repository, then confirm. The unit's state is wiped after that.</div>
<div class="fc-actions"><form class="inline" method="post" action="/ui/resets/${esc(r.id)}/cancel"><input type="hidden" name="csrf" value="${t}"><button>Cancel</button></form><form class="inline" method="post" action="/ui/resets/${esc(r.id)}/confirm"><input type="hidden" name="csrf" value="${t}"><button class="primary">Confirm the wipe</button></form></div></div>`,
      });
    }
    const order = ["key", "reset", "promotion", "audit", "review", "conclusion", "stale"];
    return out.sort(
      (a, b) =>
        order.indexOf(a.kind) - order.indexOf(b.kind) ||
        String(a.at ?? "").localeCompare(String(b.at ?? "")),
    );
  };
  /** The page shell with the sidebar's units and campaigns. */
  const page = (c: Ctx, s: Omit<Shell, "units" | "needs" | "now">, body: string, vs = views()) => {
    const now = Date.now();
    return c.html(
      shell(
        {
          ...s,
          units: vs,
          needs: needs(c, vs, now).filter((n) => n.kind !== "stale").length,
          now,
          refresh: s.refresh ?? 15,
        },
        body,
      ),
    );
  };

  // ---------------------------------------------------------------- overview (Magnesium's Home)
  app.get("/ui", (c) => {
    const now = Date.now();
    const vs = views();
    const feed = needs(c, vs, now);
    const urgent = feed.filter((n) => n.kind !== "stale");
    const instances = vs.flatMap((u) => u.instances.map((i) => ({ u, i })));
    const tiles = vs
      .map((u) => {
        const running = u.instances.filter((i) => i.status === "running");
        const main = running[0] ?? u.instances[0];
        const champ = main?.champion.filter((s) => !s.reopened).at(-1);
        const sub = u.stale
          ? `Not reporting for ${ago(u.last_seen, now)}`
          : main
            ? `${main.id} · ${modeName(main.mode)}`
            : "Idle · no campaign";
        const gain =
          !u.stale && main?.mode === "hill_climb" && (champ?.cumulative ?? 1) !== 1
            ? `<span class="gain">${pct((champ?.cumulative ?? 1) - 1, 1)}</span>`
            : !u.stale && main?.mode === "goal"
              ? `<span class="gain" style="color:var(--muted-foreground)">${main.goals.filter((g) => g.status === "met").length}/${main.goals.length}</span>`
              : "";
        const q = num(u.jobs.queued) + num(u.jobs.leased);
        return `<a class="tile${u.stale ? " off" : ""}" href="/ui/units/${encodeURIComponent(u.id)}"><span class="name"><span class="dot ${u.stale ? "bad" : "ok"}"></span>${esc(u.id)}${gain}</span><span class="sub">${esc(sub)}</span>${
          !u.stale && main?.mode === "hill_climb"
            ? sparkline(main)
            : `<span class="sub">${q ? `judge ${q} job${q > 1 ? "s" : ""}` : "&nbsp;"}</span>`
        }</a>`;
      })
      .join("");
    const board = leaderboard(store, { staleAfterMs: opts.staleAfterMs });
    const camps = Object.entries(board)
      .map(([campaign, rows]) => {
        const best = Math.max(0.0001, ...rows.map((r) => r.gain));
        return `<div class="card tight"><div class="card-head"><span class="title">${esc(campaign)}</span><span class="right muted small">${rows.length} unit${rows.length > 1 ? "s" : ""}</span></div><div class="stack" style="margin-top:10px;gap:8px">${rows
          .map((r) =>
            meter(
              `${r.unit} / ${r.instance}${r.verified_by.length ? " ✓" : ""}`,
              pct(r.gain, 1),
              r.gain / best,
              "primary",
            ),
          )
          .join("")}</div></div>`;
      })
      .join("");
    const others = instances
      .filter(({ i }) => i.mode !== "hill_climb")
      .map(({ u, i }) => {
        const st = instanceState(i);
        const met = i.goals.filter((g) => g.status === "met").length;
        const r = i.research as Record<string, unknown> | null;
        const sub =
          i.mode === "goal"
            ? `${met} of ${i.goals.length || "?"} goals met`
            : r
              ? `${num(r.verified)} verified claims · ${num(r.sources)} sources`
              : "starting";
        return `<a class="side-row" style="padding:9px 12px" href="/ui/units/${encodeURIComponent(u.id)}#${encodeURIComponent(i.id)}">${modeAvatar(i.mode)}<span class="two" style="display:flex;flex-direction:column;min-width:0"><span class="name"><b>${esc(i.id)}</b> <span class="muted">· ${esc(u.id)}</span></span><span class="muted xs">${esc(sub)}</span></span><span class="right label ${st.cls}">${st.icon}${esc(st.text)}</span></a>`;
      })
      .join("");
    const activity = vs
      .flatMap((u) => u.recent.slice(0, 12).map((e) => ({ u: u.id, e })))
      .sort((a, b) => b.e.at.localeCompare(a.e.at))
      .slice(0, 12)
      .map(
        ({ u, e }) =>
          `<div class="li"><span class="t">${esc(ago(e.at, now))}</span><span class="grow clip">${esc(e.kind.replace(/_/g, " "))} <span class="muted">${esc(e.subject ?? "")}</span></span><span class="right muted">${esc(u)}</span></div>`,
      )
      .join("");
    const running = instances.filter(({ i }) => i.status === "running").length;
    return page(
      c,
      {
        title: "Overview",
        summary: `${urgent.length} need you · ${running} running · ${vs.filter((u) => !u.stale).length} of ${vs.length} units live`,
        active: "overview",
      },
      `<div class="cols"><div>
  <div class="head"><h2 class="row">${icon.warn}<span>Needs you</span></h2><span class="n">${urgent.length}</span><span class="right">urgent first, then oldest</span></div>
  ${feed.length ? `<div class="feed">${feed.map((n) => n.html).join("")}</div>` : `<div class="card"><div class="empty">Nothing waits for you. Campaigns are running on their own.</div></div>`}
</div><div>
  <div class="block"><div class="head"><h2>Units</h2><span class="right"><a href="/ui/units">All units</a></span></div>${tiles ? `<div class="grid2">${tiles}</div>` : `<div class="card"><div class="empty">No unit has reported yet.</div></div>`}</div>
  ${camps ? `<div class="block"><div class="head"><h2>Hill climbs</h2><span class="right"><a href="/ui/leaderboard">Leaderboard</a></span></div><div class="stack">${camps}</div></div>` : ""}
  ${others ? `<div class="block"><div class="head"><h2>Goals and research</h2></div><div class="card flat" style="padding:4px">${others}</div></div>` : ""}
  ${activity ? `<div class="block"><div class="head"><h2>Activity</h2></div><div class="card flat"><div class="list">${activity}</div></div></div>` : ""}
</div></div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- units (Magnesium's Fleet)
  app.get("/ui/units", (c) => {
    const now = Date.now();
    const vs = views();
    const cards = vs
      .map((u) => {
        const key = store.unitKey(u.id);
        const status = key.pending
          ? `<span class="pill warn">Key to accept</span>`
          : u.stale
            ? `<span class="pill bad">Stale</span>`
            : `<span class="pill ok">Live</span>`;
        const queued = num(u.jobs.queued);
        const leased = num(u.jobs.leased);
        const done = num(u.jobs.done);
        const sup = u.supervisor as Record<string, unknown> | null;
        const ex =
          sup?.export && typeof sup.export === "object"
            ? (sup.export as Record<string, unknown>)
            : null;
        const rows = u.instances
          .map((i) => {
            const st = instanceState(i);
            const champ = i.champion.filter((s) => !s.reopened).at(-1);
            const extra =
              i.mode === "hill_climb"
                ? `<span class="muted small nowrap">${pct((champ?.cumulative ?? 1) - 1, 1)}</span>`
                : i.mode === "goal"
                  ? `<span class="muted small nowrap">${i.goals.filter((g) => g.status === "met").length}/${i.goals.length} goals</span>`
                  : "";
            return `<a class="row" style="padding:6px 0" href="/ui/units/${encodeURIComponent(u.id)}#${encodeURIComponent(i.id)}">${modeAvatar(i.mode)}<span class="grow clip">${esc(i.id)} <span class="muted small">${esc(i.campaign ?? "")}</span></span>${extra}<span class="label ${st.cls}">${st.icon}${esc(st.text)}</span></a>`;
          })
          .join("");
        return `<div class="card"><div class="card-head"><span class="iconbox">${icon.cpu}</span><div class="grow"><a class="title" href="/ui/units/${encodeURIComponent(u.id)}">${esc(u.id)}</a><div class="sub">${u.stale ? `last report ${esc(ago(u.last_seen, now))} ago` : `reported ${esc(ago(u.last_seen, now))} ago`}</div></div><div class="right">${status}</div></div>
<div class="grid2" style="margin-top:12px;gap:14px">${meter("Judge", `${leased} running · ${queued} queued`, (leased + queued) / Math.max(4, leased + queued), "primary")}${meter("Judged", fmtInt(done), done ? 1 : 0)}</div>
<div class="divider"></div>${rows || `<div class="muted small">Idle. No campaign assigned.</div>`}
${ex ? `<div class="divider"></div><div class="muted xs">Results: ${num(ex.exports)} exports${ex.remote === true ? ` · pushed ${esc(ago(String(ex.last_push_at ?? ""), now) || "never")} ago` : " · no results repository"}${ex.last_error ? ` · <span class="bad">${esc(String(ex.last_error).slice(0, 120))}</span>` : ""}</div>` : ""}</div>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Units",
        summary: `${vs.length} units · ${vs.filter((u) => u.stale).length} stale · ${vs.reduce((n, u) => n + u.instances.filter((i) => i.status === "running").length, 0)} campaigns running`,
        active: "units",
      },
      cards
        ? `<div class="grid-cards">${cards}</div>`
        : `<div class="card"><div class="empty">No unit has reported yet.</div></div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- one unit
  app.get("/ui/units/:unit", (c) => {
    const now = Date.now();
    const vs = views();
    const u = vs.find((x) => x.id === c.req.param("unit"));
    if (!u)
      return page(
        c,
        { title: "Not found", active: "units" },
        `<div class="card"><div class="empty">No such unit.</div></div>`,
        vs,
      );
    const t = csrf(c);
    const key = store.unitKey(u.id);
    const back = `/ui/units/${encodeURIComponent(u.id)}`;
    const others = vs.filter((x) => x.id !== u.id);
    const sup = u.supervisor as Record<string, unknown> | null;
    const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
    const ex = obj(sup?.export);
    const adv = sup?.advisors ? obj(sup.advisors) : null;
    const instances = u.instances
      .map((i) => {
        const st = instanceState(i);
        const champ = i.champion.filter((s) => !s.reopened).at(-1);
        const judged = i.attempts.filter((a) => a.verdict);
        const wins = judged.filter((a) => a.verdict === "win_confirmed").length;
        const inflight = i.attempts.filter((a) => !a.verdict).length;
        const a = i.agents;
        const kpis =
          i.mode === "research"
            ? (() => {
                const r = (i.research ?? {}) as Record<string, unknown>;
                return [
                  kpi("Verified claims", String(num(r.verified)), `${num(r.drafts)} drafts`),
                  kpi("Sources", String(num(r.sources)), `${num(r.domains)} domains`),
                  kpi("Hypotheses", String(num(r.hypotheses))),
                  kpi(
                    "Elapsed",
                    `${(num(r.elapsed_ms) / 3_600_000).toFixed(1)} h`,
                    num(r.min_ms) ? `of at least ${(num(r.min_ms) / 3_600_000).toFixed(0)} h` : "",
                  ),
                  kpi("Trials", String(a.trials), `${fmtInt(a.tokens_out)} tokens out`),
                ].join("");
              })()
            : [
                i.mode === "goal"
                  ? kpi(
                      "Goals met",
                      `${i.goals.filter((g) => g.status === "met").length}<span class="muted" style="font-size:14px"> / ${i.goals.length}</span>`,
                      `${i.goals.filter((g) => g.status === "unmet").length} unmet`,
                    )
                  : kpi(
                      "Gain",
                      pct((champ?.cumulative ?? 1) - 1, 1),
                      `champion seq ${champ?.seq ?? 1}`,
                      (champ?.cumulative ?? 1) > 1 ? "ok" : "",
                    ),
                kpi("Attempts", String(i.attempts.length), `${inflight} in flight`),
                ...(i.mode === "goal"
                  ? [
                      kpi(
                        "Progress",
                        String(num(i.verdicts.goal_progress)),
                        `${num(i.verdicts.goal_screened)} screened`,
                      ),
                      kpi(
                        "Invalid",
                        String(num(i.verdicts.invalid) + num(i.verdicts.rejected_v0)),
                        "refused or broken",
                      ),
                    ]
                  : [
                      kpi(
                        "Wins",
                        String(wins),
                        judged.length
                          ? `${Math.round((100 * wins) / judged.length)}% of judged`
                          : "",
                      ),
                      kpi(
                        "A/A noise",
                        i.calibration ? `${(i.calibration.sigma * 100).toFixed(2)}%` : "·",
                        "block σ",
                      ),
                    ]),
                kpi(
                  "Planner",
                  a.epochs ? `${Math.round((100 * a.planner_valid) / a.epochs)}%` : "·",
                  `${a.epochs} epochs valid`,
                ),
                kpi("Tokens", fmtInt(a.tokens_in + a.tokens_out), `${a.trials} trials`),
              ].join("");
        const goals = i.goals.length
          ? `<div class="card"><div class="card-head"><span class="title">Goals</span><span class="right muted small">latest validation</span></div><div style="margin-top:6px">${i.goals
              .map((g) => {
                const cls =
                  g.status === "met"
                    ? "ok"
                    : g.status === "unmet"
                      ? "bad"
                      : g.status === "not_runnable"
                        ? "off"
                        : "warn";
                const mark = g.status === "met" ? "✓" : g.status === "unmet" ? "✕" : "·";
                return `<div class="goal"><span class="gi ${cls}">${mark}</span><b>${esc(g.goal)}</b><span class="chip ${cls === "off" ? "" : cls}">${esc(g.status.replace(/_/g, " "))}</span><div class="why">${esc(g.reasons.slice(0, 400))}</div></div>`;
              })
              .join("")}</div></div>`
          : "";
        const research = i.research
          ? (() => {
              const r = i.research as Record<string, unknown>;
              const qs = Array.isArray(r.questions)
                ? (r.questions as { q?: unknown; verified?: unknown }[])
                : [];
              const most = Math.max(1, ...qs.map((q) => num(q.verified)));
              return `<div class="card"><div class="card-head"><span class="title">Research questions</span><span class="right muted small">${esc(String(r.kind ?? ""))} · ${esc(ago(String(r.at ?? ""), now))} ago</span></div><div class="stack" style="margin-top:10px">${
                qs
                  .map((q) =>
                    meter(
                      String(q.q ?? ""),
                      `${num(q.verified)} claims`,
                      num(q.verified) / most,
                      "ok",
                    ),
                  )
                  .join("") || `<div class="muted small">No question coverage yet.</div>`
              }</div>${num(r.unsupported_numbers) ? `<div class="note warn">${num(r.unsupported_numbers)} numbers in the report have no source.</div>` : ""}<details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">Latest report</summary><pre class="report" style="margin-top:8px">${esc(String(r.report ?? ""))}</pre></details></div>`;
            })()
          : "";
        const audits = i.audits.slice(-8).reverse();
        const steering = [
          audits.length
            ? `<div class="card flat"><table><thead><tr><th>Audit of</th><th>Why</th><th>Decision</th><th></th></tr></thead><tbody>${audits
                .map(
                  (
                    x,
                  ) => `<tr><td><code>${esc(x.attempt)}</code></td><td>${esc(x.reason)}</td><td class="${x.decision === "block" ? "bad" : x.decision ? "ok" : "warn"}">${esc(x.decision ?? "waiting for the auditor")}</td>
<td class="num">${x.decision === null || x.decision === "block" ? cmdForm(c, { unit: u.id, kind: "approve_promotion", fields: { instance: i.id, attempt: x.attempt }, label: "Override and approve", cls: "sm", back }) : ""}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : "",
          i.reviews.length
            ? `<div class="card flat"><table><thead><tr><th>Review</th><th>Goal</th><th>Panel</th><th>You</th><th></th></tr></thead><tbody>${i.reviews
                .slice(-8)
                .reverse()
                .map(
                  (
                    r,
                  ) => `<tr><td>${r.review}</td><td>${esc(r.goal)}</td><td>${esc(r.panel ?? "waiting")}</td><td>${esc(r.owner ?? "")}</td>
<td class="num">${r.panel === "review_passed" && !r.owner ? `${cmdForm(c, { unit: u.id, kind: "accept_review", fields: { instance: i.id, review: String(r.review), accept: "true" }, label: "Accept", cls: "sm primary", back })} ${cmdForm(c, { unit: u.id, kind: "accept_review", fields: { instance: i.id, review: String(r.review), accept: "false" }, label: "Reject", cls: "sm", back })}` : ""}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : "",
          ...i.conclusions
            .filter((x) => x.decision === null)
            .map(
              (
                k,
              ) => `<div class="card warn"><div class="card-head"><span class="title">End as not possible?</span></div><p class="small">${k.approaches} approach families refuted with receipts (proposal ${k.proposal}). Only you can accept it.</p>
<div class="row">${cmdForm(c, { unit: u.id, kind: "conclude", fields: { instance: i.id, proposal: String(k.proposal), accept: "true" }, label: "Accept: not possible", cls: "primary", back })}${cmdForm(c, { unit: u.id, kind: "conclude", fields: { instance: i.id, proposal: String(k.proposal), accept: "false" }, label: "Reject: keep going", back })}</div></div>`,
            ),
          i.propagations.length
            ? `<div class="card flat"><table><thead><tr><th>Propagated from</th><th>Attempt here</th><th>Result here</th></tr></thead><tbody>${i.propagations
                .slice(-8)
                .reverse()
                .map(
                  (p) =>
                    `<tr><td>${esc(p.source_unit)} / ${esc(p.source_instance)} seq ${p.source_seq}</td><td><code>${esc(p.attempt ?? "")}</code></td><td class="${p.result === "accepted" ? "ok" : p.result.startsWith("rejected") ? "bad" : "muted"}">${esc(p.result)}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : "",
        ]
          .filter(Boolean)
          .join("");
        const pending = i.pending_promotions
          .map(
            (p) =>
              `<div class="card warn"><div class="card-head">${icon.warn}<span class="title">Promotion waiting for approval</span><span class="right">${cmdForm(c, { unit: u.id, kind: "approve_promotion", fields: { instance: i.id, attempt: p }, label: "Approve", cls: "primary", back })}</span></div><div class="small" style="margin-top:6px"><code>${esc(p)}</code> ${esc(i.attempts.find((x) => x.id === p)?.hypothesis ?? "")}</div></div>`,
          )
          .join("");
        const propagate =
          i.published && others.length
            ? `<form class="inline" method="post" action="/ui/propagate"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="unit" value="${esc(u.id)}"><input type="hidden" name="instance" value="${esc(i.id)}"><select name="target">${others
                .flatMap((o) =>
                  o.instances
                    .filter((x) => x.campaign === i.campaign)
                    .map(
                      (x) =>
                        `<option value="${esc(`${o.id}|${x.id}`)}">${esc(o.id)} / ${esc(x.id)}</option>`,
                    ),
                )
                .join("")}</select><button>Propagate seq ${i.published.seq}</button></form>`
            : "";
        const steer = `<div class="card"><div class="card-head"><span class="title">Steer</span><span class="right muted small">${i.directives} directive${i.directives === 1 ? "" : "s"} in force</span></div>
<div class="row wrap" style="margin-top:10px">
${i.status === "paused" ? cmdForm(c, { unit: u.id, kind: "resume_instance", fields: { instance: i.id }, label: "Resume", cls: "primary", back }) : cmdForm(c, { unit: u.id, kind: "pause_instance", fields: { instance: i.id }, extra: `<input name="reason" placeholder="reason (optional)" style="width:160px">`, label: "Pause", back })}
${cmdForm(c, { unit: u.id, kind: "reset_workers", fields: { instance: i.id }, label: "Reset workers", back })}
<a class="btn" href="/ui/units/${encodeURIComponent(u.id)}/live">${icon.terminal}Live sessions</a>
${propagate}</div>
<form class="inline" method="post" action="/ui/commands" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="unit" value="${esc(u.id)}"><input type="hidden" name="instance" value="${esc(i.id)}"><input type="hidden" name="kind" value="redirect"><input type="hidden" name="back" value="${esc(back)}">
<select name="directive"><option value="avoid">avoid</option><option value="try">try</option><option value="mandate">mandate</option></select>
<input name="family" placeholder="direction family" required style="width:160px"><input name="rationale" placeholder="why, with a citation" required style="width:220px">
<label class="muted small row"><input type="checkbox" name="add" value="1" style="height:auto"> add to my directives</label><button>Redirect</button></form></div>`;
        const attempts = [...i.attempts]
          .reverse()
          .slice(0, 100)
          .map(
            (x) =>
              `<tr><td><code>${esc(x.id)}</code></td><td>${x.lane ? `<span class="chip">${esc(x.lane)}</span>` : ""}</td><td class="clip">${esc(x.hypothesis ?? "")}</td><td>${verdictChip(x.verdict, x.lifecycle)}</td><td class="num">${deltaCell(x.delta)}</td><td class="num muted">${esc(ago(x.updated_at, now))}</td></tr>`,
          )
          .join("");
        return `<section class="block" id="${esc(i.id)}">
<div class="card-head" style="margin-bottom:12px">${modeAvatar(i.mode)}<div class="grow"><span class="title" style="font-size:15px">${esc(i.id)}</span> <span class="muted small">${esc(i.campaign ?? "")} · ${esc(modeName(i.mode))}${i.seed_repo ? ` · ${esc(i.seed_repo)}` : ""}</span>${i.pause_reason ? `<div class="muted xs">${esc(i.pause_reason)}</div>` : ""}</div><span class="right label ${st.cls}">${st.icon}${esc(st.text)}</span></div>
${pending}<div class="kpis" style="margin-bottom:12px">${kpis}</div>
${i.mode === "hill_climb" ? `<div class="card"><div class="card-head"><span class="title">Champion gain</span><span class="right muted small">over the baseline, measured on this unit</span></div><div style="margin-top:8px">${gainChart(i)}</div></div>` : ""}
${goals}${research}
${i.attempts.length ? `<div class="card"><div class="card-head"><span class="title">Verdicts</span><span class="right muted small">${i.attempts.length} attempts</span></div><div style="margin-top:10px">${stackBar(i.verdicts)}</div></div>` : ""}
${steering ? `<div class="stack" style="margin-top:12px">${steering}</div>` : ""}
<div style="margin-top:12px">${steer}</div>
${attempts ? `<div class="card flat" style="margin-top:12px"><table><thead><tr><th>Attempt</th><th>Lane</th><th>Hypothesis</th><th>Verdict</th><th class="num">Δ</th><th class="num">Updated</th></tr></thead><tbody>${attempts}</tbody></table></div>` : ""}
</section>`;
      })
      .join("");
    const events = [...u.recent]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 30)
      .map(
        (e) =>
          `<div class="li"><span class="t">${esc(ago(e.at, now))}</span><span class="grow clip">${esc(e.kind.replace(/_/g, " "))}</span><span class="right"><code class="muted">${esc(e.subject ?? "")}</code></span></div>`,
      )
      .join("");
    const keyCard = key.pending
      ? `<div class="card warn" style="margin-bottom:16px"><div class="card-head">${icon.key}<span class="title">${key.pubkey ? "This unit now signs its reports with a different key" : "This unit's first report key waits for your acceptance"}</span></div>
<p class="small">Its reports are refused until you accept the key. A full reset keeps a unit's key: a change is expected only when the unit's identity was rebuilt on purpose. Check the fingerprint with the unit's deployment before accepting.</p>
<div class="row"><code>${esc(fingerprint(key.pending))}</code><span class="grow"></span><form class="inline" method="post" action="/ui/units/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="fingerprint" value="${esc(fingerprint(key.pending))}"><button class="primary">Accept this key</button></form></div></div>`
      : "";
    const actions = `<a class="btn" href="/ui/units/${encodeURIComponent(u.id)}/live">${icon.terminal}Live</a>
${cmdForm(c, { unit: u.id, kind: "export_now", label: "Export now", back })}
<details class="menu"><summary class="btn">${icon.dots}</summary><div class="menu-body">
${opts.driver ? `<form method="post" action="/ui/units/${encodeURIComponent(u.id)}/restart"><input type="hidden" name="csrf" value="${t}"><button style="width:100%;justify-content:center">Restart the unit's containers</button></form>` : `<div class="muted small">No deployment driver: restarts are not available.</div>`}
<div class="divider" style="margin:2px 0"></div>
<form method="post" action="/ui/units/${encodeURIComponent(u.id)}/reset" class="stack" style="gap:8px"><input type="hidden" name="csrf" value="${t}">
<div class="small"><b>Full reset.</b> <span class="muted">Pause, export, verify the push, then wipe after your confirmation.</span></div>
<input name="confirm" placeholder="type: reset ${esc(u.id)}"><button class="danger" style="justify-content:center">Start the full reset</button></form></div></details>`;
    return page(
      c,
      {
        title: u.id,
        crumbs: [{ href: "/ui/units", text: "Units" }],
        summary: `${u.stale ? `<span class="bad">stale</span> · last report ${esc(ago(u.last_seen, now))} ago` : `<span class="ok">live</span> · reported ${esc(ago(u.last_seen, now))} ago`} · key <code>${esc(key.pubkey ? fingerprint(key.pubkey) : "not pinned")}</code>`,
        actions,
        active: "units",
      },
      `${keyCard}<div class="cols"><div>${instances || `<div class="card"><div class="empty">No campaign assigned.</div></div>`}</div>
<div><div class="block"><div class="head"><h2>Unit</h2></div><div class="card"><div class="stack" style="gap:10px">
${meter("Judge", `${num(u.jobs.leased)} running · ${num(u.jobs.queued)} queued`, (num(u.jobs.leased) + num(u.jobs.queued)) / Math.max(4, num(u.jobs.leased) + num(u.jobs.queued)), "primary")}
<div class="small"><span class="muted">Ledger</span> <code>${esc(u.ledger_id ?? "")}</code></div>
${
  sup
    ? `<div class="small"><span class="muted">Results</span> ${num(ex.exports)} exports${ex.remote === true ? ` · <span title="${esc(ex.last_push_at ?? "")}">pushed ${esc(ago(String(ex.last_push_at ?? ""), now) || "?")} ago</span>` : " · no results repository"}${ex.last_error ? `<div class="bad xs">${esc(String(ex.last_error).slice(0, 300))}</div>` : ""}</div>
<div class="small"><span class="muted">Advisors</span> ${adv ? `${num(adv.teacher_runs)} teacher rounds · ${num(adv.directive_sets)} directive sets · ${num(adv.audits)} audits · ${num(adv.errors)} errors · $${num(adv.usd).toFixed(2)}` : "none configured"}</div>
<div class="muted xs">The supervisor reports these figures itself (unsigned).</div>`
    : ""
}
</div></div></div>
<div class="block"><div class="head"><h2>Activity</h2></div><div class="card flat"><div class="list">${events || `<div class="empty">No events.</div>`}</div></div></div></div></div>`,
      vs,
    );
  });

  app.post("/ui/units/:unit/key/accept", async (c) => {
    const f = await c.req.parseBody();
    // Only the key whose fingerprint the owner saw: a key swapped in meanwhile is not accepted.
    store.acceptPendingKey(c.req.param("unit"), "owner:ui", String(f.fingerprint ?? ""));
    return c.redirect(`/ui/units/${encodeURIComponent(c.req.param("unit"))}`, 303);
  });

  // ---------------------------------------------------------------- live sessions (Magnesium's Session)
  app.get("/ui/live", (c) => {
    const vs = views();
    const now = Date.now();
    const rows = vs
      .map((u) => {
        const srcs = store.liveSources(u.id);
        return `<a class="card tight row" style="text-decoration:none" href="/ui/units/${encodeURIComponent(u.id)}/live"><span class="dot ${u.stale ? "bad" : "ok"}"></span><b>${esc(u.id)}</b><span class="muted small grow">${srcs.length ? `${srcs.length} sessions · last line ${esc(ago(srcs[0]?.last_at, now))} ago` : "no live lines yet"}</span>${icon.terminal}</a>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Live",
        summary: "what each unit's agents and judge are doing now",
        active: "live",
        refresh: 10,
      },
      rows
        ? `<div class="stack" style="max-width:720px">${rows}</div>`
        : `<div class="card"><div class="empty">No unit has reported yet.</div></div>`,
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

  app.get("/ui/units/:unit/live", (c) => {
    const vs = views();
    const now = Date.now();
    const u = vs.find((x) => x.id === c.req.param("unit"));
    if (!u)
      return page(
        c,
        { title: "Not found", active: "live" },
        `<div class="card"><div class="empty">No such unit.</div></div>`,
        vs,
      );
    const sources = store.liveSources(u.id);
    const source = c.req.query("source") || "";
    const sel = sources.find((x) => x.source === source);
    const lines = store.liveTail(u.id, 400, source || undefined);
    const after = lines.at(-1)?.id ?? 0;
    const ended = new Map(sources.map((x) => [x.source, x.ended]));
    const list = [
      `<a class="side-row${source ? "" : " on"}" href="/ui/units/${encodeURIComponent(u.id)}/live">${icon.live}<span class="two"><span class="name"><b>Everything</b></span><span class="muted xs">all sessions, interleaved</span></span></a>`,
      ...sources.map(
        (s) =>
          `<a class="side-row${s.source === source ? " on" : ""}" href="/ui/units/${encodeURIComponent(u.id)}/live?source=${encodeURIComponent(s.source)}">${sourceAvatar(s.source)}<span class="two"><span class="name"><b>${esc(sourceName(s.source, s.lane))}</b></span><span class="muted xs clip">${esc([s.source.startsWith("trial:") ? s.source.slice(6) : (s.instance ?? ""), `${ago(s.last_at, now)} ago`].filter(Boolean).join(" · "))}</span></span>${s.source.startsWith("trial:") ? `<span class="right">${ended.get(s.source) ? `<span class="muted xs">ended</span>` : `<span class="label info xs"><span class="dot info pulse"></span>working</span>`}</span>` : ""}</a>`,
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
    const running = u.instances.filter((i) => i.status === "running");
    const inst =
      (sel?.instance && u.instances.find((i) => i.id === sel.instance)) ||
      running[0] ||
      u.instances[0];
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
          ? `<div class="composer off">No campaign on this unit: nothing to message.</div>`
          : `<form class="composer" method="post" action="/ui/units/${encodeURIComponent(u.id)}/message"><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="source" value="${esc(source)}">
<textarea name="text" required maxlength="4000" placeholder="Message ${esc(targets[0]?.label ?? "an agent")}…  (⌘/Ctrl+Enter to send)"></textarea>
<div class="bar2"><select name="to">${targets.map((x) => `<option value="${esc(x.to)}">${esc(x.label)}</option>`).join("")}</select>
<select name="instance">${u.instances.map((i) => `<option value="${esc(i.id)}"${i.id === inst.id ? " selected" : ""}>${esc(i.id)}</option>`).join("")}</select>
<span class="hint grow">A signed owner command. Workers get it after their current turn.</span><button class="primary" aria-label="Send">${icon.send}</button></div></form>`;
    const title = source ? sourceName(source, sel?.lane) : "Everything";
    return page(
      c,
      {
        title,
        crumbs: [
          { href: "/ui/live", text: "Live" },
          { href: `/ui/units/${encodeURIComponent(u.id)}`, text: u.id },
        ],
        summary: source.startsWith("trial:")
          ? `${esc(source.slice(6))}${sel?.instance ? ` · ${esc(sel.instance)}` : ""}`
          : source === "supervisor"
            ? "relayed by the supervisor, unsigned"
            : `${sources.length} sessions`,
        active: "live",
        flush: true,
        refresh: 0,
      },
      `<aside class="sessions"><div class="section" style="margin-top:4px">Sessions</div>${list}</aside>
<div class="transcript-wrap"><div class="transcript" id="transcript" data-unit="${esc(u.id)}" data-source="${esc(source)}" data-after="${after}">${out.join("") || `<div class="empty">No live lines yet. They appear here as the unit's agents and judge work.</div>`}</div>${composer}</div>`,
      vs,
    );
  });

  app.get("/ui/units/:unit/live.json", (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    return c.json({
      entries: store.live(c.req.param("unit"), after, 500, c.req.query("source") || undefined),
    });
  });

  app.post("/ui/units/:unit/message", async (c) => {
    const unit = c.req.param("unit");
    const f = await c.req.parseBody();
    const source = String(f.source ?? "");
    try {
      issueCommand(store, opts.privateKeyPem, {
        unit,
        kind: "message_agent",
        payload: {
          instance: String(f.instance ?? ""),
          to: String(f.to ?? ""),
          text: String(f.text ?? "").trim(),
        },
        issuedBy: "owner:ui",
      });
    } catch (err) {
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    return c.redirect(
      `/ui/units/${encodeURIComponent(unit)}/live${source ? `?source=${encodeURIComponent(source)}` : ""}`,
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
        return `<tr><td class="muted nowrap">${esc(ago(x.issued_at, now))} ago</td><td>${esc(x.unit)}</td><td><b>${esc(x.kind.replace(/_/g, " "))}</b></td><td class="muted">${esc(x.issued_by)}</td><td><span class="chip ${cls}">${esc(x.status)}</span></td><td class="clip"><code class="muted">${esc(JSON.stringify(x.outcome ?? "").slice(0, 200))}</code></td></tr>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Commands",
        summary: "every signed command control issued, newest first",
        active: "commands",
      },
      `<div class="card flat"><table><thead><tr><th>Issued</th><th>Unit</th><th>Kind</th><th>By</th><th>Status</th><th>Outcome</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty">No command yet.</td></tr>`}</tbody></table></div>`,
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
        return `<div class="block"><div class="head"><h2>${esc(campaign)}</h2><span class="n">${rows.length} unit${rows.length > 1 ? "s" : ""}</span></div><div class="card flat"><table><thead><tr><th style="width:40px">#</th><th>Unit / instance</th><th>Champion</th><th style="width:40%">Gain over its baseline</th><th>Cross-verified</th></tr></thead><tbody>${rows
          .map(
            (r, n) =>
              `<tr><td class="muted">${n + 1}</td><td>${avatar(r.unit)} <a href="/ui/units/${encodeURIComponent(r.unit)}#${encodeURIComponent(r.instance)}"><b>${esc(r.unit)}</b> / ${esc(r.instance)}</a></td><td class="muted">seq ${r.champion_seq}</td><td>${meter("", pct(r.gain, 2), r.gain / best, "primary")}</td>
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
          "gains against each instance's own baseline, measured on its own unit; cross-verified once another unit's judge accepted it",
        active: "leaderboard",
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
          `<tr><td><b>${esc(r.unit)}</b></td><td><span class="chip ${String(r.state) === "done" ? "ok" : String(r.state) === "failed" ? "bad" : "warn"}">${esc(r.state)}</span></td><td class="clip">${esc(r.detail ?? "")}</td><td class="muted nowrap">${esc(ago(String(r.updated_at), now))} ago</td>
<td class="num">${String(r.state) === "awaiting_owner" ? act(r.id, "confirm", "Confirm the wipe", true) : ""} ${["start", "quiescing", "exporting", "verifying", "awaiting_owner"].includes(String(r.state)) ? act(r.id, "cancel", "Cancel") : ""}</td></tr>`,
      )
      .join("");
    const rows = store
      .reports(30)
      .map(
        (r) =>
          `<div class="card"><div class="card-head">${avatar(r.unit)}<span class="title">${esc(r.unit)}</span><span class="sub">${esc(r.kind)} report</span><span class="right muted small">${esc(ago(r.at, now))} ago</span></div><pre class="report" style="margin-top:10px">${esc(r.body)}</pre></div>`,
      )
      .join("");
    return page(
      c,
      {
        title: "Reports",
        summary: "daily reports from each unit's supervisor, and full resets",
        active: "reports",
      },
      `${resets ? `<div class="block"><div class="head"><h2>Full resets</h2></div><div class="card flat"><table><thead><tr><th>Unit</th><th>State</th><th>Detail</th><th>Updated</th><th></th></tr></thead><tbody>${resets}</tbody></table></div></div>` : ""}
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
    const [toUnit, toInstance] = String(f.target ?? "").split("|");
    try {
      propagateChampion(store, opts.privateKeyPem, {
        fromUnit: String(f.unit),
        instance: String(f.instance),
        toUnit: String(toUnit),
        toInstance: String(toInstance),
        issuedBy: "owner:ui",
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    return c.redirect(`/ui/units/${encodeURIComponent(String(toUnit))}`, 303);
  });

  app.post("/ui/units/:unit/restart", async (c) => {
    const unit = c.req.param("unit");
    if (!opts.driver) return c.text("no deployment driver is configured", 409);
    store.audit("owner:ui", "restart", { unit });
    try {
      await opts.driver.restart(unit, ["harness", "supervisor"]);
    } catch (err) {
      return c.text(`restart failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    return c.redirect(`/ui/units/${encodeURIComponent(unit)}`, 303);
  });

  app.post("/ui/units/:unit/reset", async (c) => {
    const unit = c.req.param("unit");
    const f = await c.req.parseBody();
    if (String(f.confirm ?? "") !== `reset ${unit}`)
      return c.text(`type "reset ${unit}" to confirm a full reset`, 400);
    try {
      store.createReset(unit, "owner:ui");
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

  app.post("/ui/commands", async (c) => {
    const f = await c.req.parseBody();
    const kind = String(f.kind) as CommandKind;
    if (!COMMAND_KINDS.includes(kind)) return c.text("unknown command", 400);
    const instance = String(f.instance ?? "");
    const payloads: Partial<Record<CommandKind, unknown>> = {
      pause_instance: { instance, reason: String(f.reason || "paused from the dashboard") },
      resume_instance: { instance },
      reset_workers: { instance },
      export_now: {},
      approve_promotion: { instance, attempt: String(f.attempt ?? "") },
      accept_review: { instance, review: Number(f.review), accept: f.accept === "true" },
      conclude: { instance, proposal: Number(f.proposal), accept: f.accept === "true" },
      redirect: {
        instance,
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
        unit: String(f.unit),
        kind,
        payload: payloads[kind],
        issuedBy: "owner:ui",
      });
    } catch (err) {
      return c.text(`refused: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    return c.redirect(backTo(f, `/ui/units/${encodeURIComponent(String(f.unit))}`), 303);
  });

  return app;
}
