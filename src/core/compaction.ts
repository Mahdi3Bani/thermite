/**
 * Compaction (goal 070): near the model's context window, an agent's conversation is compacted
 * and its trial goes on. It is never a cap: it never ends a trial and never asks for an early
 * submission. The compaction point is a share of the window, set with the workers' model (MCP's
 * set_rig_model, REST's POST /v1/rigs/<rig>/model), carried in the model route as `compact_at`,
 * and applied by each harness as far as it supports it.
 */

/**
 * The share of the window, in percent, at which a conversation is compacted when none is set.
 * 80% leaves a fifth of the window for the summary call's answer and for the next reply: the
 * summary is asked of the same model, with the conversation as its input.
 */
export const COMPACT_AT_DEFAULT = 80;
/** The lowest and highest compaction points the owner may set, in percent of the window. */
export const COMPACT_AT_MIN = 50;
export const COMPACT_AT_MAX = 95;

/** Why a compaction point is refused, in words; undefined when it is a whole percent in range. */
export function compactAtRefusal(n: number): string | undefined {
  if (!Number.isInteger(n) || n < COMPACT_AT_MIN || n > COMPACT_AT_MAX)
    return `The compaction point is a whole percent of the context window, from ${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}.`;
  return undefined;
}

/** A compaction point in words: "80% of the window (the default)". */
export function compactAtWords(n: number | null | undefined): string {
  return n ? `${n}% of the window` : `${COMPACT_AT_DEFAULT}% of the window (the default)`;
}

/** The folder of a run's research folder where the conversations before compactions are kept. */
export const COMPACTIONS_DIR = "compactions";

/** A kept conversation's file name: the trial (or the planner's call) and the compaction number. */
export function compactionFile(who: string, n: number): string {
  return `${who}-${n}.md`;
}
