import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { USAGE_BATCH } from "../../agents/model/index.ts";
import { MODEL_CALLS } from "../../core/api/harness/advisors.ts";
import { CallUsage } from "../../core/usage.ts";
import { type ApiContext, limitOf } from "./context.ts";

/** Model usage (goal 075), each as its own code measured it: a Pi worker's, and the advisors'. */
export function usageRoutes(app: Hono, { service, supervisor, trialOf }: ApiContext): void {
  // A Pi worker's model usage (goal 075): what its own code measured of each model call, never
  // its agent. The trial decides the run, the trial and the route; only a trial whose worker hands
  // its usage over may (the harness reads the other programs' output itself).
  app.post("/v1/trial/usage", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const body = z
      .strictObject({ calls: z.array(CallUsage).min(1).max(USAGE_BATCH) })
      .parse(await c.req.json());
    return c.json({ recorded: service.usage.fromTrial(trial, body.calls) }, 201);
  });

  // The advisors' model usage (goal 075): one advisor's calls in a run, as the supervisor's code
  // measured them. Only the advisors' own kinds; the workers' and the planner's are the harness's.
  app.post(MODEL_CALLS.path, supervisor, limitOf(MODEL_CALLS), async (c) => {
    const { run, calls, ...ctx } = MODEL_CALLS.body.parse(await c.req.json());
    return c.json(
      { recorded: service.usage.fromSupervisor(run, { trial: null, ...ctx }, calls) },
      201,
    );
  });
}
