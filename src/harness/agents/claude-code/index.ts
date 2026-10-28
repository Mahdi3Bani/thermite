import { runCliTrial } from "../cli/loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "../cli/once.ts";
import type { CliTrialDeps } from "../cli/program.ts";
import type { ModelConfig } from "../model.ts";
import type { RigCheckReport } from "../model-check.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import type { ClaudeTally } from "./events.ts";
import { claudeProgram } from "./program.ts";

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

export type { UsageWindow } from "../plan-windows.ts";
export { mergeUsage } from "../plan-windows.ts";
export type { ClaudeTally } from "./events.ts";
export {
  claudeResultUsage,
  closeClaudeRun,
  newClaudeTally,
  readClaudeEvents,
} from "./events.ts";
export {
  CLAUDE_HOOK,
  claudeArgs,
  claudeCompactionEnv,
  claudeEnv,
  claudeExitWords,
  claudeHookSettings,
  NO_CLAUDE_CODE,
} from "./program.ts";
export {
  CLAUDE_BASE_ENV,
  CLAUDE_PROMPT,
  CLAUDE_TOKEN_FD,
  claudeBin,
  claudeExe,
  claudeShell,
} from "./shell.ts";

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
