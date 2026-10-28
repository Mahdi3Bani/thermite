import type { ResearchFolderPaths } from "../../../agents/tools/research.ts";
import {
  agentPath,
  breachError,
  CHECK_ROLE,
  limitsNote,
  PLANNER_ROLE,
  takeUsage,
} from "../cli/common.ts";
import { runCliTrial } from "../cli/loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "../cli/once.ts";
import type { CliTrialDeps } from "../cli/program.ts";
import type { ModelConfig } from "../model.ts";
import type { RigCheckReport } from "../model-check.ts";
import type { ResearchTrialSpec } from "../research-worker.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { newTally, type OpencodeTally, readOpencodeEvents } from "./events.ts";
import { opencodeProgram } from "./program.ts";

export {
  OPENCODE_MEMORY,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_LINK,
  opencodeConfig,
  opencodeKeepEnv,
  opencodeModelId,
  runEnv,
} from "./program.ts";
export { NO_OPENCODE, opencodeBin, opencodeExe, opencodeExitWords } from "./run.ts";

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

export type { OpencodeTally };
export {
  agentPath,
  breachError,
  CHECK_ROLE,
  limitsNote,
  newTally,
  PLANNER_ROLE,
  readOpencodeEvents,
  takeUsage,
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
