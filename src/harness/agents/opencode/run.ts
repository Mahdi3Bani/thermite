import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LaneLimitValues } from "../../../core/contract.ts";
import type { Role, Runner, RunOutcome } from "../../broker/runner.ts";

/** OpenCode's binary: THERMITE_OPENCODE_BIN, else `opencode` on the PATH (read when used). */
export const opencodeBin = () => process.env.THERMITE_OPENCODE_BIN ?? "opencode";

/** What to say when the image has no OpenCode: an image other than the published ones. */
export const NO_OPENCODE =
  "this rig's harness image has no OpenCode binary: use a harness image that has it, as the published images do, or give the rig another harness on Edit rig";

/** Why OpenCode exited, in words. A missing program says so, rather than the shell's note. */
export function opencodeExitWords(code: number | string | null, note: string): string {
  if (
    (code === 126 || code === 127) &&
    /opencode: (No such file or directory|not found)/.test(note)
  )
    return NO_OPENCODE;
  return `OpenCode exited ${code}: ${note}`;
}

/** OpenCode's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function opencodeExe(): string | undefined {
  const bin = opencodeBin();
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** One `opencode run` as the lane, under its limits; its output goes to the events file. */
export function startInArea(
  runner: Runner,
  role: Role,
  area: string,
  cwd: string,
  env: Record<string, string>,
  args: string[],
  o: { remaining: number; limits: LaneLimitValues; prompt: string },
): Promise<RunOutcome> {
  const exe = opencodeExe();
  return runner.run({
    role,
    // The prompt on stdin, which `opencode run` reads when it is not a terminal: one argument
    // holds at most 128 KiB on Linux, and a brief has no such limit (goal 171).
    stdin: o.prompt,
    // Its output goes to a file the harness follows while it runs.
    argv: [
      "sh",
      "-c",
      'exec "$@" >> "$THERMITE_OPENCODE_EVENTS" 2>&1',
      "sh",
      // By its full path, so the broker knows OpenCode's processes from its commands'.
      exe ?? opencodeBin(),
      ...args,
    ],
    cwd,
    env,
    // No time limit unless the trial has one (goal 079).
    ...(Number.isFinite(o.remaining) ? { timeoutMs: o.remaining } : {}),
    rssLimitBytes: o.limits.runRssMib * 1024 * 1024,
    // Over the memory limit, OpenCode's commands are killed and OpenCode carries on, as a
    // lane command under Pi would be; the trial ends only if OpenCode alone is over.
    ...(exe ? { spareExe: exe } : {}),
    disk: { path: area, limitBytes: o.limits.workspaceMib * 1024 * 1024 },
    nproc: o.limits.processes,
    captureBytes: 4096,
  });
}
