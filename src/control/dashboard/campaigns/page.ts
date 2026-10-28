import type { Hono } from "hono";
import { type AgentsContext, compactAtRefusal } from "../../../core/compaction.ts";
import { type McpUse, sameUses } from "../../../core/mcp.ts";
import { queueTarget, queueTargetNote } from "../../../core/queue-target.ts";
import { RESEARCH_REVIEW } from "../../../core/research-check.ts";
import {
  campaignContract,
  contractContext,
  ownModels,
  rigContext,
  setCampaignContext,
} from "../../campaign-context.ts";
import { commandFollowUrl, commandProgress } from "../../command-progress.ts";
import {
  type CopyCampaignOutcome,
  type CopyCampaignRequest,
  copiedFromWords,
  copyACampaign,
} from "../../copy-campaign.ts";
import { askOwnerFrom } from "../../new-campaign.ts";
import { type StartRunRequest, startARun } from "../../start-run.ts";
import { campaignBriefBlock } from "../../ui/campaign-brief.ts";
import { type ContextRig, contextBlock } from "../../ui/campaign-context.ts";
import { CAMPAIGN_CONTEXT_JS } from "../../ui/campaign-context-client.ts";
import { earlierRuns, isRigCheck, lastActivity } from "../../ui/campaigns.ts";
import {
  campaignHref,
  esc,
  icon,
  JUDGE_ONLY_WORDS,
  modeName,
  moreText,
  reportingTag,
  runCompleted,
  runHref,
  runKey,
  runLiveHref,
  runState,
} from "../../ui/components.ts";
import { postedUses } from "../../ui/copy-campaign.ts";
import { exportMenu } from "../../ui/exports.ts";
import { howChecked, howCheckedDetails } from "../../ui/goal-checks.ts";
import { campaignKnowledge } from "../../ui/knowledge.ts";
import { infoLabel, QUEUE_TARGET_TIP } from "../../ui/new-campaign.ts";
import { goalState } from "../../ui/operator.ts";
import { campaignReviewsTab } from "../../ui/research.ts";
import { campaignUsageBlock, runStateWord } from "../../ui/usage.ts";
import { listText } from "../../ui/words.ts";
import { usageData } from "../../usage.ts";
import {
  type CampaignView,
  campaignModes,
  campaignViews,
  leaderboard,
  type RigView,
  type RunView,
} from "../../views.ts";
import type { Ctx, Dashboard } from "../context.ts";
import { type CopyTry, campaignPanels } from "./panels.ts";
import { type RunViewName, runHelpers } from "./run.ts";
import { campaignHelpers, headline, modeWords } from "./shared.ts";

/**
 * A campaign's page, one of its runs at a time (campaigns/run.ts), and its forms: another run of
 * the campaign and a copy of it (campaigns/panels.ts), and its agents' context.
 */
export function campaignPageRoutes(app: Hono, dash: Dashboard): void {
  const { cmdForm, csrf, mcpServers, moreMenu, needs, opts, page, parts, pauseMenu, store, views } =
    dash;
  const {
    archivedLine,
    campaignActions,
    copiedLine,
    copyPanel,
    copySource,
    startFrom,
    startPanel,
    startRigs,
  } = campaignPanels(dash);
  const { aboutOf, goalChecksFor, workCardFor } = campaignHelpers(dash);
  const { reviewSources, runSection } = runHelpers(dash);

  /** A campaign's model use and cost over all its runs on every rig (goal 075), for its sidebar. */
  const campaignUsage = (k: CampaignView) =>
    campaignUsageBlock({
      report: usageData(store, { campaign: k.name }).report,
      run: (rig, run) => {
        const x = k.runs.find((y) => y.rig.id === rig && y.run.id === run);
        return x
          ? {
              href: runHref(rig, x.run),
              state: runCompleted(x.run) ? "completed" : runStateWord(x.run.status),
            }
          : undefined;
      },
    });
  const rigList = (k: CampaignView) => [...new Set(k.runs.map((x) => x.rig.id))];

  // ---------------------------------------------------------------- another run of a campaign
  // The Copy panel's form: the copy's page, or the panel again with control's words.
  app.post("/ui/campaigns/:campaign/copy", async (c) => {
    const from = c.req.param("campaign");
    const src = copySource(from);
    const f = await c.req.parseBody({ all: true });
    const one = (k: string) => {
      const v = [f[k] ?? []].flat()[0];
      return typeof v === "string" ? v.trim() : "";
    };
    const name = one("name");
    let picked: McpUse[] | undefined;
    let mcp: McpUse[] | undefined;
    let problems: string[] = [];
    // A research copy's servers, as ticked: sent to control only when they are not the source's.
    if (src?.research && one("mcp") === "1") {
      const tools = new Map(
        mcpServers.list().map((s) => [s.name, s.tools ? s.tools.map((t) => t.name) : null]),
      );
      const p = postedUses(f, tools, src.servers);
      picked = p.uses;
      problems = p.problems;
      if (!sameUses(p.uses, src.servers)) mcp = p.uses;
    }
    // The copy's Agents' context (goal 070): sent only when it is not the source's.
    const typed = { cw: one("context_window"), ca: one("compact_at") };
    let agentsContext: CopyCampaignRequest["agents_context"];
    if ("context_window" in f || "compact_at" in f) {
      const cw = postedNumber(typed.cw, false);
      const at = postedNumber(typed.ca, true);
      if (Number.isNaN(cw)) problems.push("Write the number of tokens in digits, such as 131072.");
      else if (Number.isNaN(at))
        problems.push(compactAtRefusal(0) ?? "The compaction point is not valid.");
      else {
        const source = contractContext(campaignContract(store, from));
        if (cw !== source?.context_window || at !== source?.compact_at)
          agentsContext =
            cw || at
              ? { ...(cw ? { context_window: cw } : {}), ...(at ? { compact_at: at } : {}) }
              : null;
      }
    }
    const out: CopyCampaignOutcome = problems.length
      ? { state: "refused", error: problems.join(" "), status: 400 }
      : copyACampaign(
          parts,
          { from, name, mcp_servers: mcp, agents_context: agentsContext },
          "owner:ui",
        );
    if (out.state === "copied")
      return c.redirect(
        `${campaignHref(out.campaign)}?ok=${encodeURIComponent(`Copied ${copiedFromWords(out.from)} as ${out.campaign}.${agentsContext !== undefined ? ` Agents' context: ${contextShort(out.context)}.` : ""}`)}`,
        303,
      );
    if (!src) return c.text(out.error, out.status);
    return campaignPage(c, { name, picked, error: out.error, context: typed });
  });
  app.post("/ui/campaigns/:campaign/runs", async (c) => {
    const f = await c.req.parseBody();
    const campaign = c.req.param("campaign");
    const back = (m: string) =>
      c.redirect(`${campaignHref(campaign)}?start=1&error=${encodeURIComponent(m)}`, 303);
    const agents = String(f.agents ?? "on") !== "off";
    const promotion = String(f.promotion ?? "");
    const askOwner = askOwnerFrom(f);
    if (typeof askOwner === "string") return back(askOwner);
    const choice = String(f.agents_model ?? "").trim();
    let model: StartRunRequest["model"];
    if (choice) {
      const [p, m] = choice.split("|");
      try {
        model = { provider: decodeURIComponent(p ?? ""), model: decodeURIComponent(m ?? "") };
      } catch {
        // A malformed choice names no provider's model: refused as one.
        model = { provider: "", model: "" };
      }
    }
    const key = String(f.copy_from ?? "");
    const slash = key.indexOf("/");
    const pastIds = [(await c.req.parseBody({ all: true })).past ?? []].flat().map(Number);
    const out = await startARun(
      parts,
      {
        campaign,
        rig: String(f.rig ?? ""),
        agents,
        // The model, the copy box and past research show only with agents on: for a try they
        // are left out, whatever the form sent.
        model: agents ? model : undefined,
        promotion: promotion === "auto" || promotion === "owner_approval" ? promotion : undefined,
        askOwner,
        judgeGpus: String(f.judge_gpus ?? ""),
        queueFrom:
          agents && String(f.copy_queue ?? "") === "1" && slash > 0
            ? { rig: key.slice(0, slash), run: key.slice(slash + 1) }
            : undefined,
        past: agents ? pastIds : undefined,
      },
      "owner:ui",
      true,
    );
    if (out.state === "refused")
      return out.status === 404 && !startFrom(campaign) ? c.text(out.error, 404) : back(out.error);
    if (out.state === "model_given")
      return c.redirect(`${campaignHref(campaign)}?ok=${encodeURIComponent(out.said)}`, 303);
    // A try takes no queue and no briefing: say so when the owner ticked past research it showed
    // (the page hides it for a try, and sends none of it; without the page's script it shows).
    const notes = [
      out.woke ?? "",
      ...out.notes,
      !agents && pastIds.length
        ? "A try (agents off) takes no experiments and no background: what you ticked was left out."
        : "",
    ].filter(Boolean);
    const leftOut = notes.length ? `&ok=${encodeURIComponent(notes.join(" "))}` : "";
    return c.redirect(
      `${campaignHref(campaign)}?run=${encodeURIComponent(runKey(out.rig, out.run))}${leftOut}`,
      303,
    );
  });

  // ---------------------------------------------------------------- the knowledge base (goal 065)
  /** A campaign's Knowledge section: its folder, the folders it reads, who reads it. */
  const knowledgeSection = (c: Ctx, name: string, vs: RigView[], error?: string) => {
    const kb = store.kb();
    const folders = kb.folders();
    const have = new Set(folders.map((f) => f.campaign));
    const modes = campaignModes(store, vs);
    return campaignKnowledge({
      campaign: name,
      folder: kb.folder(name, folders),
      folders: [
        ...folders,
        // Campaigns with no folder yet can be granted too: their items come as their runs report.
        ...[...modes.keys()].filter((x) => !have.has(x)).map((x) => kb.folder(x, folders)),
      ],
      mode: modeWords(modes),
      csrf: csrf(c),
      now: Date.now(),
      error,
    });
  };

  // ---------------------------------------------------------------- a campaign's agents' context
  // Goal 070: a campaign's own context window and compaction point for all its runs' agents, kept
  // in its contract (campaign-context.ts). Its page shows the two fields and what applies on each
  // rig that can run it; Save makes a new version, as set_campaign_context does.
  /** The rigs that can run a campaign, each with its agents' own models and what applies there. */
  const contextRigs = (
    name: string,
    vs: RigView[],
    ctx: AgentsContext | undefined,
    mode: unknown,
  ): ContextRig[] =>
    startRigs(name, vs)
      .filter((r) => !r.off)
      .map((r) => {
        const own = ownModels(store, r.id, mode);
        return { id: r.id, own, now: rigContext(own, ctx) };
      });
  /**
   * The campaign's Experiment queue block (goal 081): its target queue depth, the ideas kept
   * ready, from its newest contract. None for a rig check, a research campaign (its research
   * plan fills its queue) or a campaign with no contract.
   */
  const queueTargetSection = (name: string) => {
    if (isRigCheck(name)) return "";
    const contract = campaignContract(store, name) as
      | { mode?: unknown; lanes?: { count?: unknown; queue_target?: unknown } }
      | undefined;
    if (!contract || contract.mode === "research") return "";
    const count = Number(contract.lanes?.count) || 2;
    const own = contract.lanes?.queue_target;
    const lanes = {
      count,
      ...(typeof own === "number" ? { queue_target: own } : {}),
    };
    return `<div class="block" id="queue-target"><div class="head"><h2>Experiment queue</h2><span class="right">every run of ${esc(name)}</span></div>
<div class="card"><div>${infoLabel("Ideas kept ready", QUEUE_TARGET_TIP)} <b>${queueTarget({ lanes })}</b> <span class="muted">(${esc(queueTargetNote({ lanes }))})</span></div>
<div class="muted small">Set it in New campaign, or as <code>lanes.queue_target</code> in the campaign's contract. A run's Live view says when its queue falls below it, and the teachers are then asked for ideas at once.</div></div></div>`;
  };
  /** The campaign's Agents' context block; none for a rig check, or a campaign with no contract. */
  const contextSection = (c: Ctx, name: string, vs: RigView[], said: boolean) => {
    if (isRigCheck(name)) return "";
    const contract = campaignContract(store, name) as { mode?: unknown } | undefined;
    if (!contract) return "";
    const ctx = contractContext(contract);
    const error = said ? c.req.query("error") : undefined;
    return contextBlock({
      campaign: name,
      csrf: csrf(c),
      context: ctx,
      // After a refusal, the fields show what was typed: control checks it again on Save.
      typed: error ? { cw: c.req.query("cw") ?? "", at: c.req.query("ca") ?? "" } : undefined,
      rigs: contextRigs(name, vs, ctx, contract.mode),
      error,
      ok: said ? c.req.query("ok") : undefined,
    });
  };
  app.get("/ui/assets/campaign-context.js", (c) =>
    c.body(CAMPAIGN_CONTEXT_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  /** A campaign's numbers in a few words: "131,072 tokens at 70%". */
  const contextShort = (ctx: AgentsContext | undefined) => {
    const w = ctx?.context_window;
    const at = ctx?.compact_at;
    return w && at
      ? `${w.toLocaleString("en-US")} tokens at ${at}%`
      : w
        ? `${w.toLocaleString("en-US")} tokens`
        : at
          ? `compact at ${at}%`
          : "the rig's, for each agent";
  };
  /** A field of the Agents' context as posted: undefined when empty, NaN when not digits. */
  const postedNumber = (v: unknown, pct: boolean) => {
    let t = String(v ?? "")
      .trim()
      .replace(/[,_\s]/g, "");
    if (pct) t = t.replace(/%$/, "");
    return !t ? undefined : /^\d+$/.test(t) ? Number(t) : Number.NaN;
  };
  app.post("/ui/campaigns/:campaign/context", async (c) => {
    const campaign = c.req.param("campaign");
    const f = await c.req.parseBody();
    const raw = { cw: String(f.context_window ?? ""), ca: String(f.compact_at ?? "") };
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(
        `${campaignHref(campaign)}?on=context&${k}=${encodeURIComponent(m)}${k === "error" ? `&cw=${encodeURIComponent(raw.cw)}&ca=${encodeURIComponent(raw.ca)}` : ""}#agents-context`,
        303,
      );
    const contextWindow = postedNumber(raw.cw, false);
    const compactAt = postedNumber(raw.ca, true);
    if (Number.isNaN(contextWindow))
      return back("error", "Write the number of tokens in digits, such as 131072.");
    if (Number.isNaN(compactAt))
      return back("error", compactAtRefusal(0) ?? "The compaction point is not valid.");
    const out = setCampaignContext(store, { campaign, contextWindow, compactAt }, "owner:ui");
    if (out.state === "refused")
      return out.status === 404 ? c.text(out.error, 404) : back("error", out.error);
    if (out.state === "unchanged")
      return back("ok", `Nothing changed: version ${out.version} has these numbers already.`);
    const atWork = (campaignViews(views()).find((k) => k.name === campaign)?.runs ?? [])
      .filter((x) => x.run.status === "running")
      .map((x) => x.run.id);
    return back(
      "ok",
      `Saved as version ${out.version}: ${contextShort(out.context)}. New runs of ${campaign} take it.${atWork.length ? ` ${listText(atWork)} ${atWork.length === 1 ? "keeps what it" : "keep what they"} started with.` : ""}`,
    );
  });

  /**
   * A campaign's page: what it is for, its runs, its Knowledge section, and the Start a run and
   * Copy panels; or one run's page. `tried`: a Copy that control refused, to show in the panel.
   */
  const campaignPage = (c: Ctx, tried?: CopyTry) => {
    const now = Date.now();
    const vs = views();
    // Its own route's, or the Copy panel's form's (/ui/campaigns/:campaign/copy).
    const name = String(c.req.param("campaign") ?? "");
    const k = campaignViews(vs).find((x) => x.name === name);
    // A refused grant shows in the Knowledge section, not as a run that did not start.
    const kbFailed = c.req.query("on") === "kb" ? c.req.query("error") : undefined;
    // So does what the Agents' context's Save did, in its own block.
    const onContext = c.req.query("on") === "context";
    // Archive and Move to folder (on=shelf) say what they refused at the top of every page.
    const failed =
      kbFailed || onContext || c.req.query("on") === "shelf" ? undefined : c.req.query("error");
    const okNote = onContext ? undefined : c.req.query("ok");
    const context = () => contextSection(c, name, vs, onContext);
    // The campaign's brief from its contract (goal 078): what its agents know.
    const brief = () => (isRigCheck(name) ? "" : campaignBriefBlock(campaignContract(store, name)));
    const note = `${
      failed
        ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not started.</b> ${esc(failed)}</div>`
        : okNote
          ? `<div class="card" style="margin-bottom:16px"><b class="ok">${esc(okNote)}</b></div>`
          : ""
    }${archivedLine(c, name)}`;
    const canStart = Boolean(startFrom(name)) && !store.campaignArchived(name);
    const buttons = campaignActions(c, name);
    const drawer = `${startPanel(c, name, vs, c.req.query("start") === "1")}${copyPanel(c, name, vs, tried)}`;
    // A run just started (Start a run sends here with ?run=), until its rig reports it.
    // The card follows the run's command (goal 080): how the start goes, in words, and the run's
    // own page once the rig reports the run. A start that the rig refused says why.
    const startingCmd = (key: string) => {
      const slash = key.indexOf("/");
      const run = key.slice(slash + 1);
      return slash > 0
        ? store
            .latestCommands(key.slice(0, slash), "assign_campaign")
            .find(
              (x) =>
                x.payload.run === run &&
                (x.payload.contract as { campaign?: unknown } | undefined)?.campaign === name,
            )
        : undefined;
    };
    const startingCard = (key: string) => {
      const cmd = startingCmd(key);
      const p = cmd ? commandProgress(cmd, Date.now()) : undefined;
      const failed = p?.state === "refused" || p?.state === "expired";
      const follow =
        cmd && p && !p.final
          ? ` data-follow="${esc(commandFollowUrl(cmd.id))}" data-follow-state="${p.state}"`
          : "";
      return `<div class="card" style="margin-bottom:16px" data-part="starting"${follow}><b${failed ? ` class="bad"` : ""}>${failed ? "Not started:" : "Starting"} ${esc(key)}.</b>${p ? ` <span class="${p.tone}">${esc(p.said)}</span>` : ""}${failed ? "" : ` <span class="muted">The rig fetches the project and the kit, and checks both. The run's page opens here when the rig reports the run, usually within a minute.</span>`}</div>`;
    };
    if (!k) {
      // Saved on control, with no run reported yet: what was asked for, and a way to start one.
      const saved = store.campaignVersions(name);
      if (!saved.length && !startFrom(name) && !store.campaignArchived(name))
        return page(
          c,
          {
            title: "Not found",
            crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
            active: "campaigns",
          },
          `<div class="card"><div class="empty">No such campaign.</div></div>`,
          vs,
        );
      const waiting = c.req.query("run");
      // A goal campaign's goals, each with how it is checked (goal 082), before any run.
      const how = goalChecksFor(name, vs);
      const savedGoals = how?.checks.goals.length
        ? `<div class="block"><div class="head"><h2>Goals</h2><span class="n">${how.checks.goals.length}</span></div><div class="card flat">${how.checks.goals
            .map(
              (g) =>
                `<div class="gl"><span class="gl-mark off">·</span><span class="gl-main"><span><b>${esc(g.goal)}</b>${g.required ? "" : ` <span class="muted small">optional</span>`}</span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}${howCheckedDetails(g, how.checks, how.source)}</span></div>`,
            )
            .join("")}</div></div>`
        : "";
      return page(
        c,
        {
          title: name,
          crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
          summary: esc(aboutOf(name)),
          active: "campaigns",
          actions: buttons,
        },
        `${note}${copiedLine(name)}${
          waiting
            ? startingCard(waiting)
            : `<div class="card" style="margin-bottom:16px"><div class="empty">${saved.length ? "Saved on control, with no run yet." : "Assigned to a rig over the API, MCP or the CLI; no run of it reports now."}${canStart ? ` <a class="btn sm primary" href="${campaignHref(name)}?start=1" data-open="#start" style="margin-left:6px">${icon.play}Start a run of ${esc(name)}</a>` : ""}</div></div>`
        }${savedGoals}${brief()}${context()}${queueTargetSection(name)}${knowledgeSection(c, name, vs, kbFailed)}${drawer}`,
        vs,
      );
    }
    const h = headline(k);
    const feed = needs(c, vs, now, campaignHref(name));
    const waitingFor = (u: RigView, r: RunView) =>
      feed.filter((n) => n.rig === u.id && n.run === r.id).length;

    // ---------------------------------------- one run's page
    const wanted = c.req.query("run");
    const sel = wanted ? k.runs.find((x) => runKey(x.rig.id, x.run.id) === wanted) : undefined;
    if (sel) {
      const qv = c.req.query("view");
      const view: RunViewName =
        qv === "attempts" ||
        qv === "history" ||
        qv === "experiments" ||
        qv === "journal" ||
        qv === "stats" ||
        qv === "reviews" ||
        qv === "hypotheses"
          ? qv
          : qv === "planner" || qv === "steering"
            ? "planner"
            : "overview";
      const st = runState(sel.run);
      const back = runHref(sel.rig.id, sel.run, view);
      const quick =
        sel.run.status === "paused"
          ? cmdForm(c, {
              rig: sel.rig.id,
              kind: "resume_run",
              fields: { run: sel.run.id },
              label: "Resume",
              back,
            })
          : sel.run.status === "running"
            ? pauseMenu(c, sel.rig.id, sel.run.id, back)
            : "";
      // A run without agents (a try, a rig check) has no one to message and no lanes to restart.
      const agents = sel.run.has_agents !== false;
      const more = moreMenu(c, sel.rig.id, sel.run, back, "", true);
      return page(
        c,
        {
          title: sel.run.id,
          crumbs: [
            { href: "/ui/campaigns", text: "Campaigns" },
            { href: campaignHref(name), text: name },
          ],
          summary: `on <a href="/ui/rigs/${encodeURIComponent(sel.rig.id)}">${esc(sel.rig.id)}</a>${reportingTag(sel.rig)} · ${esc(modeName(sel.run.mode))}${agents ? "" : " · judge only"} · <span class="label ${st.cls}">${st.icon}${esc(st.text)}</span>`,
          active: "campaigns",
          actions: `<a class="btn" href="${runLiveHref(sel.rig.id, sel.run.id)}">${icon.terminal}Live</a>${agents ? `<a class="btn" href="${runLiveHref(sel.rig.id, sel.run.id, "&compose=1")}">Message</a>` : ""}${quick}${exportMenu({ csrf: csrf(c), rig: sel.rig.id, run: sel.run.id, back })}${more}`,
        },
        `${note}${
          /-try-\d+$/.test(sel.run.id)
            ? `<div class="card hl" style="margin-bottom:12px"><b>A try of the kit.</b> No agents work on this run: the judge builds the starting point and runs every case on its own. When the results look right, <a href="${campaignHref(name)}?start=1">start the campaign</a>.</div>`
            : agents || isRigCheck(name)
              ? ""
              : // Any other run started with its agents off (goal 099): say so plainly. A rig
                // check's smoke run is the rig page's to explain.
                `<div class="card hl" style="margin-bottom:12px"><b>Judge only:</b> ${esc(JUDGE_ONLY_WORDS)}</div>`
        }${runSection(c, sel.rig, sel.run, vs, now, view)}`,
        vs,
      );
    }

    // ---------------------------------------- the campaign
    // A new run of a campaign that has runs: Starting until its rig reports it (only the newest
    // assignment, so an old link to a run that never came says nothing).
    // An old link to a run that never came says nothing, unless the rig refused its start.
    const latest = wanted ? store.latestAssignments().get(name) : undefined;
    const startCmd = wanted ? startingCmd(wanted) : undefined;
    const starting =
      wanted &&
      ((latest && runKey(latest.rig, latest.run) === wanted) ||
        startCmd?.status === "failed" ||
        startCmd?.status === "rejected")
        ? startingCard(wanted)
        : "";
    const running = k.runs.filter((x) => x.run.status === "running");
    const earlier = k.runs
      .filter((x) => x.run.status !== "running")
      .sort((a, b) => lastActivity(b.run).localeCompare(lastActivity(a.run)));
    const waitingRuns = k.runs
      .map((x) => ({ ...x, n: waitingFor(x.rig, x.run) }))
      .filter((x) => x.n > 0);
    const bestRun = h.best;
    // How each goal is really checked (goal 082): from the kit control keeps, else from the
    // newest run whose rig reported it, else what the contract says.
    const how = k.mode === "goal" ? goalChecksFor(name, vs) : undefined;
    const goals =
      (k.mode === "goal" && bestRun?.goals.length
        ? `<div class="kgoals">${bestRun.goals
            .map((g) => {
              const s2 = goalState(g);
              return `<span class="kgoal ${s2.tone}" title="${esc(g.goal)}: ${esc(s2.word)}">${s2.tone === "ok" ? "✓ " : ""}${esc(g.goal)}</span>`;
            })
            .join("")}</div>`
        : "") +
      (how?.checks.goals.length
        ? `<details class="howcheck khow" data-k="how-goals"><summary>How each goal is checked</summary>${how.checks.goals
            .map(
              (g) =>
                `<div class="gl"><span class="gl-main"><span><b>${esc(g.goal)}</b>${g.required ? "" : ` <span class="muted small">optional</span>`}</span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}${howChecked(g, how.checks, how.source)}</span></div>`,
            )
            .join("")}</details>`
        : "");
    const about = aboutOf(name);
    const rigs = rigList(k);
    // A research campaign's page has a Reviews tab (goal 116): its runs' reviews, by run.
    const reviewCount = k.runs.reduce(
      (n, x) => n + x.run.reviews.filter((r) => r.goal === RESEARCH_REVIEW).length,
      0,
    );
    const campaignView =
      k.mode === "research" && c.req.query("view") === "reviews" ? "reviews" : "";
    const campaignTabs =
      k.mode === "research"
        ? `<nav class="tabs"><a class="${campaignView ? "" : "on"}" href="${campaignHref(name)}">Overview</a><a class="${campaignView ? "on" : ""}" href="${campaignHref(name)}?view=reviews">Reviews <span class="muted">${reviewCount}</span></a></nav>`
        : "";
    const verifiedBy = new Map(
      (leaderboard(store, { staleAfterMs: opts.staleAfterMs })[k.name] ?? []).map((r) => [
        runKey(r.rig, r.run),
        r.verified_by,
      ]),
    );
    return page(
      c,
      {
        title: k.name,
        crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
        summary: `${esc(isRigCheck(k.name) ? "rig check" : modeName(k.mode))} · ${k.runs.length} run${k.runs.length === 1 ? "" : "s"}${running.length ? ` · ${running.length} at work` : ""} · ${esc(h.value)} ${esc(h.sub)}${k.mode === "hill_climb" ? ` · <a href="/ui/leaderboard">leaderboard</a>` : ""}`,
        active: "campaigns",
        actions: buttons,
      },
      `${note}${starting}${copiedLine(k.name)}${
        about || goals
          ? `<div class="card khead"><div>${about ? `<div class="small muted">What it is for</div>` : `<div class="small muted">Goals of its best run</div>`}${about ? `<div class="kabout-big">${esc(about)}</div>` : ""}${goals}</div><div class="small muted right">on ${esc(rigs.join(", "))}${bestRun ? `<br>best: ${esc(bestRun.id)}, ${esc(h.value)} ${esc(h.sub)}` : ""}</div></div>`
          : ""
      }${campaignTabs}${
        campaignView === "reviews"
          ? campaignReviewsTab({
              runs: [...running, ...earlier].map((x) => ({
                u: x.rig,
                r: x.run,
                state: (() => {
                  const s = runState(x.run);
                  return `<span class="label ${s.cls}">${s.icon}${esc(s.text)}</span>`;
                })(),
              })),
              now,
              sources: reviewSources,
            })
          : `<div class="cols run-cols"><div>
<div class="block" data-part="at-work"><div class="head"><h2>At work now</h2><span class="n">${running.length}</span></div>${
              running.length
                ? `<div class="kwork one">${running.map((x) => workCardFor(c, x.rig, x.run, now, waitingFor(x.rig, x.run), campaignHref(name))).join("")}</div>`
                : `<div class="card"><div class="empty">No run is at work.${canStart ? ` <a href="${campaignHref(name)}?start=1" data-open="#start">Start one.</a>` : ""}</div></div>`
            }</div>
${waitingRuns.map((w) => `<div class="kneed">${icon.warn}<span class="grow"><b>${w.n} decision${w.n === 1 ? " waits" : "s wait"} for you</b> in ${esc(w.run.id)} on ${esc(w.rig.id)}.</span><a class="btn sm" href="${runHref(w.rig.id, w.run)}#needs">Review</a></div>`).join("")}
<div data-part="earlier">${
              earlier.length
                ? `<div class="block"><div class="head"><h2>Earlier runs</h2><span class="n">${earlier.length}</span><span class="right">paused, completed and finished, newest first; open one for its attempts and history</span></div>${earlierRuns(
                    earlier.map((x) => ({
                      ...x,
                      // A hill climb's champion that other rigs confirmed (cross-verified).
                      result: (() => {
                        const v = verifiedBy.get(runKey(x.rig.id, x.run.id)) ?? [];
                        return v.length
                          ? ` <span class="pill ok" title="other rigs' judges confirmed this run's champion">${icon.check}cross-verified on ${esc(v.join(", "))}</span>`
                          : "";
                      })(),
                      action:
                        x.run.status === "paused"
                          ? cmdForm(c, {
                              rig: x.rig.id,
                              kind: "resume_run",
                              fields: { run: x.run.id },
                              label: "Resume",
                              cls: "sm",
                              back: campaignHref(name),
                            })
                          : "",
                    })),
                    now,
                  )}</div>`
                : ""
            }</div>${brief()}${context()}${queueTargetSection(name)}${knowledgeSection(c, name, vs, kbFailed)}
</div><div class="side">${campaignUsage(k)}</div></div>`
      }${drawer}`,
      vs,
    );
  };
  app.get("/ui/campaigns/:campaign", (c) => campaignPage(c));
}
