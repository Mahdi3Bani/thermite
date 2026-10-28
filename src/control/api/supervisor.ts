import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { BadInput, jsonBody } from "../../common/errors.ts";
import { isUserKey, USER_KEY_WORDS } from "../../core/link/users.ts";
import { type BusUsers, takeRigBusKey } from "../bus/users.ts";
import { reportPlace } from "../ingest.ts";
import { modelSteps } from "../model-steps.ts";
import { AdvisorsFileSchema } from "../rig-model.ts";
import type { ControlStore } from "../store.ts";

/**
 * What a supervisor may say about itself: numbers and short strings only (it is unsigned). A field
 * this control does not know, at any level, is dropped, never stored or shown: a newer supervisor
 * that reports more still has the rest of its figures taken (goal 012). The fields it knows keep
 * their checks.
 */
const Count = z.number().finite().min(0).max(1e12);
const Bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Short = z.string().max(1000);
const ExportNames = z.array(z.string().regex(/^[0-9A-Za-z-]{1,80}$/)).max(50);
const SupervisorStats = z.object({
  at: Short,
  relay: z.object({ cursor: Count }).optional(),
  export: z
    .object({
      remote: z.boolean(),
      /** Where its exports go: the results repository, control, or nowhere off the rig. */
      to: z.enum(["repository", "control", "none"]).optional(),
      exports: Count,
      pushed: ExportNames,
      pushed_commit: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/)
        .nullable()
        .optional(),
      last_push_at: Short.nullable(),
      /** The newest exports it sent to control in full. */
      uploaded: ExportNames.optional(),
      last_upload_at: Short.nullable().optional(),
      /** Exports on the rig that have not left it yet, and champion patches not yet on control. */
      waiting: Count.optional(),
      champions_waiting: Count.optional(),
      last_error: Short.nullable(),
    })
    .optional(),
  /** Model files it downloads or downloaded for the harness (model-download.ts), newest first. */
  models: z
    .array(
      z.object({
        name: z.string().max(200),
        path: Short,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        from: z.string().max(300),
        state: z.enum(["downloading", "done", "refused", "failed"]),
        bytes: Bytes,
        total: Bytes.nullable(),
        resumed_from: Bytes,
        started_at: Short,
        updated_at: Short,
        error: Short.optional(),
        run: z.string().max(80).optional(),
      }),
    )
    .max(20)
    .optional(),
  advisors: z
    .object({
      teacher_runs: Count,
      directive_sets: Count,
      directives: Count,
      audits: Count,
      reviews: Count,
      errors: Count,
      tokens_in: Count,
      tokens_out: Count,
      usd: Count,
      last_error: Short.optional(),
      /** Which advisor roles the rig has configured (so control knows if an auditor decides). */
      roles: z
        .object({
          teachers: Count,
          merged_by: z.boolean(),
          auditor: z.boolean(),
          review_panel: Count,
        })
        .optional(),
      /**
       * What the rig's advisors file sets up for each role (goal 074): Edit rig says what an
       * advisor with no model from control uses. A malformed one is dropped, not the report.
       */
      file: AdvisorsFileSchema.optional().catch(undefined),
    })
    .nullable()
    .optional(),
  /** The public part of the rig's key on the message bus (goal 168), checked below. */
  bus_key: z.string().max(100).optional(),
});

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
  app.post("/v1/rigs/:rig/supervisor", rigAuth, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const rig = c.req.param("rig");
    const { bus_key: busKey, ...stats } = SupervisorStats.parse(await jsonBody(c.req));
    if (busKey !== undefined && !isUserKey(busKey))
      throw new BadInput(`bus_key is not ${USER_KEY_WORDS}`);
    const before = store.supervisor(rig)?.models;
    store.setSupervisor(rig, stats);
    for (const s of modelSteps(before, stats.models))
      store.rigSetupEvent(rig, s.step, s.ok, s.detail);
    if (busKey && takeRigBusKey(store, rig, busKey) !== "same") await deps.busUsers?.sync();
    return c.json({ ok: true, reports: reportPlace(store, rig) });
  });
}
