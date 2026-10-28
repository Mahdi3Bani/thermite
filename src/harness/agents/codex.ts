import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { modelCheckProgramPrompt } from "../../agents/roles/model-check.ts";
import type { LaneLimitValues } from "../../core/contract.ts";
import type { Role } from "../broker/runner.ts";
import { CHECK_ROLE, limitsNote } from "./cli/common.ts";
import { runCliTrial } from "./cli/loop.ts";
import type { CliTrialDeps } from "./cli/program.ts";
import { CliCompactions, type OnceKeeping, reclaim } from "./cli-compaction.ts";
import { codexOwn } from "./cli-conversation.ts";
import { type CodexTally, newCodexTally, readCodexEvents } from "./codex/events.ts";
import {
  codexArgs,
  codexBin,
  codexConfig,
  codexEnv,
  codexExe,
  codexExitWords,
  codexProgram,
} from "./codex/program.ts";
import type { McpAccess } from "./mcp-tools.ts";
import type { ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import type { OpencodeOnceDeps } from "./opencode.ts";
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

export type CodexTrialDeps = CliTrialDeps;

/** One worker trial in the Codex CLI: the CLI trial loop (cli/loop.ts) with Codex's entry. */
export function runCodexTrial(spec: TrialSpec, deps: CodexTrialDeps): Promise<TrialResult> {
  return runCliTrial(codexProgram, spec, deps);
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
    // A call stopped before its run starts nothing, and answers with nothing.
    if (o.signal?.aborted) return tally;
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
  const t = await codexOnce(model, modelCheckProgramPrompt(word), deps, {
    role: CHECK_ROLE,
    timeoutMs,
  });
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
