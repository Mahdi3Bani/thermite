import { createHash } from "node:crypto";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { Readiness, RunResult, RunSpec, TargetDriver, TargetIdentity } from "./driver.ts";
import { runTimed } from "./run.ts";

/** CPU target: the unit's CPU set. Used for CPU campaigns and for portable local testing. */
export class CpuDriver implements TargetDriver {
  readonly type = "cpu";
  private readonly targetClass: string;

  constructor(targetClass = "generic-cpu") {
    this.targetClass = targetClass;
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
    const load = loadavg()[0] ?? 0;
    const reasons: string[] = [];
    if (load > cores * 0.75) reasons.push(`load ${load.toFixed(2)} above 75% of ${cores} cores`);
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

  run(spec: RunSpec): Promise<RunResult> {
    return runTimed(spec);
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
