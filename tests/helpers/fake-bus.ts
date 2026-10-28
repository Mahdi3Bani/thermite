import type { Bus, BusMessage, Handled, Published, StreamSettings } from "../../src/common/bus.ts";

/** A message the fake bus keeps. */
export interface Kept {
  subject: string;
  seq: number;
  id: string;
  data: string;
  headers: Record<string, string>;
}

/** A subject as a stream's pattern reads it: `*` stands for one token, `>` for the rest. */
function takes(pattern: string, subject: string): boolean {
  const re = pattern
    .split(".")
    .map((t) => (t === "*" ? "[^.]+" : t === ">" ? ".+" : t.replace(/[\\^$+?()[\]{}|]/g, "\\$&")))
    .join("\\.");
  return new RegExp(`^${re}$`).test(subject);
}

/**
 * A stand-in for the NATS server, in memory, for tests of what control and the supervisor do on
 * the message bus (common/bus.ts talks to a real one). It keeps the streams made, each message
 * published to a subject one of them takes, once by its id, and removes one by its id. `take`
 * hands a subject's messages to a handler as a work queue's consumer does.
 */
export class FakeBus implements Pick<Bus, "publish" | "makeStream" | "remove"> {
  readonly streams = new Map<string, StreamSettings>();
  readonly kept: Kept[] = [];
  /** The ids the bus remembers; forgetIds() stands for its duplicate window passing. */
  private readonly ids = new Set<string>();
  private seq = 0;
  /** Set: every publish fails, as when the server's ack never comes. */
  failing = false;
  /** Set: each publish waits for it before the server answers. */
  hold: Promise<void> | undefined;

  async makeStream(stream: StreamSettings): Promise<void> {
    this.streams.set(stream.name, stream);
  }

  async publish(
    subject: string,
    data: string,
    o: { id: string; headers?: Record<string, string> | undefined },
  ): Promise<Published> {
    await this.hold;
    if (this.failing) throw new Error("TimeoutError: no ack from the server");
    const stream = [...this.streams.values()].find((s) =>
      (s.subjects ?? []).some((p) => takes(p, subject)),
    );
    if (!stream) throw new Error(`no stream on the bus takes ${subject} yet: control makes it`);
    if (this.ids.has(o.id)) return { seq: this.seq, duplicate: true };
    this.ids.add(o.id);
    this.kept.push({ subject, seq: ++this.seq, id: o.id, data, headers: o.headers ?? {} });
    return { seq: this.seq, duplicate: false };
  }

  async remove(_stream: string, subject: string, id: string): Promise<boolean> {
    const at = this.kept.findIndex((m) => m.subject === subject && m.id === id);
    if (at < 0) return false;
    this.kept.splice(at, 1);
    return true;
  }

  /** The duplicate window passes: a message id published before is new again. */
  forgetIds(): void {
    this.ids.clear();
  }

  /** The messages on a subject, oldest first. */
  on(subject: string): Kept[] {
    return this.kept.filter((m) => m.subject === subject);
  }

  /**
   * Hands each message on `subject` to `handle` once, oldest first, as a work queue's consumer:
   * a message acked is gone; one the handler asks for again stays for the next call.
   */
  async take(
    subject: string,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
  ): Promise<{ acked: number; again: number }> {
    let acked = 0;
    let again = 0;
    for (const m of this.on(subject)) {
      const handled = await handle(asMessage(m));
      if (handled) again++;
      else {
        acked++;
        this.kept.splice(this.kept.indexOf(m), 1);
      }
    }
    return { acked, again };
  }
}

/** A kept message as a handler sees it. */
export function asMessage(m: Kept): BusMessage {
  return {
    subject: m.subject,
    seq: m.seq,
    data: new TextEncoder().encode(m.data),
    header: (name) => m.headers[name],
  };
}

/** Lets the work control queued for the bus (each publish waits its turn) run to its end. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}
