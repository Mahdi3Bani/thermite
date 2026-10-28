import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_CLAUDE_CODE_SYSTEM } from "../../../agents/roles/worker.ts";
import { COMPACT_AT_DEFAULT } from "../../../core/compaction.ts";
import { agentPath } from "../cli/common.ts";
import type { CliProgram } from "../cli/program.ts";
import { type KeptAt, keptLine } from "../cli-compaction.ts";
import { claudeOwn } from "../cli-conversation.ts";
import { claudeMcpConfig } from "../mcp-tools.ts";
import type { ModelConfig } from "../model.ts";
import { OPENCODE_MEMORY } from "../opencode/program.ts";
import { type ClaudeTally, closeClaudeRun, newClaudeTally, readClaudeEvents } from "./events.ts";
import {
  CLAUDE_BASE_ENV,
  CLAUDE_PROMPT,
  claudeBin,
  claudeExe,
  claudeShell,
  PROMPT_VAR,
  writeClaudePrompt,
} from "./shell.ts";

/**
 * Claude Code as Thermite starts it: its exit words, its environment and compaction settings, its
 * command line, and its entry for the CLI trial loop (cli/loop.ts).
 */

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

/** Claude Code's PreCompact hook, as a program (compaction-hook.ts, in the folder above). */
export const CLAUDE_HOOK = fileURLToPath(
  new URL(`../compaction-hook${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
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

/**
 * Claude Code in the CLI trial loop: its token on file descriptor 3 and its prompt from a file the
 * lane writes before each run, a run cut short that keeps its usage, and the subscription's usage
 * windows, a full one of which ends the trial.
 */
export const claudeProgram: CliProgram<ClaudeTally> = {
  name: "Claude Code",
  prefix: "claude",
  eventsVar: "THERMITE_CLAUDE_EVENTS",
  system: WORKER_CLAUDE_CODE_SYSTEM,
  turnWords: "each model reply is one",
  memory: OPENCODE_MEMORY,
  bin: claudeBin,
  exe: claudeExe,
  // The MCP servers the run's kit gives its workers (goal 068), at the harness's gateway with the
  // trial's own token: in a file only the lane reads.
  setup: (run) => {
    const mcp = claudeMcpConfig(run.mcp);
    return {
      script: `mkdir -p claude-home claude-tmp ${CLAUDE_DROPS} && chmod 0755 ${CLAUDE_DROPS} && : > claude-events.jsonl && chmod 0644 claude-events.jsonl${mcp ? " && umask 077 && cat > claude-home/mcp.json" : ""}`,
      stdin: mcp,
    };
  },
  env: (run) => ({
    ...claudeEnv({
      home: run.home,
      apiUrl: run.apiUrl,
      auth: run.auth,
      tmp: run.tmp,
      maxCommandMs: run.wallMs,
      extra: run.env,
    }),
    ...claudeCompactionEnv(run.model),
    [PROMPT_VAR]: join(run.area, CLAUDE_PROMPT),
  }),
  // Before each compaction, Claude Code's hook copies its transcript into the run's own area and
  // tells the summary where the harness keeps it (goal 070).
  args: (run, session) => [
    "-p",
    ...claudeArgs(run.model, {
      session,
      mcpConfig: run.mcp ? join(run.home, "mcp.json") : undefined,
      settings: run.keptAt
        ? claudeHookSettings(join(run.area, CLAUDE_DROPS), run.keptAt)
        : undefined,
    }),
  ],
  // The token comes on stdin, which the shell moves to file descriptor 3 for Claude Code.
  shell: claudeShell,
  stdin: (_prompt, run) => run.model.apiKey,
  newTally: newClaudeTally,
  read: readClaudeEvents,
  found: (t) => t.compactions.splice(0),
  // The harness reads the hook's copy, or else the transcript itself, once Claude Code reports
  // the compaction (goal 070).
  own: (run, t) =>
    claudeOwn({
      root: run.area,
      drops: [CLAUDE_DROPS],
      home: ["claude-home"],
      title: run.title,
      session: () => t.session,
    }),
  exitWords: claudeExitWords,
  // The prompt, written by the lane into its own area, for Claude Code's stdin.
  beforeRun: (prompt, run, runner) => writeClaudePrompt(runner, run.role, run.area, prompt),
  // A run cut off before its result (a submission, the cap) keeps what its stream showed.
  closeRun: closeClaudeRun,
  onRead: (t, deps) => {
    if (t.usage) deps.usage?.(t.usage);
  },
  // A full usage window: the trial ends, and the lane waits for the reset (never paid credits).
  stopAfterRun: (t) =>
    t.limitedUntil
      ? {
          stopped: "error",
          errorKind: "rate_limit",
          retryAfter: t.limitedUntil,
          error: `the Claude subscription's usage window is full until ${t.limitedUntil}`,
        }
      : undefined,
};
