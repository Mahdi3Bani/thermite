import type { ControlStore } from "../control/store.ts";
import type { LiveEntry } from "../core/live.ts";

/**
 * A realistic control store for dashboard tests and demos: three rigs, a goal campaign with two
 * runs (one with attempts held for an audit, one with lanes at work and the judge validating), and
 * a hill climb whose rig waits for the owner's approval of a confirmed win, with an earlier one the
 * auditor blocked. Every event has the shape the harness writes; names are generic.
 */
export function seedDemo(store: ControlStore, now = Date.now()): void {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const rig = (
    id: string,
    events: [number, string, string | null, Record<string, unknown>][],
    summary: Record<string, unknown>,
  ) => {
    store.ingest({
      rig: id,
      ledger_id: `ledger-${id}`,
      cursor: 0,
      next: events.length,
      generated_at: at(0),
      // In time order, as the ledger writes them (the sort is stable for events at one time).
      events: [...events]
        .sort((x, y) => y[0] - x[0])
        .map(([ago, kind, subject, body], i) => ({
          id: i + 1,
          at: at(ago),
          actor: "harness",
          kind,
          subject,
          body,
        })),
      summary,
    });
  };
  const live = (id: string, lines: [number, Omit<LiveEntry, "seq" | "at">][]) =>
    store.addLive(
      id,
      `log-${id}`,
      lines.map(([ago, e], i) => ({ seq: i + 1, at: at(ago), ...e })),
      true,
    );

  const goals = (load: string) => [
    { goal: "build", status: "met", reasons: "the engine builds with the new types" },
    { goal: "goldens", status: "met", reasons: "every golden file matches" },
    { goal: "real-file", status: "met", reasons: "the real model file parses" },
    { goal: "ops", status: "met", reasons: "GPU ops match the CPU reference" },
    { goal: "load", status: "unmet", reasons: load },
    {
      goal: "numerics",
      status: "unmet",
      reasons: "not run: it requires load, which did not pass",
    },
    { goal: "sane", status: "unmet", reasons: "not run: it requires numerics, which did not pass" },
    { goal: "native", status: "unmet", reasons: "not run: it requires load, which did not pass" },
  ];
  const seedGoals = goals("a frame takes 31 ms against a 20 ms budget").map((g) =>
    ["build", "goldens", "real-file", "ops"].includes(g.goal) && g.goal !== "build"
      ? { ...g, status: "unmet", reasons: "the engine has no support for the new types yet" }
      : g,
  );

  // ---------------------------------------------------------------- rig-a: port-2, held for audits
  rig(
    "rig-a",
    [
      [
        600,
        "run_created",
        "port-2",
        {
          campaign: "kernel-port",
          mode: "goal",
          seed: { repo: "engine", commit: "4be1c0ffee00112233445566778899aabbccddee" },
        },
      ],
      [598, "job_queued", "1", { attempt: null, kind: "validate" }],
      [598, "job_leased", "1", { fence: 1, until: at(560) }],
      [
        574,
        "goal_report",
        "port-2",
        { run: "port-2", champion_seq: 1, goals: seedGoals, complete: false },
      ],
      [574, "job_finished", "1", { state: "done", result: { champion_seq: 1 } }],
      [
        573,
        "epoch_started",
        "port-2",
        {
          n: 1,
          source: "planner",
          planner_tries: 1,
          planner_valid: true,
          raw_violations: 0,
          directives: [],
          assignments: [
            { lane: "lane-1", family: "types-and-traits", parent: "champion" },
            { lane: "lane-2", family: "cpu-reference", parent: "champion" },
          ],
        },
      ],
      [
        470,
        "attempt_recorded",
        "a-7e1a0001",
        {
          run: "port-2",
          lane: "lane-1",
          lifecycle: "queued",
          commit: "3c0ffee100112233445566778899aabbccddeeff",
          parent: "4be1c0ffee00112233445566778899aabbccddee",
          hypothesis:
            "Register the two new tensor types with their traits and a CPU to_float, and dispatch GPU matmuls for them through the existing reference kernel.",
          known_flaws: [
            "The GPU path uses the slow reference kernel, not a tuned one.",
            "Only the two new types are covered; mixed-type models are untested.",
          ],
        },
      ],
      [
        470,
        "trial_finished",
        "port-2",
        {
          trial: "t-1111",
          lane: "lane-1",
          epoch: 1,
          family: "types-and-traits",
          attempt: "a-7e1a0001",
          stopped: "submitted",
          turns: 212,
          tokens_in: 4_100_000,
          tokens_out: 160_000,
          error: null,
        },
      ],
      [469, "job_queued", "2", { attempt: "a-7e1a0001", kind: "evaluate" }],
      [469, "job_leased", "2", { fence: 1, until: at(400) }],
      [
        330,
        "verdict",
        "a-7e1a0001",
        { id: 1, verdict: "goal_screened", delta: null, supersedes: null },
      ],
      [
        330,
        "job_finished",
        "2",
        {
          state: "done",
          result: {
            verdict: "goal_screened",
            gained: ["goldens", "real-file", "ops"],
            lost: [],
            unsure: [],
          },
        },
      ],
      [330, "job_queued", "3", { attempt: "a-7e1a0001", kind: "confirm" }],
      [329, "job_leased", "3", { fence: 1, until: at(250) }],
      [
        174,
        "verdict",
        "a-7e1a0001",
        { id: 2, verdict: "goal_progress", delta: null, supersedes: null },
      ],
      [174, "promotion_blocked", "a-7e1a0001", { reason: "audit required: declared flaws" }],
      [
        174,
        "audit_requested",
        "a-7e1a0001",
        { audit: 1, run: "port-2", reason: "declared flaws", expected_seq: 1 },
      ],
      [174, "attempt_lifecycle", "a-7e1a0001", { lifecycle: "awaiting_audit" }],
      [
        174,
        "job_finished",
        "3",
        {
          state: "done",
          result: {
            verdict: "goal_progress",
            gained: ["goldens", "real-file", "ops"],
            promoted: false,
            waiting: "audit",
          },
        },
      ],
      [
        460,
        "attempt_recorded",
        "a-7e1a0002",
        {
          run: "port-2",
          lane: "lane-2",
          lifecycle: "queued",
          commit: "7e1a000255aa66bb77cc88dd99ee00ff11223344",
          parent: "4be1c0ffee00112233445566778899aabbccddee",
          hypothesis: "Add the CPU reference path for the new types first, then the goldens.",
          known_flaws: ["No GPU kernel at all: the GPU ops goal is left for later."],
        },
      ],
      [170, "job_queued", "4", { attempt: "a-7e1a0002", kind: "evaluate" }],
      [170, "job_leased", "4", { fence: 1, until: at(100) }],
      [
        95,
        "verdict",
        "a-7e1a0002",
        { id: 3, verdict: "goal_screened", delta: null, supersedes: null },
      ],
      [
        95,
        "job_finished",
        "4",
        {
          state: "done",
          result: {
            verdict: "goal_screened",
            gained: ["goldens", "real-file"],
            lost: [],
            unsure: [],
          },
        },
      ],
      [95, "job_queued", "5", { attempt: "a-7e1a0002", kind: "confirm" }],
      [94, "job_leased", "5", { fence: 1, until: at(20) }],
      [
        20,
        "verdict",
        "a-7e1a0002",
        { id: 4, verdict: "goal_progress", delta: null, supersedes: null },
      ],
      [
        20,
        "audit_requested",
        "a-7e1a0002",
        { audit: 2, run: "port-2", reason: "declared flaws", expected_seq: 1 },
      ],
      [20, "attempt_lifecycle", "a-7e1a0002", { lifecycle: "awaiting_audit" }],
      [
        20,
        "job_finished",
        "5",
        {
          state: "done",
          result: {
            verdict: "goal_progress",
            gained: ["goldens", "real-file"],
            promoted: false,
            waiting: "audit",
          },
        },
      ],
      [18, "run_status", "port-2", { status: "paused", reason: "replaced by port-3 on rig-b" }],
    ],
    { jobs: { done: 5 } },
  );

  // ---------------------------------------------------------------- rig-b: port-3, at work
  rig(
    "rig-b",
    [
      [
        70,
        "run_created",
        "port-3",
        {
          campaign: "kernel-port",
          mode: "goal",
          seed: { repo: "engine", commit: "3c0ffee100112233445566778899aabbccddeeff" },
        },
      ],
      [70, "job_queued", "1", { attempt: null, kind: "validate" }],
      [69, "job_leased", "1", { fence: 1, until: at(40) }],
      [
        46,
        "goal_report",
        "port-3",
        {
          run: "port-3",
          champion_seq: 1,
          goals: goals(
            "the profile shows the scalar filter bank on the hot path; a frame takes 26 ms against a 20 ms budget",
          ),
          complete: false,
        },
      ],
      [46, "job_finished", "1", { state: "done", result: { champion_seq: 1 } }],
      [
        64,
        "epoch_started",
        "port-3",
        {
          n: 1,
          source: "planner",
          planner_tries: 1,
          planner_valid: true,
          raw_violations: 0,
          directives: [],
          assignments: [
            { lane: "lane-1", family: "filter-bank", parent: "champion" },
            { lane: "lane-2", family: "gemv-kernel", parent: "champion" },
          ],
        },
      ],
      [
        12,
        "command",
        "c0ffee00-0000-4000-8000-000000000001",
        { kind: "message_agent", accepted: true },
      ],
      [9, "job_queued", "2", { attempt: null, kind: "calibrate" }],
      [8, "job_leased", "2", { fence: 1, until: at(-20) }],
    ],
    { jobs: { leased: 1, queued: 0, done: 1 } },
  );
  live("rig-b", [
    [65, { source: "planner", kind: "status", text: "planning epoch 1 (2 lanes)", run: "port-3" }],
    [
      64,
      {
        source: "planner",
        kind: "text",
        text: "epoch 1: planned by the model\nlane-1: filter-bank, vectorize the filter bank so a frame fits its time budget\nlane-2: gemv-kernel, a tuned matrix-vector kernel for the new types",
        run: "port-3",
      },
    ],
    [
      63,
      {
        source: "trial:t-0a1b2c3d4e5f6071",
        kind: "status",
        text: "trial on lane-1: filter-bank, vectorize the filter bank so a frame fits its time budget (from the champion, seq 1)",
        lane: "lane-1",
        run: "port-3",
      },
    ],
    [
      63,
      {
        source: "trial:t-1b2c3d4e5f607182",
        kind: "status",
        text: "trial on lane-2: gemv-kernel, a tuned matrix-vector kernel for the new types (from the champion, seq 1)",
        lane: "lane-2",
        run: "port-3",
      },
    ],
    [60, { source: "judge", kind: "log", text: "validate port-3: started", run: "port-3" }],
    [
      46,
      {
        source: "judge",
        kind: "log",
        text: "validate port-3: done",
        run: "port-3",
      },
    ],
    [
      6,
      {
        source: "trial:t-0a1b2c3d4e5f6071",
        kind: "tool",
        text: "run timeout 270 cmake --build build-cuda --target server -j 2 2>&1 | tail -3",
        lane: "lane-1",
        run: "port-3",
      },
    ],
    [
      2,
      {
        source: "trial:t-0a1b2c3d4e5f6071",
        kind: "result",
        text: "run (268011 ms): exit 124\n[212/412] Building CUDA object mmq.cu.o",
        lane: "lane-1",
        run: "port-3",
      },
    ],
    [
      1,
      {
        source: "trial:t-1b2c3d4e5f607182",
        kind: "tool",
        text: "read src/kernels/gemv.cu",
        lane: "lane-2",
        run: "port-3",
      },
    ],
    [8, { source: "judge", kind: "log", text: "calibrate port-3: started", run: "port-3" }],
  ]);

  // ---------------------------------------------------------------- rig-c: a hill climb, approvals
  const champ = (seq: number, ago: number, attempt: string, delta: number) =>
    [
      [
        ago + 30,
        "attempt_recorded",
        attempt,
        {
          run: "sum-1",
          lane: seq % 2 ? "lane-1" : "lane-2",
          lifecycle: "queued",
          commit: `${attempt.slice(2)}00000000000000000000000000000000`.slice(0, 40),
          parent: "0".repeat(40),
          hypothesis: `step ${seq}: unroll the inner loop further`,
          known_flaws: [],
        },
      ],
      [ago + 1, "verdict", attempt, { id: seq, verdict: "win_confirmed", delta, supersedes: null }],
      [
        ago,
        "champion_promoted",
        "sum-1",
        { seq, attempt, commit: `${attempt.slice(2)}`.padEnd(40, "0") },
      ],
    ] as [number, string, string | null, Record<string, unknown>][];
  rig(
    "rig-c",
    [
      [
        3000,
        "run_created",
        "sum-1",
        {
          campaign: "sum-speed",
          mode: "hill_climb",
          seed: { repo: "sum", commit: "0".repeat(40) },
        },
      ],
      [2990, "calibration", "sum-1", { sigma: 0.012, summary: "6 A/A blocks" }],
      ...champ(2, 2400, "a-11110001", 0.061),
      ...champ(3, 1500, "a-11110002", 0.044),
      ...champ(4, 700, "a-11110003", 0.032),
      [
        200,
        "attempt_recorded",
        "a-5b5b0001",
        {
          run: "sum-1",
          lane: "lane-2",
          lifecycle: "queued",
          commit: "5b5b000100000000000000000000000000000000",
          parent: "1111000300000000000000000000000000000000",
          hypothesis: "Replace the scalar loop with a vectorized reduction over 8 lanes.",
          known_flaws: [],
        },
      ],
      [190, "job_queued", "11", { attempt: "a-5b5b0001", kind: "evaluate" }],
      [
        150,
        "job_finished",
        "11",
        { state: "done", result: { verdict: "win_screened", delta: 0.152, baseline_seq: 4 } },
      ],
      [
        150,
        "verdict",
        "a-5b5b0001",
        { id: 11, verdict: "win_screened", delta: 0.152, supersedes: null },
      ],
      [
        90,
        "verdict",
        "a-5b5b0001",
        { id: 12, verdict: "win_confirmed", delta: 0.142, supersedes: null },
      ],
      [
        90,
        "job_finished",
        "12",
        {
          state: "done",
          result: { verdict: "win_confirmed", promoted: false, waiting: "owner_approval" },
        },
      ],
      [
        90,
        "promotion_pending",
        "a-5b5b0001",
        { run: "sum-1", expected_seq: 4, commit: "5b5b000100000000000000000000000000000000" },
      ],
      [90, "attempt_lifecycle", "a-5b5b0001", { lifecycle: "awaiting_approval" }],
      [
        400,
        "attempt_recorded",
        "a-9c9c0001",
        {
          run: "sum-1",
          lane: "lane-1",
          lifecycle: "queued",
          commit: "9c9c000100000000000000000000000000000000",
          parent: "1111000300000000000000000000000000000000",
          hypothesis: "Cache the sum between calls.",
          known_flaws: [],
        },
      ],
      [
        300,
        "verdict",
        "a-9c9c0001",
        { id: 13, verdict: "win_confirmed", delta: 2.4, supersedes: null },
      ],
      [
        300,
        "audit_requested",
        "a-9c9c0001",
        { audit: 3, run: "sum-1", reason: "gain 240.0% above 100%", expected_seq: 4 },
      ],
      [
        240,
        "audit_decided",
        "a-9c9c0001",
        {
          audit: 3,
          decision: "block",
          reasons:
            "The change caches the result between calls, so the benchmark measures a cache hit, not the sum.",
        },
      ],
    ],
    { jobs: { queued: 0, leased: 0, done: 12 } },
  );
  store.setSupervisor("rig-c", {
    at: at(1),
    advisors: {
      teacher_runs: 4,
      directive_sets: 3,
      directives: 7,
      audits: 1,
      reviews: 0,
      errors: 0,
      tokens_in: 1,
      tokens_out: 1,
      usd: 2.4,
    },
  });
  store.setSupervisor("rig-a", { at: at(1), advisors: null });
}
