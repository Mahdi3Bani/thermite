import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTE_USAGE } from "../../agents/tools/names.ts";
import {
  CODE_RESEARCH_TOOLS,
  codeResearchNote,
  RESEARCH_SYSTEM,
  type ResearchFolderPaths,
  researchCommands,
  researchFolderNote,
} from "../../agents/tools/research.ts";
import { type LaneLimitValues, laneLimits } from "../../core/contract.ts";
import { notesInstruction } from "../../core/journal.ts";
import { type LiveKind, summarizeArgs } from "../../core/live.ts";
import { type CallUsage, callUsage } from "../../core/usage.ts";
import type { Role, Runner, RunOutcome } from "../broker/runner.ts";
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

/** OpenCode's binary: THERMITE_OPENCODE_BIN, else `opencode` on the PATH (read when used). */
export const opencodeBin = () => process.env.THERMITE_OPENCODE_BIN ?? "opencode";
export const OPENCODE_BIN = opencodeBin();
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

/** What OpenCode's JSON output has said so far. */
export interface OpencodeTally {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON (it prints startup errors that way). */
  notes: string[];
  /** Each step's model usage, since they were last taken (goal 075). */
  calls: CallUsage[];
  /** The step under way: when it started, its first part's start, and whether it ran a tool. */
  step?: { start: number | undefined; first: number | undefined; tools: boolean } | undefined;
}

export const newTally = (): OpencodeTally => ({
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: [],
  lastText: "",
  tools: [],
  notes: [],
  calls: [],
});

type Event = {
  type?: string;
  /** When OpenCode recorded the event (ms). */
  timestamp?: number;
  sessionID?: string;
  part?: {
    text?: string;
    tool?: string;
    /** A text's or reasoning's start and end (ms). */
    time?: { start?: number; end?: number };
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
      time?: { start?: number; end?: number };
    };
    /** OpenCode's TokenUsage.Info: input not cached, visible output, reasoning, cache. */
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  error?: { message?: string; type?: string };
};

const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);

/** A part of the step under way began at `at`: the step's first token is the earliest. */
function partAt(t: OpencodeTally, at: unknown): void {
  const n = num(at);
  if (t.step && n !== undefined) t.step.first = Math.min(t.step.first ?? n, n);
}

/**
 * A step's usage (goal 075), from OpenCode's step_finish and the lines before it. OpenCode's own
 * tokens leave the cache out of `input` and the reasoning out of `output`, so they are added back:
 * in counts every input token, out every output token. A step ends only after the tools it ran,
 * so its time is a model call's only for a step that ran none; the first token is the earliest
 * text, reasoning or tool call the step began.
 */
function stepUsage(t: OpencodeTally, e: Event): CallUsage | undefined {
  const k = e.part?.tokens;
  if (!k) return undefined;
  const s = t.step;
  const end = num(e.timestamp);
  const start = s?.start ?? end ?? Date.now();
  const read = num(k.cache?.read);
  const write = num(k.cache?.write) ?? 0;
  const reasoning = num(k.reasoning);
  return callUsage({
    at: start,
    calls: 1,
    tokensIn: (k.input ?? 0) + (read !== undefined ? read + write : 0),
    cachedIn: read ?? null,
    tokensOut: (k.output ?? 0) + (reasoning ?? 0),
    reasoning: reasoning ?? null,
    firstTokenMs:
      s?.start !== undefined && s.first !== undefined && s.first >= s.start
        ? s.first - s.start
        : null,
    callMs: s?.start !== undefined && end !== undefined && !s.tools ? end - s.start : null,
  });
}

/** Reads lines of OpenCode's JSON output into the tally; returns them as live-view lines. */
export function readOpencodeEvents(
  lines: string[],
  t: OpencodeTally,
): { kind: LiveKind; text: string }[] {
  const live: { kind: LiveKind; text: string }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      t.notes = [...t.notes, line.slice(0, 500)].slice(-5);
      continue;
    }
    if (e.sessionID) t.session = e.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case "step_start":
        t.step = { start: num(e.timestamp), first: undefined, tools: false };
        break;
      case "text":
        partAt(t, p.time?.start);
        if (p.text) {
          t.lastText = p.text;
          live.push({ kind: "text", text: p.text.slice(0, 8000) });
        }
        break;
      case "reasoning":
        partAt(t, p.time?.start);
        break;
      case "tool_use": {
        t.toolCalls++;
        if (t.step) t.step.tools = true;
        partAt(t, p.state?.time?.start);
        const tool = String(p.tool ?? "tool");
        const st = p.state ?? {};
        const ok = st.status === "completed";
        const output = String(st.output ?? st.error ?? "");
        t.tools.push({ tool, output: output.slice(0, 4000), ok });
        live.push({ kind: "tool", text: `${tool} ${summarizeArgs(st.input)}`.slice(0, 8000) });
        live.push({
          kind: "result",
          text: `${tool}${ok ? "" : " failed"}: ${output.slice(0, 1200)}`,
        });
        break;
      }
      case "step_finish": {
        t.turns++;
        t.tokensIn += p.tokens?.input ?? 0;
        t.tokensOut += (p.tokens?.output ?? 0) + (p.tokens?.reasoning ?? 0);
        const u = stepUsage(t, e);
        if (u) t.calls.push(u);
        t.step = undefined;
        break;
      }
      case "error": {
        const message = String(e.error?.message ?? e.error?.type ?? "error").slice(0, 500);
        t.errors.push(message);
        live.push({ kind: "text", text: `(OpenCode: ${message})` });
        break;
      }
    }
  }
  return live;
}

/** Reads what a growing file gained since `from`: whole lines only. */
export function readNew(path: string, from: number): { lines: string[]; next: number } {
  if (!existsSync(path)) return { lines: [], next: from };
  const size = statSync(path).size;
  if (size <= from) return { lines: [], next: from };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return { lines: [], next: from };
    return {
      lines: text.slice(0, end).split("\n"),
      next: from + Buffer.byteLength(text.slice(0, end + 1)),
    };
  } finally {
    closeSync(fd);
  }
}

export const SYSTEM = `You are a research worker in an automated research harness, working in a git repository
in your current directory. You get one assignment and one trial. Read the code, make a focused
change that follows your assignment, build and test it, then submit it exactly once:

  thermite-trial submit --hypothesis "what you changed and why it should help" [--claim "what you expect the judge to find"] [--flaw "anything wrong or limited"]...

A separate judge you cannot see or change measures your change; your own timings only guide you.
Keep your change inside the editable paths. If you find a flaw in your own change, list it with
--flaw: hiding it is worse than a smaller result. Submitting ends the trial.

Other commands: "thermite-trial dev-run [--timeout SECONDS] -- COMMAND" runs a command on the
measurement device (for example a GPU) when the judge is not using it; "thermite-trial status
ATTEMPT" shows how the judge decided an attempt; "thermite-trial idea TITLE [--why TEXT]
[--family TEXT]" proposes another experiment worth trying for the run's queue (the planner
decides whether it is queued; your trial goes on).

${notesInstruction(`with "${NOTE_USAGE}" (KIND: observation, decision, surprise, question, lesson or note; TYPE: run, experiment, attempt, source, claim, finding, round, trial or message; no --about: the run)`)}

${codeResearchNote('with "thermite-trial research fetch URL"')} The research commands:

${researchCommands(CODE_RESEARCH_TOOLS)}

Your shell tool stops a command after two minutes unless you set its timeout: for a long build or
test, set timeout to 0. What a command starts in the background runs until the trial ends.`;

/** The lane's limits, as the agent must know them: OpenCode and its commands share them. */
export function limitsNote(limits: LaneLimitValues): string {
  return `Memory: ${limits.runRssMib} MiB for everything your lane runs at once, OpenCode itself included (it uses about 500 MiB). A command that takes it over the limit is killed (your shell tool reports "Killed by SIGKILL"): run it again with less parallelism (for example make -j2) or a smaller input, or as a development run, which has its own limit. Disk: ${limits.workspaceMib} MiB, and at most 50,000 files, for this trial's directory, OpenCode's own files included; going over ends the trial.`;
}

/** OpenCode's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function opencodeExe(): string | undefined {
  const bin = opencodeBin();
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** Why the broker stopped OpenCode, when a memory or disk limit did. */
export function breachError(
  o: Pick<RunOutcome, "killedFor"> &
    Partial<Pick<RunOutcome, "peakRssBytes" | "peakDiskBytes" | "peakEntries">>,
  limits: LaneLimitValues,
): string | undefined {
  const mib = (b: number | undefined) => Math.round((b ?? 0) / 1024 ** 2);
  if (o.killedFor === "memory")
    return `stopped by the lane's memory limit: OpenCode reached ${mib(o.peakRssBytes)} MiB with what it ran, over ${limits.runRssMib} MiB (the contract's lanes.limits.run_rss_mib), and its commands' memory could not be freed`;
  if (o.killedFor === "disk")
    return `stopped by the lane's disk limit: the trial's directory reached ${mib(o.peakDiskBytes)} MiB in ${o.peakEntries ?? 0} files, over ${limits.workspaceMib} MiB (lanes.limits.workspace_mib) or 50,000 files`;
  return undefined;
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

/** Hands the usage the tally gathered to `usage`, once each (goal 075). */
export function takeUsage(
  t: { calls: CallUsage[] },
  usage: ((u: CallUsage) => void) | undefined,
): void {
  for (const u of t.calls.splice(0)) usage?.(u);
}

/** CUDA's tools (nvcc and the rest), where a CUDA development base image puts them. */
const CUDA_BIN = "/usr/local/cuda/bin";

/**
 * The PATH an agent's own shell gets under OpenCode, Claude Code and Codex: the system's places,
 * with CUDA's first when the image has it, as the CUDA base image's own PATH has it, so `nvcc` is
 * found by name on a CUDA rig. (Pi's commands get the image's PATH from the broker.) A fixed list,
 * not the harness's own PATH, so what an agent runs does not depend on how the harness started.
 */
export function agentPath(exists: (path: string) => boolean = existsSync): string {
  return `${exists(CUDA_BIN) ? `${CUDA_BIN}:` : ""}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
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

/** One `opencode run` as the lane, under its limits; its output goes to the events file. */
function startInArea(
  runner: Runner,
  role: Role,
  area: string,
  cwd: string,
  env: Record<string, string>,
  args: string[],
  o: { remaining: number; limits: LaneLimitValues },
): Promise<RunOutcome> {
  return runner.run({
    role,
    // Its output goes to a file the harness follows while it runs.
    argv: [
      "sh",
      "-c",
      'exec "$@" >> "$THERMITE_OPENCODE_EVENTS" 2>&1',
      "sh",
      // By its full path, so the broker knows OpenCode's processes from its commands'.
      opencodeExe() ?? OPENCODE_BIN,
      ...args,
    ],
    cwd,
    env,
    // No time limit unless the trial has one (goal 079).
    ...(Number.isFinite(o.remaining) ? { timeoutMs: o.remaining } : {}),
    rssLimitBytes: o.limits.runRssMib * 1024 * 1024,
    // Over the memory limit, OpenCode's commands are killed and OpenCode carries on, as a
    // lane command under Pi would be; the trial ends only if OpenCode alone is over.
    ...(opencodeExe() ? { spareExe: opencodeExe() } : {}),
    disk: { path: area, limitBytes: o.limits.workspaceMib * 1024 * 1024 },
    nproc: o.limits.processes,
    captureBytes: 4096,
  });
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
  let message = `${SYSTEM}${mcp ? `\n\n${mcpLine(mcp.servers)}` : ""}\n\n${limitsNote(limits)}\n\n${spec.brief}\n\nThe editable paths: ${spec.editablePaths.join(", ")}. ${trialBudget(minutes, undefined, "", deadline)}`;
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
      message,
    ];
    const running = startInArea(deps.runner, spec.lane, area, spec.workspace, env, args, {
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
    // A memory or disk limit ends OpenCode with everything it ran: say which, with the figures.
    const breach = breachError(outcome, limits);
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
  return `${RESEARCH_SYSTEM}

Your research tools are commands you run with your shell tool:

${researchCommands()}

Only pages fetched with "thermite-trial research fetch" are archived, and only archived sources can verify a claim: a page you read another way (your own web search, curl, a fetch from code) verifies nothing until you fetch it with that command.

To propose another research task for the run's queue (the planner or the campaign's owner decides whether it is queued; your trial goes on): thermite-trial idea TITLE [--why TEXT] [--family TEXT] [--question N] (N: the index of the question it is about, from 0). A task that only a measurement could settle is refused: record it as a next experiment instead.

${notesInstruction(`with "${NOTE_USAGE}" (KIND: observation, decision, surprise, question, lesson or note; TYPE: run, experiment, attempt, source, claim, finding, round, trial or message; no --about: the run)`)} Field notes are not research notes (add_note), which record what sources say for the report.

${researchFolderNote(folder)} Your shell starts in your working area; use grep, rg and your file tools on the folder.

${limitsNote(limits)}

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
  const capped = () => spec.maxTurns !== undefined && tally.turns >= spec.maxTurns;
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
        message,
      ],
      { remaining, limits },
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
    const breach = breachError(outcome, limits);
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
        prompt,
      ],
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

/**
 * The unprivileged users planner calls and model checks run as, under OpenCode or Claude Code.
 * Each has a user of its own, apart from every lane's and from each other's: a run ends by
 * killing its user's processes, so a shared user would let one call's cleanup kill the other's.
 */
export const PLANNER_ROLE: Role = "planner";
export const CHECK_ROLE: Role = "model-check";

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
  const t = await opencodeOnce(
    model,
    `Use your shell tool to run exactly this command: echo ${word}\nThen reply with only the word it printed.`,
    deps,
    { role: CHECK_ROLE, timeoutMs },
  );
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
