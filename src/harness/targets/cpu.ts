import { createHash } from "node:crypto";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { Readiness, TargetDriver, TargetIdentity } from "./driver.ts";

/** CPU target: the rig's CPU set. Used for CPU campaigns and for portable local testing. */
export class CpuDriver implements TargetDriver {
  readonly type = "cpu";
  private readonly targetClass: string;
  /** Not ready for timing when the 1-minute load average exceeds this fraction of the cores. */
  private readonly maxLoadFraction: number;
  private readonly load: () => number;

  constructor(
    targetClass = "generic-cpu",
    opts: { maxLoadFraction?: number; load?: () => number } = {},
  ) {
    this.targetClass = targetClass;
    this.maxLoadFraction = opts.maxLoadFraction ?? 0.75;
    this.load = opts.load ?? (() => loadavg()[0] ?? 0);
  }

  async identify(): Promise<TargetIdentity> {
    const cpu = cpus();
    const model = cpu[0]?.model ?? "unknown";
    const id = createHash("sha256").update(`${model}|${cpu.length}`).digest("hex").slice(0, 16);
    return {
      type: this.type,
      class: this.targetClass,
      id: `cpu-${id}`,
      details: { model, cores: cpu.length },
    };
  }

  async readyForTiming(): Promise<Readiness> {
    const cores = cpus().length;
    const load = this.load();
    const reasons: string[] = [];
    if (load > cores * this.maxLoadFraction) {
      reasons.push(
        `load ${load.toFixed(2)} above ${this.maxLoadFraction * 100}% of ${cores} cores`,
      );
    }
    return { ready: reasons.length === 0, reasons, details: { load1: load, cores } };
  }

  async envSnapshot(): Promise<Record<string, unknown>> {
    return {
      load: loadavg(),
      free_mem: freemem(),
      total_mem: totalmem(),
      cpu: (await this.identify()).details,
    };
  }

  async afterBlock(): Promise<string[]> {
    return [];
  }

  plausibility(metrics: Record<string, number>): string[] {
    return Object.entries(metrics)
      .filter(([, v]) => !Number.isFinite(v))
      .map(([k]) => `${k} is not finite`);
  }

  async recover(): Promise<Readiness> {
    return this.readyForTiming();
  }
}
