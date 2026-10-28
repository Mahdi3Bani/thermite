import { Agent } from "@earendil-works/pi-agent-core";
import { Compactor, summarizer } from "../../../agents/compaction/index.ts";
import { mcpLine } from "../../../agents/mcp/index.ts";
import { buildModel, PiMeter } from "../../../agents/model/index.ts";
import { WORKER_PI_NOTES, WORKER_PI_SYSTEM } from "../../../agents/roles/worker.ts";
import { NoteLimit } from "../../../agents/tools/notes.ts";
import { errorText } from "../../../common/errors.ts";
import { laneLimits } from "../../../core/contract.ts";
import { linkSession } from "../live-session.ts";
import {
  classifyProviderError,
  type FailureCount,
  failingOf,
  ProviderWatch,
} from "../provider-errors.ts";
import { guardRepeats } from "../repeats.ts";
import { TrialClock, trialBudget } from "../trial-clock.ts";
import { keepGoing, lastAssistant, NUDGE } from "./keep-going.ts";
import type { TrialDeps, TrialResult, TrialSpec } from "./spec.ts";
import { watchedStream, withoutPastThinking } from "./stream.ts";
import { trialTools } from "./tools.ts";

export {
  type KeepGoingOptions,
  keepGoing,
  stopNudging,
  type TrialEnd,
} from "./keep-going.ts";
export type {
  CompactionLink,
  McpForAgent,
  ProviderWait,
  SubmitOutcome,
  TrialDeps,
  TrialResult,
  TrialSpec,
} from "./spec.ts";
export { watchedStream, withoutPastThinking } from "./stream.ts";

/**
 * One worker trial: a fresh agent session (Pi) with Thermite's tools, in the lane's own
 * workspace, ending with at most one submission. Every tool acts as the lane's user through the
 * broker; the agent never touches the judge, the ledger or the model key. No state survives
 * the trial except what the harness records.
 *
 * Its parts are modules in worker/: what a trial takes and gives (spec.ts), its tools (tools.ts),
 * what goes to the provider (stream.ts), and how the trial goes on until it ends (keep-going.ts).
 */

export async function runTrial(spec: TrialSpec, deps: TrialDeps): Promise<TrialResult> {
  const result: TrialResult = {
    stopped: "no_submission",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };

  // Without the contract's limits: the defaults (the server enforces the contract's own).
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const clock = new TrialClock(spec.wallMs); // the trial's length, when it has one (goal 144)
  const notes = new NoteLimit(limits.notesPerTurn); // the notes of one reply (goal 147)
  const tools = trialTools(spec, deps, result, { limits, clock, notes });

  const { models, model, thinkingLevel } = buildModel(deps.model);
  // Each model call's usage, the compaction summaries' included (goal 075).
  const meter = deps.modelUsage ? new PiMeter(deps.modelUsage) : undefined;
  // The provider's error answers, for a rate limit's time (goal 079).
  const watch = new ProviderWatch();
  const agent = new Agent({
    initialState: {
      systemPrompt: `${WORKER_PI_SYSTEM}\n\n${WORKER_PI_NOTES}${deps.mcp?.tools.length ? `\n\n${mcpLine([...new Set(deps.mcp.tools.map((t) => t.server))])}` : ""}`,
      model,
      tools: clock.wrap(guardRepeats(tools, () => compactor.count)),
      thinkingLevel,
    },
    streamFn: watchedStream(models, watch, meter),
    convertToLlm: withoutPastThinking,
    // One tool call at a time: lane processes are killed by user when a tool finishes, so parallel
    // calls would kill each other, and a submission must end the trial before anything else runs.
    toolExecution: "sequential",
  });
  meter?.watch(agent);
  // Near the model's window the conversation is compacted and the trial goes on (goal 070): a
  // conversation that grows never ends a trial nor asks for an early submission.
  const compactor = new Compactor({
    window: deps.model.contextWindow,
    at: deps.model.compactAt,
    convert: withoutPastThinking,
    summarize: summarizer(deps.model, meter),
    keep: async (n, markdown) => {
      if (!deps.compaction) throw new Error("this trial has no place to keep it");
      const { path } = await deps.compaction.keep(n, markdown);
      return {
        path,
        read: `Read it with the run tool when you need a detail, for example grep -n 'a word' ${path} or sed -n '1,200p' ${path}`,
      };
    },
    done: async (r) => deps.compaction?.done(r),
    stop: (reason) => {
      if (result.submitted) return;
      result.stopped = "context";
      result.error = reason;
      agent.abort();
    },
    title: `Trial ${spec.trialId} (${spec.lane})`,
  });
  agent.prepareRequest = compactor.hook(agent);
  // A budget the campaign or the rig set is stated up front, and the worker is told once when it
  // is nearly spent, so a trial ends with its best change submitted rather than cut off with
  // nothing. Without one, a trial lasts until it submits or stops (goal 079).
  const { started, wallMs } = clock;
  const minutes = wallMs !== undefined ? Math.round(wallMs / 60_000) : undefined;
  let warned = false;
  const warn = (why: string) => {
    if (warned || result.submitted) return;
    warned = true;
    agent.steer({
      role: "user",
      content: `${why} Build and test what you have, then submit your best working change now, listing anything unfinished in known_flaws. A trial that ends without a submission is lost. If this trial measures rather than changes the code, record what you measured now as notes, with the numbers, before you start another measurement: what a trial does not record is lost when it ends.`,
      timestamp: Date.now(),
    });
  };
  const maxTurns = spec.maxTurns;
  const warnTurns = maxTurns === undefined ? undefined : Math.max(1, maxTurns - 10);
  agent.subscribe((event) => {
    if (event.type === "turn_end") {
      result.turns++;
      notes.reset();
      const usage = (event.message as { usage?: { input?: number; output?: number } }).usage;
      result.tokensIn += usage?.input ?? 0;
      result.tokensOut += usage?.output ?? 0;
      if (maxTurns !== undefined && result.turns >= maxTurns && !result.submitted) {
        result.stopped = "turns";
        agent.abort();
      } else if (maxTurns !== undefined && warnTurns !== undefined && result.turns >= warnTurns) {
        warn(`${maxTurns - result.turns} turns are left in this trial.`);
      } else if (wallMs !== undefined && Date.now() - started >= wallMs * 0.85) {
        warn(clock.leftWords());
      }
    }
  });
  // After the turn cap above: the owner's messages are not fetched on the turn it stops. After a
  // submission none are taken either: the trial is over, and the lane's next trial, which can
  // act on them, reads them in its brief.
  const link = deps.link;
  const waiting = link?.messages;
  if (link)
    linkSession(agent, {
      ...link,
      messages: waiting ? async () => (result.submitted ? [] : waiting()) : undefined,
    });
  const wall =
    wallMs !== undefined
      ? setTimeout(() => {
          if (!result.submitted) result.stopped = "wall";
          agent.abort();
        }, wallMs)
      : undefined;
  // The trial's failed model calls in a row, and since when (goal 079), over all its replies.
  const failures: FailureCount = { failures: 0, rateWaits: 0 };
  try {
    await agent.prompt(
      `${spec.brief}\n\n${trialBudget(minutes, maxTurns, "each model reply is one", wallMs === undefined ? undefined : started + wallMs)}`,
    );
    // A model that stops of its own accord without submitting is told to go on (goal 079): for
    // as long as it keeps working (a tool call since the last nudge), with no number unless the
    // campaign sets lanes.limits.nudges. A nudge it answers without any work ends the trial, its
    // own choice; the lane's next one starts afresh. Cut-off replies and failed calls never end
    // it (keepGoing).
    let nudges = 0;
    let callsAtNudge = -1;
    for (;;) {
      const end = await keepGoing(
        agent,
        () => result.submitted !== undefined || result.stopped !== "no_submission",
        deps.model.contextWindow,
        compactor,
        {
          failuresInARow: spec.limits?.failuresInARow,
          cutoffsInARow: spec.limits?.cutoffsInARow,
          watch,
          onWait: deps.waiting,
          count: failures,
        },
      );
      if (end && !result.submitted) {
        result.stopped = end.stopped;
        result.error = end.error;
        if (end.kind) result.errorKind = end.kind;
        break;
      }
      if (result.submitted || result.stopped !== "no_submission") break;
      if (nudges > 0 && result.toolCalls === callsAtNudge) break;
      if (spec.limits?.nudges !== undefined && nudges >= spec.limits.nudges) break;
      nudges++;
      callsAtNudge = result.toolCalls;
      await agent.prompt(NUDGE);
    }
  } catch (err) {
    if (result.stopped === "no_submission") {
      result.stopped = "error";
      result.error = errorText(err);
    }
  } finally {
    if (wall) clearTimeout(wall);
  }
  if (compactor.count) result.compactions = compactor.count;
  // Why the model stopped, for a trial that ended without a submission. A trial stopped at its
  // own turn or time limit says so, and one whose conversation does not fit even compacted has
  // its reason already; the call the stop aborted is not the model's error.
  const last = lastAssistant(agent);
  if (!result.submitted && (result.stopped === "turns" || result.stopped === "wall")) {
    result.error =
      result.stopped === "turns"
        ? `the trial reached its limit of ${maxTurns} turns before a submission`
        : `the trial reached its ${minutes}-minute limit before a submission`;
  } else if (!result.submitted && !result.error && last && last.stopReason !== "toolUse") {
    result.error = `the model stopped (${last.stopReason})${last.errorMessage ? `: ${last.errorMessage.slice(0, 300)}` : ""}`;
    if (last.stopReason === "error" && result.stopped === "no_submission") {
      result.stopped = "error";
      result.errorKind ??= classifyProviderError(last.errorMessage ?? "").kind;
    }
  }
  const failing = failingOf(failures);
  if (failing && !result.submitted) result.failing = failing;
  return result;
}
