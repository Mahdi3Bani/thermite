/**
 * The dashboard's stylesheet. It follows Magnesium's design (the owner's agent UI, built on
 * T3 Code's tokens): a quiet zinc palette, an indigo primary, system fonts, 10 px card radius,
 * dense 11-12 px metadata, emerald / amber / red status colours, and a near-black dark theme
 * with hairline borders.
 */
export const STYLE = `
:root {
  color-scheme: light;
  --background: #fcfcfd; --foreground: #27272a; --card: #ffffff; --popover: #ffffff;
  --muted: #fafafa; --muted-foreground: #71717a; --accent: #f4f4f5; --accent-foreground: #18181b;
  --border: #e4e4e7; --input: #d4d4d8;
  --primary: oklch(0.488 0.217 264); --primary-foreground: #ffffff;
  --primary-surface: color-mix(in srgb, var(--primary) 8%, transparent);
  --success: #10b981; --success-foreground: #047857;
  --success-surface: color-mix(in srgb, var(--success) 10%, transparent);
  --warning: #f59e0b; --warning-foreground: #b45309;
  --warning-surface: color-mix(in srgb, var(--warning) 9%, transparent);
  --error: #ef4444; --error-foreground: #b91c1c;
  --error-surface: color-mix(in srgb, var(--error) 8%, transparent);
  --info: #3b82f6; --info-foreground: #1d4ed8;
  --violet-foreground: #7c3aed;
  --sidebar: #fafafa; --sidebar-row-hover: #fcfcfd; --sidebar-row-active: #ffffff;
  --code-background: #f7f7f8;
  --radius: 0.625rem; --control-radius: 0.5rem;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --background: #0a0a0a; --foreground: #f5f5f5;
    --card: color-mix(in srgb, #0a0a0a 97%, #ffffff); --popover: var(--card);
    --muted: rgb(255 255 255 / 3%); --muted-foreground: color-mix(in srgb, #737373 90%, #ffffff);
    --accent: rgb(255 255 255 / 4%); --accent-foreground: #f5f5f5;
    --border: rgb(255 255 255 / 7%); --input: rgb(255 255 255 / 10%);
    --primary: oklch(0.571 0.21 264);
    --primary-surface: color-mix(in srgb, var(--primary) 16%, transparent);
    --success-foreground: #34d399; --success-surface: color-mix(in srgb, var(--success) 16%, transparent);
    --warning-foreground: #fbbf24; --warning-surface: color-mix(in srgb, var(--warning) 16%, transparent);
    --error: color-mix(in srgb, #ef4444 90%, #ffffff); --error-foreground: #f87171;
    --error-surface: color-mix(in srgb, var(--error) 16%, transparent);
    --info-foreground: #60a5fa; --violet-foreground: #a78bfa;
    --sidebar: var(--card); --sidebar-row-hover: var(--accent); --sidebar-row-active: rgb(255 255 255 / 7%);
    --code-background: rgb(255 255 255 / 4%);
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--background); color: var(--foreground); font: 14px/1.45 var(--font-sans);
  -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
code, .mono { font-family: var(--font-mono); font-size: 12px; }
h1, h2, h3 { margin: 0; font-weight: 600; }

/* ---------------------------------------------------------------- shell */
.app { display: grid; grid-template-columns: 256px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 30px; height: 100vh; }
.sidebar { grid-row: 1 / 2; background: var(--sidebar); border-right: 1px solid var(--border); overflow-y: auto; padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; }
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 14px; font-weight: 600; font-size: 16px; }
.mark { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; background: #18181b; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: -.02em; }
@media (prefers-color-scheme: dark) { .mark { background: #f5f5f5; color: #0a0a0a; } }
.nav a { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: var(--control-radius); color: var(--foreground); }
.nav a:hover { background: var(--sidebar-row-hover); text-decoration: none; }
.nav a.on { background: var(--accent); font-weight: 500; }
.nav a .icon { color: var(--muted-foreground); }
.nav a .count { margin-left: auto; font-size: 12px; color: var(--muted-foreground); }
.nav a .badge { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #c2410c; color: #fff; font-size: 11px; font-weight: 600; display: inline-grid; place-items: center; }
.section { margin: 16px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); }
.side-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: var(--control-radius); font-size: 13px; }
.side-row:hover { background: var(--sidebar-row-hover); text-decoration: none; }
.side-row .right { margin-left: auto; font-size: 11px; color: var(--muted-foreground); white-space: nowrap; }
.side-row .right.label.info { color: var(--info-foreground); } .side-row .right.label.warn { color: var(--warning-foreground); }
.side-row .right.label.violet { color: var(--violet-foreground); } .side-row .right.label.bad { color: var(--error-foreground); }
.side-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 999px; background: var(--muted-foreground); flex: none; }
.dot.ok { background: var(--success); } .dot.warn { background: #ea580c; } .dot.bad { background: var(--error); } .dot.info { background: var(--info); }
.dot.pulse { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.side-foot { margin-top: auto; padding: 12px 8px 0; }

.main { grid-row: 1 / 2; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.topbar { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 20px; border-bottom: 1px solid var(--border); background: var(--background); }
.topbar h1 { font-size: 15px; }
.topbar .crumbs { color: var(--muted-foreground); font-size: 13px; display: flex; gap: 6px; align-items: center; }
.topbar .summary { color: var(--muted-foreground); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topbar .actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.content { flex: 1; overflow-y: auto; padding: 20px; }
.content.flush { padding: 0; display: flex; overflow: hidden; }

.statusbar { grid-column: 1 / -1; display: flex; align-items: center; gap: 18px; padding: 0 16px; border-top: 1px solid var(--border); background: var(--background); font-size: 12px; white-space: nowrap; overflow: hidden; }
.statusbar .item { display: inline-flex; align-items: center; gap: 6px; }
.statusbar .item.warn { color: #c2410c; font-weight: 500; } .statusbar .item.bad { color: var(--error-foreground); font-weight: 500; }
.statusbar .sub { color: var(--muted-foreground); }
.statusbar .spacer { margin-left: auto; }
@media (prefers-color-scheme: dark) { .statusbar .item.warn { color: #fb923c; } }

/* ---------------------------------------------------------------- layout */
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 24px; align-items: start; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.grid-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; align-items: start; }
.grid-cards > .card, .grid2 > .card { margin-top: 0; }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (min-width: 1700px) { .kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
.head { display: flex; align-items: baseline; gap: 8px; margin: 4px 0 10px; }
.head h2 { font-size: 14px; }
.head .n { color: var(--muted-foreground); font-size: 13px; }
.head .right { margin-left: auto; font-size: 12px; color: var(--muted-foreground); }
.head .right a { color: var(--primary); }
.block { margin-bottom: 28px; }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) 30px; }
  .sidebar { grid-row: 1; flex-direction: row; flex-wrap: wrap; padding: 8px; border-right: 0; border-bottom: 1px solid var(--border); }
  .sidebar .section, .sidebar .side-row, .sidebar .side-foot { display: none; }
  .brand { padding: 4px 8px; }
  .nav { display: flex; flex-wrap: wrap; gap: 2px; }
  .main { grid-row: 2; }
  .content { padding: 14px; }
  .grid2 { grid-template-columns: minmax(0, 1fr); }
}

/* ---------------------------------------------------------------- surfaces */
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.card.tight { padding: 10px 12px; }
.card.flat { padding: 0; overflow: hidden; }
.card + .card { margin-top: 12px; }
.card.hl { border-color: color-mix(in srgb, var(--foreground) 55%, transparent); }
.card.warn { background: var(--warning-surface); border-color: color-mix(in srgb, var(--warning) 40%, transparent); }
.card.bad { background: var(--error-surface); border-color: color-mix(in srgb, var(--error) 35%, transparent); }
.card-head { display: flex; align-items: center; gap: 10px; }
.card-head .title { font-weight: 600; }
.card-head .sub { color: var(--muted-foreground); font-size: 12px; }
.card-head .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.divider { height: 1px; background: var(--border); margin: 12px 0; }
.muted { color: var(--muted-foreground); } .small { font-size: 12px; } .xs { font-size: 11px; }
.ok { color: var(--success-foreground); } .warn { color: var(--warning-foreground); } .bad { color: var(--error-foreground); } .info { color: var(--info-foreground); } .violet { color: var(--violet-foreground); }
.nowrap { white-space: nowrap; } .grow { flex: 1; min-width: 0; }
.row { display: flex; align-items: center; gap: 8px; } .row.wrap { flex-wrap: wrap; }
.empty { color: var(--muted-foreground); font-size: 13px; padding: 18px 0; text-align: center; }
.note { color: var(--muted-foreground); font-size: 12px; margin-top: 10px; }

/* avatars: two letters on a coloured square, like Magnesium's profile chips */
.av { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 5px; color: #fff; font-size: 10px; font-weight: 700; flex: none; letter-spacing: -.02em; }
.av.lg { width: 32px; height: 32px; border-radius: 8px; font-size: 12px; }
.av.c0 { background: #c2410c; } .av.c1 { background: #0e7490; } .av.c2 { background: #4d7c0f; } .av.c3 { background: #be185d; }
.av.c4 { background: #475569; } .av.c5 { background: #6d28d9; } .av.c6 { background: #b45309; } .av.c7 { background: #1d4ed8; }
.iconbox { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--accent); color: var(--muted-foreground); flex: none; }

/* labels and pills */
.label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; border: 1px solid var(--border); white-space: nowrap; }
.pill.ok { color: var(--success-foreground); background: var(--success-surface); border-color: transparent; }
.pill.warn { color: var(--warning-foreground); background: var(--warning-surface); border-color: transparent; }
.pill.bad { color: var(--error-foreground); background: var(--error-surface); border-color: transparent; }
.pill.info { color: var(--info-foreground); background: var(--primary-surface); border-color: transparent; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 6px; background: var(--accent); font-size: 11px; font-weight: 500; color: var(--accent-foreground); white-space: nowrap; }
.chip.ok { background: var(--success-surface); color: var(--success-foreground); }
.chip.warn { background: var(--warning-surface); color: var(--warning-foreground); }
.chip.bad { background: var(--error-surface); color: var(--error-foreground); }
.chip.info { background: var(--primary-surface); color: var(--info-foreground); }
.chip.violet { background: color-mix(in srgb, var(--violet-foreground) 12%, transparent); color: var(--violet-foreground); }

/* controls */
.btn, button, input, select, textarea { font: inherit; color: inherit; }
.btn, button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: var(--control-radius); border: 1px solid var(--input); background: var(--card); cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap; }
.btn:hover, button:hover { background: var(--accent); text-decoration: none; }
.btn.primary, button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.btn.primary:hover, button.primary:hover { background: color-mix(in srgb, var(--primary) 90%, var(--background)); }
.btn.danger, button.danger { color: var(--error-foreground); border-color: color-mix(in srgb, var(--error) 40%, transparent); }
.btn.sm, button.sm { height: 26px; padding: 0 9px; font-size: 12px; }
.btn.ghost, button.ghost { border-color: transparent; background: transparent; }
input, select, textarea { height: 32px; padding: 0 10px; border-radius: var(--control-radius); border: 1px solid var(--input); background: var(--card); font-size: 13px; }
textarea { height: auto; padding: 8px 10px; resize: vertical; line-height: 1.45; }
input:focus, select:focus, textarea:focus, button:focus-visible, .btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 45%, transparent); outline-offset: 1px; }
form.inline { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0; }
.seg { display: inline-flex; padding: 2px; border-radius: var(--control-radius); background: var(--accent); gap: 2px; }
.seg a, .seg span { padding: 3px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--muted-foreground); }
.seg .on { background: #18181b; color: #fff; }
@media (prefers-color-scheme: dark) { .seg .on { background: #f5f5f5; color: #0a0a0a; } }
details.menu { position: relative; }
details.menu > summary { list-style: none; }
details.menu > summary::-webkit-details-marker { display: none; }
details.menu[open] > .menu-body { position: absolute; right: 0; top: 38px; z-index: 20; width: 320px; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; box-shadow: 0 12px 32px rgb(0 0 0 / 12%); display: flex; flex-direction: column; gap: 10px; }

/* bars */
.meter { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 8px; align-items: center; font-size: 12px; }
.meter .k { color: var(--muted-foreground); } .meter .v { text-align: right; font-variant-numeric: tabular-nums; }
.bar { grid-column: 1 / -1; height: 3px; background: var(--border); border-radius: 999px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: #52525b; border-radius: 999px; }
.bar.primary > i { background: var(--primary); } .bar.ok > i { background: var(--success); } .bar.warn > i { background: #ea580c; } .bar.bad > i { background: var(--error); }
.stack-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--border); gap: 1px; }
.stack-bar > i { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; font-size: 12px; }
.legend .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: 0; }
.delta { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.delta i { display: inline-block; height: 6px; border-radius: 2px; }

/* KPI tiles */
.kpi { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
.kpi .k { font-size: 11px; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
.kpi .v { font-size: 20px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.kpi .s { font-size: 12px; color: var(--muted-foreground); }
.kpi .v.ok { color: var(--success-foreground); } .kpi .v.bad { color: var(--error-foreground); }

/* tables */
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; font-weight: 500; font-size: 12px; color: var(--muted-foreground); padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--muted); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.clip { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* feed cards ("Needs you") */
.feed { display: flex; flex-direction: column; gap: 12px; }
.fc { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.fc-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.fc-head b { font-weight: 600; }
.fc-head .link { color: var(--muted-foreground); text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
.fc-head .meta { margin-left: auto; color: var(--muted-foreground); font-size: 12px; white-space: nowrap; }
.fc-kind { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; }
.fc-body { font-size: 14px; }
.fc-box { background: var(--code-background); border-radius: var(--control-radius); padding: 9px 12px; font-family: var(--font-mono); font-size: 12px; overflow-x: auto; }
.fc-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }

/* lists */
.list { display: flex; flex-direction: column; }
.list .li { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
.list .li:last-child { border-bottom: 0; }
.list .li .t { font-family: var(--font-mono); font-size: 12px; color: var(--muted-foreground); width: 52px; flex: none; }
.list .li .right { margin-left: auto; font-size: 12px; white-space: nowrap; }

/* rig tiles (Magnesium's fleet tiles) */
.tile { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tile:hover { border-color: color-mix(in srgb, var(--foreground) 25%, transparent); text-decoration: none; }
.tile .name { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 13px; }
.tile .name .gain { margin-left: auto; font-weight: 600; font-size: 12px; color: var(--success-foreground); font-variant-numeric: tabular-nums; }
.tile .sub { font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile.off .name, .tile.off .sub { color: var(--muted-foreground); }

/* goals checklist */
.goal { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 2px 10px; padding: 9px 0; border-bottom: 1px solid var(--border); align-items: start; }
.goal:last-child { border-bottom: 0; }
.goal .gi { width: 18px; height: 18px; border-radius: 999px; display: grid; place-items: center; font-size: 11px; font-weight: 700; margin-top: 1px; }
.goal .gi.ok { background: var(--success-surface); color: var(--success-foreground); }
.goal .gi.bad { background: var(--error-surface); color: var(--error-foreground); }
.goal .gi.warn { background: var(--warning-surface); color: var(--warning-foreground); }
.goal .gi.off { background: var(--accent); color: var(--muted-foreground); }
.goal .why { grid-column: 2 / -1; font-size: 12px; color: var(--muted-foreground); word-break: break-word; }

/* chart */
svg.chart { width: 100%; height: auto; display: block; }
svg.chart text { fill: var(--muted-foreground); font-size: 11px; font-family: var(--font-sans); }
svg.chart .grid { stroke: var(--border); }
svg.chart .line { stroke: var(--primary); fill: none; stroke-width: 2; }
svg.chart .area { fill: var(--primary); opacity: .08; }
svg.chart .pt { fill: var(--card); stroke: var(--primary); stroke-width: 2; }

/* live session view (Magnesium's session board) */
.sessions { width: 280px; flex: none; border-right: 1px solid var(--border); overflow-y: auto; padding: 12px 8px; background: var(--sidebar); }
.sessions .side-row { padding: 8px 10px; align-items: flex-start; }
.sessions .side-row.on { background: var(--sidebar-row-active); box-shadow: 0 0 0 1px var(--border); }
.sessions .side-row .two { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.transcript-wrap { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.transcript { flex: 1; overflow-y: auto; padding: 20px 28px 12px; display: flex; flex-direction: column; gap: 10px; }
.transcript .tx { max-width: 860px; font-size: 14px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.transcript .think { max-width: 860px; font-size: 13px; color: var(--muted-foreground); }
.transcript .think summary, .transcript details.tool summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; }
.transcript details > summary::-webkit-details-marker { display: none; }
.transcript details.tool { max-width: 860px; font-size: 13px; color: var(--muted-foreground); }
.transcript details.tool summary .name { color: var(--foreground); font-family: var(--font-mono); font-size: 12px; }
.transcript details.tool pre, .transcript .think pre { margin: 6px 0 0; padding: 10px 12px; background: var(--code-background); border-radius: var(--control-radius); font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; color: var(--foreground); }
.transcript .msg { align-self: flex-end; max-width: 640px; background: var(--accent); border-radius: 14px; padding: 10px 14px; font-size: 14px; white-space: pre-wrap; }
.transcript .msg .who { font-size: 11px; color: var(--muted-foreground); margin-bottom: 2px; font-weight: 600; }
.transcript .status { align-self: center; color: var(--muted-foreground); font-size: 12px; display: flex; align-items: center; gap: 10px; width: 100%; max-width: 860px; }
.transcript .status::before, .transcript .status::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.transcript .logline { font-family: var(--font-mono); font-size: 12px; color: var(--foreground); display: flex; gap: 10px; max-width: 980px; }
.transcript .logline .t { color: var(--muted-foreground); flex: none; }
.transcript .unsigned { font-size: 11px; color: var(--warning-foreground); }
.composer { margin: 0 28px 18px; max-width: 860px; border: 1px solid var(--border); border-radius: 16px; background: var(--card); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 2px rgb(0 0 0 / 4%); }
.composer textarea { border: 0; padding: 4px 2px; min-height: 52px; background: transparent; font-size: 14px; }
.composer textarea:focus { outline: none; }
.composer .bar2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.composer .bar2 select { height: 28px; font-size: 12px; }
.composer .hint { font-size: 12px; color: var(--muted-foreground); }
.composer.off { background: var(--muted); color: var(--muted-foreground); font-size: 13px; padding: 14px 16px; }
@media (max-width: 760px) { .sessions { display: none; } .transcript { padding: 14px; } .composer { margin: 0 12px 12px; } }
pre.report { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; margin: 0; }
`;
