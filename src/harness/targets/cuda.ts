import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Readiness, TargetDriver, TargetIdentity } from "./driver.ts";

/**
 * CUDA GPU target, read through nvidia-smi. It never changes clocks, power or cooling (D14):
 * it records them with every block and refuses to time when the device is busy, hot or
 * throttled. Processes in other containers are invisible to nvidia-smi, so "idle" is judged
 * from utilization and memory use as well as from the process list.
 */

const run = promisify(execFile);

const FIELDS = [
  "index",
  "uuid",
  "name",
  "pci.bus_id",
  "driver_version",
  "memory.total",
  "memory.used",
  "memory.free",
  "utilization.gpu",
  "temperature.gpu",
  "power.draw",
  "power.limit",
  "clocks.sm",
  "clocks.mem",
  "clocks.max.sm",
  "clocks.max.mem",
  "pstate",
] as const;

export type GpuRow = Record<(typeof FIELDS)[number], string>;

/** Clock event (throttle) reason bits, as nvidia-smi reports them. */
const REASONS: Record<number, string> = {
  1: "gpu_idle",
  2: "applications_clocks_setting",
  4: "sw_power_cap",
  8: "hw_slowdown",
  16: "sync_boost",
  32: "sw_thermal_slowdown",
  64: "hw_thermal_slowdown",
  128: "hw_power_brake_slowdown",
  256: "display_clock_setting",
};
/** Reasons that make a timing invalid if active before a block. */
const BLOCKING = [
  "hw_slowdown",
  "sw_thermal_slowdown",
  "hw_thermal_slowdown",
  "hw_power_brake_slowdown",
];

export function parseCsvRow(line: string): string[] {
  return line.split(",").map((f) => f.trim());
}

export function parseGpuRows(csv: string): GpuRow[] {
  return csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const f = parseCsvRow(l);
      if (f.length !== FIELDS.length)
        throw new Error(`nvidia-smi: expected ${FIELDS.length} fields: ${l}`);
      return Object.fromEntries(FIELDS.map((k, i) => [k, f[i] as string])) as GpuRow;
    });
}

export function decodeReasons(hex: string): string[] {
  const bits = Number.parseInt(hex, 16);
  if (!Number.isFinite(bits)) return [`unknown(${hex})`];
  return Object.entries(REASONS)
    .filter(([bit]) => (bits & Number(bit)) !== 0)
    .map(([, name]) => name);
}

export interface CudaLimits {
  /** Utilization above this (percent) before a block means someone else is using the GPU. */
  maxIdleUtilization: number;
  /** Memory in use above this (MiB) before a block means someone else holds the GPU. */
  maxIdleMemoryMiB: number;
  maxTemperatureC: number;
}

export interface CudaDriverOptions {
  targetClass: string;
  index?: number | undefined;
  limits?: Partial<CudaLimits> | undefined;
  /** For tests: replaces running nvidia-smi. */
  smi?: ((args: string[]) => Promise<string>) | undefined;
}

export class CudaDriver implements TargetDriver {
  readonly type = "cuda-gpu";
  private readonly targetClass: string;
  private readonly index: number;
  private readonly limits: CudaLimits;
  private readonly smi: (args: string[]) => Promise<string>;

  constructor(opts: CudaDriverOptions) {
    this.targetClass = opts.targetClass;
    this.index = opts.index ?? 0;
    this.limits = {
      maxIdleUtilization: 5,
      maxIdleMemoryMiB: 600,
      maxTemperatureC: 85,
      ...opts.limits,
    };
    this.smi =
      opts.smi ?? (async (args) => (await run("nvidia-smi", args, { encoding: "utf8" })).stdout);
  }

  private async row(): Promise<GpuRow> {
    const rows = parseGpuRows(
      await this.smi([`--query-gpu=${FIELDS.join(",")}`, "--format=csv,noheader,nounits"]),
    );
    const r = rows.find((x) => Number(x.index) === this.index) ?? rows[0];
    if (!r) throw new Error("nvidia-smi reported no GPU");
    return r;
  }

  private async reasons(): Promise<string[]> {
    // The field was renamed from clocks_throttle_reasons to clocks_event_reasons.
    for (const field of ["clocks_event_reasons.active", "clocks_throttle_reasons.active"]) {
      try {
        const out = await this.smi([`--query-gpu=index,${field}`, "--format=csv,noheader"]);
        const line = out
          .split("\n")
          .map(parseCsvRow)
          .find((f) => Number(f[0]) === this.index);
        if (line?.[1]) return decodeReasons(line[1]);
      } catch {
        // try the older name
      }
    }
    return ["unknown"];
  }

  private async apps(): Promise<{ pid: number; used_mib: number }[]> {
    try {
      const out = await this.smi([
        "--query-compute-apps=pid,used_memory",
        "--format=csv,noheader,nounits",
      ]);
      return out
        .split("\n")
        .map((l) => parseCsvRow(l))
        .filter((f) => f.length === 2 && f[0] !== "")
        .map(([pid, mem]) => ({ pid: Number(pid), used_mib: Number(mem) }));
    } catch {
      return [];
    }
  }

  async identify(): Promise<TargetIdentity> {
    const r = await this.row();
    return {
      type: this.type,
      class: this.targetClass,
      id: r.uuid,
      details: {
        name: r.name,
        bus: r["pci.bus_id"],
        driver: r.driver_version,
        memory_total_mib: Number(r["memory.total"]),
        max_sm_clock: Number(r["clocks.max.sm"]),
        max_mem_clock: Number(r["clocks.max.mem"]),
      },
    };
  }

  async readyForTiming(): Promise<Readiness> {
    const [r, reasons, apps] = await Promise.all([this.row(), this.reasons(), this.apps()]);
    const why: string[] = [];
    // Anything unreadable is not "fine": a missing or NaN field means not ready.
    for (const f of ["utilization.gpu", "memory.used", "temperature.gpu"] as const) {
      if (!Number.isFinite(Number(r[f]))) why.push(`nvidia-smi gave no ${f} (${r[f]})`);
    }
    if (reasons.includes("unknown")) why.push("clock event reasons unavailable");
    if (apps.length) why.push(`compute processes on the GPU: ${apps.map((a) => a.pid).join(", ")}`);
    if (Number(r["utilization.gpu"]) > this.limits.maxIdleUtilization) {
      why.push(`GPU ${r["utilization.gpu"]}% busy before timing`);
    }
    if (Number(r["memory.used"]) > this.limits.maxIdleMemoryMiB) {
      why.push(`${r["memory.used"]} MiB in use before timing`);
    }
    if (Number(r["temperature.gpu"]) > this.limits.maxTemperatureC) {
      why.push(`temperature ${r["temperature.gpu"]} C`);
    }
    const blocking = reasons.filter((x) => BLOCKING.includes(x));
    if (blocking.length) why.push(`clock events: ${blocking.join(", ")}`);
    return {
      ready: why.length === 0,
      reasons: why,
      details: { ...r, clock_events: reasons, apps },
    };
  }

  async envSnapshot(): Promise<Record<string, unknown>> {
    const [r, reasons, apps] = await Promise.all([this.row(), this.reasons(), this.apps()]);
    return { ...r, clock_events: reasons, apps };
  }

  async afterBlock(): Promise<string[]> {
    const [r, reasons] = await Promise.all([this.row(), this.reasons()]);
    const why = reasons.filter((x) => BLOCKING.includes(x)).map((x) => `clock event: ${x}`);
    const t = Number(r["temperature.gpu"]);
    if (!Number.isFinite(t) || t > this.limits.maxTemperatureC)
      why.push(`temperature ${r["temperature.gpu"]} C`);
    return why;
  }

  plausibility(metrics: Record<string, number>): string[] {
    return Object.entries(metrics)
      .filter(([, v]) => !Number.isFinite(v) || v <= 0)
      .map(([k, v]) => `${k} is ${v}`);
  }

  async recover(): Promise<Readiness> {
    return this.readyForTiming();
  }
}
