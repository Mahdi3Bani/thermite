import { asToken, directionList, RESEARCH_TASK_KINDS } from "../../core/directions.ts";
import type { AttemptView, ExperimentView, RigView, RunView } from "../views.ts";
import { ago, esc, icon } from "./components.ts";
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
): { cls: "win" | "wait" | "loss" | "broken" | "flat" | "done" | "none"; text: string } {
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
  // The filters by the outcome's own word: a win; one waiting for you; not better than the
  // champion ("Lost"); broken or blocked; anything else (unclear, declined, a duplicate, judging).
  return {
    cls:
      waits || o.word === "Needs you"
        ? "wait"
        : o.tone === "ok"
          ? "win"
          : o.word === "Lost"
            ? "loss"
            : o.tone === "bad"
              ? "broken"
              : "flat",
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
    `<div class="qi" draggable="true" data-id="${esc(x.id)}" data-rig="${esc(u.id)}" data-run="${esc(r.id)}"><span class="qh" title="Drag to reorder">⋮⋮</span><span class="qn">${i + 1}</span><div class="qmain"><div class="qt">${esc(x.title)}</div>${x.why ? `<div class="qwhy">${esc(x.why)}</div>` : ""}<div class="qmeta">${src(x.by)}${x.family ? `<span class="qdir">${esc(x.family)}</span>` : ""}${x.from_run ? `<span class="muted xs">from ${esc(x.from_run)}</span>` : ""}</div></div><div class="qacts">${i > 0 ? o.cmd({ rig: u.id, kind: "queue_move", fields: fields(x, { position: "top" }), label: "↑ Top", cls: "sm ghost", back: o.back }) : ""}<details class="menu"><summary class="btn sm ghost">Edit</summary><div class="menu-pop qedit">${o.cmd({ rig: u.id, kind: "queue_edit", fields: fields(x), label: "Save", cls: "sm", back: o.back, extra: editFields(x) })}</div></details><details class="menu"><summary class="btn sm ghost">Drop</summary><div class="menu-pop">${o.cmd({ rig: u.id, kind: "queue_drop", fields: fields(x), label: "Drop it", cls: "sm danger", back: o.back, extra: `<input name="why" required placeholder="why" aria-label="Why" style="width:100%;margin-bottom:6px">` })}</div></details></div></div>`;
  // An experiment's words, to change before a lane takes it.
  const editFields = (x: ExperimentView) =>
    `<label class="sfd">${infoLabel("What to try", "The experiment's title: what a lane works on.")}<input name="title" required maxlength="200" value="${esc(x.title)}"></label><label class="sfd">${infoLabel("Details", "More on how to try it, for the lane that takes it. Empty: none.")}<textarea name="details" rows="3" maxlength="4000">${esc(x.details ?? "")}</textarea></label><label class="sfd">${infoLabel("Direction", "The approach it belongs to. Rules apply by direction.")}<input name="family" maxlength="80" value="${esc(x.family)}"></label><label class="sfd">${infoLabel("Why", "Why it is worth trying. Empty: none.")}<input name="why" maxlength="2000" value="${esc(x.why ?? "")}"></label>`;
  const add = `<form class="qadd" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="kind" value="queue_add"><input type="hidden" name="back" value="${esc(o.back)}">
<label class="sfd">${infoLabel("Add an experiment", "Something for a lane to try. It joins the queue where you put it; the planner gives it to a free lane when it reaches the top, and keeps two lanes off the same thing.")}<input name="title" required maxlength="200" placeholder="for example: unroll the dequantize loop by 4"></label>
<label class="sfd">${infoLabel("Direction", "The approach it belongs to, in your words or one this run has used. The planner keeps similar work on the same lane, and rules apply by direction.")}<input name="family" maxlength="80" list="qfams" placeholder="optional"><datalist id="qfams">${o.families.map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
<label class="sfd">${infoLabel("Where", "Its place in the queue. You can drag it later.")}<select name="position"><option value="top">at the top</option><option value="end">at the end</option></select></label>
<button class="primary">Add</button>
<label class="sfd qwhy-f">${infoLabel("Why", "Shown with the experiment to the planner and to the lane that gets it.")}<input name="why" maxlength="2000" placeholder="optional"></label>
<label class="sfd qwhy-f">${infoLabel("Details", "More on how to try it, for the lane that takes it.")}<textarea name="details" rows="2" maxlength="4000" placeholder="optional"></textarea></label></form>`;
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
  const counts = { win: 0, wait: 0, loss: 0, broken: 0, flat: 0, done: 0, none: 0 };
  const triedRows = tried
    .map((x) => {
      const res = triedResult(r, x);
      counts[res.cls]++;
      return `<tr data-r="${res.cls}" data-d="${esc(x.family)}" data-b="${esc(byLabel(x.by).text)}"><td><b>${esc(x.title)}</b>${x.why ? `<div class="muted xs">${esc(clip(x.why, 160))}</div>` : ""}</td><td class="qdir">${esc(x.family)}</td><td>${src(x.by)}</td><td class="muted small">${esc([x.lane, x.trial ? `trial ${x.trial.slice(0, 10)}` : ""].filter(Boolean).join(" · ") || "·")}</td><td><span class="qres ${res.cls}">${esc(res.text)}</span></td><td class="muted small nowrap">${esc(ago(x.updated_at, o.now))} ago</td></tr>`;
    })
    .join("");
  const chip = (key: string, label: string, n: number) =>
    `<button type="button" class="fchip${key === "all" ? " on" : ""}" data-qf="${key}">${esc(label)} <span class="n">${n}</span></button>`;
  // The other two filters: the directions tried, and who added them (as Added by says).
  const pick = (attr: string, label: string, all: string, values: string[]) =>
    `<select class="qsel" ${attr} aria-label="${esc(label)}"><option value="">${esc(all)}</option>${[
      ...new Set(values.filter(Boolean)),
    ]
      .sort((a, b) => a.localeCompare(b))
      .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)
      .join("")}</select>`;
  const picks = `${pick(
    "data-qd",
    "Direction",
    "Every direction",
    tried.map((x) => x.family),
  )}${pick(
    "data-qb",
    "Added by",
    "Anyone added it",
    tried.map((x) => byLabel(x.by).text),
  )}`;
  return `<div class="qcols"><div>
<div class="head"><h2>Up next</h2><span class="n">${up.length}</span><span class="right">in order; the planner gives the top ones to free lanes, never the same one to two lanes</span></div>
${add}
<div class="qlist" id="qlist">${up.map(item).join("") || `<div class="card"><div class="empty">Nothing queued. The planner adds experiments as it plans; you can add one above.</div></div>`}</div>
</div><div class="qside">
<div class="card qcard"><h3>In progress</h3>${working || `<div class="muted small">No lane is at work.</div>`}</div>
<div class="card qcard"><h3>Ideas from the lanes <span class="muted small">wait for the planner or you</span></h3>${ideaRows || `<div class="muted small">None waiting. Lanes propose ideas while they work.</div>`}${ideaRows ? `<div class="muted xs">The planner's model queues or drops these at its next hand-out, and you can decide first. Without its model (none set, its answer refused, the planner off, or a research run) they wait for you.</div>` : ""}</div>
</div></div>
<div class="block" style="margin-top:26px" id="tried"><div class="head"><h2>Tried</h2><span class="n">${tried.length}</span><span class="right">every experiment that ended, with its result, newest first</span></div>
${
  tried.length
    ? `<div class="ktools" id="qf">${chip("all", "All", tried.length)}${chip("win wait", "Wins", counts.win + counts.wait)}${chip("loss", "Not better", counts.loss)}${chip("broken", "Broken or blocked", counts.broken)}${chip("flat", "Other results", counts.flat)}${counts.done ? chip("done", "Research finished", counts.done) : ""}${chip("none", "No attempt or dropped", counts.none)}${picks}</div>
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
  /** Why the owner's last message to the planner was not sent or not taken, if so. */
  refused?: string | undefined;
  /** Why control did not send the owner's last rule from Add a rule, if so. */
  ruleRefused?: string | undefined;
}): string {
  const { u, r } = o;
  const research = r.mode === "research";
  const ruleRow = (x: RunView["rules"][number]) => {
    const kind = String(x.body.kind ?? "");
    // A direction shows as :name: (goal 066); an old rule in words, in quotes.
    const family = typeof x.body.family === "string" ? x.body.family : "";
    const what = family
      ? asToken(family)
      : x.legacy
        ? `“${String(x.body.match ?? "")}”`
        : String(x.body.value ?? "");
    const word = x.legacy
      ? "words"
      : kind === "mandate"
        ? "always"
        : kind === "lane_count"
          ? "lanes"
          : kind === "note"
            ? "note"
            : kind;
    const verb =
      kind === "mandate"
        ? "Always give"
        : kind === "try"
          ? "Try"
          : kind === "avoid"
            ? "Avoid"
            : kind;
    const said =
      kind === "lane_count"
        ? `${what} lanes`
        : kind === "note"
          ? what
          : `${verb} ${what}${kind === "mandate" ? " a lane" : ""}`;
    const fromMsg =
      typeof x.body.from_message === "number"
        ? r.messages.find((m) => m.id === x.body.from_message)
        : undefined;
    const dir = family ? r.directions.find((d) => d.name === family) : undefined;
    const note = x.legacy
      ? `<div class="xs warn" style="margin-top:3px">${icon.warn} An old rule in words, from before rules named directions. Code doesn't keep it. Only the planner's model reads it, and a round planned without the model ignores it. Remove it, and add a rule that names a direction instead.</div>`
      : dir?.to_design
        ? `<div class="xs" style="margin-top:3px">A new direction. The planner designs it at its next round, then adds it to the run's directions.</div>`
        : "";
    return `<div class="qrule"><span class="qkind ${esc(word)}">${esc(word)}</span><div><b>${esc(said)}</b> <span class="muted small">· set by</span> ${src(x.author)} <span class="muted xs">${esc(ago(x.at, o.now))} ago</span><div class="muted small">${esc(String(x.body.rationale ?? ""))}${fromMsg ? ` <span class="muted">(from your message: “${esc(clip(fromMsg.text, 120))}”)</span>` : ""}</div>${note}</div>${o.cmd({ rig: u.id, kind: "drop_directive", fields: { run: r.id, id: String(x.id) }, label: "Remove", cls: "sm ghost", back: o.back })}</div>`;
  };
  const entry = (at: string, html: string) =>
    `<div class="qhand"><span class="tm">${esc(at.slice(11, 16))}</span><div>${html}</div></div>`;
  const handed = r.handouts.map((h) => ({
    at: h.at,
    html: `${h.round !== null ? `<b>Round ${h.round}</b>: ` : ""}${h.assignments.length ? `<ul>${h.assignments.map((a) => `<li><b>${esc(a.lane)}</b>: ${esc(r.queue.find((x) => x.id === a.experiment)?.title ?? a.experiment ?? "")}${a.why ? ` <span class="muted">· ${esc(a.why)}</span>` : ""}</li>`).join("")}</ul>` : ""}${h.notes ? `<div class="muted small">${esc(clip(h.notes, 400))}</div>` : ""}`,
  }));
  // The planner's own changes to the queue and the rules it set, each with its reason. A copy
  // back in the queue after its trial stopped is not a change of the planner's: History has it.
  const changed = (r.timeline ?? [])
    .filter(
      (e) =>
        (e.actor === "planner" || (e.kind === "family_added" && e.actor.startsWith("planner:"))) &&
        !e.body.requeued_from,
    )
    .map((e) => {
      const b = e.body;
      const x = r.queue.find((y) => y.id === String(b.id));
      const t = `“${esc(clip(x?.title ?? String(b.title ?? b.id ?? ""), 160))}”`;
      const why = (w: unknown) =>
        typeof w === "string" && w ? ` <span class="muted">· ${esc(clip(w, 300))}</span>` : "";
      const d = (b.body ?? {}) as Record<string, unknown>;
      const said =
        e.kind === "experiment_added" && b.state !== "proposed"
          ? `Added ${t} to the queue${why(b.why)}`
          : e.kind === "experiment_accepted"
            ? `Queued ${esc(x ? byLabel(x.by).text : "the idea")} ${t}${why(b.why)}`
            : e.kind === "experiment_moved"
              ? `Moved ${t} to ${typeof b.position === "number" ? `place ${b.position + 1}` : `the ${esc(String(b.position))}`}${why(b.why)}`
              : e.kind === "experiment_dropped"
                ? `Dropped ${t}${why(b.why)}`
                : e.kind === "directive"
                  ? `Set the rule ${esc(String(d.kind ?? ""))} ${esc(typeof d.family === "string" ? asToken(d.family) : String(d.match ?? d.value ?? ""))}${why(d.rationale)}${
                      typeof d.from_message === "number"
                        ? ` <span class="muted">(from your message: “${esc(clip(r.messages.find((m) => m.id === d.from_message)?.text ?? `#${d.from_message}`, 120))}”)</span>`
                        : ""
                    }`
                  : // A direction the planner designed for rules that named it (goal 066).
                    e.kind === "family_added" && Array.isArray(b.for_rules) && b.for_rules.length
                    ? `Designed the direction ${esc(asToken(String(b.family ?? "")))} for rule ${esc(b.for_rules.join(", "))}${why(b.description)}`
                    : "";
      return { at: e.at, html: said };
    })
    .filter((c) => c.html);
  const handouts = [...handed, ...changed]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30)
    .map((c) => entry(c.at, c.html))
    .join("");
  return `<div class="qcols"><div>
<div class="head"><h2>Rules</h2><span class="n">${r.rules.length}</span><span class="right">the planner keeps these when it gives out work; a rule changes what lanes work on, never a verdict</span></div>
<div class="qrules">${r.rules.map(ruleRow).join("") || `<div class="card"><div class="empty">No rules. The planner follows the queue and its own judgment.</div></div>`}</div>
<details class="adv" style="margin-top:10px"${r.rules.length && !o.ruleRefused ? "" : " open"}><summary>Add a rule</summary><div>${o.ruleRefused ? `<div class="lnotice">${icon.warn}<span><b>Not added.</b> ${esc(o.ruleRefused)}</span></div>` : ""}<form method="post" action="/ui/commands" class="qruleform"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="kind" value="redirect"><input type="hidden" name="add" value="1"><input type="hidden" name="back" value="${esc(o.back)}">
<label class="sfd">${infoLabel("Rule", "Avoid: no lane gets this direction. Try: it comes first when there is a choice. Always: one lane works on it at every hand-out.")}<select name="directive"><option value="avoid">Avoid</option><option value="try">Try</option><option value="mandate">Always</option></select></label>
<label class="sfd">${infoLabel("Direction", `The direction the rule is about, in plain words, such as shared memory tiling, or as :shared memory tiling:. To name more than one, write each as :name:; each gets its own rule. Code keeps every rule at each hand-out, with or without the planner's model. ${research ? `A research run's directions are its task kinds: ${directionList(RESEARCH_TASK_KINDS)}.` : `A direction this run doesn't have yet is new: the planner designs it at its next round. This run's directions: ${r.directions.filter((d) => !d.to_design).length ? directionList(r.directions.filter((d) => !d.to_design).map((d) => d.name)) : "none yet"}.`}`)}<input name="direction" required maxlength="400" placeholder="for example: shared memory tiling"></label>
<label class="sfd">${infoLabel("Why", "Kept with the rule and shown to the planner.")}<input name="rationale" required maxlength="2000" placeholder="for example: measured slower twice"></label>
<button class="primary">Add the rule</button></form></div></details>
<div class="head" style="margin-top:26px"><h2>What the planner did</h2><span class="right">each hand-out, and each change it made to the queue or the rules, with why</span></div>
<div class="card qhands">${handouts || `<div class="empty">${research ? "A research run sets its rounds with a fixed method; its hand-outs show here." : "No hand-out yet."}</div>`}</div>
${o.figures}
</div><div class="qside">
${
  research
    ? `<div class="card qcard"><h3>The plan</h3><div class="small">A research run sets each round with a fixed method: it takes the experiments in queue order and keeps to the rules. There is no planner model to tell.</div></div>`
    : u.settings?.planner === false
      ? // The rig's own settings (Edit rig): with the planner off, nothing would read a message.
        `<div class="card qcard"><h3>Tell the planner</h3><div class="small">The planner is off on this rig, so it reads no messages. The lanes take the queue in order and keep to the rules. <a href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Switch it on in Edit rig</a> to tell it something.</div></div>`
      : `<div class="card qcard"><h3>Tell the planner</h3>${o.refused ? `<div class="lnotice">${icon.warn}<span><b>Not sent.</b> ${esc(o.refused)}</span></div>` : ""}<form method="post" action="/ui/live/message"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="to" value="planner"><input type="hidden" name="back" value="${esc(o.back)}"><textarea name="text" rows="4" required data-words maxlength="4000" placeholder="for example: stop :loop tiling:, and put vector loads first" style="width:100%"></textarea><div class="muted small" style="margin:6px 0">The planner reads it when it next gives out work. From what you say it can add or drop experiments, reorder the queue and add rules; each change shows here and in Experiments, with your message as its reason. Each rule names a direction. Write :name: to name one exactly. For plain words, the planner picks the direction that fits, or designs a new one.</div><button class="primary">Send to the planner</button></form></div>`
}
<div class="card qcard"><h3>The planner</h3><div class="small">${esc(o.model)}</div><a class="small" href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Change it on Edit rig</a>${
    r.agents.epochs && !research
      ? `<div class="muted small" style="border-top:1px solid var(--border);padding-top:8px">${r.agents.epochs} round${r.agents.epochs === 1 ? "" : "s"} so far: ${r.agents.planner_valid} planned by the model, ${r.agents.fallbacks} in queue order by the fixed rules (no model, the planner off, or no usable answer from the model). History says which for each round.</div>`
      : ""
  }</div>
${o.propagate ? `<div class="card qcard"><h3>Other rigs</h3>${o.propagate}</div>` : ""}
</div></div>`;
}
