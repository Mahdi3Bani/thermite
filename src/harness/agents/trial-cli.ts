import { execFileSync } from "node:child_process";
import { apiCall } from "./api-call.ts";

/**
 * `thermite-trial`: Thermite's tools for an agent that works through its own shell (the OpenCode
 * harness). It runs as the lane's user, in the lane's workspace, and reaches the harness API with
 * the trial's own token (THERMITE_TRIAL_AUTH), which binds every call to the trial and stops
 * working when the trial ends.
 *
 *   thermite-trial submit --hypothesis TEXT [--claim TEXT] [--flaw TEXT]...
 *   thermite-trial dev-run [--timeout SECONDS] -- COMMAND...
 *   thermite-trial status ATTEMPT
 */

const USAGE = `usage:
  thermite-trial submit --hypothesis TEXT [--claim TEXT] [--flaw TEXT]...
  thermite-trial dev-run [--timeout SECONDS] -- COMMAND...
  thermite-trial status ATTEMPT`;

export interface TrialCliEnv {
  harnessUrl: string;
  auth: string;
  workspace: string;
  editablePaths: string[];
}

type Call = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** The options after a command: repeated flags collect, `--` ends them. */
export function parseArgs(argv: string[]): { flags: Record<string, string[]>; rest: string[] } {
  const flags: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) {
      const value = m[2] ?? argv[++i] ?? "";
      flags[m[1] as string] = [...(flags[m[1] as string] ?? []), value];
    } else rest.push(a);
  }
  return { flags, rest };
}

/** The change inside the editable paths, as a binary patch against the trial's parent. */
export function patchOf(workspace: string, editablePaths: string[]): string {
  const pathspecs = editablePaths.map((p) => `':(glob)${p.replace(/'/g, "")}'`).join(" ");
  return execFileSync("sh", ["-c", `git add -A -- ${pathspecs} && git diff --cached --binary`], {
    cwd: workspace,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
}

export async function trialCli(argv: string[], env: TrialCliEnv, call: Call): Promise<string> {
  const [cmd, ...args] = argv;
  const { flags, rest } = parseArgs(args);
  if (cmd === "submit") {
    const hypothesis = flags.hypothesis?.[0]?.trim();
    if (!hypothesis) return `error: submit needs --hypothesis\n${USAGE}`;
    const patch = patchOf(env.workspace, env.editablePaths);
    if (!patch.trim())
      return `error: there are no changes inside the editable paths (${env.editablePaths.join(", ")})`;
    const out = (await call("POST", "/v1/attempts", {
      patch_base64: Buffer.from(patch).toString("base64"),
      hypothesis: hypothesis.slice(0, 2000),
      claim: flags.claim?.[0]?.slice(0, 2000),
      known_flaws: (flags.flaw ?? []).map((f) => f.slice(0, 1000)),
    })) as { attempt: string; lifecycle: string; violations?: string[] };
    return `submitted ${out.attempt}: ${out.lifecycle}${out.violations?.length ? `; refused: ${out.violations.join("; ")}` : ""}. The trial ends with this submission.`;
  }
  if (cmd === "dev-run") {
    const command = rest.join(" ").trim();
    if (!command) return `error: dev-run needs a command after --\n${USAGE}`;
    const timeout = Number(flags.timeout?.[0]);
    const out = await call("POST", "/v1/dev-runs", {
      command,
      cwd: env.workspace,
      ...(timeout > 0 ? { timeout_s: Math.trunc(timeout) } : {}),
    });
    return JSON.stringify(out, null, 2);
  }
  if (cmd === "status") {
    const id = rest[0];
    if (!id) return `error: status needs an attempt id\n${USAGE}`;
    return JSON.stringify(await call("GET", `/v1/attempts/${encodeURIComponent(id)}`), null, 2);
  }
  return USAGE;
}

async function main(): Promise<void> {
  const env: TrialCliEnv = {
    harnessUrl: process.env.THERMITE_HARNESS_URL ?? "http://127.0.0.1:8700",
    auth: process.env.THERMITE_TRIAL_AUTH ?? "",
    workspace: process.env.THERMITE_WORKSPACE ?? process.cwd(),
    editablePaths: JSON.parse(process.env.THERMITE_EDITABLE_PATHS ?? "[]") as string[],
  };
  const call: Call = async (method, path, body) => {
    const r = await apiCall(
      `${env.harnessUrl}${path}`,
      method,
      { authorization: `Bearer ${env.auth}`, "content-type": "application/json" },
      body !== undefined ? JSON.stringify(body) : undefined,
    );
    if (r.status < 200 || r.status >= 300) throw new Error(`${r.status}: ${r.text.slice(0, 500)}`);
    return JSON.parse(r.text);
  };
  try {
    const out = await trialCli(process.argv.slice(2), env, call);
    process.stdout.write(`${out}\n`);
    if (out.startsWith("error:") || out.startsWith("usage:")) process.exitCode = 2;
  } catch (err) {
    process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("trial-cli.js") || process.argv[1]?.endsWith("trial-cli.ts"))
  void main();
