import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlStore } from "./store.ts";
import { experimentsTab, plannerTab } from "./ui/queue.ts";
import { rigView } from "./views.ts";

/** A rig whose run "r-1" reported these events (subject: the run), in order. */
function rigWith(events: [string, string, Record<string, unknown>][]) {
  const store = new ControlStore(":memory:");
  const all: [string, string, Record<string, unknown>][] = [
    ["harness", "run_created", { campaign: "c", mode: "hill_climb", version: 1, agents: true }],
    ...events,
  ];
  store.ingest({
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: all.length,
    generated_at: new Date().toISOString(),
    events: all.map(([actor, kind, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + i * 60_000).toISOString(),
      actor,
      kind,
      subject: "r-1",
      body,
    })),
    summary: {},
  });
  const u = rigView(store, "rig-a", { staleAfterMs: 600_000 });
  assert.ok(u);
  const r = u.runs.find((x) => x.id === "r-1");
  assert.ok(r);
  return { u, r };
}

test("the queue view keeps the order the events give it, and where each experiment went", () => {
  const { r } = rigWith([
    [
      "planner",
      "experiment_added",
      {
        id: "x-1",
        title: "fuse the dequantize step",
        family: "dequant-fusion",
        why: "it won on long",
        by: "planner",
      },
    ],
    [
      "supervisor",
      "experiment_added",
      { id: "x-2", title: "vector loads", family: "memory-layout", by: "teacher", position: 0 },
    ],
    [
      "control:owner:ui",
      "experiment_added",
      { id: "x-3", title: "warp shuffle", by: "owner", position: "end" },
    ],
    [
      "harness",
      "experiment_added",
      { id: "x-4", title: "unit test at 3 sizes", by: "lane-2", state: "proposed" },
    ],
    ["control:owner:ui", "experiment_moved", { id: "x-3", position: "top", by: "owner" }],
    ["planner", "experiment_assigned", { id: "x-2", lane: "lane-1", trial: "t-1", by: "planner" }],
    ["planner", "experiment_dropped", { id: "x-1", by: "planner", why: "a rule avoids it" }],
    [
      "harness",
      "experiment_finished",
      { id: "x-2", lane: "lane-1", trial: "t-1", result: "no_attempt" },
    ],
    ["control:owner:ui", "experiment_accepted", { id: "x-4", by: "owner" }],
    ["planner", "experiment_added", { id: "x-5", title: "read the survey", by: "planner" }],
    ["planner", "experiment_assigned", { id: "x-5", lane: "lane-2", trial: "t-2", by: "planner" }],
    [
      "harness",
      "experiment_finished",
      { id: "x-5", lane: "lane-2", trial: "t-2", result: "finished" },
    ],
    [
      "planner",
      "planner_handout",
      {
        round: 9,
        assignments: [
          { lane: "lane-1", experiment: "x-2", why: "it has the fusion code in context" },
        ],
        notes: "kept fusion on lane-1",
      },
    ],
    [
      "control:owner:ui",
      "directive",
      { id: 7, body: { kind: "avoid", family: "gemv-tiling", rationale: "measured slower twice" } },
    ],
    [
      "control:owner:ui",
      "directive",
      {
        id: 8,
        body: { kind: "try", match: "anything with vector loads", rationale: "the guide says so" },
      },
    ],
    ["control:owner:ui", "directive_dropped", { id: 7 }],
    // A rule for a new direction (goal 066), then the planner designs it.
    [
      "control:owner:ui",
      "directive",
      { id: 9, body: { kind: "mandate", family: "split-k", rationale: "won elsewhere" } },
    ],
    [
      "planner:planner",
      "family_added",
      { family: "split-k", description: "split the reduction over k", for_rules: [9] },
    ],
  ]);
  const up = r.queue
    .filter((x) => x.state === "queued")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  assert.deepEqual(
    up.map((x) => x.id),
    ["x-3", "x-4"],
  );
  assert.equal(r.queue.find((x) => x.id === "x-2")?.state, "done");
  assert.equal(r.queue.find((x) => x.id === "x-1")?.dropped_why, "a rule avoids it");
  assert.equal(r.handouts.length, 1);
  assert.deepEqual(
    r.rules.map((x) => [x.id, x.legacy]),
    [
      [8, true],
      [9, false],
    ],
  );
  // The run's directions: each experiment's, and the one the planner designed for rule 9.
  assert.deepEqual(r.directions, [
    {
      name: "dequant-fusion",
      description: null,
      tried: 0,
      wins: 0,
      queued: 0,
      lanes: [],
      rules: [],
      to_design: false,
    },
    {
      name: "memory-layout",
      description: null,
      tried: 1,
      wins: 0,
      queued: 0,
      lanes: [],
      rules: [],
      to_design: false,
    },
    {
      name: "split-k",
      description: "split the reduction over k",
      tried: 0,
      wins: 0,
      queued: 0,
      lanes: [],
      rules: [{ id: 9, kind: "mandate" }],
      to_design: false,
    },
  ]);
  // The tabs: up next in order with who added each; tried with its result; rules with who set them.
  const cmd = (f: { kind: string; label: string }) =>
    `<form data-kind="${f.kind}">${f.label}</form>`;
  const { u } = rigWith([]);
  const exp = experimentsTab({
    u,
    r,
    now: Date.parse("2026-10-20T02:00:00Z"),
    csrf: "x",
    back: "/b",
    cmd,
    families: ["dequant-fusion"],
  });
  assert.match(exp, /<span class="qn">1<\/span><div class="qmain"><div class="qt">warp shuffle/);
  assert.match(
    exp,
    /<span class="qn">2<\/span><div class="qmain"><div class="qt">unit test at 3 sizes/,
  );
  assert.match(exp, /lane-2&#39;s idea|lane-2's idea/);
  assert.match(exp, /dropped by planner: a rule avoids it/);
  assert.match(exp, /<span class="qres none">no attempt<\/span>/);
  // A research trial's experiment ends "finished": its result is its research, not a missing attempt.
  assert.match(exp, /<span class="qres done">finished: its research is in the run's notes<\/span>/);
  assert.match(exp, /data-qf="done">Research finished <span class="n">1<\/span>/);
  assert.match(exp, /data-kind="queue_move"/);
  const plan = plannerTab({
    u,
    r,
    now: Date.parse("2026-10-20T02:00:00Z"),
    csrf: "x",
    back: "/b",
    cmd,
    model: "m",
    figures: "",
    propagate: "",
  });
  // An old rule in words shows as such, with Remove; a rule names its direction as :name:.
  assert.match(
    plan,
    /<span class="qkind words">words<\/span><div><b>Try “anything with vector loads”<\/b>/,
  );
  assert.match(
    plan,
    /An old rule in words, from before rules named directions\. Code doesn't keep it\./,
  );
  assert.match(plan, /<b>Always give :split-k: a lane<\/b>/);
  assert.doesNotMatch(plan, /gemv-tiling/);
  assert.match(plan, /This run's directions: :dequant-fusion:, :memory-layout:, :split-k:\./);
  assert.match(
    plan,
    /<b>Round 9<\/b>: <ul><li><b>lane-1<\/b>: vector loads <span class="muted">· it has the fusion code in context/,
  );
  // The planner's own changes to the queue, newest first, each with its reason; the owner's
  // changes and the hand-outs' assignments are not repeated as changes.
  assert.deepEqual(
    [
      ...plan.matchAll(
        /<div class="qhand"><span class="tm">[^<]*<\/span><div>([\s\S]*?)<\/div><\/div>/g,
      ),
    ]
      .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, ""))
      .filter((s) => !s.startsWith("Round")),
    [
      "Designed the direction :split-k: for rule 9 · split the reduction over k",
      "Added “read the survey” to the queue",
      "Dropped “fuse the dequantize step” · a rule avoids it",
      "Added “fuse the dequantize step” to the queue · it won on long",
    ],
  );
  assert.match(plan, /<input name="direction" required/);
  assert.doesNotMatch(plan, /name="match"/);
  assert.match(plan, /Tell the planner/);
});
