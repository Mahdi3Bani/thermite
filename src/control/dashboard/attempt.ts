import type { Hono } from "hono";
import { commandFollowUrl, commandProgress } from "../command-progress.ts";
import { attemptHref, campaignHref, esc, runHref } from "../ui/components.ts";
import { attemptDetail, needs as operatorNeeds } from "../ui/operator.ts";
import { runCampaign } from "../views/facts.ts";
import type { Dashboard } from "./context.ts";

/**
 * One attempt's page, a run's champion patches and research paper, and accepting a rig's new
 * key.
 */
export function attemptRoutes(app: Hono, dash: Dashboard): void {
  const { forms, page, store, views } = dash;

  // ---------------------------------------------------------------- one attempt
  // A champion as a patch file: the result an operator takes away (it applies to the base commit).
  app.get("/ui/rigs/:rig/runs/:run/champions/:file", (c) => {
    const m = /^(\d+)\.patch$/.exec(c.req.param("file"));
    const p = m
      ? store.championPatches.get(c.req.param("rig"), c.req.param("run"), Number(m[1]))
      : undefined;
    if (!m || !p) return c.text("No patch for that champion yet.", 404);
    // A project in a folder: named after the repository's commit, the one its owner has.
    const folder = views()
      .find((u) => u.id === c.req.param("rig"))
      ?.runs.find((r) => r.id === c.req.param("run"))?.seed_folder;
    const name = `${c.req.param("run")}-champion-${m[1]}-on-${(folder?.commit ?? p.base_commit).slice(0, 8)}.patch`;
    return c.body(new Uint8Array(p.patch), 200, {
      "content-type": "text/x-diff; charset=utf-8",
      "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
    });
  });

  // A research run's paper (goal 112), as its rig's report carries it: the Markdown file, with
  // the references the harness appended (the same text is paper.md in the run's research folder).
  // Shown as plain text: it is the agents' writing.
  app.get("/ui/rigs/:rig/runs/:run/paper.md", (c) => {
    const run = c.req.param("run");
    const p = views()
      .find((u) => u.id === c.req.param("rig"))
      ?.runs.find((r) => r.id === run)?.paper;
    if (p?.state !== "in" || !p.text) return c.text("No research paper for that run yet.", 404);
    return c.body(p.text, 200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `inline; filename="${`${run}-paper.md`.replace(/[^\w.-]/g, "_")}"`,
    });
  });

  /** The follow of the owner's newest decision on a change, while the rig has not done it. */
  const followDecision = (rig: string, attempt: string, now: number) => {
    const d = store.commands.decisions().find((x) => x.rig === rig && x.attempt === attempt);
    const cmd = d ? store.commands.row(d.id) : undefined;
    const p = cmd ? commandProgress(cmd, now) : undefined;
    return cmd && p && !p.final
      ? ` data-follow="${esc(commandFollowUrl(cmd.id))}" data-follow-state="${esc(p.state)}"`
      : "";
  };
  app.get("/ui/rigs/:rig/attempts/:attempt", (c) => {
    const now = Date.now();
    const vs = views();
    const u = vs.find((x) => x.id === c.req.param("rig"));
    const id = c.req.param("attempt");
    const r = u?.runs.find((x) => x.attempts.some((a) => a.id === id));
    const a = r?.attempts.find((x) => x.id === id);
    if (!u || !r || !a)
      return page(
        c,
        { title: "Not found", active: "campaigns" },
        `<div class="card"><div class="empty">No such attempt on this rig.</div></div>`,
        vs,
      );
    const back = attemptHref(u.id, a.id);
    // The change's own page keeps its decision after the owner chose: it says what the rig did.
    const decision = operatorNeeds(store, [u], forms(c), now, back).find((n) => n.attempt === a.id);
    // A champion's patch, once the rig has published it.
    const champ = r.champion.find((x) => x.attempt === a.id && !x.reopened);
    const patch =
      champ && store.championPatches.get(u.id, r.id, champ.seq)
        ? `<a href="/ui/rigs/${encodeURIComponent(u.id)}/runs/${encodeURIComponent(r.id)}/champions/${champ.seq}.patch">Download champion #${champ.seq} as a patch</a>`
        : undefined;
    return page(
      c,
      {
        title: a.id,
        crumbs: [
          { href: "/ui/campaigns", text: "Campaigns" },
          { href: campaignHref(runCampaign(r)), text: runCampaign(r) },
          { href: runHref(u.id, r), text: `${r.id} on ${u.id}` },
        ],
        active: "campaigns",
      },
      // One part: the owner's decision and what the rig did show without a refresh (goal 080),
      // followed while the rig has not done it.
      `<div data-part="attempt"${followDecision(u.id, a.id, now)}>${attemptDetail(u, r, a, now, { decision, patch })}</div>`,
      vs,
    );
  });

  app.post("/ui/rigs/:rig/key/accept", async (c) => {
    const f = await c.req.parseBody();
    // Only the key whose fingerprint the owner saw: a key swapped in meanwhile is not accepted.
    store.reportedRigs.acceptPendingKey(
      c.req.param("rig"),
      "owner:ui",
      String(f.fingerprint ?? ""),
    );
    return c.redirect(`/ui/rigs/${encodeURIComponent(c.req.param("rig"))}`, 303);
  });
}
