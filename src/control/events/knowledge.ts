import { BUS_READ_MAX, type Bus } from "../../common/bus.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { EVENT_STREAM, type EventRead, kindSubjects } from "../../core/link/events.ts";
import type { ControlStore } from "../store/index.ts";
import { streamEvent } from "../views/index.ts";

/**
 * Once, after an upgrade of the knowledge base's reading (goal 162), the events it read before, of
 * the kinds the new reading reads anew (KnowledgeBase.kindsToReadAgain), read again from the
 * events stream, from each rig's current ledger: those the apply applied before control started
 * (at or before the store's place) and those indexed from control's events table before the apply
 * fed it (at or below the hand-over mark, kb_cursor.seq, against each message's Thermite-Seq), as
 * the apply's own indexing tells them apart. Every later event the apply indexes as it comes. A
 * run filed already stays in its folder. The apply runs it as control starts, before its first
 * page; nothing is read once the store is at the reading. An event the knowledge base can't index
 * is passed over, in control's log. Returns how many events it read again.
 */
export async function readKnowledgeAgain(
  store: ControlStore,
  bus: Pick<Bus, "read">,
): Promise<number> {
  const kb = store.kb();
  const kinds = kb.kindsToReadAgain();
  if (!kinds.length) return 0;
  const place = store.busPositions.of(EVENT_STREAM);
  const mark = kb.indexedFromTable();
  const subjects = kinds.flatMap(kindSubjects);
  const ledgers = new Map(
    store.reportedRigs.list({ withRetired: true }).map((r) => [r.id, r.ledger_id]),
  );
  const started = performance.now();
  let again = 0;
  for (let from = 1; ; ) {
    const page = await bus.read(EVENT_STREAM, { subjects, from, limit: BUS_READ_MAX });
    const due: EventRead[] = [];
    // Messages come in the stream's order, and their Thermite-Seq with it: the first one after
    // both bounds ends the read.
    let ended = false;
    for (const m of page.messages) {
      const e = streamEvent(m);
      if (!e) continue;
      const seq = e.read.seq;
      if (m.seq > place && (seq === undefined || seq > mark)) {
        ended = true;
        break;
      }
      if (ledgers.get(e.read.rig) === e.read.ledger) due.push(e.read);
    }
    store.tx(() => {
      for (const { rig, ledger, event } of due)
        try {
          // A savepoint: an event indexed in part is not kept.
          store.tx(() => kb.index({ rig, ledger }, event, { again: true }));
          again++;
        } catch (err) {
          const what = { rig, ledger, event: event.id, kind: event.kind, error: errorText(err) };
          log("control", "an event not read again into the knowledge base", what, "error");
        }
    });
    if (ended || page.done || page.next <= from) break;
    from = page.next;
  }
  kb.readAgainDone();
  const ms = Math.round(performance.now() - started);
  const level = again ? "info" : "debug";
  log("control", "the knowledge base read events again for its new reading", { again, ms }, level);
  return again;
}
