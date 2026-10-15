import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { type Role, RoleSchema, type Runner } from "../broker/runner.ts";
import type { Ledger } from "../ledger.ts";
import { laneCacheEnv } from "./workspace.ts";

/**
 * Agents' development runs on the measurement device (§6.2a). The judge goes first: a dev run
 * waits while the judge has work queued or running, and the judge does not start a job while a
 * dev run holds the device. On a rig with a dedicated development card, neither waits for the
 * other: dev runs use their own card, and the broker keeps them off the judge's. Each run is
 * time-limited and killed at the end; its output is diagnostic only and never reaches the
 * ledger as a measurement.
 */

export const DevRunRequest = z.object({
  lane: RoleSchema.refine((r) => /^lane-\d+$/.test(r), "a lane"),
  command: z.string().min(1).max(4000),
  cwd: z.string().min(1),
  timeout_s: z.number().int().min(1).max(3600).default(120),
});

export class DevRuns {
  /** True while a dev run holds the device; the judge checks it before leasing a job. */
  active = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Each lane's newest dev run (queued or running), so its trial can wait for it to end. */
  private readonly perLane = new Map<string, Promise<unknown>>();
  private readonly runner: Runner;
  private readonly ledger: Ledger;
  private readonly scratchDir: string;
  private readonly gpu: boolean;
  private readonly dedicated: boolean;
  private readonly unavailable: string | undefined;
  private readonly maxWaitMs: number;

  constructor(opts: {
    runner: Runner;
    ledger: Ledger;
    scratchDir: string;
    gpu: boolean;
    /** The rig has a dedicated development card. */
    dedicated?: boolean | undefined;
    /** Why dev runs cannot run on this rig at all. */
    unavailable?: string | undefined;
    maxWaitMs?: number;
  }) {
    this.runner = opts.runner;
    this.ledger = opts.ledger;
    this.scratchDir = opts.scratchDir;
    this.gpu = opts.gpu;
    this.dedicated = opts.dedicated === true;
    this.unavailable = opts.unavailable;
    this.maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  }

  private judgeBusy(): boolean {
    const r = this.ledger.db
      .prepare(
        "select count(*) as n from job where state in ('queued', 'leased') and kind in ('evaluate', 'confirm', 'calibrate', 'validate')",
      )
      .get() as { n: number };
    return Number(r.n) > 0;
  }

  /** Waits until the lane's dev runs have ended (a trial's end waits for this). */
  async settle(lane: string): Promise<void> {
    await this.perLane.get(lane)?.catch(() => undefined);
  }

  private trialOpen(trial: string): boolean {
    const r = this.ledger.db.prepare("select ended_at from trial where id = ?").get(trial) as
      | { ended_at: string | null }
      | undefined;
    return r !== undefined && r.ended_at === null;
  }

  /** A dev run for an open trial; one that waited past its trial's end never runs. */
  run(
    input: unknown,
    trial: string,
    limits: { rssMib: number; diskMib: number } = { rssMib: 4096, diskMib: 2048 },
  ): Promise<unknown> {
    const req = DevRunRequest.parse(input);
    const laneRoot = join(this.scratchDir, "lanes", req.lane);
    const cwd = resolve(req.cwd);
    if (!cwd.startsWith(laneRoot + sep))
      throw new Error("a dev run must run in the lane's own workspace");
    if (this.unavailable) return Promise.resolve({ ran: false, reason: this.unavailable });
    // One dev run at a time, in arrival order.
    const next = this.queue.then(async () => {
      const deadline = Date.now() + this.maxWaitMs;
      while (!this.dedicated && this.judgeBusy()) {
        if (Date.now() > deadline)
          return { ran: false, reason: "the judge kept the device busy; try again later" };
        if (!this.trialOpen(trial)) return { ran: false, reason: "the trial has ended" };
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!this.trialOpen(trial)) return { ran: false, reason: "the trial has ended" };
      // The judge waits for a dev run only when they share the card.
      this.active = !this.dedicated;
      try {
        const r = await this.runner.run({
          role: req.lane as Role,
          argv: ["sh", "-c", req.command],
          cwd,
          env: laneCacheEnv(this.scratchDir, req.lane),
          timeoutMs: req.timeout_s * 1000,
          rssLimitBytes: limits.rssMib * 1024 * 1024,
          disk: { path: cwd, limitBytes: limits.diskMib * 1024 * 1024 },
          captureBytes: 32 * 1024,
          ...(this.gpu ? { gpu: true } : {}),
        });
        this.ledger.appendEvent("devrun", "dev_run", req.lane, {
          wall_ms: Math.round(r.wallMs),
          exit: r.exitCode,
          killed: r.killedFor,
        });
        return {
          ran: true,
          exit: r.exitCode ?? r.signal,
          killed: r.killedFor,
          wall_ms: Math.round(r.wallMs),
          stdout: r.stdout.slice(-12_000),
          stderr: r.stderr.slice(-6_000),
          note: "diagnostic only: this number never counts",
        };
      } finally {
        await this.runner.killRole(req.lane as Role).catch(() => 0);
        this.active = false;
      }
    });
    this.queue = next.catch(() => undefined);
    this.perLane.set(req.lane, next);
    return next;
  }
}
