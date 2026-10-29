/**
 * Control's events on the message bus (goal 168, step 4): the mirror of control's events table in
 * the `EVENTS` stream, with what the bus can't carry, which ingest refuses (mirror.ts); and the
 * apply of the stream, which writes what control derives from the events (apply.ts).
 */

export { APPLY_PAGE, applyState, EventsApply, type EventsApplyOptions } from "./apply.ts";
export {
  EventsMirror,
  type EventsMirrorOptions,
  MIRROR_BATCH_BYTES,
  type MirrorStopped,
  mirrorState,
  streamEnd,
  tooLargeForBus,
} from "./mirror.ts";
