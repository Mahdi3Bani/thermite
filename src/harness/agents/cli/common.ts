import type { LaneLimitValues } from "../../../core/contract.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { Role, RunOutcome } from "../../broker/runner.ts";
import type { MessageInbox } from "../live-session.ts";
import type { ProgramStep } from "../provider-errors.ts";
import type { TrialResult } from "../worker/index.ts";

/**
 * What the trial loops of the agent programs that run as command-line programs (OpenCode,
 * Claude Code, Codex) share (goal 125, T7): the limits as the agent reads them, why a limit
 * stopped the program, the nudge and the owner's messages, and the usage hand-over (the PATH their
 * agent's shell gets is in src/agents/programs/path.ts).
 */

/**
 * The lane's limits, as the agent must know them: the program and its commands share them.
 * `memory`: what the program itself uses, in words, when it is known.
 */
export function limitsNote(limits: LaneLimitValues, program: string, memory?: string): string {
  return `Memory: ${limits.runRssMib} MiB for everything your lane runs at once, ${program} itself included${memory ? ` (it uses ${memory})` : ""}. A command that takes it over the limit is killed (your shell tool reports "Killed by SIGKILL"): run it again with less parallelism (for example make -j2) or a smaller input, or as a development run, which has its own limit. Disk: ${limits.workspaceMib} MiB, and at most 50,000 files, for this trial's directory, ${program}'s own files included; going over ends the trial.`;
}

/** Why the broker stopped the program, when a memory or disk limit did. */
export function breachError(
  o: Pick<RunOutcome, "killedFor"> &
    Partial<Pick<RunOutcome, "peakRssBytes" | "peakDiskBytes" | "peakEntries">>,
  limits: LaneLimitValues,
  program: string,
): string | undefined {
  const mib = (b: number | undefined) => Math.round((b ?? 0) / 1024 ** 2);
  if (o.killedFor === "memory")
    return `stopped by the lane's memory limit: ${program} reached ${mib(o.peakRssBytes)} MiB with what it ran, over ${limits.runRssMib} MiB (the contract's lanes.limits.run_rss_mib), and its commands' memory could not be freed`;
  if (o.killedFor === "disk")
    return `stopped by the lane's disk limit: the trial's directory reached ${mib(o.peakDiskBytes)} MiB in ${o.peakEntries ?? 0} files, over ${limits.workspaceMib} MiB (lanes.limits.workspace_mib) or 50,000 files`;
  return undefined;
}

/** Whether a trial used its turns: a cap set by Turns per trial (none unless configured). */
export const turnsUp = (spec: { maxTurns?: number | undefined }, tally: { turns: number }) =>
  spec.maxTurns !== undefined && tally.turns >= spec.maxTurns;

/**
 * How a trial ends when the step after a provider's error (afterProgramFailure) does not go on:
 * stopped, out of time, or ended by the error's kind or the campaign's limit.
 */
export function trialEnd(
  step: Exclude<ProgramStep, { goOn: string }>,
): Pick<TrialResult, "stopped" | "error" | "errorKind"> {
  if ("interrupted" in step) return { stopped: "interrupted" };
  if ("wall" in step) return { stopped: "wall" };
  return { stopped: "error", error: step.end.error, errorKind: step.end.kind };
}

/**
 * A submission ends the trial (OpenCode or Claude Code): the submit command gets this long to
 * finish and its result to be recorded, then the lane's processes are stopped. The submission is
 * in the ledger before the harness sees it, so stopping cuts off only the agent's closing reply,
 * which would keep the lane busy (a slow model's took about 40 s) for nothing.
 */
export const AFTER_SUBMIT_MS = 5_000;

export const NUDGE =
  'You have not submitted yet. Keep working: make your change, build and test it, then run `thermite-trial submit --hypothesis "..."` once. If you find no change worth judging, say why in one sentence.';

/** The owner's messages as they are put to an agent in a continued session. */
export const ownerLines = (msgs: { text: string }[]) =>
  msgs.map((m) => `A message from the campaign's owner: ${m.text}`);

/**
 * The owner's messages carried by the prompt of a continued session (OpenCode or Claude Code):
 * they are read once the agent has started on that prompt (its first step or tool call), and
 * stay waiting if it never does.
 */
export class CarriedMessages {
  private carrying: { ids: number[]; turns: number; calls: number } | undefined;
  private readonly inbox: MessageInbox | undefined;

  constructor(inbox: MessageInbox | undefined) {
    this.inbox = inbox;
  }

  /** The messages waiting now, to put in the next prompt. */
  take(tally: { turns: number; toolCalls: number }): { id: number; text: string }[] {
    const msgs = this.inbox?.waiting() ?? [];
    this.carrying = msgs.length
      ? { ids: msgs.map((m) => m.id), turns: tally.turns, calls: tally.toolCalls }
      : undefined;
    return msgs;
  }

  /** After reading the run's output: the agent started on the prompt, so they are read. */
  check(tally: { turns: number; toolCalls: number }): void {
    const c = this.carrying;
    if (!c || (tally.turns <= c.turns && tally.toolCalls <= c.calls)) return;
    this.carrying = undefined;
    this.inbox?.given(c.ids);
  }

  /** The run ended: what it never started on stays waiting (for the next prompt or trial). */
  drop(): void {
    this.carrying = undefined;
  }
}

/** Hands the usage the tally gathered to `usage`, once each (goal 075). */
export function takeUsage(
  t: { calls: CallUsage[] },
  usage: ((u: CallUsage) => void) | undefined,
): void {
  for (const u of t.calls.splice(0)) usage?.(u);
}

/**
 * The unprivileged users planner calls and model checks run as, under OpenCode or Claude Code.
 * Each has a user of its own, apart from every lane's and from each other's: a run ends by
 * killing its user's processes, so a shared user would let one call's cleanup kill the other's.
 */
export const PLANNER_ROLE: Role = "planner";
export const CHECK_ROLE: Role = "model-check";
