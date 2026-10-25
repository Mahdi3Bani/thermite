import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPACT_AT_DEFAULT } from "../../core/compaction.ts";
import { laneLimits } from "../../core/contract.ts";
import { type LiveKind, summarizeArgs } from "../../core/live.ts";
import { type CallUsage, callUsage } from "../../core/usage.ts";
import type { Role, Runner } from "../broker/runner.ts";
import {
  CliCompactions,
  type FoundCompaction,
  type KeptAt,
  keptLine,
  type OnCompacted,
  type OnceKeeping,
  reclaim,
} from "./cli-compaction.ts";
import { claudeOwn } from "./cli-conversation.ts";
import type { MessageInbox, TrialProgress } from "./live-session.ts";
import { claudeMcpConfig, type McpAccess, mcpLine } from "./mcp-tools.ts";
import type { ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import {
  AFTER_SUBMIT_MS,
  agentPath,
  breachError,
  CarriedMessages,
  CHECK_ROLE,
  limitsNote,
  NUDGE,
  ownerLines,
  readNew,
  SYSTEM,
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
 * Trials, model checks and planner calls in Claude Code, for a Claude subscription. Anthropic
 * allows a subscription only in its own program, unmodified: the owner's token from `claude
 * setup-token` reaches Claude Code alone, on a file descriptor (claudeShell), and no other program
 * here uses it. Claude Code runs headless (`claude -p`, its permissions bypassed) as the lane's
 * own user, in the lane's workspace, under the lane's memory, disk and time limits and the GPU
 * fence, as OpenCode does: it has the lane's access and none of the judge's. It starts with a home
 * of its own, no setting sources and no MCP servers, so nothing of a project's or a host's Claude
 * settings runs. The token is in no environment and no file, so its commands inherit no
 * credentials; they run as the same user, which could still reach the token: the owner accepted
 * that (decision 51).
 *
 * Claude Code's own sandbox stays off, here and in the advisors (whose Claude Code has
 * none of its own tools), so the images carry no bubblewrap. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
 * would make the sandbox mandatory, and it cannot start in a rig: its bubblewrap mounts, which the
 * GPU fence (Landlock) refuses, as do a container's own confinement and masked /proc; its network
 * bridge's sockets, in TMPDIR, pass the 108-byte limit of a socket's path in the lanes' areas. The
 * scrub also forces Claude Code's default permission mode, which refuses file edits and most
 * commands in a headless run.
 *
 * Thermite's own tools are the `thermite-trial` command, which calls the harness API with the
 * trial's token. Claude Code reports the subscription's usage windows as it goes
 * (rate_limit_event); a full window ends the trial with the time it resets.
 */

/** Claude Code's binary: THERMITE_CLAUDE_BIN, else `claude` on the PATH (read when used). */
export const claudeBin = () => process.env.THERMITE_CLAUDE_BIN ?? "claude";

/** What to say when the image has no Claude Code: it is in an image only when built with it. */
export const NO_CLAUDE_CODE =
  "this rig's harness image has no Claude Code: build the image with the Claude Code option (CLAUDE_CODE_VERSION), or give the rig another harness on Edit rig";

/**
 * Why Claude Code exited, in words. A missing program says so, rather than the shell's note. Its
 * own `error:` line, anywhere in its output, comes before the last line (Bun prints the source
 * around an error after it).
 */
export function claudeExitWords(code: number | string | null, note: string, output = ""): string {
  if ((code === 126 || code === 127) && /claude: (No such file or directory|not found)/.test(note))
    return NO_CLAUDE_CODE;
  const own = /(?:^|\n)\s*error: ([^\n]+)/.exec(output)?.[1]?.trim();
  return `Claude Code exited ${code}: ${own ?? note}`;
}

/** The file descriptor Claude Code reads the sign-in token from, once, when it starts. */
export const CLAUDE_TOKEN_FD = 3;

/**
 * What every Claude Code run here has in its environment, the agents' and the supervisor's
 * advisors': where the token is (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), never the token, and no
 * update checks, reports or other traffic. Never CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: it would turn on
 * Claude Code's own sandbox, which cannot start in a rig (this file's opening comment says why).
 */
export const CLAUDE_BASE_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: String(CLAUDE_TOKEN_FD),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
};

/**
 * Claude Code's command line behind `sh`, which moves the run's stdin, the token, to file
 * descriptor 3 (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) and gives Claude Code /dev/null for its
 * own. Claude Code reads the token from there once, so it is in no environment: not Claude Code's,
 * nor its commands'. `after` is more of the shell line, after the redirection (where the output
 * goes). The broker gives a run only its stdin; the supervisor, which starts an advisor's Claude
 * Code itself, opens descriptor 3 directly and keeps stdin for the prompt.
 */
export function claudeShell(argv: string[], after = ""): string[] {
  return ["sh", "-c", `exec ${CLAUDE_TOKEN_FD}<&0 && exec "$@" < /dev/null${after}`, "sh", ...argv];
}

/** Claude Code's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function claudeExe(): string | undefined {
  const bin = claudeBin();
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** A subscription's usage window, as Claude Code reports it. */
export interface UsageWindow {
  /** 0 to 1. */
  utilization: number;
  /** When it resets (ISO). */
  resets_at: string;
}

/** What Claude Code's stream-json output has said so far. */
export interface ClaudeTally {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON. */
  notes: string[];
  /** The subscription's windows, from its latest rate-limit event. */
  usage?: { five_hour?: UsageWindow; seven_day?: UsageWindow } | undefined;
  /** Set when a window is full: when it resets (ISO). */
  limitedUntil?: string | undefined;
  /** The final result's text, when the run ended with one. */
  result?: string | undefined;
  /** Each turn's tokens by message id (a message comes in several events). */
  messages: Map<string, { input: number; output: number }>;
  toolNames: Map<string, string>;
  /** Compactions it reported (compact_boundary) since they were last taken (goal 070). */
  compactions: FoundCompaction[];
  /** Each run's model usage, since they were last taken (goal 075). */
  calls: CallUsage[];
  /** The run under way: each model call's usage by its message's id, and when the run began. */
  run: Map<string, Usage>;
  runAt?: number | undefined;
}

export const newClaudeTally = (): ClaudeTally => ({
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: [],
  lastText: "",
  tools: [],
  notes: [],
  messages: new Map(),
  toolNames: new Map(),
  compactions: [],
  calls: [],
  run: new Map(),
});

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type Usage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};
type Event = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { id?: string; content?: Block[] | string; usage?: Usage };
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
    unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
  };
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  usage?: Usage;
  errors?: string[];
  /** A compaction's boundary (`system`, `compact_boundary`): its trigger and its tokens. */
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  /**
   * The result's times (ms): the run's, its time in API calls, and from the run's start to its
   * first token and to its first request.
   */
  duration_ms?: number;
  duration_api_ms?: number;
  ttft_ms?: number;
  time_to_request_ms?: number;
};

const tokensIn = (u: Usage | undefined) =>
  (u?.input_tokens ?? 0) +
  (u?.cache_creation_input_tokens ?? 0) +
  (u?.cache_read_input_tokens ?? 0);

const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);

/**
 * One run's usage from Claude Code's result (goal 075): every input token (Anthropic's input,
 * cache written and cache read), the cache read as cached, the output, and its time in API calls.
 * Claude Code gives a run's first token only from the run's start, so the time to its first
 * request is taken off. It names no reasoning tokens apart from the output. `calls`: the model
 * calls it made, where its stream showed them; null where it did not (its JSON output).
 */
export function claudeResultUsage(result: unknown, calls: number | null): CallUsage | undefined {
  if (!result || typeof result !== "object") return undefined;
  const e = result as Event;
  if (e.type !== "result" || !e.usage) return undefined;
  const ttft = num(e.ttft_ms);
  const toRequest = num(e.time_to_request_ms);
  const duration = num(e.duration_ms);
  return callUsage({
    at: Date.now() - (duration ?? 0),
    calls,
    tokensIn: tokensIn(e.usage),
    cachedIn: num(e.usage.cache_read_input_tokens) ?? null,
    tokensOut: e.usage.output_tokens ?? 0,
    reasoning: null,
    firstTokenMs:
      ttft !== undefined && toRequest !== undefined && ttft >= toRequest ? ttft - toRequest : null,
    callMs: num(e.duration_api_ms) ?? null,
  });
}

/**
 * A run of Claude Code that ended without its result (a submission or the trial's time ended it):
 * its calls' usage as its stream showed it, with no times, which only the result gives (goal 075).
 */
export function closeClaudeRun(t: ClaudeTally): void {
  if (t.run.size) {
    const all = [...t.run.values()];
    const has = all.every((u) => typeof u.cache_read_input_tokens === "number");
    t.calls.push(
      callUsage({
        at: t.runAt ?? Date.now(),
        calls: t.run.size,
        tokensIn: all.reduce((n, u) => n + tokensIn(u), 0),
        cachedIn: has ? all.reduce((n, u) => n + (u.cache_read_input_tokens ?? 0), 0) : null,
        tokensOut: all.reduce((n, u) => n + (u.output_tokens ?? 0), 0),
        reasoning: null,
        firstTokenMs: null,
        callMs: null,
      }),
    );
  }
  t.run.clear();
  t.runAt = undefined;
}

const iso = (seconds: number | undefined) =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : undefined;
const text = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((x) => (typeof x === "object" && x && "text" in x ? String(x.text) : "")).join("")
      : "";

/** Reads lines of Claude Code's stream-json output into the tally; returns them as live-view lines. */
export function readClaudeEvents(
  lines: string[],
  t: ClaudeTally,
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
    if (e.session_id) t.session = e.session_id;
    t.runAt ??= Date.now();
    switch (e.type) {
      // Claude Code compacted its conversation (goal 070): its own summary replaces the turns
      // before this point, and the session goes on.
      case "system": {
        if (e.subtype !== "compact_boundary") break;
        const c = e.compact_metadata ?? {};
        t.compactions.push({
          at: live.length,
          tokensBefore: typeof c.pre_tokens === "number" ? c.pre_tokens : null,
          tokensAfter: typeof c.post_tokens === "number" ? c.post_tokens : null,
        });
        break;
      }
      case "assistant": {
        const m = e.message ?? {};
        const id = m.id ?? `m${t.messages.size}`;
        if (!t.messages.has(id)) t.turns++;
        t.messages.set(id, { input: tokensIn(m.usage), output: m.usage?.output_tokens ?? 0 });
        t.run.set(id, m.usage ?? {});
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === "text" && b.text) {
            t.lastText = b.text;
            live.push({ kind: "text", text: b.text.slice(0, 8000) });
          } else if (b.type === "thinking" && b.thinking) {
            live.push({ kind: "thinking", text: b.thinking.slice(0, 8000) });
          } else if (b.type === "tool_use") {
            t.toolCalls++;
            const tool = String(b.name ?? "tool");
            if (b.id) t.toolNames.set(b.id, tool);
            live.push({ kind: "tool", text: `${tool} ${summarizeArgs(b.input)}`.slice(0, 8000) });
          }
        }
        let inSum = 0;
        let outSum = 0;
        for (const v of t.messages.values()) {
          inSum += v.input;
          outSum += v.output;
        }
        t.tokensIn = inSum;
        t.tokensOut = outSum;
        break;
      }
      case "user": {
        const content = e.message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type !== "tool_result") continue;
          const tool = t.toolNames.get(b.tool_use_id ?? "") ?? "tool";
          const output = text(b.content);
          const ok = b.is_error !== true;
          t.tools.push({ tool, output: output.slice(0, 4000), ok });
          live.push({
            kind: "result",
            text: `${tool}${ok ? "" : " failed"}: ${output.slice(0, 1200)}`,
          });
        }
        break;
      }
      case "rate_limit_event": {
        const r = e.rate_limit_info ?? {};
        const w = r.unifiedWindows ?? {};
        const win = (k: string): UsageWindow | undefined => {
          const x = w[k];
          const at = iso(x?.resetsAt);
          return x && typeof x.utilization === "number" && at
            ? { utilization: x.utilization, resets_at: at }
            : undefined;
        };
        t.usage = { five_hour: win("five_hour"), seven_day: win("seven_day") };
        if (r.status && r.status !== "allowed" && r.status !== "allowed_warning") {
          t.limitedUntil = iso(r.resetsAt);
          const which = r.rateLimitType === "seven_day" ? "weekly" : "5-hour";
          live.push({
            kind: "text",
            text: `(Claude Code: the subscription's ${which} window is full${t.limitedUntil ? ` until ${t.limitedUntil}` : ""})`,
          });
        }
        break;
      }
      case "result": {
        if (typeof e.num_turns === "number") t.turns = Math.max(t.turns, e.num_turns);
        if (e.usage) {
          t.tokensIn = Math.max(t.tokensIn, tokensIn(e.usage));
          t.tokensOut = Math.max(t.tokensOut, e.usage.output_tokens ?? 0);
        }
        // The run's usage, from its result: its calls are the messages its stream showed.
        const u = claudeResultUsage(e, t.run.size || null);
        if (u) {
          t.calls.push(u);
          t.run.clear();
          t.runAt = undefined;
        } else closeClaudeRun(t);
        if (typeof e.result === "string") t.result = e.result;
        if (e.is_error) {
          const message = String(e.result ?? e.errors?.join("; ") ?? e.subtype ?? "error").slice(
            0,
            500,
          );
          t.errors.push(message);
          live.push({ kind: "text", text: `(Claude Code: ${message})` });
        }
        break;
      }
    }
  }
  return live;
}

/**
 * Claude Code's own compaction settings from the route (goal 070): the window it compacts within
 * (CLAUDE_CODE_AUTO_COMPACT_WINDOW, the route's window, so the owner's cap; Claude Code takes
 * 100,000 to 1,000,000 tokens and raises a smaller one to 100,000) and the compaction point
 * (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, a percent of its window less the room it keeps for a reply;
 * it can only bring Claude Code's own point earlier). Its auto-compaction is on by default.
 */
export function claudeCompactionEnv(
  m: Pick<ModelConfig, "contextWindow" | "compactAt">,
): Record<string, string> {
  return {
    ...(m.contextWindow > 0 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(m.contextWindow) } : {}),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(m.compactAt ?? COMPACT_AT_DEFAULT),
  };
}

/**
 * The environment Claude Code runs in: its home, Thermite's command and no telemetry. The token is
 * not in it: Claude Code reads it from file descriptor 3 (claudeShell).
 */
export function claudeEnv(o: {
  home: string;
  apiUrl: string;
  auth: string;
  tmp: string;
  /** The trial's or the call's length; none: a day, the most a command may ask for. */
  maxCommandMs?: number | undefined;
  extra?: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    ...o.extra,
    HOME: o.home,
    PATH: agentPath(),
    TMPDIR: o.tmp,
    THERMITE_HARNESS_URL: o.apiUrl,
    THERMITE_TRIAL_AUTH: o.auth,
    ...CLAUDE_BASE_ENV,
    // A build or a test may run for most of the trial. Without a trial length (goal 079), a day:
    // the most a command may ask for, as Claude Code needs a number.
    BASH_MAX_TIMEOUT_MS: String(
      o.maxCommandMs !== undefined ? Math.max(120_000, o.maxCommandMs) : 86_400_000,
    ),
  };
}

/** Claude Code's model name for a route's model (claude-code:opus-5.5[1m] → claude-opus-5-5[1m]). */
export function claudeModelId(m: ModelConfig): string {
  return m.model;
}

/** Claude Code's PreCompact hook, as a program (compaction-hook.ts, beside this module). */
export const CLAUDE_HOOK = fileURLToPath(
  new URL(`./compaction-hook${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** The folder in a Claude Code run's own area where its PreCompact hook copies the transcript. */
export const CLAUDE_DROPS = "claude-compactions";

/**
 * Claude Code's settings for a run that keeps its conversation before each compaction (goal 070),
 * given with `--settings` (Claude Code reads them whatever `--setting-sources` says): Thermite's
 * own hook program (compaction-hook.ts), run by Node without a shell, with the folder for its
 * copies (`drops`, in the run's own area). As the PreCompact hook, it copies the transcript and
 * prints the line that tells the summary where Thermite keeps the conversation (Claude Code
 * 2.1.305 appends a PreCompact hook's output to the compaction's instructions); as the PostCompact
 * hook, it keeps the summary. Claude Code keeps its transcript private to the agent's user, so
 * these copies are what the harness reads.
 */
export function claudeHookSettings(drops: string, at: KeptAt): string {
  const hook = (args: string[]) => [
    { hooks: [{ type: "command", command: process.execPath, args, timeout: 60 }] },
  ];
  return JSON.stringify({
    hooks: {
      PreCompact: hook([CLAUDE_HOOK, "claude", drops, keptLine(at)]),
      PostCompact: hook([CLAUDE_HOOK, "claude-post", drops]),
    },
  });
}

/**
 * The flags every headless Claude Code run here has: no settings files, no MCP, permissions
 * bypassed; `settings`, Thermite's own (its PreCompact hook), when given.
 */
export function claudeArgs(
  m: ModelConfig,
  o: {
    tools?: string | undefined;
    session?: string | undefined;
    /** A file with the MCP servers it may use (at the harness's gateway), and only those. */
    mcpConfig?: string | undefined;
    /** Thermite's settings for the run, as JSON (claudeHookSettings). */
    settings?: string | undefined;
  },
) {
  return [
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    claudeModelId(m),
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    ...(o.mcpConfig ? ["--mcp-config", o.mcpConfig] : []),
    ...(o.settings ? ["--settings", o.settings] : []),
    ...(o.tools !== undefined ? ["--tools", o.tools] : []),
    ...(m.effort
      ? ["--effort", m.effort]
      : m.reasoning && m.reasoning !== "off"
        ? ["--effort", m.reasoning]
        : []),
    ...(o.session ? ["--resume", o.session] : []),
  ];
}

const SHELL_NOTE =
  "Your Bash tool stops a command after two minutes unless you set its timeout (in milliseconds): for a long build or test, set a longer one. What a command starts in the background runs until the trial ends.";

/** The trial's opening instructions for Claude Code (its shell tool's limits differ from OpenCode's). */
export const CLAUDE_SYSTEM = SYSTEM.replace(
  /\n\nYour shell tool stops[\s\S]*$/,
  `\n\n${SHELL_NOTE}`,
);

export interface ClaudeTrialDeps extends ProviderLink {
  runner: Runner;
  model: ModelConfig;
  /** The harness API as the lane reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  live(entries: { kind: LiveKind; text: string }[]): void;
  progress(p: TrialProgress): void;
  submitted(): SubmitOutcome | undefined;
  /**
   * The owner's messages for this trial. `claude -p` takes no message into a running session: one
   * waiting when a run ends is given by resuming the session with it, and is read once the agent
   * starts on that prompt.
   */
  messages?: MessageInbox | undefined;
  /** The subscription's windows, whenever Claude Code reports them. */
  usage?: ((u: NonNullable<ClaudeTally["usage"]>) => void) | undefined;
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  pollMs?: number | undefined;
  /** How long the run goes on after a submission (AFTER_SUBMIT_MS; tests make it short). */
  afterSubmitMs?: number | undefined;
  /** A compaction Claude Code reported (goal 070), for the harness to keep and record. */
  compacted?: OnCompacted | undefined;
  /**
   * Where the harness keeps the conversation before each compaction (goal 070): with it, Claude
   * Code's PreCompact hook copies the transcript and tells the summary to name the file.
   */
  keptAt?: KeptAt | undefined;
  /** Each run's model usage, as Claude Code's output reports it (goal 075). */
  modelUsage?: ((u: CallUsage) => void) | undefined;
}

/**
 * One worker trial in Claude Code: its home in the lane's own area, then `claude -p` in the
 * workspace until the agent submits or the trial's time ends. A run that ends without a submission
 * is continued in the same session, twice at most, and after that for as long as the owner's
 * messages wait and the agent keeps working; a message waits until the run ends without a
 * submission. A turn cap, when the rig sets one, is kept by counting its turns.
 */
export async function runClaudeTrial(spec: TrialSpec, deps: ClaudeTrialDeps): Promise<TrialResult> {
  const area = spec.workspaceRoot ?? dirname(spec.workspace);
  const home = join(area, "claude-home");
  const events = join(area, "claude-events.jsonl");
  const tmp = join(area, "claude-tmp");
  const tally = newClaudeTally();
  const result: TrialResult = {
    stopped: "no_submission",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const env = {
    ...claudeEnv({
      home,
      apiUrl: deps.apiUrl,
      auth: `trial.${spec.token ?? ""}`,
      tmp,
      maxCommandMs: spec.wallMs,
      extra: deps.env,
    }),
    ...claudeCompactionEnv(deps.model),
    THERMITE_EDITABLE_PATHS: JSON.stringify(spec.editablePaths),
    THERMITE_WORKSPACE: spec.workspace,
    THERMITE_CLAUDE_EVENTS: events,
  };
  const title = `Trial ${spec.trialId} (${spec.lane})`;
  // Before each compaction, Claude Code's hook copies its transcript into the run's own area and
  // tells the summary where the harness keeps it; the harness reads the copy, or else the
  // transcript itself, once Claude Code reports the compaction (goal 070).
  const settings = deps.keptAt
    ? claudeHookSettings(join(area, CLAUDE_DROPS), deps.keptAt)
    : undefined;
  const compactions = new CliCompactions({
    title,
    harness: "Claude Code",
    on: deps.compacted,
    own: claudeOwn({
      root: area,
      drops: [CLAUDE_DROPS],
      home: ["claude-home"],
      title,
      session: () => tally.session,
    }),
  });
  // The MCP servers the run's kit gives its workers (goal 068), at the harness's gateway with
  // the trial's own token: in a file only the lane reads.
  const mcp = claudeMcpConfig(
    spec.mcpServers?.length
      ? { apiUrl: deps.apiUrl, auth: `trial.${spec.token ?? ""}`, servers: spec.mcpServers }
      : undefined,
  );
  const mcpFile = mcp ? join(home, "mcp.json") : undefined;
  const setup = await deps.runner.run({
    role: spec.lane,
    argv: [
      "sh",
      "-c",
      `mkdir -p claude-home claude-tmp ${CLAUDE_DROPS} && chmod 0755 ${CLAUDE_DROPS} && : > claude-events.jsonl && chmod 0644 claude-events.jsonl${mcp ? " && umask 077 && cat > claude-home/mcp.json" : ""}`,
    ],
    cwd: area,
    timeoutMs: 30_000,
    ...(mcp ? { stdin: mcp } : {}),
    captureBytes: 4096,
  });
  if (setup.exitCode !== 0)
    return {
      ...result,
      stopped: "error",
      error: `could not set Claude Code up: ${setup.stderr.slice(-300)}`,
    };
  const started = Date.now();
  // A trial's length only when the campaign or the rig sets one (goal 079).
  const deadline = spec.wallMs !== undefined ? started + spec.wallMs : Number.POSITIVE_INFINITY;
  const minutes = spec.wallMs !== undefined ? Math.round(spec.wallMs / 60_000) : undefined;
  // Failed model calls in a row, rate limits in a row, and since when the calls fail (goal 079).
  const count: FailureCount = { failures: 0, rateWaits: 0 };
  const maxTurns = spec.maxTurns;
  let message = `${CLAUDE_SYSTEM}${mcp ? `\n\n${mcpLine(spec.mcpServers)}` : ""}\n\n${limitsNote(limits).replace(/OpenCode/g, "Claude Code")}\n\n${spec.brief}\n\nThe editable paths: ${spec.editablePaths.join(", ")}. ${trialBudget(minutes, maxTurns, "each model reply is one", deadline)}`;
  let offset = 0;
  const carried = new CarriedMessages(deps.messages);
  const pump = () => {
    const r = readNew(events, offset);
    offset = r.next;
    const live = readClaudeEvents(r.lines, tally);
    if (live.length) deps.live(live);
    compactions.take(live, tally.compactions.splice(0));
    takeUsage(tally, deps.modelUsage);
    carried.check(tally);
    if (r.lines.length) {
      deps.progress({
        turns: tally.turns,
        tool_calls: tally.toolCalls,
        tokens_in: tally.tokensIn,
        tokens_out: tally.tokensOut,
      });
      if (tally.usage) deps.usage?.(tally.usage);
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
    const exe = claudeExe() ?? claudeBin();
    const running = deps.runner.run({
      role: spec.lane,
      // Its output goes to a file the harness follows while it runs; the token comes on stdin.
      argv: claudeShell(
        [
          exe,
          "-p",
          message,
          ...claudeArgs(deps.model, { session: tally.session, mcpConfig: mcpFile, settings }),
        ],
        ' >> "$THERMITE_CLAUDE_EVENTS" 2>&1',
      ),
      cwd: spec.workspace,
      env,
      stdin: deps.model.apiKey,
      ...(Number.isFinite(remaining) ? { timeoutMs: remaining } : {}),
      rssLimitBytes: limits.runRssMib * 1024 * 1024,
      ...(claudeExe() ? { spareExe: claudeExe() } : {}),
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
    // A run cut off before its result (a submission, the cap) keeps what its stream showed.
    closeClaudeRun(tally);
    takeUsage(tally, deps.modelUsage);
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
    // A full usage window: the trial ends, and the lane waits for the reset (never paid credits).
    if (tally.limitedUntil) {
      result.stopped = "error";
      result.errorKind = "rate_limit";
      result.retryAfter = tally.limitedUntil;
      result.error = `the Claude subscription's usage window is full until ${tally.limitedUntil}`;
      break;
    }
    const breach = breachError(outcome, limits);
    if (breach) {
      result.stopped = "error";
      result.error = breach.replace(/OpenCode/g, "Claude Code");
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
      result.error = claudeExitWords(
        outcome.exitCode ?? outcome.signal,
        tally.notes.at(-1) ?? "no output",
        tally.notes.join("\n"),
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

export interface ClaudeOnceDeps {
  runner: Runner;
  apiUrl: string;
  scratchDir: string;
}

/**
 * One prompt through Claude Code outside a trial (a model check, a planner call), as `role` (the
 * planner's or the model check's own user) in a fresh directory, removed afterwards. `tools` ""
 * gives it none.
 */
export async function claudeOnce(
  model: ModelConfig,
  prompt: string,
  deps: ClaudeOnceDeps,
  o: {
    tools: string;
    /** None unless given: a planner call runs until it answers or its run stops (goal 079). */
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    role: Role;
    /** The MCP servers the call may use, and the gateway's credential for them (a planner's). */
    mcp?: Omit<McpAccess, "apiUrl"> | undefined;
    /** Where its conversation is kept before each compaction, and who records it (goal 070). */
    compaction?: OnceKeeping | undefined;
  },
): Promise<ClaudeTally> {
  const role = o.role;
  const parent = join(deps.scratchDir, "lanes", "claude-ask");
  mkdirSync(parent, { recursive: true, mode: 0o711 });
  chmodSync(parent, 0o711);
  const dir = join(parent, randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  await deps.runner.handOver(dir, role);
  const tally = newClaudeTally();
  const kill = () => void deps.runner.killRole(role).catch(() => 0);
  o.signal?.addEventListener("abort", kill, { once: true });
  try {
    const mcp = claudeMcpConfig(
      o.mcp?.servers.length ? { apiUrl: deps.apiUrl, ...o.mcp } : undefined,
    );
    const keeping = o.compaction;
    const setup = await deps.runner.run({
      role,
      argv: [
        "sh",
        "-c",
        `mkdir -p home tmp${keeping ? " compactions" : ""}${mcp ? " && umask 077 && cat > home/mcp.json" : ""}`,
      ],
      cwd: dir,
      timeoutMs: 30_000,
      ...(mcp ? { stdin: mcp } : {}),
      captureBytes: 4096,
    });
    if (setup.exitCode !== 0) {
      tally.errors.push(`could not set Claude Code up: ${setup.stderr.slice(-300)}`);
      return tally;
    }
    const r = await deps.runner.run({
      role,
      argv: claudeShell([
        claudeExe() ?? claudeBin(),
        "-p",
        prompt,
        ...claudeArgs(model, {
          tools: o.tools,
          mcpConfig: mcp ? join(dir, "home", "mcp.json") : undefined,
          // Its PreCompact hook, when the call's conversation is kept (goal 070).
          settings: keeping
            ? claudeHookSettings(join(dir, "compactions"), keeping.keptAt)
            : undefined,
        }),
      ]),
      cwd: dir,
      env: {
        ...claudeEnv({
          home: join(dir, "home"),
          apiUrl: deps.apiUrl,
          auth: "",
          tmp: join(dir, "tmp"),
          maxCommandMs: o.timeoutMs,
        }),
        // A planner's call compacts as the workers' trials do (goal 070).
        ...claudeCompactionEnv(model),
      },
      // The token, which the shell gives Claude Code on file descriptor 3.
      stdin: model.apiKey,
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      captureBytes: 8 * 1024 * 1024,
    });
    const live = readClaudeEvents(r.stdout.split("\n"), tally);
    // A run cut off before its result keeps the usage its stream showed (goal 075).
    closeClaudeRun(tally);
    // Each compaction it reported, kept and recorded once the call is over (goal 070): the
    // controller takes the call's folder back to read the hook's copies.
    if (keeping && tally.compactions.length) {
      await reclaim(deps.runner, dir);
      new CliCompactions({
        title: keeping.title,
        harness: "Claude Code",
        on: keeping.compacted,
        own: claudeOwn({
          root: dir,
          drops: ["compactions"],
          home: ["home"],
          title: keeping.title,
          session: () => tally.session,
        }),
      }).take(live, tally.compactions.splice(0));
    }
    if (r.killedFor === "timeout")
      tally.errors.push(`no answer in ${Math.round((o.timeoutMs ?? 0) / 1000)} s`);
    else if (r.exitCode !== 0 && !tally.errors.length)
      tally.errors.push(
        claudeExitWords(
          r.exitCode ?? r.signal,
          tally.notes.at(-1) ?? r.stderr.slice(-300),
          `${tally.notes.join("\n")}\n${r.stderr}`,
        ),
      );
  } finally {
    o.signal?.removeEventListener("abort", kill);
    await deps.runner.remove(dir).catch(() => undefined);
  }
  return tally;
}

/** The model check in Claude Code: the model must run one shell command through its Bash tool. */
export async function claudeModelCheck(
  model: ModelConfig,
  deps: ClaudeOnceDeps,
  timeoutMs = 120_000,
): Promise<RigCheckReport> {
  const word = `thermite-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const t = await claudeOnce(
    model,
    `Use your Bash tool to run exactly this command: echo ${word}\nThen reply with only the word it printed.`,
    deps,
    { tools: "Bash", timeoutMs, role: CHECK_ROLE },
  );
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const called = t.tools.some((x) => x.ok && x.output.includes(word));
  const detail = {
    harness: "claude-code",
    model: model.model,
    seconds,
    tool_called: called,
    tokens_in: t.tokensIn,
    tokens_out: t.tokensOut,
    usage: t.usage ?? null,
    error: t.errors.at(-1) ?? null,
    text: t.lastText.slice(0, 300) || null,
  };
  if (called)
    return {
      ok: true,
      summary: `${model.model} answered with a correct tool call in ${seconds} s (Claude Code)`,
      detail,
    };
  const why = t.limitedUntil
    ? `the subscription's usage window is full until ${t.limitedUntil}`
    : t.errors.length
      ? t.errors.at(-1)
      : t.toolCalls
        ? "its tool call did not print the word"
        : `no tool call${t.lastText ? `; it wrote: ${t.lastText.slice(0, 200)}` : ""}`;
  return {
    ok: false,
    summary: `${model.model} failed the tool-call check in Claude Code: ${why}`,
    detail,
  };
}
