import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { COMMAND_KINDS, type CommandKind } from "../core/commands.ts";
import { issueCommand, propagateChampion } from "./issue.ts";
import { advanceResets, type DeploymentDriver } from "./lifecycle.ts";
import { type ControlStore, fingerprint } from "./store.ts";
import { type InstanceView, leaderboard, type UnitView, unitView } from "./views.ts";

/**
 * The control dashboard: server-rendered pages over control's store, with forms that issue
 * signed commands. Login takes the admin token once and keeps a random session in an HttpOnly,
 * SameSite=Strict cookie; every form carries a token derived from the session (CSRF).
 */

const SESSION_MS = 12 * 3_600_000;

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 120
    ? `${s}s ago`
    : s < 7200
      ? `${Math.round(s / 60)}m ago`
      : `${Math.round(s / 3600)}h ago`;
};

const STYLE = `
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --line:#dcdcd6; --card:#ffffff;
  --accent:#b4441c; --ok:#2e7d32; --warn:#b26a00; --bad:#b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ececea; --muted:#a3a39c;
  --line:#33332f; --card:#1e1e1c; --accent:#e0703f; --ok:#66bb6a; --warn:#ffb74d; --bad:#ef5350; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
header { display:flex; gap:16px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); }
header b { color:var(--accent); letter-spacing:.02em; }
header a { color:var(--fg); text-decoration:none; }
main { padding:16px; max-width:1200px; margin:0 auto; }
h1 { font-size:20px; margin:4px 0 12px; } h2 { font-size:16px; margin:20px 0 8px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:10px 0; overflow-x:auto; }
table { border-collapse:collapse; width:100%; } th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; }
.muted { color:var(--muted); } .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid var(--line); font-size:12px; margin:0 4px 4px 0; }
form.inline { display:inline-flex; gap:6px; align-items:center; flex-wrap:wrap; margin:4px 0; }
input, select, button { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); }
button { cursor:pointer; } button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
code { font-size:12px; } svg text { fill:var(--muted); font-size:11px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Thermite</title>
<style>${STYLE}</style></head><body><header><b>THERMITE</b><a href="/ui">Units</a><a href="/ui/leaderboard">Leaderboard</a>
<a href="/ui/reports">Reports</a><a href="/ui/commands">Commands</a>
<a href="/ui/audit">Audit</a><form method="post" action="/ui/logout" style="margin-left:auto"><button>Log out</button></form>
</header><main>${body}</main></body></html>`;
}

/** Cumulative relative gain of the champion over time, as inline SVG. */
function chart(v: InstanceView): string {
  const steps = v.champion.filter((c) => !c.reopened);
  if (steps.length < 2) return `<p class="muted">No promotions yet: the champion is the seed.</p>`;
  const w = 640;
  const h = 180;
  const pad = 36;
  const ts = steps.map((s) => Date.parse(s.at));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts, t0 + 1);
  const ys = steps.map((s) => s.cumulative - 1);
  const y0 = Math.min(0, ...ys);
  const y1 = Math.max(...ys, y0 + 0.001);
  const X = (t: number) => pad + ((t - t0) / (t1 - t0)) * (w - 2 * pad);
  const Y = (y: number) => h - pad + ((y0 - y) / (y1 - y0)) * (h - 2 * pad);
  let d = "";
  steps.forEach((_s, i) => {
    const x = X(ts[i] as number);
    const y = Y(ys[i] as number);
    d += i === 0 ? `M${x},${y}` : ` H${x} V${y}`;
  });
  const dots = steps
    .map(
      (s, i) =>
        `<circle cx="${X(ts[i] as number)}" cy="${Y(ys[i] as number)}" r="3" fill="var(--accent)"><title>seq ${s.seq} ${pct(s.cumulative - 1)}</title></circle>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" role="img" aria-label="champion gain over time">
<line x1="${pad}" x2="${w - pad}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--line)"/>
<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/>${dots}
<text x="${pad}" y="${h - 8}">${esc(new Date(t0).toISOString().slice(0, 16))}</text>
<text x="${w - pad}" y="${h - 8}" text-anchor="end">${esc(new Date(t1).toISOString().slice(0, 16))}</text>
<text x="4" y="${Y(y1) + 4}">${pct(y1)}</text><text x="4" y="${Y(0) + 4}">0%</text></svg>`;
}

/** Agents' figures for M4: planner quality, duplicates, effort. */
function agentsLine(v: InstanceView): string {
  const a = v.agents;
  if (!a.epochs && !a.trials) return "";
  const ratio = (x: number, n: number) => (n ? `${Math.round((100 * x) / n)}%` : "n/a");
  return `<p class="muted">Agents: ${a.epochs} epochs, planner valid ${ratio(a.planner_valid, a.epochs)}, fallbacks ${a.fallbacks}, epochs with directive violations ${a.epochs_with_violations}; ${a.trials} trials, ${a.submitted} submissions, duplicates ${ratio(a.duplicates, a.attempts)}; tokens ${a.tokens_in.toLocaleString()} in / ${a.tokens_out.toLocaleString()} out</p>`;
}

function goalsTable(v: InstanceView): string {
  if (!v.goals.length) return "";
  const cls = (s: string) => (s === "met" ? "ok" : s === "unmet" ? "bad" : "warn");
  return `<table><tr><th>Goal</th><th>Status</th><th>Why</th></tr>${v.goals
    .map(
      (g) =>
        `<tr><td>${esc(g.goal)}</td><td class="${cls(g.status)}">${esc(g.status)}</td><td>${esc(g.reasons.slice(0, 300))}</td></tr>`,
    )
    .join("")}</table>`;
}

function researchBlock(v: InstanceView): string {
  const r = v.research;
  if (!r) return "";
  const n = (k: string) => Number(r[k] ?? 0);
  const elapsed = (n("elapsed_ms") / 3_600_000).toFixed(2);
  return `<p class="muted">Research (${esc(r.kind)}, ${esc(String(r.at ?? "").slice(0, 16))}): ${elapsed} h elapsed; ${n("sources")} sources from ${n("domains")} domains; ${n("verified")} verified claims, ${n("drafts")} drafts; ${n("hypotheses")} hypotheses${n("unsupported_numbers") ? `; <span class="warn">${n("unsupported_numbers")} numbers without a source</span>` : ""}</p>
<details><summary>Latest report</summary><pre style="white-space:pre-wrap">${esc(String(r.report ?? ""))}</pre></details>`;
}

function supervisorLine(u: UnitView): string {
  const s = u.supervisor as {
    export?: {
      remote?: boolean;
      exports?: number;
      last_push_at?: string | null;
      last_error?: string | null;
    };
    advisors?: {
      teacher_runs: number;
      directive_sets: number;
      audits: number;
      reviews: number;
      errors: number;
      usd: number;
    } | null;
  } | null;
  if (!s) return "";
  const e = s.export;
  const a = s.advisors;
  return `<p class="muted">Supervisor: ${e ? `${e.exports ?? 0} exports, ${e.remote ? `last push ${esc(e.last_push_at ?? "never")}` : "no results repository"}${e.last_error ? `, <span class="bad">${esc(e.last_error)}</span>` : ""}` : ""}${
    a
      ? `; advisors: ${a.teacher_runs} teacher rounds, ${a.directive_sets} directive sets, ${a.audits} audits, ${a.reviews} reviews, ${a.errors} errors, $${a.usd.toFixed(2)}`
      : "; no advisors configured"
  }</p>`;
}

function verdictPills(v: InstanceView): string {
  return Object.entries(v.verdicts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<span class="pill">${esc(k)} ${n}</span>`)
    .join("");
}

export interface DashboardOptions {
  adminToken: string;
  privateKeyPem: string;
  staleAfterMs: number;
  driver?: DeploymentDriver | undefined;
}

/** Audits, reviews, "not possible" proposals and propagation for one instance (M5). */
function steeringBlock(
  v: InstanceView,
  form: (kind: string, fields: Record<string, string>, label: string, primary?: boolean) => string,
): string {
  const parts: string[] = [];
  const audits = v.audits.slice(-10).reverse();
  if (audits.length) {
    parts.push(
      `<table><tr><th>Audit of</th><th>Why</th><th>Decision</th><th></th></tr>${audits
        .map(
          (a) => `<tr><td><code>${esc(a.attempt)}</code></td><td>${esc(a.reason)}</td>
<td class="${a.decision === "block" ? "bad" : a.decision ? "ok" : "warn"}">${esc(a.decision ?? "waiting for the auditor")}</td>
<td>${a.decision === null || a.decision === "block" ? form("approve_promotion", { attempt: a.attempt }, "Override and approve") : ""}</td></tr>`,
        )
        .join("")}</table>`,
    );
  }
  const reviews = v.reviews.slice(-10).reverse();
  if (reviews.length) {
    parts.push(
      `<table><tr><th>Review</th><th>Goal</th><th>Panel</th><th>Owner</th><th></th></tr>${reviews
        .map(
          (
            r,
          ) => `<tr><td>${r.review}</td><td>${esc(r.goal)}</td><td>${esc(r.panel ?? "waiting")}</td><td>${esc(r.owner ?? "")}</td>
<td>${r.panel === "review_passed" && !r.owner ? `${form("accept_review", { review: String(r.review), accept: "true" }, "Accept", true)}${form("accept_review", { review: String(r.review), accept: "false" }, "Reject")}` : ""}</td></tr>`,
        )
        .join("")}</table>`,
    );
  }
  for (const c of v.conclusions.filter((x) => x.decision === null)) {
    parts.push(
      `<div class="card warn">The harness proposes ending this campaign as <b>not possible</b>: ${c.approaches} approach families refuted with receipts (proposal ${c.proposal}). Only you can accept it.
${form("conclude", { proposal: String(c.proposal), accept: "true" }, "Accept: not possible", true)}${form("conclude", { proposal: String(c.proposal), accept: "false" }, "Reject: keep going")}</div>`,
    );
  }
  if (v.propagations.length) {
    parts.push(
      `<table><tr><th>Propagated from</th><th>Attempt here</th><th>Result here</th></tr>${v.propagations
        .slice(-10)
        .reverse()
        .map(
          (p) =>
            `<tr><td>${esc(p.source_unit)} / ${esc(p.source_instance)} seq ${p.source_seq}</td><td><code>${esc(p.attempt ?? "")}</code></td><td>${esc(p.result)}</td></tr>`,
        )
        .join("")}</table>`,
    );
  }
  return parts.join("");
}

export function createDashboard(store: ControlStore, opts: DashboardOptions): Hono {
  const app = new Hono();
  const secret = randomBytes(32);
  const sessions = new Map<string, number>();
  const csrfOf = (sid: string) => createHmac("sha256", secret).update(sid).digest("hex");
  // biome-ignore lint/suspicious/noExplicitAny: any route's context
  const sessionOf = (c: Context<any, any, any>) => {
    const sid = getCookie(c, "thermite_session");
    const until = sid ? sessions.get(sid) : undefined;
    return sid && until && until > Date.now() ? sid : undefined;
  };
  const sameBytes = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  app.get("/ui/login", (c) =>
    c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Thermite</title><style>${STYLE}</style></head><body><main><h1>Thermite control</h1>
<form class="card" method="post" action="/ui/login"><label>Admin token <input type="password" name="token" autofocus></label>
<button class="primary">Sign in</button></form></main></body></html>`,
    ),
  );
  app.post("/ui/login", async (c) => {
    const form = await c.req.parseBody();
    const token = String(form.token ?? "");
    if (!sameBytes(token, opts.adminToken)) return c.redirect("/ui/login", 303);
    const sid = randomBytes(24).toString("base64url");
    sessions.set(sid, Date.now() + SESSION_MS);
    setCookie(c, "thermite_session", sid, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/ui",
      maxAge: SESSION_MS / 1000,
      secure: new URL(c.req.url).protocol === "https:",
    });
    store.audit("owner:ui", "login", {});
    return c.redirect("/ui", 303);
  });

  // Everything else needs a session.
  app.use("/ui/*", async (c, next) => {
    if (c.req.path === "/ui/login") return next();
    const sid = sessionOf(c);
    if (!sid) return c.redirect("/ui/login", 303);
    if (c.req.method === "POST") {
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

  // biome-ignore lint/suspicious/noExplicitAny: any route's context
  const csrf = (c: Context<any, any, any>) => csrfOf(sessionOf(c) ?? "");
  const views = (): UnitView[] =>
    store
      .units()
      .map((u) => unitView(store, u.id, { staleAfterMs: opts.staleAfterMs }))
      .filter((v): v is UnitView => v !== undefined);

  app.get("/ui", (c) => {
    const now = Date.now();
    const vs = views();
    const rows = vs
      .map((u) => {
        const inst = u.instances
          .map((i) => {
            const champ = i.champion.filter((s) => !s.reopened).at(-1);
            return `<a href="/ui/units/${encodeURIComponent(u.id)}#${encodeURIComponent(i.id)}">${esc(i.id)}</a>
<span class="muted">${esc(i.mode)} · ${esc(i.status)} · champion ${champ?.seq ?? 1} (${pct((champ?.cumulative ?? 1) - 1)})</span>`;
          })
          .join("<br>");
        return `<tr><td><a href="/ui/units/${encodeURIComponent(u.id)}"><b>${esc(u.id)}</b></a></td>
<td class="${u.stale ? "bad" : "ok"}">${u.stale ? "stale" : "live"}</td><td>${esc(ago(u.last_seen, now))}</td>
<td>${inst || '<span class="muted">no campaign</span>'}</td>
<td>${Object.entries(u.jobs)
          .map(([k, n]) => `<span class="pill">${esc(k)} ${n}</span>`)
          .join("")}</td></tr>`;
      })
      .join("");
    const pending = vs.flatMap((u) =>
      u.instances.flatMap((i) =>
        i.pending_promotions.map((a) => ({ unit: u.id, instance: i.id, attempt: a })),
      ),
    );
    const pendingHtml = pending.length
      ? `<h2>Promotions waiting for approval</h2><div class="card"><table><tr><th>Unit</th><th>Instance</th><th>Attempt</th><th></th></tr>${pending
          .map(
            (
              p,
            ) => `<tr><td>${esc(p.unit)}</td><td>${esc(p.instance)}</td><td><code>${esc(p.attempt)}</code></td><td>
<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${csrf(c)}">
<input type="hidden" name="unit" value="${esc(p.unit)}"><input type="hidden" name="kind" value="approve_promotion">
<input type="hidden" name="instance" value="${esc(p.instance)}"><input type="hidden" name="attempt" value="${esc(p.attempt)}">
<button class="primary">Approve</button></form></td></tr>`,
          )
          .join("")}</table></div>`
      : "";
    const held = vs.flatMap((u) =>
      u.instances.flatMap((i) =>
        i.audits
          .filter((a) => a.decision === null || a.decision === "block")
          .map((a) => ({ unit: u.id, instance: i.id, ...a })),
      ),
    );
    const heldHtml = held.length
      ? `<h2>Held by audits</h2><div class="card"><table><tr><th>Unit</th><th>Instance</th><th>Attempt</th><th>Why</th><th>State</th></tr>${held
          .map(
            (h) =>
              `<tr><td>${esc(h.unit)}</td><td>${esc(h.instance)}</td><td><code>${esc(h.attempt)}</code></td><td>${esc(h.reason)}</td><td class="${h.decision ? "bad" : "warn"}">${h.decision ? "blocked by the auditor" : "waiting for the auditor"}</td></tr>`,
          )
          .join("")}</table></div>`
      : "";
    return c.html(
      page(
        "Units",
        `<h1>Units</h1><div class="card"><table><tr><th>Unit</th><th>State</th><th>Last report</th><th>Campaign instances</th><th>Jobs</th></tr>${
          rows || '<tr><td colspan="5" class="muted">No unit has reported yet.</td></tr>'
        }</table></div>${pendingHtml}${heldHtml}`,
      ),
    );
  });

  app.get("/ui/units/:unit", (c) => {
    const now = Date.now();
    const u = unitView(store, c.req.param("unit"), { staleAfterMs: opts.staleAfterMs });
    if (!u) return c.html(page("Not found", "<h1>No such unit</h1>"), 404);
    const t = csrf(c);
    const key = store.unitKey(u.id);
    const hidden = (inst: string) =>
      `<input type="hidden" name="csrf" value="${t}"><input type="hidden" name="unit" value="${esc(u.id)}"><input type="hidden" name="instance" value="${esc(inst)}">`;
    const others = views().filter((x) => x.id !== u.id);
    const instances = u.instances
      .map((i) => {
        const attempts = [...i.attempts]
          .reverse()
          .slice(0, 100)
          .map(
            (
              a,
            ) => `<tr><td><code>${esc(a.id)}</code></td><td>${esc(a.lane ?? "")}</td><td>${esc(a.lifecycle)}</td>
<td>${esc(a.verdict ?? "")}</td><td>${pct(a.delta)}</td><td>${esc((a.hypothesis ?? "").slice(0, 140))}</td><td class="muted">${esc(ago(a.updated_at, now))}</td></tr>`,
          )
          .join("");
        return `<div class="card" id="${esc(i.id)}"><h2>${esc(i.id)} <span class="muted">${esc(i.campaign)} · ${esc(i.mode)} · ${esc(i.status)}${
          i.pause_reason ? ` (${esc(i.pause_reason)})` : ""
        }</span></h2>${chart(i)}
<p>${verdictPills(i)}${i.calibration ? `<span class="pill">A/A block σ ${(i.calibration.sigma * 100).toFixed(2)}%</span>` : ""}</p>
${agentsLine(i)}${goalsTable(i)}${researchBlock(i)}
${steeringBlock(
  i,
  (kind, fields, label, primary) =>
    `<form class="inline" method="post" action="/ui/commands">${hidden(i.id)}<input type="hidden" name="kind" value="${esc(kind)}">${Object.entries(
      fields,
    )
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join("")}<button${primary ? ' class="primary"' : ""}>${esc(label)}</button></form>`,
)}
${
  i.published
    ? `<p class="muted">Champion seq ${i.published.seq} is published for propagation (tree <code>${esc(i.published.tree.slice(0, 12))}</code>).</p>${
        others.length
          ? `<form class="inline" method="post" action="/ui/propagate">${hidden(i.id)}<select name="target">${others
              .flatMap((o) =>
                o.instances
                  .filter((x) => x.campaign === i.campaign)
                  .map(
                    (x) =>
                      `<option value="${esc(`${o.id}|${x.id}`)}">${esc(o.id)} / ${esc(x.id)}</option>`,
                  ),
              )
              .join("")}</select><button>Propagate (the other unit's judge decides)</button></form>`
          : ""
      }`
    : ""
}<p class="muted">Directives in force: ${i.directives}</p>
<form class="inline" method="post" action="/ui/commands">${hidden(i.id)}<input type="hidden" name="kind" value="${i.status === "paused" ? "resume_instance" : "pause_instance"}">
<input name="reason" placeholder="reason" ${i.status === "paused" ? 'type="hidden"' : ""}><button>${i.status === "paused" ? "Resume" : "Pause"}</button></form>
<form class="inline" method="post" action="/ui/commands">${hidden(i.id)}<input type="hidden" name="kind" value="reset_workers"><button>Reset workers</button></form>
<form class="inline" method="post" action="/ui/commands">${hidden(i.id)}<input type="hidden" name="kind" value="redirect">
<select name="directive"><option value="avoid">avoid</option><option value="try">try</option><option value="mandate">mandate</option></select>
<input name="family" placeholder="direction family" required><input name="rationale" placeholder="why, with a citation" required>
<label class="muted"><input type="checkbox" name="add" value="1"> add to my current directives</label><button>Redirect</button></form>
<table><tr><th>Attempt</th><th>Lane</th><th>Lifecycle</th><th>Verdict</th><th>Δ</th><th>Hypothesis</th><th>Updated</th></tr>${attempts}</table></div>`;
      })
      .join("");
    const events = u.recent
      .map(
        (e) =>
          `<tr><td class="muted">${esc(ago(e.at, now))}</td><td>${esc(e.kind)}</td><td><code>${esc(e.subject ?? "")}</code></td></tr>`,
      )
      .join("");
    return c.html(
      page(
        u.id,
        `<h1>${esc(u.id)} <span class="${u.stale ? "bad" : "ok"}">${u.stale ? "stale" : "live"}</span></h1>
<p class="muted">Last report ${esc(ago(u.last_seen, now))} · ledger <code>${esc(u.ledger_id ?? "")}</code> · report key <code>${esc(key.pubkey ? fingerprint(key.pubkey) : "not pinned")}</code></p>
${
  key.pending
    ? `<div class="card bad">This unit now signs its reports with a different key (<code>${esc(fingerprint(key.pending))}</code>), and its reports are refused until you accept it. Expected after the unit's state was wiped or rebuilt; otherwise, investigate first.
<form class="inline" method="post" action="/ui/units/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${t}"><button class="primary">Accept the new key</button></form></div>`
    : ""
}
${supervisorLine(u)}
<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="unit" value="${esc(u.id)}">
<input type="hidden" name="kind" value="export_now"><button>Export now</button></form>
${
  opts.driver
    ? `<form class="inline" method="post" action="/ui/units/${encodeURIComponent(u.id)}/restart"><input type="hidden" name="csrf" value="${t}"><button>Restart the unit's containers</button></form>`
    : ""
}<form class="inline" method="post" action="/ui/units/${encodeURIComponent(u.id)}/reset"><input type="hidden" name="csrf" value="${t}">
<input name="confirm" placeholder="type: reset ${esc(u.id)}"><button>Full reset (export, verify, wipe)</button></form>
${instances || '<p class="muted">No campaign assigned.</p>'}<h2>Recent events</h2><div class="card"><table>${events}</table></div>`,
      ),
    );
  });

  app.post("/ui/units/:unit/key/accept", (c) => {
    store.acceptPendingKey(c.req.param("unit"), "owner:ui");
    return c.redirect(`/ui/units/${encodeURIComponent(c.req.param("unit"))}`, 303);
  });

  app.get("/ui/commands", (c) => {
    const now = Date.now();
    const rows = store
      .listCommands(200)
      .map(
        (
          x,
        ) => `<tr><td class="muted">${esc(ago(x.issued_at, now))}</td><td>${esc(x.unit)}</td><td>${esc(x.kind)}</td><td>${esc(x.issued_by)}</td>
<td class="${x.status === "delivered" ? "ok" : x.status === "pending" ? "warn" : "bad"}">${esc(x.status)}</td><td><code>${esc(JSON.stringify(x.outcome ?? "").slice(0, 200))}</code></td></tr>`,
      )
      .join("");
    return c.html(
      page(
        "Commands",
        `<h1>Commands</h1><div class="card"><table><tr><th>Issued</th><th>Unit</th><th>Kind</th><th>By</th><th>Status</th><th>Outcome</th></tr>${rows}</table></div>`,
      ),
    );
  });

  app.get("/ui/audit", (c) => {
    const now = Date.now();
    const rows = store
      .listAudit(300)
      .map(
        (x) =>
          `<tr><td class="muted">${esc(ago(x.at, now))}</td><td>${esc(x.actor)}</td><td>${esc(x.action)}</td><td><code>${esc(JSON.stringify(x.body).slice(0, 200))}</code></td></tr>`,
      )
      .join("");
    return c.html(
      page(
        "Audit",
        `<h1>Audit log</h1><div class="card"><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr>${rows}</table></div>`,
      ),
    );
  });

  app.get("/ui/leaderboard", (c) => {
    const board = leaderboard(store, { staleAfterMs: opts.staleAfterMs });
    const body = Object.entries(board)
      .map(
        ([campaign, rows]) =>
          `<h2>${esc(campaign)}</h2><div class="card"><table><tr><th>Unit</th><th>Instance</th><th>Champion</th><th>Gain over its baseline</th><th>Cross-verified</th></tr>${rows
            .map(
              (r) =>
                `<tr><td>${esc(r.unit)}</td><td>${esc(r.instance)}</td><td>seq ${r.champion_seq}</td><td>${pct(r.gain)}</td>
<td class="${r.verified_by.length ? "ok" : "muted"}">${r.verified_by.length ? `yes, by ${esc(r.verified_by.join(", "))}` : "not yet"}</td></tr>`,
            )
            .join("")}</table></div>`,
      )
      .join("");
    return c.html(
      page(
        "Leaderboard",
        `<h1>Leaderboard</h1><p class="muted">Gains are relative to each instance's own baseline, measured on its own unit; a result is cross-verified once another unit's judge accepted it.</p>${
          body || '<p class="muted">No campaign yet.</p>'
        }`,
      ),
    );
  });

  app.get("/ui/reports", (c) => {
    const rows = store
      .reports(30)
      .map(
        (r) =>
          `<div class="card"><h2>${esc(r.unit)} <span class="muted">${esc(r.kind)} · ${esc(r.at.slice(0, 16))}</span></h2><pre style="white-space:pre-wrap">${esc(r.body)}</pre></div>`,
      )
      .join("");
    const resets = store
      .resets(20)
      .map(
        (r) =>
          `<tr><td>${esc(r.unit)}</td><td>${esc(r.state)}</td><td>${esc(r.detail ?? "")}</td><td class="muted">${esc(String(r.updated_at).slice(0, 16))}</td></tr>`,
      )
      .join("");
    return c.html(
      page(
        "Reports",
        `<h1>Reports</h1>${rows || '<p class="muted">No daily report yet.</p>'}${
          resets
            ? `<h2>Full resets</h2><div class="card"><table><tr><th>Unit</th><th>State</th><th>Detail</th><th>Updated</th></tr>${resets}</table></div>`
            : ""
        }`,
      ),
    );
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
    return c.redirect(`/ui/units/${encodeURIComponent(String(f.unit))}`, 303);
  });

  return app;
}
