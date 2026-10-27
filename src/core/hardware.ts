/**
 * What a rig runs on, as its harness reports it (inside the signed report's summary) and the
 * dashboard shows it. Collected once when the harness starts: the device, its driver, the
 * container's CPU and memory, and the disks it works on.
 */
export interface Hardware {
  collected_at: string;
  /** The judge's target, as its driver identifies it (the comparability key is `id`). */
  target: { type: string; class: string; id: string };
  /**
   * "shared": one device for the judge and agents' dev runs; "dedicated": cards of their own for
   * the judge and for dev runs (one or more of each; devices lists them with their roles).
   */
  device_mode: "shared" | "dedicated" | "none";
  devices: HardwareDevice[];
  cpu: {
    model: string;
    /** CPUs the host has, the harness may run on (affinity), and the container's quota. */
    host: number;
    usable: number;
    quota: number | null;
  };
  memory: { host_mib: number; limit_mib: number | null };
  disks: { name: "state" | "scratch"; total_gib: number; free_gib: number }[];
  os: { kernel: string; arch: string; node: string; image: string | null };
  toolchain: { cc: string | null; nvcc: string | null };
  /** What could not be read. */
  errors: string[];
}

export interface HardwareDevice {
  /** Who uses it: the judge, agents' dev runs, or both. */
  role: "judge" | "dev" | "shared";
  name: string;
  uuid: string;
  bus: string;
  memory_mib: number | null;
  driver: string | null;
  cuda: string | null;
  power_limit_w: number | null;
  max_sm_mhz: number | null;
  max_mem_mhz: number | null;
  /** PCIe generation and width, as "gen3 x16". */
  pcie: string | null;
  vbios: string | null;
}

/** Reads a reported hardware object loosely: anything malformed is dropped, never trusted. */
export function readHardware(x: unknown): Hardware | null {
  if (!x || typeof x !== "object") return null;
  const h = x as Partial<Hardware>;
  if (typeof h.collected_at !== "string" || !Array.isArray(h.devices) || !h.cpu || !h.memory) {
    return null;
  }
  return h as Hardware;
}

/**
 * The judge's GPUs on a rig of `n` when no split is given: half, rounded up (the one GPU of a
 * rig with one). Control's pages and the broker split the same way; a page's script takes this
 * function's source.
 */
export const judgeGpusByDefault = (n: number): number => Math.ceil(n / 2);
