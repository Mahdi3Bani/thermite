import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ControlStore } from "../../../src/control/store/index.ts";
import {
  campaignRuns,
  EARLIER_FOLDS,
  FoldCache,
  findRun,
  keepFolds,
  rigView,
} from "../../../src/control/views/index.ts";
import { controlOnly } from "../../helpers/control-stack.ts";
import { uniforms } from "../../helpers/property.ts";
import {
  goalEvents,
  hillClimbEvents,
  report,
  type SetEvent,
  VIEW_NOW,
  VIEW_SETS,
} from "../../helpers/view-events.ts";

/**
 * The folds control keeps (goal 168). With events ingested between reads, a view read through the
 * kept folds is the view of a fresh fold of the same events; a rig's new ledger starts a new
 * fold and a retired rig loses its fold; a failed read leaves no half-done fold; and a view is the
 * caller's own: what it changes changes neither the fold nor another caller's view, and what the
 * fold never changes is frozen.
 */

const OPTS = { staleAfterMs: 600_000, now: VIEW_NOW };

/** A view of a fresh fold of the store's events now. */
const fresh = (store: ControlStore, rig: string) => new FoldCache(store).view(rig, OPTS);

/** A list's first entry, which the test needs. */
function first<T>(xs: readonly T[]): T {
  const x = xs[0];
  assert.ok(x !== undefined);
  return x;
}

/** Each event the store holds, in the order it took them, as its rig sent it. */
function sent(store: ControlStore) {
  return store.db
    .prepare(
      "select rig, ledger_id, event_id as id, at, actor, kind, subject, body from rig_event order by seq",
    )
    .all()
    .map((r) => ({
      rig: String(r.rig),
      ledger: String(r.ledger_id),
      event: {
        id: Number(r.id),
        at: String(r.at),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: r.subject === null ? null : String(r.subject),
        body: JSON.parse(String(r.body)) as unknown,
      },
    }));
}

describe("a kept fold, with events ingested between reads, gives a fresh fold's view", () => {
  for (const set of VIEW_SETS)
    test(set.name, () => {
      const source = new ControlStore(":memory:");
      set.fill(source);
      const summaries = new Map(source.reportedRigs.list().map((u) => [u.id, u.summary]));
      const events = sent(source);
      for (const seed of [1, 2]) {
        const store = new ControlStore(":memory:");
        const folds = keepFolds(store);
        const size = uniforms(seed);
        // The rigs' reports in the order they came, each cut in pieces of random sizes: a read of
        // every rig's view after each piece, kept and fresh.
        for (let at = 0; at < events.length; ) {
          const first = events[at];
          assert.ok(first);
          let n = 1;
          const most = 1 + Math.floor(size() * 30);
          while (
            n < most &&
            events[at + n]?.rig === first.rig &&
            events[at + n]?.ledger === first.ledger
          )
            n++;
          const piece = events.slice(at, at + n).map((x) => x.event);
          store.rigEvents.ingest({
            rig: first.rig,
            ledger_id: first.ledger,
            cursor: (piece[0]?.id ?? 1) - 1,
            next: piece.at(-1)?.id ?? 0,
            events: piece,
            summary: summaries.get(first.rig) ?? {},
          });
          at += n;
          for (const v of folds.views(OPTS))
            assert.deepStrictEqual(v, fresh(store, v.id), `seed ${seed}, ${v.id} at ${at}`);
        }
        // The same views as the set's own store gives, from the folds of the same events.
        for (const u of source.reportedRigs.list()) {
          const kept = rigView(store, u.id, OPTS);
          const theirs = rigView(source, u.id, OPTS);
          for (const part of ["ledger_id", "runs", "judge", "checks", "recent"] as const)
            assert.deepStrictEqual(kept?.[part], theirs?.[part], `${u.id} ${part}`);
        }
        assert.deepEqual(
          folds
            .held()
            .map((h) => [h.rig, h.ledger])
            .sort(),
          source.reportedRigs.list().map((u) => [u.id, u.ledger_id]),
        );
      }
    });
});

test("a rig's new ledger starts a new fold, and a retired rig loses its fold", () => {
  const store = new ControlStore(":memory:");
  const folds = keepFolds(store);
  assert.equal(keepFolds(store), folds, "one set of folds for a store");
  report(store, "rig-a", "ledger-1", hillClimbEvents("r-1"));
  report(store, "rig-b", "ledger-b", goalEvents("g-1"));
  assert.equal(rigView(store, "rig-a", OPTS)?.runs.length, 2);
  assert.equal(folds.views(OPTS).length, 2);
  // A full reset: the rig reports a new ledger, which starts again at event 1.
  report(store, "rig-a", "ledger-2", goalEvents("r-1").slice(0, 5));
  const v = rigView(store, "rig-a", OPTS);
  assert.deepEqual(
    v?.runs.map((r) => [r.id, r.mode, r.attempts.length]),
    [["r-1", "goal", 0]],
  );
  assert.deepStrictEqual(v, fresh(store, "rig-a"));
  assert.deepEqual(
    folds.held().map((h) => [h.rig, h.ledger]),
    [
      ["rig-a", "ledger-2"],
      ["rig-b", "ledger-b"],
    ],
  );
  // The other rig's fold is its own: unchanged by rig-a's events.
  assert.deepStrictEqual(rigView(store, "rig-b", OPTS), fresh(store, "rig-b"));
  store.retired.add("rig-b", "owner:ui");
  assert.equal(rigView(store, "rig-b", OPTS), undefined);
  assert.deepEqual(
    folds.held().map((h) => h.rig),
    ["rig-a"],
  );
  // Brought back, its fold is built again from its events.
  store.retired.bringBack("rig-b", "owner:ui");
  assert.deepStrictEqual(rigView(store, "rig-b", OPTS), fresh(store, "rig-b"));
});

test("control reads every rig's view through the folds it keeps for its store", async () => {
  const { store, api } = controlOnly();
  report(store, "rig-a", "ledger-a", hillClimbEvents("r-1").slice(0, 30));
  const first = (await (await api("GET", "/v1/rigs/rig-a/view")).json()) as { runs: unknown[] };
  assert.equal(first.runs.length, 2);
  assert.deepEqual(
    keepFolds(store)
      .held()
      .map((h) => [h.rig, h.ledger, h.seq]),
    [["rig-a", "ledger-a", 30]],
  );
  report(store, "rig-a", "ledger-a", hillClimbEvents("r-1").slice(30), {}, 30);
  const again = await (await api("GET", "/v1/rigs/rig-a/view")).json();
  assert.deepStrictEqual(again, JSON.parse(JSON.stringify(fresh(store, "rig-a"))));
});

test("a tail longer than a page of events is folded whole", () => {
  const store = new ControlStore(":memory:");
  keepFolds(store);
  const notes = (from: number, n: number): SetEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "journal_note",
      subject: "r-1",
      body: { id: from + i, by: "lane-1", kind: "observation", text: `note ${from + i}` },
    }));
  report(store, "rig-a", "l", [
    { kind: "run_created", subject: "r-1", body: { campaign: "c", mode: "goal" } },
  ]);
  assert.equal(rigView(store, "rig-a", OPTS)?.runs[0]?.journal.length, 0);
  report(store, "rig-a", "l", notes(1, 12_000), {}, 1);
  const v = rigView(store, "rig-a", OPTS);
  assert.equal(v?.runs[0]?.journal.length, 12_000);
  assert.deepStrictEqual(v, fresh(store, "rig-a"));
});

test("a read that fails leaves no half-done fold: the next read builds it again", () => {
  const store = new ControlStore(":memory:");
  const folds = keepFolds(store);
  const events = hillClimbEvents();
  report(store, "rig-h", "ledger-h", events.slice(0, 40));
  rigView(store, "rig-h", OPTS);
  report(store, "rig-h", "ledger-h", events.slice(40), {}, 40);
  // The store fails while the fold reads the new events.
  const read = store.rigEvents.after.bind(store.rigEvents);
  store.rigEvents.after = () => {
    throw new Error("disk I/O error");
  };
  assert.throws(() => rigView(store, "rig-h", OPTS), /disk I\/O error/);
  assert.deepEqual(folds.held(), []);
  store.rigEvents.after = read;
  assert.deepStrictEqual(rigView(store, "rig-h", OPTS), fresh(store, "rig-h"));
});

describe("a view is its caller's own", () => {
  const filled = () => {
    const store = new ControlStore(":memory:");
    keepFolds(store);
    const set = VIEW_SETS.find((s) => s.name === "a hill climb with promotions");
    assert.ok(set);
    set.fill(store);
    return store;
  };

  test("what a caller changes in its view changes neither the fold nor another caller's view", () => {
    const store = filled();
    const other = rigView(store, "rig-h", OPTS);
    const before = structuredClone(other);
    const mine = rigView(store, "rig-h", OPTS);
    assert.ok(mine);
    const run = mine.runs.find((r) => r.id === "h-1");
    assert.ok(run);
    // What a caller may do with what it got: sort, push, edit and delete.
    mine.runs.reverse();
    run.attempts.sort((a, b) => b.id.localeCompare(a.id));
    run.attempts.push(first(run.attempts));
    first(run.attempts).verdict = "edited";
    first(run.champion).reopened = true;
    run.timeline.pop();
    first(run.queue).title = "edited";
    first(run.messages).reads.push({
      by: "x",
      trial: null,
      at: "x",
      round: null,
    });
    for (const id of Object.keys(run.promotion_waits)) delete run.promotion_waits[id];
    for (const w of Object.values(run.at_work)) w.trial = "edited";
    run.agents.trials = -1;
    run.verdicts.edited = 9;
    run.audits.length = 0;
    mine.judge.jobs.length = 0;
    if (mine.judge.queued[0]) mine.judge.queued[0].state = "edited";
    for (const c of Object.values(mine.checks)) c.ok = false;
    // What the fold never changes is frozen and shared: a change to it throws.
    assert.throws(() => {
      first(run.journal).text = "edited";
    }, TypeError);
    assert.throws(() => {
      first(mine.recent).body.edited = true;
    }, TypeError);
    assert.throws(() => {
      first(run.trials).stopped = "edited";
    }, TypeError);
    assert.throws(() => {
      run.attempts.find((a) => a.files.length)?.files.push({ path: "x", added: 1, removed: 1 });
    }, TypeError);
    // The other caller's view, the next read and a fresh fold's view are as they were.
    assert.deepStrictEqual(other, before);
    assert.deepStrictEqual(rigView(store, "rig-h", OPTS), before);
    assert.deepStrictEqual(fresh(store, "rig-h"), before);
  });

  test("a view a caller holds does not change when the fold takes new events", () => {
    const store = filled();
    const held = rigView(store, "rig-h", OPTS);
    const before = structuredClone(held);
    report(
      store,
      "rig-h",
      "ledger-h",
      [
        { kind: "verdict", subject: "a-4", body: { verdict: "regress", delta: -0.1 } },
        { kind: "attempt_lifecycle", subject: "a-4", body: { lifecycle: "rejected" } },
        { kind: "agent_message_read", subject: "h-1", body: { message: 1, by: "lane-2" } },
        { kind: "job_leased", subject: "6", body: {} },
        { kind: "champion_reopened", subject: "h-1", body: { seq: 1 } },
        { kind: "run_status", subject: "h-1", body: { status: "running", reason: null } },
      ],
      {},
      hillClimbEvents().length,
    );
    const after = rigView(store, "rig-h", OPTS);
    assert.deepStrictEqual(held, before);
    assert.notDeepStrictEqual(after, before);
    assert.deepStrictEqual(after, fresh(store, "rig-h"));
  });
});

describe("a run is read wherever it ran (goal 170)", () => {
  /** Events as the set gives them, an hour later than its own times: a later ledger's. */
  const later = (events: SetEvent[], hours: number): SetEvent[] =>
    events.map((e, i) => ({
      ...e,
      at: new Date(VIEW_NOW - 24 * 3_600_000 + hours * 3_600_000 + i * 1000).toISOString(),
    }));
  const ids = (xs: { run: { id: string }; earlier: string | null }[]) =>
    xs.map((x) => [x.run.id, x.earlier]);

  test("from control's run registry: the rig's current ledger, an earlier one after a full reset, a retired rig's", () => {
    const store = new ControlStore(":memory:");
    const folds = keepFolds(store);
    report(store, "rig-a", "ledger-1", hillClimbEvents("r-1"));
    report(store, "rig-b", "ledger-b", goalEvents("g-1"));
    const now = findRun(store, "r-1", OPTS);
    assert.ok(now);
    assert.deepEqual([now.rig.id, now.rig.ledger_id, now.earlier], ["rig-a", "ledger-1", null]);
    const before = rigView(store, "rig-a", OPTS)?.runs.find((r) => r.id === "r-1");
    assert.deepStrictEqual(now.run, before);
    assert.equal(findRun(store, "nope", OPTS), undefined);

    // A full reset: the rig reports a new ledger. Its view has the new ledger's runs alone; the
    // old run is read from a fold of its own ledger, as it stood.
    report(store, "rig-a", "ledger-2", later(goalEvents("g-2"), 1));
    assert.deepEqual(
      rigView(store, "rig-a", OPTS)?.runs.map((r) => r.id),
      ["g-2"],
    );
    const reset = findRun(store, "r-1", OPTS);
    assert.ok(reset);
    assert.deepEqual(
      [reset.rig.id, reset.rig.ledger_id, reset.earlier],
      ["rig-a", "ledger-1", "reset"],
    );
    assert.deepStrictEqual(reset.run, before);
    // No report of the rig is the earlier ledger's: its view has none of the newer one's.
    assert.deepEqual(reset.rig.summary, {});
    assert.deepEqual(folds.heldEarlier(), [{ rig: "rig-a", ledger: "ledger-1" }]);
    // The rig's own fold is its current ledger's, as before.
    assert.deepEqual(
      folds.held().map((h) => [h.rig, h.ledger]),
      [["rig-a", "ledger-2"]],
    );

    // A retired rig: its runs stay readable, as they stood.
    const g1 = findRun(store, "g-1", OPTS);
    store.retired.add("rig-b", "owner:ui");
    assert.equal(rigView(store, "rig-b", OPTS), undefined);
    const retired = findRun(store, "g-1", OPTS);
    assert.ok(retired && g1);
    assert.deepEqual([retired.rig.id, retired.earlier], ["rig-b", "retired"]);
    assert.deepStrictEqual(retired.run, g1.run);

    // A campaign's runs, newest first, wherever they ran; a fresh fold reads the same.
    assert.deepEqual(ids(campaignRuns(store, "speed", OPTS)), [
      ["r-1", "reset"],
      ["h-0", "reset"],
    ]);
    assert.deepEqual(ids(campaignRuns(store, "decoder", OPTS)), [
      ["g-2", null],
      ["g-1", "retired"],
    ]);
    const fresh = new FoldCache(store);
    assert.deepStrictEqual(
      fresh.campaignRuns("decoder", OPTS),
      campaignRuns(store, "decoder", OPTS),
    );
    assert.deepStrictEqual(fresh.run("r-1", OPTS), reset);
  });

  test(`control keeps the folds of the ${EARLIER_FOLDS} earlier ledgers read last; one read before them is built again`, () => {
    const store = new ControlStore(":memory:");
    const folds = keepFolds(store);
    const n = EARLIER_FOLDS + 2;
    for (let i = 1; i <= n; i++)
      report(store, "rig-a", `ledger-${i}`, later(goalEvents(`g-${i}`).slice(0, 4), i));
    // Each run before the newest ledger's is an earlier one.
    for (let i = 1; i < n; i++) assert.equal(findRun(store, `g-${i}`, OPTS)?.earlier, "reset");
    const kept = folds.heldEarlier();
    assert.equal(kept.length, EARLIER_FOLDS);
    assert.deepEqual(
      kept.map((k) => k.ledger),
      Array.from({ length: EARLIER_FOLDS }, (_, i) => `ledger-${n - EARLIER_FOLDS + i}`),
    );
    // The first, read longest ago, is built again when it is read, and goes to the end.
    const first = findRun(store, "g-1", OPTS);
    assert.deepStrictEqual(first, new FoldCache(store).run("g-1", OPTS));
    assert.equal(folds.heldEarlier().at(-1)?.ledger, "ledger-1");
    assert.equal(folds.heldEarlier().length, EARLIER_FOLDS);
  });
});
