/**
 * Control's events on the message bus (goal 168, step 4): the mirror of control's events table in
 * the `EVENTS` stream, with what the bus can't carry, which ingest refuses (mirror.ts); the apply
 * of the stream, which writes what control derives from the events and hands them to control's
 * views (apply.ts); and the knowledge base's reading of the stream again after an upgrade
 * (knowledge.ts).
 */

export { APPLY_PAGE, applyState, EventsApply, type EventsApplyOptions } from "./apply.ts";
export { readKnowledgeAgain } from "./knowledge.ts";
export {
  EventsMirror,
  type EventsMirrorOptions,
  MIRROR_BATCH_BYTES,
  type MirrorStopped,
  mirrorState,
  streamEnd,
  tooLargeForBus,
} from "./mirror.ts";
