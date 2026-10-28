import { ApiError } from "../common/api/call.ts";
import { controlClient } from "../common/api/control.ts";
import { harnessClient } from "../common/api/harness.ts";
import { log } from "../common/env.ts";
import { MODEL_ROUTE } from "../core/api/control/rigs.ts";
import { MODEL_ROUTE_GET, MODEL_ROUTE_PUT } from "../core/api/harness/supervisor.ts";
import type { ControlRoute } from "../core/api/model-route.ts";
import type { AnswerOf } from "../core/api/route.ts";

/**
 * The agents' model route comes from control: the owner sets it on the settings page, and control
 * keeps its key sealed. The supervisor fetches its rig's route over its own authenticated channel
 * and hands it to its harness when it changed. It never logs or keeps the key. Only control's
 * explicit "no route" returns the agents to the rig's own settings; an error changes nothing.
 * With the message bus, the route comes in the rig's config there instead (config/), and is
 * handed over the same way.
 */
export interface RouteSync {
  rig: string;
  controlUrl: string;
  controlToken: string;
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
}

export type RouteSyncResult = "unchanged" | "set" | "cleared" | "no_agents";

/**
 * One round of the supervisor's route poll. A failed sync is tried once more after `retryMs`:
 * at start, control may not answer yet ("fetch failed"), and one retry keeps that out of the
 * log. The retry's outcome stands for the round, so only a second failure reaches the caller,
 * which logs it.
 */
export async function syncModelRouteRound(
  s: RouteSync,
  retryMs: number,
  wait: (ms: number) => Promise<void>,
): Promise<RouteSyncResult> {
  try {
    return await syncModelRoute(s);
  } catch {
    await wait(retryMs);
    return syncModelRoute(s);
  }
}

/** One round of the poll: control's routes, handed to the harness when they changed. */
export async function syncModelRoute(s: RouteSync): Promise<RouteSyncResult> {
  const control = controlClient({
    url: s.controlUrl,
    token: s.controlToken,
    rig: s.rig,
    fetchImpl: s.fetchImpl,
  });
  return handModelRoute(s, await control.call(MODEL_ROUTE));
}

/**
 * Hands the harness control's routes, the workers' and the planner's (newer controls), when they
 * differ from the ones it holds: from the poll, or from the rig's config on the message bus.
 */
export async function handModelRoute(
  s: Pick<RouteSync, "harnessUrl" | "harnessToken" | "fetchImpl">,
  given: AnswerOf<typeof MODEL_ROUTE>,
): Promise<RouteSyncResult> {
  const harness = harnessClient({
    url: s.harnessUrl,
    token: s.harnessToken,
    fetchImpl: s.fetchImpl,
  });
  // The planner's own route, when the owner gave the planner a model (newer controls).
  const { route, planner = null } = given;
  let info: AnswerOf<typeof MODEL_ROUTE_GET>;
  try {
    info = await harness.call(MODEL_ROUTE_GET);
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") return "no_agents";
    throw err;
  }
  const plannerSame = (info.planner_revision ?? null) === (planner?.revision ?? null);
  if (
    plannerSame &&
    (route
      ? info.source === "control" && info.revision === route.revision
      : info.source !== "control")
  )
    return "unchanged";
  // Control's routes, passed on untouched: the harness checks each whole.
  await harness.call(MODEL_ROUTE_PUT, {
    body: { route: route as ControlRoute | null, planner: planner as ControlRoute | null },
  });
  log("supervisor", route ? "model route handed to the harness" : "model route cleared", {
    name: route?.name ?? null,
    version: route?.version ?? null,
  });
  return route ? "set" : "cleared";
}
