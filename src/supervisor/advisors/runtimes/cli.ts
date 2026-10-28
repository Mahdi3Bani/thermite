import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { TSchema } from "@earendil-works/pi-ai";
import type { z } from "zod";
import { errorText } from "../../../common/errors.ts";
import type { CallUsage, UsageRoute } from "../../../core/usage.ts";
import { CLAUDE_TOKEN_FD } from "../../../harness/agents/claude-code/index.ts";
import type { Own } from "../../../harness/agents/cli-conversation.ts";
import type { CliAnswer } from "../../advisor-cli.ts";
import type { AdvisorCompaction, AdvisorKeeper, AdvisorResult, AdvisorUsage } from "../call.ts";

/** A call's id, for the names of its kept conversations: when it started. */
export const callId = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * The compactions an advisor's own program made in its call (goal 070), from what its PreCompact
 * hook, plugin or rollout left in the call's folder: each conversation kept with the supervisor's
 * records, and each compaction said in the run's live view.
 */
export function collectCompactions(o: {
  harness: NonNullable<AdvisorCompaction["harness"]>;
  advisor: string;
  call: string;
  count: number;
  own: (n: number) => Own | undefined;
  keeper: AdvisorKeeper | undefined;
}): AdvisorCompaction[] {
  const out: AdvisorCompaction[] = [];
  for (let n = 1; n <= o.count; n++) {
    let got: Own | undefined;
    let kept: string | null = null;
    let error: string | undefined;
    try {
      got = o.own(n);
      if (!got) error = "the conversation could not be read";
      else if (!o.keeper) error = "this advisor's call has no place to keep it";
      else kept = o.keeper.keep(o.advisor, o.call, n, got.markdown);
    } catch (err) {
      error = `the conversation was not kept: ${errorText(err)}`;
    }
    const c: AdvisorCompaction = {
      advisor: o.advisor,
      number: n,
      tokens_before: got?.tokensBefore ?? null,
      tokens_after: null,
      how: "harness",
      harness: o.harness,
      kept,
      ...(got?.summary ? { summary: got.summary.slice(0, 4000) } : {}),
      ...(error ? { error } : {}),
    };
    out.push(c);
    o.keeper?.done?.(c);
  }
  return out;
}

/**
 * The last top-level JSON object in a text (CLI agents print logs before their answer). Lines are
 * tried from the end first; then a scan that respects strings, so braces inside quoted text
 * cannot shift the object found.
 */
export function lastJsonObject(out: string): unknown {
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // not a whole object on one line
    }
  }
  let last: unknown;
  for (let start = out.indexOf("{"); start >= 0; start = out.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < out.length; i++) {
      const ch = out[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          last = JSON.parse(out.slice(start, i + 1));
          start = i;
        } catch {
          // not JSON from here
        }
        break;
      }
    }
  }
  return last;
}

/**
 * One advisor call as a command, with the prompt on its stdin and its answer read from what it
 * printed: a command-line agent's call, and Claude Code's, OpenCode's and Codex's (their runtimes
 * set the command up).
 */
export function runCli<S extends z.ZodType>(
  rt: {
    argv: string[];
    /** None: no time limit (goal 079). */
    timeout_s?: number | undefined;
    env?: Record<string, string> | undefined;
    /**
     * Claude Code's sign-in token: written to the command's file descriptor CLAUDE_TOKEN_FD, then
     * closed, never in its environment or on its command line. The prompt keeps stdin: an audit's
     * or a review's package can pass the size of one command-line argument.
     */
    token?: string | undefined;
    /** Writes the command's own files in its folder before it starts; returns more environment. */
    prepare?: ((home: string) => Record<string, string>) | undefined;
    /** Reads the answer and the tokens from what it printed (default: its last JSON object). */
    read?: ((out: string) => CliAnswer) | undefined;
    /**
     * Its model usage (goal 075): where it ran, and its records from what it printed (`read`'s,
     * else `calls`').
     */
    usage?: { route: UsageRoute; calls?: ((out: string) => CallUsage[]) | undefined } | undefined;
    /** More arguments, which name the call's own folder (Claude Code's `--settings`). */
    extra?: ((home: string) => string[]) | undefined;
    /**
     * The compactions the program made in the call (goal 070), from what it left in its folder:
     * read once it has ended, before the folder is removed.
     */
    collect?: ((home: string) => AdvisorCompaction[]) | undefined;
  },
  system: string,
  prompt: string,
  schema: S,
  answerSchema?: TSchema | undefined,
): Promise<AdvisorResult<z.infer<S>>> {
  // Its own empty home, working directory and temporary folder, and its own process group (killed
  // as a whole). Without TMPDIR, Claude Code would make its folder in /tmp, which the one-container
  // rig image closes to the supervisor's user.
  const home = mkdtempSync(join(tmpdir(), "thermite-advisor-"));
  let more: Record<string, string> = {};
  try {
    more = rt.prepare?.(home) ?? {};
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    return Promise.resolve({
      output: undefined,
      error: `could not set ${rt.argv[0]} up: ${errorText(err)}`,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
    });
  }
  const stdio: "pipe"[] = ["pipe", "pipe", "pipe"];
  if (rt.token !== undefined) stdio[CLAUDE_TOKEN_FD] = "pipe";
  return new Promise((resolve) => {
    const child = spawn(rt.argv[0] as string, [...rt.argv.slice(1), ...(rt.extra?.(home) ?? [])], {
      stdio,
      cwd: home,
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
        ...more,
        ...rt.env,
      },
    });
    if (rt.token !== undefined) {
      const tokenPipe = child.stdio[CLAUDE_TOKEN_FD] as Writable | null | undefined;
      // A command that exits without reading it fails on its own words, which the answer shows.
      tokenPipe?.on("error", () => undefined);
      tokenPipe?.end(rt.token);
    }
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    };
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out = (out + d.toString("utf8")).slice(-4_000_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString("utf8")).slice(-20_000);
    });
    const timer =
      rt.timeout_s !== undefined ? setTimeout(killGroup, rt.timeout_s * 1000) : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      killGroup();
      rmSync(home, { recursive: true, force: true });
    };
    let done = false;
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      // Its compactions (goal 070): read from its folder before the folder goes.
      clearTimeout(timer);
      killGroup();
      let compactions: AdvisorCompaction[] = [];
      try {
        compactions = rt.collect?.(home) ?? [];
      } catch {
        compactions = [];
      }
      const kept = compactions.length ? { compactions } : {};
      cleanup();
      if (error) {
        resolve({ output: undefined, error, tokensIn: 0, tokensOut: 0, usd: 0, ...kept });
        return;
      }
      // A CLI with JSON events (OpenCode, Codex): its last message is the answer.
      const said = rt.read?.(out);
      let found = lastJsonObject(said ? said.text : out);
      // Agents that wrap their answer (for example `{"result": "..."}`): look inside once.
      if (found && typeof found === "object" && "result" in found) {
        const inner = (found as { result: unknown }).result;
        const nested = typeof inner === "string" ? lastJsonObject(inner) : inner;
        if (schema.safeParse(nested).success) found = nested;
      }
      const parsed = schema.safeParse(found);
      const tokensIn = said?.tokensIn ?? 0;
      const tokensOut = said?.tokensOut ?? 0;
      // Its model usage, from what it printed, answer or not.
      const usage: AdvisorUsage | undefined = rt.usage
        ? { ...rt.usage.route, calls: said?.calls ?? rt.usage.calls?.(out) ?? [] }
        : undefined;
      // Why there is no answer: the CLI's last message, else its last error, else its output.
      const why = said?.text || said?.error || err || out;
      resolve(
        parsed.success
          ? { output: parsed.data, tokensIn, tokensOut, usd: 0, usage, ...kept }
          : {
              output: undefined,
              error: `no valid answer: ${why.slice(-300)}`,
              tokensIn,
              tokensOut,
              usd: 0,
              usage,
              ...kept,
            },
      );
    };
    child.on("error", (e) => finish(e.message));
    child.on("close", () => finish());
    // A leftover grandchild holding the pipes cannot keep the call open: after the command
    // exits, what it printed within two seconds is its answer.
    child.on("exit", () => setTimeout(() => finish(), 2000).unref());
    // A command-line agent has no answer tool: it is told the answer's shape.
    child.stdin.end(
      `${system}\n\n${prompt}\n\nAnswer with exactly one JSON object${answerSchema ? `, of this shape (JSON Schema): ${JSON.stringify(answerSchema)}` : ""}.`,
    );
  });
}
