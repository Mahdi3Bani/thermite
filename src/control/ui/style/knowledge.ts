/** Journals and the knowledge base. */
export const KNOWLEDGE = `/* Journals and the knowledge base (goal 065) */
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
.past .pastrow input { margin: 2px 0 0; height: auto; width: auto; }`;
