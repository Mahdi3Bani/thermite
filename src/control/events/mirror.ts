import { BUS_BATCH_MAX, BUS_RETRY_MS, type Bus, type Outgoing } from "../../common/bus.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import {
  EVENT_HEADERS,
  EVENT_MAX_BYTES,
  EVENT_STREAM,
  EVENT_STREAM_CONFIG,
  type EventMessage,
  eventFits,
  eventMessage,
} from "../../core/link/events.ts";
import type { ReportEvent } from "../../core/link/report.ts";
import type { ControlStore, StoredEvent } from "../store/index.ts";

/**
 * Control's events table on the message bus (goal 168, step 4): the `EVENTS` stream holds every
 * row of control's table of rig events, in the table's order, each on its subject as the rig
 * recorded it (core/link/events.ts), with its place in the table (`Thermite-Seq`). The mirror goes
 * on after the Thermite-Seq of the stream's last message: at control's start, from there to the
 * table's end (the move of the events control had before), and then each time ingest stores new
 * rows. It is the stream's one writer, one turn at a time. The apply of the stream (apply.ts)
 * writes what control derives from the events; control's pages still read the table.
 */

/**
 * How many bytes of events one batch holds at most: what one message may hold, so that a batch,
 * which the server holds until its last message, weighs no more than a report's page on the bus.
 * A row alone always fits.
 */
export const MIRROR_BATCH_BYTES = EVENT_MAX_BYTES;
/** While the mirror moves many rows, it logs how far it got every this many. */
const MOVE_LOG_ROWS = 100_000;
/** NATS's header that has a publish stored only when the stream's last place is this one. */
const EXPECTED_LAST_HEADER = "Nats-Expected-Last-Sequence";
/** The server's code for a store that is full: it refuses every publish, until it has room. */
const STORE_FULL = 10023;

/** Why the mirror stopped: a row the bus can't carry, or a stream it can't go on from. */
export interface MirrorStopped {
  /** The row's rig, ledger and place in the table; null for a stream it can't go on from. */
  rig: string | null;
  ledger: string | null;
  seq: number | null;
  /** The row's event as a message's data, in bytes; null when its size is not what stopped it. */
  bytes: number | null;
  error: string;
}

/**
 * Whether a run's event goes on its run's subject: the run registry gives the run to the rig that
 * reported it, or to no rig yet. A run a rig created is its own from its `run_created` on, which
 * ingest registers before this copy reads the registry; so every event of a run a page creates goes
 * on the run's subject, its `run_created` too. A run the registry gives only other rigs is not the
 * rig's: its event goes on the rig's own subject.
 */
function isTheRigsRun(rig: string, rigsOfRun: readonly string[]): boolean {
  return rigsOfRun.length === 0 || rigsOfRun.includes(rig);
}

/** A row as a message on the bus, or why the bus can't carry it. */
type OnBus = { message: EventMessage; bytes: number } | { error: string; bytes: number | null };

/** An event as a message on the bus, or why the bus can't carry it: too large, or a bad name. */
function onBus(o: {
  rig: string;
  ledger: string;
  event: ReportEvent;
  runIsTheRigs: boolean;
  seq?: number | undefined;
}): OnBus {
  let message: EventMessage;
  try {
    message = eventMessage(o);
  } catch (err) {
    return { error: errorText(err), bytes: null };
  }
  const bytes = Buffer.byteLength(message.data);
  if (!eventFits(bytes))
    return {
      error: `it is ${bytes} bytes, more than a message on the bus holds (${EVENT_MAX_BYTES} bytes with its headers)`,
      bytes,
    };
  return { message, bytes };
}

/**
 * Why the bus can't carry an event of a report's page, in words, or undefined when it can carry
 * them all. Control keeps every event it takes on the bus too, so ingest refuses a page with one
 * too large before it stores anything of it.
 */
export function tooLargeForBus(r: {
  rig: string;
  ledger_id: string;
  events: readonly ReportEvent[];
}): string | undefined {
  for (const event of r.events) {
    const m = onBus({ rig: r.rig, ledger: r.ledger_id, event, runIsTheRigs: false });
    if (m.bytes !== null && "error" in m)
      return `event ${event.id} (${event.kind}) is too large for the message bus: ${m.error}`;
  }
  return undefined;
}

export interface EventsMirrorOptions {
  store: ControlStore;
  bus: Pick<Bus, "makeStream" | "publishBatch" | "lastSeq" | "message">;
  /** How long it waits after a failure: BUS_RETRY_MS unless a test gives a shorter one. */
  retryMs?: number | undefined;
  /** Told after each batch the stream stored: the apply of the stream (apply.ts) reads it then. */
  published?: (() => void) | undefined;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The mirror of control's events table on the bus. start() makes the stream and copies what it
 * lacks, and again each time ingest stores rows; nudge() runs a turn after the one under way. A
 * publish that fails or gets no ack is followed by a look at the stream's last message before it
 * goes on, so a batch the server stored is never published twice; each batch also names the
 * stream's last place it expects, so one stored late, after its publish failed, refuses the next.
 */
export class EventsMirror {
  private readonly o: EventsMirrorOptions;
  readonly since = new Date().toISOString();
  /** Messages it published since control started. */
  published = 0;
  /** The Thermite-Seq of the stream's last message, as it last read or published it. */
  private streamSeq: number | null = null;
  /** Why it waits now (the bus away, its store full); null while it copies, or has copied all. */
  waiting: string | null = null;
  /** Why it stopped, until control starts again; null while it goes on. */
  stopped: MirrorStopped | null = null;
  /** The stream's last place, as it last read or published it. */
  private place = 0;
  /** Set: the stream's last message is read again before the next publish. */
  private reread = true;
  private due = false;
  private running: Promise<void> | undefined;
  private closed = false;
  private unwatch: (() => void) | undefined;

  constructor(o: EventsMirrorOptions) {
    this.o = o;
  }

  /** Copies what the stream lacks, and again each time ingest stores rows, until close(). */
  start(): Promise<void> {
    this.unwatch ??= this.o.store.rigEvents.watch(() => void this.nudge());
    return this.nudge();
  }

  /** A turn after the one under way; resolves when the mirror has copied all, or stopped. */
  nudge(): Promise<void> {
    this.due = true;
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  close(): void {
    this.closed = true;
    this.unwatch?.();
  }

  private async run(): Promise<void> {
    // After the code that stored the rows has run to its end, and its transaction with it.
    await Promise.resolve();
    while (this.due && !this.stopped && !this.closed) {
      this.due = false;
      try {
        await this.turn();
        if (this.waiting) log("control", "events go on the bus again", { after: this.waiting });
        this.waiting = null;
      } catch (err) {
        // Gone, refused or not acked: read the stream's last message again, then go on after it.
        this.reread = true;
        this.due = true;
        const full = (err as { code?: unknown } | null)?.code === STORE_FULL;
        const error = full ? `the bus's store is full: ${errorText(err)}` : errorText(err);
        if (this.waiting !== error)
          log("control", "events not copied to the bus; trying again", { error }, "warn");
        this.waiting = error;
        await pause(this.o.retryMs ?? BUS_RETRY_MS);
      }
    }
  }

  /** Stops the mirror, with its words in control's log, until control starts again. */
  private stop(s: MirrorStopped): void {
    this.stopped = s;
    log("control", "events stopped going on the bus until control starts again", { ...s }, "error");
  }

  /**
   * Reads where the stream ends: the place of its last message and that message's Thermite-Seq
   * (0 for a stream with none). Makes the stream first, waiting for the bus.
   */
  private async readStream(): Promise<void> {
    const { store, bus } = this.o;
    await bus.makeStream(EVENT_STREAM_CONFIG);
    const { place, seq } = await streamEnd(bus);
    if (seq === null) {
      const error = `the stream's last message (place ${place}) has no ${EVENT_HEADERS.seq}: control can't tell where its copy ends`;
      return this.stop({ rig: null, ledger: null, seq: null, bytes: null, error });
    }
    const tableSeq = store.rigEvents.lastSeq();
    if (seq > tableSeq) {
      const error = `the stream holds rows to seq ${seq}, past the table's last, ${tableSeq}: control's store is older than the stream`;
      return this.stop({ rig: null, ledger: null, seq: null, bytes: null, error });
    }
    this.place = place;
    this.streamSeq = seq;
    this.reread = false;
    const behind = store.rigEvents.countAfter(seq);
    const where = { stream: EVENT_STREAM, stream_seq: seq, table_seq: tableSeq, behind };
    log("control", "control's events go on the bus after the stream's last", where);
  }

  /** Publishes every row the stream lacks, a batch at a time, in the table's order. */
  private async turn(): Promise<void> {
    if (this.reread) await this.readStream();
    if (this.stopped || this.streamSeq === null) return;
    const { store } = this.o;
    const behind = store.rigEvents.countAfter(this.streamSeq);
    const moving = behind > BUS_BATCH_MAX;
    const started = performance.now();
    if (moving) log("control", "moving control's events to the bus", { behind });
    let copied = 0;
    let logged = 0;
    while (!this.closed) {
      const { messages, last, stop } = this.batchOf(
        store.rigEvents.inOrder(this.streamSeq, BUS_BATCH_MAX),
      );
      if (messages.length) {
        // The stream's last place, as the mirror knows it: a batch stored late refuses this one.
        const first = messages[0] as Outgoing;
        first.headers = { ...first.headers, [EXPECTED_LAST_HEADER]: String(this.place) };
        const ack = await this.o.bus.publishBatch(messages);
        this.place = ack.seq;
        this.streamSeq = last;
        this.published += messages.length;
        copied += messages.length;
        this.o.published?.();
      }
      if (stop) return this.stop(stop);
      if (!messages.length) break;
      if (moving && copied - logged >= MOVE_LOG_ROWS) {
        logged = copied;
        const left = store.rigEvents.countAfter(this.streamSeq);
        log("control", "moving control's events to the bus", { copied, left });
      }
    }
    const seconds = Math.round(performance.now() - started) / 1000;
    const what = { copied, stream_seq: this.streamSeq, seconds };
    if (moving) log("control", "control's events moved to the bus", what);
    else if (copied) log("control", "events copied to the bus", what, "debug");
  }

  /**
   * The messages of the rows, in order, up to BUS_BATCH_MAX and MIRROR_BATCH_BYTES, and the seq of
   * the last; and, at a row the bus can't carry, why the mirror stops there.
   */
  private batchOf(rows: StoredEvent[]): {
    messages: Outgoing[];
    last: number;
    stop?: MirrorStopped;
  } {
    const messages: Outgoing[] = [];
    let last = this.streamSeq ?? 0;
    let bytes = 0;
    // The rigs the run registry gives each run, looked up once a batch.
    const rigsOf = new Map<string, string[]>();
    for (const row of rows) {
      const run = row.run;
      if (run !== null && !rigsOf.has(run)) rigsOf.set(run, this.o.store.runRegistry.rigsOf(run));
      const m = onBus({
        rig: row.rig,
        ledger: row.ledger_id,
        event: { ...row.event, body: JSON.parse(row.body), run },
        runIsTheRigs: run !== null && isTheRigsRun(row.rig, rigsOf.get(run) ?? []),
        seq: row.seq,
      });
      if ("error" in m) {
        const at = { rig: row.rig, ledger: row.ledger_id, seq: row.seq };
        return { messages, last, stop: { ...at, bytes: m.bytes, error: m.error } };
      }
      if (messages.length && bytes + m.bytes > MIRROR_BATCH_BYTES) break;
      const { subject, data, headers } = m.message;
      messages.push({ subject, data, headers });
      bytes += m.bytes;
      last = row.seq;
    }
    return { messages, last };
  }
}

/**
 * Where the events stream ends, as the server has it: the place of its last message, and that
 * message's Thermite-Seq; 0 and 0 for a stream with none or not made yet, and a seq of null for
 * a last message that names no place in control's table.
 */
export async function streamEnd(
  bus: Pick<Bus, "lastSeq" | "message">,
): Promise<{ place: number; seq: number | null }> {
  const place = await bus.lastSeq(EVENT_STREAM);
  if (place === 0) return { place, seq: 0 };
  const header = (await bus.message(EVENT_STREAM, place))?.header(EVENT_HEADERS.seq);
  const seq = Number(header);
  return { place, seq: header !== undefined && Number.isSafeInteger(seq) && seq >= 1 ? seq : null };
}

/**
 * The mirror's state, for the bus's state (REST, MCP, /metrics): the table's last seq, the
 * Thermite-Seq of the stream's last message as the server has it (`streamSeq`: null when the
 * server did not answer), how many rows of the table come after it, those published, and why the
 * mirror waits or stopped.
 */
export function mirrorState(store: ControlStore, mirror: EventsMirror, streamSeq: number | null) {
  return {
    stream: EVENT_STREAM,
    since: mirror.since,
    table_seq: store.rigEvents.lastSeq(),
    stream_seq: streamSeq,
    behind: streamSeq === null ? null : store.rigEvents.countAfter(streamSeq),
    published: mirror.published,
    waiting: mirror.waiting,
    stopped: mirror.stopped,
  };
}
