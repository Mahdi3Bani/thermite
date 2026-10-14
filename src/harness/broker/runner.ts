import { chmodSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { runSupervised, type SupervisedResult } from "./process.ts";

/**
 * Roles and the runner interface. Inside the harness container the broker (root) runs each
 * role as its own Unix user; in local development the same interface runs everything as the
 * current user, without separation. Callers never pass uids: they name a role.
 */

/** Fixed ids, created in the harness image (containers/harness/Containerfile). */
export const IDS = {
  thermite: { uid: 10010, gid: 10010 },
  builder: { uid: 10020, gid: 10020 },
  /** Candidate execution: primary group `gpu`, the group that owns the device nodes. */
  run: { uid: 10030, gid: 10500 },
  gpuGroup: 10500,
  laneBase: 10100,
  laneDevBase: 10200,
  /** Each lane's worker agent process: its own user, with no access to the lane's files. */
  agentBase: 10300,
  maxLanes: 16,
} as const;

export const RoleSchema = z
  .string()
  .regex(
    /^(builder|run|lane-([1-9]|1[0-6])|lane-([1-9]|1[0-6])-dev|agent-([1-9]|1[0-6]))$/,
    "unknown role",
  );
export type Role = z.infer<typeof RoleSchema>;

export function roleIds(role: Role): { uid: number; gid: number } {
  if (role === "builder") return IDS.builder;
  if (role === "run") return IDS.run;
  const agent = /^agent-(\d+)$/.exec(role);
  if (agent) {
    const n = Number(agent[1]);
    return { uid: IDS.agentBase + n, gid: IDS.agentBase + n };
  }
  const m = /^lane-(\d+)(-dev)?$/.exec(role);
  if (!m) throw new Error(`unknown role ${role}`);
  const n = Number(m[1]);
  // Development runs on the device get the gpu group; plain lane work gets its own group.
  return m[2]
    ? { uid: IDS.laneDevBase + n, gid: IDS.gpuGroup }
    : { uid: IDS.laneBase + n, gid: IDS.laneBase + n };
}

export const RunRequest = z.object({
  role: RoleSchema,
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(24 * 3_600_000),
  rssLimitBytes: z.number().int().positive().optional(),
  disk: z.object({ path: z.string().min(1), limitBytes: z.number().int().positive() }).optional(),
  /** Written to the child's stdin (file contents for workers' file tools). */
  stdin: z
    .string()
    .max(8 * 1024 * 1024)
    .optional(),
  /** Bytes of stdout and stderr kept (the tail); default 64 KiB. */
  captureBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .optional(),
  /**
   * Run a lane's command with the gpu group (an agent's development run on the device, §6.2a).
   * Only lane roles may ask; the broker refuses it for any other role.
   */
  gpu: z.boolean().optional(),
});
export type RunRequest = z.input<typeof RunRequest>;

export type RunOutcome = SupervisedResult;

export interface Runner {
  /** True when roles really run as separate users. */
  readonly separated: boolean;
  run(req: RunRequest): Promise<RunOutcome>;
  /** Gives a directory under scratch to a role (it may then write there). */
  handOver(path: string, role: Role): Promise<void>;
  /** Takes a directory back for the controller (so it can read and move results). */
  reclaim(path: string): Promise<void>;
  /** Removes a directory under scratch, whoever owns its files. */
  remove(path: string): Promise<void>;
  /** Kills every process of a role. */
  killRole(role: Role): Promise<number>;
}

/** Resolves `path` and checks it lies strictly inside `root` (symlinks resolved). */
export function insideRoot(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const full = realpathSync(resolve(path));
  if (!full.startsWith(realRoot + sep)) throw new Error(`path outside scratch: ${path}`);
  return full;
}

/** Walks a tree without following symlinks. */
export function walk(path: string, visit: (p: string, isDir: boolean) => void): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    visit(path, false);
    return;
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(path)) walk(join(path, e), visit);
  }
  visit(path, st.isDirectory());
}

/** Local development runner: no user separation, same limits and timing. */
export class LocalRunner implements Runner {
  readonly separated = false;
  private readonly scratchDir: string;

  constructor(scratchDir: string) {
    this.scratchDir = scratchDir;
  }

  async run(input: RunRequest): Promise<RunOutcome> {
    const req = RunRequest.parse(input);
    insideRoot(this.scratchDir, req.cwd);
    return runSupervised({
      argv: req.argv,
      cwd: req.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: req.cwd, ...req.env },
      timeoutMs: req.timeoutMs,
      rssLimitBytes: req.rssLimitBytes,
      disk: req.disk,
      stdin: req.stdin,
      captureBytes: req.captureBytes,
    });
  }

  async handOver(path: string): Promise<void> {
    insideRoot(this.scratchDir, path);
  }

  async reclaim(path: string): Promise<void> {
    const full = insideRoot(this.scratchDir, path);
    // A run may have left read-only directories; the controller must be able to clean up.
    walk(full, (p, isDir) => {
      if (isDir) chmodSync(p, 0o755);
    });
  }

  async remove(path: string): Promise<void> {
    const full = insideRoot(this.scratchDir, path);
    await this.reclaim(full);
    rmSync(full, { recursive: true, force: true });
  }

  async killRole(): Promise<number> {
    return 0;
  }
}
