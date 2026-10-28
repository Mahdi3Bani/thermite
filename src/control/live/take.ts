import { LIVE } from "../../core/api/control/rigs.ts";
import { verifyJson } from "../../core/commands.ts";
import { type LiveBatchWire, liveBody, readLiveEntries } from "../../core/live.ts";
import type { ControlStore } from "../store/index.ts";

/** A batch of live lines as control reads it, from HTTP or from the bus. */
export type LiveBatchRead = ReturnType<typeof LiveBatchWire.parse>;

/** Why a batch is not the harness's own, in the words the route and the bus's counts use. */
export type HarnessRefusal =
  | "rig mismatch"
  | "the rig's report key is not accepted yet"
  | "live lines must be signed with the rig's pinned key"
  | "bad live signature";

/**
 * Whether a batch is the harness's own, for `rig`: the rig's, signed with the rig's pinned key.
 * The supervisor relays the harness's lines but cannot forge them. Undefined when it is; else the
 * status and words of the refusal.
 */
export function harnessRefusal(
  store: ControlStore,
  rig: string,
  b: LiveBatchRead,
): [403 | 409, HarnessRefusal] | undefined {
  if (b.rig !== rig) return [403, "rig mismatch"];
  const pinned = store.reportedRigs.key(rig).pubkey;
  if (!pinned) return [409, "the rig's report key is not accepted yet"];
  if (!b.signature || !b.rig_pubkey || b.rig_pubkey.trim() !== pinned.trim())
    return [409, "live lines must be signed with the rig's pinned key"];
  if (!verifyJson(liveBody(b), b.signature, pinned)) return [403, "bad live signature"];
  return undefined;
}

/**
 * A rig's live lines, as its supervisor posts them: the harness's, signed with the rig's pinned
 * key, and the supervisor's own, stored as unsigned. The lines control knows are kept, and the
 * rest counted in `left_out`, so one line from a newer rig never stops its live view (goal 171).
 * The status and the answer.
 */
export function takeLive(
  store: ControlStore,
  rig: string,
  raw: unknown,
): [200 | 403 | 409, Record<string, unknown>] {
  const body = LIVE.body.parse(raw);
  const b = body.batch;
  const refused = harnessRefusal(store, rig, b);
  if (refused) return [refused[0], { error: refused[1] }];
  const read = readLiveEntries(b.entries);
  let added = store.liveLines.add(rig, b.log_id, read.entries, true);
  if (body.supervisor) {
    const own = readLiveEntries(body.supervisor.entries).entries;
    added += store.liveLines.add(
      rig,
      `supervisor:${body.supervisor.log_id}`,
      own.filter((e) => e.source === "supervisor"),
      false,
    );
  }
  return [200, { added, left_out: read.unknown }];
}
