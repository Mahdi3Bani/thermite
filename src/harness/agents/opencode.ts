import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { modelCheckProgramPrompt } from "../../agents/roles/model-check.ts";
import { RESEARCH_WORKER_SYSTEM } from "../../agents/roles/research-worker.ts";
import { NOTE_USAGE } from "../../agents/tools/names.ts";
import {
  type ResearchFolderPaths,
  researchCommands,
  researchFolderNote,
} from "../../agents/tools/research.ts";
import { type LaneLimitValues, laneLimits } from "../../core/contract.ts";
import { notesInstruction } from "../../core/journal.ts";
import type { LiveKind } from "../../core/live.ts";
import type { Role, Runner } from "../broker/runner.ts";
import {
  agentPath,
  breachError,
  CarriedMessages,
  CHECK_ROLE,
  limitsNote,
  ownerLines,
  PLANNER_ROLE,
  takeUsage,
  trialEnd,
  turnsUp,
} from "./cli/common.ts";
import { runCliTrial, setUp, startRun } from "./cli/loop.ts";
import type { CliRun, CliTrialDeps } from "./cli/program.ts";
import { CliCompactions, type OnceKeeping, reclaim } from "./cli-compaction.ts";
import { opencodeOwn } from "./cli-conversation.ts";
import { type McpAccess, mcpLine } from "./mcp-tools.ts";
import type { ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import { newTally, type OpencodeTally, readNew, readOpencodeEvents } from "./opencode/events.ts";
import {
  OPENCODE_DROPS,
  OPENCODE_MEMORY,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_LINK,
  opencodeConfig,
  opencodeFound,
  opencodeKeepEnv,
  opencodeModelId,
  opencodeProgram,
  runEnv,
} from "./opencode/program.ts";
import { opencodeBin, opencodeExe, opencodeExitWords } from "./opencode/run.ts";
import { afterProgramFailure, type FailureCount, failingOf } from "./provider-errors.ts";
import type { ResearchTrialSpec } from "./research-worker.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";

export {
  OPENCODE_MEMORY,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_LINK,
  opencodeConfig,
  opencodeKeepEnv,
  opencodeModelId,
  runEnv,
} from "./opencode/program.ts";
export { NO_OPENCODE, opencodeBin, opencodeExe, opencodeExitWords } from "./opencode/run.ts";

/**
 * Trials (hill-climb, goal and research), model checks and planner calls in OpenCode v2 instead
 * of Pi. OpenCode runs headless with its permissions approved (`--auto`) as the lane's own user,
 * in the lane's workspace, under the same memory, disk and time limits as the lane's commands: it
 * has exactly the lane's access, and none of the judge's. Its permission rules are not a boundary
 * (its Code Mode reaches the network whatever they say); the user it runs as is.
 *
 * Thermite's own tools are the `thermite-trial` command (submit, dev-run, status, and a research
 * trial's tools), which calls the harness API with the trial's token. A provider's key never
 * reaches the lane: OpenCode calls the provider through the harness API's model proxy, which
 * checks the trial's token and adds the key. OpenCode's own models (its free ones) need no key.
 */

export const TRIAL_CLI = "thermite-trial";

/**
 * The compactions Thermite's plugin saw end since the last read, given to `c` with the read's live
 * entries (goal 070).
 */
function takeEnded(
  c: CliCompactions,
  root: string,
  drops: string[],
  live: { kind: LiveKind; text: string }[],
): void {
  c.take(live, opencodeFound(root, drops, c.count, live.length));
}

export type { OpencodeTally };
export {
  agentPath,
  breachError,
  CHECK_ROLE,
  limitsNote,
  newTally,
  PLANNER_ROLE,
  readOpencodeEvents,
  takeUsage,
};

export type OpencodeTrialDeps = CliTrialDeps;

/** One worker trial in OpenCode: the CLI trial loop (cli/loop.ts) with OpenCode's entry. */
export function runOpencodeTrial(spec: TrialSpec, deps: OpencodeTrialDeps): Promise<TrialResult> {
  return runCliTrial(opencodeProgram, spec, deps);
}

/** What a research worker in OpenCode is told about its tools, on top of the research brief. */
export function researchPrompt(
  limits: LaneLimitValues,
  brief: string,
  minutes: number | undefined,
  folder: ResearchFolderPaths,
): string {
  return `${RESEARCH_WORKER_SYSTEM}

Your research tools are commands you run with your shell tool:

${researchCommands()}

Only pages fetched with "thermite-trial research fetch" are archived, and only archived sources can verify a claim: a page you read another way (your own web search, curl, a fetch from code) verifies nothing until you fetch it with that command.

To propose another research task for the run's queue (the planner or the campaign's owner decides whether it is queued; your trial goes on): thermite-trial idea TITLE [--why TEXT] [--family TEXT] [--question N] (N: the index of the question it is about, from 0). A task that only a measurement could settle is refused: record it as a next experiment instead.

${notesInstruction(`with "${NOTE_USAGE}" (KIND: observation, decision, surprise, question, lesson or note; TYPE: run, experiment, attempt, source, claim, finding, round, trial or message; no --about: the run)`)} Field notes are not research notes (add_note), which record what sources say for the report.

${researchFolderNote(folder)} Your shell starts in your working area; use grep, rg and your file tools on the folder.

${limitsNote(limits, "OpenCode", OPENCODE_MEMORY)}

${brief}${
  minutes !== undefined
    ? `

This trial lasts ${minutes} minutes.`
    : ""
}`;
}

export interface OpencodeResearchDeps extends Omit<OpencodeTrialDeps, "submitted"> {
  /** The trial's own area in the lane (owned by its user): OpenCode's home, temporary files, events. */
  area: string;
  /** The run's research folder; the agent works in its lane's working area there. */
  folder: ResearchFolderPaths;
}

/**
 * One research trial in OpenCode: the same tools as a hill-climb trial (its shell, files and web
 * search) plus the research tools as `thermite-trial research` commands, which reach the
 * harness's research service with the trial's token. As in Pi, the trial ends when the agent
 * stops, its time or turns run out, or it is stopped. A run cut short by a failure after some
 * work is continued in its session, twice at most; one that ends with the owner's messages
 * waiting is continued with them, for as long as messages wait and the agent keeps working.
 */
export async function runOpencodeResearchTrial(
  spec: ResearchTrialSpec,
  deps: OpencodeResearchDeps,
): Promise<TrialResult> {
  const role = spec.lane as Role;
  const area = deps.area;
  const events = join(area, "opencode-events.jsonl");
  const tally = newTally();
  const result: TrialResult = {
    stopped: "finished",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const auth = `trial.${spec.token ?? ""}`;
  const title = `Trial ${spec.trialId} (${spec.lane})`;
  const mcp = spec.mcpServers?.length
    ? { apiUrl: deps.apiUrl, auth, servers: spec.mcpServers }
    : undefined;
  // OpenCode's run as its entry sees it (opencode/program.ts), in the trial's own area.
  const run: CliRun = {
    trialId: spec.trialId,
    role,
    title,
    model: deps.model,
    apiUrl: deps.apiUrl,
    area,
    home: join(area, "opencode-home"),
    tmp: join(area, "opencode-tmp"),
    auth,
    mcp,
    keptAt: deps.keptAt,
    wallMs: spec.wallMs,
    env: deps.env,
  };
  const env = {
    ...runEnv(run.home, deps.apiUrl, auth, deps.env ?? {}),
    TMPDIR: run.tmp,
    THERMITE_OPENCODE_EVENTS: events,
    ...(deps.keptAt ? opencodeKeepEnv(join(area, OPENCODE_DROPS), deps.keptAt) : {}),
  };
  const setupError = await setUp(opencodeProgram, deps.runner, run);
  if (setupError) return { ...result, stopped: "error", error: setupError };
  // Each compaction Thermite's plugin saw end, with the session it kept before it (goal 070).
  const compactions = new CliCompactions({
    title,
    harness: "OpenCode",
    on: deps.compacted,
    own: opencodeOwn({ root: area, drops: [OPENCODE_DROPS], title }),
  });
  // A trial's length only when the campaign or the rig sets one (goal 079).
  const deadline = spec.wallMs !== undefined ? Date.now() + spec.wallMs : Number.POSITIVE_INFINITY;
  const minutes = spec.wallMs !== undefined ? Math.round(spec.wallMs / 60_000) : undefined;
  let message = `${researchPrompt(limits, spec.brief, minutes, deps.folder)}${mcp ? `\n\n${mcpLine(mcp.servers)}` : ""}`;
  let offset = 0;
  const carried = new CarriedMessages(deps.messages);
  const pump = () => {
    const r = readNew(events, offset);
    offset = r.next;
    const live = readOpencodeEvents(r.lines, tally);
    if (live.length) deps.live(live);
    takeEnded(compactions, area, [OPENCODE_DROPS], live);
    takeUsage(tally, deps.modelUsage);
    carried.check(tally);
    if (r.lines.length)
      deps.progress({
        turns: tally.turns,
        tool_calls: tally.toolCalls,
        tokens_in: tally.tokensIn,
        tokens_out: tally.tokensOut,
      });
  };
  const capped = () => turnsUp(spec, tally);
  // Failed model calls in a row, rate limits in a row, and since when the calls fail (goal 079).
  const count: FailureCount = { failures: 0, rateWaits: 0 };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.stopped = "wall";
      break;
    }
    const errorsBefore = tally.errors.length;
    const callsBefore = tally.toolCalls;
    const turnsBefore = tally.turns;
    const runStarted = Date.now();
    const running = startRun(opencodeProgram, deps.runner, run, {
      cwd: deps.folder.work,
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
    while (!done) {
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 1000));
      pump();
      // A cap on the trial's turns (none unless configured) or a stop ends OpenCode at once.
      if (deps.signal?.aborted || capped()) {
        await deps.runner.killRole(role).catch(() => 0);
        break;
      }
    }
    const outcome = await running;
    pump();
    carried.drop();
    // A run that made progress had calls that worked: the calls no longer fail (goal 079).
    if (tally.turns > turnsBefore || tally.toolCalls > callsBefore) count.failing = undefined;
    if (deps.signal?.aborted) {
      result.stopped = "interrupted";
      break;
    }
    if (capped()) {
      result.stopped = "turns";
      result.error = `the trial reached its limit of ${spec.maxTurns} turns`;
      break;
    }
    const breach = breachError(outcome, limits, "OpenCode");
    if (breach) {
      result.stopped = "error";
      result.error = breach;
      break;
    }
    if (outcome.killedFor === "timeout" || Date.now() >= deadline) {
      result.stopped = "wall";
      break;
    }
    const progressed = tally.turns > turnsBefore || tally.toolCalls > callsBefore;
    // A run that ended with the provider's error (goal 079): by its kind, the trial ends (no
    // credits, a refused key, an unserved model, or the campaign's limit), or waits and goes on
    // in the same session.
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
      message = [step.goOn, ...ownerLines(carried.take(tally))].join("\n\n");
      continue;
    }
    if (outcome.exitCode !== 0 && !tally.session) {
      result.stopped = "error";
      result.error = opencodeExitWords(
        outcome.exitCode ?? outcome.signal,
        tally.notes.at(-1) ?? "no output",
      );
      break;
    }
    // Continued for as long as the owner's messages wait and the agent keeps working. Messages
    // are taken only for a run that starts, and read only once the agent starts on that prompt:
    // none is ever dropped.
    const owner = progressed ? (deps.messages?.waiting().length ?? 0) : 0;
    if (!owner) break;
    message = ["Continue your research.", ...ownerLines(carried.take(tally))].join("\n\n");
  }
  if (result.stopped === "wall") result.error = `the trial reached its ${minutes}-minute limit`;
  const failing = failingOf(count);
  if (failing) result.failing = failing;
  result.turns = tally.turns;
  result.toolCalls = tally.toolCalls;
  result.tokensIn = tally.tokensIn;
  result.tokensOut = tally.tokensOut;
  if (compactions.count) result.compactions = compactions.count;
  return result;
}

export interface OpencodeAskDeps {
  runner: Runner;
  model: ModelConfig;
  apiUrl: string;
  /** A short-lived credential the model proxy accepts (none needed for OpenCode's own models). */
  proxyAuth: string;
  /** An unprivileged role to run as, and an empty directory to run in (owned by that role). */
  role: Role;
  dir: string;
  /** None unless given: a planner call runs until it answers or its run stops (goal 079). */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** The MCP servers the call may use (a planner's), at the harness's gateway. */
  mcp?: McpAccess | undefined;
  /** Where its conversation is kept before each compaction, and who records it (goal 070). */
  compaction?: OnceKeeping | undefined;
}

/**
 * One prompt through OpenCode outside a trial (a model check, a planner call), as an
 * unprivileged agent user in an empty directory. Returns what OpenCode's output said.
 */
export async function opencodeAsk(prompt: string, deps: OpencodeAskDeps): Promise<OpencodeTally> {
  const home = join(deps.dir, "home");
  const keeping = deps.compaction;
  const env = {
    ...runEnv(home, deps.apiUrl, deps.proxyAuth, {}),
    TMPDIR: join(deps.dir, "tmp"),
    // Thermite's compaction plugin, when the call's conversation is kept (goal 070).
    ...(keeping ? opencodeKeepEnv(join(deps.dir, "compactions"), keeping.keptAt) : {}),
  };
  const tally = newTally();
  const kill = () => void deps.runner.killRole(deps.role).catch(() => 0);
  deps.signal?.addEventListener("abort", kill, { once: true });
  try {
    const setup = await deps.runner.run({
      role: deps.role,
      argv: [
        "sh",
        "-c",
        `mkdir -p home/.config/opencode tmp && umask 077 && cat > home/.config/opencode/opencode.jsonc${keeping ? ` && mkdir -p home/.config/opencode/plugins compactions && ln -sf "$1" home/${OPENCODE_PLUGIN_LINK}` : ""}`,
        ...(keeping ? ["sh", OPENCODE_PLUGIN] : []),
      ],
      cwd: deps.dir,
      timeoutMs: 30_000,
      stdin: JSON.stringify(opencodeConfig(deps.model, `${deps.apiUrl}/v1/model-proxy`, deps.mcp)),
      captureBytes: 4096,
    });
    if (setup.exitCode !== 0) {
      tally.errors.push(`could not set OpenCode up: ${setup.stderr.slice(-300)}`);
      return tally;
    }
    // A call stopped before its run starts nothing, and answers with nothing.
    if (deps.signal?.aborted) return tally;
    const r = await deps.runner.run({
      role: deps.role,
      argv: [
        opencodeExe() ?? opencodeBin(),
        "run",
        "--standalone",
        "--auto",
        "--format",
        "json",
        "--model",
        opencodeModelId(deps.model),
      ],
      // The prompt on stdin, as a trial's.
      stdin: prompt,
      cwd: deps.dir,
      env,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      captureBytes: 8 * 1024 * 1024,
    });
    const live = readOpencodeEvents(r.stdout.split("\n"), tally);
    // Each compaction the plugin saw end, kept and recorded once the call is over (goal 070):
    // the controller takes the call's folder back to read the plugin's records.
    if (keeping) {
      await reclaim(deps.runner, deps.dir);
      takeEnded(
        new CliCompactions({
          title: keeping.title,
          harness: "OpenCode",
          on: keeping.compacted,
          own: opencodeOwn({ root: deps.dir, drops: ["compactions"], title: keeping.title }),
        }),
        deps.dir,
        ["compactions"],
        live,
      );
    }
    if (r.killedFor === "timeout")
      tally.errors.push(`no answer in ${Math.round((deps.timeoutMs ?? 0) / 1000)} s`);
    else if (r.exitCode !== 0 && !tally.errors.length)
      tally.errors.push(
        opencodeExitWords(r.exitCode ?? r.signal, tally.notes.at(-1) ?? r.stderr.slice(-300)),
      );
  } finally {
    deps.signal?.removeEventListener("abort", kill);
  }
  return tally;
}

export interface OpencodeOnceDeps {
  runner: Runner;
  apiUrl: string;
  scratchDir: string;
  /** A credential for the harness's model proxy; `model`: the route it reaches (else the workers'). */
  mintProxyToken(model?: ModelConfig): string;
}

/** One prompt through OpenCode as `role`, in a fresh directory of its own, removed afterwards. */
export async function opencodeOnce(
  model: ModelConfig,
  prompt: string,
  deps: OpencodeOnceDeps,
  o: {
    role: Role;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    /** The MCP servers the call may use, and the gateway's credential for them (a planner's). */
    mcp?: Omit<McpAccess, "apiUrl"> | undefined;
    /** Where its conversation is kept before each compaction, and who records it (goal 070). */
    compaction?: OnceKeeping | undefined;
  },
): Promise<OpencodeTally> {
  // OpenCode finds its home by name, so the directory must be reachable by name: under the lanes'
  // area, not the controller's own (which only its processes may walk).
  const parent = join(deps.scratchDir, "lanes", "opencode-ask");
  mkdirSync(parent, { recursive: true, mode: 0o711 });
  chmodSync(parent, 0o711);
  const dir = join(parent, randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  await deps.runner.handOver(dir, o.role);
  try {
    return await opencodeAsk(prompt, {
      runner: deps.runner,
      model,
      apiUrl: deps.apiUrl,
      proxyAuth: deps.mintProxyToken(model),
      role: o.role,
      dir,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      ...(o.mcp?.servers.length ? { mcp: { apiUrl: deps.apiUrl, ...o.mcp } } : {}),
      ...(o.compaction ? { compaction: o.compaction } : {}),
    });
  } finally {
    await deps.runner.remove(dir).catch(() => undefined);
  }
}

/**
 * The model check in OpenCode: the model must run one shell command through OpenCode's own tool
 * and the command's output must come back, as a trial's tool calls would.
 */
export async function opencodeModelCheck(
  model: ModelConfig,
  deps: OpencodeOnceDeps,
  timeoutMs = 120_000,
): Promise<RigCheckReport> {
  const word = `thermite-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const t = await opencodeOnce(model, modelCheckProgramPrompt(word), deps, {
    role: CHECK_ROLE,
    timeoutMs,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const called = t.tools.some((x) => x.ok && x.output.includes(word));
  const detail = {
    harness: "opencode",
    model: model.model,
    base_url: model.api === "opencode" ? "opencode" : model.baseUrl,
    seconds,
    tool_called: called,
    tokens_in: t.tokensIn,
    tokens_out: t.tokensOut,
    error: t.errors.at(-1) ?? null,
    text: t.lastText.slice(0, 300) || null,
  };
  if (called)
    return {
      ok: true,
      summary: `${model.model} answered with a correct tool call in ${seconds} s (OpenCode)`,
      detail,
    };
  const why = t.errors.length
    ? t.errors.at(-1)
    : t.toolCalls
      ? "its tool call did not print the word"
      : `no tool call${t.lastText ? `; it wrote: ${t.lastText.slice(0, 200)}` : ""}`;
  return {
    ok: false,
    summary: `${model.model} failed the tool-call check in OpenCode: ${why}`,
    detail,
  };
}
