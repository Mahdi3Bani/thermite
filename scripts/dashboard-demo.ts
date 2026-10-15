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
g3.ev(20, "run_created", "format-port-1", {
  campaign: "format-port",
  version: 1,
  mode: "goal",
  seed: { repo: "inference-engine", commit: "0a1b2c3d4e5f" },
});
for (let i = 0; i < 22; i++) {
  const t = 19 - i * 0.8;
  const id = `a-fp-${(i + 1).toString().padStart(3, "0")}`;
  g3.ev(
    t,
    "attempt_recorded",
    id,
    {
      run: "format-port-1",
      lane: `lane-${(i % 2) + 1}`,
      lifecycle: "queued",
      hypothesis: pick([
        "declare the new type traits",
        "CPU dequantize for the new types",
        "GET_ROWS kernel for the new types",
        "a fused kernel for the new types",
        "fp32 reference path behind an env switch",
        "a prepass for small inputs",
      ]),
    },
    "agent",
  );
  g3.ev(t - 0.4, "verdict", id, {
    verdict: pick(["goal_progress", "goal_screened", "invalid", "neutral", "invalid"]),
    delta: null,
  });
  g3.ev(t - 0.41, "attempt_lifecycle", id, { lifecycle: "judged" });
  g3.ev(t - 0.05, "trial_finished", "format-port-1", {
    attempt: id,
    tokens_in: 30000,
    tokens_out: 9000,
    stopped: "submitted",
  });
  if (i % 2 === 0)
    g3.ev(t + 0.1, "epoch_started", "format-port-1", { planner_valid: true, source: "planner" });
}
g3.ev(1.2, "goal_report", "format-port-1", {
  goals: [
    { goal: "build", status: "met", reasons: "verifier build passed on info" },
    { goal: "goldens", status: "met", reasons: "verifier goldens passed on goldens" },
    { goal: "real-file", status: "met", reasons: "verifier real-file passed on realfile" },
    {
      goal: "ops",
      status: "unmet",
      reasons:
        "ops: invalid: case 7 of 40: error 1.2e-02 exceeds 5e-03",
    },
    {
      goal: "load",
      status: "unmet",
      reasons: "load: invalid: no coverage line for the new kernel",
    },
    { goal: "numerics", status: "not_runnable", reasons: "the fast path is not built yet" },
    {
      goal: "sane",
      status: "unmet",
      reasons: "quality: invalid: quality score 0.91 is below 0.95",
    },
    {
      goal: "native",
      status: "unmet",
      reasons: "native: invalid: throughput 3.4 items/s is below 15.0",
    },
    {
      goal: "reference-unchanged",
      status: "met",
      reasons: "verifier reference-unchanged passed on reference",
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

const report = (u: Rig, jobs: Record<string, number>, lastSeenHoursAgo = 0) => {
  store.ingest({
    rig: u.id,
    ledger_id: `ledger-${u.id}`,
    cursor: 0,
    next: u.events.length,
    events: u.events,
    summary: { jobs },
    generated_at: iso(lastSeenHoursAgo),
  });
};
report(g1, { queued: 1, leased: 1, done: 214 });
report(g2, { queued: 0, leased: 1, done: 162 });
report(g3, { queued: 2, leased: 1, done: 88 });
report(c1, { done: 0 });
report(g4, {});
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
      run: "format-port-1",
      directives: [
        {
          kind: "try",
          family: "fused-kernel",
          rationale: "the probe's decode is fastest",
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
