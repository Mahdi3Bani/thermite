import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeOwn } from "../../../agents/compaction/index.ts";
import { claudeMcpConfig } from "../../../agents/mcp/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import {
  CLAUDE_DROPS,
  CLAUDE_PROMPT,
  type ClaudeTally,
  claudeArgs,
  claudeBin,
  claudeCompactionEnv,
  claudeEnv,
  claudeExe,
  claudeExitWords,
  claudeHookSettings,
  claudeShell,
  closeClaudeRun,
  newClaudeTally,
  PROMPT_VAR,
  readClaudeEvents,
} from "../../../agents/programs/index.ts";
import type { Role, Runner } from "../../broker/index.ts";
import type { RigCheckReport } from "../model/index.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { runCliTrial } from "./loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "./once.ts";
import type { CliProgram, CliTrialDeps } from "./program.ts";

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
 * that (decision 51). Claude Code's own sandbox stays off (src/agents/programs/claude-code/ says
 * why).
 *
 * Thermite's own tools are the `thermite-trial` command, which calls the harness API with the
 * trial's token. Claude Code reports the subscription's usage windows as it goes
 * (rate_limit_event); a full window ends the trial with the time it resets.
 */

/**
 * Writes a run's prompt into its folder (`cwd`), as the run's role: a trial's area is the lane's.
 * Undefined when it is written; else why not, in words.
 */
async function writeClaudePrompt(
  runner: Runner,
  role: Role,
  cwd: string,
  prompt: string,
): Promise<string | undefined> {
  const r = await runner.run({
    role,
    argv: ["sh", "-c", `umask 077 && cat > ${CLAUDE_PROMPT}`],
    cwd,
    stdin: prompt,
    timeoutMs: 30_000,
    captureBytes: 4096,
  });
  return r.exitCode === 0
    ? undefined
    : `could not write Claude Code's prompt: ${r.stderr.slice(-300)}`;
}

/**
 * Claude Code in the CLI trial loop and the one-prompt call: its token on file descriptor 3 and
 * its prompt from a file the lane (or, for a call, the controller) writes before each run, a run
 * cut short that keeps its usage, and the subscription's usage windows, a full one of which ends
 * the trial.
 */
/**
 * What Claude Code itself uses, as its limits note says: measured in the real Claude Code
 * acceptance (2026-10-28: 343 MiB at its trial's peak, with the commands it ran).
 */
export const CLAUDE_CODE_MEMORY = "about 350 MiB";

export const claudeProgram: CliProgram<ClaudeTally> = {
  id: "claude-code",
  name: "Claude Code",
  prefix: "claude",
  eventsVar: "THERMITE_CLAUDE_EVENTS",
  turnWords: "each model reply is one",
  memory: CLAUDE_CODE_MEMORY,
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
  windows: (t) => t.usage,
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
  call: {
    setup: (c) => {
      const mcp = claudeMcpConfig(c.mcp);
      return {
        script: `mkdir -p home tmp${c.keptAt ? " compactions" : ""}${mcp ? " && umask 077 && cat > home/mcp.json" : ""}`,
        stdin: mcp,
      };
    },
    env: (c) => ({
      ...claudeEnv({
        home: c.home,
        apiUrl: c.apiUrl,
        auth: "",
        tmp: c.tmp,
        maxCommandMs: c.timeoutMs,
      }),
      // A planner's call compacts as the workers' trials do (goal 070).
      ...claudeCompactionEnv(c.model),
      [PROMPT_VAR]: join(c.dir, CLAUDE_PROMPT),
    }),
    args: (c) => [
      "-p",
      ...claudeArgs(c.model, {
        tools: c.tools,
        mcpConfig: c.mcp ? join(c.home, "mcp.json") : undefined,
        // Its PreCompact hook, when the call's conversation is kept (goal 070).
        settings: c.keptAt ? claudeHookSettings(join(c.dir, "compactions"), c.keptAt) : undefined,
      }),
    ],
    // The prompt for Claude Code's stdin, handed over with the folder.
    prepare: (c, prompt) => writeFileSync(join(c.dir, CLAUDE_PROMPT), prompt, { mode: 0o600 }),
    own: (c, title, t) =>
      claudeOwn({
        root: c.dir,
        drops: ["compactions"],
        home: ["home"],
        title,
        session: () => t.session,
      }),
  },
  answer: (t) => t.result,
  // No tools, or the read-only file tools when it has past research to read.
  plannerTools: (read) => (read ? "Read,Grep,Glob" : ""),
  check: {
    tool: "Bash",
    why: (t) =>
      t.limitedUntil
        ? `the subscription's usage window is full until ${t.limitedUntil}`
        : undefined,
  },
};

/**
 * One worker trial in Claude Code: the CLI trial loop (cli/loop.ts) with Claude Code's entry. A
 * full usage window ends the trial with the time it resets.
 */
export function runClaudeTrial(spec: TrialSpec, deps: CliTrialDeps): Promise<TrialResult> {
  return runCliTrial(claudeProgram, { mode: "code", spec }, deps);
}

/**
 * One prompt through Claude Code outside a trial (a model check, a planner call), as `role` (the
 * planner's or the model check's own user) in a fresh directory, removed afterwards. `tools` ""
 * gives it none.
 */
export function claudeOnce(
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: CliOnceOptions & { tools: string },
): Promise<ClaudeTally> {
  return cliOnce(claudeProgram, model, prompt, deps, o);
}

/** The model check in Claude Code: the model must run one shell command through its Bash tool. */
export function claudeModelCheck(
  model: ModelConfig,
  deps: CliOnceDeps,
  timeoutMs?: number,
): Promise<RigCheckReport> {
  return cliModelCheck(claudeProgram, model, deps, timeoutMs);
}
