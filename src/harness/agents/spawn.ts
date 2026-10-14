import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchTrialSpec } from "./research-worker.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";

export type AnyTrial =
  | { kind: "code"; spec: TrialSpec }
  | { kind: "research"; spec: ResearchTrialSpec };

/** Runs one trial in its own worker process (the controller's user), with a hard wall limit. */
export function spawnTrial(
  trial: AnyTrial,
  scratchDir: string,
  apiPort: number,
): Promise<TrialResult> {
  const spec = trial.spec;
  const dir = join(scratchDir, "trials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const specFile = join(dir, `${spec.trialId}.json`);
  writeFileSync(specFile, JSON.stringify(trial), { mode: 0o600 });
  const main = fileURLToPath(new URL("./worker-main.js", import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, main, specFile], {
      env: { ...process.env, THERMITE_HARNESS_URL: `http://127.0.0.1:${apiPort}` },
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
    child.on("close", () => {
      clearTimeout(timer);
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
