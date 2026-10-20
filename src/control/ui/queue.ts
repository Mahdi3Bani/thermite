import type { AttemptView, ExperimentView, RigView, RunView } from "../views.ts";
import { ago, esc } from "./components.ts";
import { infoLabel } from "./new-campaign.ts";
import { outcome } from "./operator.ts";
import { clip } from "./words.ts";

/**
 * The run page's Experiments and Planner tabs (goal 064): the experiment queue in order, what
 * each lane is on, the lanes' ideas, everything tried with its result; the rules for the plan,
 * and what the planner did at each hand-out. Changes go to the rig as signed owner commands
 * through the dashboard's command form (`cmd`).
 */

/** A hidden-field form that posts one owner command; `extra` adds visible fields. */
export type CmdForm = (f: {
  rig: string;
  kind: string;
  fields?: Record<string, string>;
  label: string;
  cls?: string;
  back?: string;
  extra?: string;
}) => string;

/** Who added an experiment or set a rule, as a short label and a tone. */
export function byLabel(by: string): { text: string; cls: string } {
  if (by === "owner" || by.startsWith("control:owner") || by === "you")
    return { text: "you", cls: "you" };
  if (by === "planner" || by.startsWith("planner")) return { text: "planner", cls: "planner" };
  if (/^lane-\d+$/.test(by)) return { text: `${by}'s idea`, cls: "lane" };
  if (/teacher|combiner|supervisor/.test(by)) return { text: "teachers", cls: "teacher" };
  if (/auditor/.test(by)) return { text: "auditor", cls: "auditor" };
  if (/panel|review/.test(by)) return { text: "review panel", cls: "auditor" };
  if (by.startsWith("control:")) return { text: by.replace(/^control:/, ""), cls: "you" };
  return { text: by, cls: "auditor" };
}
const src = (by: string) => {
  const b = byLabel(by);
  return `<span class="qsrc ${b.cls}">${esc(b.text)}</span>`;
};

/** An experiment's result in the Tried table: its class for the filters, and its words. */
export function triedResult(
  r: RunView,
  x: ExperimentView,
): { cls: "win" | "wait" | "loss" | "flat" | "done" | "none"; text: string } {
  if (x.state === "dropped")
    return {
      cls: "none",
      text: `dropped by ${byLabel(x.dropped_by ?? "").text}${x.dropped_why ? `: ${x.dropped_why}` : ""}`,
    };
  const a: AttemptView | undefined = x.attempt
    ? r.attempts.find((y) => y.id === x.attempt)
    : undefined;
  // A research trial ends without an attempt: its sources, claims and findings are its result.
  if (!a && x.result === "finished")
    return { cls: "done", text: "finished: its research is in the run's notes" };
  if (!a)
    return {
      cls: "none",
      text: x.attempt
        ? `${x.attempt}: not judged yet`
        : x.result && x.result !== "no_attempt" && x.result !== "submitted"
          ? `no attempt: ${x.result.replace(/_/g, " ")}`
          : "no attempt",
    };
  const o = outcome(r, a);
  const waits = r.pending_promotions.includes(a.id);
  return {
    cls: waits ? "wait" : o.tone === "ok" ? "win" : o.tone === "bad" ? "loss" : "flat",
    text: `${a.id}: ${o.word}${waits ? ", waits for you" : ""}`,
  };
}

/** The Experiments tab. */
export function experimentsTab(o: {
  u: RigView;
  r: RunView;
  now: number;
  csrf: string;
  back: string;
  cmd: CmdForm;
  /** Directions the run has used, to suggest when adding. */
  families: string[];
}): string {
  const { u, r } = o;
  const up = r.queue
    .filter((x) => x.state === "queued")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const ideas = r.queue.filter((x) => x.state === "proposed");
  const doing = r.queue.filter((x) => x.state === "assigned");
  const tried = r.queue
    .filter((x) => x.state === "done" || x.state === "dropped")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const fields = (x: ExperimentView, extra: Record<string, string> = {}) => ({
    run: r.id,
    id: x.id,
    ...extra,
  });
  const item = (x: ExperimentView, i: number) =>
    `<div class="qi" draggable="true" data-id="${esc(x.id)}" data-rig="${esc(u.id)}" data-run="${esc(r.id)}"><span class="qh" title="Drag to reorder">⋮⋮</span><span class="qn">${i + 1}</span><div class="qmain"><div class="qt">${esc(x.title)}</div>${x.why ? `<div class="qwhy">${esc(x.why)}</div>` : ""}<div class="qmeta">${src(x.by)}${x.family ? `<span class="qdir">${esc(x.family)}</span>` : ""}${x.from_run ? `<span class="muted xs">from ${esc(x.from_run)}</span>` : ""}</div></div><div class="qacts">${i > 0 ? o.cmd({ rig: u.id, kind: "queue_move", fields: fields(x, { position: "top" }), label: "↑ Top", cls: "sm ghost", back: o.back }) : ""}<details class="menu"><summary class="btn sm ghost">Drop</summary><div class="menu-pop">${o.cmd({ rig: u.id, kind: "queue_drop", fields: fields(x), label: "Drop it", cls: "sm danger", back: o.back, extra: `<input name="why" required placeholder="why" aria-label="Why" style="width:100%;margin-bottom:6px">` })}</div></details></div></div>`;
  const add = `<form class="qadd" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="kind" value="queue_add"><input type="hidden" name="back" value="${esc(o.back)}">
<label class="sfd">${infoLabel("Add an experiment", "Something for a lane to try. It joins the queue where you put it; the planner gives it to a free lane when it reaches the top, and keeps two lanes off the same thing.")}<input name="title" required maxlength="200" placeholder="for example: unroll the dequantize loop by 4"></label>
<label class="sfd">${infoLabel("Direction", "The approach it belongs to, in your words or one this run has used. The planner keeps similar work on the same lane, and rules apply by direction.")}<input name="family" maxlength="80" list="qfams" placeholder="optional"><datalist id="qfams">${o.families.map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
<label class="sfd">${infoLabel("Where", "Its place in the queue. You can drag it later.")}<select name="position"><option value="top">at the top</option><option value="end">at the end</option></select></label>
<button class="primary">Add</button>
<label class="sfd qwhy-f">${infoLabel("Why", "Shown with the experiment to the planner and to the lane that gets it.")}<input name="why" maxlength="2000" placeholder="optional"></label></form>`;
  const working = Object.entries(r.at_work)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([lane, w]) => {
      const x = doing.find((d) => d.trial === w.trial || d.lane === lane);
      return `<div class="qlane"><div class="qlt"><span class="dot ok"></span><b>${esc(lane)}</b> · since ${esc(ago(w.since, o.now))} ago</div><div>${esc(x?.title ?? w.focus ?? w.family ?? "working")}</div>${x ? `<div class="muted xs">${src(x.by)}</div>` : ""}</div>`;
    })
    .join("");
  const ideaRows = ideas
    .map(
      (x) =>
        `<div class="qidea"><div>${esc(x.title)}</div>${x.why ? `<div class="muted xs">${esc(clip(x.why, 200))}</div>` : ""}<div class="muted xs">${src(x.by)} · ${esc(ago(x.at, o.now))} ago</div><div class="qb">${o.cmd({ rig: u.id, kind: "queue_accept", fields: fields(x), label: "Queue it", cls: "sm", back: o.back })}${o.cmd({ rig: u.id, kind: "queue_drop", fields: fields(x, { why: "the owner dropped this idea" }), label: "Drop", cls: "sm ghost", back: o.back })}</div></div>`,
    )
    .join("");
  const counts = { win: 0, wait: 0, loss: 0, flat: 0, done: 0, none: 0 };
  const triedRows = tried
    .map((x) => {
      const res = triedResult(r, x);
      counts[res.cls]++;
      return `<tr data-r="${res.cls}"><td><b>${esc(x.title)}</b>${x.why ? `<div class="muted xs">${esc(clip(x.why, 160))}</div>` : ""}</td><td class="qdir">${esc(x.family)}</td><td>${src(x.by)}</td><td class="muted small">${esc([x.lane, x.trial ? `trial ${x.trial.slice(0, 10)}` : ""].filter(Boolean).join(" · ") || "·")}</td><td><span class="qres ${res.cls}">${esc(res.text)}</span></td><td class="muted small nowrap">${esc(ago(x.updated_at, o.now))} ago</td></tr>`;
    })
    .join("");
  const chip = (key: string, label: string, n: number) =>
    `<button type="button" class="fchip${key === "all" ? " on" : ""}" data-qf="${key}">${esc(label)} <span class="n">${n}</span></button>`;
  return `<div class="qcols"><div>
<div class="head"><h2>Up next</h2><span class="n">${up.length}</span><span class="right">in order; the planner gives the top ones to free lanes, never the same one to two lanes</span></div>
${add}
<div class="qlist" id="qlist">${up.map(item).join("") || `<div class="card"><div class="empty">Nothing queued. The planner adds experiments as it plans; you can add one above.</div></div>`}</div>
</div><div class="qside">
<div class="card qcard"><h3>In progress</h3>${working || `<div class="muted small">No lane is at work.</div>`}</div>
<div class="card qcard"><h3>Ideas from the lanes <span class="muted small">wait for the planner</span></h3>${ideaRows || `<div class="muted small">None waiting. Lanes propose ideas while they work.</div>`}${ideaRows ? `<div class="muted xs">The planner queues or drops these at its next hand-out. You can decide first.</div>` : ""}</div>
</div></div>
<div class="block" style="margin-top:26px" id="tried"><div class="head"><h2>Tried</h2><span class="n">${tried.length}</span><span class="right">every experiment that ended, with its result, newest first</span></div>
${
  tried.length
    ? `<div class="ktools" id="qf">${chip("all", "All", tried.length)}${chip("win wait", "Wins", counts.win + counts.wait)}${chip("loss", "Slower or broke a goal", counts.loss)}${chip("flat", "No gain", counts.flat)}${counts.done ? chip("done", "Research finished", counts.done) : ""}${chip("none", "No attempt or dropped", counts.none)}</div>
<div class="card flat"><table class="ktable"><thead><tr><th>Experiment</th><th>Direction</th><th>Added by</th><th>Where</th><th>Result</th><th>When</th></tr></thead><tbody id="qtried">${triedRows}</tbody></table></div>`
    : `<div class="card"><div class="empty">Nothing tried yet.</div></div>`
}</div>`;
}

/** The Planner tab: the rules (whoever set them), add a rule, tell the planner, what it did. */
export function plannerTab(o: {
  u: RigView;
  r: RunView;
  now: number;
  csrf: string;
  back: string;
  cmd: CmdForm;
  /** The planner's model, in words, or why there is none. */
  model: string;
  /** The run's agent figures (kpis). */
  figures: string;
  /** The champion to another rig, when that is possible. */
  propagate: string;
}): string {
  const { u, r } = o;
  const research = r.mode === "research";
  const ruleRow = (x: RunView["rules"][number]) => {
    const kind = String(x.body.kind ?? "");
    const what = String(x.body.family ?? x.body.match ?? x.body.value ?? "");
    const word =
      kind === "mandate"
        ? "always"
        : kind === "lane_count"
          ? "lanes"
          : kind === "note"
            ? "note"
            : kind;
    const said =
      kind === "lane_count"
        ? `${what} lanes`
        : kind === "note"
          ? what
          : `${word === "always" ? "Always give" : word === "try" ? "Try" : word === "avoid" ? "Avoid" : word} ${what}${word === "always" ? " a lane" : ""}`;
    const fromMsg =
      typeof x.body.from_message === "number"
        ? r.messages.find((m) => m.id === x.body.from_message)
        : undefined;
    return `<div class="qrule"><span class="qkind ${esc(word)}">${esc(word)}</span><div><b>${esc(said)}</b> <span class="muted small">· set by</span> ${src(x.author)} <span class="muted xs">${esc(ago(x.at, o.now))} ago</span><div class="muted small">${esc(String(x.body.rationale ?? ""))}${fromMsg ? ` <span class="muted">(from your message: “${esc(clip(fromMsg.text, 120))}”)</span>` : ""}</div></div>${o.cmd({ rig: u.id, kind: "drop_directive", fields: { run: r.id, id: String(x.id) }, label: "Remove", cls: "sm ghost", back: o.back })}</div>`;
  };
  const handouts = r.handouts
    .slice()
    .reverse()
    .slice(0, 30)
    .map(
      (h) =>
        `<div class="qhand"><span class="tm">${esc(h.at.slice(11, 16))}</span><div>${h.round !== null ? `<b>Round ${h.round}</b>: ` : ""}${h.assignments.length ? `<ul>${h.assignments.map((a) => `<li><b>${esc(a.lane)}</b>: ${esc(r.queue.find((x) => x.id === a.experiment)?.title ?? a.experiment ?? "")}${a.why ? ` <span class="muted">· ${esc(a.why)}</span>` : ""}</li>`).join("")}</ul>` : ""}${h.notes ? `<div class="muted small">${esc(clip(h.notes, 400))}</div>` : ""}</div></div>`,
    )
    .join("");
  return `<div class="qcols"><div>
<div class="head"><h2>Rules</h2><span class="n">${r.rules.length}</span><span class="right">the planner keeps these when it gives out work; a rule changes what lanes work on, never a verdict</span></div>
<div class="qrules">${r.rules.map(ruleRow).join("") || `<div class="card"><div class="empty">No rules. The planner follows the queue and its own judgment.</div></div>`}</div>
<details class="adv" style="margin-top:10px"${r.rules.length ? "" : " open"}><summary>Add a rule</summary><div><form method="post" action="/ui/commands" class="qruleform"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="kind" value="redirect"><input type="hidden" name="add" value="1"><input type="hidden" name="back" value="${esc(o.back)}">
<label class="sfd">${infoLabel("Rule", "Avoid: no lane gets this direction. Try: it comes first when there is a choice. Always: one lane works on it at every hand-out.")}<select name="directive"><option value="avoid">Avoid</option><option value="try">Try</option><option value="mandate">Always</option></select></label>
<label class="sfd">${infoLabel("Direction", "In your own words: a direction this run has used, a kind of change (anything with shared memory), or a file. The planner applies it to every experiment it matches.")}<input name="match" required maxlength="200" placeholder="for example: anything that uses shared memory"></label>
<label class="sfd">${infoLabel("Why", "Kept with the rule and shown to the planner.")}<input name="rationale" required maxlength="2000" placeholder="for example: measured slower twice"></label>
<button class="primary">Add the rule</button></form></div></details>
<div class="head" style="margin-top:26px"><h2>What the planner did</h2><span class="right">each hand-out: what went to which lane, and why</span></div>
<div class="card qhands">${handouts || `<div class="empty">${research ? "A research run sets its rounds with a fixed method; its hand-outs show here." : "No hand-out yet."}</div>`}</div>
${o.figures}
</div><div class="qside">
${
  research
    ? `<div class="card qcard"><h3>The plan</h3><div class="small">A research run sets each round with a fixed method: it takes the experiments in queue order and keeps to the rules. There is no planner model to tell.</div></div>`
    : `<div class="card qcard"><h3>Tell the planner</h3><form method="post" action="/ui/live/message"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="to" value="planner"><input type="hidden" name="back" value="${esc(o.back)}"><textarea name="text" rows="4" required maxlength="4000" placeholder="for example: stop trying tiling, and put vector loads first" style="width:100%"></textarea><div class="muted small" style="margin:6px 0">The planner reads it when it next gives out work. From what you say it can add or drop experiments, reorder the queue and add rules; each change shows here and in Experiments, with your message as its reason.</div><button class="primary">Send to the planner</button></form></div>`
}
<div class="card qcard"><h3>The planner</h3><div class="small">${esc(o.model)}</div><a class="small" href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Change it on Edit rig</a>${
    r.agents.epochs && !research
      ? `<div class="muted small" style="border-top:1px solid var(--border);padding-top:8px">Last ${r.agents.epochs} hand-outs: ${r.agents.planner_valid} by the model, ${r.agents.fallbacks} in queue order because the model's answer was refused.</div>`
      : ""
  }</div>
${o.propagate ? `<div class="card qcard"><h3>Other rigs</h3>${o.propagate}</div>` : ""}
</div></div>`;
}
