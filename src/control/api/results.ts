import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { jsonBody } from "../../common/errors.ts";
import { CHAMPION_PATCH, KB, KB_NOT_ASSIGNED, REPORTS } from "../../core/api/control/rigs.ts";
import { type ExportFiles, mountExports } from "../exports.ts";
import { propagateChampion } from "../issue/index.ts";
import { resultsLeft } from "../results-left.ts";
import { leaderboard } from "../views/index.ts";
import { type ApiContext, clampLimit } from "./context.ts";

/**
 * What rigs' runs produce, and the owner reads: the knowledge base's items for a run's agents,
 * champions' patches, exports (`exportFiles`: where control keeps them; none, it takes none),
 * daily reports, the leaderboard, and a champion propagated to another rig.
 */
export function resultRoutes(
  app: Hono,
  api: ApiContext,
  exportFiles: ExportFiles | undefined,
): void {
  const { store, privateKeyPem, opts, admin, rigAuth } = api;

  // Past research for a run's agents (goal 065): the items of the folders the run's campaign may
  // read, after the supervisor's cursor. Only the rig's own runs; never a folder not granted.
  app.get(KB.path, rigAuth, (c) => {
    c.header("cache-control", "no-store");
    const run = c.req.query("run") ?? "";
    const after = Number(c.req.query("after") ?? "0");
    if (!run) return c.json({ error: "run is required" }, 400);
    if (!Number.isSafeInteger(after) || after < 0)
      return c.json({ error: "after is a whole number from 0" }, 400);
    // Only a run control assigned to this rig, of the campaign control assigned: a rig cannot
    // read another campaign's folders by naming it in its own events.
    const assigned = store.runRegistry.assignedCampaigns(c.req.param("rig")).get(run);
    if (!assigned) {
      const error = `control did not assign run ${run} to this rig`;
      return c.json({ error, code: KB_NOT_ASSIGNED }, 404);
    }
    const sync = store.kb().sync(c.req.param("rig"), run, after);
    if (!sync) return c.json({ error: `this rig has no run ${run}` }, 404);
    if (sync.campaign !== assigned)
      return c.json({ error: `run ${run} is not of the campaign control assigned` }, 409);
    return c.json(sync);
  });

  // A champion's patch, uploaded by the rig's supervisor once its export is published. It is
  // kept only if its sha256 is the one the rig's signed champion_published event names.
  app.post(
    CHAMPION_PATCH.path,
    rigAuth,
    bodyLimit({ maxSize: CHAMPION_PATCH.maxBytes }),
    async (c) => {
      const seq = Number(c.req.param("seq"));
      if (!Number.isInteger(seq) || seq < 1) return c.json({ error: "bad seq" }, 400);
      const patch = Buffer.from(await c.req.arrayBuffer());
      const r = store.championPatches.put(c.req.param("rig"), c.req.param("run"), seq, patch);
      if (r === "not_published")
        return c.json({ error: "control has no champion_published event for it yet" }, 409);
      if (r === "mismatch")
        return c.json({ error: "the patch is not the one the rig published" }, 422);
      return c.json({ stored: true }, 201);
    },
  );
  app.get("/v1/rigs/:rig/champions/:run/:seq/patch", admin, (c) => {
    const p = store.championPatches.get(
      c.req.param("rig"),
      c.req.param("run"),
      Number(c.req.param("seq")),
    );
    if (!p) return c.json({ error: "no patch for that champion" }, 404);
    return c.body(new Uint8Array(p.patch), 200, {
      "content-type": "text/x-diff",
      "x-thermite-base-commit": p.base_commit,
      "x-thermite-sha256": p.sha256,
    });
  });

  // Exports a rig without a results repository sends to control, and the owner reads back.
  mountExports(app, {
    store,
    files: exportFiles,
    rigAuth,
    admin,
  });
  // Have all of a rig's results left it? (What a terminate waits for: goal 023.)
  app.get("/v1/rigs/:rig/results-left", admin, (c) =>
    c.json(resultsLeft(store, c.req.param("rig"), { export: c.req.query("export") || undefined })),
  );

  app.post(REPORTS.path, rigAuth, bodyLimit({ maxSize: REPORTS.maxBytes }), async (c) => {
    const body = REPORTS.body.parse(await jsonBody(c.req));
    return c.json({ id: store.rigReports.add(c.req.param("rig"), body.kind, body.body) }, 201);
  });

  app.get("/v1/reports", admin, (c) =>
    c.json({
      reports: store.rigReports.list(
        clampLimit(c.req.query("limit"), 20),
        c.req.query("rig") || undefined,
      ),
    }),
  );

  app.get("/v1/leaderboard", admin, (c) =>
    c.json({ campaigns: leaderboard(store, { staleAfterMs: opts.staleAfterMs }) }),
  );

  app.post("/v1/propagate", admin, async (c) => {
    const body = z
      .object({
        from_rig: z.string().min(1),
        run: z.string().min(1),
        to_rig: z.string().min(1),
        to_run: z.string().min(1),
      })
      .parse(await jsonBody(c.req));
    const r = propagateChampion(store, privateKeyPem, {
      fromRig: body.from_rig,
      run: body.run,
      toRig: body.to_rig,
      toRun: body.to_run,
      issuedBy: "owner:api",
      staleAfterMs: opts.staleAfterMs,
    });
    return c.json(r, 201);
  });
}
