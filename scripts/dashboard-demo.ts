// A local demo of the control dashboard with synthetic data: four rigs, a hill climb on two of
// them (promotions, a pending approval, an audit hold, a cross-verified champion), a goal
// campaign part way, a research campaign, and a stale rig. For working on the dashboard only.
//
//   node --experimental-strip-types scripts/dashboard-demo.ts [--port 8810]
//   then open http://127.0.0.1:8810/ui and sign in with the token it prints.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createControlApi } from "../src/control/api.ts";
import { issueCommand } from "../src/control/issue.ts";
import { ControlStore, type IngestReport } from "../src/control/store.ts";
import { generateSigningKeys } from "../src/core/commands.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8810" } } });
const now = Date.now();
let seed = 42;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

type Ev = IngestReport["events"][number];
class Rig {
  events: Ev[] = [];
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  ev(
    hoursAgo: number,
    kind: string,
    subject: string | null,
    body: Record<string, unknown>,
    actor = "harness",
  ) {
    this.events.push({ id: this.events.length + 1, at: iso(hoursAgo), actor, kind, subject, body });
  }
}

const HYPOTHESES = [
  "fuse the dequantize into the GEMV inner loop",
  "split K across two warps to hide load latency",
  "keep the activation vector in shared memory",
  "unroll the 4-row tile by 2",
  "vectorize the scale loads (half2)",
  "prefetch the next block while reducing",
  "drop the redundant bounds check in the hot loop",
  "use a wider memory transaction for the codes",
  "reorder the reduction to avoid bank conflicts",
  "precompute the per-group zero point",
];
const VERDICTS = [
  "neutral",
  "neutral",
  "neutral",
  "regress",
  "invalid",
  "rejected_v0",
  "inconclusive",
  "crash_candidate",
];

function hillClimb(
  u: Rig,
  run: string,
  hours: number,
  wins: number[],
  opts: { pending?: boolean; held?: boolean } = {},
) {
  u.ev(hours, "run_created", run, {
    campaign: "decode-speed",
    version: 1,
    mode: "hill_climb",
    seed: { repo: "inference-engine", commit: "a1b2c3d4e5f6" },
  });
  u.ev(hours - 0.2, "calibration", run, {
    sigma: 0.0042 + rnd() * 0.004,
    summary: "A/A over 6 blocks",
  });
  let seq = 1;
  let n = 0;
  const total = 48;
  for (let i = 0; i < total; i++) {
    const t = hours - 0.5 - (i * (hours - 1)) / total;
    const id = `a-${run}-${(i + 1).toString().padStart(3, "0")}`;
    const lane = `lane-${(i % 2) + 1}`;
    u.ev(
      t,
      "attempt_recorded",
      id,
      { run, lane, lifecycle: "queued", hypothesis: pick(HYPOTHESES) },
      "agent",
    );
    if (i % 3 === 0)
      u.ev(t + 0.05, "epoch_started", run, {
        planner_valid: rnd() > 0.1,
        source: rnd() > 0.92 ? "fallback" : "planner",
        raw_violations: rnd() > 0.85 ? 1 : 0,
        assignments: [
          { lane: "lane-1", family: "smem-activations", parent: "champion" },
          { lane: "lane-2", family: "split-k", parent: "champion" },
        ],
      });
    u.ev(t - 0.02, "trial_finished", run, {
      attempt: id,
      tokens_in: 9000 + Math.floor(rnd() * 20000),
      tokens_out: 2000 + Math.floor(rnd() * 6000),
      stopped: "submitted",
    });
    const win = wins[n];
    if (win !== undefined && i === Math.floor(((n + 1) * total) / (wins.length + 1))) {
      n++;
      u.ev(t - 0.3, "verdict", id, { verdict: "win_confirmed", delta: win });
      if (opts.held && n === wins.length) {
        u.ev(t - 0.31, "attempt_lifecycle", id, { lifecycle: "awaiting_audit" });
        u.ev(t - 0.31, "audit_requested", id, {
          run,
          reason: `gain ${(win * 100).toFixed(1)}% above the 15% trigger`,
        });
        continue;
      }
      if (opts.pending && n === wins.length) {
        u.ev(t - 0.31, "attempt_lifecycle", id, { lifecycle: "awaiting_approval" });
        u.ev(t - 0.31, "promotion_pending", id, { run });
        continue;
      }
      seq++;
      u.ev(t - 0.32, "attempt_lifecycle", id, { lifecycle: "promoted" });
      u.ev(t - 0.32, "champion_promoted", run, {
        seq,
        attempt: id,
        commit: `c${seq}${"0".repeat(10)}`,
      });
      u.ev(t - 0.33, "champion_published", run, {
        seq,
        repo: "inference-engine",
        base_commit: "a1b2c3d4e5f6",
        tree: `tree-${run}-${seq}`,
        sha256: "0".repeat(64),
        path: `champions/${run}/${seq}.patch`,
      });
      continue;
    }
    const v = pick(VERDICTS);
    u.ev(t - 0.25, "verdict", id, {
      verdict: v,
      delta: v === "neutral" ? (rnd() - 0.5) * 0.01 : v === "regress" ? -0.02 - rnd() * 0.05 : null,
    });
    u.ev(t - 0.26, "attempt_lifecycle", id, { lifecycle: "judged" });
  }
  // Two attempts still being judged.
  u.ev(
    0.3,
    "attempt_recorded",
    `a-${run}-live1`,
    { run, lane: "lane-1", lifecycle: "queued", hypothesis: "tile the scale reads per warp" },
    "agent",
  );
  u.ev(
    0.1,
    "attempt_recorded",
    `a-${run}-live2`,
    {
      run,
      lane: "lane-2",
      lifecycle: "queued",
      hypothesis: "use the read-only cache for the codes",
    },
    "agent",
  );
  u.ev(hours - 1, "directive", run, { kind: "try" }, "supervisor");
  u.ev(hours - 3, "directive", run, { kind: "avoid" }, "supervisor");
}

const store = new ControlStore(join(mkdtempSync(join(tmpdir(), "thermite-demo-")), "control.db"));
const rigs = ["gpu-1", "gpu-2", "gpu-3", "cpu-1", "gpu-4"];
store.setConfiguredRigs(rigs);

const g1 = new Rig("gpu-1");
hillClimb(g1, "decode-a", 30, [0.061, 0.043, 0.038, 0.052, 0.024, 0.19], { held: true });
// The two trials Live shows at work (T1 and T2 below): control counts lanes at work from these.
g1.ev(9 / 60, "trial_started", "decode-a", {
  lane: "lane-1",
  trial: "t-4f1c9a2e7b3d5c01",
  family: "smem-activations",
  focus: "keep the activation vector in shared memory",
});
g1.ev(3 / 60, "trial_started", "decode-a", {
  lane: "lane-2",
  trial: "t-9b2e6d4a1c8f3e77",
  family: "split-k",
  focus: "split K across two warps to hide load latency",
});
// decode-a's experiment queue: tried, in progress, up next and a lane's idea.
const experiment = (
  hoursAgo: number,
  id: string,
  by: string,
  family: string,
  title: string,
  why: string,
  state: "queued" | "proposed" = "queued",
) =>
  g1.ev(
    hoursAgo,
    "experiment_added",
    "decode-a",
    { id, by, family, title, why, state, position: "end" },
    by,
  );
experiment(
  10,
  "x-01",
  "planner",
  "tiling",
  "unroll the 4-row tile by 2",
  "the 4-row tile left registers free",
);
g1.ev(9.6, "experiment_assigned", "decode-a", { id: "x-01", lane: "lane-1", trial: "t-1a2b3c4d" });
g1.ev(9, "experiment_finished", "decode-a", {
  id: "x-01",
  lane: "lane-1",
  attempt: "a-decode-a-035",
});
experiment(
  8,
  "x-02",
  "owner",
  "zero-point",
  "precompute the per-group zero point",
  "it might save a subtract per element",
);
g1.ev(
  7.5,
  "experiment_dropped",
  "decode-a",
  { id: "x-02", by: "owner", why: "measured slower twice in earlier runs" },
  "owner",
);
experiment(
  3,
  "x-03",
  "teacher-pair",
  "smem-activations",
  "keep the activation vector in shared memory",
  "every row tile reads the same vector from global memory",
);
experiment(
  2,
  "x-04",
  "planner",
  "split-k",
  "split K across two warps to hide load latency",
  "lane-2's last change showed the loads stall",
);
experiment(
  1.5,
  "x-05",
  "owner",
  "vector-loads",
  "vectorize the scale loads (half2)",
  "the profile shows scalar loads in the hot loop",
);
experiment(
  1.2,
  "x-06",
  "planner",
  "prefetch",
  "prefetch the next block while reducing",
  "the reduction leaves the memory unit idle",
);
experiment(
  0.8,
  "x-07",
  "auditor",
  "check",
  "re-measure the held change on the large cases",
  "its gain on large inputs is far above the other cases",
);
experiment(
  0.3,
  "x-08",
  "lane-2",
  "memory",
  "use a wider memory transaction for the codes",
  "the codes are read 4 bytes at a time",
  "proposed",
);
g1.ev(9 / 60, "experiment_assigned", "decode-a", {
  id: "x-03",
  lane: "lane-1",
  trial: "t-4f1c9a2e7b3d5c01",
});
g1.ev(3 / 60, "experiment_assigned", "decode-a", {
  id: "x-04",
  lane: "lane-2",
  trial: "t-9b2e6d4a1c8f3e77",
});
g1.ev(
  9 / 60,
  "planner_handout",
  "decode-a",
  {
    round: 17,
    assignments: [
      { lane: "lane-1", experiment: "x-03", why: "builds on lane-1's last direction" },
      { lane: "lane-2", experiment: "x-04", why: "next in the queue; no lane is on it" },
    ],
    notes: "",
  },
  "planner",
);
// decode-a's journal: the agents' field notes (goal 065).
const note = (hoursAgo: number, id: number, by: string, body: Record<string, unknown>) =>
  g1.ev(hoursAgo, "journal_note", "decode-a", { id, by, ...body }, by);
note(9.2, 1, "lane-1", {
  kind: "observation",
  text: "Unrolling past 2 stops paying here: the loop waits on memory reads, not on instructions.",
  about: { type: "attempt", id: "a-decode-a-035" },
  lane: "lane-1",
});
note(5, 2, "planner", {
  kind: "decision",
  text: "Kept lane-1 on shared memory: it has that kernel in its context from its last trial.",
  about: { type: "round", id: "15" },
});
note(4.4, 3, "lane-2", {
  kind: "surprise",
  text: "A 19% gain from one change is far above anything before it on the large cases.",
  about: { type: "attempt", id: "a-decode-a-042" },
  lane: "lane-2",
});
note(4.3, 4, "auditor:auditor-a", {
  kind: "question",
  text: "Does the large case reuse the same input on every call? If so, the gain may be the cache.",
});
note(1, 5, "teachers:teacher-a", {
  kind: "lesson",
  text: "A gain far above the rig's noise needs a fresh input on every call before it can count.",
});
const g2 = new Rig("gpu-2");
hillClimb(g2, "decode-b", 26, [0.048, 0.031, 0.027, 0.036], { pending: true });
g2.ev(5, "propagation_received", "decode-b", {
  attempt: "a-prop-1",
  source_rig: "gpu-1",
  source_run: "decode-a",
  source_seq: 5,
  tree: "tree-decode-a-5",
  result: "judging",
});
g2.ev(4.5, "propagation_accepted", "decode-b", { attempt: "a-prop-1", verdict: "win_confirmed" });

const g3 = new Rig("gpu-3");
g3.ev(20, "run_created", "regex-dfa-1", {
  campaign: "regex-dfa",
  version: 1,
  mode: "goal",
  seed: { repo: "text-search", commit: "0a1b2c3d4e5f" },
});
for (let i = 0; i < 22; i++) {
  const t = 19 - i * 0.8;
  const id = `a-rx-${(i + 1).toString().padStart(3, "0")}`;
  g3.ev(
    t,
    "attempt_recorded",
    id,
    {
      run: "regex-dfa-1",
      lane: `lane-${(i % 2) + 1}`,
      lifecycle: "queued",
      hypothesis: pick([
        "a lazy DFA that caches up to 4096 states",
        "a SIMD prefilter for literal prefixes",
        "Unicode classes compiled to byte ranges",
        "a one-pass NFA for anchored patterns",
        "bounded backtracking for short inputs",
        "a memchr fast path for single-byte literals",
      ]),
    },
    "agent",
  );
  g3.ev(t - 0.4, "verdict", id, {
    verdict: pick(["goal_progress", "goal_screened", "invalid", "neutral", "invalid"]),
    delta: null,
  });
  g3.ev(t - 0.41, "attempt_lifecycle", id, { lifecycle: "judged" });
  g3.ev(t - 0.05, "trial_finished", "regex-dfa-1", {
    attempt: id,
    tokens_in: 30000,
    tokens_out: 9000,
    stopped: "submitted",
  });
  if (i % 2 === 0)
    g3.ev(t + 0.1, "epoch_started", "regex-dfa-1", { planner_valid: true, source: "planner" });
}
g3.ev(1.2, "goal_report", "regex-dfa-1", {
  goals: [
    { goal: "builds", status: "met", reasons: "verifier builds passed on info" },
    { goal: "conformance", status: "met", reasons: "verifier conformance passed on suite-a" },
    { goal: "unicode", status: "met", reasons: "verifier unicode passed on ucd-cases" },
    {
      goal: "same-matches",
      status: "unmet",
      reasons:
        "corpus-a: invalid: 3 of 1200 patterns match differently from the backtracking engine",
    },
    {
      goal: "memory",
      status: "unmet",
      reasons: "memory: invalid: the DFA for pattern set B needs 412 MiB, above 256 MiB",
    },
    { goal: "streaming", status: "not_runnable", reasons: "the streaming API is not built yet" },
    {
      goal: "throughput",
      status: "unmet",
      reasons: "corpus-b: invalid: 1.8 GB/s is below 2.5 GB/s",
    },
    {
      goal: "latency",
      status: "unmet",
      reasons: "latency: invalid: p99 match latency 3.1 ms is above 1.0 ms",
    },
    {
      goal: "api-unchanged",
      status: "met",
      reasons: "verifier api-unchanged passed on public-headers",
    },
  ],
});

const c1 = new Rig("cpu-1");
c1.ev(11, "run_created", "noise-survey", {
  campaign: "benchmark-noise",
  version: 1,
  mode: "research",
  seed: { repo: "research-notes", commit: "" },
});
for (let i = 0; i < 18; i++)
  c1.ev(10.5 - i * 0.55, "trial_finished", "noise-survey", {
    tokens_in: 18000,
    tokens_out: 3500,
    stopped: "done",
  });
c1.ev(0.4, "research_digest", "noise-survey", {
  elapsed_ms: 9.4 * 3_600_000,
  min_ms: 24 * 3_600_000,
  sources: 38,
  domains: 14,
  verified: 112,
  drafts: 9,
  hypotheses: 6,
  unsupported_numbers: 2,
  questions: [
    { q: "What makes a benchmark representative and repeatable?", verified: 41 },
    { q: "How are differences between measurements tested for significance?", verified: 37 },
    { q: "Which sources of run-to-run noise dominate on GPUs?", verified: 22 },
    { q: "How many repetitions are enough?", verified: 12 },
  ],
  report:
    "# Benchmark noise: digest 9\n\nFindings (verified, two or more independent domains):\n- Interleaving arms (ABAB) removes most slow drift between runs.\n- Clock and thermal state must be recorded with each result.\n- Bootstrap intervals over blocks are robust to outliers.\n",
});

const g4 = new Rig("gpu-4");

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
const report = (u: Rig, jobs: Record<string, number>, hw: unknown, lastSeenHoursAgo = 0) => {
  store.ingest({
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
  store.setSupervisor(u, {
    export: { exports: 31, remote: true, last_push_at: iso(0.4) },
    advisors: { teacher_runs: 28, directive_sets: 9, audits: 2, reviews: 0, errors: 0, usd },
  });
}
store.setSupervisor("cpu-1", { export: { exports: 10, remote: false } });

// Live sessions: the planner, the judge, two workers and the supervisor on gpu-1.
type Line = {
  source: string;
  kind: "text" | "thinking" | "tool" | "result" | "message" | "status" | "log";
  text: string;
  lane?: string;
  run?: string;
};
const lines = (rig: string, items: Line[], minutesAgo: number) => {
  let seq = 0;
  store.addLive(
    rig,
    "demo-log",
    items.map((l, n) => ({
      seq: ++seq,
      at: new Date(now - (minutesAgo - n * 0.4) * 60_000).toISOString(),
      ...l,
    })),
    true,
  );
};
const T1 = "trial:t-4f1c9a2e7b3d5c01";
const T2 = "trial:t-9b2e6d4a1c8f3e77";
lines(
  "gpu-1",
  [
    {
      source: "planner",
      kind: "status",
      text: "planning epoch 17 (2 lanes)",
      run: "decode-a",
    },
    {
      source: "planner",
      kind: "text",
      text: "epoch 17: planned by the model\nlane-1: smem-activations, keep the activation vector in shared memory\nlane-2: split-k, split K across two warps to hide load latency",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "status",
      text: "trial on lane-1: smem-activations, keep the activation vector in shared memory (from the champion, seq 6)",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "thinking",
      text: "The GEMV reads the activation vector once per row tile. Staging it in shared memory should cut global loads; I need to check the tile size against the 48 KB static limit first.",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "text",
      text: "I'll read the decode GEMV kernel first, then stage the activation vector in shared memory for each row tile.",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "tool",
      text: 'read_file {"path":"src/kernels/gemv.cu"}',
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "result",
      text: "read_file (4 ms): __global__ void gemv_rows(const block_q4 * w, const float * x, float * y, int k) {\n  const int row = blockIdx.x * ROWS + threadIdx.y;\n  ...",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "tool",
      text: 'write_file {"path":"src/kernels/gemv.cu","content":"…"}',
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "result",
      text: "write_file (2 ms): ok, 214 lines",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "tool",
      text: 'run {"command":"cmake --build build -j4 --target bench && ./build/bench --check"}',
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "result",
      text: "run (48210 ms): exit 0\n[100%] Built target bench\ncheck: 4096 rows, max abs error 0.0000, ok",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "message",
      text: "Owner: Keep the tile at 128 rows; 256 spilled registers last time.",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "text",
      text: "Understood: keeping the tile at 128 rows. I'll time it on the device before submitting.",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "tool",
      text: 'dev_run {"command":"./build/bench --cells small,large"}',
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T1,
      kind: "result",
      text: "dev_run (9120 ms): small 1.21 ms, large 3.87 ms (diagnostic only)",
      lane: "lane-1",
      run: "decode-a",
    },
    {
      source: T2,
      kind: "status",
      text: "trial on lane-2: split-k, split K across two warps to hide load latency (from the champion, seq 6)",
      lane: "lane-2",
      run: "decode-a",
    },
    {
      source: T2,
      kind: "text",
      text: "Splitting K across two warps per row; the partial sums reduce through shuffles.",
      lane: "lane-2",
      run: "decode-a",
    },
    {
      source: T2,
      kind: "tool",
      text: 'search {"pattern":"__shfl_down_sync"}',
      lane: "lane-2",
      run: "decode-a",
    },
    {
      source: T2,
      kind: "result",
      text: "search (11 ms): src/kernels/reduce.cuh:14",
      lane: "lane-2",
      run: "decode-a",
    },
    {
      source: "judge",
      kind: "log",
      text: "evaluate a-decode-a-live1: started",
      run: "decode-a",
    },
    { source: "judge", kind: "log", text: "build c6000000000: ok in 41 s", run: "decode-a" },
    { source: "judge", kind: "log", text: "candidate · small: ok", run: "decode-a" },
    { source: "judge", kind: "log", text: "champion · small: ok", run: "decode-a" },
    { source: "judge", kind: "log", text: "candidate · large: ok", run: "decode-a" },
    {
      source: "supervisor",
      kind: "status",
      text: "advisor round done: 2 teacher runs, 1 directive sets, 0 audits, 0 reviews, 0 errors",
    },
  ],
  9,
);

const keys = generateSigningKeys();
const tokens = {
  admin: "demo-admin-token-0123456789",
  rigs: Object.fromEntries(rigs.map((u) => [u, `rig-${u}-token-abcdef`])),
};
for (const [rig, kind, payload] of [
  ["gpu-1", "pause_run", { run: "decode-a", reason: "owner check" }],
  ["gpu-1", "resume_run", { run: "decode-a" }],
  ["gpu-2", "export_now", {}],
  [
    "gpu-3",
    "redirect",
    {
      run: "regex-dfa-1",
      directives: [
        {
          kind: "try",
          family: "simd-prefilter",
          rationale: "the prefilter probe skips most of the input",
          citations: [],
        },
      ],
      replace: true,
    },
  ],
] as const) {
  issueCommand(store, keys.privateKeyPem, { rig, kind, payload, issuedBy: "owner:ui" });
}
store.addReport(
  "gpu-1",
  "daily",
  "Daily report for gpu-1\n\nCampaign decode-speed (decode-a): champion seq 6, +24.1% over its baseline.\n48 attempts today: 6 wins confirmed, 1 held by audit.\nAgents: 16 epochs, 48 trials, planner valid 94%.",
);

const port = Number(values.port);
serve({
  fetch: createControlApi(store, tokens, keys.privateKeyPem, { staleAfterMs: 180_000 }).fetch,
  hostname: "127.0.0.1",
  port,
});
console.log(`dashboard demo: http://127.0.0.1:${port}/ui  (token: ${tokens.admin})`);
