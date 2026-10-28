import type { Hono } from "hono";
import { checkClusterNow, setClusterSlots } from "../../clusters/rigs.ts";
import type { Dashboard } from "../context.ts";
import { settingsUrl } from "./shared.ts";

/** A cluster's forms on Providers: check it now, its slots, and delete it. */
export function clusterRoutes(app: Hono, dash: Dashboard): void {
  const { parts, store } = dash;

  // ---------------------------------------------------------------- clusters (Providers)
  app.post("/ui/settings/clusters/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!store.cluster(name)) return c.redirect(settingsUrl("error", "No such cluster."), 303);
    const why = await checkClusterNow(parts, name);
    return c.redirect(
      why ? settingsUrl("error", `"${name}": ${why}`) : settingsUrl("ok", `Read "${name}" again.`),
      303,
    );
  });
  app.post("/ui/settings/clusters/:name/slots", async (c) => {
    const name = c.req.param("name");
    const f = await c.req.parseBody();
    const slots = String(f.slots ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const why = await setClusterSlots(parts, name, slots, "owner:ui");
    return c.redirect(
      why
        ? settingsUrl("error", `"${name}": ${why}.`)
        : settingsUrl(
            "ok",
            `"${name}" now has ${slots.length} slot${slots.length === 1 ? "" : "s"}, read again.`,
          ),
      303,
    );
  });
  app.post("/ui/settings/clusters/:name/delete", (c) => {
    const name = c.req.param("name");
    if (store.clusterRigs(name).some((r) => r.status !== "removed"))
      return c.redirect(settingsUrl("error", `"${name}" still runs rigs: remove them first.`), 303);
    return c.redirect(
      store.deleteCluster(name, "owner:ui")
        ? settingsUrl("ok", `"${name}" is deleted: control keeps nothing of its kubeconfig.`)
        : settingsUrl("error", "No such cluster."),
      303,
    );
  });
}
