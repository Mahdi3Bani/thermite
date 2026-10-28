import type { ControlStore } from "../../src/control/store.ts";
import { iso, type Rig } from "./shared.ts";

// Synthetic hardware, shaped like what a harness reports (no real host data).
const card = (role: "judge" | "dev" | "shared", n: number) => ({
  role,
  name: "NVIDIA L4",
  uuid: `GPU-${String(n).repeat(8)}-0000-0000-0000-000000000000`,
  bus: `00000000:0${n}:00.0`,
  memory_mib: 23034,
  driver: "550.00.00",
  cuda: "12.4",
  power_limit_w: 72,
  max_sm_mhz: 2040,
  max_mem_mhz: 6251,
  pcie: "gen4 x16",
  vbios: "95.04.00.00.01",
});
const hardware = (devices: ReturnType<typeof card>[], cpus: number, mib: number) => ({
  collected_at: iso(6),
  target: devices.length
    ? { type: "cuda-gpu", class: "l4-24g", id: devices[0]?.uuid ?? "" }
    : { type: "cpu", class: "generic-cpu", id: "cpu" },
  device_mode: devices.length > 1 ? "dedicated" : devices.length ? "shared" : "none",
  devices,
  cpu: { model: "Example EPYC CPU @ 2.45GHz", host: 64, usable: 64, quota: cpus },
  memory: { host_mib: 515_000, limit_mib: mib },
  disks: [
    { name: "state", total_gib: 200, free_gib: 143.5 },
    { name: "scratch", total_gib: 100, free_gib: 81.2 },
  ],
  os: { kernel: "6.8.0-generic", arch: "x64", node: "v22.15.0", image: "sha256:0123456789abcdef" },
  toolchain: {
    cc: "cc (Debian 12.2.0) 12.2.0",
    nvcc: devices.length ? "Build cuda_12.4.r12.4" : null,
  },
  errors: [],
});

/** Each rig's report to control (its events, jobs and hardware), and its supervisor's state. */
export function reportRigs(
  store: ControlStore,
  { g1, g2, g3, c1, g4 }: { g1: Rig; g2: Rig; g3: Rig; c1: Rig; g4: Rig },
): void {
  const report = (u: Rig, jobs: Record<string, number>, hw: unknown, lastSeenHoursAgo = 0) => {
    store.rigEvents.ingest({
      rig: u.id,
      ledger_id: `ledger-${u.id}`,
      cursor: 0,
      next: u.events.length,
      events: u.events,
      summary: { jobs, hardware: hw },
      generated_at: iso(lastSeenHoursAgo),
    });
  };
  report(g1, { queued: 1, leased: 1, done: 214 }, hardware([card("shared", 1)], 6, 16_384));
  report(g2, { queued: 0, leased: 1, done: 162 }, hardware([card("shared", 2)], 8, 24_576));
  report(
    g3,
    { queued: 2, leased: 1, done: 88 },
    hardware([card("judge", 3), card("dev", 4)], 12, 32_768),
  );
  report(c1, { done: 0 }, hardware([], 8, 16_384));
  report(g4, {}, hardware([card("judge", 5), card("dev", 6)], 16, 65_536));
  store.db.prepare("update rig set last_seen = ? where id = ?").run(iso(2.3), "gpu-4");
  for (const [u, usd] of [
    ["gpu-1", 4.2],
    ["gpu-2", 3.1],
    ["gpu-3", 6.8],
  ] as const) {
    store.reportedRigs.setSupervisor(u, {
      export: { exports: 31, remote: true, last_push_at: iso(0.4) },
      advisors: {
        teacher_runs: 28,
        directive_sets: 9,
        audits: 2,
        reviews: 0,
        errors: 0,
        usd,
        // What the rig's advisors file sets up: Edit rig's empty Model choices name it.
        file: {
          teachers: [
            {
              harness: "pi",
              model: "glm-5.1",
              provider: null,
              api: "openai",
              context_window: 204_800,
              compact_at: null,
            },
          ],
          merged_by: null,
          auditor: {
            harness: "pi",
            model: "glm-5.1",
            provider: null,
            api: "openai",
            context_window: 204_800,
            compact_at: null,
          },
          review_panel: [],
        },
      },
    });
  }
  store.reportedRigs.setSupervisor("cpu-1", { export: { exports: 10, remote: false } });
}
