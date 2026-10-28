import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORKER_CODEX_SYSTEM } from "../../../agents/roles/worker.ts";
import { agentPath } from "../cli/common.ts";
import type { CliProgram } from "../cli/program.ts";
import { codexCompactPrompt, compactionTokens, type KeptAt } from "../cli-compaction.ts";
import { codexOwn } from "../cli-conversation.ts";
import { gatewayUrl, type McpAccess } from "../mcp-tools.ts";
import type { ModelConfig } from "../model.ts";
import { type CodexTally, newCodexTally, readCodexEvents } from "./events.ts";

/**
 * The Codex CLI as Thermite starts it: its binary, its configuration, its command line and its
 * environment, and its entry for the CLI trial loop (cli/loop.ts).
 */

/** The Codex CLI's binary: THERMITE_CODEX_BIN, else `codex` on the PATH (read when used). */
export const codexBin = () => process.env.THERMITE_CODEX_BIN ?? "codex";

/** What to say when the image has no Codex CLI: an image built with an empty CODEX_VERSION. */
export const NO_CODEX =
  "this rig's harness image has no Codex CLI: build the image with the Codex option (CODEX_VERSION, which the published images set), or give the rig another harness on Edit rig";

/** Why the Codex CLI exited, in words. A missing program says so, rather than the shell's note. */
export function codexExitWords(code: number | string | null, note: string): string {
  if ((code === 126 || code === 127) && /codex: (No such file or directory|not found)/.test(note))
    return NO_CODEX;
  return `Codex exited ${code}: ${note}`;
}

/** The Codex CLI's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function codexExe(): string | undefined {
  const bin = codexBin();
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** A TOML basic string (the configuration Codex reads). */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\" || ch === '"') out += `\\${ch}`;
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * The Codex CLI's configuration for a run ($CODEX_HOME/config.toml): one provider, the harness's
 * key-adding proxy (`proxyRoot`) over the Responses API, with the run's credential from
 * THERMITE_PROXY_AUTH; the route's reasoning effort ("off" sends "none"); no hosted web search,
 * analytics, feedback, update checks or history file. The MCP servers the run's kit gives this
 * agent (goal 068) are each a streamable HTTP server at the harness's gateway, with the gateway's
 * credential from THERMITE_MCP_AUTH (never in the file), and none is required to start.
 *
 * `keptAt` (goal 070): where Thermite keeps the conversation before each compaction. Codex 0.162
 * takes a compaction prompt of its own (`compact_prompt`, which replaces its built-in one): Thermite
 * gives it its own summary prompt, which names that folder, and reads the conversation from
 * Codex's rollout of the thread once Codex reports the compaction.
 */
export function codexConfig(
  m: ModelConfig,
  proxyRoot: string,
  mcp?: Pick<McpAccess, "apiUrl" | "servers"> | undefined,
  keptAt?: KeptAt | undefined,
): string {
  const effort = m.reasoning === "off" ? "none" : m.reasoning;
  const servers = (mcp?.servers ?? []).flatMap((s) => [
    `[mcp_servers.${s}]`,
    `url = ${tomlString(gatewayUrl(mcp?.apiUrl ?? "", s))}`,
    'bearer_token_env_var = "THERMITE_MCP_AUTH"',
    "required = false",
    "",
  ]);
  // The window (the route's, so the owner's cap) and the compaction point (goal 070). Codex
  // compacts on its own, by default at 90% of the window; it keeps a window to the most the
  // model takes (272,000 tokens for a model it does not know).
  const point = compactionTokens(m);
  return [
    "# Written by Thermite's harness for one run.",
    'model_provider = "thermite"',
    ...(effort ? [`model_reasoning_effort = ${tomlString(effort)}`] : []),
    ...(point !== undefined
      ? [`model_context_window = ${m.contextWindow}`, `model_auto_compact_token_limit = ${point}`]
      : []),
    ...(keptAt ? [`compact_prompt = ${tomlString(codexCompactPrompt(keptAt))}`] : []),
    'web_search = "disabled"',
    "check_for_update_on_startup = false",
    "",
    "[model_providers.thermite]",
    'name = "Thermite route"',
    `base_url = ${tomlString(proxyRoot)}`,
    'env_key = "THERMITE_PROXY_AUTH"',
    'wire_api = "responses"',
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
    ...servers,
  ].join("\n");
}

/**
 * The flags every headless Codex run here has: JSON events, no git check (a check or a plan runs
 * in an empty directory), no execution-policy rules from the project, approvals and its sandbox
 * off; the prompt on stdin ("-"). A session is resumed by its thread's id.
 */
export function codexArgs(m: ModelConfig, o: { session?: string | undefined } = {}): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    m.model,
    ...(o.session ? ["resume", o.session] : []),
    "-",
  ];
}

/** The environment Codex runs in: its home, Thermite's command and the run's proxy credential. */
export function codexEnv(o: {
  home: string;
  apiUrl: string;
  /** The trial's credential for `thermite-trial` (empty outside a trial). */
  auth: string;
  /** What the model proxy takes: the trial's credential, or one minted for a check or a plan. */
  proxyAuth: string;
  /** What the MCP gateway takes, when the agent has MCP servers: the trial's, or the plan's. */
  mcpAuth?: string | undefined;
  tmp: string;
  extra?: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    ...o.extra,
    ...(o.mcpAuth ? { THERMITE_MCP_AUTH: o.mcpAuth } : {}),
    HOME: o.home,
    CODEX_HOME: join(o.home, ".codex"),
    PATH: agentPath(),
    TMPDIR: o.tmp,
    THERMITE_HARNESS_URL: o.apiUrl,
    THERMITE_TRIAL_AUTH: o.auth,
    THERMITE_PROXY_AUTH: o.proxyAuth,
  };
}

/** Codex in the CLI trial loop: `codex exec` resumes its thread with each continuation. */
export const codexProgram: CliProgram<CodexTally> = {
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
};
