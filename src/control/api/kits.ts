import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { redact } from "../../common/env.ts";
import { KIT_ADD, KITS } from "../../core/api/control/owner.ts";
import { addKit, kitAnswer, kitsAnswer } from "../kit-add.ts";
import { KIT_BUNDLE_MAX } from "../kit-repos.ts";
import type { ApiContext } from "./context.ts";

/**
 * The kits control keeps, and a kit written elsewhere given as a git bundle of its repository:
 * kept with its commits, served to rigs as the kits the New campaign page writes are. The body
 * is the bundle's bytes; ?ref= names the head, ?force=true replaces a head it does not descend
 * from. The owner's token adds; the reader's reads too (MCP's kit_add takes an operator's).
 */
export function kitRoutes(app: Hono, api: ApiContext): void {
  const { store, opts, admin, reader } = api;

  app.get(KITS.path, reader, (c) =>
    opts.kits
      ? c.json(kitsAnswer(opts.kits))
      : c.json({ error: "this control keeps no kits" }, 404),
  );
  app.get("/v1/kits/:name", reader, (c) => {
    if (!opts.kits) return c.json({ error: "this control keeps no kits" }, 404);
    const out = kitAnswer(opts.kits, c.req.param("name"));
    return out.ok ? c.json(out.answer) : c.json({ error: out.error }, out.status);
  });
  app.post(
    KIT_ADD.path,
    admin,
    bodyLimit({
      maxSize: KIT_ADD.maxBytes,
      onError: (c) => {
        const error = `the bundle is above the ${KIT_BUNDLE_MAX} bytes (64 MiB) control takes`;
        store.auditLog.add("owner:api", "refused", { path: c.req.path, why: error });
        return c.json({ error }, 413);
      },
    }),
    async (c) => {
      const name = c.req.param("name");
      const path = `/v1/kits/${name}`;
      const refuse = (error: string, status: 400 | 404 | 409 | 413) => {
        store.auditLog.add("owner:api", "refused", { path, why: redact(error) });
        return c.json({ error }, status);
      };
      if (!opts.kits) return refuse("this control keeps no kits", 404);
      const force = c.req.query("force");
      if (force !== undefined && !["", "true", "false", "1", "0"].includes(force))
        return refuse("force is true or false", 400);
      const out = await addKit(
        store,
        opts.kits,
        {
          name,
          bundle: Buffer.from(await c.req.arrayBuffer()),
          ref: c.req.query("ref") || undefined,
          force: force === "true" || force === "1",
        },
        "owner:api",
      );
      if (!out.ok) return refuse(out.error, out.status);
      return c.json(out.answer, out.created ? 201 : 200);
    },
  );
}
