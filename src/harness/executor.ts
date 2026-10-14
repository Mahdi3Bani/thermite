import type { HarnessService } from "./service.ts";
import type { TargetDriver } from "./targets/driver.ts";

/**
 * M1 fake executor: leases `evaluate` jobs and records the executor-measured wall time of a fixed
 * probe command, with an environment receipt. It exercises leases, fences and receipts end to end.
 * The judge's real gates, screens and verdicts replace the probe in M2.
 */
export class FakeExecutor {
  private readonly service: HarnessService;
  private readonly driver: TargetDriver;
  private readonly owner: string;

  constructor(service: HarnessService, driver: TargetDriver, owner = "executor-0") {
    this.service = service;
    this.driver = driver;
    this.owner = owner;
  }

  /** One scheduling step. Returns true when a job was processed. */
  async tick(): Promise<boolean> {
    const ledger = this.service.ledger;
    ledger.expireLeases();
    const job = ledger.leaseJob(this.owner, 10 * 60_000, ["evaluate"]);
    if (!job) return false;
    const target = await this.driver.identify();
    const ready = await this.driver.readyForTiming();
    const probe = await this.driver.run({
      command: process.execPath,
      args: ["-e", "let s=0; for (let i=0;i<2e6;i++) s+=i; process.stdout.write(String(s))"],
      cwd: this.service.paths.scratchDir,
      env: {},
      timeoutMs: 60_000,
    });
    const ok = probe.exitCode === 0 && !probe.timedOut;
    if (ok) {
      ledger.recordMeasurement(job.id, job.fence, {
        metric: "probe_wall_ms",
        cell: "probe",
        rep: 1,
        value: probe.wallMs,
        unit: "ms",
      });
    }
    ledger.recordReceipt(job.id, job.fence, {
      job: job.id,
      attempt: job.attempt,
      target,
      ready,
      env: await this.driver.envSnapshot(),
      probe: { exit: probe.exitCode, timed_out: probe.timedOut, wall_ms: probe.wallMs },
    });
    ledger.completeJob(job.id, job.fence, ok ? "done" : "failed", { probe_wall_ms: probe.wallMs });
    if (job.attempt)
      ledger.setAttemptLifecycle(job.attempt, ok ? "measured" : "errored", this.owner);
    return true;
  }
}
