import { spawn } from "node:child_process";
import type { RunResult, RunSpec } from "./driver.ts";

const MAX_CAPTURE = 4 * 1024 * 1024;

/**
 * Runs a child in its own process group and measures wall time from this process. On timeout the
 * whole group is killed, so a candidate cannot leave work running into the next timed block.
 */
export function runTimed(spec: RunSpec): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? {},
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(spec.uid !== undefined ? { uid: spec.uid } : {}),
      ...(spec.gid !== undefined ? { gid: spec.gid } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
    });
    let timedOut = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, spec.timeoutMs);
    const finish = (exitCode: number | null, signal: string | null) => {
      clearTimeout(timer);
      killGroup();
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ exitCode, signal, timedOut, wallMs, stdout, stderr });
    };
    child.on("error", (err) => {
      stderr += String(err);
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
