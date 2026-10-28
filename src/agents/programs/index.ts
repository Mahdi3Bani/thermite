/**
 * The agent programs that run as command-line programs, as Thermite starts them for the harness's
 * agents and the supervisor's advisors: Claude Code (claude-code/), the Codex CLI (codex/) and
 * OpenCode v2 (opencode/), each with its binary, its configuration and environment, its command
 * line and how its output is read; and the PATH their agent's shell gets (path.ts). The harness's
 * trial loop for them is src/harness/agents/cli/.
 */

export {
  CLAUDE_BASE_ENV,
  CLAUDE_DROPS,
  CLAUDE_HOOK,
  CLAUDE_PROMPT,
  CLAUDE_TOKEN_FD,
  type ClaudeTally,
  claudeArgs,
  claudeBin,
  claudeCompactionEnv,
  claudeEnv,
  claudeExe,
  claudeExitWords,
  claudeHookSettings,
  claudeModelId,
  claudeResultUsage,
  claudeShell,
  closeClaudeRun,
  mergeUsage,
  NO_CLAUDE_CODE,
  newClaudeTally,
  type PlanWindows,
  PROMPT_VAR,
  readClaudeEvents,
  type UsageWindow,
} from "./claude-code/index.ts";
export {
  type CodexTally,
  codexArgs,
  codexBin,
  codexConfig,
  codexEnv,
  codexExe,
  codexExitWords,
  NO_CODEX,
  newCodexTally,
  readCodexEvents,
  tomlString,
} from "./codex/index.ts";
export {
  NO_OPENCODE,
  newTally,
  OPENCODE_DROPS,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_LINK,
  type OpencodeTally,
  opencodeArgs,
  opencodeBin,
  opencodeConfig,
  opencodeExe,
  opencodeExitWords,
  opencodeFound,
  opencodeKeepEnv,
  opencodeModelId,
  readNew,
  readOpencodeEvents,
  runEnv,
} from "./opencode/index.ts";
export { agentPath } from "./path.ts";
