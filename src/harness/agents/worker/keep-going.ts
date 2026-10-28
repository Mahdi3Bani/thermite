import type { Agent } from "@earendil-works/pi-agent-core";
import type { Compactor } from "../../../agents/compaction/index.ts";
import {
  classifyProviderError,
  type FailureCount,
  nextStep,
  type ProviderErrorKind,
  type ProviderWatch,
} from "../provider-errors.ts";
import type { ProviderWait } from "./spec.ts";

/**
 * A trial goes on until it submits or stops of its own accord (goal 079): a cut-off reply, a
 * failed model call or a full context is answered and the trial continues, and a worker that
 * stops without a submission is told to go on.
 */

/**
 * Whether a trial in a program of its own stops telling its worker to go on after a run that
 * ended without a submission (goal 079): after a nudge it answered without any work (no tool
 * call), or after the campaign's own number of nudges (`lanes.limits.nudges`); the owner's
 * messages waiting for a worker that keeps working continue it either way.
 */
export function stopNudging(
  nudges: number,
  worked: boolean,
  progressed: boolean,
  limit: number | undefined,
  messages?: { waiting(): unknown[] } | undefined,
): boolean {
  const owner = progressed && (messages?.waiting().length ?? 0) > 0;
  if (owner) return false;
  if (nudges > 0 && !worked) return true;
  return limit !== undefined && nudges >= limit;
}

export const NUDGE =
  "You have not called submit yet. Keep working with your tools: make your change, build and test it, then call submit once. If you find no change worth judging, say why in one sentence.";

const CUT_OFF =
  "Your last reply was cut off at the output limit before it made a tool call. Think briefly, then make one tool call; keep each reply short.";

/** Why keepGoing ended a trial early: its context is full even compacted, or the provider refuses. */
export interface TrialEnd {
  stopped: "context" | "error";
  error: string;
  /** The provider's error's kind (goal 079), when a provider's error ended it. */
  kind?: ProviderErrorKind | undefined;
}

/** What keepGoing takes besides the agent: the campaign's limits and the provider's answers. */
export interface KeepGoingOptions {
  /** The campaign's `lanes.limits.failures_in_a_row`: none unless set (goal 079). */
  failuresInARow?: number | undefined;
  /** The campaign's `lanes.limits.cutoffs_in_a_row`: none unless set (goal 079). */
  cutoffsInARow?: number | undefined;
  /** The provider's error answers as Pi's calls saw them (a rate limit's Retry-After). */
  watch?: ProviderWatch | undefined;
  /** Told of each wait for the provider, before it. */
  onWait?: ((w: ProviderWait) => void) | undefined;
  /** How a wait is spent (tests give their own); by default, real time, cut short by done(). */
  sleep?: ((ms: number, done: () => boolean) => Promise<void>) | undefined;
  /**
   * The trial's failed calls in a row and since when (goal 079), kept over this call and the
   * trial's next ones; a reply that came through clears them. By default, this call's own.
   */
  count?: FailureCount | undefined;
  /** The clock (tests give their own). */
  now?: (() => number) | undefined;
}

/** Said to the agent after the harness compacted a full conversation. */
const COMPACTED =
  "The model's context was full, so the harness compacted the conversation. Continue where you left off.";

/**
 * Until `done()`, a reply cut off at the output limit is told to think less and act, and a
 * failed model call is answered by its kind (goal 079): a rate limit waits for the time the
 * provider gives, a passing fault waits a growing pause, and the trial goes on in the same
 * conversation. A full context (a cut-off reply with almost no output, a prompt at the window, or
 * a context-length error) is compacted and the trial goes on (goal 070); only a conversation that
 * the compactor cannot make fit, twice running, ends it. Returns undefined when the model stops of
 * its own accord (or once `done()`), or why the trial must end: a full context that compaction
 * cannot help; no credits, a refused key or an unserved model, or a passing fault or the model's
 * own error with no call that worked for 30 minutes (the run's agents then stop until a model
 * check passes); or the campaign's own limit on failures or cut-offs in a row. Nothing here ends
 * research.
 */
export async function keepGoing(
  agent: Agent,
  done: () => boolean,
  contextWindow?: number | undefined,
  compactor?: Pick<Compactor, "force" | "count"> | undefined,
  o: KeepGoingOptions = {},
): Promise<TrialEnd | undefined> {
  const count: FailureCount = o.count ?? { failures: 0, rateWaits: 0 };
  const now = o.now ?? Date.now;
  let cutoffs = 0;
  // Compactions forced in a row by a full context, with no finished reply between them.
  let forced = 0;
  let replies = 0;
  let repliesAtForce = -1;
  let repliesAtFailure = -1;
  const unsubscribe = agent.subscribe((e) => {
    if (e.type !== "turn_end") return;
    const stop = (e.message as { stopReason?: string }).stopReason;
    if (stop === "stop" || stop === "toolUse") replies++;
    // A call that worked (a reply cut off at the output limit came through too): the calls no
    // longer fail.
    if (stop === "stop" || stop === "toolUse" || stop === "length") count.failing = undefined;
  });
  /** A full context: compacted and continued, or the trial's end when that cannot help. */
  const full = async (why: string): Promise<TrialEnd | undefined> => {
    if (replies !== repliesAtForce) forced = 0;
    if (!compactor || forced >= 2)
      return {
        stopped: "context",
        error: `the conversation filled the model's context${compactor ? " again right after a compaction" : ""} (${why})`,
      };
    forced++;
    repliesAtForce = replies;
    compactor.force();
    await agent.prompt(COMPACTED);
    return undefined;
  };
  try {
    while (!done()) {
      const last = lastAssistant(agent);
      if (last?.stopReason === "length") {
        count.failures = 0;
        const atWindow = (contextWindow ?? 0) > 0 && last.input >= 0.95 * (contextWindow as number);
        if (last.output < 64 || atWindow) {
          const end = await full(`${last.input} tokens in, ${last.output} out`);
          if (end) return end;
          continue;
        }
        cutoffs++;
        if (o.cutoffsInARow !== undefined && cutoffs >= o.cutoffsInARow) {
          return {
            stopped: "error",
            error: `the model's replies were cut off ${cutoffs} times in a row without a tool call (the campaign's cutoffs_in_a_row)`,
          };
        }
        await agent.prompt(CUT_OFF);
      } else if (last?.stopReason === "error") {
        cutoffs = 0;
        // A reply that came through since the last failure: the failures are not in a row.
        if (replies !== repliesAtFailure) {
          count.failures = 0;
          count.rateWaits = 0;
        }
        repliesAtFailure = replies;
        const message = last.errorMessage ?? "no detail";
        const e = classifyProviderError(message, o.watch?.take());
        if (e.kind === "context") {
          const end = await full(e.words.slice(0, 200));
          if (end) return end;
          continue;
        }
        const step = nextStep(e, count, o.failuresInARow, now());
        if (step.end) return { stopped: "error", error: step.error, kind: e.kind };
        o.onWait?.({ until: step.until, kind: e.kind, words: e.words });
        await (o.sleep ?? sleepUnlessDone)(step.waitMs, done);
        if (done()) return undefined;
        await agent.prompt(
          `The model call failed (${e.words.slice(0, 200)}). Continue where you left off.`,
        );
      } else {
        return undefined;
      }
    }
    return undefined;
  } finally {
    unsubscribe();
  }
}

/** Waits `ms`, or less once `done()` turns true (the trial's time ran out meanwhile). */
async function sleepUnlessDone(ms: number, done: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !done()) {
    await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
  }
}

export function lastAssistant(
  agent: Agent,
): { stopReason: string; errorMessage?: string; input: number; output: number } | undefined {
  const messages = agent.state.messages as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: { input?: number; output?: number };
  }[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && m.stopReason)
      return {
        stopReason: m.stopReason,
        ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}),
        input: m.usage?.input ?? 0,
        output: m.usage?.output ?? 0,
      };
  }
  return undefined;
}
