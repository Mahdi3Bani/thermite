import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKER_CODEX_SYSTEM } from "../../agents/roles/worker.ts";
import { type LaneLimitValues, laneLimits } from "../../core/contract.ts";
import { type LiveKind, summarizeArgs } from "../../core/live.ts";
import { type CallUsage, callUsage } from "../../core/usage.ts";
import type { Role, Runner } from "../broker/runner.ts";
import {
  CliCompactions,
  codexCompactPrompt,
  compactionTokens,
  type FoundCompaction,
  type KeptAt,
  type OnCompacted,
  type OnceKeeping,
  reclaim,
} from "./cli-compaction.ts";
import { codexOwn } from "./cli-conversation.ts";
import type { MessageInbox, TrialProgress } from "./live-session.ts";
import { gatewayUrl, type McpAccess, mcpLine } from "./mcp-tools.ts";
import { CHATGPT_LIMIT_CODE, type ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import {
  AFTER_SUBMIT_MS,
  agentPath,
  breachError,
  CarriedMessages,
  CHECK_ROLE,
  limitsNote,
  NUDGE,
  type OpencodeOnceDeps,
  ownerLines,
  readNew,
  takeUsage,
} from "./opencode.ts";
import {
  afterProgramFailure,
  type FailureCount,
  failingOf,
  type ProviderLink,
} from "./provider-errors.ts";
import { trialBudget } from "./trial-clock.ts";
import { type SubmitOutcome, stopNudging, type TrialResult, type TrialSpec } from "./worker.ts";

/**
 * Trials, model checks and planner calls in the Codex CLI, OpenAI's open-source agent program,
 * for a ChatGPT sign-in or an OpenAI-compatible route. Codex runs headless (`codex exec --json`,
 * its approvals and its own sandbox off) as the lane's own user, in the lane's workspace, under
 * the lane's memory, disk and time limits, as OpenCode and Claude Code do: it has the lane's
 * access and none of the judge's. Its own sandbox would cut its commands off the harness API;
 * the boundary is the user it runs as, not its permission rules.
 *
 * It starts with a home of its own (CODEX_HOME) whose configuration names one provider: the
 * harness API's model proxy, over OpenAI's Responses API (the only API Codex speaks), with the
 * trial's token, or a check's or plan's short-lived one, from THERMITE_PROXY_AUTH. The proxy
 * checks that token and adds the real key, so a ChatGPT sign-in's access token or a provider's
 * key never reaches the lane (unlike a Claude subscription's token, which only Claude Code may
 * carry). Its analytics, feedback, update checks and history file are off, and so is its hosted
 * web search, which the ChatGPT route may refuse: the agent fetches pages with its shell or with
 * `thermite-trial research fetch`. A project's own execution-policy rules are not loaded.
 *
 * Thermite's own tools are the `thermite-trial` command, which calls the harness API with the
 * trial's token. One `codex exec` takes one prompt (on its stdin, so a long brief fits): a run
 * that ends without a submission is resumed (`codex exec resume`) with a nudge or the owner's
 * messages.
 */

/** The Codex CLI's binary: THERMITE_CODEX_BIN, else `codex` on the PATH (read when used). */
export const codexBin = () => process.env.THERMITE_CODEX_BIN ?? "codex";

/** What to say when the image has no Codex CLI: an image built with an empty CODEX_VERSION. */
export const NO_CODEX =
  "this rig's harness image has no Codex CLI: build the image with the Codex option (CODEX_VERSION, which the published images set), or give the rig another harness on Edit rig";

/** Why the Codex CLI exited, in words. A missing program says so, rather than the shell's note. */
export function codexExitWords(code: number | string | null, note: string): string {
  if ((code === 126 || code === 127) && /codex: (No such file or directory|not found)/.test(note))
    return NO_CODEX;
  return `Codex exited ${code}: ${note}`;
}

/** The Codex CLI's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function codexExe(): string | undefined {
  const bin = codexBin();
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** What the Codex CLI's JSON output (`codex exec --json`) has said so far. */
export interface CodexTally {
  /** Each message and each tool call the model made is one turn. */
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** The thread's id, which `codex exec resume` takes. */
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON, and its non-fatal error items. */
  notes: string[];
  /** Items already shown as started in the live view. */
  started: Set<string>;
  /** Compactions it reported since they were last taken (goal 070). */
  compactions: FoundCompaction[];
  /** Each turn's model usage, since they were last taken (goal 075). */
  calls: CallUsage[];
  /** The thread's totals at its last completed turn, and when the turn under way started. */
  totals?: CodexUsage | undefined;
  turnAt?: number | undefined;
}

export const newCodexTally = (): CodexTally => ({
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: [],
  lastText: "",
  tools: [],
  notes: [],
  started: new Set(),
  compactions: [],
  calls: [],
});

/** The usage a `turn.completed` gives (codex exec's Usage): the thread's totals so far. */
interface CodexUsage {
  /** Every input token, the cached ones included. */
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  /** Every output token, the reasoning ones included. */
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * A turn's usage (goal 075): what the thread's totals grew by since its last turn (Codex keeps the
 * totals when a thread is resumed), or the totals themselves for a new thread, whose totals start
 * again. A turn makes one or more model calls and Codex says neither how many nor how long they
 * took: those are not reported.
 */
function turnUsage(now: CodexUsage, was: CodexUsage | undefined, at: number): CallUsage {
  const keys = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
  ] as const;
  const grew = was !== undefined && keys.every((k) => (now[k] ?? 0) >= (was[k] ?? 0));
  const less = (k: (typeof keys)[number]) =>
    now[k] === undefined ? null : now[k] - (grew ? (was?.[k] ?? 0) : 0);
  return callUsage({
    at,
    calls: null,
    tokensIn: less("input_tokens") ?? 0,
    cachedIn: less("cached_input_tokens"),
    tokensOut: less("output_tokens") ?? 0,
    reasoning: less("reasoning_output_tokens"),
    firstTokenMs: null,
    callMs: null,
  });
}

type Item = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown[] } | null;
  error?: { message?: string } | null;
  query?: string;
  message?: string;
};
type Event = {
  type?: string;
  thread_id?: string;
  item?: Item;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
};

/** A tool item's name and the line the live view shows when it starts. */
function toolOf(i: Item): { tool: string; call: string } | undefined {
  switch (i.type) {
    case "command_execution":
      return { tool: "shell", call: `shell ${String(i.command ?? "")}` };
    case "file_change": {
      const paths = (i.changes ?? []).map((c) => `${c.kind ?? "update"} ${c.path ?? ""}`);
      return { tool: "apply_patch", call: `apply_patch ${paths.join(", ")}` };
    }
    case "mcp_tool_call": {
      const tool = `${i.server ?? "mcp"}.${i.tool ?? "tool"}`;
      return { tool, call: `${tool} ${summarizeArgs(i.arguments)}` };
    }
    case "web_search":
      return { tool: "web_search", call: `web_search ${String(i.query ?? "")}` };
    case "agent_message":
    case "reasoning":
    case "todo_list":
    case "error":
    case undefined:
      return undefined;
    default:
      return { tool: i.type, call: i.type };
  }
}

/** What a completed tool item returned, and whether it worked. */
function resultOf(i: Item): { output: string; ok: boolean } {
  switch (i.type) {
    case "command_execution":
      return {
        output: String(i.aggregated_output ?? ""),
        ok: i.status === "completed" && (i.exit_code ?? 0) === 0,
      };
    case "file_change":
      return {
        output: (i.changes ?? []).map((c) => `${c.kind ?? "update"} ${c.path ?? ""}`).join("\n"),
        ok: i.status === "completed",
      };
    case "mcp_tool_call":
      return {
        output: i.error?.message ?? summarizeArgs(i.result?.content ?? [], 4000),
        ok: i.status === "completed" && !i.error,
      };
    default:
      return { output: String(i.query ?? i.status ?? ""), ok: i.status !== "failed" };
  }
}

/**
 * The warning the Codex CLI gives (as an error item in `codex exec --json`) once it has compacted
 * its conversation on its own, as it does for a provider other than OpenAI's own: the only sign of
 * a compaction in its JSON output.
 */
export const CODEX_COMPACTED =
  /Long threads and multiple compactions can cause the model to be less accurate/;

/** Reads lines of the Codex CLI's JSON output into the tally; returns them as live-view lines. */
export function readCodexEvents(
  lines: string[],
  t: CodexTally,
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
    switch (e.type) {
      case "thread.started":
        if (e.thread_id) t.session = e.thread_id;
        break;
      case "turn.started":
        t.turnAt = Date.now();
        break;
      case "item.started": {
        const i = e.item ?? {};
        const tool = toolOf(i);
        if (!tool) break;
        if (i.id) t.started.add(i.id);
        live.push({ kind: "tool", text: tool.call.slice(0, 8000) });
        break;
      }
      case "item.completed": {
        const i = e.item ?? {};
        if (i.type === "agent_message") {
          t.turns++;
          if (i.text) {
            t.lastText = i.text;
            live.push({ kind: "text", text: i.text.slice(0, 8000) });
          }
          break;
        }
        if (i.type === "reasoning") {
          if (i.text) live.push({ kind: "thinking", text: i.text.slice(0, 8000) });
          break;
        }
        if (i.type === "error") {
          const message = String(i.message ?? "error").slice(0, 500);
          // The warning Codex gives after each compaction of its own conversation (goal 070): no
          // tokens are said. The compaction is recorded in words instead of the warning.
          if (CODEX_COMPACTED.test(message)) {
            t.compactions.push({ at: live.length, tokensBefore: null, tokensAfter: null });
            break;
          }
          t.notes = [...t.notes, message].slice(-5);
          live.push({ kind: "text", text: `(Codex: ${message})` });
          break;
        }
        const tool = toolOf(i);
        if (!tool) break;
        t.turns++;
        t.toolCalls++;
        // A file change is only ever completed; an item may also end without having started.
        if (!i.id || !t.started.delete(i.id))
          live.push({ kind: "tool", text: tool.call.slice(0, 8000) });
        const r = resultOf(i);
        t.tools.push({ tool: tool.tool, output: r.output.slice(0, 4000), ok: r.ok });
        live.push({
          kind: "result",
          text: `${tool.tool}${r.ok ? "" : " failed"}: ${r.output.slice(0, 1200)}`,
        });
        break;
      }
      // The thread's tokens so far: Codex keeps the total when a thread is resumed.
      case "turn.completed": {
        t.tokensIn = Math.max(t.tokensIn, e.usage?.input_tokens ?? 0);
        t.tokensOut = Math.max(t.tokensOut, e.usage?.output_tokens ?? 0);
        const now = e.usage ?? {};
        t.calls.push(turnUsage(now, t.totals, t.turnAt ?? Date.now()));
        t.totals = now;
        t.turnAt = undefined;
        break;
      }
      case "turn.failed":
      case "error": {
        const message = String(e.error?.message ?? e.message ?? "error").slice(0, 500);
        t.errors.push(message);
        live.push({ kind: "text", text: `(Codex: ${message})` });
        break;
      }
    }
  }
  return live;
}

/** A TOML basic string (the configuration Codex reads). */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\" || ch === '"') out += `\\${ch}`;
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * The Codex CLI's configuration for a run ($CODEX_HOME/config.toml): one provider, the harness's
 * key-adding proxy (`proxyRoot`) over the Responses API, with the run's credential from
 * THERMITE_PROXY_AUTH; the route's reasoning effort ("off" sends "none"); no hosted web search,
 * analytics, feedback, update checks or history file. The MCP servers the run's kit gives this
 * agent (goal 068) are each a streamable HTTP server at the harness's gateway, with the gateway's
 * credential from THERMITE_MCP_AUTH (never in the file), and none is required to start.
 *
 * `keptAt` (goal 070): where Thermite keeps the conversation before each compaction. Codex 0.162
 * takes a compaction prompt of its own (`compact_prompt`, which replaces its built-in one): Thermite
 * gives it its own summary prompt, which names that folder, and reads the conversation from
 * Codex's rollout of the thread once Codex reports the compaction.
 */
export function codexConfig(
  m: ModelConfig,
  proxyRoot: string,
  mcp?: Pick<McpAccess, "apiUrl" | "servers"> | undefined,
  keptAt?: KeptAt | undefined,
): string {
  const effort = m.reasoning === "off" ? "none" : m.reasoning;
  const servers = (mcp?.servers ?? []).flatMap((s) => [
    `[mcp_servers.${s}]`,
    `url = ${tomlString(gatewayUrl(mcp?.apiUrl ?? "", s))}`,
    'bearer_token_env_var = "THERMITE_MCP_AUTH"',
    "required = false",
    "",
  ]);
  // The window (the route's, so the owner's cap) and the compaction point (goal 070). Codex
  // compacts on its own, by default at 90% of the window; it keeps a window to the most the
  // model takes (272,000 tokens for a model it does not know).
  const point = compactionTokens(m);
  return [
    "# Written by Thermite's harness for one run.",
    'model_provider = "thermite"',
    ...(effort ? [`model_reasoning_effort = ${tomlString(effort)}`] : []),
    ...(point !== undefined
      ? [`model_context_window = ${m.contextWindow}`, `model_auto_compact_token_limit = ${point}`]
      : []),
    ...(keptAt ? [`compact_prompt = ${tomlString(codexCompactPrompt(keptAt))}`] : []),
    'web_search = "disabled"',
    "check_for_update_on_startup = false",
    "",
    "[model_providers.thermite]",
    'name = "Thermite route"',
    `base_url = ${tomlString(proxyRoot)}`,
    'env_key = "THERMITE_PROXY_AUTH"',
    'wire_api = "responses"',
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
    ...servers,
  ].join("\n");
}

/**
 * The flags every headless Codex run here has: JSON events, no git check (a check or a plan runs
 * in an empty directory), no execution-policy rules from the project, approvals and its sandbox
 * off; the prompt on stdin ("-"). A session is resumed by its thread's id.
 */
export function codexArgs(m: ModelConfig, o: { session?: string | undefined } = {}): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    m.model,
    ...(o.session ? ["resume", o.session] : []),
    "-",
  ];
}

/** The environment Codex runs in: its home, Thermite's command and the run's proxy credential. */
export function codexEnv(o: {
  home: string;
  apiUrl: string;
  /** The trial's credential for `thermite-trial` (empty outside a trial). */
  auth: string;
  /** What the model proxy takes: the trial's credential, or one minted for a check or a plan. */
  proxyAuth: string;
  /** What the MCP gateway takes, when the agent has MCP servers: the trial's, or the plan's. */
  mcpAuth?: string | undefined;
  tmp: string;
  extra?: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    ...o.extra,
    ...(o.mcpAuth ? { THERMITE_MCP_AUTH: o.mcpAuth } : {}),
    HOME: o.home,
    CODEX_HOME: join(o.home, ".codex"),
    PATH: agentPath(),
    TMPDIR: o.tmp,
    THERMITE_HARNESS_URL: o.apiUrl,
    THERMITE_TRIAL_AUTH: o.auth,
    THERMITE_PROXY_AUTH: o.proxyAuth,
  };
}

/** The lane's limits as the agent must know them: Codex and its commands share them. */
export const codexLimitsNote = (limits: LaneLimitValues) =>
  limitsNote(limits)
    .replace(" (it uses about 500 MiB)", "")
    .replace(/OpenCode/g, "Codex");

export interface CodexTrialDeps extends ProviderLink {
  runner: Runner;
  model: ModelConfig;
  /** The harness API as the lane reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  live(entries: { kind: LiveKind; text: string }[]): void;
  progress(p: TrialProgress): void;
  submitted(): SubmitOutcome | undefined;
  /**
   * The owner's messages for this trial. `codex exec` takes no message into a running session:
   * one waiting when a run ends is given by resuming the session with it, and is read once the
   * agent starts on that prompt.
   */
  messages?: MessageInbox | undefined;
  /**
   * When the agents may try a ChatGPT plan again, if the model proxy saw OpenAI say its usage is
   * full at or after the time given (ms); undefined if it did not.
   */
  usageLimitSince?: ((since: number) => string | undefined) | undefined;
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  pollMs?: number | undefined;
  /** How long the run goes on after a submission (AFTER_SUBMIT_MS; tests make it short). */
  afterSubmitMs?: number | undefined;
  /** A compaction Codex reported (goal 070), for the harness to keep and record. */
  compacted?: OnCompacted | undefined;
  /**
   * Where the harness keeps the conversation before each compaction (goal 070): with it, Codex's
   * compaction prompt tells the summary to name the file.
   */
  keptAt?: KeptAt | undefined;
  /** Each turn's model usage, as Codex's output reports it (goal 075). */
  modelUsage?: ((u: CallUsage) => void) | undefined;
}

/**
 * One worker trial in the Codex CLI: its home and configuration in the lane's own area, then
 * `codex exec` in the workspace until the agent submits or the trial's time ends. A run that ends
 * without a submission is resumed in the same session, twice at most, and after that for as long
 * as the owner's messages wait and the agent keeps working; a message waits until the run ends
 * without a submission. A turn cap, when the rig sets one, is kept by counting its turns.
 */
export async function runCodexTrial(spec: TrialSpec, deps: CodexTrialDeps): Promise<TrialResult> {
  const area = spec.workspaceRoot ?? dirname(spec.workspace);
  const events = join(area, "codex-events.jsonl");
  const tally = newCodexTally();
  const result: TrialResult = {
    stopped: "no_submission",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const auth = `trial.${spec.token ?? ""}`;
  // The MCP servers the run's kit gives its workers (goal 068), at the gateway with the trial's token.
  const mcp = spec.mcpServers?.length
    ? { apiUrl: deps.apiUrl, servers: spec.mcpServers }
    : undefined;
  const env = {
    ...codexEnv({
      home: join(area, "codex-home"),
      apiUrl: deps.apiUrl,
      auth,
      proxyAuth: auth,
      mcpAuth: mcp ? auth : undefined,
      tmp: join(area, "codex-tmp"),
      extra: deps.env,
    }),
    THERMITE_EDITABLE_PATHS: JSON.stringify(spec.editablePaths),
    THERMITE_WORKSPACE: spec.workspace,
    THERMITE_CODEX_EVENTS: events,
  };
  const title = `Trial ${spec.trialId} (${spec.lane})`;
  // Each compaction's conversation, from Codex's rollout of the thread in its home (goal 070).
  const compactions = new CliCompactions({
    title,
    harness: "Codex",
    on: deps.compacted,
    own: codexOwn({
      root: area,
      home: ["codex-home", ".codex"],
      title,
      thread: () => tally.session,
    }),
  });
  const setup = await deps.runner.run({
    role: spec.lane,
    // Relative to its own area: the lane may not walk the harness's directories by name.
    argv: [
      "sh",
      "-c",
      "mkdir -p codex-home/.codex codex-tmp && cat > codex-home/.codex/config.toml && : > codex-events.jsonl && chmod 0644 codex-events.jsonl",
    ],
    cwd: area,
    timeoutMs: 30_000,
    stdin: codexConfig(deps.model, `${deps.apiUrl}/v1/model-proxy`, mcp, deps.keptAt),
    captureBytes: 4096,
  });
  if (setup.exitCode !== 0)
    return {
      ...result,
      stopped: "error",
      error: `could not set Codex up: ${setup.stderr.slice(-300)}`,
    };
  const started = Date.now();
  // A trial's length only when the campaign or the rig sets one (goal 079).
  const deadline = spec.wallMs !== undefined ? started + spec.wallMs : Number.POSITIVE_INFINITY;
  const minutes = spec.wallMs !== undefined ? Math.round(spec.wallMs / 60_000) : undefined;
  // Failed model calls in a row, rate limits in a row, and since when the calls fail (goal 079).
  const count: FailureCount = { failures: 0, rateWaits: 0 };
  const maxTurns = spec.maxTurns;
  let message = `${WORKER_CODEX_SYSTEM}${mcp ? `\n\n${mcpLine(mcp.servers)}` : ""}\n\n${codexLimitsNote(limits)}\n\n${spec.brief}\n\nThe editable paths: ${spec.editablePaths.join(", ")}. ${trialBudget(minutes, maxTurns, "each message or tool call is one", deadline)}`;
  let offset = 0;
  const carried = new CarriedMessages(deps.messages);
  const pump = () => {
    const r = readNew(events, offset);
    offset = r.next;
    const live = readCodexEvents(r.lines, tally);
    if (live.length) deps.live(live);
    compactions.take(live, tally.compactions.splice(0));
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
    const exe = codexExe();
    const running = deps.runner.run({
      role: spec.lane,
      // Its output goes to a file the harness follows while it runs; the prompt goes on stdin.
      argv: [
        "sh",
        "-c",
        'exec "$@" >> "$THERMITE_CODEX_EVENTS" 2>&1',
        "sh",
        exe ?? codexBin(),
        ...codexArgs(deps.model, { session: tally.session }),
      ],
      cwd: spec.workspace,
      env,
      stdin: message,
      ...(Number.isFinite(remaining) ? { timeoutMs: remaining } : {}),
      rssLimitBytes: limits.runRssMib * 1024 * 1024,
      // Over the memory limit, Codex's commands are killed and Codex carries on.
      ...(exe ? { spareExe: exe } : {}),
      disk: { path: area, limitBytes: limits.workspaceMib * 1024 * 1024 },
      nproc: limits.processes,
      captureBytes: 4096,
    });
    let done = false;
    void running.finally(() => {
      done = true;
    });
    let submittedAt: number | undefined;
    let capped = false;
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
      } else if (maxTurns !== undefined && tally.turns >= maxTurns && !capped) {
        capped = true;
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
    if (capped) {
      result.stopped = "turns";
      result.error = `the trial reached its limit of ${maxTurns} turns before a submission`;
      break;
    }
    // A full ChatGPT plan: the trial ends, and the lane waits a while (never paid credits).
    const until = deps.usageLimitSince?.(runStarted);
    if (until) {
      result.stopped = "error";
      result.errorKind = "rate_limit";
      result.retryAfter = until;
      result.error = `the ChatGPT plan's usage is full (${CHATGPT_LIMIT_CODE}): the agents try again after ${until}`;
      break;
    }
    const breach = breachError(outcome, limits);
    if (breach) {
      result.stopped = "error";
      result.error = breach.replace(/OpenCode/g, "Codex");
      break;
    }
    if (outcome.killedFor === "timeout" || Date.now() >= deadline) {
      result.stopped = "wall";
      break;
    }
    // A run that ended with the provider's error (goal 079): by its kind, the trial ends (no
    // credits, a refused key, an unserved model, or the campaign's limit), or waits and goes on
    // in the same session. The failure is not one of the nudges.
    if (tally.errors.length > errorsBefore) {
      if (tally.turns + tally.toolCalls > progressBefore) count.failures = 0;
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
      result.error = codexExitWords(
        outcome.exitCode ?? outcome.signal,
        tally.notes.at(-1) ?? "no output",
      );
      break;
    }
    // Continued to get a submission (goal 079) for as long as the agent keeps working (a tool
    // call in this run), with no number unless the campaign sets lanes.limits.nudges; a nudge it
    // answers without any work ends the trial, its own choice. The owner's messages continue it
    // while they wait and it keeps working. A message is read only once the agent starts on the
    // prompt.
    const progressed = tally.turns + tally.toolCalls > progressBefore;
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

/**
 * One prompt through the Codex CLI outside a trial (a model check, a planner call), as `role`
 * (the planner's or the model check's own user) in a fresh directory, removed afterwards. It
 * reaches the model through the proxy with a credential minted for this call.
 */
export async function codexOnce(
  model: ModelConfig,
  prompt: string,
  deps: OpencodeOnceDeps,
  o: {
    role: Role;
    /** None unless given: a planner call runs until it answers or its run stops (goal 079). */
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    /** The MCP servers the call may use, and the gateway's credential for them (a planner's). */
    mcp?: Omit<McpAccess, "apiUrl"> | undefined;
    /** Where its conversation is kept before each compaction, and who records it (goal 070). */
    compaction?: OnceKeeping | undefined;
  },
): Promise<CodexTally> {
  // Codex finds its home by name, so the directory must be reachable by name: under the lanes'
  // area, not the controller's own (which only its processes may walk).
  const parent = join(deps.scratchDir, "lanes", "codex-ask");
  mkdirSync(parent, { recursive: true, mode: 0o711 });
  chmodSync(parent, 0o711);
  const dir = join(parent, randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  await deps.runner.handOver(dir, o.role);
  const tally = newCodexTally();
  const kill = () => void deps.runner.killRole(o.role).catch(() => 0);
  o.signal?.addEventListener("abort", kill, { once: true });
  try {
    const setup = await deps.runner.run({
      role: o.role,
      argv: ["sh", "-c", "mkdir -p home/.codex tmp && cat > home/.codex/config.toml"],
      cwd: dir,
      timeoutMs: 30_000,
      stdin: codexConfig(
        model,
        `${deps.apiUrl}/v1/model-proxy`,
        o.mcp?.servers.length ? { apiUrl: deps.apiUrl, servers: o.mcp.servers } : undefined,
        o.compaction?.keptAt,
      ),
      captureBytes: 4096,
    });
    if (setup.exitCode !== 0) {
      tally.errors.push(`could not set Codex up: ${setup.stderr.slice(-300)}`);
      return tally;
    }
    const r = await deps.runner.run({
      role: o.role,
      argv: [codexExe() ?? codexBin(), ...codexArgs(model)],
      cwd: dir,
      env: codexEnv({
        home: join(dir, "home"),
        apiUrl: deps.apiUrl,
        auth: "",
        proxyAuth: deps.mintProxyToken(model),
        mcpAuth: o.mcp?.servers.length ? o.mcp.auth : undefined,
        tmp: join(dir, "tmp"),
      }),
      stdin: prompt,
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      captureBytes: 8 * 1024 * 1024,
    });
    const live = readCodexEvents(r.stdout.split("\n"), tally);
    // Each compaction it reported, kept and recorded once the call is over (goal 070), from its
    // rollout, which the controller takes the call's folder back to read.
    const keeping = o.compaction;
    if (keeping && tally.compactions.length) {
      await reclaim(deps.runner, dir);
      new CliCompactions({
        title: keeping.title,
        harness: "Codex",
        on: keeping.compacted,
        own: codexOwn({
          root: dir,
          home: ["home", ".codex"],
          title: keeping.title,
          thread: () => tally.session,
        }),
      }).take(live, tally.compactions.splice(0));
    }
    if (r.killedFor === "timeout")
      tally.errors.push(`no answer in ${Math.round((o.timeoutMs ?? 0) / 1000)} s`);
    else if (r.exitCode !== 0 && !tally.errors.length)
      tally.errors.push(
        codexExitWords(r.exitCode ?? r.signal, tally.notes.at(-1) ?? r.stderr.slice(-300)),
      );
  } finally {
    o.signal?.removeEventListener("abort", kill);
    await deps.runner.remove(dir).catch(() => undefined);
  }
  return tally;
}

/**
 * The model check in the Codex CLI: the model must run one shell command through Codex's own
 * tool and the command's output must come back, as a trial's tool calls would.
 */
export async function codexModelCheck(
  model: ModelConfig,
  deps: OpencodeOnceDeps,
  timeoutMs = 120_000,
): Promise<RigCheckReport> {
  const word = `thermite-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const t = await codexOnce(
    model,
    `Use your shell tool to run exactly this command: echo ${word}\nThen reply with only the word it printed.`,
    deps,
    { role: CHECK_ROLE, timeoutMs },
  );
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const called = t.tools.some((x) => x.ok && x.output.includes(word));
  const detail = {
    harness: "codex",
    model: model.model,
    base_url: model.baseUrl,
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
      summary: `${model.model} answered with a correct tool call in ${seconds} s (Codex)`,
      detail,
    };
  const why = t.errors.length
    ? t.errors.at(-1)
    : t.toolCalls
      ? "its tool call did not print the word"
      : `no tool call${t.lastText ? `; it wrote: ${t.lastText.slice(0, 200)}` : ""}`;
  return {
    ok: false,
    summary: `${model.model} failed the tool-call check in Codex: ${why}`,
    detail,
  };
}
