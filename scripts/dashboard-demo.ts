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
import { callUsage } from "../src/core/usage.ts";

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

// The model calls draw from their own sequence, so the rest of the demo stays as it was.
let useSeed = 7;
const urnd = () => {
  useSeed = (useSeed * 1103515245 + 12345) % 2 ** 31;
  return useSeed / 2 ** 31;
};

/** One made-up model usage record: its calls, tokens, cached share (null: not reported) and times. */
function modelCall(
  u: Rig,
  hoursAgo: number,
  run: string,
  agent: string,
  harness: string,
  provider: string,
  model: string,
  calls: number,
  cached: number | null,
  trial: string | null,
) {
  const tokensIn = calls * (14_000 + Math.floor(urnd() * 16_000));
  const tokensOut = calls * (300 + Math.floor(urnd() * 900));
  u.ev(hoursAgo, "model_call", run, {
    trial,
    round: null,
    agent,
    harness,
    provider,
    model,
    ...callUsage({
      at: iso(hoursAgo),
      calls,
      tokensIn,
      cachedIn: cached === null ? null : Math.floor(tokensIn * cached),
      tokensOut,
      firstTokenMs: 900 + Math.floor(urnd() * 1500),
      callMs: Math.floor((tokensOut / (30 + urnd() * 40)) * 1000) + calls * 1200,
    }),
  });
}

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
  // A hill climb's judge measures its starting point first (goal 115), then the rig's noise.
  const ppl = { median: 1, mad: 0.0001, n: 9 };
  u.ev(hours - 0.1, "baseline", run, {
    run,
    job: 1,
    champion_seq: 1,
    commit: "a1b2c3d4e5f6",
    attempt: null,
    blocks: 3,
    runs_per_cell: 3,
    primary: { metric: "tok_per_s", direction: "max" },
    guards: [{ metric: "ppl_ratio", direction: "min", max_total_regression: 0.01 }],
    units: { tok_per_s: "tok/s", ppl_ratio: "ratio" },
    cells: {
      small: { tok_per_s: { median: 182.4, mad: 0.6, n: 9 }, ppl_ratio: ppl },
      large: { tok_per_s: { median: 61.7, mad: 0.3, n: 9 }, ppl_ratio: ppl },
    },
    files: [],
    bytes: 0,
    summary: "tok_per_s small 182 ±0.33%, large 61.7 ±0.49% (median of 3 blocks)",
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
    // Model use (goal 075): the trial's worker, a round's planner, now and then the teachers
    // (on a subscription, in Claude Code) and the auditor (OpenCode, which does not report the cache).
    modelCall(u, t - 0.03, run, "workers", "pi", "demo-models", "glm-5.1", 28, 0.75, `t-${id}`);
    if (i % 3 === 0)
      modelCall(u, t + 0.04, run, "planner", "pi", "demo-models", "kimi-k3", 1, 0.6, null);
    if (i % 8 === 4)
      modelCall(
        u,
        t - 0.1,
        run,
        "teachers",
        "claude-code",
        "claude-plan",
        "opus-5.5",
        1,
        0.9,
        null,
      );
    if (i === total - 6)
      modelCall(u, t - 0.2, run, "auditor", "opencode", "demo-models", "glm-5.1", 2, null, null);
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
  "teachers",
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

// A research campaign (goals 112, 116 and 117): its questions' answer cards, the review panel's
// item reviews and decisions, the hypotheses (the author's, the pool, promoted, merged, retired),
// research tasks with their question and yield, and the progress rule's state.
const c1 = new Rig("cpu-1");
const RS = "noise-survey";
const QUESTIONS = [
  "What makes a benchmark representative and repeatable?",
  "How are differences between measurements tested for significance?",
  "Which sources of run-to-run noise dominate on GPUs?",
  "How many repetitions are enough?",
];
c1.ev(11, "run_created", RS, {
  campaign: "benchmark-noise",
  version: 1,
  mode: "research",
  seed: { repo: "research-notes", commit: "" },
});
c1.ev(11, "run_status", RS, { status: "running", reason: null });
const hypothesis = (
  at: number,
  id: string,
  text: string,
  o: { lane?: string; question?: number; supporting?: number } = {},
) =>
  c1.ev(at, "hypothesis_added", RS, {
    hypothesis: id,
    lane: o.lane ?? null,
    text,
    supporting: Array.from({ length: o.supporting ?? 0 }, (_, i) => `c-${id.slice(2)}${i}`),
    ...(o.lane ? {} : { from: "brief" }),
    question: o.question ?? null,
    status: o.lane ? "pool" : "author",
  });
hypothesis(11, "h-a1", "Interleaving the arms (ABAB) removes most slow drift between runs.");
hypothesis(11, "h-a2", "Clock and thermal state explain most run-to-run variance on GPUs.");
hypothesis(9.2, "h-p1", "Power capping reduces variance more than it reduces throughput.", {
  lane: "lane-1",
  question: 2,
  supporting: 3,
});
hypothesis(
  8.6,
  "h-p2",
  "Bootstrap intervals over blocks hold up better than t-tests on skewed timings.",
  { lane: "lane-2", question: 1, supporting: 5 },
);
hypothesis(
  7.9,
  "h-p3",
  "Ten repetitions are enough when the coefficient of variation is under 1%.",
  { lane: "lane-1", question: 3, supporting: 2 },
);
hypothesis(7.1, "h-p4", "Background daemons cause the rare slow outliers.", {
  lane: "lane-2",
  question: 2,
  supporting: 1,
});
hypothesis(6.4, "h-p5", "A block bootstrap beats a t-test for skewed timings.", {
  lane: "lane-1",
  question: 1,
  supporting: 2,
});
hypothesis(5.8, "h-p6", "Warm-up runs remove the first-run outlier on every GPU tested.", {
  lane: "lane-2",
  question: 0,
  supporting: 4,
});
c1.ev(6.3, "hypothesis_merged", RS, {
  hypothesis: "h-p5",
  into: "h-p2",
  lane: "lane-1",
  text: "Block bootstrap intervals hold up better than t-tests on skewed timings.",
  question: 1,
  supporting: ["c-p50", "c-p51"],
});
c1.ev(
  5.1,
  "hypothesis_status",
  RS,
  {
    hypothesis: "h-p2",
    status: "promoted",
    by: "control:owner:ui",
    reason: "Question 2 turns on it: the review panel should give it a verdict.",
  },
  "control:owner:ui",
);
c1.ev(
  3.4,
  "hypothesis_status",
  RS,
  {
    hypothesis: "h-p4",
    status: "retired",
    by: "control:owner:ui",
    reason: "Out of scope: the rigs run no background daemons.",
  },
  "control:owner:ui",
);
// Research tasks: each names one question; a finished one keeps its yield.
const TASKS: [number, string, string, number, number][] = [
  [0, "explore", "survey benchmark methodology guides", 9, 4],
  [1, "primary", "find the primary sources for block bootstrap intervals", 7, 3],
  [2, "explore", "map the sources of GPU clock and thermal noise", 6, 3],
  [3, "explore", "find guidance on repetition counts", 4, 2],
  [0, "contradict", "look for sources that disagree on interleaving", 3, 1],
  [1, "explore", "compare significance tests used in benchmark suites", 5, 2],
  [2, "primary", "find vendor documents on boost clocks", 2, 1],
  [2, "contradict", "look for sources that disagree on thermal effects", 1, 0],
  [3, "primary", "find primary sources on stopping rules", 2, 1],
  [2, "explore", "look for studies of power capping and variance", 0, 0],
  [1, "consolidate", "consolidate the claims on significance tests", 3, 0],
  [2, "explore", "search for measurements of driver-induced jitter", 0, 0],
];
TASKS.forEach(([q, family, title, verified, fresh], n) => {
  const id = `x-${String(n + 1).padStart(3, "0")}`;
  const at = 10.5 - n * 0.8;
  const full = `Question ${q + 1} (index ${q}): ${title}`;
  c1.ev(at, "experiment_added", RS, {
    id,
    title: full,
    family,
    why: "the research plan: the question's open gaps",
    question: q,
    by: "planner",
    state: "queued",
  });
  c1.ev(at - 0.02, "experiment_assigned", RS, {
    id,
    lane: `lane-${(n % 2) + 1}`,
    trial: `t-r${n + 1}`,
  });
  c1.ev(at - 0.7, "experiment_finished", RS, {
    id,
    lane: `lane-${(n % 2) + 1}`,
    trial: `t-r${n + 1}`,
    result: "finished",
    yield: {
      verified_claims: verified,
      by_question: verified
        ? [{ question: q, verified_claims: verified, new_domain_claims: fresh }]
        : [],
      no_question: 0,
      new_domains: fresh,
      domains: [],
      findings: n % 4 === 0 ? 1 : 0,
      card_changes: verified ? 1 : 0,
    },
  });
  c1.ev(at - 0.7, "trial_finished", RS, { tokens_in: 18000, tokens_out: 3500, stopped: "done" });
});
for (const [n, q, title] of [
  [13, 1, "look for sources that disagree on bootstrap intervals"],
  [14, 0, "find primary sources on warm-up runs"],
] as const)
  c1.ev(0.3, "experiment_added", RS, {
    id: `x-${String(n).padStart(3, "0")}`,
    title: `Question ${q + 1} (index ${q}): ${title}`,
    family: n === 13 ? "contradict" : "primary",
    why: "the research plan: the question's open gaps",
    question: q,
    by: "planner",
    state: "queued",
  });
// Each question's answer card, as the synthesizer wrote it and the harness kept it.
const answerCard = (
  at: number,
  question: number,
  version: number,
  certainty: string,
  answer: string,
  gaps: { kind: string; text: string }[],
  claims: number,
) =>
  c1.ev(at, "card_written", RS, {
    question,
    version,
    certainty,
    claims,
    gaps: gaps.length,
    by: "teacher-1",
    through: `c-q${question}v${version}`,
    answer,
    cited: Array.from({ length: claims }, (_, i) => `c-q${question}${i}`),
    gap_list: gaps,
  });
answerCard(
  5.2,
  0,
  1,
  "moderate",
  "A benchmark is representative when its inputs and sizes match the workload it stands for, and repeatable when the same build, inputs and machine state give the same result within its noise.",
  [{ kind: "evidence", text: "A second site that names the machine state to record." }],
  6,
);
answerCard(
  2.6,
  0,
  2,
  "high",
  "A benchmark is representative when its inputs, sizes and access patterns match the workload it stands for, and repeatable when the same build, inputs and recorded machine state (clocks, temperature, driver) give the same result within its measured noise. Three independent guides agree on recording the machine state with each result, and on warm-up runs before measuring.",
  [],
  9,
);
answerCard(
  2.4,
  1,
  3,
  "moderate",
  "Differences are tested on blocks of interleaved runs. Bootstrap intervals over blocks are robust to the skewed timings that benchmarks produce; a t-test on single runs is not. Two sites agree; a third uses the Mann-Whitney test.",
  [
    {
      kind: "evidence",
      text: "A primary source that compares block bootstrap with Mann-Whitney on timings.",
    },
  ],
  7,
);
answerCard(
  1.2,
  2,
  3,
  "low",
  "Clock boost and thermal throttling are the noise sources most sources name on GPUs; driver jitter and background work are named less often, and the sources disagree on their size.",
  [
    { kind: "evidence", text: "A vendor document on how boost clocks vary between runs." },
    { kind: "evidence", text: "A study that measures driver-induced jitter apart from clocks." },
    {
      kind: "measurement",
      text: "Measure the variance with clocks locked against boost on the rig's GPU: a hill-climb run's A/A check.",
    },
  ],
  5,
);
answerCard(
  4.6,
  3,
  1,
  "insufficient",
  "Sources give stopping rules (repeat until the interval is narrower than the effect sought) rather than one number. How many repetitions a given rig needs depends on its own noise, which only a measurement shows.",
  [
    {
      kind: "measurement",
      text: "Measure the rig's noise (an A/A run) and derive the repetitions from it.",
    },
  ],
  4,
);
c1.ev(1.0, "card_refused", RS, {
  question: 1,
  by: "teacher-1",
  count: 1,
  problems: ["the number 30 is not in the claims it cites"],
});
// The owner's message to the review panel, and its answer.
c1.ev(2.5, "agent_message", RS, {
  id: 7,
  to: "panel",
  text: "Judge question 4 against what sources can say: how many repetitions a rig needs is a next experiment.",
});
// Reviews: each asked, each reviewer's answers per item, the decision on each item.
const review = (
  n: number,
  asked: number,
  claims: number,
  posted: number | null,
  answers: Record<string, [string, string | null][]>,
  decided: [string, string, string, string | null, number | null, number | null][],
  result: string,
) => {
  c1.ev(asked, "review_requested", RS, {
    review: n,
    goal: "research",
    commit: `corpus:${claims}:0:c-${n}`,
    questions: 4,
    hypotheses: n === 1 ? 2 : 3,
    verified_claims: claims,
  });
  if (posted === null) return;
  for (const [reviewer, verdicts] of Object.entries(answers))
    c1.ev(posted + 0.02, "review_items", RS, {
      review: n,
      reviewer,
      items: decided.map(([kind, key, , , , version], i) => ({
        kind,
        key: kind === "question" ? Number(key) : key,
        card_version: version,
        verdict: verdicts[i]?.[0] ?? "open",
        certainty: verdicts[i]?.[1] ?? null,
        reasons:
          verdicts[i]?.[0] === "open"
            ? "The card names its gap itself: no source yet measures driver jitter apart from clocks."
            : "The cited claims answer it directly, from independent sites.",
        claims: [`c-${key}1`, `c-${key}2`],
        problems:
          reviewer === "reviewer-3" && i === 1 && n === 1
            ? ["the number 12 is not in the claims it cites"]
            : [],
      })),
    });
  for (const [kind, key, decision, certainty, dissent, version] of decided)
    c1.ev(posted + 0.01, "item_decided", RS, {
      review: n,
      kind,
      key: kind === "question" ? Number(key) : key,
      card_version: version,
      decision,
      certainty,
      dissent:
        dissent === null
          ? []
          : [
              {
                reviewer: `reviewer-${dissent}`,
                verdict: kind === "question" ? "open" : "undecided",
                certainty: null,
                reasons: "One site only: I would wait for a second.",
              },
            ],
    });
  c1.ev(posted, "review_panel", RS, {
    review: n,
    goal: "research",
    result,
    reviewers: Object.keys(answers).length,
    decided: decided.filter(([, , d]) => d !== "open" && d !== "undecided").length,
    open: decided.filter(([, , d]) => d === "open" || d === "undecided").length,
  });
};
review(
  1,
  4.5,
  64,
  4.2,
  {
    "reviewer-1": [
      ["answered", "moderate"],
      ["open", null],
      ["open", null],
      ["open", null],
      ["supported", null],
      ["undecided", null],
    ],
    "reviewer-2": [
      ["answered", "moderate"],
      ["open", null],
      ["open", null],
      ["open", null],
      ["supported", null],
      ["undecided", null],
    ],
    "reviewer-3": [
      ["answered", "low"],
      ["answered", "low"],
      ["open", null],
      ["open", null],
      ["supported", null],
      ["undecided", null],
    ],
  },
  [
    ["question", "0", "answered", "moderate", null, 1],
    ["question", "1", "open", null, 3, 1],
    ["question", "2", "open", null, null, 1],
    ["question", "3", "open", null, null, 1],
    ["hypothesis", "h-a1", "supported", null, null, null],
    ["hypothesis", "h-a2", "undecided", null, null, null],
  ],
  "review_failed",
);
review(
  2,
  2.2,
  97,
  1.9,
  {
    "reviewer-1": [
      ["answered", "high"],
      ["answered", "moderate"],
      ["open", null],
      ["insufficient", null],
      ["supported", null],
      ["undecided", null],
      ["supported", null],
    ],
    "reviewer-2": [
      ["answered", "high"],
      ["answered", "moderate"],
      ["open", null],
      ["insufficient", null],
      ["supported", null],
      ["supported", null],
      ["supported", null],
    ],
    "reviewer-3": [
      ["answered", "high"],
      ["open", null],
      ["open", null],
      ["insufficient", null],
      ["supported", null],
      ["undecided", null],
      ["supported", null],
    ],
  },
  [
    ["question", "0", "answered", "high", null, 2],
    ["question", "1", "answered", "moderate", 3, 3],
    ["question", "2", "open", null, null, 2],
    ["question", "3", "insufficient", null, null, 1],
    ["hypothesis", "h-a1", "supported", null, null, null],
    ["hypothesis", "h-a2", "undecided", null, 2, null],
    ["hypothesis", "h-p2", "supported", null, null, null],
  ],
  "review_failed",
);
c1.ev(1.88, "agent_message_read", RS, { message: 7, by: "panel" });
c1.ev(
  1.88,
  "advisor_answer",
  RS,
  {
    message: 7,
    role: "panel",
    advisor: "reviewer-1",
    text: "Understood: question 4 is the best available, insufficient; the repetitions a rig needs are a next experiment.",
  },
  "supervisor",
);
review(3, 0.6, 112, null, {}, [], "");
// Review 3's tries that could not be posted, as the harness keeps them (goal 116).
c1.ev(0.54, "review_try_failed", RS, {
  review: 3,
  try: 1,
  error:
    "2 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429 too many requests)",
});
c1.ev(0.05, "review_try_failed", RS, {
  review: 3,
  try: 2,
  error:
    "1 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429 too many requests; reviewer-3: no answer in 15 min)",
});
for (const [h, run, calls] of [
  [4.3, "review 1", 3],
  [2.0, "review 2", 3],
  [0.5, "review 3", 2],
] as const)
  for (const reviewer of ["reviewer-1", "reviewer-2", "reviewer-3"].slice(0, calls)) {
    const tokensIn = 60_000 + Math.floor(urnd() * 30_000);
    const tokensOut = 2_000 + Math.floor(urnd() * 1_500);
    c1.ev(h, "model_call", RS, {
      trial: null,
      round: run,
      agent: "panel",
      harness: "pi",
      provider: "demo-models",
      model: reviewer === "reviewer-3" ? "kimi-k3" : "glm-5.1",
      ...callUsage({
        at: iso(h),
        calls: 6,
        tokensIn,
        cachedIn: Math.floor(tokensIn * 0.6),
        tokensOut,
        firstTokenMs: 1200,
        callMs: 95_000 + Math.floor(urnd() * 60_000),
      }),
    });
  }
c1.ev(0.4, "research_progress", RS, {
  open: [2],
  saturated: [2],
  last_improvement: iso(1.9),
  since_ms: 1.9 * 3_600_000,
  needed_ms: 2.75 * 3_600_000,
});
c1.ev(0.4, "research_digest", RS, {
  elapsed_ms: 11 * 3_600_000,
  min_ms: 6 * 3_600_000,
  sources: 38,
  domains: 14,
  verified: 112,
  drafts: 9,
  hypotheses: 6,
  unsupported_numbers: 2,
  questions: QUESTIONS.map((question, i) => ({ question, verified: [41, 37, 22, 12][i] })),
  report:
    "# Benchmark noise: digest 9\n\nFindings (verified, two or more independent domains):\n- Interleaving arms (ABAB) removes most slow drift between runs.\n- Clock and thermal state must be recorded with each result.\n- Bootstrap intervals over blocks are robust to outliers.\n",
});
// The rig reports its events in the order they happened.
c1.events.sort((a, b) => a.at.localeCompare(b.at));
c1.events.forEach((e, i) => {
  e.id = i + 1;
});
const g4 = new Rig("gpu-4");
// An earlier run of the research campaign, closed by its owner, whose one review came from a
// harness before item reviews (goal 112): each question's count of reviewers, and the gaps.
g4.ev(40, "run_created", "noise-pilot", {
  campaign: "benchmark-noise",
  version: 1,
  mode: "research",
  seed: { repo: "research-notes", commit: "" },
});
g4.ev(40, "run_status", "noise-pilot", { status: "running", reason: null });
g4.ev(31, "review_requested", "noise-pilot", {
  review: 1,
  goal: "research",
  commit: "corpus:31:0:c-1",
  questions: 4,
  hypotheses: 2,
  verified_claims: 31,
});
g4.ev(30.6, "review_panel", "noise-pilot", {
  review: 1,
  goal: "research",
  result: "review_failed",
  reviewers: 3,
  questions: [
    { question: 0, answered_by: 2, answer: "Record the machine state with each result." },
    { question: 1, answered_by: 0 },
    { question: 2, answered_by: 1, answer: "Boost clocks and temperature." },
    { question: 3, answered_by: 0 },
  ],
  gaps: [
    "Question 2: missing: a primary source on significance tests for timings",
    "Question 4: missing: any source on repetition counts",
  ],
});
g4.ev(30, "run_status", "noise-pilot", {
  status: "closed",
  reason: "closed by the owner: the brief changed",
});

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
// The supervisor's lines for the research run's reviews (goal 116): each reviewer's answer, and a
// third review whose tries failed on the provider, which the Reviews tab shows from Live.
store.addLive(
  "cpu-1",
  "demo-supervisor",
  [
    [
      1.92,
      "text",
      "review 2 of the research questions, reviewer-1: fail. 2 of the questions answered. Question 3 still has open gaps.",
    ],
    [
      1.91,
      "text",
      "review 2 of the research questions, reviewer-2: fail. 2 of the questions answered. Question 3 still has open gaps.",
    ],
    [1.9, "status", "review 2: the review panel did not pass it"],
    [
      0.55,
      "text",
      "review 3 of the research questions, reviewer-1: fail. 3 of the questions answered. Question 3's new card needs a second site.",
    ],
    [
      0.54,
      "status",
      "review 3: 2 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429 too many requests)",
    ],
    [
      0.05,
      "status",
      "review 3: 1 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429 too many requests; reviewer-3: no answer in 15 min)",
    ],
  ].map(([h, kind, text], n) => ({
    seq: n + 1,
    at: iso(Number(h)),
    source: "supervisor",
    kind: kind as "text" | "status",
    text: String(text),
    run: "noise-survey",
  })),
  false,
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

// A model provider whose list prices one model and not the other (goal 075's price field).
store.putProvider({
  name: "demo-models",
  type: "openai",
  base_url: "https://models.example.com/v1",
  key: { sealed: "demo", hint: "…demo" },
});
store.setProviderModels("demo-models", [
  {
    id: "glm-5.1",
    context_window: 131_072,
    price: { input: 0.6, cached_input: 0.11, output: 2.2 },
  },
  { id: "kimi-k3", context_window: 262_144 },
]);

const port = Number(values.port);
serve({
  fetch: createControlApi(store, tokens, keys.privateKeyPem, { staleAfterMs: 180_000 }).fetch,
  hostname: "127.0.0.1",
  port,
});
console.log(`dashboard demo: http://127.0.0.1:${port}/ui  (token: ${tokens.admin})`);
