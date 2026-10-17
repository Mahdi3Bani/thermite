import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type LaneLimitValues, laneLimits } from "../../core/contract.ts";
import { type LiveKind, summarizeArgs } from "../../core/live.ts";
import type { Role, Runner, RunOutcome } from "../broker/runner.ts";
import type { TrialProgress } from "./live-session.ts";
import type { ModelConfig } from "./model.ts";
import type { RigCheckReport } from "./model-check.ts";
import type { SubmitOutcome, TrialResult, TrialSpec } from "./worker.ts";

/**
 * Trials, model checks and planner calls in OpenCode v2 instead of Pi. OpenCode runs headless with
 * its permissions approved (`--auto`) as the lane's own user, in the lane's workspace, under the
 * same memory, disk and time limits as the lane's commands: it has exactly the lane's access, and
 * none of the judge's. Its permission rules are not a boundary (its Code Mode reaches the network
 * whatever they say); the user it runs as is.
 *
 * Thermite's own tools are the `thermite-trial` command (submit, dev-run, status), which calls the
 * harness API with the trial's token. A provider's key never reaches the lane: OpenCode calls the
 * provider through the harness API's model proxy, which checks the trial's token and adds the key.
 * OpenCode's own models (its free ones) need no key.
 */

export const OPENCODE_BIN = process.env.THERMITE_OPENCODE_BIN ?? "opencode";
export const TRIAL_CLI = "thermite-trial";

/** The model as OpenCode names it: its own models, or the rig's provider as "thermite". */
export function opencodeModelId(m: ModelConfig): string {
  return m.api === "opencode" ? `opencode/${m.model}` : `thermite/${m.model}`;
}

/**
 * OpenCode's configuration for a run. Nobody answers a question in a headless run, so OpenCode's
 * question tool is denied. A provider other than OpenCode's own is reached through the harness's
 * key-adding proxy (`proxyRoot`), with the run's proxy credential from THERMITE_PROXY_AUTH.
 */
export function opencodeConfig(m: ModelConfig, proxyRoot: string): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permissions: [{ action: "question", resource: "*", effect: "deny" }],
  };
  if (m.api !== "opencode") {
    const anthropic = m.api === "anthropic";
    config.providers = {
      thermite: {
        name: "Thermite route",
        env: ["THERMITE_PROXY_AUTH"],
        package: anthropic
          ? "@opencode/ai/providers/anthropic"
          : "@opencode/ai/providers/openai-compatible",
        // Anthropic's client posts to {base}/messages; its API is at /v1/messages.
        settings: { baseURL: anthropic ? `${proxyRoot}/v1` : proxyRoot },
        models: { [m.model]: { name: m.model } },
      },
    };
  }
  return config;
}

/** What OpenCode's JSON output has said so far. */
export interface OpencodeTally {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON (it prints startup errors that way). */
  notes: string[];
}

export const newTally = (): OpencodeTally => ({
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: [],
  lastText: "",
  tools: [],
  notes: [],
});

type Event = {
  type?: string;
  sessionID?: string;
  part?: {
    text?: string;
    tool?: string;
    state?: { status?: string; input?: unknown; output?: unknown; error?: unknown };
    tokens?: { input?: number; output?: number; reasoning?: number };
  };
  error?: { message?: string; type?: string };
};

/** Reads lines of OpenCode's JSON output into the tally; returns them as live-view lines. */
export function readOpencodeEvents(
  lines: string[],
  t: OpencodeTally,
): { kind: LiveKind; text: string }[] {
  const live: { kind: LiveKind; text: string }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      t.notes = [...t.notes, line.slice(0, 500)].slice(-5);
      continue;
    }
    if (e.sessionID) t.session = e.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case "text":
        if (p.text) {
          t.lastText = p.text;
          live.push({ kind: "text", text: p.text.slice(0, 8000) });
        }
        break;
      case "tool_use": {
        t.toolCalls++;
        const tool = String(p.tool ?? "tool");
        const st = p.state ?? {};
        const ok = st.status === "completed";
        const output = String(st.output ?? st.error ?? "");
        t.tools.push({ tool, output: output.slice(0, 4000), ok });
        live.push({ kind: "tool", text: `${tool} ${summarizeArgs(st.input)}`.slice(0, 8000) });
        live.push({
          kind: "result",
          text: `${tool}${ok ? "" : " failed"}: ${output.slice(0, 1200)}`,
        });
        break;
      }
      case "step_finish":
        t.turns++;
        t.tokensIn += p.tokens?.input ?? 0;
        t.tokensOut += (p.tokens?.output ?? 0) + (p.tokens?.reasoning ?? 0);
        break;
      case "error": {
        const message = String(e.error?.message ?? e.error?.type ?? "error").slice(0, 500);
        t.errors.push(message);
        live.push({ kind: "text", text: `(OpenCode: ${message})` });
        break;
      }
    }
  }
  return live;
}

/** Reads what a growing file gained since `from`: whole lines only. */
function readNew(path: string, from: number): { lines: string[]; next: number } {
  if (!existsSync(path)) return { lines: [], next: from };
  const size = statSync(path).size;
  if (size <= from) return { lines: [], next: from };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return { lines: [], next: from };
    return {
      lines: text.slice(0, end).split("\n"),
      next: from + Buffer.byteLength(text.slice(0, end + 1)),
    };
  } finally {
    closeSync(fd);
  }
}

const SYSTEM = `You are a research worker in an automated research harness, working in a git repository
in your current directory. You get one assignment and one trial. Read the code, make a focused
change that follows your assignment, build and test it, then submit it exactly once:

  thermite-trial submit --hypothesis "what you changed and why it should help" [--claim "what you expect the judge to find"] [--flaw "anything wrong or limited"]...

A separate judge you cannot see or change measures your change; your own timings only guide you.
Keep your change inside the editable paths. If you find a flaw in your own change, list it with
--flaw: hiding it is worse than a smaller result. Submitting ends the trial.

Other commands: "thermite-trial dev-run [--timeout SECONDS] -- COMMAND" runs a command on the
measurement device (for example a GPU) when the judge is not using it; "thermite-trial status
ATTEMPT" shows how the judge decided an attempt.

Your shell tool stops a command after two minutes unless you set its timeout: for a long build or
test, set timeout to 0. What a command starts in the background runs until the trial ends.`;

/** The lane's limits, as the agent must know them: OpenCode and its commands share them. */
export function limitsNote(limits: LaneLimitValues): string {
  return `Memory: ${limits.runRssMib} MiB for everything your lane runs at once, OpenCode itself included (it uses about 500 MiB). A command that takes it over the limit is killed (your shell tool reports "Killed by SIGKILL"): run it again with less parallelism (for example make -j2) or a smaller input, or as a development run, which has its own limit. Disk: ${limits.workspaceMib} MiB, and at most 50,000 files, for this trial's directory, OpenCode's own files included; going over ends the trial.`;
}

/** OpenCode's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function opencodeExe(): string | undefined {
  if (OPENCODE_BIN.startsWith("/")) return OPENCODE_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, OPENCODE_BIN);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** Why the broker stopped OpenCode, when a memory or disk limit did. */
export function breachError(
  o: Pick<RunOutcome, "killedFor"> &
    Partial<Pick<RunOutcome, "peakRssBytes" | "peakDiskBytes" | "peakEntries">>,
  limits: LaneLimitValues,
): string | undefined {
  const mib = (b: number | undefined) => Math.round((b ?? 0) / 1024 ** 2);
  if (o.killedFor === "memory")
    return `stopped by the lane's memory limit: OpenCode reached ${mib(o.peakRssBytes)} MiB with what it ran, over ${limits.runRssMib} MiB (the contract's lanes.limits.run_rss_mib), and its commands' memory could not be freed`;
  if (o.killedFor === "disk")
    return `stopped by the lane's disk limit: the trial's directory reached ${mib(o.peakDiskBytes)} MiB in ${o.peakEntries ?? 0} files, over ${limits.workspaceMib} MiB (lanes.limits.workspace_mib) or 50,000 files`;
  return undefined;
}

const NUDGE =
  'You have not submitted yet. Keep working: make your change, build and test it, then run `thermite-trial submit --hypothesis "..."` once. If you find no change worth judging, say why in one sentence.';

export interface OpencodeTrialDeps {
  runner: Runner;
  model: ModelConfig;
  /** The harness API as the lane reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  /** Lines for the live view, and the session's counters. */
  live(entries: { kind: LiveKind; text: string }[]): void;
  progress(p: TrialProgress): void;
  /** The trial's submission, once it has one (from the ledger). */
  submitted(): SubmitOutcome | undefined;
  /** The owner's messages for this trial, each given once. */
  messages?: (() => string[]) | undefined;
  /** The lane's build caches (ccache and the like). */
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** How often the output is read (tests make it short). */
  pollMs?: number | undefined;
}

/** The environment of an OpenCode run: its home, Thermite's command and how to reach the API. */
function runEnv(home: string, apiUrl: string, auth: string, extra: Record<string, string>) {
  return {
    ...extra,
    HOME: home,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    THERMITE_HARNESS_URL: apiUrl,
    THERMITE_TRIAL_AUTH: auth,
    THERMITE_PROXY_AUTH: auth,
  };
}

/**
 * One worker trial in OpenCode: its home and configuration in the lane's own area, then
 * `opencode run` in the workspace until the agent submits or the trial's time ends. A run that
 * ends without a submission is continued in the same session, twice at most, as Pi's are.
 */
export async function runOpencodeTrial(
  spec: TrialSpec,
  deps: OpencodeTrialDeps,
): Promise<TrialResult> {
  const area = spec.workspaceRoot ?? dirname(spec.workspace);
  const home = join(area, "opencode-home");
  const events = join(area, "opencode-events.jsonl");
  const tmp = join(area, "opencode-tmp");
  const tally = newTally();
  const result: TrialResult = {
    stopped: "no_submission",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const auth = `trial.${spec.token ?? ""}`;
  const proxyRoot = `${deps.apiUrl}/v1/model-proxy`;
  const env = {
    ...runEnv(home, deps.apiUrl, auth, deps.env ?? {}),
    THERMITE_EDITABLE_PATHS: JSON.stringify(spec.editablePaths),
    THERMITE_WORKSPACE: spec.workspace,
    // Its own temp directory: the shared /tmp is not the lane's.
    TMPDIR: tmp,
    THERMITE_OPENCODE_EVENTS: events,
  };
  // Its home and configuration, made as the lane's user in the lane's own area.
  const setup = await deps.runner.run({
    role: spec.lane,
    // Relative to its own area: the lane may not walk the harness's directories by name.
    argv: [
      "sh",
      "-c",
      "mkdir -p opencode-home/.config/opencode opencode-tmp && cat > opencode-home/.config/opencode/opencode.jsonc && : > opencode-events.jsonl && chmod 0644 opencode-events.jsonl",
    ],
    cwd: area,
    timeoutMs: 30_000,
    stdin: JSON.stringify(opencodeConfig(deps.model, proxyRoot)),
    captureBytes: 4096,
  });
  if (setup.exitCode !== 0) {
    return {
      ...result,
      stopped: "error",
      error: `could not set OpenCode up: ${setup.stderr.slice(-300)}`,
    };
  }
  const started = Date.now();
  const deadline = started + spec.wallMs;
  const minutes = Math.round(spec.wallMs / 60_000);
  let message = `${SYSTEM}\n\n${limitsNote(limits)}\n\n${spec.brief}\n\nThe editable paths: ${spec.editablePaths.join(", ")}. This trial lasts ${minutes} minutes. Submit before it ends.`;
  let offset = 0;
  const pump = () => {
    const r = readNew(events, offset);
    offset = r.next;
    const live = readOpencodeEvents(r.lines, tally);
    if (live.length) deps.live(live);
    if (r.lines.length)
      deps.progress({
        turns: tally.turns,
        tool_calls: tally.toolCalls,
        tokens_in: tally.tokensIn,
        tokens_out: tally.tokensOut,
      });
  };
  for (let nudges = 0; ; nudges++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.stopped = "wall";
      break;
    }
    const errorsBefore = tally.errors.length;
    const args = [
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "--model",
      opencodeModelId(deps.model),
      ...(tally.session ? ["--session", tally.session] : ["--title", `trial ${spec.trialId}`]),
      message,
    ];
    const running = deps.runner.run({
      role: spec.lane,
      // Its output goes to a file the harness follows while it runs.
      argv: [
        "sh",
        "-c",
        'exec "$@" >> "$THERMITE_OPENCODE_EVENTS" 2>&1',
        "sh",
        // By its full path, so the broker knows OpenCode's processes from its commands'.
        opencodeExe() ?? OPENCODE_BIN,
        ...args,
      ],
      cwd: spec.workspace,
      env,
      timeoutMs: remaining,
      rssLimitBytes: limits.runRssMib * 1024 * 1024,
      // Over the memory limit, OpenCode's commands are killed and OpenCode carries on, as a
      // lane command under Pi would be; the trial ends only if OpenCode alone is over.
      ...(opencodeExe() ? { spareExe: opencodeExe() } : {}),
      disk: { path: area, limitBytes: limits.workspaceMib * 1024 * 1024 },
      captureBytes: 4096,
    });
    let done = false;
    void running.finally(() => {
      done = true;
    });
    let submittedAt: number | undefined;
    while (!done) {
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 1000));
      pump();
      if (deps.signal?.aborted) {
        await deps.runner.killRole(spec.lane).catch(() => 0);
        break;
      }
      // A submission ends the trial: the agent gets a minute to finish its last reply.
      if (deps.submitted()) {
        submittedAt ??= Date.now();
        if (Date.now() - submittedAt > 60_000) await deps.runner.killRole(spec.lane).catch(() => 0);
      }
    }
    const outcome = await running;
    pump();
    if (deps.signal?.aborted) {
      result.stopped = "interrupted";
      break;
    }
    if (deps.submitted()) break;
    // A memory or disk limit ends OpenCode with everything it ran: say which, with the figures.
    const breach = breachError(outcome, limits);
    if (breach) {
      result.stopped = "error";
      result.error = breach;
      break;
    }
    if (outcome.killedFor === "timeout" || Date.now() >= deadline) {
      result.stopped = "wall";
      break;
    }
    // A run that failed outright (its model unreachable, say) ends the trial; the scheduler's
    // backoff decides when the lane tries again.
    if (tally.errors.length > errorsBefore && tally.toolCalls === 0) {
      result.stopped = "error";
      result.error = tally.errors.at(-1);
      break;
    }
    if (outcome.exitCode !== 0 && !tally.session) {
      result.stopped = "error";
      result.error = `OpenCode exited ${outcome.exitCode ?? outcome.signal}: ${tally.notes.at(-1) ?? "no output"}`;
      break;
    }
    if (nudges >= 2) break;
    const owner = deps.messages?.() ?? [];
    message = [NUDGE, ...owner.map((m) => `A message from the campaign's owner: ${m}`)].join(
      "\n\n",
    );
  }
  const sub = deps.submitted();
  if (sub) {
    result.submitted = sub;
    result.stopped = "submitted";
  } else if (result.stopped === "wall") {
    result.error = `the trial reached its ${minutes}-minute limit before a submission`;
  } else if (result.stopped === "no_submission" && tally.errors.length) {
    result.error = tally.errors.at(-1);
  }
  result.turns = tally.turns;
  result.toolCalls = tally.toolCalls;
  result.tokensIn = tally.tokensIn;
  result.tokensOut = tally.tokensOut;
  return result;
}

export interface OpencodeAskDeps {
  runner: Runner;
  model: ModelConfig;
  apiUrl: string;
  /** A short-lived credential the model proxy accepts (none needed for OpenCode's own models). */
  proxyAuth: string;
  /** An unprivileged role to run as, and an empty directory to run in (owned by that role). */
  role: Role;
  dir: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/**
 * One prompt through OpenCode outside a trial (a model check, a planner call), as an
 * unprivileged agent user in an empty directory. Returns what OpenCode's output said.
 */
export async function opencodeAsk(prompt: string, deps: OpencodeAskDeps): Promise<OpencodeTally> {
  const home = join(deps.dir, "home");
  const env = { ...runEnv(home, deps.apiUrl, deps.proxyAuth, {}), TMPDIR: join(deps.dir, "tmp") };
  const setup = await deps.runner.run({
    role: deps.role,
    argv: [
      "sh",
      "-c",
      "mkdir -p home/.config/opencode tmp && cat > home/.config/opencode/opencode.jsonc",
    ],
    cwd: deps.dir,
    timeoutMs: 30_000,
    stdin: JSON.stringify(opencodeConfig(deps.model, `${deps.apiUrl}/v1/model-proxy`)),
    captureBytes: 4096,
  });
  const tally = newTally();
  if (setup.exitCode !== 0) {
    tally.errors.push(`could not set OpenCode up: ${setup.stderr.slice(-300)}`);
    return tally;
  }
  const kill = () => void deps.runner.killRole(deps.role).catch(() => 0);
  deps.signal?.addEventListener("abort", kill, { once: true });
  try {
    const r = await deps.runner.run({
      role: deps.role,
      argv: [
        OPENCODE_BIN,
        "run",
        "--standalone",
        "--auto",
        "--format",
        "json",
        "--model",
        opencodeModelId(deps.model),
        prompt,
      ],
      cwd: deps.dir,
      env,
      timeoutMs: deps.timeoutMs,
      captureBytes: 8 * 1024 * 1024,
    });
    readOpencodeEvents(r.stdout.split("\n"), tally);
    if (r.killedFor === "timeout")
      tally.errors.push(`no answer in ${Math.round(deps.timeoutMs / 1000)} s`);
    else if (r.exitCode !== 0 && !tally.errors.length)
      tally.errors.push(
        `OpenCode exited ${r.exitCode ?? r.signal}: ${tally.notes.at(-1) ?? r.stderr.slice(-300)}`,
      );
  } finally {
    deps.signal?.removeEventListener("abort", kill);
  }
  return tally;
}

/** The unprivileged user model checks and planner calls run as (lanes rarely reach 16). */
export const ASK_ROLE: Role = "agent-16";

export interface OpencodeOnceDeps {
  runner: Runner;
  apiUrl: string;
  scratchDir: string;
  mintProxyToken(): string;
}

/** One prompt through OpenCode in a fresh directory of ASK_ROLE's, removed afterwards. */
export async function opencodeOnce(
  model: ModelConfig,
  prompt: string,
  deps: OpencodeOnceDeps,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OpencodeTally> {
  // OpenCode finds its home by name, so the directory must be reachable by name: under the lanes'
  // area, not the controller's own (which only its processes may walk).
  const parent = join(deps.scratchDir, "lanes", "opencode-ask");
  mkdirSync(parent, { recursive: true, mode: 0o711 });
  chmodSync(parent, 0o711);
  const dir = join(parent, randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  await deps.runner.handOver(dir, ASK_ROLE);
  try {
    return await opencodeAsk(prompt, {
      runner: deps.runner,
      model,
      apiUrl: deps.apiUrl,
      proxyAuth: deps.mintProxyToken(),
      role: ASK_ROLE,
      dir,
      timeoutMs,
      signal,
    });
  } finally {
    await deps.runner.remove(dir).catch(() => undefined);
  }
}

/**
 * The model check in OpenCode: the model must run one shell command through OpenCode's own tool
 * and the command's output must come back, as a trial's tool calls would.
 */
export async function opencodeModelCheck(
  model: ModelConfig,
  deps: OpencodeOnceDeps,
  timeoutMs = 120_000,
): Promise<RigCheckReport> {
  const word = `thermite-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const t = await opencodeOnce(
    model,
    `Use your shell tool to run exactly this command: echo ${word}\nThen reply with only the word it printed.`,
    deps,
    timeoutMs,
  );
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const called = t.tools.some((x) => x.ok && x.output.includes(word));
  const detail = {
    harness: "opencode",
    model: model.model,
    base_url: model.api === "opencode" ? "opencode" : model.baseUrl,
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
      summary: `${model.model} answered with a correct tool call in ${seconds} s (OpenCode)`,
      detail,
    };
  const why = t.errors.length
    ? t.errors.at(-1)
    : t.toolCalls
      ? "its tool call did not print the word"
      : `no tool call${t.lastText ? `; it wrote: ${t.lastText.slice(0, 200)}` : ""}`;
  return {
    ok: false,
    summary: `${model.model} failed the tool-call check in OpenCode: ${why}`,
    detail,
  };
}
