import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelCheckProgramPrompt } from "../../agents/roles/model-check.ts";
import type { Role, Runner } from "../broker/runner.ts";
import {
  type ClaudeTally,
  closeClaudeRun,
  newClaudeTally,
  readClaudeEvents,
} from "./claude-code/events.ts";
import {
  claudeArgs,
  claudeCompactionEnv,
  claudeEnv,
  claudeExitWords,
  claudeHookSettings,
  claudeProgram,
} from "./claude-code/program.ts";
import {
  CLAUDE_PROMPT,
  claudeBin,
  claudeExe,
  claudeShell,
  PROMPT_VAR,
} from "./claude-code/shell.ts";
import { CHECK_ROLE } from "./cli/common.ts";
import { runCliTrial } from "./cli/loop.ts";
import type { CliTrialDeps } from "./cli/program.ts";
import { CliCompactions, type OnceKeeping, reclaim } from "./cli-compaction.ts";
import { claudeOwn } from "./cli-conversation.ts";
import { claudeMcpConfig, type McpAccess } from "./mcp-tools.ts";
import type { ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";

/**
 * Trials, model checks and planner calls in Claude Code, for a Claude subscription. Anthropic
 * allows a subscription only in its own program, unmodified: the owner's token from `claude
 * setup-token` reaches Claude Code alone, on a file descriptor (claudeShell), and no other program
 * here uses it. Claude Code runs headless (`claude -p`, its permissions bypassed) as the lane's
 * own user, in the lane's workspace, under the lane's memory, disk and time limits and the GPU
 * fence, as OpenCode does: it has the lane's access and none of the judge's. It starts with a home
 * of its own, no setting sources and no MCP servers, so nothing of a project's or a host's Claude
 * settings runs. The token is in no environment and no file, so its commands inherit no
 * credentials; they run as the same user, which could still reach the token: the owner accepted
 * that (decision 51).
 *
 * Claude Code's own sandbox stays off, here and in the advisors (whose Claude Code has
 * none of its own tools), so the images carry no bubblewrap. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
 * would make the sandbox mandatory, and it cannot start in a rig: its bubblewrap mounts, which the
 * GPU fence (Landlock) refuses, as do a container's own confinement and masked /proc; its network
 * bridge's sockets, in TMPDIR, pass the 108-byte limit of a socket's path in the lanes' areas. The
 * scrub also forces Claude Code's default permission mode, which refuses file edits and most
 * commands in a headless run.
 *
 * Thermite's own tools are the `thermite-trial` command, which calls the harness API with the
 * trial's token. Claude Code reports the subscription's usage windows as it goes
 * (rate_limit_event); a full window ends the trial with the time it resets.
 */

export type { ClaudeTally } from "./claude-code/events.ts";
export {
  claudeResultUsage,
  closeClaudeRun,
  newClaudeTally,
  readClaudeEvents,
} from "./claude-code/events.ts";
export {
  CLAUDE_HOOK,
  claudeArgs,
  claudeCompactionEnv,
  claudeEnv,
  claudeExitWords,
  claudeHookSettings,
  NO_CLAUDE_CODE,
} from "./claude-code/program.ts";
export {
  CLAUDE_BASE_ENV,
  CLAUDE_PROMPT,
  CLAUDE_TOKEN_FD,
  claudeBin,
  claudeExe,
  claudeShell,
} from "./claude-code/shell.ts";
export type { UsageWindow } from "./plan-windows.ts";
export { mergeUsage } from "./plan-windows.ts";

export type ClaudeTrialDeps = CliTrialDeps;

/**
 * One worker trial in Claude Code: the CLI trial loop (cli/loop.ts) with Claude Code's entry. A
 * full usage window ends the trial with the time it resets.
 */
export function runClaudeTrial(spec: TrialSpec, deps: ClaudeTrialDeps): Promise<TrialResult> {
  return runCliTrial(claudeProgram, spec, deps);
}

export interface ClaudeOnceDeps {
  runner: Runner;
  apiUrl: string;
  scratchDir: string;
}

/**
 * One prompt through Claude Code outside a trial (a model check, a planner call), as `role` (the
 * planner's or the model check's own user) in a fresh directory, removed afterwards. `tools` ""
 * gives it none.
 */
export async function claudeOnce(
  model: ModelConfig,
  prompt: string,
  deps: ClaudeOnceDeps,
  o: {
    tools: string;
    /** None unless given: a planner call runs until it answers or its run stops (goal 079). */
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    role: Role;
    /** The MCP servers the call may use, and the gateway's credential for them (a planner's). */
    mcp?: Omit<McpAccess, "apiUrl"> | undefined;
    /** Where its conversation is kept before each compaction, and who records it (goal 070). */
    compaction?: OnceKeeping | undefined;
  },
): Promise<ClaudeTally> {
  const role = o.role;
  const parent = join(deps.scratchDir, "lanes", "claude-ask");
  mkdirSync(parent, { recursive: true, mode: 0o711 });
  chmodSync(parent, 0o711);
  const dir = join(parent, randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  // The prompt for Claude Code's stdin, handed over with the folder.
  writeFileSync(join(dir, CLAUDE_PROMPT), prompt, { mode: 0o600 });
  await deps.runner.handOver(dir, role);
  const tally = newClaudeTally();
  const kill = () => void deps.runner.killRole(role).catch(() => 0);
  o.signal?.addEventListener("abort", kill, { once: true });
  try {
    const mcp = claudeMcpConfig(
      o.mcp?.servers.length ? { apiUrl: deps.apiUrl, ...o.mcp } : undefined,
    );
    const keeping = o.compaction;
    const setup = await deps.runner.run({
      role,
      argv: [
        "sh",
        "-c",
        `mkdir -p home tmp${keeping ? " compactions" : ""}${mcp ? " && umask 077 && cat > home/mcp.json" : ""}`,
      ],
      cwd: dir,
      timeoutMs: 30_000,
      ...(mcp ? { stdin: mcp } : {}),
      captureBytes: 4096,
    });
    if (setup.exitCode !== 0) {
      tally.errors.push(`could not set Claude Code up: ${setup.stderr.slice(-300)}`);
      return tally;
    }
    // A call stopped before its run starts nothing, and answers with nothing.
    if (o.signal?.aborted) return tally;
    const r = await deps.runner.run({
      role,
      argv: claudeShell([
        claudeExe() ?? claudeBin(),
        "-p",
        ...claudeArgs(model, {
          tools: o.tools,
          mcpConfig: mcp ? join(dir, "home", "mcp.json") : undefined,
          // Its PreCompact hook, when the call's conversation is kept (goal 070).
          settings: keeping
            ? claudeHookSettings(join(dir, "compactions"), keeping.keptAt)
            : undefined,
        }),
      ]),
      cwd: dir,
      env: {
        ...claudeEnv({
          home: join(dir, "home"),
          apiUrl: deps.apiUrl,
          auth: "",
          tmp: join(dir, "tmp"),
          maxCommandMs: o.timeoutMs,
        }),
        // A planner's call compacts as the workers' trials do (goal 070).
        ...claudeCompactionEnv(model),
        [PROMPT_VAR]: join(dir, CLAUDE_PROMPT),
      },
      // The token, which the shell gives Claude Code on file descriptor 3.
      stdin: model.apiKey,
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      captureBytes: 8 * 1024 * 1024,
    });
    const live = readClaudeEvents(r.stdout.split("\n"), tally);
    // A run cut off before its result keeps the usage its stream showed (goal 075).
    closeClaudeRun(tally);
    // Each compaction it reported, kept and recorded once the call is over (goal 070): the
    // controller takes the call's folder back to read the hook's copies.
    if (keeping && tally.compactions.length) {
      await reclaim(deps.runner, dir);
      new CliCompactions({
        title: keeping.title,
        harness: "Claude Code",
        on: keeping.compacted,
        own: claudeOwn({
          root: dir,
          drops: ["compactions"],
          home: ["home"],
          title: keeping.title,
          session: () => tally.session,
        }),
      }).take(live, tally.compactions.splice(0));
    }
    if (r.killedFor === "timeout")
      tally.errors.push(`no answer in ${Math.round((o.timeoutMs ?? 0) / 1000)} s`);
    else if (r.exitCode !== 0 && !tally.errors.length)
      tally.errors.push(
        claudeExitWords(
          r.exitCode ?? r.signal,
          tally.notes.at(-1) ?? r.stderr.slice(-300),
          `${tally.notes.join("\n")}\n${r.stderr}`,
        ),
      );
  } finally {
    o.signal?.removeEventListener("abort", kill);
    await deps.runner.remove(dir).catch(() => undefined);
  }
  return tally;
}

/** The model check in Claude Code: the model must run one shell command through its Bash tool. */
export async function claudeModelCheck(
  model: ModelConfig,
  deps: ClaudeOnceDeps,
  timeoutMs = 120_000,
): Promise<RigCheckReport> {
  const word = `thermite-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const t = await claudeOnce(model, modelCheckProgramPrompt(word, "Bash tool"), deps, {
    tools: "Bash",
    timeoutMs,
    role: CHECK_ROLE,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const called = t.tools.some((x) => x.ok && x.output.includes(word));
  const detail = {
    harness: "claude-code",
    model: model.model,
    seconds,
    tool_called: called,
    tokens_in: t.tokensIn,
    tokens_out: t.tokensOut,
    usage: t.usage ?? null,
    error: t.errors.at(-1) ?? null,
    text: t.lastText.slice(0, 300) || null,
  };
  if (called)
    return {
      ok: true,
      summary: `${model.model} answered with a correct tool call in ${seconds} s (Claude Code)`,
      detail,
    };
  const why = t.limitedUntil
    ? `the subscription's usage window is full until ${t.limitedUntil}`
    : t.errors.length
      ? t.errors.at(-1)
      : t.toolCalls
        ? "its tool call did not print the word"
        : `no tool call${t.lastText ? `; it wrote: ${t.lastText.slice(0, 200)}` : ""}`;
  return {
    ok: false,
    summary: `${model.model} failed the tool-call check in Claude Code: ${why}`,
    detail,
  };
}
