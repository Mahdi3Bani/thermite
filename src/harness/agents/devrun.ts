import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { SHARED_DEV_RUN_S } from "../../core/contract.ts";
import { type Role, RoleSchema, type Runner } from "../broker/runner.ts";
import type { Ledger } from "../ledger.ts";
import { laneCacheEnv } from "./workspace.ts";

/**
 * Agents' development runs on the measurement device (§6.2a). The judge goes first: a dev run
 * waits while the judge has work queued or running, and the judge does not start a job while a
 * dev run holds the device. On a rig with a dedicated development card, neither waits for the
 * other: dev runs use their own card, and the broker keeps them off the judge's. A dev run on a
 * card the judge shares is time-limited, so the judge gets the card back; on a dedicated card
 * only the contract's limit applies, if it sets one. Nothing a dev run starts on the device
 * outlives it. Its output is diagnostic only and never reaches the ledger as a measurement.
 */

export const DevRunRequest = z.object({
  lane: RoleSchema.refine((r) => /^lane-\d+$/.test(r), "a lane"),
  command: z.string().min(1).max(4000),
  cwd: z.string().min(1),
  timeout_s: z
    .number()
    .int()
    .min(1)
    .max(24 * 3600)
    .optional(),
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
    limits: { rssMib: number; diskMib: number; timeoutS?: number } = {
      rssMib: 4096,
      diskMib: 2048,
    },
  ): Promise<unknown> {
    const req = DevRunRequest.parse(input);
    const laneRoot = join(this.scratchDir, "lanes", req.lane);
    const cwd = resolve(req.cwd);
    if (!cwd.startsWith(laneRoot + sep))
      throw new Error("a dev run must run in the lane's own workspace");
    if (this.unavailable) return Promise.resolve({ ran: false, reason: this.unavailable });
    const cap = limits.timeoutS ?? (this.dedicated ? undefined : SHARED_DEV_RUN_S);
    const timeoutS =
      req.timeout_s === undefined ? cap : Math.min(req.timeout_s, cap ?? Number.POSITIVE_INFINITY);
    // One dev run at a time, in arrival order. One waiting behind another lane's for longer than
    // maxWaitMs is told so and never runs: the device has no time limit of its own.
    let started = false;
    let gaveUp = false;
    const next = this.queue.then(async () => {
      if (gaveUp) return { ran: false, reason: "another lane's dev run held the device" };
      started = true;
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
          ...(timeoutS !== undefined ? { timeoutMs: timeoutS * 1000 } : {}),
          rssLimitBytes: limits.rssMib * 1024 * 1024,
          disk: { path: cwd, limitBytes: limits.diskMib * 1024 * 1024 },
          captureBytes: 32 * 1024,
          // Without a device (a CPU target) a dev run is a lane command run in the judge's turn.
          ...(this.gpu ? { gpu: true } : { keepBackground: true }),
        });
        // What ran and its peak memory, so a killed dev run can be understood afterwards.
        this.ledger.appendEvent("devrun", "dev_run", req.lane, {
          wall_ms: Math.round(r.wallMs),
          exit: r.exitCode,
          killed: r.killedFor,
          peak_rss_mib: Math.round(r.peakRssBytes / 2 ** 20),
          command: req.command.slice(0, 300),
        });
        return {
          ran: true,
          exit: r.exitCode ?? r.signal,
          killed: r.killedFor,
          wall_ms: Math.round(r.wallMs),
          stdout: r.stdout.slice(-6_000),
          stderr: r.stderr.slice(-3_000),
          note: "diagnostic only: this number never counts",
        };
      } finally {
        // Only the dev run's processes: the lane's own background work runs on.
        if (this.gpu) await this.runner.killRole(req.lane as Role, { gpu: true }).catch(() => 0);
        this.active = false;
      }
    });
    this.queue = next.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<unknown>((resolve) => {
      timer = setTimeout(() => {
        if (started) return;
        gaveUp = true;
        resolve({
          ran: false,
          reason: "another lane's dev run held the device; try again later",
        });
      }, this.maxWaitMs);
      timer.unref?.();
    });
    const outcome = Promise.race([next, waited]).finally(() => clearTimeout(timer));
    this.perLane.set(req.lane, outcome);
    return outcome;
  }
}
