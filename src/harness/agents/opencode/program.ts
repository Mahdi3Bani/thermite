import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_OPENCODE_SYSTEM } from "../../../agents/roles/worker.ts";
import { agentPath } from "../cli/common.ts";
import type { CliProgram } from "../cli/program.ts";
import {
  compactionTokens,
  type FoundCompaction,
  type KeptAt,
  keptLine,
} from "../cli-compaction.ts";
import { opencodeEnded, opencodeOwn } from "../cli-conversation.ts";
import { type McpAccess, opencodeMcp } from "../mcp-tools.ts";
import type { ModelConfig } from "../model.ts";
import { newTally, type OpencodeTally, readOpencodeEvents } from "./events.ts";
import { opencodeBin, opencodeExe, opencodeExitWords } from "./run.ts";

/**
 * OpenCode as Thermite starts it: its configuration, its compaction plugin, its environment, and
 * its entry for the CLI trial loop (cli/loop.ts).
 */

/** This module's own extension: `.js` when built, `.ts` when run from the source. */
const OWN_EXT = extname(fileURLToPath(import.meta.url));
/** Thermite's OpenCode plugin (opencode-plugin.ts, in the folder above), which OpenCode loads. */
export const OPENCODE_PLUGIN = fileURLToPath(
  new URL(`../opencode-plugin${OWN_EXT}`, import.meta.url),
);
/** Where OpenCode finds the plugin, under its home: a link in its own settings' plugins folder. */
export const OPENCODE_PLUGIN_LINK = `.config/opencode/plugins/thermite-compaction${OWN_EXT}`;
/** The folder in an OpenCode run's own area where the plugin keeps each compaction's session. */
export const OPENCODE_DROPS = "opencode-compactions";

/**
 * What Thermite's plugin reads from OpenCode's environment (goal 070): its folder, and the line
 * that tells the summary where the harness keeps the conversation.
 */
export function opencodeKeepEnv(drops: string, at: KeptAt): Record<string, string> {
  return { THERMITE_COMPACTION_DROPS: drops, THERMITE_COMPACTION_LINE: keptLine(at) };
}

/**
 * The compactions Thermite's plugin saw end, in `drops`, past the first `count`; each comes `at`
 * that many of a read's live entries (goal 070). OpenCode's own output does not report them; the
 * plugin's records do.
 */
export function opencodeFound(
  root: string,
  drops: string[],
  count: number,
  at: number,
): FoundCompaction[] {
  return opencodeEnded(root, drops)
    .filter((n) => n > count)
    .map(() => ({ at, tokensBefore: null, tokensAfter: null }));
}

/** The model as OpenCode names it: its own models, or the rig's provider as "thermite". */
export function opencodeModelId(m: ModelConfig): string {
  return m.api === "opencode" ? `opencode/${m.model}` : `thermite/${m.model}`;
}

/**
 * OpenCode's configuration for a run. Nobody answers a question in a headless run, so OpenCode's
 * question tool is denied. A provider other than OpenCode's own is reached through the harness's
 * key-adding proxy (`proxyRoot`), with the run's proxy credential from THERMITE_PROXY_AUTH.
 *
 * Compaction (goal 070): OpenCode compacts its conversation on its own (`compaction.auto`), but
 * only for a model whose window it knows. For the rig's provider, the model's `limit.context` is
 * the route's window (so the owner's cap), and `compaction.buffer`, the tokens it keeps free
 * below that window, puts its compaction point at the route's share. OpenCode's own models keep
 * the windows and the compaction point OpenCode knows for them.
 */
export function opencodeConfig(
  m: ModelConfig,
  proxyRoot: string,
  mcp?: McpAccess | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permissions: [{ action: "question", resource: "*", effect: "deny" }],
  };
  // The MCP servers the run's kit gives this agent (goal 068), each at the harness's gateway.
  const servers = opencodeMcp(mcp);
  if (servers) config.mcp = servers;
  const point = m.api !== "opencode" ? compactionTokens(m) : undefined;
  config.compaction = {
    auto: true,
    ...(point !== undefined ? { buffer: m.contextWindow - point } : {}),
  };
  if (m.api !== "opencode") {
    const anthropic = m.api === "anthropic";
    config.providers = {
      thermite: {
        name: "Thermite route",
        env: ["THERMITE_PROXY_AUTH"],
        // A ChatGPT sign-in: OpenAI's Responses API (OpenCode's own OpenAI provider posts to
        // {base}/responses with store off and the whole history; the proxy drops what the
        // route refuses, such as max_output_tokens).
        package: anthropic
          ? "@opencode/ai/providers/anthropic"
          : m.api === "chatgpt"
            ? "@opencode/ai/providers/openai"
            : "@opencode/ai/providers/openai-compatible",
        // Anthropic's client posts to {base}/messages; its API is at /v1/messages.
        settings: { baseURL: anthropic ? `${proxyRoot}/v1` : proxyRoot },
        models: {
          [m.model]: {
            name: m.model,
            ...(point !== undefined ? { limit: { context: m.contextWindow } } : {}),
          },
        },
      },
    };
  }
  return config;
}

/** What OpenCode itself uses, as its limits note says (Claude Code's says the same, unmeasured). */
export const OPENCODE_MEMORY = "about 500 MiB";

/** The environment of an OpenCode run: its home, Thermite's command and how to reach the API. */
export function runEnv(home: string, apiUrl: string, auth: string, extra: Record<string, string>) {
  return {
    ...extra,
    HOME: home,
    PATH: agentPath(),
    THERMITE_HARNESS_URL: apiUrl,
    THERMITE_TRIAL_AUTH: auth,
    THERMITE_PROXY_AUTH: auth,
  };
}

/** OpenCode in the CLI trial loop: `opencode run` continues its session with each continuation. */
export const opencodeProgram: CliProgram<OpencodeTally> = {
  name: "OpenCode",
  prefix: "opencode",
  eventsVar: "THERMITE_OPENCODE_EVENTS",
  system: WORKER_OPENCODE_SYSTEM,
  turnWords: "each model reply is one",
  memory: OPENCODE_MEMORY,
  bin: opencodeBin,
  exe: opencodeExe,
  // The configuration may hold the trial's own token (its MCP servers): only the lane reads it.
  // With a place to keep the conversation, Thermite's compaction plugin is linked into its
  // settings, and the plugin's folder is made (goal 070).
  setup: (run) => {
    const keep = run.keptAt !== undefined;
    return {
      script: `mkdir -p opencode-home/.config/opencode opencode-tmp && umask 077 && cat > opencode-home/.config/opencode/opencode.jsonc && : > opencode-events.jsonl && chmod 0644 opencode-events.jsonl${keep ? ` && mkdir -p opencode-home/.config/opencode/plugins ${OPENCODE_DROPS} && chmod 0755 ${OPENCODE_DROPS} && ln -sf "$1" opencode-home/${OPENCODE_PLUGIN_LINK}` : ""}`,
      args: keep ? ["sh", OPENCODE_PLUGIN] : [],
      stdin: JSON.stringify(opencodeConfig(run.model, `${run.apiUrl}/v1/model-proxy`, run.mcp)),
    };
  },
  env: (run) => ({
    ...runEnv(run.home, run.apiUrl, run.auth, run.env ?? {}),
    // Its own temp directory: the shared /tmp is not the lane's.
    TMPDIR: run.tmp,
    ...(run.keptAt ? opencodeKeepEnv(join(run.area, OPENCODE_DROPS), run.keptAt) : {}),
  }),
  args: (run, session) => [
    "run",
    "--standalone",
    "--auto",
    "--format",
    "json",
    "--model",
    opencodeModelId(run.model),
    ...(session ? ["--session", session] : ["--title", `trial ${run.trialId}`]),
  ],
  newTally,
  read: readOpencodeEvents,
  found: (_t, read) => opencodeFound(read.area, [OPENCODE_DROPS], read.count, read.at),
  // Each compaction Thermite's plugin saw end, with the session it kept before it (goal 070).
  own: (run) => opencodeOwn({ root: run.area, drops: [OPENCODE_DROPS], title: run.title }),
  exitWords: opencodeExitWords,
};
