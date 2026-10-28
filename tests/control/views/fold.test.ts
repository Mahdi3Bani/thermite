import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ControlStore } from "../../../src/control/store.ts";
import { RigFold } from "../../../src/control/views/fold/index.ts";
import { readRig, rigInputs } from "../../../src/control/views/rig.ts";
import { rigEvents, rigView, type StoredEvent } from "../../../src/control/views.ts";
import { uniforms } from "../../helpers/property.ts";
import { VIEW_NOW, VIEW_SETS } from "../../helpers/view-events.ts";

/**
 * A rig's view is a fold of its events, then a read (goal 125, T8; goal 168). For each set of
 * events the control tests build, rigView's view (one fold of every event) is the view of a fold
 * applied one event at a time with a read after each, and of a fold applied in pages of random
 * sizes, with a read after each page. A read changes nothing the fold holds: after each event, a
 * fold that was read holds what a fold of the same events that was never read holds, and reads
 * the same.
 */

const OPTS = { staleAfterMs: 600_000, now: VIEW_NOW };

for (const set of VIEW_SETS) {
  describe(set.name, () => {
    const store = new ControlStore(":memory:");
    set.fill(store);
    for (const u of store.rigs()) {
      const events = rigEvents(store, u.id, u.ledger_id);
      const inputs = rigInputs(store, u, OPTS);
      const whole = rigView(store, u.id, OPTS);

      test(`${u.id}: one event at a time, with a read after each, gives rigView's view`, () => {
        assert.ok(events.length > 0 && whole);
        const f = new RigFold();
        const unread = new RigFold();
        for (const e of events) {
          f.apply(e);
          unread.apply(e);
          const read = readRig(f.state(), inputs);
          assert.deepStrictEqual(f.state(), unread.state(), `the fold after event ${e.seq}`);
          assert.deepStrictEqual(read, readRig(unread.state(), inputs), `the read of ${e.seq}`);
        }
        assert.deepStrictEqual(readRig(f.state(), inputs), whole);
      });

      test(`${u.id}: pages of random sizes, with a read after each, give rigView's view`, () => {
        for (const seed of [1, 2, 3]) {
          const size = uniforms(seed);
          const f = new RigFold();
          for (let at = 0; at < events.length; ) {
            const n = 1 + Math.floor(size() * 60);
            for (const e of events.slice(at, at + n)) f.apply(e);
            readRig(f.state(), inputs);
            at += n;
          }
          assert.deepStrictEqual(readRig(f.state(), inputs), whole, `seed ${seed}`);
        }
      });
    }
  });
}

test("a kind such as constructor or toString is only an event of its run's timeline", () => {
  const event = (seq: number, kind: string, subject: string | null): StoredEvent => ({
    seq,
    ledger_id: "l",
    id: seq,
    at: new Date(VIEW_NOW + seq).toISOString(),
    actor: "harness",
    kind,
    subject,
    body: subject ? {} : { run: "p-1" },
  });
  // The fold finds each kind's handler in a map: a name every object has finds none.
  const kinds = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];
  const f = new RigFold();
  f.apply(event(1, "run_created", "p-1"));
  for (const [i, k] of kinds.entries()) f.apply(event(i + 2, k, i % 2 ? null : "p-1"));
  const [run] = f.state().runs;
  assert.deepEqual(
    run?.timeline.map((e) => e.kind),
    ["run_created", ...kinds],
  );
  assert.equal(f.state().runs.length, 1);
});

test("after a reset, a rig's view folds only its new ledger's events", () => {
  const set = VIEW_SETS.find((s) => s.name === "a reset to a new ledger");
  assert.ok(set);
  const store = new ControlStore(":memory:");
  set.fill(store);
  const v = rigView(store, "rig-a", OPTS);
  assert.equal(v?.ledger_id, "ledger-2");
  assert.deepEqual(
    v?.runs.map((r) => [r.id, r.mode, r.attempts.length]),
    [["r-1", "goal", 0]],
  );
  assert.ok(v?.recent.every((e) => e.ledger_id === "ledger-2"));
  // The old ledger's events are still in the store: only the view leaves them out.
  assert.ok(rigEvents(store, "rig-a", "ledger-1").length > 100);
});
