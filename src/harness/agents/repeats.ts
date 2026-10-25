import type { AgentTool } from "@earendil-works/pi-agent-core";
import { canonicalJson, canonicalSha } from "../../core/canonical.ts";

/**
 * A worker that repeats the same tool call (goal 143). On the lab one model reply held the same
 * 13 calls at least 74 times, and the conversation reached millions of tokens before compaction
 * could act, since Pi compacts only before the next model call. Here, in a Pi worker, a call with
 * the same tool and the same arguments as an earlier one, whose answer is the same as the one
 * already in the conversation, gets a short answer instead of the full one again. The call still
 * runs: a changed answer is given in full. After a compaction the earlier answer may be gone from
 * the conversation, so the guard forgets what it gave. The trial goes on; this is not a cap.
 */

/** How a short answer starts: the harness's watch counts a line that starts so as a repeat. */
export const SAME_ANSWER = "Same call and same answer as at";

/** The short answer to a repeated call: when and which call gave the answer in full. */
export const sameAnswer = (at: string, call: number): string =>
  `${SAME_ANSWER} ${at.slice(11, 19)} UTC (call ${call}). Its answer is above. Change what you ask, or go on.`;

/** The most answers the guard remembers; past it, the oldest go, and a call to one is new again. */
export const GUARD_MAX = 2000;

/** A tool's answer: its content, and whatever else it carries (Pi's `terminate`, say). */
type Answer = { content?: unknown; details?: unknown; [k: string]: unknown };

/** One trial's memory of the answers it gave in full: by call, the answer's hash and when. */
export class RepeatGuard {
  private readonly given = new Map<string, { hash: string; at: string; call: number }>();
  private calls = 0;
  private readonly clock: () => Date;
  /** The conversation's compactions so far (the Compactor's count): a new one resets the guard. */
  private readonly compactions: () => number;
  private seenCompactions = 0;

  constructor(o: { compactions?: () => number; clock?: () => Date } = {}) {
    this.compactions = o.compactions ?? (() => 0);
    this.clock = o.clock ?? (() => new Date());
  }

  /** A compaction: the conversation may no longer hold the answers given, so all go. */
  reset(): void {
    this.given.clear();
  }

  /** The answer the model gets: the full one, or a short one for the same call and answer. */
  answer(tool: string, params: unknown, full: Answer): Answer {
    this.calls++;
    const compactions = this.compactions();
    if (compactions !== this.seenCompactions) {
      this.seenCompactions = compactions;
      this.reset();
    }
    const key = `${tool} ${canonicalJson(params ?? null)}`;
    const hash = canonicalSha(full.content ?? null);
    const before = this.given.get(key);
    // A short answer keeps the rest of the answer: a call that ends the trial still ends it.
    if (before?.hash === hash)
      return { ...full, content: [{ type: "text", text: sameAnswer(before.at, before.call) }] };
    // Kept in order of use: the newest at the end, the oldest first out.
    this.given.delete(key);
    this.given.set(key, { hash, at: this.clock().toISOString(), call: this.calls });
    if (this.given.size > GUARD_MAX) this.given.delete(this.given.keys().next().value as string);
    return full;
  }
}

/**
 * The tools with one guard around their answers, which forgets them at each compaction (the
 * Compactor's count). A tool that fails is not guarded.
 */
export function guardRepeats(tools: AgentTool[], compactions: () => number): AgentTool[] {
  const guard = new RepeatGuard({ compactions });
  return tools.map(
    (t) =>
      ({
        ...t,
        execute: async (id: string, params: unknown, ...rest: unknown[]) => {
          const full = await (t.execute as (...a: unknown[]) => Promise<Answer>)(
            id,
            params,
            ...rest,
          );
          return guard.answer(t.name, params, full);
        },
      }) as AgentTool,
  );
}
