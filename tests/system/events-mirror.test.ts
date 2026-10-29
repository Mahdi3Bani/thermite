import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInfo } from "../../src/common/build-info.ts";
import type { Outgoing } from "../../src/common/bus.ts";
import { EventsMirror, MIRROR_BATCH_BYTES } from "../../src/control/events/index.ts";
import { type Intake, takeReport } from "../../src/control/ingest.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import {
  EVENT_HEADERS,
  EVENT_MAX_BYTES,
  EVENT_STREAM,
  EVENT_STREAM_CONFIG,
  readEventMessage,
} from "../../src/core/link/events.ts";
import { readReport } from "../../src/core/link/report.ts";
import { asMessage, FakeBus } from "../helpers/fake-bus.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { appendOther } from "../helpers/kinds.ts";

/**
 * Control's events table mirrored to the message bus's `EVENTS` stream (goal 168, step 4): the
 * move of the rows control holds at start, then the rows ingest stores, by HTTP or by the bus.
 * Every row once, in the table's order, on its subject, with its headers, through a stop part
 * way, a lost ack, a batch stored late and a full store; a row too large stops the mirror, and
 * ingest refuses a page with one.
 */

type Ev = {
  id: number;
  kind: string;
  run?: string | null;
  subject?: string | null;
  body?: unknown;
};

/** Stores a page of a rig's ledger through the store's ingest, as a report taken does. */
function page(store: ControlStore, rig: string, ledger: string, events: Ev[]): void {
  const first = events[0]?.id ?? 1;
  store.rigEvents.ingest({
    rig,
    ledger_id: ledger,
    cursor: first - 1,
    next: events.at(-1)?.id ?? first,
    generated_at: new Date().toISOString(),
    summary: {},
    events: events.map((e) => ({
      id: e.id,
      at: new Date(Date.UTC(2026, 9, 29, 4, 0, 0, e.id)).toISOString(),
      actor: "harness",
      kind: e.kind,
      subject: e.subject ?? null,
      body: e.body ?? { n: e.id },
      run: e.run ?? null,
    })),
  });
}

/** `n` events of one rig's ledger, from `from`, journal notes of no run. */
const notes = (from: number, n: number): Ev[] =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, kind: "journal_note" }));

/** A bus with the events stream made, and a mirror of `store` on it that waits a little. */
async function mirrorOf(store: ControlStore, bus = new FakeBus()) {
  await bus.makeStream(EVENT_STREAM_CONFIG);
  return { bus, mirror: new EventsMirror({ store, bus, retryMs: 5 }) };
}

const onStream = (bus: FakeBus) => bus.kept.filter((k) => k.stream === EVENT_STREAM);

/** Waits until `ok` holds, or fails after two seconds. */
async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`not in 2 s: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The stream holds every row of the table once, in the table's order: each message, read back,
 * is its row, with the rig, the ledger and the row's seq in its headers and no message id.
 */
function assertMirrored(store: ControlStore, bus: FakeBus): void {
  const rows = store.rigEvents.inOrder(0, 100_000);
  const kept = onStream(bus);
  assert.equal(kept.length, rows.length, "a message for each row");
  for (const [i, row] of rows.entries()) {
    const k = kept[i];
    assert.ok(k);
    const read = readEventMessage(asMessage(k));
    assert.deepEqual(
      [read.rig, read.ledger, read.seq, read.report],
      [row.rig, row.ledger_id, row.seq, undefined],
    );
    assert.deepEqual(read.event, { ...row.event, body: JSON.parse(row.body), run: row.run });
    assert.equal(k.id, undefined, "no message id");
    assert.equal(k.headers[EVENT_HEADERS.seq], String(row.seq));
  }
}

describe("control's events table, mirrored to the events stream", () => {
  test("the move takes every row, in order, on its subject; then the rows ingest stores follow", async () => {
    const store = new ControlStore(":memory:");
    // Two rigs, rig-a in two ledgers (a full reset between them), three runs, and rig-b's event
    // of a run the registry gives rig-a.
    page(store, "rig-a", "la-1", [
      { id: 1, kind: "run_created", subject: "sort-1", run: "sort-1", body: { campaign: "c-1" } },
      { id: 2, kind: "trial_started", subject: "t-1", run: "sort-1" },
      { id: 3, kind: "experiment_added", subject: "sort-1", run: "sort-1" },
      { id: 4, kind: "journal_note" },
    ]);
    page(store, "rig-b", "lb-1", [
      { id: 1, kind: "run_created", subject: "sort-2", run: "sort-2", body: { campaign: "c-2" } },
      { id: 2, kind: "trial_finished", subject: "t-2", run: "sort-2" },
      { id: 3, kind: "dev_run", run: "sort-1" },
    ]);
    page(store, "rig-a", "la-2", [
      { id: 1, kind: "rig_check_started" },
      { id: 2, kind: "trial_started", subject: "t-3", run: "sort-1" },
    ]);
    const { bus, mirror } = await mirrorOf(store);
    await mirror.start();
    assertMirrored(store, bus);
    assert.deepEqual(
      onStream(bus).map((k) => k.subject),
      [
        "thermite.run.sort-1.ev.run_created",
        "thermite.run.sort-1.ev.trial_started",
        "thermite.run.sort-1.queue.added",
        "thermite.rig.rig-a.ev.journal_note",
        "thermite.run.sort-2.ev.run_created",
        "thermite.run.sort-2.ev.trial_finished",
        // A run the registry gives another rig: on the rig's own subject.
        "thermite.rig.rig-b.ev.dev_run",
        "thermite.rig.rig-a.ev.rig_check_started",
        "thermite.run.sort-1.ev.trial_started",
      ],
    );
    assert.equal(mirror.published, 9);
    // The follow: a page the store's ingest keeps, then one a rig's harness signed, taken as the
    // ingest route takes it.
    page(store, "rig-b", "lb-1", [{ id: 4, kind: "journal_note", run: "sort-2" }]);
    await until(() => onStream(bus).length === 10, "the stored page on the stream");
    const harness = makeHarnessEnv("rig-c");
    for (let i = 0; i < 3; i++) appendOther(harness.service.ledger, "t", "step", null, { i });
    const intake: Intake = { store, control: buildInfo(), requireKeyAcceptance: false };
    const signed = harness.service.snapshot(0, 100);
    const [status] = takeReport(intake, "rig-c", readReport(signed));
    assert.equal(status, 200);
    const rows = store.rigEvents.lastSeq();
    await until(() => onStream(bus).at(-1)?.headers[EVENT_HEADERS.seq] === String(rows), "rig-c");
    assertMirrored(store, bus);
    assert.ok(onStream(bus).some((k) => k.subject === "thermite.rig.rig-c.ev.step"));
    // Each batch named the stream's last place it expected: 0 for the first.
    const expected = onStream(bus).map((k) => k.headers["Nats-Expected-Last-Sequence"]);
    assert.equal(expected[0], "0");
    mirror.close();
  });

  test("stopped part way, then started again: every row once, in order", async () => {
    const store = new ControlStore(":memory:");
    page(store, "rig-a", "l-1", notes(1, 1000));
    page(store, "rig-a", "l-1", notes(1001, 1000));
    page(store, "rig-a", "l-1", notes(2001, 500));
    const { bus, mirror } = await mirrorOf(store);
    // The server goes away after the first two batches.
    bus.failAfter = 2;
    void mirror.start();
    await until(() => mirror.waiting !== null, "the mirror waits");
    assert.equal(onStream(bus).length, 2000);
    assert.match(String(mirror.waiting), /no ack|no answer/);
    mirror.close();
    await mirror.nudge();
    // Control starts again, and the server is back: it goes on after the stream's last row.
    bus.failing = false;
    bus.failAfter = undefined;
    const again = new EventsMirror({ store, bus, retryMs: 5 });
    await again.start();
    assertMirrored(store, bus);
    assert.equal(again.published, 500);
    again.close();
  });

  test("a batch stored whose ack was lost is not published again", async () => {
    const store = new ControlStore(":memory:");
    page(store, "rig-a", "l-1", notes(1, 1000));
    page(store, "rig-a", "l-1", notes(1001, 500));
    const { bus, mirror } = await mirrorOf(store);
    bus.loseAck = true;
    await mirror.start();
    assertMirrored(store, bus);
    // The lost ack's batch counts as not published; the stream holds it once all the same.
    assert.equal(mirror.published, 500);
    assert.equal(mirror.waiting, null);
    mirror.close();
  });

  test("a batch the server stores late, after its publish failed, refuses the next, which goes on after it", async () => {
    const store = new ControlStore(":memory:");
    page(store, "rig-a", "l-1", notes(1, 1500));
    const bus = new FakeBus();
    await bus.makeStream(EVENT_STREAM_CONFIG);
    // The first publish fails with nothing stored; the batch lands just before the next publish.
    const publish = bus.publishBatch.bind(bus);
    let calls = 0;
    let late: Outgoing[] = [];
    bus.publishBatch = async (batch) => {
      calls++;
      if (calls === 1) {
        late = [...batch];
        throw new Error("TimeoutError: no ack from the server");
      }
      if (calls === 2) await publish(late);
      return publish(batch);
    };
    const mirror = new EventsMirror({ store, bus, retryMs: 5 });
    await mirror.start();
    assertMirrored(store, bus);
    assert.equal(calls, 3, "the failed one, the refused one, and the one after the late batch");
    mirror.close();
  });

  test("a full store: the mirror waits, says why, and goes on when there is room", async () => {
    const store = new ControlStore(":memory:");
    page(store, "rig-a", "l-1", notes(1, 30));
    const { bus, mirror } = await mirrorOf(store);
    bus.full = true;
    const done = mirror.start();
    await until(() => mirror.waiting !== null, "the mirror waits");
    assert.match(String(mirror.waiting), /the bus's store is full: insufficient resources/);
    assert.equal(onStream(bus).length, 0);
    bus.full = false;
    await done;
    assert.equal(mirror.waiting, null);
    assertMirrored(store, bus);
    mirror.close();
  });

  test("a batch holds at most the bytes of one message", async () => {
    const store = new ControlStore(":memory:");
    const third = "x".repeat(Math.floor(MIRROR_BATCH_BYTES / 3));
    page(
      store,
      "rig-a",
      "l-1",
      notes(1, 7).map((e) => ({ ...e, body: { text: third } })),
    );
    const { bus, mirror } = await mirrorOf(store);
    let batches = 0;
    const publish = bus.publishBatch.bind(bus);
    bus.publishBatch = (batch) => {
      batches++;
      return publish(batch);
    };
    await mirror.start();
    assertMirrored(store, bus);
    // Two of a third each fit in a batch, not three (their envelopes take a little more).
    assert.equal(batches, 4);
    mirror.close();
  });

  test("a stream it can't go on from stops the mirror, saying why", async () => {
    const store = new ControlStore(":memory:");
    page(store, "rig-a", "l-1", notes(1, 2));
    const stoppedOn = async (headers: Record<string, string>) => {
      const { bus, mirror } = await mirrorOf(store);
      await bus.publish("thermite.rig.rig-a.ev.journal_note", "{}", { id: "x", headers });
      await mirror.start();
      assert.equal(onStream(bus).length, 1, "nothing published");
      mirror.close();
      return mirror.stopped;
    };
    // The stream holds rows past the table's end: control's store is older than the stream.
    const ahead = await stoppedOn({ [EVENT_HEADERS.seq]: "5" });
    assert.deepEqual([ahead?.rig, ahead?.seq], [null, null]);
    assert.match(
      String(ahead?.error),
      /the stream holds rows to seq 5, past the table's last, 2: control's store is older/,
    );
    // Its last message names no place in control's table.
    const unplaced = await stoppedOn({});
    assert.match(String(unplaced?.error), /last message \(place 1\) has no Thermite-Seq/);
  });

  test("a row too large for the bus stops the mirror there, and ingest refuses a page with one", async () => {
    const store = new ControlStore(":memory:");
    // A row control stored before ingest refused such pages.
    page(store, "rig-a", "l-1", [
      { id: 1, kind: "journal_note" },
      { id: 2, kind: "journal_note", body: { text: "x".repeat(EVENT_MAX_BYTES) } },
      { id: 3, kind: "journal_note" },
    ]);
    const { bus, mirror } = await mirrorOf(store);
    await mirror.start();
    assert.equal(onStream(bus).length, 1, "the row before it");
    const stopped = mirror.stopped;
    assert.ok(stopped);
    assert.deepEqual([stopped.rig, stopped.ledger, stopped.seq], ["rig-a", "l-1", 2]);
    assert.ok(Number(stopped.bytes) > EVENT_MAX_BYTES);
    assert.match(stopped.error, /more than a message on the bus holds \(8388608 bytes/);
    // It is tried again only when control starts again: a new row changes nothing.
    page(store, "rig-a", "l-1", [{ id: 4, kind: "journal_note" }]);
    await mirror.nudge();
    assert.equal(onStream(bus).length, 1);
    mirror.close();

    // Ingest refuses a signed page with an event too large for the bus, before it stores anything.
    const fresh = new ControlStore(":memory:");
    const harness = makeHarnessEnv("rig-a");
    appendOther(harness.service.ledger, "t", "step", null, { i: 1 });
    appendOther(harness.service.ledger, "t", "step", null, { text: "y".repeat(EVENT_MAX_BYTES) });
    const intake: Intake = { store: fresh, control: buildInfo(), requireKeyAcceptance: false };
    const [status, answer] = takeReport(
      intake,
      "rig-a",
      readReport(harness.service.snapshot(0, 10)),
    );
    assert.equal(status, 409);
    assert.match(
      (answer as { error: string }).error,
      /^event \d+ \(step\) is too large for the message bus: it is \d+ bytes, more than a message on the bus holds/,
    );
    assert.equal(fresh.rigEvents.lastSeq(), 0, "no event stored");
    assert.equal(fresh.reportedRigs.key("rig-a").pubkey, null, "no key pinned");
    assert.equal(fresh.reportedRigs.reportRow("rig-a"), undefined, "no report noted");
    assert.deepEqual(
      fresh.auditLog
        .list(10)
        .filter((a) => a.action === "report_refused")
        .map((a) => (a.body as { reason: string }).reason),
      [(answer as { error: string }).error],
    );
  });
});
