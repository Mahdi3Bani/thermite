import { z } from "zod";
import { verifyJson } from "../core/commands.ts";
import { LiveBatchWire, liveBody, readLiveEntries } from "../core/live.ts";
import type { ControlStore } from "./store.ts";

const LiveIn = z.object({
  batch: LiveBatchWire,
  supervisor: z
    .object({ log_id: z.string().min(1).max(64), entries: z.array(z.unknown()).max(500) })
    .optional(),
});

/**
 * A rig's live lines, as its supervisor posts them: the harness's, signed with the rig's pinned
 * key (the supervisor relays them but cannot forge them), and the supervisor's own, stored as
 * unsigned. The lines control knows are kept, and the rest counted in `left_out`, so one line
 * from a newer rig never stops its live view (goal 171). The status and the answer.
 */
export function takeLive(
  store: ControlStore,
  rig: string,
  raw: unknown,
): [200 | 403 | 409, Record<string, unknown>] {
  const body = LiveIn.parse(raw);
  const b = body.batch;
  if (b.rig !== rig) return [403, { error: "rig mismatch" }];
  const pinned = store.rigKey(rig).pubkey;
  if (!pinned) return [409, { error: "the rig's report key is not accepted yet" }];
  if (!b.signature || !b.rig_pubkey || b.rig_pubkey.trim() !== pinned.trim())
    return [409, { error: "live lines must be signed with the rig's pinned key" }];
  if (!verifyJson(liveBody(b), b.signature, pinned)) return [403, { error: "bad live signature" }];
  const read = readLiveEntries(b.entries);
  let added = store.addLive(rig, b.log_id, read.entries, true);
  if (body.supervisor) {
    const own = readLiveEntries(body.supervisor.entries).entries;
    added += store.addLive(
      rig,
      `supervisor:${body.supervisor.log_id}`,
      own.filter((e) => e.source === "supervisor"),
      false,
    );
  }
  return [200, { added, left_out: read.unknown }];
}
