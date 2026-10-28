import type { LaneLimitValues } from "../../core/contract.ts";
import { limitsNote } from "./cli/common.ts";
import { runCliTrial } from "./cli/loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "./cli/once.ts";
import type { CliTrialDeps } from "./cli/program.ts";
import type { CodexTally } from "./codex/events.ts";
import { codexProgram } from "./codex/program.ts";
import type { ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";

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

export type { CodexTally } from "./codex/events.ts";
export { newCodexTally, readCodexEvents } from "./codex/events.ts";
export {
  codexArgs,
  codexBin,
  codexConfig,
  codexEnv,
  codexExe,
  codexExitWords,
  NO_CODEX,
  tomlString,
} from "./codex/program.ts";

/** The lane's limits as the agent must know them: Codex and its commands share them. */
export const codexLimitsNote = (limits: LaneLimitValues) => limitsNote(limits, "Codex");

/** One worker trial in the Codex CLI: the CLI trial loop (cli/loop.ts) with Codex's entry. */
export function runCodexTrial(spec: TrialSpec, deps: CliTrialDeps): Promise<TrialResult> {
  return runCliTrial(codexProgram, { mode: "code", spec }, deps);
}

/**
 * One prompt through the Codex CLI outside a trial (a model check, a planner call), as `role`
 * (the planner's or the model check's own user) in a fresh directory, removed afterwards. It
 * reaches the model through the proxy with a credential minted for this call.
 */
export function codexOnce(
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: Omit<CliOnceOptions, "tools">,
): Promise<CodexTally> {
  return cliOnce(codexProgram, model, prompt, deps, o);
}

/** The model check in the Codex CLI (cli/once.ts). */
export function codexModelCheck(
  model: ModelConfig,
  deps: CliOnceDeps,
  timeoutMs?: number,
): Promise<RigCheckReport> {
  return cliModelCheck(codexProgram, model, deps, timeoutMs);
}
