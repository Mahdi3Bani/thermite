import { EventsApply, EventsMirror } from "../../src/control/events/index.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { FakeBus } from "./fake-bus.ts";

/**
 * Control's store as control's main makes it (goal 168, step 4): on its message bus, here the fake
 * one, with the mirror of its events table in the events stream and the apply of that stream,
 * which writes what control derives from the events (a command's outcome as the harness gave it,
 * a model call's usage, the knowledge base). A test that takes a report and then reads what is
 * derived from it waits for applied() first; what control's views fold from the table needs no
 * wait.
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
