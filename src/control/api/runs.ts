import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { errorText } from "../../common/errors.ts";
import { RUN_DETAIL_INPUT, runDetail } from "../run-lists.ts";
import type { RunView } from "../views.ts";

/** What the routes need from control: a run's view, and a past run's untried experiments. */
export interface RunRoutesDeps {
  /** The run's view, or why there is none. */
  find(rig: string, run: string): { run: RunView } | { error: string };
  /** A past run's untried experiments as a new run's first queue, for `campaign` (goal 067). */
  untried(run: RunView, campaign: string): unknown[];
}

/** A number from the query, or undefined so that the argument's default applies. */
const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));

/** The query's arguments, read as MCP's get_run reads its own (goal 128). */
const DetailQuery = z.object({
  attempts: z.preprocess(num, RUN_DETAIL_INPUT.attempts),
  limit: z.preprocess(num, RUN_DETAIL_INPUT.limit),
  list: RUN_DETAIL_INPUT.list,
  offset: z.preprocess(num, RUN_DETAIL_INPUT.offset),
  full_report: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

/**
 * Control's REST routes for one run of a rig, the owner's and an operator's (admin): the run
 * itself, of a size an agent can read (goal 128, as MCP's get_run gives it); a past run's untried
 * experiments as a new run's first queue (goal 067); and its directions (goal 066).
 */
export function runRoutes(app: Hono, admin: MiddlewareHandler, deps: RunRoutesDeps): void {
  app.get("/v1/rigs/:rig/runs/:run", admin, (c) => {
    const found = deps.find(c.req.param("rig"), c.req.param("run"));
    if ("error" in found) return c.json({ error: found.error }, 404);
    const q = DetailQuery.safeParse({
      attempts: c.req.query("attempts"),
      limit: c.req.query("limit"),
      list: c.req.query("list") || undefined,
      offset: c.req.query("offset"),
      full_report: c.req.query("full_report") || undefined,
    });
    if (!q.success) return c.json({ error: q.error.issues.map((i) => i.message).join("; ") }, 400);
    try {
      return c.json(runDetail(found.run, q.data));
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });

  // A past run's untried experiments as a new run's first queue (goal 067): what Start a run
  // copies, at most 500, with the words and authors control's records hold, as MCP takes them
  // for the new run's campaign (`campaign`; the past run's own when not given).
  app.get("/v1/rigs/:rig/runs/:run/untried", admin, (c) => {
    const rig = c.req.param("rig");
    const run = c.req.param("run");
    const found = deps.find(rig, run);
    if ("error" in found) return c.json({ error: found.error }, 404);
    const r = found.run;
    const campaign = c.req.query("campaign") || r.campaign || "";
    return c.json({ rig, run, campaign: r.campaign, queue: deps.untried(r, campaign) });
  });

  // A run's directions (goal 066), each with its counts and the rules naming it, and the rules in
  // force: what a rule may name, and what a picker of directions lists.
  app.get("/v1/rigs/:rig/runs/:run/directions", admin, (c) => {
    const rig = c.req.param("rig");
    const run = c.req.param("run");
    const found = deps.find(rig, run);
    if ("error" in found) return c.json({ error: found.error }, 404);
    const r = found.run;
    return c.json({ rig, run, mode: r.mode, directions: r.directions, rules: r.rules });
  });
}
