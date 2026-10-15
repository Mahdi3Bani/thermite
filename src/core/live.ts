import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * The live log: what the unit's agents and judge are doing right now, for people watching from
 * control. It is a view, never a record: nothing in it is judged, it is not in the ledger, and it
 * starts empty when the harness controller restarts (a new log id).
 *
 * Sources: "planner", "judge", "trial:<id>" (one worker's session) and "supervisor" (the
 * supervisor's own advisors, relayed unsigned). The harness signs every batch it hands to the
 * supervisor, so control can tell the harness's lines from anything the supervisor might invent.
 */

export const LIVE_KINDS = [
  "text",
  "thinking",
  "tool",
  "result",
  "message",
  "status",
  "log",
] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];

export const LiveEntry = z.object({
  seq: z.number().int().positive(),
  at: z.string().min(1).max(40),
  source: z.string().regex(/^(planner|judge|supervisor|trial:[A-Za-z0-9_-]{1,64})$/),
  kind: z.enum(LIVE_KINDS),
  text: z.string().max(8000),
  lane: z.string().max(32).optional(),
  instance: z.string().max(80).optional(),
});
export type LiveEntry = z.infer<typeof LiveEntry>;

export const LiveBatch = z.object({
  unit: z.string().min(1),
  /** Changes when the controller restarts; sequence numbers start again under a new id. */
  log_id: z.string().min(1).max(64),
  from: z.number().int().min(0),
  next: z.number().int().min(0),
  entries: z.array(LiveEntry).max(2000),
  unit_pubkey: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
});
export type LiveBatch = z.infer<typeof LiveBatch>;

/** The part of a live batch its signature covers. */
export function liveBody(
  b: Pick<LiveBatch, "unit" | "log_id" | "from" | "next" | "entries">,
): unknown {
  return { unit: b.unit, log_id: b.log_id, from: b.from, next: b.next, entries: b.entries };
}

/** What a writer appends (the log numbers and times it). */
export interface LiveLine {
  source: string;
  kind: LiveKind;
  text: string;
  lane?: string | undefined;
  instance?: string | undefined;
}

/** A bounded in-memory live log. */
export class LiveLog {
  readonly id = randomUUID();
  private entries: LiveEntry[] = [];
  private seq = 0;
  private readonly max: number;
  private readonly clock: () => Date;

  constructor(opts: { max?: number; clock?: () => Date } = {}) {
    this.max = opts.max ?? 5000;
    this.clock = opts.clock ?? (() => new Date());
  }

  append(line: LiveLine): void {
    const e: LiveEntry = {
      seq: ++this.seq,
      at: this.clock().toISOString(),
      source: line.source,
      kind: line.kind,
      text: line.text.length > 8000 ? `${line.text.slice(0, 7990)} [cut]` : line.text,
      ...(line.lane ? { lane: line.lane } : {}),
      ...(line.instance ? { instance: line.instance } : {}),
    };
    // Only well-formed lines: a bad source name is dropped, never relayed.
    if (!LiveEntry.safeParse(e).success) return;
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  /** Lines after `after`, oldest first, at most `limit`. */
  since(after: number, limit = 500): { entries: LiveEntry[]; next: number } {
    const out = this.entries.filter((e) => e.seq > after).slice(0, limit);
    return { entries: out, next: out.at(-1)?.seq ?? Math.max(after, 0) };
  }

  get latest(): number {
    return this.seq;
  }
}

/** A short, single-line rendering of a tool call's arguments for the live log. */
export function summarizeArgs(args: unknown, max = 300): string {
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  s = s.replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
