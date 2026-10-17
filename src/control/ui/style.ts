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
.side-foot { margin-top: auto; padding: 12px 8px 0; display: flex; align-items: center; justify-content: space-between; }
.side-foot .cog { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: var(--control-radius); color: var(--muted-foreground); }
.side-foot .cog:hover, .side-foot .cog.on { background: var(--sidebar-row-hover); color: var(--foreground); text-decoration: none; }

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
.grid2 > .card + .card, .stack > .card + .card { margin-top: 0; }
.card.camp { padding: 0; }
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
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin: 4px 0 16px; overflow-x: auto; }
.tabs a { display: inline-flex; align-items: center; gap: 7px; padding: 8px 12px; font-size: 13px; font-weight: 500; color: var(--muted-foreground); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.tabs a:hover { color: var(--foreground); text-decoration: none; }
.tabs a.on { color: var(--foreground); border-bottom-color: var(--primary); }
.tabs a .sub { font-weight: 400; font-size: 12px; color: var(--muted-foreground); }
.goalcell { text-align: center; font-weight: 600; }
tr.on td { background: var(--primary-surface); }
.seg a span { padding: 0; }
.seg a .dot { display: inline-block; margin-left: 4px; vertical-align: middle; }
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

/* tallies: the overview's few numbers */
.tallies { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
.tally { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); color: var(--muted-foreground); font-size: 13px; }
a.tally:hover { text-decoration: none; border-color: color-mix(in srgb, var(--foreground) 25%, transparent); }
.tally b { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; color: var(--foreground); font-variant-numeric: tabular-nums; }
.tally.warn { border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); background: var(--warning-surface); }
.tally.warn b { color: var(--warning-foreground); } .tally.ok b { color: var(--success-foreground); } .tally.bad b { color: var(--error-foreground); }

/* decisions: one row each (what, why, facts, buttons); opened, the evidence and each choice */
.dqs { border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); overflow: hidden; }
.dq { border-bottom: 1px solid var(--border); }
.dq:last-child { border-bottom: 0; }
.dq > summary { list-style: none; display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; gap: 14px; align-items: start; padding: 12px 14px; cursor: pointer; }
.dq > summary::-webkit-details-marker { display: none; }
.dq > summary:hover, .dq[open] > summary { background: var(--muted); }
.dq-kind { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; white-space: nowrap; padding-top: 1px; color: var(--warning-foreground); }
.dq-bad .dq-kind { color: var(--error-foreground); } .dq-violet .dq-kind { color: var(--violet-foreground); }
.dq-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dq-head { font-weight: 600; font-size: 14px; line-height: 1.35; }
.dq-why { font-size: 13px; color: var(--muted-foreground); }
.dq-sub { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 3px; }
.dq-where { font-size: 12px; color: var(--muted-foreground); }
.dq-where a { color: inherit; text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
.dq-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.dq-age { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
.dq-btns { display: flex; gap: 6px; }
.dq-btns button, .dq-btns .btn { height: 28px; padding: 0 10px; }
.dq-body { padding: 4px 14px 16px 148px; display: flex; flex-direction: column; gap: 12px; }
.dq-q { margin: 0; font-weight: 600; font-size: 13px; }
dl.dq-choices { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px 14px; margin: 0; padding-top: 10px; border-top: 1px solid var(--border); font-size: 13px; }
dl.dq-choices dt { font-weight: 600; font-size: 12px; padding-top: 1px; } dl.dq-choices dd { margin: 0; }
.dq-foot { font-size: 12px; } .dq-foot a { color: var(--primary); }
dl.dc-facts, dl.facts { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 8px 14px; margin: 0; font-size: 13px; }
dl.dc-facts dt, dl.facts dt { color: var(--muted-foreground); font-size: 12px; font-weight: 600; padding-top: 1px; }
dl.dc-facts dd, dl.facts dd { margin: 0; min-width: 0; word-break: break-word; }
.side dl.facts { grid-template-columns: 90px minmax(0, 1fr); }
.quote { border-left: 2px solid var(--border); padding: 1px 0 1px 10px; font-size: 14px; }
.quote.inline { border: 0; padding: 0; font-style: italic; }
ul.flaws { margin: 4px 0 0; padding-left: 18px; } ul.flaws li { margin: 2px 0; }
.dc-choices { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; }
.choice { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 12px; align-items: start; font-size: 13px; }
.choice .btns { display: flex; } .choice .btns > span { padding-top: 6px; }
.choice .does { padding-top: 6px; color: var(--foreground); }
@media (max-width: 1100px) { .dq > summary { grid-template-columns: minmax(0, 1fr); } .dq-side { align-items: flex-start; } .dq-body { padding-left: 14px; } .tallies { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { dl.dc-facts, dl.facts, dl.dq-choices, .choice { grid-template-columns: minmax(0, 1fr); } }

/* a run at a glance: its lanes, planner and judge, one line each */
.brief { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; }
.brief + .brief { margin-top: 10px; }
.brief-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.brief-name { font-weight: 600; font-size: 14px; }
.brief-progress { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.br { display: grid; grid-template-columns: 70px minmax(0, 1fr) 80px; gap: 10px; padding: 4px 0; font-size: 13px; border-top: 1px dashed var(--border); }
.brief-head + .br, .brief > .br:first-child { border-top: 0; }
.brief-head ~ .br { padding-left: 34px; }
.br-who { color: var(--muted-foreground); font-family: var(--font-mono); font-size: 12px; padding-top: 1px; }
.br-what { min-width: 0; word-break: break-word; } .br-what a { color: var(--primary); }
.br.muted .br-what { color: var(--muted-foreground); }
.br-when { color: var(--muted-foreground); font-size: 12px; text-align: right; white-space: nowrap; }
.br-more { display: block; color: var(--muted-foreground); font-size: 12px; }
.side .brief-head ~ .br { padding-left: 0; } .side .br { grid-template-columns: 56px minmax(0, 1fr) 56px; }
.fig { font-weight: 600; font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.goalbar { display: inline-flex; gap: 2px; }
.goalbar .seg { width: 14px; height: 8px; border-radius: 2px; background: var(--border); }
.goalbar .seg.ok { background: var(--success); } .goalbar .seg.bad { background: var(--error); } .goalbar .seg.warn { background: var(--warning); }

/* a run's page */
.run-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.run-title { font-size: 18px; font-weight: 650; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.run-title .label { font-size: 12px; }
details.matrix > summary { padding: 10px 14px; cursor: pointer; font-size: 13px; font-weight: 600; }
details.matrix[open] > summary { border-bottom: 1px solid var(--border); }
.cols.run-cols { grid-template-columns: minmax(0, 1.7fr) minmax(300px, 1fr); }
@media (max-width: 1100px) { .cols.run-cols { grid-template-columns: minmax(0, 1fr); } }
.run-said { font-size: 15px; line-height: 1.5; margin: 0 0 20px; max-width: 900px; }
.gl { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.gl:last-child { border-bottom: 0; }
.gl-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gl-why { color: var(--muted-foreground); font-size: 12px; } .gl-why.bad { color: var(--error-foreground); }
.gl-mark { width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 11px; font-weight: 700; background: var(--muted); color: var(--muted-foreground); }
.gl-mark.ok { background: var(--success-surface); color: var(--success-foreground); }
.gl-mark.bad { background: var(--error-surface); color: var(--error-foreground); }
.gl-mark.warn { background: var(--warning-surface); color: var(--warning-foreground); }
.ladder-chart { padding: 12px 14px 4px; border-bottom: 1px solid var(--border); }
.lad { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto 64px 40px; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.lad:last-child { border-bottom: 0; }
.lad-n { font-weight: 650; color: var(--muted-foreground); } .lad-age { color: var(--muted-foreground); font-size: 12px; text-align: right; }
.lad-main a { color: inherit; }
.ar { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto 56px 36px; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; color: inherit; }
.ar:last-child { border-bottom: 0; }
.ar:hover { background: var(--muted); text-decoration: none; }
.ar-out { justify-content: center; }
.ar-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ar-main b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-effect { display: flex; gap: 4px; justify-content: flex-end; }
.ar-lane { color: var(--muted-foreground); font-family: var(--font-mono); font-size: 12px; }
.ar-age { color: var(--muted-foreground); font-size: 12px; text-align: right; }
/* an attempt's page */
.att-head { margin-bottom: 8px; }
.att-crumb { display: flex; align-items: center; gap: 8px; color: var(--muted-foreground); font-size: 13px; margin-bottom: 6px; }
.att-title { font-size: 20px; line-height: 1.3; margin: 0 0 6px; max-width: 920px; font-weight: 650; }
.att-head a { color: var(--primary); }
.decide { border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); background: var(--warning-surface); border-radius: var(--radius); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.decide-bad { border-color: color-mix(in srgb, var(--error) 45%, var(--border)); background: var(--error-surface); }
.decide-violet { border-color: color-mix(in srgb, var(--violet-foreground) 35%, var(--border)); background: color-mix(in srgb, var(--violet-foreground) 6%, transparent); }
.decide-q { display: flex; align-items: center; gap: 12px; font-size: 14px; }
.decide-q .dq-age { margin-left: auto; }
.decide-why { font-size: 13px; }
.decide dl.dq-choices { border-top-color: color-mix(in srgb, var(--foreground) 12%, transparent); }
ol.stepper { list-style: none; margin: 0; padding: 0; }
ol.stepper li { display: grid; grid-template-columns: 14px minmax(0, 1fr) 40px; gap: 10px; align-items: start; padding: 6px 0; font-size: 13px; position: relative; }
ol.stepper li:not(:last-child)::before { content: ""; position: absolute; left: 4px; top: 18px; bottom: -8px; width: 2px; background: var(--border); }
ol.stepper .sd { width: 10px; height: 10px; border-radius: 50%; background: var(--border); margin-top: 4px; position: relative; z-index: 1; }
ol.stepper li.ok .sd { background: var(--success); } ol.stepper li.bad .sd { background: var(--error); } ol.stepper li.warn .sd { background: var(--warning); }
ol.stepper li.ok .st { color: var(--success-foreground); } ol.stepper li.bad .st { color: var(--error-foreground); } ol.stepper li.warn .st { color: var(--warning-foreground); }
ol.stepper .sa { color: var(--muted-foreground); font-size: 12px; text-align: right; }
details.matrix .card { border: 0; border-radius: 0; }
.fw { padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; } .fw:last-child { border-bottom: 0; }
.fl { display: grid; grid-template-columns: minmax(0, 1fr) 130px 84px; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.fl:last-child { border-bottom: 0; }
.fl code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fl-bar { display: flex; height: 8px; } .fl-bar i { display: block; } .fl-bar .add { background: var(--success); } .fl-bar .rem { background: var(--error); }
.fl-n { text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }

/* a rig's page */
.ck { display: grid; grid-template-columns: 90px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.ck:last-child { border-bottom: 0; }
.ck-res .chip { min-width: 70px; justify-content: center; }
.ck-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ck-sum { font-size: 13px; } .ck-sum.bad { color: var(--error-foreground); }
.ck-what { color: var(--muted-foreground); font-size: 12px; }
.rr { display: grid; grid-template-columns: 80px minmax(0, 1fr) auto 100px; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; color: inherit; }
.rr:last-child { border-bottom: 0; }
.rr:hover { background: var(--muted); text-decoration: none; }
.rr .chip { justify-content: center; }
.rr-need { text-align: right; }
.camp + .camp { margin-top: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; width: 100%; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; font-weight: 600; }
.form-grid label .muted { font-weight: 400; }
.form-grid input, .form-grid select { width: 100%; }
.form-grid input[readonly] { background: var(--muted); color: var(--muted-foreground); }
.form-end { grid-column: 1 / -1; }
.route-name { color: var(--foreground); }
.rr-route { grid-template-columns: 80px minmax(0, 1fr) auto; align-items: center; }
.route-acts { display: flex; gap: 6px; align-items: center; } .route-acts select { width: 260px; } .route-acts select.harness { width: 140px; }
@media (max-width: 760px) { .form-grid { grid-template-columns: minmax(0, 1fr); } }
.camp-top { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.camp-name { font-weight: 650; font-size: 15px; }
.camp-said { margin-top: 3px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
ol.steps { margin: 0; padding-left: 18px; font-size: 13px; } ol.steps li { margin: 3px 0; }
.explain { color: var(--muted-foreground); font-size: 12px; margin: 4px 0 0; }

/* what happened: one sentence a row */
.tl-row { display: grid; grid-template-columns: 44px 8px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.tl-row:last-child { border-bottom: 0; }
.tl-t { color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; }
.tl-row .dot { align-self: start; margin-top: 6px; }
.tl-s { min-width: 0; word-break: break-word; } .tl-s a { color: var(--primary); }
.tl-rig { color: var(--muted-foreground); font-size: 12px; white-space: nowrap; }


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
/* Form labels with an info icon: hovering or focusing it shows what the field means (#tip). */
.lb { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.ii { display: inline-grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; border: 1px solid var(--muted-foreground); color: var(--muted-foreground); font: italic 600 10px/1 Georgia, serif; cursor: help; flex: none; }
.ii:hover, .ii:focus { background: var(--foreground); color: var(--background); border-color: var(--foreground); outline: none; }
#tip { position: fixed; z-index: 50; max-width: 340px; padding: 10px 12px; border-radius: 8px; background: var(--foreground); color: var(--background); font-size: 12.5px; line-height: 1.45; box-shadow: 0 6px 24px rgba(0,0,0,.18); pointer-events: none; display: none; }
/* The new-campaign page. */
#nc [hidden] { display: none !important; }
.fd { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; min-width: 0; }
.fd input:not([type=checkbox]):not([type=file]), .fd select, .fd textarea { height: 34px; padding: 0 10px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 13px; width: 100%; }
.fd textarea { height: 64px; padding: 8px 10px; font-family: var(--font-mono); font-size: 12px; }
.g2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.g3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 16px; }
.cards3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 900px) { .g2, .g3, .cards3 { grid-template-columns: 1fr; } }
.ch { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; font-size: 13px; line-height: 1.45; cursor: pointer; background: var(--card); }
.ch:hover { border-color: color-mix(in srgb, var(--foreground) 30%, transparent); }
.ch.on { border-color: var(--primary); background: var(--primary-surface); }
.ch.dis { opacity: .5; cursor: not-allowed; }
.ch b { display: block; font-size: 13.5px; margin-bottom: 2px; }
.ch .muted { font-size: 12.5px; }
.dotx { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--input); margin-top: 2px; }
.ch.on .dotx { border-color: var(--primary); background: radial-gradient(var(--primary) 0 3px, transparent 4px); }
.sec { margin-bottom: 26px; }
.sec > h2 { font-size: 15px; margin: 0 0 4px; }
.sec > p.lead { margin: 0 0 12px; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; max-width: 820px; }
.nc-does { border-left: 3px solid var(--border); padding: 4px 0 4px 12px; margin: 12px 0 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.nc-does b { color: var(--foreground); font-weight: 600; }
.sum { font-size: 15px; line-height: 1.6; margin: 0 0 12px; }
.act { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.big { height: 38px; padding: 0 18px; font-size: 14px; }
.wiz { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 760px) { .wiz { grid-template-columns: 1fr; } }
ol.nc-steps { list-style: none; margin: 0; padding: 0; position: sticky; top: 70px; }
ol.nc-steps li { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 8px; font-size: 13px; color: var(--muted-foreground); cursor: pointer; }
ol.nc-steps li .k { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border); font-size: 11px; font-weight: 600; }
ol.nc-steps li.on { background: var(--accent); color: var(--foreground); font-weight: 600; }
ol.nc-steps li.on .k { background: var(--foreground); color: var(--background); border-color: var(--foreground); }
ol.nc-steps li.done .k { background: var(--success-surface); color: var(--success-foreground); border-color: transparent; }
.adv { border: 1px dashed var(--border); border-radius: var(--radius); padding: 0; margin-top: 8px; }
.adv > summary { cursor: pointer; padding: 10px 14px; font-size: 13px; font-weight: 600; color: var(--muted-foreground); }
.adv[open] > summary { border-bottom: 1px dashed var(--border); }
.adv > div { padding: 14px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-size: 12px; color: var(--muted-foreground); font-weight: 600; padding: 6px 8px; }
.tbl td { padding: 4px 8px; }
.tbl input, .tbl select { height: 30px; width: 100%; padding: 0 8px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 12.5px; }
.ph { display: inline-flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.ph button { height: 24px; font-family: var(--font-mono); font-size: 11px; padding: 0 8px; }
pre.json { background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; font-size: 11.5px; max-height: 360px; overflow: auto; margin: 0; }
`;
