import type { ArmRun } from "./measure.ts";

/**
 * What a confirmation found on its held-out cells (goal 082), named safely.
 *
 * The owner sees each held-out cell's name, its kind of failure, and the measured value against
 * its threshold where the check gives one. The agents (the lanes, the planner, the teachers) see
 * only that a held-out check failed and its kind, in fixed words. No one gets a held-out cell's
 * inputs, outputs or texts: a run's error output and the kit's check reasons never pass through
 * here, only a kind from a closed list.
 */

/** How one held-out cell failed. A closed list: nothing a run printed becomes a kind. */
export const HELD_OUT_KINDS = [
  "threshold_missed",
  "timed_out",
  "crashed",
  "check_failed",
  "non_finite",
  "no_cell",
] as const;
export type HeldOutKind = (typeof HELD_OUT_KINDS)[number];

/** One held-out cell's result, as the owner sees it. */
export interface HeldOutCell {
  cell: string;
  /** Goal campaigns: the threshold goal it was checked for, or the kit's verifier it ran in. */
  goal?: string | undefined;
  verifier?: string | undefined;
  ok: boolean;
  /** How it failed, when it did. */
  kind?: HeldOutKind | undefined;
  /**
   * The measured value and the threshold it is held to, where the check gives one: a goal's
   * metric threshold (its mean, and its interval), or a hill climb's ratio to the champion.
   */
  value?: number | undefined;
  low?: number | undefined;
  high?: number | undefined;
  threshold?: number | undefined;
  op?: ">=" | ">" | "<=" | "<" | undefined;
  /** What the value measures, in words, and its unit. */
  measure?: string | undefined;
  unit?: string | undefined;
}

/** A held-out record: whether every cell passed, and each cell's result. */
export interface HeldOutResult {
  pass: boolean;
  cells: HeldOutCell[];
}

/** The agents' words for each kind: that a held-out check failed, and how, never which or why. */
export const HELD_OUT_WORDS: Record<HeldOutKind, string> = {
  threshold_missed: "a held-out check missed its threshold",
  timed_out: "a held-out check timed out",
  crashed: "a held-out check crashed",
  check_failed: "a held-out check failed the kit's check",
  non_finite: "a held-out check gave no finite value",
  no_cell: "a held-out check names a cell the kit does not have",
};

/**
 * The agents' words when a held-out pass could not finish: an error in the judge's own work (a
 * kit that fails its runs, a tampered build, a lost lease). An error's text can carry a held-out
 * cell's name, parameters or time, so the agents get only these words; the error itself goes to
 * the rig's log, for the owner.
 */
export const HELD_OUT_INFRA = "a held-out check could not finish (an infrastructure failure)";

/** The owner's words for each kind, after the cell's name. */
export const HELD_OUT_OWNER_WORDS: Record<HeldOutKind, string> = {
  threshold_missed: "missed its threshold",
  timed_out: "timed out",
  crashed: "crashed",
  check_failed: "failed the kit's check",
  non_finite: "gave no finite value",
  no_cell: "is not in the kit",
};

/**
 * What a hill climb's held-out ratio measures: the change over the champion when higher is better,
 * the champion over the change when lower is better, so a ratio above 1 is always an improvement.
 */
export function heldOutMeasure(metric: string, direction: "max" | "min"): string {
  return direction === "max"
    ? `${metric}, the change's median over the champion's`
    : `${metric}, the champion's median over the change's (lower is better)`;
}

/** Whether a value is on the passing side of a goal's threshold. */
export function meetsThreshold(x: number, op: ">=" | ">" | "<=" | "<", value: number): boolean {
  return op === ">=" ? x >= value : op === ">" ? x > value : op === "<=" ? x <= value : x < value;
}

/** A failed run's kind, from how it failed: never from what it printed. */
export function heldOutKindOf(r: Exclude<ArmRun, { kind: "ok" }>): HeldOutKind {
  switch (r.failure) {
    case "timeout":
      return "timed_out";
    case "memory":
    case "disk":
    case "exit":
      return "crashed";
    case "metric":
      return "non_finite";
    default:
      return "check_failed";
  }
}

/** The kinds a record holds, each once, in the list's order. */
export function heldOutKinds(cells: readonly HeldOutCell[]): HeldOutKind[] {
  const found = new Set(cells.filter((c) => !c.ok && c.kind).map((c) => c.kind as HeldOutKind));
  return HELD_OUT_KINDS.filter((k) => found.has(k));
}

/**
 * The agents' words for a failed held-out check: each kind once, such as "a held-out check
 * timed out; a held-out check missed its threshold". A record from before goal 082 has no
 * kinds: "a held-out check failed".
 */
export function heldOutWords(kinds: readonly HeldOutKind[]): string {
  return kinds.length ? kinds.map((k) => HELD_OUT_WORDS[k]).join("; ") : "a held-out check failed";
}

/**
 * A held-out record of these cells, with any value that is not a finite number left out: the
 * ledger's JSON has no form for one, and a record must never fail for it.
 */
export function heldOutResult(cells: readonly HeldOutCell[]): HeldOutResult {
  const finite = cells.map(
    (c) =>
      Object.fromEntries(
        Object.entries(c).filter(([, v]) => typeof v !== "number" || Number.isFinite(v)),
      ) as unknown as HeldOutCell,
  );
  return { pass: finite.every((c) => c.ok), cells: finite };
}

/** A held-out record's cells, read back from its detail; [] for a record from before goal 082. */
export function heldOutCellsOf(detail: unknown): HeldOutCell[] {
  const cells = (detail as { cells?: unknown } | null | undefined)?.cells;
  if (!Array.isArray(cells)) return [];
  return cells.filter(
    (c): c is HeldOutCell =>
      !!c && typeof c === "object" && typeof (c as HeldOutCell).cell === "string",
  );
}
