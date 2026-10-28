import { codexOwn } from "../../../agents/compaction/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import {
  type CodexTally,
  codexArgs,
  codexBin,
  codexConfig,
  codexEnv,
  codexExe,
  codexExitWords,
  newCodexTally,
  readCodexEvents,
} from "../../../agents/programs/index.ts";
import { WORKER_CODEX_SYSTEM } from "../../../agents/roles/worker.ts";
import type { LaneLimitValues } from "../../../core/contract.ts";
import type { RigCheckReport } from "../model/index.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { limitsNote } from "./common.ts";
import { runCliTrial } from "./loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "./once.ts";
import type { CliProgram, CliTrialDeps } from "./program.ts";

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

/**
 * Codex in the CLI trial loop and the one-prompt call: `codex exec` resumes its thread with each
 * continuation.
 */
export const codexProgram: CliProgram<CodexTally> = {
  id: "codex",
  name: "Codex",
  prefix: "codex",
  eventsVar: "THERMITE_CODEX_EVENTS",
  system: WORKER_CODEX_SYSTEM,
  turnWords: "each message or tool call is one",
  bin: codexBin,
  exe: codexExe,
  setup: (run) => ({
    script:
      "mkdir -p codex-home/.codex codex-tmp && cat > codex-home/.codex/config.toml && : > codex-events.jsonl && chmod 0644 codex-events.jsonl",
    stdin: codexConfig(run.model, `${run.apiUrl}/v1/model-proxy`, run.mcp, run.keptAt),
  }),
  // The proxy takes the trial's credential, and so does the gateway of its MCP servers (goal 068).
  env: (run) =>
    codexEnv({
      home: run.home,
      apiUrl: run.apiUrl,
      auth: run.auth,
      proxyAuth: run.auth,
      mcpAuth: run.mcp?.auth,
      tmp: run.tmp,
      extra: run.env,
    }),
  args: (run, session) => codexArgs(run.model, { session }),
  newTally: newCodexTally,
  read: readCodexEvents,
  found: (t) => t.compactions.splice(0),
  // Each compaction's conversation, from Codex's rollout of the thread in its home (goal 070).
  own: (run, t) =>
    codexOwn({
      root: run.area,
      home: ["codex-home", ".codex"],
      title: run.title,
      thread: () => t.session,
    }),
  exitWords: codexExitWords,
  call: {
    setup: (c) => ({
      script: "mkdir -p home/.codex tmp && cat > home/.codex/config.toml",
      stdin: codexConfig(c.model, `${c.apiUrl}/v1/model-proxy`, c.mcp, c.keptAt),
    }),
    // It reaches the model through the proxy with a credential minted for this call.
    env: (c) =>
      codexEnv({
        home: c.home,
        apiUrl: c.apiUrl,
        auth: "",
        proxyAuth: c.proxyAuth(),
        mcpAuth: c.mcp?.auth,
        tmp: c.tmp,
      }),
    args: (c) => codexArgs(c.model),
    // Each compaction's conversation, from its rollout in the call's folder (goal 070).
    own: (c, title, t) =>
      codexOwn({ root: c.dir, home: ["home", ".codex"], title, thread: () => t.session }),
  },
  check: { baseUrl: (m) => m.baseUrl },
};

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
