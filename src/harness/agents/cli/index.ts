/**
 * The agent programs that run as command-line programs (OpenCode, Claude Code, Codex): each
 * program's entry (program.ts and one file for each), their trial loop (loop.ts, common.ts) and
 * their one-prompt call (once.ts).
 */

export { claudeProgram } from "./claude-code.ts";
export { codexProgram } from "./codex.ts";
export { runCliTrial } from "./loop.ts";
export { type CliAskOptions, type CliOnceDeps, cliAsk, cliModelCheck } from "./once.ts";
export { opencodeProgram } from "./opencode.ts";
export type { CliHarness, CliProgram, CliTally, CliTrialDeps } from "./program.ts";
