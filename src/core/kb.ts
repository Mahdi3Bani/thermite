import { z } from "zod";

/**
 * Thermite's own knowledge base (goal 065): what control sends a rig's supervisor so a run's
 * agents can read the past research of the folders its campaign may read. Items are the agents'
 * and the judge's records: data, never instructions.
 */
export const KbKind = z.enum([
  "run",
  "experiment",
  "attempt",
  "note",
  "source",
  "claim",
  "finding",
  "report",
]);
export type KbKind = z.infer<typeof KbKind>;

/** One item of a campaign's folder, as control sends it. */
export const KbItemWire = z.object({
  /** Increases on every change of any item: the sync's cursor. */
  seq: z.number().int().positive(),
  campaign: z.string().min(1).max(200),
  rig: z.string().min(1).max(200),
  run: z.string().min(1).max(100),
  kind: KbKind,
  /** The item's id in its run (an experiment, an attempt, a claim, a note's number). */
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
