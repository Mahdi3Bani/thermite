import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelCheckProgramPrompt } from "../../agents/roles/model-check.ts";
import { RESEARCH_WORKER_SYSTEM } from "../../agents/roles/research-worker.ts";
import { WORKER_OPENCODE_SYSTEM } from "../../agents/roles/worker.ts";
import { NOTE_USAGE } from "../../agents/tools/names.ts";
import {
  type ResearchFolderPaths,
  researchCommands,
  researchFolderNote,
} from "../../agents/tools/research.ts";
import { type LaneLimitValues, laneLimits } from "../../core/contract.ts";
import { notesInstruction } from "../../core/journal.ts";
import type { LiveKind } from "../../core/live.ts";
import type { CallUsage } from "../../core/usage.ts";
import type { Role, Runner } from "../broker/runner.ts";
import {
  AFTER_SUBMIT_MS,
  agentPath,
  breachError,
  CarriedMessages,
  CHECK_ROLE,
  limitsNote,
  NUDGE,
  ownerLines,
  PLANNER_ROLE,
  takeUsage,
} from "./cli/common.ts";
import {
  CliCompactions,
  compactionTokens,
  type FoundCompaction,
  type KeptAt,
  keptLine,
  type OnCompacted,
  type OnceKeeping,
  reclaim,
} from "./cli-compaction.ts";
import { opencodeEnded, opencodeOwn } from "./cli-conversation.ts";
import type { MessageInbox, TrialProgress } from "./live-session.ts";
import { type McpAccess, mcpLine, opencodeMcp } from "./mcp-tools.ts";
import type { ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import { newTally, type OpencodeTally, readNew, readOpencodeEvents } from "./opencode/events.ts";
import { OPENCODE_BIN, startInArea } from "./opencode/run.ts";

export { OPENCODE_BIN, opencodeBin, opencodeExe } from "./opencode/run.ts";

import {
  afterProgramFailure,
  type FailureCount,
  failingOf,
  type ProviderLink,
} from "./provider-errors.ts";
import type { ResearchTrialSpec } from "./research-worker.ts";
import { trialBudget } from "./trial-clock.ts";
import { type SubmitOutcome, stopNudging, type TrialResult, type TrialSpec } from "./worker.ts";

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

/** This module's own extension: `.js` when built, `.ts` when run from the source. */
const OWN_EXT = extname(fileURLToPath(import.meta.url));
/** Thermite's OpenCode plugin (opencode-plugin.ts, beside this module), which OpenCode loads. */
export const OPENCODE_PLUGIN = fileURLToPath(
  new URL(`./opencode-plugin${OWN_EXT}`, import.meta.url),
);
/** Where OpenCode finds the plugin, under its home: a link in its own settings' plugins folder. */
export const OPENCODE_PLUGIN_LINK = `.config/opencode/plugins/thermite-compaction${OWN_EXT}`;
/** The folder in an OpenCode run's own area where the plugin keeps each compaction's session. */
export const OPENCODE_DROPS = "opencode-compactions";

/**
 * What Thermite's plugin reads from OpenCode's environment (goal 070): its folder, and the line
 * that tells the summary where the harness keeps the conversation.
 */
export function opencodeKeepEnv(drops: string, at: KeptAt): Record<string, string> {
  return { THERMITE_COMPACTION_DROPS: drops, THERMITE_COMPACTION_LINE: keptLine(at) };
}

/**
 * The compactions Thermite's plugin saw end since the last read, given to `c` with the read's live
 * entries (goal 070). OpenCode's own output does not report them; the plugin's records do.
 */
function takeEnded(
  c: CliCompactions,
  root: string,
  drops: string[],
  live: { kind: LiveKind; text: string }[],
): void {
  const found: FoundCompaction[] = opencodeEnded(root, drops)
    .filter((n) => n > c.count)
    .map(() => ({ at: live.length, tokensBefore: null, tokensAfter: null }));
  c.take(live, found);
}

/** The model as OpenCode names it: its own models, or the rig's provider as "thermite". */
export function opencodeModelId(m: ModelConfig): string {
  return m.api === "opencode" ? `opencode/${m.model}` : `thermite/${m.model}`;
}

/**
 * OpenCode's configuration for a run. Nobody answers a question in a headless run, so OpenCode's
 * question tool is denied. A provider other than OpenCode's own is reached through the harness's
 * key-adding proxy (`proxyRoot`), with the run's proxy credential from THERMITE_PROXY_AUTH.
 *
 * Compaction (goal 070): OpenCode compacts its conversation on its own (`compaction.auto`), but
 * only for a model whose window it knows. For the rig's provider, the model's `limit.context` is
 * the route's window (so the owner's cap), and `compaction.buffer`, the tokens it keeps free
 * below that window, puts its compaction point at the route's share. OpenCode's own models keep
 * the windows and the compaction point OpenCode knows for them.
 */
export function opencodeConfig(
  m: ModelConfig,
  proxyRoot: string,
  mcp?: McpAccess | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permissions: [{ action: "question", resource: "*", effect: "deny" }],
  };
  // The MCP servers the run's kit gives this agent (goal 068), each at the harness's gateway.
  const servers = opencodeMcp(mcp);
  if (servers) config.mcp = servers;
  const point = m.api !== "opencode" ? compactionTokens(m) : undefined;
  config.compaction = {
    auto: true,
    ...(point !== undefined ? { buffer: m.contextWindow - point } : {}),
  };
  if (m.api !== "opencode") {
    const anthropic = m.api === "anthropic";
    config.providers = {
      thermite: {
        name: "Thermite route",
        env: ["THERMITE_PROXY_AUTH"],
        // A ChatGPT sign-in: OpenAI's Responses API (OpenCode's own OpenAI provider posts to
        // {base}/responses with store off and the whole history; the proxy drops what the
        // route refuses, such as max_output_tokens).
        package: anthropic
          ? "@opencode/ai/providers/anthropic"
          : m.api === "chatgpt"
            ? "@opencode/ai/providers/openai"
            : "@opencode/ai/providers/openai-compatible",
        // Anthropic's client posts to {base}/messages; its API is at /v1/messages.
        settings: { baseURL: anthropic ? `${proxyRoot}/v1` : proxyRoot },
        models: {
          [m.model]: {
            name: m.model,
            ...(point !== undefined ? { limit: { context: m.contextWindow } } : {}),
          },
        },
      },
    };
  }
  return config;
}

export type { OpencodeTally };
export {
  AFTER_SUBMIT_MS,
  agentPath,
  breachError,
  CarriedMessages,
  CHECK_ROLE,
  limitsNote,
  NUDGE,
  newTally,
  ownerLines,
  PLANNER_ROLE,
  readNew,
  readOpencodeEvents,
  takeUsage,
};

/** What OpenCode itself uses, as its limits note says (Claude Code's says the same, unmeasured). */
export const OPENCODE_MEMORY = "about 500 MiB";

/** Whether a trial used its turns: a cap set by Turns per trial (none unless configured). */
const turnsUp = (spec: { maxTurns?: number | undefined }, tally: OpencodeTally) =>
  spec.maxTurns !== undefined && tally.turns >= spec.maxTurns;

export interface OpencodeTrialDeps extends ProviderLink {
  runner: Runner;
  model: ModelConfig;
  /** The harness API as the lane reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  /** Lines for the live view, and the session's counters. */
  live(entries: { kind: LiveKind; text: string }[]): void;
  progress(p: TrialProgress): void;
  /** The trial's submission, once it has one (from the ledger). */
  submitted(): SubmitOutcome | undefined;
  /**
   * The owner's messages for this trial. OpenCode takes no message into a running session: one
   * waiting when a run ends is given by continuing the session with it, and is read once the
   * agent starts on that prompt.
   */
  messages?: MessageInbox | undefined;
  /** The lane's build caches (ccache and the like). */
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** How often the output is read (tests make it short). */
  pollMs?: number | undefined;
  /** How long the run goes on after a submission (AFTER_SUBMIT_MS; tests make it short). */
  afterSubmitMs?: number | undefined;
  /** Each step's model usage, as OpenCode's output reports it (goal 075). */
  modelUsage?: ((u: CallUsage) => void) | undefined;
  /**
   * Where the harness keeps the conversation before each compaction (goal 070): with it,
   * Thermite's plugin keeps OpenCode's session before each compaction and tells the summary to
   * name the file, and each compaction it sees end is kept and recorded (`compacted`).
   */
  keptAt?: KeptAt | undefined;
  compacted?: OnCompacted | undefined;
}

/** The environment of an OpenCode run: its home, Thermite's command and how to reach the API. */
export function runEnv(home: string, apiUrl: string, auth: string, extra: Record<string, string>) {
  return {
    ...extra,
    HOME: home,
    PATH: agentPath(),
    THERMITE_HARNESS_URL: apiUrl,
    THERMITE_TRIAL_AUTH: auth,
    THERMITE_PROXY_AUTH: auth,
  };
}

/**
 * OpenCode's home, configuration and events file in a lane's area, made as the lane's user; with
 * `keep`, Thermite's compaction plugin linked into its settings and the plugin's folder (goal 070).
 */
async function setUpInArea(
  runner: Runner,
  role: Role,
  area: string,
  model: ModelConfig,
  proxyRoot: string,
  mcp?: McpAccess | undefined,
  keep = false,
): Promise<string | undefined> {
  const setup = await runner.run({
    role,
    // Relative to its own area: the lane may not walk the harness's directories by name. The
    // configuration may hold the trial's own token (its MCP servers): only the lane reads it.
    argv: [
      "sh",
      "-c",
      `mkdir -p opencode-home/.config/opencode opencode-tmp && umask 077 && cat > opencode-home/.config/opencode/opencode.jsonc && : > opencode-events.jsonl && chmod 0644 opencode-events.jsonl${keep ? ` && mkdir -p opencode-home/.config/opencode/plugins ${OPENCODE_DROPS} && chmod 0755 ${OPENCODE_DROPS} && ln -sf "$1" opencode-home/${OPENCODE_PLUGIN_LINK}` : ""}`,
      ...(keep ? ["sh", OPENCODE_PLUGIN] : []),
    ],
    cwd: area,
    timeoutMs: 30_000,
    stdin: JSON.stringify(opencodeConfig(model, proxyRoot, mcp)),
    captureBytes: 4096,
  });
  return setup.exitCode === 0
    ? undefined
    : `could not set OpenCode up: ${setup.stderr.slice(-300)}`;
}

/**
 * One worker trial in OpenCode: its home and configuration in the lane's own area, then
 * `opencode run` in the workspace until the agent submits or the trial's time ends. A run that
 * ends without a submission is continued in the same session, twice at most, as Pi's are, and
 * after that for as long as the owner's messages wait and the agent keeps working. OpenCode
 * takes no message into a running session: a message waits until the run ends without a
 * submission, and goes into the continuation's prompt.
 */
export async function runOpencodeTrial(
  spec: TrialSpec,
  deps: OpencodeTrialDeps,
): Promise<TrialResult> {
  const area = spec.workspaceRoot ?? dirname(spec.workspace);
  const home = join(area, "opencode-home");
  const events = join(area, "opencode-events.jsonl");
  const tmp = join(area, "opencode-tmp");
  const tally = newTally();
  const result: TrialResult = {
    stopped: "no_submission",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const auth = `trial.${spec.token ?? ""}`;
  const proxyRoot = `${deps.apiUrl}/v1/model-proxy`;
  const env = {
    ...runEnv(home, deps.apiUrl, auth, deps.env ?? {}),
    THERMITE_EDITABLE_PATHS: JSON.stringify(spec.editablePaths),
    THERMITE_WORKSPACE: spec.workspace,
    // Its own temp directory: the shared /tmp is not the lane's.
    TMPDIR: tmp,
    THERMITE_OPENCODE_EVENTS: events,
    ...(deps.keptAt ? opencodeKeepEnv(join(area, OPENCODE_DROPS), deps.keptAt) : {}),
  };
  const mcp = spec.mcpServers?.length
    ? { apiUrl: deps.apiUrl, auth, servers: spec.mcpServers }
    : undefined;
  const setupError = await setUpInArea(
    deps.runner,
    spec.lane,
    area,
    deps.model,
    proxyRoot,
    mcp,
    deps.keptAt !== undefined,
  );
  if (setupError) return { ...result, stopped: "error", error: setupError };
  const title = `Trial ${spec.trialId} (${spec.lane})`;
  // Each compaction Thermite's plugin saw end, with the session it kept before it (goal 070).
  const compactions = new CliCompactions({
    title,
    harness: "OpenCode",
    on: deps.compacted,
    own: opencodeOwn({ root: area, drops: [OPENCODE_DROPS], title }),
  });
  const started = Date.now(); // the trial's length only when one is set (goal 079)
  const deadline = spec.wallMs !== undefined ? started + spec.wallMs : Number.POSITIVE_INFINITY;
  const minutes = spec.wallMs !== undefined ? Math.round(spec.wallMs / 60_000) : undefined;
  let message = `${WORKER_OPENCODE_SYSTEM}${mcp ? `\n\n${mcpLine(mcp.servers)}` : ""}\n\n${limitsNote(limits, "OpenCode", OPENCODE_MEMORY)}\n\n${spec.brief}\n\nThe editable paths: ${spec.editablePaths.join(", ")}. ${trialBudget(minutes, undefined, "", deadline)}`;
  // Failed model calls in a row, rate limits in a row, and since when the calls fail (goal 079).
  const count: FailureCount = { failures: 0, rateWaits: 0 };
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
    const args = [
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "--model",
      opencodeModelId(deps.model),
      ...(tally.session ? ["--session", tally.session] : ["--title", `trial ${spec.trialId}`]),
    ];
    const running = startInArea(deps.runner, spec.lane, area, spec.workspace, env, args, {
      prompt: message,
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
      // A stop, or the trial's turns used up (goal 163: code trials keep the cap too), ends it.
      if (deps.signal?.aborted || turnsUp(spec, tally)) {
        await deps.runner.killRole(spec.lane).catch(() => 0);
        break;
      }
      // A submission ends the trial: its command finishes, and the agent's next reply is not waited for.
      if (deps.submitted()) {
        submittedAt ??= Date.now();
        if (Date.now() - submittedAt >= (deps.afterSubmitMs ?? AFTER_SUBMIT_MS))
          await deps.runner.killRole(spec.lane).catch(() => 0);
      }
    }
    const outcome = await running;
    pump();
    carried.drop();
    // A run that made progress had calls that worked: the calls no longer fail (goal 079).
    if (tally.turns + tally.toolCalls > progressBefore) count.failing = undefined;
    if (deps.signal?.aborted) {
      result.stopped = "interrupted";
      break;
    }
    // After a submission the trial is over: messages still waiting go to the lane's next trial,
    // which can act on them.
    if (deps.submitted()) break;
    if (turnsUp(spec, tally)) {
      result.stopped = "turns";
      break;
    }
    // A memory or disk limit ends OpenCode with everything it ran: say which, with the figures.
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
      if ("interrupted" in step) {
        result.stopped = "interrupted";
        break;
      }
      if ("wall" in step) {
        result.stopped = "wall";
        break;
      }
      if ("end" in step) {
        result.stopped = "error";
        result.error = step.end.error;
        result.errorKind = step.end.kind;
        break;
      }
      nudges--;
      message = [step.goOn, ...ownerLines(carried.take(tally))].join("\n\n");
      continue;
    }
    if (outcome.exitCode !== 0 && !tally.session) {
      result.stopped = "error";
      result.error = `OpenCode exited ${outcome.exitCode ?? outcome.signal}: ${tally.notes.at(-1) ?? "no output"}`;
      break;
    }
    // Continued to get a submission (goal 079) for as long as the agent keeps working (a tool
    // call in this run), with no number unless the campaign sets lanes.limits.nudges; a nudge it
    // answers without any work ends the trial, its own choice. The owner's messages continue it
    // while they wait and it keeps working. A message is read only once the agent starts on the
    // prompt.
    if (
      stopNudging(nudges, tally.toolCalls > callsBefore, progressed, limits.nudges, deps.messages)
    )
      break;
    message = [NUDGE, ...ownerLines(carried.take(tally))].join("\n\n");
  }
  const sub = deps.submitted();
  if (sub) {
    result.submitted = sub;
    result.stopped = "submitted";
  } else if (result.stopped === "wall") {
    result.error = `the trial reached its ${minutes}-minute limit before a submission`;
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
  const proxyRoot = `${deps.apiUrl}/v1/model-proxy`;
  const env = {
    ...runEnv(join(area, "opencode-home"), deps.apiUrl, auth, deps.env ?? {}),
    TMPDIR: join(area, "opencode-tmp"),
    THERMITE_OPENCODE_EVENTS: events,
    ...(deps.keptAt ? opencodeKeepEnv(join(area, OPENCODE_DROPS), deps.keptAt) : {}),
  };
  const mcp = spec.mcpServers?.length
    ? { apiUrl: deps.apiUrl, auth, servers: spec.mcpServers }
    : undefined;
  const setupError = await setUpInArea(
    deps.runner,
    role,
    area,
    deps.model,
    proxyRoot,
    mcp,
    deps.keptAt !== undefined,
  );
  if (setupError) return { ...result, stopped: "error", error: setupError };
  const title = `Trial ${spec.trialId} (${spec.lane})`;
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
    const running = startInArea(
      deps.runner,
      role,
      area,
      deps.folder.work,
      env,
      [
        "run",
        "--standalone",
        "--auto",
        "--format",
        "json",
        "--model",
        opencodeModelId(deps.model),
        ...(tally.session ? ["--session", tally.session] : ["--title", `trial ${spec.trialId}`]),
      ],
      { remaining, limits, prompt: message },
    );
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
      if ("interrupted" in step) {
        result.stopped = "interrupted";
        break;
      }
      if ("wall" in step) {
        result.stopped = "wall";
        break;
      }
      if ("end" in step) {
        result.stopped = "error";
        result.error = step.end.error;
        result.errorKind = step.end.kind;
        break;
      }
      message = [step.goOn, ...ownerLines(carried.take(tally))].join("\n\n");
      continue;
    }
    if (outcome.exitCode !== 0 && !tally.session) {
      result.stopped = "error";
      result.error = `OpenCode exited ${outcome.exitCode ?? outcome.signal}: ${tally.notes.at(-1) ?? "no output"}`;
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
  const tally = newTally();
  if (setup.exitCode !== 0) {
    tally.errors.push(`could not set OpenCode up: ${setup.stderr.slice(-300)}`);
    return tally;
  }
  const kill = () => void deps.runner.killRole(deps.role).catch(() => 0);
  deps.signal?.addEventListener("abort", kill, { once: true });
  try {
    const r = await deps.runner.run({
      role: deps.role,
      argv: [
        OPENCODE_BIN,
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
        `OpenCode exited ${r.exitCode ?? r.signal}: ${tally.notes.at(-1) ?? r.stderr.slice(-300)}`,
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
