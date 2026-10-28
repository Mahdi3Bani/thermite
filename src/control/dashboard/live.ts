import type { Hono } from "hono";
import { errorText } from "../../common/errors.ts";
import { commandFollowUrl, commandProgress, notSent } from "../command-progress.ts";
import { issueCommand, nobodyReads, panelReviews } from "../issue/index.ts";
import { HARNESS_NAMES } from "../rigs/model.ts";
import { lastActivity } from "../ui/campaigns.ts";
import {
  ago,
  esc,
  icon,
  modeAvatar,
  modeName,
  num,
  runCompleted,
  runHref,
  runKey,
  runLiveHref,
  runState,
} from "../ui/components.ts";
import {
  liveEntryHtml,
  liveLinesHtml,
  resultJoin,
  runEntryHtml,
  runLinesHtml,
} from "../ui/live.ts";
import { waitingOn } from "../ui/operator/index.ts";
import { clip, signed } from "../ui/words/index.ts";
import { currentChampion, runCampaign } from "../views/facts.ts";
import { podStopped, type RigView, type RunView } from "../views/index.ts";
import { type Dashboard, wantsJson } from "./context.ts";

/**
 * Live, one run at a time (goal 063), and one rig's sessions over every run, with the owner's
 * messages to them.
 */
export function liveRoutes(app: Hono, dash: Dashboard): void {
  const { cmdForm, csrf, moreMenu, opts, page, pauseMenu, store, views } = dash;

  // ---------------------------------------------------------------- live, one run at a time (goal 063)
  /**
   * Live: the runs at work on the left; one run's stream in the middle, with filters for each
   * lane, the planner, the judge, the advisors and the owner's own messages; under it, one
   * message box that writes to the lane being watched.
   */
  app.get("/ui/live", (c) => {
    const vs = views();
    const now = Date.now();
    const all = vs.flatMap((u) => u.runs.map((r) => ({ u, r })));
    const atWork = all.filter((x) => x.r.status === "running");
    const wanted = c.req.query("run");
    const sel =
      (wanted ? all.find((x) => runKey(x.u.id, x.r.id) === wanted) : undefined) ?? atWork[0];
    const day = now - 24 * 3600_000;
    const ended = all
      .filter((x) => x.r.status !== "running" && Date.parse(lastActivity(x.r)) > day)
      .sort((a, b) => lastActivity(b.r).localeCompare(lastActivity(a.r)));
    const idle = vs.filter((u) => !u.runs.some((r) => r.status === "running"));
    const runLink = (x: { u: RigView; r: RunView }, sub: string, cls = "") =>
      `<a class="lr${sel && x.u.id === sel.u.id && x.r.id === sel.r.id ? " on" : ""}${cls}" href="${runLiveHref(x.u.id, x.r.id)}"><span class="t">${x.r.status === "running" ? `<span class="dot ok pulse"></span>` : ""}${esc(x.r.id)}</span><span class="s">${sub}</span></a>`;
    const nav = `<nav class="lruns" aria-label="Runs" data-part="lruns">
<div class="hd">At work</div>${atWork.map((x) => runLink(x, `${esc(x.u.id)} · ${esc(modeName(x.r.mode))} · ${Object.keys(x.r.at_work).length} working${waitingOn(x.r, x.u) ? ` · <span class="warn">${waitingOn(x.r, x.u)} wait for you</span>` : ""}`)).join("") || `<div class="lempty">No run is at work.</div>`}
${idle.length ? `<div class="hd">Idle rigs</div>${idle.map((u) => `<a class="lr idle" href="/ui/rigs/${encodeURIComponent(u.id)}"><span class="t">${esc(u.id)}</span><span class="s">no run at work${podStopped(u) ? " · its pod is stopped" : u.stale ? " · not reporting" : ""}</span></a>`).join("")}` : ""}
${ended.length ? `<details class="lended"${sel && sel.r.status !== "running" ? " open" : ""}><summary class="hd">Ended in the last day (${ended.length})</summary>${ended.map((x) => runLink(x, `${esc(x.u.id)} · ${runCompleted(x.r) ? "completed" : x.r.status === "closed" ? "finished" : esc(x.r.status)}`, " idle")).join("")}</details>` : ""}
</nav>`;
    if (!sel)
      return page(
        c,
        { title: "Live", summary: "no run at work", active: "live", flush: true },
        `<div class="lwrap">${nav}<section class="lcol"><div class="empty" style="margin:auto">${ended.length ? "No run is at work. Pick one from the list to see its lines." : "No run to watch yet. Runs show here as soon as a rig reports one."}</div></section></div>`,
        vs,
      );
    const { u, r } = sel;
    const research = r.mode === "research";
    const trials = store.liveLines.trials(u.id).filter((t) => t.run === r.id);
    const lanes = [
      ...new Set([
        ...Object.keys(r.at_work),
        ...(r.epoch?.assignments.map((a) => a.lane) ?? []),
        ...trials.map((t) => t.lane).filter((l): l is string => !!l),
      ]),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const lines = store.liveLines.runTail(u.id, r.id, 600);
    const after = lines.at(-1)?.id ?? 0;
    const w = c.req.query("w") || "all";
    // The filters: everyone, each lane (working or not), the planner, the judge, the advisors, you.
    const chip = (key: string, label: string, title = "", working = false) =>
      `<a class="lchip${w === key ? " on" : ""}" data-w="${esc(key)}" href="${runLiveHref(u.id, r.id, key === "all" ? "" : `&w=${encodeURIComponent(key)}`)}"${title ? ` title="${esc(title)}"` : ""}>${working ? `<span class="dot ok"></span>` : ""}${esc(label)}</a>`;
    const chips = [
      chip("all", "Everyone"),
      ...lanes.map((l) => {
        const work = r.at_work[l];
        return chip(
          l,
          l,
          work ? `${work.family}: ${work.focus}` : "between trials",
          Boolean(work) && r.status === "running",
        );
      }),
      chip("planner", "Planner"),
      ...(research ? [] : [chip("judge", "Judge")]),
      chip("advisors", "Advisors"),
      chip("you", "You", "your messages, and who read them"),
    ].join("");
    const kept = r.messages.filter((m) => m.keep && !m.unkept);
    const keptBox = kept.length
      ? `<details class="lkept"><summary class="lchip" title="Your messages kept in force">📌 ${kept.length} kept</summary><div class="menu-pop"><div class="muted small">Every new trial gets these, until you remove them.</div>${kept
          .map(
            (m) =>
              `<div class="krow"><span class="small"><b>To ${esc(m.to === "all" ? "everyone" : m.to)}:</b> ${esc(clip(m.text, 200))}</span>${cmdForm(c, { rig: u.id, kind: "unkeep_message", fields: { run: r.id, message: String(m.id) }, label: "Remove", cls: "sm ghost", back: runLiveHref(u.id, r.id) })}</div>`,
          )
          .join("")}</div></details>`
      : "";
    // The message box: who it goes to, and when they read it (the placeholder says).
    // When they read it depends on the agents' harness: Pi between steps; OpenCode, Claude Code
    // and Codex when their current run ends (or in the lane's next trial). A research run's
    // workers on a Codex rig run in Pi.
    const harness = u.model?.harness;
    const pi = harness === "pi" || (research && harness === "codex");
    const when =
      harness === undefined
        ? "when it can (this rig hasn't said which program runs its agents)"
        : pi
          ? "at its next step"
          : "when its current run ends, or in its next trial";
    const hint = (to: string) =>
      to === "all"
        ? `Each agent reads it ${harness === undefined ? "when it can" : pi ? "at its next step" : "when its current run ends"}; the planner at its next plan`
        : to.startsWith("lane-")
          ? `${to}${r.at_work[to] ? ` (on ${r.at_work[to]?.family})` : ""} reads it ${when}`
          : to === "planner"
            ? "The planner reads it when it plans the next round"
            : to === "teachers"
              ? "The teachers read it in their next round and answer here"
              : to === "auditor"
                ? "The auditor reads it before its next audit and answers here"
                : to === "review_panel"
                  ? "The review panel reads it before its next review and answers here"
                  : "The advisors read it and answer here";
    // A run without agents has no one working: the box starts on the advisors.
    const to =
      lanes.includes(w) || w === "planner"
        ? w
        : w === "advisors" || r.has_agents === false
          ? "advisors"
          : "all";
    // The review panel reads only for a goal it reviews (a goal checked by review) or a research
    // run's questions (goal 112).
    const reviewed = panelReviews(store, runCampaign(r));
    // Who would read nothing: off on the rig, or not set up on its supervisor. Control refuses
    // a message to them with the same words (issue.ts).
    const off = (v: string) => nobodyReads(u, v, r);
    const opt = (v: string, label: string, off = "") =>
      `<option value="${esc(v)}" data-hint="${esc(hint(v))}"${v === to ? " selected" : ""}${off ? ` disabled title="${esc(off)}"` : ""}>${esc(label)}</option>`;
    // A message control refused, or the rig refused (its newest one to this run).
    const refused = c.req.query("msgerror");
    const rigRefused = store.commands.lastMessageToRun(u.id, r.id)?.refused ?? "";
    const notice =
      refused || rigRefused
        ? `<div class="lnotice">${icon.warn}<span><b>Not sent.</b> ${esc(refused || `The rig refused your last message: ${rigRefused}`)}</span></div>`
        : "";
    const box =
      r.status === "closed"
        ? `<div class="lcomposer off">This run has finished: its agents take no more messages.</div>`
        : `<form class="lcomposer" method="post" action="/ui/live/message" data-act><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="rig" value="${esc(u.id)}"><input type="hidden" name="run" value="${esc(r.id)}"><input type="hidden" name="w" value="${esc(w)}">
<select name="to" aria-label="To" class="lto">${opt("all", "To everyone working", off("all"))}${lanes.map((l) => opt(l, `To ${l}`, off(l))).join("")}${opt("planner", "To the planner", off("planner"))}<optgroup label="Advisors">${opt("advisors", "To all advisors", off("advisors"))}${opt("teachers", "To the teachers", off("teachers"))}${opt("auditor", "To the auditor", off("auditor"))}${opt("review_panel", "To the review panel", off("review_panel") || (!reviewed ? "This run has no goal the review panel reviews." : ""))}</optgroup></select>
<textarea name="text" rows="1" required data-words maxlength="4000" aria-label="Message" placeholder="${esc(hint(to))} · ⌘↩ sends"${c.req.query("compose") ? " autofocus" : ""}></textarea>
<label class="lpin" title="Keep it in force: every new trial gets it too, until you remove it"><input type="checkbox" name="keep" value="1">📌</label>
<button class="primary">${icon.send}Send</button></form>`;
    const meta = [
      esc(u.id),
      r.epoch ? `round ${r.epoch.n}` : "",
      research
        ? `${num((r.research as Record<string, unknown> | null)?.verified)} verified claims`
        : r.mode === "goal"
          ? `${r.goals.filter((g) => g.status === "met").length} of ${r.goals.length} goals met`
          : signed((currentChampion(r)?.cumulative ?? 1) - 1),
      waitingOn(r, u)
        ? `<a class="warn" href="${runHref(u.id, r)}#needs">${waitingOn(r, u)} wait${waitingOn(r, u) === 1 ? "s" : ""} for you</a>`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const st = runState(r);
    const head = `<div data-part="lhead"><div class="lhead"><button class="ghost sm lnav-btn" type="button" title="Show or hide the list of runs" aria-label="Runs">☰</button>${modeAvatar(r.mode)}<span class="t">${esc(r.id)}</span><span class="label ${st.cls}">${st.icon}${esc(st.text)}</span><span class="lmeta">${meta}</span><a class="btn sm" href="${runHref(u.id, r)}">Open the run</a>${
      r.status === "running"
        ? pauseMenu(c, u.id, r.id, runLiveHref(u.id, r.id), "sm") +
          moreMenu(c, u.id, r, runLiveHref(u.id, r.id), "sm")
        : r.status === "paused"
          ? cmdForm(c, {
              rig: u.id,
              kind: "resume_run",
              fields: { run: r.id },
              label: "Resume",
              cls: "sm",
              back: runLiveHref(u.id, r.id),
            })
          : ""
    }</div></div>`;
    return page(
      c,
      {
        title: "Live",
        summary: `${atWork.length} run${atWork.length === 1 ? "" : "s"} at work`,
        active: "live",
        flush: true,
      },
      `<div class="lwrap" id="lwrap">${nav}<section class="lcol">${head}<div data-fw-top></div><div class="lchips">${chips}<span class="grow"></span><span data-part="lkept">${keptBox}</span><button class="lchip on lfollow" type="button" aria-pressed="true" title="Follow new lines">↓ Follow</button></div>
<div class="transcript lstream" id="transcript" data-rig="${esc(u.id)}" data-run="${esc(r.id)}" data-w="${esc(w)}" data-after="${after}">${runLinesHtml(lines, now, store.rigEvents.runMessages(u.id, r.id)) || `<div class="empty">No live lines yet. They appear here as the run's agents and judge work.</div>`}</div>
<div data-part="lnotice">${notice}</div>${box}</section></div>`,
      vs,
    );
  });

  app.get("/ui/live.json", (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const [rig, run] = String(c.req.query("run") ?? "").split("/");
    if (!rig || !run) return c.json({ entries: [] });
    const now = Date.now();
    const messages = store.rigEvents.runMessages(rig, run);
    const entries = store.liveLines.ofRun(rig, run, after, 500).map((e) => ({
      id: e.id,
      kind: e.kind,
      src: e.source,
      html: runEntryHtml(e, now, messages),
      ...(e.kind === "result" ? { join: resultJoin(e) } : {}),
    }));
    // Lines drawn before their event came (recheck=ids), drawn again once it has.
    const ids = String(c.req.query("recheck") ?? "")
      .split(",")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 50);
    const redrawn = ids.length
      ? store.liveLines
          .ofRun(rig, run, 0, 50, ids)
          .map((e) => ({ id: e.id, html: runEntryHtml(e, now, messages) }))
          .filter((x) => !x.html.includes('data-recheck="1"'))
      : [];
    return c.json({ entries, redrawn });
  });

  app.post("/ui/live/message", async (c) => {
    const f = await c.req.parseBody();
    const rig = String(f.rig ?? "");
    const run = String(f.run ?? "");
    const w = String(f.w ?? "");
    // From the Planner tab, back there; from Live, to the same filter.
    const from = String(f.back ?? "");
    const back = (more = "") =>
      c.redirect(
        from.startsWith("/ui/")
          ? `${from}${from.includes("?") ? "&" : "?"}${more ? more.slice(1) : `sent=${encodeURIComponent("Sent to the rig. The planner reads it when it next gives out work; Commands shows whether the rig took it.")}`}`
          : runLiveHref(
              rig,
              run,
              `${w && w !== "all" ? `&w=${encodeURIComponent(w)}` : ""}${more}`,
            ),
        303,
      );
    const to = String(f.to ?? "all");
    const keep = String(f.keep ?? "") === "1" && (to === "all" || to.startsWith("lane-"));
    // From the page's script (goal 080): JSON, and the message is followed until the rig took it.
    const json = wantsJson(c);
    let id: string;
    try {
      ({ id } = issueCommand(store, opts.privateKeyPem, {
        rig,
        kind: "message_agent",
        payload: { run, to, text: String(f.text ?? "").trim(), ...(keep ? { keep: true } : {}) },
        issuedBy: "owner:ui",
      }));
    } catch (err) {
      const why = errorText(err);
      return json ? c.json(notSent(why), 400) : back(`&msgerror=${encodeURIComponent(why)}`);
    }
    const cmd = json ? store.commands.row(id) : undefined;
    if (cmd) return c.json({ ...commandProgress(cmd, Date.now()), follow: commandFollowUrl(id) });
    return back();
  });

  // ---------------------------------------------------------------- one rig's sessions, every run
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
    const sources = store.liveLines.sources(u.id);
    const intros = new Map(
      store.liveLines
        .trials(u.id)
        .map((x) => [x.source, x.intro.replace(/^(research )?trial on [^:]+: /, "")]),
    );
    const source = c.req.query("source") || "";
    const sel = sources.find((x) => x.source === source);
    const lines = store.liveLines.tail(u.id, 400, source || undefined);
    const after = lines.at(-1)?.id ?? 0;
    // A trial works while the ledger has it at work; its "trial ended" line may never come (a
    // restart cuts it off, and the harness closes it as interrupted when it starts again).
    const atWork = new Set(
      u.runs.flatMap((r) => Object.values(r.at_work).map((w) => `trial:${w.trial}`)),
    );
    const ended = new Map(sources.map((x) => [x.source, x.ended || !atWork.has(x.source)]));
    const list = [
      `<a class="side-row${source ? "" : " on"}" href="/ui/rigs/${encodeURIComponent(u.id)}/live">${icon.live}<span class="two"><span class="name"><b>Everything</b></span><span class="muted xs">all sessions, interleaved</span></span></a>`,
      ...sources.map(
        (s) =>
          `<a class="side-row${s.source === source ? " on" : ""}" href="/ui/rigs/${encodeURIComponent(u.id)}/live?source=${encodeURIComponent(s.source)}">${sourceAvatar(s.source)}<span class="two"><span class="name"><b>${esc(sourceName(s.source, s.lane))}</b></span><span class="muted xs clip">${esc([intros.get(s.source) || (s.source.startsWith("trial:") ? s.source.slice(6) : (s.run ?? "")), `${ago(s.last_at, now)} ago`].filter(Boolean).join(" · "))}</span></span>${s.source.startsWith("trial:") ? `<span class="right">${ended.get(s.source) ? `<span class="muted xs">ended</span>` : `<span class="label info xs"><span class="dot info pulse"></span>working</span>`}</span>` : ""}</a>`,
      ),
    ].join("");
    // Lines with their times, formatted once (ui/live.ts); the script adds new ones the same way.
    const out = [liveLinesHtml(lines, { showWho: !source, name: sourceName, now })];
    // Who is at work: for one worker, its agent, task, start and last activity.
    const agent = u.model
      ? u.model.source === "control"
        ? `${HARNESS_NAMES[u.model.harness] ?? u.model.harness} · ${u.model.model} (from ${u.model.name})`
        : u.model.source === "environment"
          ? `${HARNESS_NAMES[u.model.harness] ?? u.model.harness} · ${u.model.model} (the rig's own settings)`
          : "no model: the agents wait"
      : "not reported by this rig's harness";
    const trial = source.startsWith("trial:")
      ? store.liveLines.trials(u.id).find((x) => x.source === source)
      : undefined;
    const whenAt = (at: string) =>
      `${esc(at.slice(11, 19))} UTC <span class="muted">(${esc(ago(at, now))} ago)</span>`;
    const head = trial
      ? `<div class="lv-head"><dl class="facts"><dt>Agent</dt><dd>${esc(agent)}</dd><dt>Task</dt><dd>${esc(intros.get(source) || "not given")}</dd><dt>Started</dt><dd>${whenAt(trial.started_at)}</dd><dt>Last activity</dt><dd>${whenAt(trial.last_at)} ${trial.ended ? `<span class="chip">ended</span>` : `<span class="chip info">working</span>`}</dd></dl></div>`
      : !source
        ? `<div class="lv-head"><dl class="facts"><dt>Agents</dt><dd>${esc(agent)}</dd><dt>Last activity</dt><dd>${sources[0] ? whenAt(sources[0].last_at) : "none yet"}</dd></dl></div>`
        : "";
    // Messages go from a run's own Live page, where each recipient says when it reads them.
    const composer = u.runs.filter((x) => x.status !== "closed").length
      ? `<div class="composer off">To message an agent, open its run's Live: ${u.runs
          .filter((x) => x.status !== "closed")
          .map((x) => `<a href="${runLiveHref(u.id, x.id)}">${esc(x.id)}</a>`)
          .join(", ")}.</div>`
      : `<div class="composer off">No run on this rig to message.</div>`;
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
                  ? `<a href="${runHref(u.id, run)}">${esc(runCampaign(run))} › ${esc(run.id)}</a>`
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
      },
      `<aside class="sessions"><div class="section" style="margin-top:4px">Sessions</div>${list}</aside>
<div class="transcript-wrap">${head}<div class="transcript" id="transcript" data-rig="${esc(u.id)}" data-source="${esc(source)}" data-after="${after}">${out.join("") || `<div class="empty">No live lines yet. They appear here as the rig's agents and judge work.</div>`}</div>${composer}</div>`,
      vs,
    );
  });

  app.get("/ui/rigs/:rig/live.json", (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const source = c.req.query("source") || undefined;
    const now = Date.now();
    // Each line as the page shows it; a result also as the part it adds to its call's row.
    const entries = store.liveLines.after(c.req.param("rig"), after, 500, source).map((e) => ({
      id: e.id,
      kind: e.kind,
      html: liveEntryHtml(e, { showWho: !source, name: sourceName, now }),
      ...(e.kind === "result" ? { join: resultJoin(e) } : {}),
    }));
    return c.json({ entries });
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
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect(
      `/ui/rigs/${encodeURIComponent(rig)}/live${source ? `?source=${encodeURIComponent(source)}` : ""}`,
      303,
    );
  });
}
