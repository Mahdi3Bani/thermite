import { join } from "node:path";
import { opencodeOwn } from "../../../agents/compaction/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import {
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
  readOpencodeEvents,
  runEnv,
} from "../../../agents/programs/index.ts";
import { WORKER_OPENCODE_SYSTEM } from "../../../agents/roles/index.ts";
import type { ResearchFolderPaths } from "../../../agents/tools/index.ts";
import type { RigCheckReport } from "../model/index.ts";
import type { ResearchTrialSpec } from "../research/index.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { runCliTrial } from "./loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "./once.ts";
import type { CliProgram, CliTrialDeps } from "./program.ts";

/**
 * Trials (hill-climb, goal and research), model checks and planner calls in OpenCode v2 instead
 * of Pi. OpenCode runs headless with its permissions approved (`--auto`) as the lane's own user,
 * in the lane's workspace, under the same memory, disk and time limits as the lane's commands: it
 * has exactly the lane's access, and none of the judge's. Its permission rules are not a boundary
 * (its Code Mode reaches the network whatever they say); the user it runs as is.
 *
 * Thermite's own tools are the `thermite-trial` command (submit, dev-run, status, and a research
 * trial's tools), which calls the harness API with the trial's token. A provider's key never
 * reaches the lane: OpenCode calls the provider through the harness API's model proxy, which
 * checks the trial's token and adds the key. OpenCode's own models (its free ones) need no key.
 */

/** What OpenCode itself uses, as its limits note says. */
export const OPENCODE_MEMORY = "about 500 MiB";

/**
 * OpenCode in the CLI trial loop and the one-prompt call: `opencode run` continues its session
 * with each continuation. It runs research trials too.
 */
export const opencodeProgram: CliProgram<OpencodeTally> = {
  id: "opencode",
  name: "OpenCode",
  research: true,
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
    ...opencodeArgs(run.model),
    ...(session ? ["--session", session] : ["--title", `trial ${run.trialId}`]),
  ],
  newTally,
  read: readOpencodeEvents,
  found: (_t, read) => opencodeFound(read.area, [OPENCODE_DROPS], read.count, read.at),
  // Each compaction Thermite's plugin saw end, with the session it kept before it (goal 070).
  own: (run) => opencodeOwn({ root: run.area, drops: [OPENCODE_DROPS], title: run.title }),
  exitWords: opencodeExitWords,
  call: {
    // Thermite's compaction plugin, when the call's conversation is kept (goal 070).
    setup: (c) => {
      const keep = c.keptAt !== undefined;
      return {
        script: `mkdir -p home/.config/opencode tmp && umask 077 && cat > home/.config/opencode/opencode.jsonc${keep ? ` && mkdir -p home/.config/opencode/plugins compactions && ln -sf "$1" home/${OPENCODE_PLUGIN_LINK}` : ""}`,
        args: keep ? ["sh", OPENCODE_PLUGIN] : [],
        stdin: JSON.stringify(opencodeConfig(c.model, `${c.apiUrl}/v1/model-proxy`, c.mcp)),
      };
    },
    // A credential minted for the call reaches the proxy (none needed for OpenCode's own models).
    env: (c) => ({
      ...runEnv(c.home, c.apiUrl, c.proxyAuth(), {}),
      TMPDIR: c.tmp,
      ...(c.keptAt ? opencodeKeepEnv(join(c.dir, "compactions"), c.keptAt) : {}),
    }),
    args: (c) => opencodeArgs(c.model),
    // The plugin's records, which the controller reads once it has the call's folder back.
    kept: (c, at) => opencodeFound(c.dir, ["compactions"], 0, at),
    own: (c, title) => opencodeOwn({ root: c.dir, drops: ["compactions"], title }),
  },
  check: { baseUrl: (m) => (m.api === "opencode" ? "opencode" : m.baseUrl) },
};

export type OpencodeTrialDeps = CliTrialDeps;

/** One worker trial in OpenCode: the CLI trial loop (cli/loop.ts) with OpenCode's entry. */
export function runOpencodeTrial(spec: TrialSpec, deps: OpencodeTrialDeps): Promise<TrialResult> {
  return runCliTrial(opencodeProgram, { mode: "code", spec }, deps);
}

export interface OpencodeResearchDeps extends Omit<OpencodeTrialDeps, "submitted"> {
  /** The trial's own area in the lane (owned by its user): OpenCode's home, temporary files, events. */
  area: string;
  /** The run's research folder; the agent works in its lane's working area there. */
  folder: ResearchFolderPaths;
}

/**
 * One research trial in OpenCode: the CLI trial loop's research mode. The same tools as a
 * hill-climb trial (its shell, files and web search) plus the research tools as `thermite-trial
 * research` commands, which reach the harness's research service with the trial's token. As in
 * Pi, the trial ends when the agent stops, its time or turns run out, or it is stopped.
 */
export function runOpencodeResearchTrial(
  spec: ResearchTrialSpec,
  deps: OpencodeResearchDeps,
): Promise<TrialResult> {
  return runCliTrial(
    opencodeProgram,
    { mode: "research", spec, area: deps.area, folder: deps.folder },
    deps,
  );
}

/** One prompt through OpenCode as `role`, in a fresh directory of its own, removed afterwards. */
export function opencodeOnce(
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: Omit<CliOnceOptions, "tools">,
): Promise<OpencodeTally> {
  return cliOnce(opencodeProgram, model, prompt, deps, o);
}

/** The model check in OpenCode (cli/once.ts). */
export function opencodeModelCheck(
  model: ModelConfig,
  deps: CliOnceDeps,
  timeoutMs?: number,
): Promise<RigCheckReport> {
  return cliModelCheck(opencodeProgram, model, deps, timeoutMs);
}
