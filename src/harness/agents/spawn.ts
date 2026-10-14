import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchTrialSpec } from "./research-worker.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";

export type AnyTrial =
  | { kind: "code"; spec: TrialSpec }
  | { kind: "research"; spec: ResearchTrialSpec };

/**
 * What a worker process inherits: the model route and the broker socket, never the controller's
 * API tokens or other secrets (its trial token comes in the spec file).
 */
const WORKER_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "TMPDIR",
  "NODE_OPTIONS",
  "THERMITE_BROKER_SOCKET",
  "QWEN_BASE_URL",
  "QWEN_MODEL",
  "QWEN_API_KEY",
  "QWEN_CONTEXT_WINDOW",
  "QWEN_MAX_TOKENS",
];

/**
 * Runs one trial in its own worker process (the controller's user), with a hard wall limit. The
 * worker shares the controller's process group, so the broker's kill of that group after a
 * controller crash ends it too.
 */
export function spawnTrial(
  trial: AnyTrial,
  scratchDir: string,
  apiPort: number,
  signal?: AbortSignal,
): Promise<TrialResult> {
  const spec = trial.spec;
  const dir = join(scratchDir, "trials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const specFile = join(dir, `${spec.trialId}.json`);
  writeFileSync(specFile, JSON.stringify(trial), { mode: 0o600 });
  const main = fileURLToPath(new URL("./worker-main.js", import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, main, specFile], {
      env: {
        ...Object.fromEntries(
          WORKER_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
        ),
        THERMITE_HARNESS_URL: `http://127.0.0.1:${apiPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out = (out + d.toString("utf8")).slice(-1_000_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString("utf8")).slice(-20_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), spec.wallMs + 120_000);
    const abort = () => child.kill("SIGKILL");
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rmSync(specFile, { force: true });
      const last = out.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(last) as TrialResult);
      } catch {
        resolve({
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
          error: `worker process gave no result: ${err.slice(-500)}`,
        });
      }
    });
  });
}
