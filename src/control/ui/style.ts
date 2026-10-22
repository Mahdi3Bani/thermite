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
/* The campaigns in the left navigation, with their folders (goal 077) */
.side-head { display: flex; align-items: center; margin: 16px 2px 4px 10px; }
.side-head .section { margin: 0; flex: 1; }
.sidebar .ib { width: 24px; height: 24px; padding: 0; display: inline-grid; place-items: center; border: 0; background: transparent; box-shadow: none; color: var(--muted-foreground); border-radius: 6px; cursor: pointer; list-style: none; }
.sidebar .ib::-webkit-details-marker { display: none; }
.sidebar .ib:hover, .sidebar .ib:focus-visible, .sidebar details[open] > summary.ib { background: var(--sidebar-row-hover); color: var(--foreground); }
.fnew { position: relative; }
.fnew > .menu-pop { top: 28px; right: 0; width: 224px; }
.side-camps { position: relative; display: flex; flex-direction: column; gap: 2px; }
.side-fold { position: relative; }
details.side-folder > summary { list-style: none; display: flex; align-items: center; gap: 6px; padding: 5px 34px 5px 6px; border-radius: var(--control-radius); font-size: 13px; cursor: pointer; user-select: none; }
details.side-folder > summary::-webkit-details-marker { display: none; }
details.side-folder > summary:hover { background: var(--sidebar-row-hover); }
details.side-folder > summary .icon { color: var(--muted-foreground); flex: none; }
details.side-folder > summary > .icon:first-child { transition: transform .15s; }
details.side-folder[open] > summary > .icon:first-child { transform: rotate(90deg); }
details.side-folder > summary .fname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details.side-folder > summary .n { margin-left: auto; font-size: 11px; color: var(--muted-foreground); }
.side-folder .side-row { padding-left: 30px; }
.side-empty { padding: 3px 10px 5px 30px; font-size: 12px; color: var(--muted-foreground); }
.fmenu { position: absolute; top: 3px; right: 4px; }
.fmenu > summary { list-style: none; }
.fmenu > .menu-pop { top: 28px; width: 224px; }
.fsep { height: 1px; background: var(--border); margin: 4px 0; }
.side-row[draggable="true"] { cursor: grab; }
.side-row[aria-current] { background: var(--sidebar-row-active); box-shadow: 0 0 0 1px var(--border); }
.side-row.dragging { opacity: .4; }
.side-drop { display: none; margin: 4px 2px 0; padding: 6px 10px; border: 1px dashed var(--input); border-radius: var(--control-radius); font-size: 12px; color: var(--muted-foreground); }
.side-dragging .side-drop { display: block; }
.side-dragging .side-fold > details.side-folder > summary { box-shadow: inset 0 0 0 1px var(--border); }
.side-fold.drop-over > details.side-folder > summary, .side-drop.drop-over { background: var(--primary-surface); box-shadow: inset 0 0 0 1.5px var(--primary); color: var(--foreground); }
.side-say { margin: 6px 6px 0; color: var(--muted-foreground); }
.side-say:empty { display: none; }
.side-say.bad { color: var(--error-foreground); }
/* A campaign's page: ⋯ with Move to folder and Archive */
.kmore-pop { width: 300px; }
.kmore-pop > form > button { justify-self: start; }
.kmove { display: flex; gap: 6px; } .kmove select { flex: 1; min-width: 0; }
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
.pager { display: flex; gap: 14px; margin-top: 10px; font-size: 12px; } .pager a { color: var(--primary); }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) 30px; }
  .sidebar { grid-row: 1; flex-direction: row; flex-wrap: wrap; padding: 8px; border-right: 0; border-bottom: 1px solid var(--border); }
  .sidebar .section, .sidebar .side-row, .sidebar .side-foot, .sidebar .side-head, .sidebar .side-camps, .sidebar .side-say { display: none; }
  .kmore-pop { width: min(300px, calc(100vw - 32px)); }
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
/* Edit rig's agents (goals 070, 073 and 074): two groups; Runs in and Context on every line */
.roles { display: grid; grid-template-columns: minmax(150px, .95fr) minmax(190px, 1.4fr) minmax(92px, .55fr) minmax(132px, .8fr) minmax(150px, .9fr); gap: 8px 14px; align-items: center; }
.roles .hd { font-size: 12px; font-weight: 600; color: var(--muted-foreground); }
.roles select { height: 32px; width: 100%; min-width: 0; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 13px; padding: 0 8px; }
.roles .ln { display: contents; }
.roles .ln[hidden] { display: none; }
.roles .grp { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--border); }
.roles .grp .lb { font-size: 11.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--foreground); }
.roles .ag { display: grid; gap: 1px; min-width: 0; }
.roles .ag .lb { font-size: 13px; }
.roles .job { font-size: 11.5px; line-height: 1.35; color: var(--muted-foreground); }
.roles select.bad { border-color: var(--error); }
.roles select:disabled { opacity: 1; color: var(--muted-foreground); background: transparent; border-style: dashed; cursor: default; }
.roles select option[hidden] { display: none; }
.t2-m, .mb-m { display: flex; align-items: center; gap: 6px; min-width: 0; }
.t2-m select, .mb-m select { flex: 1; min-width: 0; }
.mb-m .lb { flex: none; font-weight: 500; color: var(--muted-foreground); }
.t2-x { flex: none; width: 30px; height: 32px; padding: 0; justify-content: center; color: var(--muted-foreground); font-size: 16px; box-shadow: none; }
.t2-x:hover { text-decoration: none; }
.t2-add-c { grid-column: 2 / -1; margin-top: -4px; }
.t2-add-c .btn { height: 24px; padding: 0 8px; font-size: 12px; }
.ctx-w { position: relative; min-width: 0; }
.ctx-b { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); color: var(--foreground); font-size: 12.5px; font-variant-numeric: tabular-nums; list-style: none; cursor: pointer; user-select: none; }
.ctx-b::-webkit-details-marker { display: none; }
.ctx-b:hover { border-color: var(--muted-foreground); }
.ctx-w[open] > .ctx-b { border-color: var(--primary); background: var(--primary-surface); }
.ctx-w.ctx-bad > .ctx-b { border-color: var(--error); }
.ctx-w.off > .ctx-b { cursor: default; background: transparent; border-style: dashed; }
.ctx-w.off > .ctx-b:hover { border-color: var(--input); }
.ctx-b .ctx-car { flex: none; width: 7px; height: 7px; margin: -4px 2px 0 0; border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground); transform: rotate(45deg); }
.ctx-w[open] > .ctx-b .ctx-car { margin-top: 3px; transform: rotate(-135deg); }
.ctx-w.off .ctx-car { display: none; }
.ctx-b b { font-weight: 650; }
.ctx-k { display: none; color: var(--muted-foreground); }
.ctx-v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ctx-v .bad { color: var(--error-foreground); }
.ctx-pop { position: absolute; z-index: 40; top: calc(100% + 6px); right: 0; width: 320px; max-width: calc(100vw - 32px); display: grid; gap: 8px; padding: 10px 12px; background: var(--popover); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 34px rgb(0 0 0 / 18%); }
.ctx-f { display: grid; grid-template-columns: minmax(0, 1fr) 96px 42px; align-items: center; gap: 8px; margin: 0; }
.ctx-f input { height: 30px; width: 100%; padding: 0 8px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--background); font-variant-numeric: tabular-nums; }
.ctx-f input.bad { border-color: var(--error); }
.ctx-f > .muted { font-size: 12px; }
.ctx-msg { font-size: 12px; line-height: 1.4; color: var(--muted-foreground); }
.ctx-msg:empty { display: none; }
.ctx-msg.bad { color: var(--error-foreground); } .ctx-msg.warn { color: var(--warning-foreground); }
.row-say { grid-column: 2 / -1; margin-top: -3px; font-size: 12.5px; line-height: 1.45; color: var(--error-foreground); }
.chg li.bad { color: var(--error-foreground); }
@media (max-width: 900px) {
  .roles { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .roles .ag { grid-column: 1 / -1; padding-top: 6px; }
  .roles .ag-sp { display: none; }
  .roles select[data-role], .roles .t2-m, .roles .mb-m, .roles .ctx-w, .roles .row-say, .roles .t2-add-c { grid-column: 1 / -1; }
  .roles .ln.sub > .t2-m, .roles .ln.sub > .mb-m { padding-top: 8px; border-top: 1px dashed var(--border); }
  .roles .t2-add-c { margin-top: 0; }
  .roles .hd { display: none; }
  .roles .hd + .grp, .roles .hd + .hd { margin-top: 0; padding-top: 0; border-top: 0; }
  .ctx-pop { left: 0; width: auto; }
  .ctx-k { display: inline; }
}
.flag { border-left: 3px solid var(--warning-foreground); padding: 6px 0 6px 12px; margin: 12px 0 0; font-size: 13px; line-height: 1.5; }
.use { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 22px; font-size: 13px; }
.ubar { height: 8px; border-radius: 99px; background: var(--muted); overflow: hidden; margin: 4px 0 2px; }
.ubar > div { height: 100%; background: var(--primary); border-radius: 99px; }
.ubar.warn > div { background: var(--warning-foreground); }
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
details.howcheck > summary { cursor: pointer; font-size: 12px; color: var(--primary); width: fit-content; }
.howc { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 2px; padding: 8px 10px; border-left: 2px solid var(--border); }
.howc code { word-break: break-word; }
table.howc-cells { width: 100%; font-size: 12px; }
table.howc-cells td, table.howc-cells th { padding: 4px 8px 4px 0; vertical-align: top; }
.khow { margin-top: 12px; } .khow .gl { padding: 8px 0; }
details.more > summary { list-style: none; cursor: pointer; } details.more > summary::-webkit-details-marker { display: none; }
details.more > summary .more-tog::after { content: "more"; color: var(--primary); white-space: nowrap; }
details.more[open] > summary .more-part { display: none; } details.more[open] > summary .more-tog::after { content: "less"; }
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
.cks .ck { grid-template-columns: 132px minmax(0, 1fr) auto; }
/* An action followed to its outcome (goal 080): its words beside the button, or at the top. */
.fw-top { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; font-size: 13px; font-weight: 500; }
.fw-say { margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
.fw-say.ok { color: var(--success-foreground); } .fw-say.bad { color: var(--error-foreground); }
.lcol > .fw-say { margin: 0; padding: 6px 14px; border-top: 1px solid var(--border); background: var(--card); }
[data-fw-top] > .fw-top { margin: 0; padding: 8px 14px; border-width: 0 0 1px; border-radius: 0; box-shadow: none; }
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
#nc [hidden], #prov-add [hidden], #mcp-add [hidden] { display: none !important; }
.gr { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; cursor: pointer; }
.gr:last-child { border-bottom: 0; } .gr.used { color: var(--muted-foreground); cursor: not-allowed; }
#add-rig [hidden] { display: none !important; }
.dq-sent { display: inline-block; max-width: 380px; font-size: 12px; line-height: 1.45; color: var(--muted-foreground); text-align: right; white-space: normal; }
.dq-sent b { color: var(--foreground); }
/* The live view: every line has its time; tool calls read as commands. */
.lv-head { padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--card); }
.lv-head dl.facts { grid-template-columns: 110px minmax(0, 1fr); gap: 4px 12px; }
.lv-row { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; padding: 3px 0; align-items: baseline; font-size: 13px; line-height: 1.5; }
.lv-t { font: 12px var(--font-mono, ui-monospace, monospace); color: var(--muted-foreground); white-space: nowrap; cursor: default; }
.lv-body { min-width: 0; }
.lv-body details > summary { cursor: pointer; list-style: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-body details > summary::-webkit-details-marker { display: none; }
.lv-body details[open] > summary { white-space: normal; }
.lv-body pre { margin: 6px 0 4px; padding: 8px 10px; max-height: 360px; overflow: auto; background: var(--muted); border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.lv-name { display: inline-block; min-width: 62px; font: 600 12px var(--font-mono, ui-monospace, monospace); color: var(--foreground); }
.lv-cmd { font-size: 12px; background: none; padding: 0; }
.lv-res, .lv-hint .lv-res { margin-left: 8px; font-size: 12px; }
.lv-who { display: inline-block; margin-right: 8px; font-size: 11px; color: var(--muted-foreground); }
.lv-think summary { color: var(--muted-foreground); }
.lv-said { white-space: pre-wrap; }
.lv-status span, .lv-log span { color: var(--muted-foreground); }
.lv-unsigned { margin-left: 8px; font-size: 10px; color: var(--warning-foreground); }
/* Edit rig: one row per part, with its switch. */
.pt { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.pt:last-child { border-bottom: 0; } .pt.locked { opacity: .8; } .pt-off { margin-top: 4px; color: var(--muted-foreground); }
.pt-state { font-size: 12px; } .pt-state.on { color: var(--success-foreground); } .pt-state.off { color: var(--warning-foreground); }
.sw { position: relative; display: inline-block; width: 40px; height: 22px; margin-top: 2px; }
.sw input { opacity: 0; width: 0; height: 0; }
.knob { position: absolute; inset: 0; background: var(--border); border-radius: 999px; transition: .15s; cursor: pointer; }
.knob::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .15s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.sw input:checked + .knob { background: var(--primary); } .sw input:checked + .knob::before { transform: translateX(18px); }
.sw input:disabled + .knob { cursor: not-allowed; opacity: .6; }
.chg li { margin: 2px 0; }
.kind { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.kind.m { background: var(--primary-surface); color: var(--info-foreground); }
.kind.r { background: var(--warning-surface); color: var(--warning-foreground); }
.kind.g { background: color-mix(in srgb, var(--violet-foreground) 14%, transparent); color: var(--violet-foreground); }
.fd { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; min-width: 0; }
.fd input:not([type=checkbox]):not([type=file]), .fd select, .fd textarea { height: 34px; padding: 0 10px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 13px; width: 100%; }
.fd textarea { height: 64px; padding: 8px 10px; font-family: var(--font-mono); font-size: 12px; }
.g2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.g3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 16px; }
.cards3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 900px) { .g2, .g3, .cards3 { grid-template-columns: 1fr; } }
.ch { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; font-size: 13px; line-height: 1.45; cursor: pointer; background: var(--card); }
.ch > :only-child { grid-column: 1 / -1; }
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
/* A campaign's brief (goal 078): New campaign's boxes and preview, and its page's block */
.nc-brief { max-width: 1040px; }
.bl { display: grid; gap: 6px; }
.bl-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.bl-k { display: inline-grid; place-items: center; width: 22px; height: 22px; margin-top: 6px; border-radius: 50%; background: var(--accent); color: var(--muted-foreground); font-size: 11px; font-weight: 600; }
.fd .bl-row textarea { height: 54px; min-height: 34px; max-height: 480px; padding: 7px 10px; font: 13px/1.45 var(--font-sans); resize: vertical; }
.bl-row button { margin-top: 4px; }
.bl-act { margin-top: 2px; }
.md-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
@media (max-width: 900px) { .md-two { grid-template-columns: 1fr; } }
.fd .md-two textarea.md-in { height: 260px; min-height: 120px; padding: 8px 10px; font-size: 12.5px; line-height: 1.5; }
.md-out { height: 260px; overflow: auto; padding: 6px 12px; border: 1px dashed var(--input); border-radius: var(--control-radius); background: var(--muted); }
[data-md-say].bad, [data-bl-n].bad { color: var(--error-foreground); }
.md { font-size: 13.5px; line-height: 1.55; overflow-wrap: anywhere; }
.md h3, .md h4, .md h5, .md h6 { margin: 12px 0 4px; font-size: 14px; } .md h3 { font-size: 15px; }
.md > :first-child { margin-top: 6px; }
.md p { margin: 6px 0; } .md ul, .md ol { margin: 6px 0; padding-left: 22px; } .md li { margin: 2px 0; }
.md a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.md pre { margin: 6px 0; padding: 8px 10px; background: var(--code-background); border-radius: var(--control-radius); overflow: auto; white-space: pre-wrap; }
.md blockquote { margin: 6px 0; padding: 0 0 0 10px; border-left: 3px solid var(--border); color: var(--muted-foreground); }
.md hr { border: 0; border-top: 1px solid var(--border); margin: 10px 0; }
.kbrief { display: grid; gap: 14px; }
.kb-part .lb { margin-bottom: 4px; }
.kb-list { margin: 4px 0 0; padding-left: 22px; font-size: 13.5px; line-height: 1.5; } .kb-list li { margin: 3px 0; }
.kb-info > summary { cursor: pointer; font-size: 13px; }
.kb-info .md { margin-top: 6px; padding: 4px 12px; border-left: 3px solid var(--border); }
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
/* Campaigns: at work, waiting, every campaign (goal 063) */
.av.ck { background: #71717a; }
.kwork { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); gap: 14px; }
.kwork.one { grid-template-columns: minmax(0, 1fr); }
.kcard { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.kcard .brief { border: 0; margin: 0; box-shadow: none; flex: 1; }
.kfoot { display: flex; gap: 8px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--border); background: var(--muted); }
.kfoot form { display: inline; }
.kneed { display: flex; gap: 12px; align-items: center; padding: 10px 14px; margin-bottom: 22px; border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); background: var(--warning-surface); border-radius: var(--radius); font-size: 13px; }
.kneed svg { color: var(--warning-foreground); flex: none; }
.ktools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.fchip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--input); background: var(--card); color: var(--foreground); font-size: 12.5px; font-weight: 500; }
.fchip:hover { background: var(--accent); text-decoration: none; }
.fchip .n { color: var(--muted-foreground); }
.fchip.on { background: var(--foreground); color: var(--background); border-color: var(--foreground); }
.fchip.on .n { color: color-mix(in srgb, var(--background) 70%, transparent); }
.ksearch { margin-left: auto; }
.ksearch input { height: 30px; width: 260px; max-width: 60vw; padding: 0 10px; border-radius: var(--control-radius); border: 1px solid var(--input); background: var(--card); font-size: 13px; }
.ktable td { vertical-align: middle; }
.ktable tr.click:hover td { background: var(--accent); }
.kname { display: flex; gap: 10px; align-items: center; color: inherit; }
.kname:hover { text-decoration: none; } .kname:hover b { text-decoration: underline; }
.kabout { display: block; font-size: 12px; color: var(--muted-foreground); margin-top: 1px; }
/* the Rigs list: one row for each rig */
.rtable td { vertical-align: top; padding-top: 10px; padding-bottom: 10px; }
.rtable .rsub { display: block; font-size: 12px; color: var(--muted-foreground); margin-top: 1px; white-space: normal; }
.rtable .nowrap, .rtable td.nowrap .rsub { white-space: nowrap; }
.rtable a.kname b { font-size: 13.5px; }
.rtable .vchip { text-decoration: none; cursor: pointer; }
.rtable .vchip:hover { text-decoration: underline; }
.rtable tr.click { cursor: pointer; }
.kdots { display: inline-flex; gap: 10px; font-size: 12.5px; white-space: nowrap; }
.kdot { display: inline-flex; align-items: center; gap: 5px; }
.kdot::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--input); }
.kdot.run::before { background: var(--success); } .kdot.pause::before { background: var(--warning); } .kdot.done::before { background: #a1a1aa; }
.kst { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
.kst.pause { background: var(--warning-surface); color: var(--warning-foreground); } .kst.done { background: var(--accent); color: var(--muted-foreground); }
.khead { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: start; margin-bottom: 22px; }
.kabout-big { font-size: 14px; margin-top: 3px; }
.kgoals { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.kgoal { font-size: 12px; padding: 3px 8px; border-radius: 6px; background: var(--accent); }
.kgoal.ok { background: var(--success-surface); color: var(--success-foreground); } .kgoal.bad { background: var(--error-surface); color: var(--error-foreground); }
details.kmore > summary { cursor: pointer; text-align: center; padding: 8px; font-size: 12.5px; color: var(--info-foreground); border-top: 1px solid var(--border); }
details.menu { position: relative; display: inline-block; }
details.menu > summary { list-style: none; }
details.menu > summary::-webkit-details-marker { display: none; }
.menu-pop { position: absolute; right: 0; top: 38px; z-index: 30; width: 280px; padding: 10px; display: grid; gap: 6px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 30px rgb(0 0 0 / 14%); font-size: 13px; }
/* Start a run: a panel from the right */
.drawer-wrap { position: fixed; inset: 0; z-index: 50; }
.drawer-wrap[hidden] { display: none; }
.drawer-bg { position: absolute; inset: 0; background: rgb(0 0 0 / 28%); }
.drawer { position: absolute; top: 0; right: 0; bottom: 0; width: 540px; max-width: 100vw; background: var(--background); border-left: 1px solid var(--border); box-shadow: -10px 0 30px rgb(0 0 0 / 12%); }
.drawer-form { display: flex; flex-direction: column; height: 100%; }
.drawer-form > header { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
.drawer-form > header h3 { margin: 0; font-size: 15px; }
.drawer-body { padding: 18px 20px; overflow: auto; flex: 1; display: grid; gap: 18px; align-content: start; }
.drawer-form > footer { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; gap: 10px; align-items: center; background: var(--card); }
.sfd { display: grid; gap: 7px; }
.sfd > .lb { font-size: 13px; font-weight: 600; }
.sfd select, .sfd input { height: 32px; padding: 0 10px; border-radius: var(--control-radius); border: 1px solid var(--input); background: var(--card); font-size: 13px; width: 100%; }
.sopts { display: grid; gap: 6px; }
.sopt { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--control-radius); background: var(--card); cursor: pointer; font-size: 13px; }
.sopt:has(input:checked) { border-color: var(--primary); background: var(--primary-surface); }
.sopt.dis { opacity: .5; cursor: not-allowed; }
.sopt input { margin: 2px 0 0; height: auto; }
.sopt .sd { display: block; font-size: 12px; color: var(--muted-foreground); margin-top: 2px; }
.sopt .sr { font-size: 12px; white-space: nowrap; }
.sgrid { display: grid; gap: 14px; }
/* MCP servers (goal 068): their tools in Settings, and the kit's servers on the new-campaign page */
.tools { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tools th { text-align: left; font-weight: 600; font-size: 12px; color: var(--muted-foreground); padding: 4px 8px; border-bottom: 1px solid var(--border); }
.tools td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.tools tr:last-child td { border-bottom: 0; }
.tools td:first-child { font-family: var(--font-mono); white-space: nowrap; width: 1%; }
.more-tools summary { cursor: pointer; margin-top: 6px; }
.mcp-pick { display: grid; gap: 6px; }
.mcp-pick .sopt { grid-template-columns: 18px minmax(0, 1fr) auto; cursor: default; }
.mcp-pick .sopt:has(input:checked) { border-color: var(--border); background: var(--card); }
.mcp-pick .sopt:has(> input[data-srv-on]:checked) { border-color: var(--primary); background: var(--primary-surface); }
.mcp-who { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.mcp-who label { display: inline-flex; gap: 5px; align-items: center; height: 24px; padding: 0 9px; border: 1px solid var(--input); border-radius: 999px; font-size: 12px; background: var(--card); cursor: pointer; }
.mcp-who label:has(input:checked) { border-color: var(--primary); background: var(--primary-surface); }
.mcp-who input { height: auto; width: auto; margin: 0; }
.mcp-who.off { opacity: .45; pointer-events: none; }
.mcp-adv { margin-top: 8px; }
.mcp-tools td input { height: auto; width: auto; margin: 0; }
.mcp-tools td:not(:first-child):not(:nth-child(2)), .mcp-tools th:not(:first-child):not(:nth-child(2)) { text-align: center; width: 1%; }
/* Copy a campaign (goal 069): a panel like Start a run's */
#copy [hidden] { display: none !important; }
.cp-why { margin: 0; font-size: 14px; line-height: 1.55; }
.cp-say { font-size: 12.5px; line-height: 1.5; color: var(--muted-foreground); }
.cp-say.ok { color: var(--success-foreground); } .cp-say.bad { color: var(--error-foreground); }
.cp-say button { margin-left: 4px; vertical-align: baseline; height: 24px; font-size: 12px; padding: 0 8px; }
.sfd input.bad { border-color: var(--error); }
.cp-mcp-sum { font-size: 13px; line-height: 1.55; margin: 2px 0 0; display: grid; gap: 4px; }
.cp-req { white-space: pre-wrap; word-break: break-word; }
/* goal 070: a campaign's own agents' context */
.cc-f { display: grid; grid-template-columns: repeat(2, minmax(0, 220px)); gap: 0 16px; }
.cc-f .fd { margin-bottom: 4px; }
.cc-in { display: flex; align-items: center; gap: 8px; }
.cc-in input { flex: 1; min-width: 0; font-variant-numeric: tabular-nums; }
.fd .cc-in input.bad:not([type=checkbox]), .sfd .cc-in input.bad:not([type=checkbox]) { border-color: var(--error); }
.cc-in .muted { white-space: nowrap; }
.cc-help { font-size: 12.5px; line-height: 1.45; color: var(--muted-foreground); }
.cc-say { font-size: 12.5px; line-height: 1.45; margin-top: 3px; }
.cc-say:empty { display: none; }
.cc-say.bad { color: var(--error-foreground); } .cc-say.ok { color: var(--success-foreground); } .cc-say.warn { color: var(--warning-foreground); }
.cc-say b, .cc-line b, .cc-t b { font-weight: 650; }
.cc-sec { margin: 4px 0 14px; }
.cc-sec h2 { font-size: 14px; }
.cc-rigs-h { margin: 16px 0 6px; }
.cc-tw { max-width: 620px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.cc-t th, .cc-t td { padding: 7px 12px; }
.cc-t td.num, .cc-t th.num { text-align: right; font-variant-numeric: tabular-nums; }
.cc-t tr:last-child td { border-bottom: 0; }
.cc-t tr.bad td { background: var(--error-surface); }
.cc-st.ok { color: var(--success-foreground); } .cc-st.bad { color: var(--error-foreground); }
.cc-line .bad, .cc-rignote.bad { color: var(--error-foreground); }
.cc-act { margin-top: 14px; }
.cc-chg.bad { color: var(--error-foreground); }
[data-start-sum].bad { color: var(--error-foreground); }
.drawer .cc-f { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 760px) { .cc-f, .drawer .cc-f { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { .cc-t { font-size: 12px; } .cc-t th, .cc-t td { padding: 6px; } .cc-t th { white-space: normal; } .cc-t td:first-child { white-space: nowrap; } }
@media (max-width: 600px) {
  /* Copy and Start a run don't fit beside a long name: the buttons go under it. */
  .topbar:has([data-open="#copy"]), .topbar:has([data-campaign-more]) { flex-wrap: wrap; row-gap: 6px; padding-top: 8px; padding-bottom: 8px; }
  .drawer .mcp-pick .sopt { grid-template-columns: 18px minmax(0, 1fr); }
  .drawer .mcp-pick .sopt > .sr { display: none; }
}
/* Live, one run at a time: the stream gets the room */
.lwrap { display: grid; grid-template-columns: 230px minmax(0, 1fr); width: 100%; min-height: 0; position: relative; }
.lwrap.closed { grid-template-columns: minmax(0, 1fr); } .lwrap.closed .lruns { display: none; }
@media (max-width: 1180px) {
  .lwrap { grid-template-columns: minmax(0, 1fr); } .lwrap .lruns { display: none; }
  .lwrap.open .lruns { display: block; position: absolute; z-index: 20; top: 0; bottom: 0; left: 0; width: 250px; box-shadow: 8px 0 24px rgb(0 0 0 / 12%); }
}
.lruns { border-right: 1px solid var(--border); overflow-y: auto; padding: 12px 8px; background: var(--sidebar); }
.lruns .hd { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted-foreground); margin: 10px 8px 6px; cursor: default; }
.lruns details > summary { list-style: none; cursor: pointer; } .lruns details > summary::-webkit-details-marker { display: none; }
.lr { display: block; padding: 8px 10px; border-radius: 8px; color: inherit; margin-bottom: 2px; }
.lr:hover { background: var(--sidebar-row-hover); text-decoration: none; }
.lr.on { background: var(--sidebar-row-active); box-shadow: 0 0 0 1px var(--border); }
.lr .t { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lr .s { display: block; font-size: 12px; color: var(--muted-foreground); margin-top: 1px; }
.lr.idle .t { font-weight: 500; color: var(--muted-foreground); }
.lempty { font-size: 12.5px; color: var(--muted-foreground); padding: 4px 10px; }
.lcol { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.lhead { display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-bottom: 1px solid var(--border); background: var(--card); min-width: 0; }
.lhead .t { font-weight: 650; font-size: 14px; white-space: nowrap; }
.lhead form { display: inline; }
.lmeta { flex: 1; min-width: 0; font-size: 12px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lchips { display: flex; gap: 5px; align-items: center; padding: 6px 14px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
.lchip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--input); background: var(--card); color: var(--foreground); font-size: 12.5px; font-weight: 500; flex: none; cursor: pointer; }
.lchip:hover { background: var(--accent); text-decoration: none; }
.lchip.on { background: var(--foreground); color: var(--background); border-color: var(--foreground); }
.lchip.lfollow.on { background: var(--accent); color: var(--foreground); border-color: var(--input); }
.lstream { padding: 10px 18px 16px; gap: 4px; }
.lstream [hidden] { display: none !important; }
.lv-div { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; font-size: 12px; color: var(--muted-foreground); }
.lv-div::before, .lv-div::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.lv-div b { color: var(--foreground); font-weight: 600; }
.lv-md p { margin: 0 0 6px; } .lv-md p:last-child { margin: 0; } .lv-md code { font-size: 12px; }
.lv-you .you { display: inline-block; background: var(--primary-surface); border: 1px solid color-mix(in srgb, var(--primary) 25%, transparent); border-radius: 10px; padding: 6px 11px; white-space: pre-wrap; }
.lv-read .lv-body { font-size: 12px; }
.lv-answer .answer { display: inline-block; background: var(--card); border: 1px solid var(--border); border-left: 3px solid #0d9488; border-radius: 10px; padding: 6px 11px; }
.lv-answer .answer p { display: inline; margin: 0; }
.lkept { position: relative; flex: none; } .lkept > summary { list-style: none; } .lkept > summary::-webkit-details-marker { display: none; }
.lkept .menu-pop { top: 30px; width: 340px; }
.lkept .krow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; padding-top: 8px; border-top: 1px solid var(--border); }
.lkept .krow form { display: inline; }
.lcomposer { display: flex; gap: 6px; align-items: flex-end; padding: 8px 14px; border-top: 1px solid var(--border); background: var(--card); }
.lcomposer.off { color: var(--muted-foreground); font-size: 13px; padding: 12px 16px; }
.lcomposer textarea { flex: 1; min-height: 34px; max-height: 160px; height: 34px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--input); resize: none; line-height: 1.4; background: var(--background); font-size: 13.5px; }
.lcomposer .lto { height: 34px; width: auto; max-width: 200px; flex: none; font-weight: 500; }
.lcomposer button { height: 34px; flex: none; }
.lpin { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: var(--control-radius); border: 1px solid var(--input); cursor: pointer; flex: none; opacity: .5; }
.lpin input { position: absolute; opacity: 0; pointer-events: none; }
.lpin:has(input:checked) { opacity: 1; background: var(--accent); }
.lpin[hidden] { display: none; }
.lnotice { display: flex; gap: 8px; align-items: center; padding: 8px 14px; border-top: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); background: var(--warning-surface); font-size: 13px; }
.lnotice svg { color: var(--warning-foreground); flex: none; }
/* The experiment queue and the Planner tab (goal 064) */
.qcols { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 20px; align-items: start; }
@media (max-width: 1100px) { .qcols { grid-template-columns: minmax(0, 1fr); } }
.qside { display: grid; gap: 14px; }
.qcard { padding: 12px 14px; display: grid; gap: 8px; font-size: 13px; }
.qcard h3 { margin: 0; font-size: 13px; font-weight: 650; }
.qlist { display: grid; gap: 6px; }
.qi { display: grid; grid-template-columns: 18px 22px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px 12px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
.qi.drag { opacity: .45; } .qi.over { box-shadow: 0 -2px 0 var(--primary); }
.qh { cursor: grab; color: var(--muted-foreground); user-select: none; line-height: 20px; }
.qn { font: 600 12px var(--font-mono); color: var(--muted-foreground); line-height: 20px; }
.qt { font-weight: 600; font-size: 13.5px; }
.qwhy { font-size: 12.5px; color: var(--muted-foreground); margin-top: 3px; }
.qmeta { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.qacts { display: flex; gap: 4px; align-items: center; opacity: .35; } .qi:hover .qacts, .qi:focus-within .qacts { opacity: 1; }
.qacts form { display: inline; }
.qsrc { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 5px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.qsrc.planner { background: color-mix(in srgb, #7c3aed 12%, transparent); color: var(--violet-foreground); }
.qsrc.teacher { background: color-mix(in srgb, #0d9488 13%, transparent); color: #0f766e; }
.qsrc.auditor { background: var(--accent); color: var(--muted-foreground); }
.qsrc.you { background: var(--primary-surface); color: var(--info-foreground); }
.qsrc.lane { background: color-mix(in srgb, #0e7490 12%, transparent); color: #0e7490; }
.qdir { font: 500 11.5px var(--font-mono); color: var(--muted-foreground); }
.qadd { display: grid; grid-template-columns: minmax(0, 1fr) 180px 140px auto; gap: 8px; align-items: end; padding: 12px; border: 1px dashed var(--input); border-radius: 10px; margin-bottom: 10px; }
.qadd .qwhy-f { grid-column: 1 / -2; }
@media (max-width: 760px) { .qadd { grid-template-columns: minmax(0, 1fr); } .qadd .qwhy-f { grid-column: auto; } }
.qlane { display: grid; gap: 3px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
.qlt { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted-foreground); }
.qlt b { color: var(--foreground); }
.qidea { display: grid; gap: 4px; padding: 8px 10px; border: 1px dashed var(--input); border-radius: 8px; }
.qb { display: flex; gap: 6px; margin-top: 2px; } .qb form { display: inline; }
.qres { font-weight: 600; font-size: 12.5px; }
.menu-pop.qedit { width: min(360px, 86vw); } .menu-pop.qedit form { display: grid; gap: 8px; } .menu-pop.qedit textarea, .menu-pop.qedit input { width: 100%; }
.qres.win, .qres.done { color: var(--success-foreground); } .qres.wait { color: var(--warning-foreground); } .qres.broken { color: var(--error-foreground); } .qres.loss, .qres.flat, .qres.none { color: var(--muted-foreground); font-weight: 500; }
.qrules { display: grid; gap: 8px; }
.qrule { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); font-size: 13px; }
.qrule form { display: inline; }
.qkind { font: 700 11px var(--font-mono); text-transform: uppercase; padding: 3px 7px; border-radius: 5px; text-align: center; background: var(--accent); color: var(--muted-foreground); }
.qkind.avoid { background: var(--error-surface); color: var(--error-foreground); } .qkind.always { background: var(--success-surface); color: var(--success-foreground); } .qkind.try { background: var(--primary-surface); color: var(--info-foreground); }
.qrule.legacy { border-style: dashed; }
.qrule .qb { margin-top: 0; }
@media (max-width: 760px) { .qrule { grid-template-columns: 64px minmax(0, 1fr); } .qrule > :last-child { grid-column: 2; } }
/* Directions, written :name: (goal 066); dashed while the planner has yet to design one */
.dtok { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font: 500 12px var(--font-mono); background: color-mix(in srgb, #7c3aed 10%, transparent); color: var(--violet-foreground); white-space: nowrap; vertical-align: baseline; }
.dtok i { font-style: normal; opacity: .45; }
.dtok.new { background: transparent; border: 1px dashed color-mix(in srgb, #7c3aed 45%, transparent); }
.dtok.bad { background: var(--error-surface); color: var(--error-foreground); }
.dlist { display: grid; gap: 2px; max-height: 480px; overflow-y: auto; }
.dlrow { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.dlrow:last-child { border-bottom: 0; }
.dlrow .muted { margin-left: auto; text-align: right; }
.dlrow.fresh { background: color-mix(in srgb, #7c3aed 5%, transparent); }
.dlrow .qkind, .dpick .qkind { padding: 1px 5px; }
/* The : picker in Tell the planner */
.dpick { position: fixed; z-index: 60; width: 360px; max-width: calc(100vw - 24px); background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 34px rgb(0 0 0 / 18%); font-size: 13px; overflow: hidden; }
.dpick[hidden] { display: none; }
.dpick .dh { padding: 8px 12px 6px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted-foreground); border-bottom: 1px solid var(--border); }
.dpick .dl { max-height: 260px; overflow-y: auto; padding: 4px; }
.dpick .dr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 7px 9px; border-radius: 7px; cursor: pointer; }
.dpick .dr.on { background: var(--primary-surface); }
.dpick .dr.fresh { border-top: 1px dashed var(--border); border-radius: 0 0 7px 7px; }
.dpick .dr .n { font: 500 12.5px var(--font-mono); }
.dpick .dr .r { display: flex; gap: 4px; font-size: 11px; }
.dpick .dr .s { grid-column: 1 / -1; font-size: 11.5px; color: var(--muted-foreground); }
.dpick .dnone { padding: 10px 12px; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.dpick .df { padding: 6px 12px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--muted-foreground); }
.dpick kbd { font: 600 10.5px var(--font-mono); padding: 1px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--muted); }
/* Tell the planner: the box, and each message with the planner's answer */
.qtell { display: grid; gap: 8px; }
.qtell .ktools { margin: 0; }
.qtell .nc-does { margin: 2px 0 0; }
.qthread { display: grid; gap: 12px; margin-top: 4px; }
.qthread:empty { display: none; }
.qturn { display: grid; gap: 6px; }
.qmsg { padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.qmsg.you { background: var(--muted); }
.qmsg.planner { border-color: color-mix(in srgb, #7c3aed 30%, var(--border)); }
.qmsg ul { margin: 4px 0 0; padding-left: 18px; display: grid; gap: 5px; }
.qmh { margin-bottom: 3px; }
.qstep { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 13px; line-height: 1.45; color: var(--muted-foreground); }
.qstep .ic { width: 18px; height: 18px; border-radius: 50%; margin-top: 1px; border: 2px solid var(--border); }
.qstep.wait .ic { border-top-color: var(--primary); animation: qspin .9s linear infinite; }
@keyframes qspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .qstep.wait .ic { animation: none; } }
.qhands { padding: 4px 14px; margin-bottom: 22px; }
.qhand { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.qhand:last-child { border-bottom: 0; }
.qhand .tm { font: 12px var(--font-mono); color: var(--muted-foreground); }
.qhand ul { margin: 4px 0 0; padding-left: 18px; display: grid; gap: 2px; }
/* Journals and the knowledge base (goal 065) */
.jcols { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
@media (max-width: 1100px) { .jcols { grid-template-columns: minmax(0, 1fr); } }
.jside { display: grid; gap: 14px; }
.jnote { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; display: grid; gap: 6px; margin-bottom: 8px; }
.jnote[hidden] { display: none; }
.jhead { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--muted-foreground); }
.jtext { font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.jctx { font-size: 12px; color: var(--muted-foreground); overflow-wrap: anywhere; }
.jk { font: 700 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 5px; background: var(--accent); color: var(--muted-foreground); }
.jk.obs { background: var(--primary-surface); color: var(--info-foreground); } .jk.dec { background: var(--success-surface); color: var(--success-foreground); }
.jk.sur { background: var(--warning-surface); color: var(--warning-foreground); } .jk.que { background: color-mix(in srgb, #7c3aed 12%, transparent); color: var(--violet-foreground); } .jk.les { background: var(--accent); color: var(--foreground); }
.jsearch { height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--input); background: var(--card); font-size: 12.5px; margin-left: auto; width: 220px; max-width: 100%; }
.qsel { height: 28px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--input); background: var(--card); font-size: 12.5px; width: auto; max-width: 100%; }
.qsel[data-qd] { margin-left: auto; }
.jstat { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; font-size: 12.5px; }
.jstat b { text-align: right; font-variant-numeric: tabular-nums; }
.jsnote { display: grid; gap: 3px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px; overflow-wrap: anywhere; }
details.jmore { display: grid; gap: 6px; } details.jmore > summary { cursor: pointer; color: var(--info-foreground); }
.kfold { display: grid; grid-template-columns: 34px minmax(0, 1fr) 150px 230px; gap: 12px; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.kfold:last-child { border-bottom: 0; }
.kfold a { color: inherit; }
@media (max-width: 900px) { .kfold { grid-template-columns: 34px minmax(0, 1fr); } }
.kfic { width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; background: var(--accent); font-size: 16px; }
.kbsearch { display: grid; grid-template-columns: minmax(0, 1fr) 170px 200px auto; gap: 8px; align-items: end; margin-bottom: 10px; }
@media (max-width: 760px) { .kbsearch { grid-template-columns: minmax(0, 1fr); } }
.kbresults { padding: 10px 14px; display: grid; gap: 6px; }
details.kbres { border: 1px solid var(--border); border-radius: 8px; background: var(--card); }
details.kbres > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 10px; font-size: 12.5px; }
details.kbres > summary::-webkit-details-marker { display: none; }
.kbic { font-size: 14px; line-height: 18px; }
.kbbody { padding: 0 12px 10px 40px; font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.kbcard { padding: 12px 14px; display: grid; gap: 8px; }
.kbbtns { display: flex; gap: 6px; }
.kbreads { margin-bottom: 10px; }
.readrow { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
.readrow:last-child { border-bottom: 0; }
.kbadd { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
.kbadd .sfd { width: 300px; max-width: 100%; }
.past { display: grid; gap: 6px; }
.past .pastrow { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); font-size: 12.5px; cursor: pointer; }
.past .pastrow:has(input:checked) { border-color: var(--primary); background: var(--primary-surface); }
.past .pastrow input { margin: 2px 0 0; height: auto; width: auto; }
/* a rig's page: its state, and the steps of a change under way */
.card.ok { border-color: color-mix(in srgb, var(--success) 45%, transparent); }
button:disabled { opacity: .5; cursor: not-allowed; }
.steps { display: grid; gap: 2px; margin: 10px 0 0; }
.step { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; padding: 4px 0; font-size: 13px; line-height: 1.45; }
.step .ic { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; margin-top: 1px; }
.step.ok .ic { background: var(--success-surface); color: var(--success-foreground); }
.step.bad .ic { background: var(--error-surface); color: var(--error-foreground); }
.step.wait .ic { border: 2px solid var(--border); border-top-color: var(--primary); animation: stepspin 0.9s linear infinite; }
.step.todo { color: var(--muted-foreground); } .step.todo .ic { border: 2px solid var(--border); }
@keyframes stepspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .step.wait .ic { animation: none; } }
.flash { padding: 8px 12px; border-radius: 8px; background: var(--success-surface); color: var(--success-foreground); font-size: 13px; }
.flash.bad { background: var(--error-surface); color: var(--error-foreground); }
/* RunPod: the launch form and a rig's pod */
.gtab { display: grid; grid-template-columns: 18px minmax(0, 1.4fr) 80px 110px 110px; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; cursor: pointer; }
.gtab:last-child { border-bottom: 0; }
.gtab.hd { color: var(--muted-foreground); font-size: 12px; font-weight: 600; background: var(--muted); cursor: default; }
.gtab.on { background: var(--primary-surface); }
.gtab .num { text-align: right; font-variant-numeric: tabular-nums; }
.gtab input { width: auto; height: auto; margin: 0; accent-color: var(--primary); }
@media (max-width: 760px) { .gtab { grid-template-columns: 18px minmax(0, 1fr) 90px; } .gtab > :nth-child(3), .gtab > :nth-child(5) { display: none; } }
.price { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.facts4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 14px; }
@media (max-width: 900px) { .facts4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.fact { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--card); }
.fact .k { color: var(--muted-foreground); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.fact .v { font-size: 20px; font-weight: 650; margin-top: 2px; font-variant-numeric: tabular-nums; }
.fact .s { color: var(--muted-foreground); font-size: 12px; margin-top: 2px; }
.fact .bar { margin-top: 8px; }
.lc { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 1100px) { .lc { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.lcb { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; background: var(--card); display: grid; gap: 6px; align-content: start; font-size: 12.5px; line-height: 1.45; }
.lcb.off { opacity: .55; }
.lcb button { justify-content: center; }
.lcb .muted { font-size: 12px; }
.lcb input { height: 30px; padding: 0 8px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--background); font-size: 12.5px; width: 100%; }
.outlist { display: grid; gap: 0; }
.outrow { display: grid; grid-template-columns: 18px minmax(0, 1fr) 120px; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.outrow:last-child { border-bottom: 0; }
.outrow .small { text-align: right; }
/* goal 075: model use and cost (a run's top and Stats tab, a campaign's sidebar, Metrics, Model prices) */
#model-use { margin-bottom: 18px; }
/* A campaign's page has model use in its sidebar: its Knowledge block stacks in the main column. */
.run-cols .kbcols { grid-template-columns: minmax(0, 1fr); gap: 12px; }
.ufacts { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.5fr) repeat(4, minmax(0, 1fr)); gap: 10px; margin: 0 0 6px; }
.ufacts .fact { padding: 10px 12px; min-width: 0; }
.ufacts .fact .v { font-size: 22px; letter-spacing: -.01em; }
.ufacts .fact .v .u { font-size: 12px; font-weight: 500; color: var(--muted-foreground); letter-spacing: 0; }
.ufacts .fact .s { font-variant-numeric: tabular-nums; }
.ufacts .nr, .uside .nr { font-size: 15px; font-weight: 500; font-style: italic; color: var(--muted-foreground); }
.ufacts .s .ii, .uside .s .ii { display: inline-grid; margin-right: 5px; vertical-align: -3px; }
.usplit { display: flex; height: 6px; margin: 8px 0 6px; border-radius: 999px; overflow: hidden; background: var(--border); gap: 1px; }
.usplit i { display: block; height: 100%; min-width: 2px; }
.usplit .c, .ulg i.c { background: var(--primary); }
.usplit .n, .ulg i.n { background: color-mix(in srgb, var(--foreground) 30%, transparent); }
.usplit .r, .ulg i.r { background: repeating-linear-gradient(135deg, var(--muted-foreground) 0 2px, transparent 2px 4px); }
.usplit .o, .ulg i.o { background: var(--violet-foreground); }
.usplit .g, .ulg i.g { background: var(--warning); }
.ulg { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.ulg span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.ulg b { color: var(--foreground); font-weight: 600; }
.ulg i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.uspark { display: flex; align-items: flex-end; gap: 2px; height: 20px; margin-top: 6px; }
.uspark i { flex: 1; min-width: 1px; border-radius: 1px; background: color-mix(in srgb, var(--primary) 55%, transparent); }
.u-h { margin: 16px 0 6px; font-size: 12.5px; font-weight: 600; }
.utw { overflow-x: auto; }
.ut { font-size: 12.5px; }
.ut th, .ut td { padding: 7px 10px; }
.ut td { vertical-align: top; }
.ut td.num { white-space: nowrap; }
.ut th .lb { font-weight: 500; }
.ut th.num .lb { justify-content: flex-end; }
.ut .u-m { font-weight: 600; }
.ut .us { display: block; margin-top: 1px; font-size: 11.5px; color: var(--muted-foreground); white-space: nowrap; }
.ut .nr { font-size: 11.5px; font-style: italic; color: var(--muted-foreground); white-space: nowrap; }
.ut td .ii { display: inline-grid; margin-right: 5px; vertical-align: -3px; }
.ut tr.grp td { padding: 5px 10px; background: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted-foreground); }
.ut tr.u-gpu td { background: color-mix(in srgb, var(--warning) 6%, transparent); }
.ut .ush { display: inline-flex; align-items: center; gap: 8px; }
.ut .ush > i { display: block; width: 48px; height: 5px; border-radius: 999px; background: var(--border); overflow: hidden; }
.ut .ush > i > b { display: block; height: 100%; background: var(--primary); }
.ut .u-ph { display: none; }
.u-head { flex-wrap: wrap; row-gap: 6px; }
.u-per { display: inline-flex; gap: 6px; }
.head .u-per a.fchip { height: 26px; font-size: 12px; color: var(--foreground); }
.head .u-per a.fchip.on { color: var(--background); }
.uside { display: grid; gap: 12px; padding: 12px 14px; }
.uside .k { color: var(--muted-foreground); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.uside .v { font-size: 22px; font-weight: 650; letter-spacing: -.01em; margin-top: 2px; font-variant-numeric: tabular-nums; }
.uside .v .u { font-size: 12px; font-weight: 500; color: var(--muted-foreground); letter-spacing: 0; }
.uside .s { color: var(--muted-foreground); font-size: 12px; margin-top: 2px; font-variant-numeric: tabular-nums; }
.umini { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.umini .v { font-size: 17px; }
.umini .s .ii { margin-right: 4px; }
.u-runs { margin-top: 10px; }
.u-runs .ut th, .u-runs .ut td { padding: 7px 10px; }
.u-more { margin-top: 8px; font-size: 12.5px; text-align: right; }
.pr-act { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-top: 10px; }
.pr-act b.ok { color: var(--success-foreground); }
.pr-act b.bad { color: var(--error-foreground); }
/* A run's top (the owner, 2026-10-21: keep it small): one line, then Cost and the tokens. */
.u-clock { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0 0 8px; font-size: 13px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.u-clock > .icon { width: 14px; height: 14px; flex: none; }
.u-two { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 10px; }
.u-two .fact, .u-calls.fact { padding: 10px 12px; min-width: 0; }
.u-two .fact .v, .u-calls .v { font-size: 22px; letter-spacing: -.01em; }
.u-two .fact .v .u { font-size: 12px; font-weight: 500; color: var(--muted-foreground); letter-spacing: 0; }
.u-two .fact .s, .u-calls .s { font-variant-numeric: tabular-nums; }
.u-two .nr, .u-calls .nr { font-size: 15px; font-weight: 500; font-style: italic; color: var(--muted-foreground); }
.u-two .s .ii, .u-calls .s .ii { display: inline-grid; margin-right: 5px; vertical-align: -3px; }
.utok { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px 18px; }
.utok > div + div { border-left: 1px solid var(--border); padding-left: 16px; }
/* A run's Stats tab: its calls, with a bar for each round. */
.u-calls { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr); gap: 10px 24px; align-items: end; }
.u-calls .uspark { height: 64px; margin: 0; gap: 4px; }
.u-axis { display: flex; justify-content: space-between; margin-top: 4px; font-size: 11.5px; color: var(--muted-foreground); }
/* Settings › Providers: Model prices, one table under the providers. */
.mp-t td { vertical-align: middle; }
.mp-t input { width: 76px; height: 28px; padding: 0 8px; text-align: right; font-variant-numeric: tabular-nums; }
.mp-t input.bad { border-color: var(--error); }
@media (max-width: 1300px) { .ufacts { grid-template-columns: repeat(4, minmax(0, 1fr)); } .ufacts .uf-wide { grid-column: span 2; } }
@media (max-width: 700px) {
  .ufacts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ufacts .uf-wide { grid-column: 1 / -1; }
  .u-two, .u-calls { grid-template-columns: minmax(0, 1fr); }
  .utok { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .utok > :first-child { grid-column: 1 / -1; }
  .utok > div + div { border-left: 0; padding-left: 0; }
  .utok > div:last-child { border-left: 1px solid var(--border); padding-left: 14px; }
}
@media (max-width: 600px) {
  .mp-t input { width: 46px; padding: 0 4px; }
  .mp-t .chip { white-space: normal; }
  .ut { font-size: 12px; }
  .ut .u-opt { display: none; }
  .ut .u-ph { display: block; }
  .ut th, .ut td { padding: 6px 4px; }
  .ut th:first-child, .ut td:first-child { padding-left: 8px; }
  .ut th:last-child, .ut td:last-child { padding-right: 8px; }
  .ut th { font-size: 11px; }
  .ut th .lb { gap: 3px; }
  .ut .ii { width: 13px; height: 13px; font-size: 9px; }
  .ut td .ii { margin-right: 3px; }
  .ut .ush > i, .ut .kname .av { display: none; }
  .ut .nr { white-space: normal; }
  .ut td:first-child .us { white-space: normal; }
}
`;
