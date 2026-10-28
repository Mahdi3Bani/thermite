import { dirname, join } from "node:path";
import { RESEARCH_WORKER_SYSTEM } from "../../../agents/roles/research-worker.ts";
import { NOTE_USAGE } from "../../../agents/tools/names.ts";
import {
  type ResearchFolderPaths,
  researchCommands,
  researchFolderNote,
} from "../../../agents/tools/research.ts";
import { type LaneLimitValues, laneLimits } from "../../../core/contract.ts";
import { notesInstruction } from "../../../core/journal.ts";
import type { Role, Runner, RunOutcome } from "../../broker/runner.ts";
import { CliCompactions } from "../cli-compaction.ts";
import { mcpLine } from "../mcp-tools.ts";
import { readNew } from "../opencode/events.ts";
import { afterProgramFailure, type FailureCount, failingOf } from "../provider-errors.ts";
import { trialBudget } from "../trial-clock.ts";
import { stopNudging, type TrialResult } from "../worker.ts";
import {
  AFTER_SUBMIT_MS,
  breachError,
  CarriedMessages,
  limitsNote,
  NUDGE,
  ownerLines,
  takeUsage,
  trialEnd,
  turnsUp,
} from "./common.ts";
import type { CliProgram, CliRun, CliSetup, CliTally, CliTrial, CliTrialDeps } from "./program.ts";

/**
 * Sets a program up in its run's area (or its call's folder), as the run's user: relative to that
 * folder, since the user may not walk the harness's directories by name. Undefined when it is set
 * up; else why not.
 */
export async function setUp(
  name: string,
  s: CliSetup,
  runner: Runner,
  at: { role: Role; cwd: string },
): Promise<string | undefined> {
  const r = await runner.run({
    role: at.role,
    argv: ["sh", "-c", s.script, ...(s.args ?? [])],
    cwd: at.cwd,
    timeoutMs: 30_000,
    ...(s.stdin !== undefined ? { stdin: s.stdin } : {}),
    captureBytes: 4096,
  });
  return r.exitCode === 0 ? undefined : `could not set ${name} up: ${r.stderr.slice(-300)}`;
}

/**
 * One run of a program as its run's user, in `cwd`, under the lane's limits. Its output goes to
 * its events file, which the harness follows while it runs.
 */
function startRun<T extends CliTally>(
  p: CliProgram<T>,
  runner: Runner,
  run: CliRun,
  o: {
    cwd: string;
    env: Record<string, string>;
    prompt: string;
    session: string | undefined;
    remaining: number;
    limits: LaneLimitValues;
  },
): Promise<RunOutcome> {
  const exe = p.exe();
  // By its full path, so the broker knows the program's processes from its commands'.
  const argv = [exe ?? p.bin(), ...p.args(run, o.session)];
  const into = ` >> "$${p.eventsVar}" 2>&1`;
  return runner.run({
    role: run.role,
    argv: p.shell ? p.shell(argv, into) : ["sh", "-c", `exec "$@"${into}`, "sh", ...argv],
    cwd: o.cwd,
    env: o.env,
    // The prompt on stdin: one argument holds at most 128 KiB on Linux, and a brief has no such
    // limit (goal 171).
    stdin: p.stdin ? p.stdin(o.prompt, run) : o.prompt,
    // No time limit unless the trial has one (goal 079).
    ...(Number.isFinite(o.remaining) ? { timeoutMs: o.remaining } : {}),
    rssLimitBytes: o.limits.runRssMib * 1024 * 1024,
    // Over the memory limit, the program's commands are killed and the program carries on, as a
    // lane command under Pi would be; the trial ends only if the program alone is over.
    ...(exe ? { spareExe: exe } : {}),
    disk: { path: run.area, limitBytes: o.limits.workspaceMib * 1024 * 1024 },
    nproc: o.limits.processes,
    captureBytes: 4096,
  });
}

/** What a research worker in a program is told about its tools, on top of the research brief. */
function researchPrompt(
  limits: LaneLimitValues,
  brief: string,
  minutes: number | undefined,
  folder: ResearchFolderPaths,
  program: { name: string; memory?: string | undefined },
): string {
  return `${RESEARCH_WORKER_SYSTEM}

Your research tools are commands you run with your shell tool:

${researchCommands()}

Only pages fetched with "thermite-trial research fetch" are archived, and only archived sources can verify a claim: a page you read another way (your own web search, curl, a fetch from code) verifies nothing until you fetch it with that command.

To propose another research task for the run's queue (the planner or the campaign's owner decides whether it is queued; your trial goes on): thermite-trial idea TITLE [--why TEXT] [--family TEXT] [--question N] (N: the index of the question it is about, from 0). A task that only a measurement could settle is refused: record it as a next experiment instead.

${notesInstruction(`with "${NOTE_USAGE}" (KIND: observation, decision, surprise, question, lesson or note; TYPE: run, experiment, attempt, source, claim, finding, round, trial or message; no --about: the run)`)} Field notes are not research notes (add_note), which record what sources say for the report.

${researchFolderNote(folder)} Your shell starts in your working area; use grep, rg and your file tools on the folder.

${limitsNote(limits, program.name, program.memory)}

${brief}${
  minutes !== undefined
    ? `

This trial lasts ${minutes} minutes.`
    : ""
}`;
}

/**
 * One worker trial in a program: its home and configuration in the lane's own area, then the
 * program in the trial's working place until the trial ends.
 *
 * A code trial works in its workspace until the agent submits or the trial's time ends. A run that
 * ends without a submission is continued in the same session, twice at most, and after that for
 * as long as the owner's messages wait and the agent keeps working. A research trial works in its
 * lane's working area of the research folder and ends when the agent stops; a run that ends with
 * the owner's messages waiting is continued with them, for as long as they wait and the agent keeps
 * working. No program takes a message into a running session: a message waits until the run ends,
 * and goes into the continuation's prompt. A run cut short by a provider's failure waits and goes
 * on in its session. A turn cap, when the rig sets one, is kept by counting its turns.
 */
export async function runCliTrial<T extends CliTally>(
  p: CliProgram<T>,
  trial: CliTrial,
  deps: CliTrialDeps,
): Promise<TrialResult> {
  const { spec } = trial;
  const code = trial.mode === "code";
  if (!code && !p.research) throw new Error(`${p.name} runs no research trials`);
  // A research trial makes no submission, and its ends name none.
  const submitted = () => (code ? deps.submitted?.() : undefined);
  const before = code ? " before a submission" : "";
  const area = code ? (trial.spec.workspaceRoot ?? dirname(trial.spec.workspace)) : trial.area;
  const events = join(area, `${p.prefix}-events.jsonl`);
  const tally = p.newTally();
  const result: TrialResult = {
    stopped: code ? "no_submission" : "finished",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const auth = `trial.${spec.token ?? ""}`;
  const title = `Trial ${spec.trialId} (${spec.lane})`;
  const run: CliRun = {
    trialId: spec.trialId,
    role: spec.lane as Role,
    title,
    model: deps.model,
    apiUrl: deps.apiUrl,
    area,
    home: join(area, `${p.prefix}-home`),
    tmp: join(area, `${p.prefix}-tmp`),
    auth,
    mcp: spec.mcpServers?.length
      ? { apiUrl: deps.apiUrl, auth, servers: spec.mcpServers }
      : undefined,
    keptAt: deps.keptAt,
    wallMs: spec.wallMs,
    env: deps.env,
  };
  const env = {
    ...p.env(run),
    // What a code trial's submission takes: the workspace and the paths it may change.
    ...(code
      ? {
          THERMITE_EDITABLE_PATHS: JSON.stringify(trial.spec.editablePaths),
          THERMITE_WORKSPACE: trial.spec.workspace,
        }
      : {}),
    [p.eventsVar]: events,
  };
  // Each compaction the program reported, with its own conversation before it (goal 070).
  const compactions = new CliCompactions({
    title,
    harness: p.name,
    on: deps.compacted,
    own: p.own(run, tally),
  });
  const setupError = await setUp(p.name, p.setup(run), deps.runner, { role: run.role, cwd: area });
  if (setupError) return { ...result, stopped: "error", error: setupError };
  const started = Date.now();
  // A trial's length only when the campaign or the rig sets one (goal 079).
  const deadline = spec.wallMs !== undefined ? started + spec.wallMs : Number.POSITIVE_INFINITY;
  const minutes = spec.wallMs !== undefined ? Math.round(spec.wallMs / 60_000) : undefined;
  // Failed model calls in a row, rate limits in a row, and since when the calls fail (goal 079).
  const count: FailureCount = { failures: 0, rateWaits: 0 };
  const mcp = run.mcp ? `\n\n${mcpLine(run.mcp.servers)}` : "";
  // A research prompt keeps its MCP line last.
  let message = code
    ? `${p.system}${mcp}\n\n${limitsNote(limits, p.name, p.memory)}\n\n${spec.brief}\n\nThe editable paths: ${trial.spec.editablePaths.join(", ")}. ${trialBudget(minutes, spec.maxTurns, p.turnWords, deadline)}`
    : `${researchPrompt(limits, spec.brief, minutes, trial.folder, p)}${mcp}`;
  let offset = 0;
  const carried = new CarriedMessages(deps.messages);
  const pump = () => {
    const r = readNew(events, offset);
    offset = r.next;
    const live = p.read(r.lines, tally);
    if (live.length) deps.live(live);
    compactions.take(live, p.found(tally, { area, count: compactions.count, at: live.length }));
    takeUsage(tally, deps.modelUsage);
    carried.check(tally);
    if (r.lines.length) {
      deps.progress({
        turns: tally.turns,
        tool_calls: tally.toolCalls,
        tokens_in: tally.tokensIn,
        tokens_out: tally.tokensOut,
      });
      const windows = p.windows?.(tally);
      if (windows) deps.usage?.(windows);
    }
  };
  for (let nudges = 0; ; nudges++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.stopped = "wall";
      break;
    }
    const errorsBefore = tally.errors.length;
    const progressBefore = tally.turns + tally.toolCalls;
    const callsBefore = tally.toolCalls;
    const runStarted = Date.now();
    const unready = await p.beforeRun?.(message, run, deps.runner);
    if (unready) {
      result.stopped = "error";
      result.error = unready;
      break;
    }
    const running = startRun(p, deps.runner, run, {
      cwd: code ? trial.spec.workspace : trial.folder.work,
      env,
      prompt: message,
      session: tally.session,
      remaining,
      limits,
    });
    let done = false;
    void running.finally(() => {
      done = true;
    });
    let submittedAt: number | undefined;
    while (!done) {
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 1000));
      pump();
      if (deps.signal?.aborted) {
        await deps.runner.killRole(spec.lane).catch(() => 0);
        break;
      }
      // A submission ends the trial: its command finishes, and the agent's next reply is not waited for.
      // Without one, the trial's turns used up end it (goal 163: code trials keep the cap too).
      if (submitted()) {
        submittedAt ??= Date.now();
        if (Date.now() - submittedAt >= (deps.afterSubmitMs ?? AFTER_SUBMIT_MS))
          await deps.runner.killRole(spec.lane).catch(() => 0);
      } else if (turnsUp(spec, tally)) {
        await deps.runner.killRole(spec.lane).catch(() => 0);
        break;
      }
    }
    const outcome = await running;
    pump();
    if (p.closeRun) {
      p.closeRun(tally);
      takeUsage(tally, deps.modelUsage);
    }
    carried.drop();
    // A run that made progress had calls that worked: the calls no longer fail (goal 079).
    if (tally.turns + tally.toolCalls > progressBefore) count.failing = undefined;
    if (deps.signal?.aborted) {
      result.stopped = "interrupted";
      break;
    }
    // After a submission the trial is over: messages still waiting go to the lane's next trial,
    // which can act on them.
    if (submitted()) break;
    if (turnsUp(spec, tally)) {
      result.stopped = "turns";
      result.error = `the trial reached its limit of ${spec.maxTurns} turns${before}`;
      break;
    }
    const own = p.stopAfterRun?.(tally);
    if (own) {
      Object.assign(result, own);
      break;
    }
    // A memory or disk limit ends the program with everything it ran: say which, with the figures.
    const breach = breachError(outcome, limits, p.name);
    if (breach) {
      result.stopped = "error";
      result.error = breach;
      break;
    }
    if (outcome.killedFor === "timeout" || Date.now() >= deadline) {
      result.stopped = "wall";
      break;
    }
    const progressed = tally.turns + tally.toolCalls > progressBefore;
    // A run that ended with the provider's error (goal 079): by its kind, the trial ends (no
    // credits, a refused key, an unserved model, or the campaign's limit), or waits and goes on
    // in the same session. The failure is not one of the nudges.
    if (tally.errors.length > errorsBefore) {
      if (progressed) count.failures = 0;
      const step = await afterProgramFailure({
        error: tally.errors.at(-1) as string,
        answer: deps.providerAnswer?.(runStarted),
        count,
        failuresInARow: limits.failuresInARow,
        deadline,
        signal: deps.signal,
        waiting: deps.waiting,
        pauseMs: deps.pauseMs,
      });
      if (!("goOn" in step)) {
        Object.assign(result, trialEnd(step));
        break;
      }
      nudges--;
      message = [step.goOn, ...ownerLines(carried.take(tally))].join("\n\n");
      continue;
    }
    if (outcome.exitCode !== 0 && !tally.session) {
      result.stopped = "error";
      result.error = p.exitWords(
        outcome.exitCode ?? outcome.signal,
        tally.notes.at(-1) ?? "no output",
        tally.notes.join("\n"),
      );
      break;
    }
    // A code trial is continued to get a submission (goal 079) for as long as the agent keeps
    // working (a tool call in this run), with no number unless the campaign sets
    // lanes.limits.nudges; a nudge it answers without any work ends the trial, its own choice. The
    // owner's messages continue either trial while they wait and the agent keeps working. A
    // message is read only once the agent starts on the prompt: none is ever dropped.
    const ends = code
      ? stopNudging(nudges, tally.toolCalls > callsBefore, progressed, limits.nudges, deps.messages)
      : !(progressed && deps.messages?.waiting().length);
    if (ends) break;
    message = [code ? NUDGE : "Continue your research.", ...ownerLines(carried.take(tally))].join(
      "\n\n",
    );
  }
  const sub = submitted();
  if (sub) {
    result.submitted = sub;
    result.stopped = "submitted";
  } else if (result.stopped === "wall") {
    result.error = `the trial reached its ${minutes}-minute limit${before}`;
  } else if (result.stopped === "no_submission" && tally.errors.length) {
    result.error = tally.errors.at(-1);
  }
  const failing = failingOf(count);
  if (failing && !sub) result.failing = failing;
  result.turns = tally.turns;
  result.toolCalls = tally.toolCalls;
  result.tokensIn = tally.tokensIn;
  result.tokensOut = tally.tokensOut;
  if (compactions.count) result.compactions = compactions.count;
  return result;
}
