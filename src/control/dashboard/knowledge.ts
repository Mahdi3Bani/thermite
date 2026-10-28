import type { Hono } from "hono";
import { PICKABLE } from "../kb.ts";
import { runHref, runKey } from "../ui/components.ts";
import { knowledgePage, pastWords, SEARCH_KINDS } from "../ui/knowledge.ts";
import { campaignModes, type RigView } from "../views/index.ts";
import { campaignHelpers, modeWords } from "./campaigns/shared.ts";
import type { Dashboard } from "./context.ts";

/** The Knowledge page (goal 065) and its search. */
export function knowledgeRoutes(app: Hono, dash: Dashboard): void {
  const { page, store, views } = dash;
  const { pastResults } = campaignHelpers(dash);

  /** A run's page, when a rig reports the run now (an item's run may be gone after a reset). */
  const runLinks = (vs: RigView[]) => {
    const live = new Map(
      vs.flatMap((u) => u.runs.map((r) => [runKey(u.id, r.id), runHref(u.id, r)] as const)),
    );
    return (rig: string, run: string) => live.get(runKey(rig, run));
  };

  // ---------------------------------------------------------------- the Knowledge page (goal 065)
  app.get("/ui/knowledge", (c) => {
    const vs = views();
    const kb = store.kb();
    const folders = kb.folders();
    const q = (c.req.query("q") ?? "").slice(0, 300);
    const kind = SEARCH_KINDS.find((k) => k === c.req.query("kind")) ?? "";
    const folder = folders.find((f) => f.campaign === c.req.query("folder"))?.campaign ?? "";
    const limit = 100;
    const results = kb.search(q, folder ? [folder] : folders.map((f) => f.campaign), {
      ...(kind ? { kinds: [kind] } : {}),
      limit,
    });
    return page(
      c,
      {
        title: "Knowledge",
        summary: "Thermite's knowledge base: a folder for each campaign, and what each may read",
        active: "knowledge",
      },
      knowledgePage({
        folders,
        mode: modeWords(campaignModes(store, vs)),
        q,
        kind,
        folder,
        results,
        limit,
        now: Date.now(),
        link: runLinks(vs),
        result: (x) => kb.resultOf(x),
      }),
      vs,
    );
  });

  /**
   * Start a run's "From past research": a search of the folders one campaign may read (its own
   * and those granted), of the kinds a new run can start from. Agents' text, sent as JSON data.
   */
  app.get("/ui/kb/search.json", (c) => {
    c.header("cache-control", "no-store");
    const campaign = c.req.query("campaign") ?? "";
    if (!campaignModes(store, views()).has(campaign))
      return c.json({ error: "no such campaign" }, 404);
    const kb = store.kb();
    const folders = kb.readable(campaign);
    const items = pastResults(campaign, (c.req.query("q") ?? "").slice(0, 300));
    return c.json({
      campaign,
      folders,
      items: items.map((x) => {
        const w = pastWords(x, kb.resultOf(x));
        return {
          id: x.id,
          kind: x.kind,
          label: w.label,
          title: x.title,
          line: w.line,
          campaign: x.campaign,
          run: x.run,
          by: x.by,
          at: x.updated_at,
          goes: PICKABLE[x.kind],
        };
      }),
    });
  });
}
