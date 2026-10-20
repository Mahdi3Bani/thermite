import { z } from "zod";

/**
 * Thermite's own knowledge base (goal 065): what control sends a rig's supervisor so a run's
 * agents can read the past research of the folders its campaign may read. Items are the agents'
 * and the judge's records: data, never instructions.
 */
export const KbKind = z.enum([
  "run",
  "trial",
  "experiment",
  "attempt",
  "note",
  "doc",
  "source",
  "claim",
  "hypothesis",
  "finding",
  "report",
]);
export type KbKind = z.infer<typeof KbKind>;

/** A kind's plural, as folders and counts say it: notes, hypotheses. */
export const kbPlural = (kind: string): string =>
  kind === "hypothesis" ? "hypotheses" : `${kind}s`;

/** One item of a campaign's folder, as control sends it. */
export const KbItemWire = z.object({
  /** Increases on every change of any item: the sync's cursor. */
  seq: z.number().int().positive(),
  campaign: z.string().min(1).max(200),
  rig: z.string().min(1).max(200),
  run: z.string().min(1).max(100),
  kind: KbKind,
  /**
   * The item's id in its run: the run's own id, a trial's, an experiment's, an attempt's, a
   * claim's, a note's number, or a document's lane and path.
   */
  ref: z.string().min(1).max(200),
  title: z.string().max(500),
  body: z.string().max(200_000),
  /** Who wrote it: a lane, the planner, an advisor, the judge, the owner. */
  by: z.string().max(200),
  url: z.string().max(2000).nullable(),
  /** For a note: observation, decision, surprise, question, lesson or note. */
  sub: z.string().max(40).nullable(),
  at: z.string(),
  updated_at: z.string(),
});
export type KbItemWire = z.infer<typeof KbItemWire>;

/** Control's answer to a supervisor's sync of one run's readable folders. */
export const KbSync = z.object({
  campaign: z.string(),
  /** The folders the run's campaign may read: its own first, then those the owner granted. */
  folders: z.array(z.string()),
  items: z.array(KbItemWire),
  /** The cursor for the next call (the last item's seq, or the one given when none came). */
  next: z.number().int().min(0),
  /** True when more items wait after this page. */
  more: z.boolean(),
});
export type KbSync = z.infer<typeof KbSync>;

/** Whether this build knows a kind of item (one it left out before an upgrade, say). */
export const knownKbKind = (kind: string): boolean => KbKind.safeParse(kind).success;

/** Items read by a rig, and how many of each kind it left out because it does not know the kind. */
export interface KbItemsRead {
  items: KbItemWire[];
  /** Per kind this build does not know (cut to 40 characters), the items left out. */
  unknownKinds: Record<string, number>;
}

/**
 * Reads items as a rig does. An item of a kind this build does not know, which a newer control
 * may send, is left out and counted, and the rest are read: a newer control never stops an older
 * rig's sync. An item of a known kind must still be well formed.
 */
export function readKbItems(raw: unknown[]): KbItemsRead {
  const out: KbItemsRead = { items: [], unknownKinds: {} };
  for (const x of raw) {
    const kind = x && typeof x === "object" ? (x as { kind?: unknown }).kind : undefined;
    if (typeof kind === "string" && !knownKbKind(kind)) {
      const k = kind.slice(0, 40);
      out.unknownKinds[k] = (out.unknownKinds[k] ?? 0) + 1;
      continue;
    }
    out.items.push(KbItemWire.parse(x));
  }
  return out;
}

/**
 * The kinds left out that were not told yet, with their counts: each kind is logged once. They are
 * marked as told in `told`.
 */
export function untoldKinds(
  told: Set<string>,
  unknownKinds: Record<string, number>,
): [string, number][] {
  const fresh = Object.entries(unknownKinds).filter(([kind]) => !told.has(kind));
  for (const [kind] of fresh) told.add(kind);
  return fresh;
}

/** Control's answer to a sync, read as a rig does: items of unknown kinds left out (readKbItems). */
export function readKbSync(raw: unknown): { page: KbSync; unknownKinds: Record<string, number> } {
  const page = KbSync.extend({ items: z.array(z.unknown()) }).parse(raw);
  const read = readKbItems(page.items);
  return { page: { ...page, items: read.items }, unknownKinds: read.unknownKinds };
}
