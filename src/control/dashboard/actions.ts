import type { Hono } from "hono";
import { errorText } from "../../common/errors.ts";
import { checkProgress, checkRows, commandProgress, modelProgress } from "../command-progress.ts";
import { propagateChampion } from "../issue.ts";
import { advanceResets, cancelReset, confirmReset } from "../lifecycle.ts";
import { runpodResetRefusal } from "../runpod-lifecycle.ts";
import { RIG_ID } from "../store.ts";
import { runHref } from "../ui/components.ts";
import { backTo, type Dashboard } from "./context.ts";

/**
 * Following an action to its outcome (goal 080): a command's, a check's and a model's progress,
 * and the actions that answer it directly (full reset, leave a trial, propagate a champion,
 * restart or reset a rig).
 */
export function actionRoutes(app: Hono, dash: Dashboard): void {
  const { opts, store, views } = dash;

  // ---------------------------------------------------------------- following an action (goal 080)
  // The page's script sends an action's form with fetch, asking for JSON, then follows it on these
  // routes until its outcome: a Progress (command-progress.ts) each time.
  app.get("/ui/commands/:file{.+\\.json}", (c) => {
    const cmd = store.commands.row(c.req.param("file").replace(/\.json$/, ""));
    return cmd ? c.json(commandProgress(cmd, Date.now())) : c.json({ error: "not found" }, 404);
  });
  app.get("/ui/rigs/:rig/checks/:file{.+\\.json}", (c) => {
    const rig = c.req.param("rig");
    const check = c.req.param("file").replace(/\.json$/, "");
    const known = store.reportedRigs.list().find((x) => x.id === rig);
    if (!known) return c.json({ error: "not found" }, 404);
    const row = checkRows(store, rig, Date.now())[check];
    return row
      ? c.json(checkProgress(row, known.last_cursor))
      : c.json({ error: "not found" }, 404);
  });
  app.get("/ui/rigs/:rig/model.json", (c) => {
    const rig = c.req.param("rig");
    return store.reportedRigs.list().some((x) => x.id === rig)
      ? c.json(modelProgress(store, rig, Date.now()))
      : c.json({ error: "not found" }, 404);
  });

  app.post("/ui/resets/:id/confirm", async (c) => {
    try {
      confirmReset(store, Number(c.req.param("id")), "owner:ui");
      await advanceResets({
        store,
        privateKeyPem: opts.privateKeyPem,
        driver: opts.driver,
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  app.post("/ui/resets/:id/cancel", (c) => {
    try {
      cancelReset(store, Number(c.req.param("id")), "owner:ui");
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  // A stuck trial the owner leaves running (goal 143): its card stays away until it is stuck again.
  app.post("/ui/trials/leave", async (c) => {
    const f = await c.req.parseBody();
    const [rig, trial, kind, since] = ["rig", "trial", "kind", "since"].map((k) =>
      String(f[k] ?? ""),
    );
    if (
      !RIG_ID.test(rig ?? "") ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(trial ?? "") ||
      // A quiet or repeating spell is known by a time; a refused page's by its address.
      !(kind === "refused"
        ? (since ?? "").length >= 1 && (since ?? "").length <= 2000
        : (kind === "quiet" || kind === "repeating") && !Number.isNaN(Date.parse(since ?? "")))
    )
      return c.text("refused: that is not a stuck trial's card", 400);
    store.liveLines.leaveTrial({
      rig: String(rig),
      trial: String(trial),
      kind: String(kind),
      since: String(since),
      by: "owner:ui",
    });
    store.auditLog.add("owner:ui", "trial_left", {
      rig,
      run: String(f.run ?? ""),
      trial,
      kind,
      since,
    });
    return c.redirect(backTo(f, "/ui"), 303);
  });

  app.post("/ui/propagate", async (c) => {
    const f = await c.req.parseBody();
    const [toRig, toRun] = String(f.target ?? "").split("|");
    try {
      propagateChampion(store, opts.privateKeyPem, {
        fromRig: String(f.rig),
        run: String(f.run),
        toRig: String(toRig),
        toRun: String(toRun),
        issuedBy: "owner:ui",
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    const target = views()
      .find((x) => x.id === toRig)
      ?.runs.find((x) => x.id === toRun);
    return c.redirect(
      target ? runHref(String(toRig), target) : `/ui/rigs/${encodeURIComponent(String(toRig))}`,
      303,
    );
  });

  app.post("/ui/rigs/:rig/restart", async (c) => {
    const rig = c.req.param("rig");
    // A rig on RunPod: RunPod's own driver, whatever THERMITE_LIFECYCLE says.
    if (opts.runpodDriver?.serves(rig)) {
      store.auditLog.add("owner:ui", "restart", { rig });
      const to = (k: "ok" | "error", m: string) =>
        c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}#pod`, 303);
      try {
        await opts.runpodDriver.restart(rig, ["harness", "supervisor"], "owner:ui");
      } catch (err) {
        return to("error", errorText(err));
      }
      return to("ok", "Restarting: the pod stops, then starts again.");
    }
    if (!opts.driver) return c.text("no deployment driver is configured", 409);
    store.auditLog.add("owner:ui", "restart", { rig });
    try {
      await opts.driver.restart(rig, ["harness", "supervisor"]);
    } catch (err) {
      return c.text(`restart failed: ${errorText(err)}`, 500);
    }
    return c.redirect(`/ui/rigs/${encodeURIComponent(rig)}`, 303);
  });

  app.post("/ui/rigs/:rig/reset", async (c) => {
    const rig = c.req.param("rig");
    const f = await c.req.parseBody();
    if (String(f.confirm ?? "") !== `reset ${rig}`)
      return c.text(`type "reset ${rig}" to confirm a full reset`, 400);
    // A rig on RunPod: its pod must run, with no stop, start or terminate under way.
    const onRunpod = runpodResetRefusal(store, rig);
    if (onRunpod)
      return c.redirect(
        `/ui/rigs/${encodeURIComponent(rig)}?error=${encodeURIComponent(onRunpod)}#pod`,
        303,
      );
    try {
      store.fullResets.create(rig, "owner:ui");
      await advanceResets({
        store,
        privateKeyPem: opts.privateKeyPem,
        driver: opts.driver,
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });
}
