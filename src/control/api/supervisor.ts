import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BadInput, jsonBody } from "../../common/errors.ts";
import { FIGURES } from "../../core/api/control/rigs.ts";
import { isUserKey, USER_KEY_WORDS } from "../../core/link/users.ts";
import { type BusUsers, takeRigBusKey } from "../bus/users.ts";
import { reportPlace } from "../ingest.ts";
import { modelSteps } from "../model-steps.ts";
import type { ControlStore } from "../store/index.ts";

/** What the route needs from control: its store, and the bus's users when control runs the bus. */
export interface SupervisorRoutesDeps {
  store: ControlStore;
  busUsers?: BusUsers | undefined;
}

/**
 * The supervisor's own figures, its regular call (unsigned: the supervisor reports itself). A
 * model download that starts or ends is a step in the rig's history.
 * With the bus, the figures carry the rig's key: a key that is not a NATS user key is refused, and
 * a new or changed one gets its user on the bus before the answer, so the supervisor can sign in
 * once it has it. The key is kept apart from the figures, which pages show.
 */
export function supervisorRoutes(
  app: Hono,
  rigAuth: MiddlewareHandler,
  deps: SupervisorRoutesDeps,
): void {
  const { store } = deps;
  app.post(FIGURES.path, rigAuth, bodyLimit({ maxSize: FIGURES.maxBytes }), async (c) => {
    const rig = c.req.param("rig");
    const { bus_key: busKey, ...stats } = FIGURES.body.parse(await jsonBody(c.req));
    if (busKey !== undefined && !isUserKey(busKey))
      throw new BadInput(`bus_key is not ${USER_KEY_WORDS}`);
    const before = store.reportedRigs.supervisor(rig)?.models;
    store.reportedRigs.setSupervisor(rig, stats);
    for (const s of modelSteps(before, stats.models))
      store.rigHistory.add(rig, s.step, s.ok, s.detail);
    if (busKey && takeRigBusKey(store, rig, busKey) !== "same") await deps.busUsers?.sync();
    return c.json({ ok: true, reports: reportPlace(store, rig) });
  });
}
