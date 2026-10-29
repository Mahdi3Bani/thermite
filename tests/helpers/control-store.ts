import { BUS_READ_MAX } from "../../src/common/bus.ts";
import { EventsApply, EventsMirror } from "../../src/control/events/index.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import {
  FoldCache,
  keepFolds,
  type RawEvent,
  rigEventsPage,
  type StoredEvent,
  streamEvent,
} from "../../src/control/views/index.ts";
import { foldEvent, readLedger } from "../../src/control/views/stream.ts";
import { EVENT_STREAM } from "../../src/core/link/events.ts";
import { FakeBus } from "./fake-bus.ts";

/**
 * Control's store as control's main makes it (goal 168, step 4): on its message bus, here the fake
 * one, with the mirror of its events table in the events stream and the apply of that stream,
 * which writes what control derives from the events (a command's outcome as the harness gave it,
 * a model call's usage, the knowledge base) and hands them to control's views. A test that takes
 * a report and then reads what is derived from it, or a view, waits for applied() first.
 */

interface OnBus {
  bus: FakeBus;
  mirror: EventsMirror;
  apply: EventsApply;
  /** The apply's check of the store's place, then the mirror's start, as main.ts runs them. */
  started: Promise<void>;
}

const onBus = new WeakMap<ControlStore, OnBus>();

/**
 * A store at `path` (in memory unless given) on `bus` (a fake bus of its own unless given), with
 * the mirror and the apply started as control's main starts them.
 */
export function controlStore(path = ":memory:", bus = new FakeBus()): ControlStore {
  const store = new ControlStore(path);
  const apply = new EventsApply({ store, bus, retryMs: 5 });
  const mirror = new EventsMirror({
    store,
    bus,
    retryMs: 5,
    published: () => void apply.nudge(),
  });
  const started = apply.start().then(() => (apply.stopped ? undefined : mirror.start()));
  onBus.set(store, { bus, mirror, apply, started });
  return store;
}

/** The store's bus, its mirror and its apply, for a test that looks at them. */
export function busOf(store: ControlStore): OnBus {
  const o = onBus.get(store);
  if (!o) throw new Error("a store controlStore() did not make has no bus");
  return o;
}

/**
 * Waits until the apply has applied every event the store took so far: the mirror has copied
 * them to the stream, and the apply has applied the stream to its end.
 */
export async function applied(store: ControlStore): Promise<void> {
  const o = busOf(store);
  await o.started;
  await o.mirror.nudge();
  await o.apply.nudge();
}

/** Stops the store's mirror and apply, for a test that opens the same store again. */
export function closeBus(store: ControlStore): void {
  const o = busOf(store);
  o.mirror.close();
  o.apply.close();
}

/**
 * A rig's events as control holds them, oldest first, under the current names, read from its
 * events stream as `GET /v1/rigs/<rig>/events` reads them (each one's seq is its place there),
 * once the store's mirror has copied what it took.
 */
export async function heldEvents(store: ControlStore, rig: string): Promise<RawEvent[]> {
  await applied(store);
  return await rigEventsPage(store, { rig, after: 0, limit: BUS_READ_MAX });
}

/**
 * Folds of the store's events made now, in one pass over its events stream from the first
 * message, as control's start makes them: what the folds control kept must give the same views
 * as.
 */
export async function freshFolds(store: ControlStore): Promise<FoldCache> {
  await applied(store);
  const { bus } = busOf(store);
  const folds = new FoldCache(store, bus);
  for (let from = 1; ; ) {
    const read = await bus.read(EVENT_STREAM, { from, limit: BUS_READ_MAX });
    if (read.next <= from) return folds;
    folds.take(
      read.messages.flatMap((m) => streamEvent(m) ?? []),
      read.next - 1,
    );
    if (read.done) return folds;
    from = read.next;
  }
}

/**
 * A rig ledger's events as its fold takes them (views/stream.ts), oldest first: from the store's
 * events stream, once the store's mirror has copied what it took.
 */
export async function foldedEvents(
  store: ControlStore,
  rig: string,
  ledger: string,
): Promise<StoredEvent[]> {
  await applied(store);
  const out: StoredEvent[] = [];
  for (let from = 1; ; ) {
    const subjects = keepFolds(store).subjectsOf(rig);
    const page = await readLedger(busOf(store).bus, { rig, ledger, subjects, from });
    for (const e of page.events) {
      const stored = foldEvent(e);
      if (stored) out.push(stored);
    }
    if (page.done || page.next <= from) return out;
    from = page.next;
  }
}
