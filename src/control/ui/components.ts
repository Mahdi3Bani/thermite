import type { Hardware } from "../../core/hardware.ts";
import { type CampaignView, campaignViews, type RigView, type RunView } from "../views.ts";
import { STYLE } from "./style.ts";

/** Everything the dashboard writes into HTML goes through esc (rig data is never markup). */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const pct = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? ""
    : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;

export const ago = (iso: string | null | undefined, now: number) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.round(s / 60)}m`
      : s < 172_800
        ? `${Math.round(s / 3600)}h`
        : `${Math.round(s / 86_400)}d`;
};

export const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
export const fmtInt = (x: number) =>
  x >= 1e6
    ? `${(x / 1e6).toFixed(1)}M`
    : x >= 1e4
      ? `${Math.round(x / 1e3)}k`
      : String(Math.round(x));

// ---------------------------------------------------------------- icons (16 px, stroke)
const svg = (d: string, size = 16) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icon = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  rigs: svg(
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  ),
  trophy: svg(
    '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  ),
  live: svg('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  terminal: svg(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  ),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  file: svg(
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  ),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>'),
  warn: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>', 14),
  check: svg('<path d="m5 12 5 5 9-10"/>', 14),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>', 14),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 14),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>', 14),
  pause: svg('<path d="M9 5v14M15 5v14"/>', 14),
  play: svg('<path d="m7 4 13 8-13 8z"/>', 14),
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>', 16),
  dots: svg('<path d="M5 12h.01M12 12h.01M19 12h.01"/>', 16),
  chip: svg(
    '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    18,
  ),
  cpu: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/>', 18),
  logout: svg('<path d="M15 4h4v16h-4M10 17l5-5-5-5M15 12H3"/>'),
  cog: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ),
};

// ---------------------------------------------------------------- small parts
/** A stable colour per name (the same rig or campaign always gets the same chip). */
export function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 8;
}
export function avatar(name: string, large = false): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = (
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : name.slice(0, 2)
  ).toUpperCase();
  return `<span class="av c${hue(name)}${large ? " lg" : ""}">${esc(letters)}</span>`;
}
const MODE: Record<string, [string, string]> = {
  hill_climb: ["HC", "hill climb"],
  goal: ["GL", "goal"],
  research: ["RS", "research"],
};
export function modeAvatar(mode: string | null): string {
  const m = MODE[mode ?? ""] ?? ["??", "campaign"];
  return `<span class="av c${mode === "hill_climb" ? 7 : mode === "goal" ? 5 : 1}" title="${esc(m[1])}">${m[0]}</span>`;
}
export const modeName = (mode: string | null) => MODE[mode ?? ""]?.[1] ?? mode ?? "";

/** What a run needs, or is doing, as one coloured label (Magnesium's status words). */
export function runState(i: RunView): { text: string; cls: string; icon: string } {
  const heldAudit = i.audits.some((a) => a.decision === null || a.decision === "block");
  if (i.status === "closed") return { text: "Closed", cls: "muted", icon: icon.check };
  if (i.pending_promotions.length) return { text: "Approval", cls: "warn", icon: icon.warn };
  if (i.conclusions.some((c) => c.decision === null))
    return { text: "Decision", cls: "warn", icon: icon.warn };
  if (i.reviews.some((r) => r.panel === "review_passed" && !r.owner))
    return { text: "Review", cls: "violet", icon: icon.warn };
  if (heldAudit) return { text: "Audit", cls: "warn", icon: icon.shield };
  if (i.status === "paused") return { text: "Paused", cls: "muted", icon: icon.pause };
  return { text: "Running", cls: "info", icon: icon.live };
}

/** A campaign's state: its most urgent run's. */
export function campaignState(k: CampaignView): { text: string; cls: string; icon: string } {
  const order = ["Approval", "Decision", "Review", "Audit", "Running", "Paused", "Closed"];
  const states = k.runs.map((x) => runState(x.run));
  return (
    states.sort((a, b) => order.indexOf(a.text) - order.indexOf(b.text))[0] ?? {
      text: "Idle",
      cls: "muted",
      icon: "",
    }
  );
}

export const campaignHref = (name: string) => `/ui/campaigns/${encodeURIComponent(name)}`;
/** A run's key on its campaign's page (run ids are unique per rig only). */
export const runKey = (rig: string, run: string) => `${rig}/${run}`;
/** A run's page (on its campaign's page), and one of its tabs. */
export const runHref = (
  rig: string,
  i: Pick<RunView, "id" | "campaign">,
  view: "overview" | "experiments" | "attempts" | "history" | "planner" = "overview",
) =>
  `${campaignHref(i.campaign || i.id)}?run=${encodeURIComponent(runKey(rig, i.id))}${view === "overview" ? "" : `&view=${view}`}`;

export function label(text: string, cls: string, ic = ""): string {
  return `<span class="label ${cls}">${ic}${esc(text)}</span>`;
}

export function meter(k: string, v: string, fraction: number, cls = ""): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return `<div class="meter"><span class="k">${esc(k)}</span><span></span><span class="v">${esc(v)}</span><div class="bar ${cls}"><i style="width:${(f * 100).toFixed(1)}%"></i></div></div>`;
}

export function kpi(k: string, v: string, s = "", cls = ""): string {
  return `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
}

/** Verdict colours, shared by the stacked bar, chips and legends. */
export function verdictColor(v: string): string {
  if (v === "win_confirmed" || v === "promoted" || v === "goal_progress" || v === "met")
    return "var(--success)";
  if (v === "win_screened" || v === "goal_screened")
    return "color-mix(in srgb, var(--success) 55%, transparent)";
  if (v === "regress" || v === "crash_candidate" || v === "unmet") return "var(--error)";
  if (v === "invalid" || v === "rejected_v0" || v === "duplicate") return "var(--warning)";
  if (v === "queued" || v === "judging" || v === "evaluating") return "var(--info)";
  if (v === "inconclusive" || v === "crash_infra") return "#d4d4d8";
  return "#a1a1aa";
}
export function verdictChip(v: string | null, lifecycle: string): string {
  const k = v ?? lifecycle;
  const cls =
    k === "win_confirmed" || k === "goal_progress" || k === "promoted"
      ? "ok"
      : k === "regress" || k === "crash_candidate"
        ? "bad"
        : k === "invalid" ||
            k === "rejected_v0" ||
            k === "duplicate" ||
            k === "awaiting_audit" ||
            k === "awaiting_approval"
          ? "warn"
          : k === "queued" || k === "screening" || k === "confirming"
            ? "info"
            : "";
  return `<span class="chip ${cls}">${esc(k.replace(/_/g, " "))}</span>`;
}

export function stackBar(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return `<div class="empty">No attempts yet.</div>`;
  return `<div class="stack-bar">${entries
    .map(
      ([k, n]) =>
        `<i style="width:${((100 * n) / total).toFixed(2)}%;background:${verdictColor(k)}" title="${esc(k)} ${n}"></i>`,
    )
    .join("")}</div><div class="legend">${entries
    .map(
      ([k, n]) =>
        `<span><span class="sw" style="background:${verdictColor(k)}"></span>${esc(k.replace(/_/g, " "))} <b>${n}</b></span>`,
    )
    .join("")}</div>`;
}

export function deltaCell(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return `<span class="muted">·</span>`;
  const w = Math.min(60, Math.round(Math.abs(d) * 600));
  return `<span class="delta ${d > 0 ? "ok" : d < 0 ? "bad" : "muted"}"><i style="width:${w}px;background:currentColor;opacity:.5"></i>${pct(d)}</span>`;
}

/** The champion's gain over time: a stepped line with an area, promotions marked. */
export function gainChart(v: RunView, w = 760, h = 200): string {
  const steps = v.champion.filter((c) => !c.reopened);
  if (steps.length < 2)
    return `<div class="empty">No promotion yet: the champion is the seed.</div>`;
  const padL = 46;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const now = Date.now();
  const ts = steps.map((s) => Date.parse(s.at));
  const t0 = Math.min(...ts);
  const t1 = Math.max(now, ...ts, t0 + 1);
  const ys = steps.map((s) => s.cumulative - 1);
  const y0 = Math.min(0, ...ys);
  const y1 = Math.max(...ys, y0 + 0.001) * 1.12;
  const X = (t: number) => padL + ((t - t0) / (t1 - t0)) * (w - padL - padR);
  const Y = (y: number) => padT + ((y1 - y) / (y1 - y0)) * (h - padT - padB);
  let d = "";
  steps.forEach((_s, i) => {
    const x = X(ts[i] as number);
    const y = Y(ys[i] as number);
    d += i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` H${x.toFixed(1)} V${y.toFixed(1)}`;
  });
  const lastY = Y(ys.at(-1) as number);
  d += ` H${X(t1).toFixed(1)}`;
  const area = `${d} V${Y(y0).toFixed(1)} H${X(t0).toFixed(1)} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => y0 + f * (y1 - y0))
    .map(
      (y) =>
        `<line class="grid" x1="${padL}" x2="${w - padR}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}"/><text x="${padL - 8}" y="${(Y(y) + 4).toFixed(1)}" text-anchor="end">${pct(y, 0)}</text>`,
    )
    .join("");
  const fmt = (t: number) => {
    const dt = new Date(t);
    return `${dt.toISOString().slice(5, 10)} ${dt.toISOString().slice(11, 16)}`;
  };
  const pts = steps
    .slice(1)
    .map(
      (s, i) =>
        `<circle class="pt" cx="${X(ts[i + 1] as number).toFixed(1)}" cy="${Y(ys[i + 1] as number).toFixed(1)}" r="3.5"><title>seq ${s.seq} · ${pct(s.cumulative - 1)} · ${esc(s.at.slice(0, 16))}</title></circle>`,
    )
    .join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="champion gain over time">${grid}
<path class="area" d="${area}"/><path class="line" d="${d}"/>${pts}
<text x="${padL}" y="${h - 6}">${esc(fmt(t0))}</text><text x="${w - padR}" y="${h - 6}" text-anchor="end">now</text>
<text x="${(X(t1) - 4).toFixed(1)}" y="${(lastY - 8).toFixed(1)}" text-anchor="end" style="fill:var(--foreground);font-weight:600">${pct(ys.at(-1) as number)}</text></svg>`;
}

/** A small sparkline of the champion's gain, for tiles and lists. */
export function sparkline(v: RunView, w = 120, h = 28): string {
  const steps = v.champion.filter((c) => !c.reopened);
  if (steps.length < 2) return "";
  const ts = steps.map((s) => Date.parse(s.at));
  const t0 = Math.min(...ts);
  const t1 = Math.max(Date.now(), t0 + 1);
  const ys = steps.map((s) => s.cumulative - 1);
  const y1 = Math.max(...ys, 0.001);
  const X = (t: number) => 1 + ((t - t0) / (t1 - t0)) * (w - 2);
  const Y = (y: number) => h - 2 - (y / y1) * (h - 4);
  let d = "";
  steps.forEach((_s, i) => {
    d +=
      i === 0
        ? `M${X(ts[i] as number).toFixed(1)},${Y(ys[i] as number).toFixed(1)}`
        : ` H${X(ts[i] as number).toFixed(1)} V${Y(ys[i] as number).toFixed(1)}`;
  });
  d += ` H${X(t1).toFixed(1)}`;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:${w}px" aria-hidden="true"><path class="line" style="stroke-width:1.5" d="${d}"/></svg>`;
}

// ---------------------------------------------------------------- the page shell
export interface Shell {
  title: string;
  /** Muted text after the title. */
  summary?: string | undefined;
  /** Breadcrumb links before the title. */
  crumbs?: { href: string; text: string }[] | undefined;
  actions?: string | undefined;
  active:
    | "overview"
    | "campaigns"
    | "rigs"
    | "live"
    | "commands"
    | "reports"
    | "audit"
    | "settings"
    | "";
  rigs: RigView[];
  needs: number;
  now: number;
  /** A full-height content area without padding (the live view). */
  flush?: boolean | undefined;
}

export function shell(s: Shell, body: string): string {
  const live = s.rigs.filter((u) => !u.stale).length;
  const stale = s.rigs.length - live;
  const runs = s.rigs.flatMap((u) => u.runs.map((i) => ({ u, i })));
  const running = runs.filter(({ i }) => i.status === "running").length;
  const jobs = s.rigs.reduce(
    (acc, u) => ({
      queued: acc.queued + num(u.jobs.queued),
      leased: acc.leased + num(u.jobs.leased),
    }),
    { queued: 0, leased: 0 },
  );
  const nav = (href: string, key: Shell["active"], ic: string, text: string, right = "") =>
    `<a href="${href}" class="${s.active === key ? "on" : ""}">${ic}<span>${esc(text)}</span>${right}</a>`;
  const rigRows = s.rigs
    .map(
      (u) =>
        `<a class="side-row" href="/ui/rigs/${encodeURIComponent(u.id)}"><span class="dot ${u.stale ? "bad" : "ok"}"></span><span class="name">${esc(u.id)}</span><span class="right">${u.stale ? "stale" : u.runs.filter((i) => i.status === "running").length || ""}</span></a>`,
    )
    .join("");
  const camps = campaignViews(s.rigs);
  const campRows = camps
    .filter((k) => k.runs.some((x) => x.run.status !== "closed"))
    .slice(0, 12)
    .map((k) => {
      const st = campaignState(k);
      return `<a class="side-row" href="${campaignHref(k.name)}">${modeAvatar(k.mode)}<span class="name">${esc(k.name)}</span><span class="right label ${st.cls}">${esc(st.text)}</span></a>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(s.title)} · Thermite</title>
<style>${STYLE}</style><script src="/ui/assets/app.js" defer></script></head>
<body><div class="app">
<aside class="sidebar">
  <a class="brand" href="/ui"><span class="mark">Th</span>Thermite</a>
  <nav class="nav">
    ${nav("/ui", "overview", icon.home, "Overview", s.needs ? `<span class="badge">${s.needs}</span>` : "")}
    ${nav("/ui/campaigns", "campaigns", icon.trophy, "Campaigns", `<span class="count">${camps.length}</span>`)}
    ${nav("/ui/rigs", "rigs", icon.rigs, "Rigs", `<span class="count">${s.rigs.length}</span>`)}
    ${nav("/ui/live", "live", icon.terminal, "Live")}
    ${nav("/ui/commands", "commands", icon.list, "Commands")}
    ${nav("/ui/reports", "reports", icon.file, "Reports")}
    ${nav("/ui/audit", "audit", icon.shield, "Audit log")}
  </nav>
  ${campRows ? `<div class="section">Campaigns</div>${campRows}` : ""}
  ${s.rigs.length ? `<div class="section">Rigs</div>${rigRows}` : ""}
  <div class="side-foot"><form method="post" action="/ui/logout"><button class="ghost sm">${icon.logout}Sign out</button></form><a class="cog${s.active === "settings" ? " on" : ""}" href="/ui/settings" title="Settings" aria-label="Settings">${icon.cog}</a></div>
</aside>
<div class="main">
  <header class="topbar">
    ${s.crumbs?.length ? `<span class="crumbs">${s.crumbs.map((c) => `<a href="${c.href}">${esc(c.text)}</a><span>›</span>`).join("")}</span>` : ""}
    <h1>${esc(s.title)}</h1>${s.summary ? `<span class="summary">${s.summary}</span>` : ""}
    <div class="actions">${s.actions ?? ""}</div>
  </header>
  <div class="content${s.flush ? " flush" : ""}" id="content">${body}</div>
</div>
<footer class="statusbar">
  <span class="item ${stale ? "warn" : ""}"><span class="dot ${stale ? "warn" : "ok"}"></span>${s.rigs.length} rigs${stale ? ` · ${stale} stale` : ""}</span>
  ${s.needs ? `<a class="item warn" href="/ui">${icon.warn}Needs you ${s.needs}</a>` : ""}
  <span class="spacer"></span>
  <span class="item">${running} running <span class="sub">runs</span></span>
  <span class="item">${jobs.leased} judging · ${jobs.queued} queued <span class="sub">judge</span></span>
  <span class="item" id="live-state"><span class="sub">page from ${esc(new Date(s.now).toISOString().slice(11, 19))} UTC</span><a href="" title="Load this page again with what control knows now">refresh</a></span>
</footer></div></body></html>`;
}

const gib = (mib: number | null | undefined) =>
  typeof mib === "number"
    ? `${mib >= 10_240 ? Math.round(mib / 1024) : (mib / 1024).toFixed(1)} GiB`
    : "?";

/** One line for a rig's card: its devices, CPUs and memory. */
export function hardwareLine(h: Hardware | null): string {
  if (!h) return "";
  const byName = new Map<string, number>();
  for (const d of h.devices) byName.set(d.name, (byName.get(d.name) ?? 0) + 1);
  const devices = [...byName].map(([name, n]) => `${n > 1 ? `${n}× ` : ""}${esc(name)}`);
  const cpus = h.cpu.quota ?? h.cpu.usable;
  return [
    ...devices,
    `${esc(String(cpus))} CPU`,
    `${esc(gib(h.memory.limit_mib ?? h.memory.host_mib))} RAM`,
  ].join(" · ");
}

const DEVICE_MODES: Record<Hardware["device_mode"], string> = {
  shared: "one, shared by the judge and agents' dev runs",
  dedicated: "one for the judge, one for agents' dev runs",
  none: "none: the judge measures on the CPU",
};
/** How the rig's devices are used, in words: with several cards, how many of each. */
export function deviceModeText(h: Hardware): string {
  if (h.device_mode !== "dedicated") return DEVICE_MODES[h.device_mode] ?? h.device_mode;
  const judges = h.devices.filter((d) => d.role === "judge").length;
  const devs = h.devices.filter((d) => d.role === "dev").length;
  if (judges <= 1 && devs <= 1) return DEVICE_MODES.dedicated;
  return `${judges} for the judge, ${devs} for agents' dev runs`;
}
const ROLES: Record<string, string> = {
  judge: "Judge",
  dev: "Dev runs",
  shared: "Judge + dev runs",
};

/** A rig's hardware, in full: devices, CPU, memory, disks, system and toolchain. */
export function hardwareCard(h: Hardware | null, now: number): string {
  if (!h) {
    return `<div class="card"><div class="empty">This rig's harness does not report its hardware yet (it needs a newer image).</div></div>`;
  }
  const n = (v: number | null | undefined, unit: string) =>
    typeof v === "number" ? `${esc(String(v))}${unit}` : `<span class="muted">?</span>`;
  const rows = h.devices
    .map(
      (d) =>
        `<tr><td class="nowrap">${esc(ROLES[d.role] ?? d.role)}</td><td><b>${esc(d.name)}</b><div class="muted xs"><code>${esc(d.uuid)}</code></div></td><td class="num nowrap">${esc(gib(d.memory_mib))}</td><td class="nowrap"><code>${esc(d.bus)}</code></td><td class="nowrap">${esc(d.driver ?? "?")}${d.cuda ? ` <span class="muted">· CUDA ${esc(d.cuda)}</span>` : ""}</td><td class="num nowrap">${n(d.power_limit_w, " W")}</td><td class="num nowrap">${n(d.max_sm_mhz, "")} / ${n(d.max_mem_mhz, " MHz")}</td><td class="nowrap">${esc(d.pcie ?? "?")}</td></tr>`,
    )
    .join("");
  const devices = h.devices.length
    ? `<div style="overflow-x:auto"><table><thead><tr><th>Used by</th><th>Device</th><th class="num">Memory</th><th>Bus</th><th>Driver</th><th class="num">Power limit</th><th class="num">Max SM / mem clock</th><th>PCIe</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : "";
  const kv = (k: string, v: string) =>
    `<div class="small"><span class="muted">${esc(k)}</span> ${v}</div>`;
  const cpu = `${esc(h.cpu.model || "?")} · ${h.cpu.quota !== null ? `quota ${esc(String(h.cpu.quota))} CPU` : `${esc(String(h.cpu.usable))} CPU`} of the host's ${esc(String(h.cpu.host))}`;
  const mem =
    h.memory.limit_mib !== null
      ? `${esc(gib(h.memory.limit_mib))} limit, of the host's ${esc(gib(h.memory.host_mib))}`
      : `no limit; the host has ${esc(gib(h.memory.host_mib))}`;
  const disks = h.disks
    .map((d) => `${esc(d.name)} ${esc(String(d.free_gib))} of ${esc(String(d.total_gib))} GiB free`)
    .join(" · ");
  return `<div class="card"><div class="stack" style="gap:10px">
<div class="small"><span class="muted">Devices</span> ${esc(deviceModeText(h))}</div>
${devices}
<div class="grid2" style="gap:8px 16px">
${kv("CPU", cpu)}
${kv("Memory", mem)}
${kv("Disks", disks || "?")}
${kv("System", `${esc(h.os.kernel)} · ${esc(h.os.arch)} · Node ${esc(h.os.node)}${h.os.image ? ` · image <code>${esc(h.os.image.slice(0, 24))}</code>` : ""}`)}
${kv("Compilers", `${esc(h.toolchain.cc ?? "no cc")}${h.toolchain.nvcc ? ` · ${esc(h.toolchain.nvcc)}` : ""}`)}
${kv("Target", `${esc(h.target.type)} · ${esc(h.target.class)}`)}
</div>
${h.errors.length ? `<div class="bad xs">${h.errors.map((e) => esc(e.slice(0, 300))).join("<br>")}</div>` : ""}
<div class="muted xs">Reported by the rig's harness when it started, ${esc(ago(h.collected_at, now))} ago.</div>
</div></div>`;
}
