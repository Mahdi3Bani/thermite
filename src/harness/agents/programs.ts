import type { CliCompacted } from "../../agents/compaction/index.ts";
import type { ModelConfig } from "../../agents/model/index.ts";
import type { ResearchFolderPaths } from "../../agents/tools/index.ts";
import { type Harness, type ProviderType, programForApi, reaches } from "../../core/agents.ts";
import type { Role } from "../broker/index.ts";
import {
  type CliAskOptions,
  type CliHarness,
  type CliOnceDeps,
  type CliProgram,
  type CliTally,
  type CliTrialDeps,
  claudeProgram,
  cliAsk,
  cliModelCheck,
  codexProgram,
  opencodeProgram,
  runCliTrial,
} from "./cli/index.ts";
import { checkModel, type RigCheckReport } from "./model/index.ts";
import type { ResearchTrialSpec } from "./research/index.ts";
import { spawnTrial } from "./spawn.ts";
import type { TrialResult, TrialSpec } from "./worker/index.ts";
import { prepareResearchArea } from "./workspace.ts";

/**
 * The agent programs (goal 125, T7): one entry for each program a rig's agents may run in, which
 * the harness consults wherever it picks one. Pi runs in the harness itself: a worker process for
 * each trial, the planner in the controller. OpenCode, Claude Code and Codex run as command-line
 * programs, each through its entry in the CLI trial loop (cli/loop.ts) and the one-prompt call
 * (cli/once.ts).
 */

/** A trial as a program runs it: a code trial, or a research trial in the run's research folder. */
export type AgentTrial =
  | { mode: "code"; spec: TrialSpec }
  | { mode: "research"; spec: ResearchTrialSpec; folder: ResearchFolderPaths };

/** What a trial takes from the harness, whichever program runs it. */
export interface TrialLink extends Omit<CliTrialDeps, "model" | "compacted"> {
  /** The route; none: Pi's worker takes the harness's own model settings. */
  model: ModelConfig | undefined;
  /** Records a compaction that `harness` itself made and reported (goal 070). */
  compacted?: ((harness: CliHarness, c: CliCompacted) => void) | undefined;
  /** The controller's scratch area, and the harness API's port (Pi's worker reaches it there). */
  scratchDir: string;
  port: number;
  /**
   * Opens the trial's record of the model usage its program's own code hands over (Pi's worker,
   * goal 075), for its route as `harness` runs it; the function it returns closes it.
   */
  handOverUsage(harness: Harness): () => void;
}

export interface AgentProgram {
  id: Harness;
  /** Its name in what people read. */
  name: string;
  /** Whether it reaches a provider of this kind (core/agents.ts). */
  reaches(api: ProviderType | undefined): boolean;
  /** Whether it runs research trials (Pi and OpenCode do). */
  research: boolean;
  /**
   * Whether a planner without a model of its own follows the workers into it (Codex does; the
   * planner of OpenCode's workers on a provider's key plans in Pi).
   */
  plannerFollows: boolean;
  /** The user its trial in `lane` runs as: the lane's own, or Pi's worker's. */
  runsAs(lane: string): Role;
  runTrial(t: AgentTrial, link: TrialLink): Promise<TrialResult>;
  /** A planner call through it: its answer. None for Pi, whose planner runs in the controller. */
  ask?(m: ModelConfig, prompt: string, deps: CliOnceDeps, o: CliAskOptions): Promise<string>;
  /** The model check in it: one correct tool call. */
  modelCheck(m: ModelConfig, deps: CliOnceDeps): Promise<RigCheckReport>;
}

/** Pi: each trial in a worker process of its own, as the lane's agent user (spawn.ts). */
const pi: AgentProgram = {
  id: "pi",
  name: "Pi",
  reaches: (api) => reaches("pi", api),
  research: true,
  plannerFollows: true,
  runsAs: (lane) => lane.replace(/^lane-/, "agent-") as Role,
  runTrial: async (t, link) => {
    // Its worker hands its model usage over with the trial's token while the trial runs.
    const close = link.handOverUsage("pi");
    try {
      return await spawnTrial(
        t.mode === "code"
          ? { kind: "code", spec: t.spec }
          : { kind: "research", spec: { ...t.spec, folder: t.folder } },
        link.runner,
        link.scratchDir,
        link.port,
        link.signal,
        link.model,
      );
    } finally {
      close();
    }
  },
  modelCheck: (m) => checkModel(m),
};

/** A program that runs as a command-line program: it takes planner calls of its own. */
type CliAgentProgram = AgentProgram & Required<Pick<AgentProgram, "ask">>;

/** A program that runs as a command-line program, through its entry (cli/program.ts). */
function cli<T extends CliTally>(p: CliProgram<T>, plannerFollows: boolean): CliAgentProgram {
  return {
    id: p.id,
    name: p.name,
    reaches: (api) => reaches(p.id, api),
    research: p.research === true,
    plannerFollows,
    runsAs: (lane) => lane as Role,
    runTrial: (t, link) => cliTrial(p, t, link),
    ask: (m, prompt, deps, o) => cliAsk(p, m, prompt, deps, o),
    modelCheck: (m, deps) => cliModelCheck(p, m, deps),
  };
}

/**
 * A trial in a command-line program. A research trial gets an area of its own in the lane for the
 * program's home and files, removed when it ends with what the agent started from its shell.
 */
async function cliTrial<T extends CliTally>(
  p: CliProgram<T>,
  t: AgentTrial,
  link: TrialLink,
): Promise<TrialResult> {
  const model = link.model;
  // Without a route the agents run in Pi (programOf): this is a programmer's error.
  if (!model) throw new Error(`${p.name} runs only on a model route`);
  const compacted = link.compacted;
  const deps: CliTrialDeps = {
    ...link,
    model,
    compacted: compacted ? (c) => compacted(p.id, c) : undefined,
  };
  if (t.mode === "code") return runCliTrial(p, t, deps);
  const lane = t.spec.lane as Role;
  const area = await prepareResearchArea({
    runner: link.runner,
    scratchDir: link.scratchDir,
    lane,
  });
  try {
    return await runCliTrial(p, { ...t, area: area.dir }, deps);
  } finally {
    await link.runner.killRole(lane).catch(() => 0);
    await link.runner.remove(area.dir).catch(() => undefined);
  }
}

export const CLI_PROGRAMS: Record<CliHarness, CliAgentProgram> = {
  opencode: cli(opencodeProgram, false),
  "claude-code": cli(claudeProgram, true),
  codex: cli(codexProgram, true),
};

export const AGENT_PROGRAMS: Record<Harness, AgentProgram> = { pi, ...CLI_PROGRAMS };

/** Whether a program runs as a command-line program: a planner call goes through it, not Pi. */
export const isCliProgram = (h: Harness): h is CliHarness => h in CLI_PROGRAMS;

/** The program a route's agents run in: the one it names, else Pi (also without a route). */
export const programOf = (m: ModelConfig | undefined): AgentProgram =>
  AGENT_PROGRAMS[m?.harness ?? "pi"];

/**
 * The program a route's research trials run in: its own when that runs research, else Pi, which
 * reaches the same provider (a route whose code trials run in Codex).
 */
export function researchProgramOf(m: ModelConfig | undefined): AgentProgram {
  const p = programOf(m);
  return p.research ? p : AGENT_PROGRAMS.pi;
}

/**
 * Why a rig's model cannot serve its research trials, in words; undefined when it can. They run
 * in Pi or OpenCode (researchProgramOf), and neither reaches a Claude subscription, which runs
 * only in Claude Code; Pi does not reach OpenCode's own (free) models, which run only in OpenCode.
 */
export function researchRefusal(m: ModelConfig | undefined): string | undefined {
  if (!m) return "this rig has no model for its agents: give it one on its Edit rig page";
  if (researchProgramOf(m).reaches(m.api)) return undefined;
  return programForApi(m.api) === "claude-code"
    ? "research workers run in Pi or OpenCode, and a Claude subscription runs only in Claude Code: give this rig another model for research"
    : `${m.model} is one of OpenCode's own models, which work only inside OpenCode: set this rig's agents' harness to OpenCode on its Edit rig page`;
}
