import { inBackground } from "../background.ts";
import { issueCommand } from "../issue/index.ts";
import type { ControlParts } from "../parts.ts";
import { updateRigImages } from "./images.ts";
import { applyResize } from "./resize.ts";
import { IMAGES_REASON, RESIZE_REASON, rigWork, undrain } from "./rigs.ts";

/** How often the drain watch looks at a draining rig's report by default. */
const DRAIN_WATCH_MS = 10_000;

/** The owner calls the update off: the rig goes back to work on its images. */
export function cancelDrain(
  parts: ControlParts,
  rig: string,
  by: string,
): { ok: string } | { error: string } {
  const { store } = parts;
  const r = store.clusters.rig(rig);
  if (r?.status !== "draining") return { error: `${rig} is not draining.` };
  undrain(parts, rig, by);
  store.clusters.setRigStatus(rig, "running");
  if (r.pending) {
    store.rigHistory.add(
      rig,
      "drain",
      true,
      "called off: the rig goes back to work with its GPUs, CPUs and memory as they were",
    );
    return { ok: `${rig} goes back to work with its GPUs, CPUs and memory as they were.` };
  }
  store.rigHistory.add(rig, "drain", true, "called off: the rig goes back to work on its images");
  return { ok: `${rig} goes back to work on its images.` };
}

/**
 * A draining rig's pods restart once its report says nothing runs any more (goal 079), on new
 * images or with the new size it waits for (goal 118); its report is looked at every `everyMs`.
 * A rig whose change is still being applied is not applied again. The watch never keeps control
 * from exiting.
 */
export function watchDrains(parts: ControlParts, everyMs = DRAIN_WATCH_MS): void {
  const { store } = parts;
  /**
   * A harness keeps its drain in memory only: one that started again since it took the drain
   * reports none, and goes back to work. Asked again, it drains again: once the last ask is taken
   * and two reports after it say no drain. One is not enough: a report's summary can be read
   * before the drain took effect and reach control after the ask was taken.
   */
  const undrained = new Map<string, { ask: string; seen: string }>();
  const redrain = (rig: string) => {
    const last = store.commands.latest(rig, "drain_rig", 1)[0];
    if (last?.payload.drain !== true || last.status === "pending" || !last.acked_at) return;
    const seen = store.reportedRigs.list().find((x) => x.id === rig)?.last_seen;
    if (!seen || Date.parse(seen) <= Date.parse(last.acked_at)) return;
    const first = undrained.get(rig);
    if (first?.ask !== last.id) {
      undrained.set(rig, { ask: last.id, seen });
      return;
    }
    if (first.seen === seen) return;
    undrained.delete(rig);
    issueCommand(store, parts.privateKeyPem, {
      rig,
      kind: "drain_rig",
      payload: {
        drain: true,
        reason: store.clusters.rig(rig)?.pending ? RESIZE_REASON : IMAGES_REASON,
      },
      issuedBy: "control:drain",
    });
    store.rigHistory.add(
      rig,
      "drain",
      true,
      "its harness started again and was not draining: asked again",
    );
  };
  const moving = new Set<string>();
  const watch = setInterval(() => {
    for (const r of store.clusters.rigs().filter((x) => x.status === "draining")) {
      if (moving.has(r.rig)) continue;
      const w = rigWork(parts, r.rig);
      if (w && w.draining === null) redrain(r.rig);
      else undrained.delete(r.rig);
      if (!w || w.draining === null || w.trials > 0 || w.judge_jobs > 0) continue;
      store.rigHistory.add(r.rig, "drain", true, "nothing runs any more: its pods restart now");
      moving.add(r.rig);
      const move = r.pending
        ? applyResize(parts, r.rig, r.pending, "control:drain")
        : updateRigImages(parts, r.rig, "control:drain", { wait: false });
      void inBackground(store, "cluster", r.rig, r.pending ? "resources" : "images", move).finally(
        () => moving.delete(r.rig),
      );
    }
  }, everyMs);
  watch.unref?.();
}
