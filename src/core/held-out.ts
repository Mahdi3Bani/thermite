/**
 * The kinds of held-out failure and their words (goal 082), for the judge, the agents and the
 * owner's screens alike (goal 125, T1). A closed list: nothing a run printed becomes a kind.
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

/** The agents' words for each kind: that a held-out check failed, and how, never which or why. */
export const HELD_OUT_WORDS: Record<HeldOutKind, string> = {
  threshold_missed: "a held-out check missed its threshold",
  timed_out: "a held-out check timed out",
  crashed: "a held-out check crashed",
  check_failed: "a held-out check failed the kit's check",
  non_finite: "a held-out check gave no finite value",
  no_cell: "a held-out check names a cell the kit does not have",
};

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
 * The agents' words for a failed held-out check: each kind once, such as "a held-out check
 * timed out; a held-out check missed its threshold". A record from before goal 082 has no
 * kinds: "a held-out check failed".
 */
export function heldOutWords(kinds: readonly HeldOutKind[]): string {
  return kinds.length ? kinds.map((k) => HELD_OUT_WORDS[k]).join("; ") : "a held-out check failed";
}
