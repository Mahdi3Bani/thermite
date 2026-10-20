import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { laneLimits } from "../../core/contract.ts";
import { type LiveKind, summarizeArgs } from "../../core/live.ts";
import type { Role, Runner } from "../broker/runner.ts";
import type { MessageInbox, TrialProgress } from "./live-session.ts";
import { claudeMcpConfig, type McpAccess, mcpLine } from "./mcp-tools.ts";
import type { ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import {
  AFTER_SUBMIT_MS,
  breachError,
  CarriedMessages,
  CHECK_ROLE,
  limitsNote,
  NUDGE,
  ownerLines,
  readNew,
  SYSTEM,
} from "./opencode.ts";
import type { SubmitOutcome, TrialResult, TrialSpec } from "./worker.ts";

/**
 * Trials, model checks and planner calls in Claude Code, for a Claude subscription. Anthropic
 * allows a subscription only in its own program, unmodified: the owner's token from `claude
 * setup-token` goes into Claude Code's environment (CLAUDE_CODE_OAUTH_TOKEN) and nowhere else, and
 * no other program here uses it. Claude Code runs headless (`claude -p`, its permissions
 * bypassed) as the lane's own user, in the lane's workspace, under the lane's memory, disk and
 * time limits, as OpenCode does: it has the lane's access and none of the judge's. It starts with
 * a home of its own, no setting sources and no MCP servers, so nothing of a project's or a host's
 * Claude settings runs. Its commands get no credentials (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB), but
 * they run as the same user, which can read the token: the owner accepted that (decision 51).
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

/** What to say when Claude Code can't isolate the agent's commands: bubblewrap is missing. */
export const NO_BUBBLEWRAP =
  "Claude Code needs bubblewrap to keep the agent's commands away from its sign-in, and this rig's image has none: rebuild the image from a newer Thermite, or install bubblewrap in it";

/**
 * Why Claude Code exited, in words. A missing program says so, rather than the shell's note. Its
 * own `error:` line, anywhere in its output, comes before the last line (Bun prints the source
 * around an error after it).
 */
export function claudeExitWords(code: number | string | null, note: string, output = ""): string {
  if ((code === 126 || code === 127) && /claude: (No such file or directory|not found)/.test(note))
    return NO_CLAUDE_CODE;
  const own = /(?:^|\n)\s*error: ([^\n]+)/.exec(output)?.[1]?.trim();
  if (/bubblewrap is required/.test(own ?? note)) return NO_BUBBLEWRAP;
  return `Claude Code exited ${code}: ${own ?? note}`;
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
};

const tokensIn = (u: Usage | undefined) =>
  (u?.input_tokens ?? 0) +
  (u?.cache_creation_input_tokens ?? 0) +
  (u?.cache_read_input_tokens ?? 0);
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
    switch (e.type) {
      case "assistant": {
        const m = e.message ?? {};
        const id = m.id ?? `m${t.messages.size}`;
        if (!t.messages.has(id)) t.turns++;
        t.messages.set(id, { input: tokensIn(m.usage), output: m.usage?.output_tokens ?? 0 });
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

/** The environment Claude Code runs in: its home, Thermite's command, the token and no telemetry. */
export function claudeEnv(o: {
  home: string;
  apiUrl: string;
  auth: string;
  token: string;
  tmp: string;
  maxCommandMs: number;
  extra?: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    ...o.extra,
    HOME: o.home,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: o.tmp,
    THERMITE_HARNESS_URL: o.apiUrl,
    THERMITE_TRIAL_AUTH: o.auth,
    CLAUDE_CODE_OAUTH_TOKEN: o.token,
    // Its commands get no credentials; no update checks, reports or other traffic.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    // A build or a test may run for most of the trial.
    BASH_MAX_TIMEOUT_MS: String(Math.max(120_000, o.maxCommandMs)),
  };
}

/** Claude Code's model name for a route's model (claude-code:opus-5.5[1m] → claude-opus-5-5[1m]). */
export function claudeModelId(m: ModelConfig): string {
  return m.model;
}

/** The flags every headless Claude Code run here has: no settings, no MCP, permissions bypassed. */
export function claudeArgs(
  m: ModelConfig,
  o: {
    tools?: string | undefined;
    session?: string | undefined;
    /** A file with the MCP servers it may use (at the harness's gateway), and only those. */
    mcpConfig?: string | undefined;
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

export interface ClaudeTrialDeps {
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
      token: deps.model.apiKey,
      tmp,
      maxCommandMs: spec.wallMs,
      extra: deps.env,
    }),
    THERMITE_EDITABLE_PATHS: JSON.stringify(spec.editablePaths),
    THERMITE_WORKSPACE: spec.workspace,
    THERMITE_CLAUDE_EVENTS: events,
  };
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
      `mkdir -p claude-home claude-tmp && : > claude-events.jsonl && chmod 0644 claude-events.jsonl${mcp ? " && umask 077 && cat > claude-home/mcp.json" : ""}`,
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
  const deadline = started + spec.wallMs;
  const minutes = Math.round(spec.wallMs / 60_000);
  const maxTurns = spec.maxTurns;
  let message = `${CLAUDE_SYSTEM}${mcp ? `\n\n${mcpLine(spec.mcpServers)}` : ""}\n\n${limitsNote(limits).replace(/OpenCode/g, "Claude Code")}\n\n${spec.brief}\n\nThe editable paths: ${spec.editablePaths.join(", ")}. This trial lasts ${minutes} minutes${maxTurns !== undefined ? ` and at most ${maxTurns} turns (each model reply is one)` : ""}. Submit before it ends.`;
  let offset = 0;
  const carried = new CarriedMessages(deps.messages);
  const pump = () => {
    const r = readNew(events, offset);
    offset = r.next;
    const live = readClaudeEvents(r.lines, tally);
    if (live.length) deps.live(live);
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
    const exe = claudeExe() ?? claudeBin();
    const running = deps.runner.run({
      role: spec.lane,
      // Its output goes to a file the harness follows while it runs.
      argv: [
        "sh",
        "-c",
        'exec "$@" < /dev/null >> "$THERMITE_CLAUDE_EVENTS" 2>&1',
        "sh",
        exe,
        "-p",
        message,
        ...claudeArgs(deps.model, { session: tally.session, mcpConfig: mcpFile }),
      ],
      cwd: spec.workspace,
      env,
      timeoutMs: remaining,
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
    carried.drop();
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
    if (tally.errors.length > errorsBefore && tally.toolCalls === 0) {
      result.stopped = "error";
      result.error = tally.errors.at(-1);
      break;
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
    // Continued twice to get a submission, and then for as long as the owner's messages wait
    // and the agent keeps working. A message is read only once the agent starts on the prompt.
    const progressed = tally.turns + tally.toolCalls > progressBefore;
    if (nudges >= 2 && (!progressed || !(deps.messages?.waiting().length ?? 0))) break;
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
  result.turns = tally.turns;
  result.toolCalls = tally.toolCalls;
  result.tokensIn = tally.tokensIn;
  result.tokensOut = tally.tokensOut;
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
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    role: Role;
    /** The MCP servers the call may use, and the gateway's credential for them (a planner's). */
    mcp?: Omit<McpAccess, "apiUrl"> | undefined;
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
    const setup = await deps.runner.run({
      role,
      argv: ["sh", "-c", `mkdir -p home tmp${mcp ? " && umask 077 && cat > home/mcp.json" : ""}`],
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
      argv: [
        claudeExe() ?? claudeBin(),
        "-p",
        prompt,
        ...claudeArgs(model, {
          tools: o.tools,
          mcpConfig: mcp ? join(dir, "home", "mcp.json") : undefined,
        }),
      ],
      cwd: dir,
      env: claudeEnv({
        home: join(dir, "home"),
        apiUrl: deps.apiUrl,
        auth: "",
        token: model.apiKey,
        tmp: join(dir, "tmp"),
        maxCommandMs: o.timeoutMs,
      }),
      stdin: "",
      timeoutMs: o.timeoutMs,
      captureBytes: 8 * 1024 * 1024,
    });
    readClaudeEvents(r.stdout.split("\n"), tally);
    if (r.killedFor === "timeout")
      tally.errors.push(`no answer in ${Math.round(o.timeoutMs / 1000)} s`);
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
