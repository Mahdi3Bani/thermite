import type { LiveKind } from "../../../core/live.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { Role, Runner } from "../../broker/runner.ts";
import type { FoundCompaction, KeptAt, OnCompacted, OwnConversation } from "../cli-compaction.ts";
import type { MessageInbox, TrialProgress } from "../live-session.ts";
import type { McpAccess } from "../mcp-tools.ts";
import type { ModelConfig } from "../model.ts";
import type { PlanWindows } from "../plan-windows.ts";
import type { ProviderLink } from "../provider-errors.ts";
import type { SubmitOutcome, TrialResult } from "../worker.ts";

/**
 * The agent programs that run as command-line programs (OpenCode, Claude Code, Codex), as one
 * trial loop sees them (cli/loop.ts, goal 125, T7): each program's entry holds only what differs
 * between them, and the loop does the rest.
 */

/** What every program's output has said so far: the fields each program's tally has. */
export interface CliTally {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** The session a run continues (OpenCode's and Claude Code's session, Codex's thread). */
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON. */
  notes: string[];
  /** The model usage it reported since it was last taken (goal 075). */
  calls: CallUsage[];
}

/** One trial's run of a program, as its entry sees it. */
export interface CliRun {
  trialId: string;
  /** The lane's user, which sets the program up and runs it. */
  role: Role;
  /** The title its kept conversations get: `Trial <id> (<lane>)`. */
  title: string;
  model: ModelConfig;
  /** The harness API as the lane reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  /** The trial's own area in the lane, and the program's home and temporary folders there. */
  area: string;
  home: string;
  tmp: string;
  /** The trial's credential: `trial.<token>`. */
  auth: string;
  /** The MCP servers the run's kit gives its workers (goal 068), at the gateway with `auth`. */
  mcp: McpAccess | undefined;
  /** Where the harness keeps the conversation before each compaction (goal 070). */
  keptAt: KeptAt | undefined;
  /** The trial's length, when one is set (goal 079). */
  wallMs: number | undefined;
  /** The lane's build caches (ccache and the like). */
  env: Record<string, string> | undefined;
}

/** What a program's setup runs in the trial's area, as the lane: a shell line and its input. */
export interface CliSetup {
  script: string;
  /** The shell's positional arguments ($0 first). */
  args?: string[] | undefined;
  stdin?: string | undefined;
}

/** Why a program stops a trial on its own, after a run (Claude Code: a full usage window). */
export type OwnStop = Pick<TrialResult, "stopped" | "error" | "errorKind" | "retryAfter">;

/**
 * One program, as the trial loop runs it. Its compaction settings go in through its setup, its
 * environment or its command line (Codex's configuration, Claude Code's environment and hook
 * settings, OpenCode's configuration and plugin); `found` and `own` say how its compactions are
 * found and read.
 */
export interface CliProgram<T extends CliTally> {
  /** Its name in what people read: "Codex", "Claude Code", "OpenCode". */
  name: string;
  /** The start of its folders' and events file's names in the trial's area: `<prefix>-home`. */
  prefix: string;
  /** The variable that names its events file to the shell that starts it. */
  eventsVar: string;
  /** The worker's instructions for this program. */
  system: string;
  /** What one turn is, as the trial's budget says it. */
  turnWords: string;
  /** What the program itself uses, in words, when it is known (the limits note says it). */
  memory?: string | undefined;
  /** Its binary's name, and its absolute path when it is found. */
  bin(): string;
  exe(): string | undefined;
  /** Its home, configuration and events file, made in the trial's area as the lane. */
  setup(run: CliRun): CliSetup;
  /** Its environment, apart from the trial's workspace, editable paths and events file. */
  env(run: CliRun): Record<string, string>;
  /** Its command line after the binary; `session`: the one to continue. */
  args(run: CliRun, session: string | undefined): string[];
  /** The shell that starts it, with `into` (where its output goes) after it. */
  shell?(argv: string[], into: string): string[];
  /** Its standard input (else the prompt). */
  stdin?(prompt: string, run: CliRun): string;
  newTally(): T;
  /** Reads lines of its output into the tally; returns them as live-view lines. */
  read(lines: string[], t: T): { kind: LiveKind; text: string }[];
  /**
   * The compactions found in one read (goal 070): in its output, or in the area. `count`: those
   * taken already; `at`: how many live entries the read gave (one found outside the output comes
   * after them).
   */
  found(t: T, read: { area: string; count: number; at: number }): FoundCompaction[];
  /** Its own conversation before each compaction, as it keeps it. */
  own(run: CliRun, t: T): OwnConversation;
  /** Why it exited, in words: `note`, its last line; `output`, its last lines. */
  exitWords(code: number | string | null, note: string, output: string): string;
  /** Before each run (Claude Code: its prompt into a file); else why not, in words. */
  beforeRun?(prompt: string, run: CliRun, runner: Runner): Promise<string | undefined>;
  /** After each run (Claude Code: a run cut short keeps the usage its output showed). */
  closeRun?(t: T): void;
  /** After each read that had lines (Claude Code: its subscription's usage windows). */
  onRead?(t: T, deps: CliTrialDeps): void;
  /** Its own reason to end the trial after a run (Claude Code: a full usage window). */
  stopAfterRun?(t: T): OwnStop | undefined;
}

/** What the trial loop takes from the harness. */
export interface CliTrialDeps extends ProviderLink {
  runner: Runner;
  model: ModelConfig;
  /** The harness API as the lane reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  /** Lines for the live view, and the session's counters. */
  live(entries: { kind: LiveKind; text: string }[]): void;
  progress(p: TrialProgress): void;
  /** The trial's submission, once it has one (from the ledger). */
  submitted(): SubmitOutcome | undefined;
  /**
   * The owner's messages for this trial. No program takes a message into a running session: one
   * waiting when a run ends is given by continuing the session with it, and is read once the
   * agent starts on that prompt.
   */
  messages?: MessageInbox | undefined;
  /** The subscription's windows, whenever the program reports them (Claude Code). */
  usage?: ((u: PlanWindows) => void) | undefined;
  /** The lane's build caches (ccache and the like). */
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** How often the output is read (tests make it short). */
  pollMs?: number | undefined;
  /** How long the run goes on after a submission (AFTER_SUBMIT_MS; tests make it short). */
  afterSubmitMs?: number | undefined;
  /** Each model usage the program's output reports (goal 075). */
  modelUsage?: ((u: CallUsage) => void) | undefined;
  /**
   * Where the harness keeps the conversation before each compaction (goal 070): with it, the
   * program's summary names the file, and each compaction it reports is kept and recorded
   * (`compacted`).
   */
  keptAt?: KeptAt | undefined;
  compacted?: OnCompacted | undefined;
}
