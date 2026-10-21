import { z } from "zod";

/**
 * Compaction (goal 070): near the model's context window, an agent's conversation is compacted
 * and its trial goes on. It is never a cap: it never ends a trial and never asks for an early
 * submission. The compaction point is a share of the window, set with each agent's model (MCP's
 * set_rig_model, REST's POST /v1/rigs/<rig>/model), carried in the model route as `compact_at`,
 * and applied by each harness as far as it supports it. A campaign may set its own window and
 * point for all its runs (the contract's `agents_context`): its window is never above the rig's.
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

/**
 * A context window the owner sets (a cap on a rig's model, or a campaign's own): at least this
 * many tokens, and at most what a model route carries.
 */
export const CONTEXT_WINDOW_MIN = 4096;
export const CONTEXT_WINDOW_MAX = 100_000_000;

/**
 * A campaign's own context settings for all its runs' agents (the contract's `agents_context`):
 * the window, which is never above the rig's (the lower wins), and the compaction point, which
 * replaces the rig's. Both optional, with no defaults, so a contract without them keeps its hash.
 */
export const AgentsContext = z.strictObject({
  context_window: z.number().int().min(CONTEXT_WINDOW_MIN).max(CONTEXT_WINDOW_MAX).optional(),
  compact_at: z.number().int().min(COMPACT_AT_MIN).max(COMPACT_AT_MAX).optional(),
});
export type AgentsContext = z.infer<typeof AgentsContext>;

/**
 * The window and point an agent works with in a campaign's run: the lower of its own window and
 * the campaign's (the campaign's as given when its own is unknown, 0), and the campaign's point
 * over its own. Without a campaign setting, its own.
 */
export function contextApplied(
  own: { contextWindow: number; compactAt?: number | undefined },
  campaign: AgentsContext | undefined,
): { contextWindow: number; compactAt: number | undefined } {
  const cap = campaign?.context_window;
  return {
    contextWindow:
      cap && (own.contextWindow <= 0 || cap < own.contextWindow) ? cap : own.contextWindow,
    compactAt: campaign?.compact_at ?? own.compactAt,
  };
}

/** Tokens as people read them: 131,072. */
const tokenWords = (n: number) => n.toLocaleString("en-US");

/** Why a campaign's context settings are refused, in words; undefined when they are good. */
export function agentsContextRefusal(c: {
  context_window?: unknown;
  compact_at?: unknown;
}): string | undefined {
  const w = c.context_window;
  if (
    w !== undefined &&
    (typeof w !== "number" ||
      !Number.isInteger(w) ||
      w < CONTEXT_WINDOW_MIN ||
      w > CONTEXT_WINDOW_MAX)
  )
    return `A context window is a whole number of tokens from ${tokenWords(CONTEXT_WINDOW_MIN)} to ${tokenWords(CONTEXT_WINDOW_MAX)}.`;
  const at = c.compact_at;
  if (at !== undefined) return typeof at === "number" ? compactAtRefusal(at) : compactAtRefusal(0);
  return undefined;
}

/** A campaign's context settings in words: "a context window of 131,072 tokens, compacted at 70%". */
export function agentsContextWords(c: AgentsContext | undefined): string {
  const parts = [
    ...(c?.context_window ? [`a context window of ${tokenWords(c.context_window)} tokens`] : []),
    ...(c?.compact_at ? [`compaction at ${c.compact_at}% of the window`] : []),
  ];
  return parts.length ? parts.join(", ") : "none: each agent keeps the rig's settings";
}

/** The folder of a run's research folder where the conversations before compactions are kept. */
export const COMPACTIONS_DIR = "compactions";

/** A kept conversation's file name: the trial (or the planner's call) and the compaction number. */
export function compactionFile(who: string, n: number): string {
  return `${who}-${n}.md`;
}
