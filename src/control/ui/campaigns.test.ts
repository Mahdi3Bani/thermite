import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignView, RigView, RunView } from "../views.ts";
import {
  campaignFilter,
  campaignKind,
  campaignsListBody,
  isRigCheck,
  startDrawer,
} from "./campaigns.ts";

const run = (id: string, status: string, campaign: string): RunView =>
  ({
    id,
    campaign,
    status,
    mode: "hill_climb",
    attempts: [],
    timeline: [],
    created_at: "2026-10-20T00:00:00Z",
    champion: [],
    goals: [],
    research: null,
  }) as unknown as RunView;
const rig = { id: "rig-a" } as unknown as RigView;
const camp = (name: string, ...statuses: string[]): CampaignView => ({
  name,
  mode: "hill_climb",
  runs: statuses.map((s, i) => ({ rig, run: run(`${name}-${i + 1}`, s, name) })),
});

test("the Campaigns list hides rig checks and finished campaigns unless asked", () => {
  const camps = [
    camp("speed", "running", "paused"),
    camp("old", "closed"),
    camp("rig-check-smoke-cpu-1a2b3c4d", "closed", "closed"),
  ];
  assert.equal(isRigCheck("rig-check-smoke-cpu-1a2b3c4d"), true);
  assert.equal(campaignKind(camps[0] as CampaignView), "active");
  assert.equal(campaignKind(camps[1] as CampaignView), "finished");
  assert.equal(campaignKind(camps[2] as CampaignView), "check");
  const body = (f: string, q = "") =>
    campaignsListBody({
      camps,
      atWork: [],
      waiting: [],
      filter: campaignFilter(f),
      query: q,
      now: Date.parse("2026-10-20T01:00:00Z"),
      best: () => "+1.0% gain",
      about: (k) => (k.name === "speed" ? "Make it faster" : ""),
    });
  const dflt = body("");
  assert.match(dflt, /<b>speed<\/b>/);
  assert.doesNotMatch(dflt, /<b>old<\/b>/);
  assert.doesNotMatch(dflt, /<b>rig-check-smoke/);
  assert.match(dflt, /Show the 1 rig check/);
  assert.match(dflt, /Make it faster/);
  assert.match(body("check"), /<b>rig-check-smoke-cpu-1a2b3c4d<\/b>/);
  assert.match(body("check"), /rig check/);
  assert.match(body("all"), /<b>old<\/b>/);
  // Search matches names, descriptions, runs and rigs.
  assert.match(body("all", "faster"), /<b>speed<\/b>/);
  assert.doesNotMatch(body("all", "faster"), /<b>old<\/b>/);
  assert.match(body("all", "nothing-like-this"), /No campaign matches/);
  // An unknown filter is the default one.
  assert.equal(campaignFilter("bogus"), "default");
});

test("a paused run reads as paused, whatever decision waits in it", async () => {
  const { runState } = await import("./components.ts");
  const r = (status: string, more: Partial<RunView> = {}) =>
    ({
      status,
      audits: [],
      pending_promotions: [],
      conclusions: [],
      reviews: [],
      ...more,
    }) as unknown as RunView;
  const approval = { pending_promotions: [{}] } as unknown as Partial<RunView>;
  const audit = { audits: [{ decision: null }] } as unknown as Partial<RunView>;
  assert.equal(runState(r("paused", approval)).text, "Paused");
  assert.equal(runState(r("paused", audit)).text, "Paused");
  assert.equal(runState(r("running", approval)).text, "Approval");
  // An open audit is the auditor's to decide; a blocked result waits on the owner.
  assert.deepEqual(
    [runState(r("running", audit)).text, runState(r("running", audit)).cls],
    ["Auditing", "info"],
  );
  const blocked = { audits: [{ decision: "block" }] } as unknown as Partial<RunView>;
  assert.deepEqual(
    [runState(r("running", blocked)).text, runState(r("running", blocked)).cls],
    ["Audit", "warn"],
  );
  assert.equal(runState(r("closed", approval)).text, "Finished");
});

/** A run for the status words (goal 099): its state, mode, start and its goals' end. */
const statusRun = (
  id: string,
  status: string,
  created_at: string,
  more: Partial<RunView> = {},
): RunView =>
  ({
    id,
    campaign: "quality",
    status,
    mode: "goal",
    created_at,
    goals_complete: false,
    audits: [],
    pending_promotions: [],
    conclusions: [],
    reviews: [],
    attempts: [],
    timeline: [],
    champion: [],
    goals: [],
    research: null,
    ...more,
  }) as unknown as RunView;

test("a closed goal run that met its goals reads Completed; any other closed run, Finished (goal 099)", async () => {
  const { runState } = await import("./components.ts");
  const met = { goals_complete: true } as Partial<RunView>;
  const st = (r: RunView) => [runState(r).text, runState(r).cls];
  assert.deepEqual(st(statusRun("q-1", "closed", "2026-10-20T00:00:00Z", met)), [
    "Completed",
    "ok",
  ]);
  // Closed with its goals unmet (the owner closed it, or "not possible"): Finished.
  assert.deepEqual(st(statusRun("q-1", "closed", "2026-10-20T00:00:00Z")), ["Finished", "muted"]);
  // Only a goal run completes: a hill climb never meets goals.
  assert.deepEqual(
    st(statusRun("h-1", "closed", "2026-10-20T00:00:00Z", { ...met, mode: "hill_climb" })),
    ["Finished", "muted"],
  );
  // A paused or running run keeps its word, whatever its last report said.
  assert.equal(runState(statusRun("q-1", "paused", "2026-10-20T00:00:00Z", met)).text, "Paused");
  assert.equal(runState(statusRun("q-1", "running", "2026-10-20T00:00:00Z", met)).text, "Running");
});

test("a campaign reads as its newest run when none is at work; a run at work still wins (goal 099)", async () => {
  const { campaignState } = await import("./components.ts");
  const met = { goals_complete: true } as Partial<RunView>;
  const k = (...runs: RunView[]): CampaignView => ({
    name: "quality",
    mode: "goal",
    runs: runs.map((run) => ({ rig, run })),
  });
  const old = statusRun("q-1", "paused", "2026-10-20T00:00:00Z");
  const older = statusRun("q-0", "paused", "2026-10-19T00:00:00Z");
  const done = statusRun("q-2", "closed", "2026-10-21T00:00:00Z", met);
  // Two older paused runs and a newer one that completed: Completed, in any order.
  const both = k(older, done, old);
  assert.deepEqual([campaignState(both).text, campaignState(both).cls], ["Completed", "ok"]);
  assert.equal(campaignKind(both), "finished");
  // A newer paused run after a completed one: Paused, and the list counts it as paused.
  const again = k(done, statusRun("q-3", "paused", "2026-10-22T00:00:00Z"));
  assert.equal(campaignState(again).text, "Paused");
  assert.equal(campaignKind(again), "paused");
  // A newer run closed without meeting its goals: Finished.
  assert.equal(
    campaignState(k(old, statusRun("q-4", "closed", "2026-10-22T00:00:00Z"))).text,
    "Finished",
  );
  // Any run at work wins over the newest run's end, and the most urgent of those first.
  const working = statusRun("q-5", "running", "2026-10-18T00:00:00Z");
  assert.equal(campaignState(k(done, working)).text, "Running");
  assert.equal(campaignKind(k(done, working)), "active");
  const asks = statusRun("q-6", "running", "2026-10-17T00:00:00Z", {
    pending_promotions: ["a-1"],
  });
  assert.equal(campaignState(k(working, done, asks)).text, "Approval");
  // Every run paused: Paused.
  assert.equal(campaignState(k(older, old)).text, "Paused");
  assert.equal(campaignState(k()).text, "Idle");
});

test("the Campaigns list hides a campaign whose newest run completed, and counts it apart (goal 099)", () => {
  const camps: CampaignView[] = [
    {
      name: "quality",
      mode: "goal",
      runs: [
        { rig, run: statusRun("q-1", "paused", "2026-10-20T00:00:00Z") },
        {
          rig,
          run: statusRun("q-2", "closed", "2026-10-21T00:00:00Z", { goals_complete: true }),
        },
        { rig, run: statusRun("q-3", "closed", "2026-10-19T00:00:00Z") },
      ],
    },
  ];
  const body = (f: string) =>
    campaignsListBody({
      camps,
      atWork: [],
      waiting: [],
      filter: campaignFilter(f),
      query: "",
      now: Date.parse("2026-10-22T00:00:00Z"),
      best: () => "2/2 goals met",
      about: () => "",
    });
  assert.doesNotMatch(body(""), /<b>quality<\/b>/);
  assert.doesNotMatch(body("paused"), /<b>quality<\/b>/);
  assert.match(
    body("all"),
    /<span class="kdot pause">1 paused<\/span><span class="kdot ok">1 completed<\/span><span class="kdot done">1 finished<\/span>/,
  );
});

test("Earlier runs reads Completed for a run that met its goals, and marks a judge-only run (goal 099)", async () => {
  const { earlierRuns } = await import("./campaigns.ts");
  const html = earlierRuns(
    [
      statusRun("q-2", "closed", "2026-10-21T00:00:00Z", { goals_complete: true }),
      statusRun("q-1", "closed", "2026-10-20T00:00:00Z", { has_agents: false }),
    ].map((run) => ({ rig, run, result: "", action: "" })),
    Date.parse("2026-10-22T00:00:00Z"),
  );
  assert.match(
    html,
    /<td><span class="kst ok">Completed<\/span><\/td><td><a [^>]*><b>q-2<\/b><\/a><\/td>/,
  );
  assert.match(
    html,
    /<td><span class="kst done">Finished<\/span><\/td><td><a [^>]*><b>q-1<\/b><\/a> <span class="chip" title="[^"]*">judge only<\/span><\/td>/,
  );
});

test("a judge-only run's queue says no worker takes it, and how to carry it to a run with workers (goal 099)", async () => {
  const { experimentsTab, judgeOnlyQueueLine } = await import("./queue.ts");
  const waiting = (state: string) =>
    [
      {
        id: "x-000000000001",
        title: "tile the loop",
        state,
        position: 0,
        by: "teacher",
        family: "",
        why: "",
        at: "2026-10-21T00:00:00Z",
        updated_at: "2026-10-21T00:00:00Z",
      },
    ] as unknown as RunView["queue"];
  const run = (has_agents: boolean, queue: RunView["queue"]) =>
    statusRun("q-1", "running", "2026-10-20T00:00:00Z", {
      has_agents,
      queue,
      at_work: {},
    } as Partial<RunView>);
  const LINE =
    /<b>Judge only:<\/b> no worker takes these experiments, so they wait for a run with workers\. To carry them over, <a href="\/ui\/campaigns\/quality\?start=1&amp;copy=rig-a%2Fq-1">Start a run<\/a> of the campaign with <b>Copy the untried experiments of<\/b> q-1 ticked\./;
  const tab = (r: RunView) =>
    experimentsTab({
      u: rig,
      r,
      now: Date.parse("2026-10-22T00:00:00Z"),
      csrf: "c",
      back: "/ui/campaigns/quality?run=rig-a%2Fq-1&view=experiments",
      cmd: () => "",
      families: [],
    });
  assert.match(tab(run(false, waiting("queued"))), LINE);
  assert.match(judgeOnlyQueueLine(rig, run(false, waiting("proposed"))), LINE);
  // A run with workers, or nothing waiting: no line.
  assert.doesNotMatch(tab(run(true, waiting("queued"))), /Judge only/);
  assert.equal(judgeOnlyQueueLine(rig, run(false, [])), "");
  assert.equal(judgeOnlyQueueLine(rig, run(false, waiting("done"))), "");
});

test("Start a run chooses the run to copy from that the link names (goal 099)", () => {
  const html = (copyPick?: string) =>
    startDrawer({
      campaign: "quality",
      csrf: "c",
      open: true,
      rigs: [{ id: "rig-a", hardware: "6 CPU", stale: false, model: "m-1" }],
      models: [],
      from: "Control assigns the campaign again.",
      copyFrom: [
        { key: "rig-a/q-2", label: "q-2 (3 up next)" },
        { key: "rig-a/q-1", label: "q-1 (1 up next)" },
      ],
      copyPick,
    });
  assert.match(
    html("rig-a/q-1"),
    /<option value="rig-a\/q-1" selected>q-1 \(1 up next\)<\/option>/,
  );
  assert.doesNotMatch(html("rig-a/q-1"), /value="rig-a\/q-2" selected/);
  assert.doesNotMatch(html(), / selected>/);
});

test("the Planner tab counts rounds, and says plainly when the planner is off", async () => {
  const { plannerTab } = await import("./queue.ts");
  const tab = (settings: Record<string, unknown> | null, epochs: number) =>
    plannerTab({
      u: { id: "rig-a", settings } as unknown as RigView,
      r: {
        id: "r-1",
        mode: "hill_climb",
        rules: [],
        directions: [],
        handouts: [],
        queue: [],
        messages: [],
        agents: { epochs, planner_valid: epochs - 1, fallbacks: 1 },
      } as unknown as RunView,
      now: Date.parse("2026-10-20T01:00:00Z"),
      csrf: "c",
      back: "/ui/campaigns/x?run=rig-a%2Fr-1&view=planner",
      cmd: () => "",
      model: "m",
      figures: "",
      propagate: "",
    });
  const on = tab({ planner: true }, 3);
  assert.match(on, /3 rounds so far: 2 planned by the model, 1 in queue order by the fixed rules/);
  assert.doesNotMatch(on, /hand-outs:/);
  assert.match(tab({ planner: true }, 1), /1 round so far:/);
  assert.match(on, /Send to the planner/);
  const off = tab({ planner: false }, 3);
  assert.match(off, /The planner is off on this rig, so it reads no messages/);
  assert.doesNotMatch(off, /Send to the planner/);
});

test("a research run's rounds with the planner off read as set by the gap-driven plan, not as a refused plan", async () => {
  const { sentence } = await import("./words.ts");
  const e = (body: Record<string, unknown>) =>
    ({
      kind: "epoch_started",
      subject: "r-1",
      actor: "scheduler",
      at: "2026-10-20T00:00:00Z",
      body,
    }) as never;
  const assignments = [{ lane: "lane-1", family: "contradict" }];
  const u = { judge: { jobs: [] }, runs: [] } as never;
  const research = sentence(
    u,
    e({ n: 3, source: "fallback", notes: "research plan (deterministic in v1)", assignments }),
  );
  assert.match(
    String(research?.text ?? JSON.stringify(research)),
    /The gap-driven plan set round 3 \(the planner is off\): lane-1 on contradict\./,
  );
  const said = (body: Record<string, unknown>) => {
    const x = sentence(u, e({ n: 3, source: "fallback", assignments, ...body }));
    return String(x?.text ?? JSON.stringify(x));
  };
  assert.match(
    said({ planner_tries: 2, refused: ["try 2: lane-3 is not a lane"] }),
    /by the fixed rules: the model gave no usable plan, because lane-3 is not a lane/,
  );
  // Every try's reason, not only the first.
  assert.match(
    said({
      planner_tries: 2,
      refused: ["try 1: no JSON in the answer", "try 2: lane-3 is not a lane"],
    }),
    /because try 1: no JSON in the answer; try 2: lane-3 is not a lane\)/,
  );
  // Neither a planner switched off nor a missing model reads as a refused plan.
  assert.match(
    said({ planner_tries: 0, notes: "the planner is off on this rig (Edit rig)" }),
    /round 3 \(by the fixed rules: the planner is off on this rig \(Edit rig\)\)/,
  );
  assert.match(said({ planner_tries: 0 }), /round 3 \(by the fixed rules: no model\)/);
  // Each try's real cause (goal 079), in words: not "did not call submit_plan" for every one.
  assert.match(
    said({
      planner_tries: 2,
      refused: ["try 1: x", "try 2: y"],
      causes: [
        { try: 1, cause: "cut_off", detail: "its reply was cut off" },
        { try: 2, cause: "provider_error", detail: "the provider failed for now: 503" },
      ],
    }),
    /because try 1: its reply was cut off at the output limit \(its reply was cut off\); try 2: the provider failed \(the provider failed for now: 503\)\)/,
  );
});

test("a research run's rounds are counted as research rounds, not as planner fallbacks (goal 079)", async () => {
  const { ControlStore } = await import("../store.ts");
  const { rigView } = await import("../views.ts");
  const store = new ControlStore(":memory:");
  const ev = (kind: string, subject: string, body: Record<string, unknown>) => ({
    kind,
    subject,
    actor: "scheduler",
    at: "2026-10-22T00:00:00Z",
    body,
  });
  store.ingest({
    rig: "rig-a",
    ledger_id: "l-1",
    cursor: 0,
    next: 3,
    generated_at: "2026-10-22T00:00:00Z",
    events: [
      ev("run_created", "r-1", { mode: "research", campaign: "c" }),
      ev("epoch_started", "r-1", {
        n: 1,
        source: "fallback",
        plan: "research",
        planner_valid: false,
      }),
      ev("epoch_started", "r-1", {
        n: 2,
        source: "fallback",
        plan: "research",
        planner_valid: false,
      }),
    ].map((e, i) => ({ id: i + 1, ...e })),
    summary: {},
  } as never);
  const v = rigView(store, "rig-a", { staleAfterMs: 600_000 });
  const a = v?.runs.find((r) => r.id === "r-1")?.agents;
  assert.deepEqual([a?.epochs, a?.research_rounds, a?.fallbacks], [2, 2, 0]);
});

test("History tells a run's MCP servers, and a server that fails and comes back, in words", async () => {
  const { sentence } = await import("./words.ts");
  const u = { judge: { jobs: [] }, runs: [] } as never;
  const say = (kind: string, body: Record<string, unknown>) => {
    const x = sentence(u, {
      kind,
      subject: "r-1",
      actor: "harness",
      at: "2026-10-21T00:00:00Z",
      body,
    } as never);
    return [x?.text, x?.tone, x?.run];
  };
  assert.deepEqual(
    say("mcp_servers", {
      servers: [
        { name: "gbrain", agents: ["workers", "planner"], tools: { planner: ["search"] } },
        { name: "papers", agents: ["advisors"] },
      ],
    }),
    [
      "The run's agents can use MCP servers: gbrain for the workers and the planner; papers for the advisors.",
      "",
      "r-1",
    ],
  );
  assert.deepEqual(say("mcp_servers", { servers: [{ name: "gbrain", agents: ["workers"] }] }), [
    "The run's agents can use an MCP server: gbrain for the workers.",
    "",
    "r-1",
  ]);
  assert.deepEqual(
    say("mcp_server_failed", { server: "gbrain", agents: "planner", error: "HTTP 503" }),
    [
      "The MCP server gbrain failed for the planner: HTTP 503. The run goes on without it.",
      "warn",
      "r-1",
    ],
  );
  assert.deepEqual(say("mcp_server_back", { server: "gbrain", agents: "planner" }), [
    "The MCP server gbrain works again for the planner.",
    "ok",
    "r-1",
  ]);
  // The run's first plan or trial waited for its servers (goal 068).
  assert.deepEqual(
    say("mcp_servers_wait", {
      waited_s: 120,
      missing: [{ name: "papers", why: "control has not given it to this rig yet" }],
    }),
    [
      "The run's work started without the MCP server papers (control has not given it to this rig yet), after waiting 120 s for them. A later trial gets each one once the rig has it.",
      "warn",
      "r-1",
    ],
  );
  assert.deepEqual(say("mcp_servers_wait", { waited_s: 12, missing: [] }), [
    "The run's work waited 12 s for its MCP servers to reach the rig, then started with them.",
    "",
    "r-1",
  ]);
});

test("History tells each claim: verified, or a draft with the harness's reasons", async () => {
  const { sentence } = await import("./words.ts");
  const u = { judge: { jobs: [] }, runs: [] } as never;
  const say = (actor: string, body: Record<string, unknown>) => {
    const x = sentence(u, {
      kind: "claim_added",
      subject: "r-1",
      actor,
      at: "2026-10-21T00:00:00Z",
      body,
    } as never);
    return [x?.text, x?.tone, x?.run];
  };
  assert.deepEqual(
    say("lane-1", {
      claim: "c-1",
      verified: true,
      text: "Workers keep no state.",
      sources: ["s-1"],
      problems: [],
    }),
    ['lane-1 recorded a verified claim: "Workers keep no state.".', "ok", "r-1"],
  );
  assert.deepEqual(
    say("lane-2", {
      claim: "c-2",
      verified: false,
      text: "Question 0: Workers keep no state.",
      sources: ["https://example.com/a"],
      problems: [
        "no archived source https://example.com/a: no source was archived from that URL; fetch it first, then cite the s-… id that fetch returns",
        'the number 0 is not in the claim\'s quotes: it comes from the heading "Question 0:"',
      ],
    }),
    [
      'lane-2\'s claim stays a draft: "Question 0: Workers keep no state.". Why: no archived source https://example.com/a: no source was archived from that URL; fetch it first, then cite the s-… id that fetch returns; the number 0 is not in the claim\'s quotes: it comes from the heading "Question 0:".',
      "warn",
      "r-1",
    ],
  );
  // More than three reasons: the first three, and how many more (with those the event left out).
  const [many] = say("research", {
    verified: false,
    text: "Many numbers.",
    problems: ["a", "b", "c", "d"],
    more_problems: 5,
  });
  assert.equal(many, 'A worker\'s claim stays a draft: "Many numbers.". Why: a; b; c; and 6 more.');
  // A draft from before events carried their reasons: no reasons, no invented ones.
  assert.deepEqual(say("lane-1", { verified: false, text: "Old draft." }), [
    'lane-1\'s claim stays a draft: "Old draft.".',
    "warn",
    "r-1",
  ]);
});

test("History tells the queue's changes, the hand-outs and the rules in words", async () => {
  const { sentence } = await import("./words.ts");
  const u = {
    judge: { jobs: [] },
    runs: [{ id: "r-1", queue: [{ id: "x-1", title: "vector loads" }] }],
  } as never;
  const say = (kind: string, actor: string, body: Record<string, unknown>) =>
    String(
      sentence(u, { kind, subject: "r-1", actor, at: "2026-10-20T00:00:00Z", body } as never)?.text,
    );
  assert.equal(
    say("experiment_added", "supervisor:teacher", {
      id: "x-1",
      title: "vector loads",
      by: "teacher",
    }),
    'The teachers added "vector loads" to the queue.',
  );
  assert.equal(
    say("experiment_dropped", "control:owner:ui", { id: "x-1", by: "owner", why: "slower" }),
    'You dropped "vector loads": slower.',
  );
  assert.equal(
    say("experiment_moved", "planner", { id: "x-1", by: "planner", position: 0 }),
    'The planner moved "vector loads" to place 1.',
  );
  assert.equal(
    say("planner_handout", "planner", {
      round: 4,
      assignments: [{ lane: "lane-1", experiment: "x-1" }],
    }),
    'The planner gave out round 4: lane-1 on "vector loads".',
  );
  assert.equal(
    say("directive", "control:owner:ui", {
      id: 3,
      body: { kind: "avoid", match: "shared memory" },
    }),
    "You set a rule for the plan: avoid “shared memory”.",
  );
  // A rule names a direction as :name: (goal 066); the planner says when it designs a new one.
  assert.equal(
    say("directive", "control:owner:ui", {
      id: 4,
      body: { kind: "mandate", family: "shared-memory-tiling" },
    }),
    "You set a rule for the plan: mandate :shared-memory-tiling:.",
  );
  assert.equal(
    say("family_added", "planner:planner", {
      family: "shared-memory-tiling",
      description: "tiles staged in shared memory",
      for_rules: [4],
    }),
    "The planner designed the new direction :shared-memory-tiling: for rule 4: tiles staged in shared memory.",
  );
  assert.equal(
    say("family_added", "planner:planner", { family: "split-k", description: "split k" }),
    "The run has a new direction, :split-k: (split k).",
  );
  // The planner converts an old rule in words: one line, from its directive_converted event; the
  // new rule's own directive event (its author's, as the old one's was) says nothing more.
  assert.equal(
    say("directive_converted", "planner", {
      id: 3,
      to: 9,
      kind: "avoid",
      family: "shared-memory",
      words: "shared memory",
    }),
    "The planner converted rule 3, an old rule in words (“shared memory”), to rule 9: avoid :shared-memory:.",
  );
  assert.equal(
    sentence(u, {
      kind: "directive",
      subject: "r-1",
      actor: "control:owner:ui",
      at: "2026-10-20T00:00:00Z",
      body: {
        id: 9,
        body: {
          kind: "avoid",
          family: "shared-memory",
          converted_from: { rule: 3, words: "shared memory" },
        },
      },
    } as never),
    null,
  );
  assert.equal(
    say("directives_left_out", "supervisor", {
      rules: [{ kind: "avoid", family: "blogs" }],
      why: "A research run's directions are its task kinds.",
      reason: "unknown_direction",
    }),
    "The teachers named a direction this research run doesn't have (avoid :blogs:): left out. A research run's directions are its task kinds.",
  );
  // Goal 081: a rule that would freeze the queue's size, and a queue below its target.
  assert.equal(
    say("directives_left_out", "supervisor", {
      rules: [{ kind: "note", value: "Do not add queue entries" }],
      why: "a rule may not freeze the queue's size",
      reason: "freezes_queue",
    }),
    "The teachers gave a rule that would freeze the queue's size (note): left out. a rule may not freeze the queue's size",
  );
  assert.equal(
    say("directives_left_out", "supervisor", {
      rules: [{ kind: "priority" }, { kind: "note" }],
      why: "a rule may not pin an experiment",
      reason: "pins_experiment",
    }),
    "The teachers gave 2 rules that would pin an experiment (priority; note): left out. a rule may not pin an experiment",
  );
  assert.equal(
    say("queue_low", "planner", { round: 7, ready: 1, target: 4, lanes: 2 }),
    "After round 7, the queue had 1 of its target of 4 experiments ready: the teachers were asked for ideas at once.",
  );
  // An experiment back in the queue after its trial was interrupted: not its author's act.
  const back = {
    id: "x-2",
    title: "vector loads",
    by: "owner",
    state: "queued",
    position: "top",
  };
  assert.equal(
    say("experiment_added", "planner", {
      ...back,
      why: "tried again: its trial on lane-1 was interrupted (x-1). fewer loads",
    }),
    'Your experiment "vector loads" went back in the queue: its trial was interrupted.',
  );
  assert.equal(
    say("experiment_added", "planner", {
      ...back,
      by: "planner",
      requeued_from: { experiment: "x-1", trial: "t-1", lane: "lane-1", result: "interrupted" },
    }),
    'The planner\'s experiment "vector loads" went back in the queue: its trial was interrupted.',
  );
  assert.equal(
    say("experiment_added", "planner", {
      ...back,
      by: "lane-2",
      why: "tried again: its trial on lane-2 failed (x-1)",
    }),
    'lane-2\'s experiment "vector loads" went back in the queue: its trial failed.',
  );
  assert.equal(
    say("experiment_added", "control:owner:ui", { ...back, why: "fewer loads" }),
    'You added "vector loads" to the queue.',
  );
  // Restart the lanes, and a change on Edit rig.
  assert.equal(
    say("workers_reset", "control:owner:ui", {}),
    "You restarted the lanes: their trials ended, and every lane starts again from the champion.",
  );
  assert.equal(
    say("rig_settings_changed", "control:owner:ui", {
      change: { planner: false, lanes: 3, max_turns: null, promotion: "auto" },
      settings: {},
    }),
    "You changed the rig's settings: the planner off, 3 lanes, no turn limit, confirmed wins kept at once.",
  );
});

test("Start a run lists each rig as free, busy or other hardware; a rig of other hardware can't be chosen", () => {
  const html = startDrawer({
    campaign: "speed",
    csrf: "c",
    open: true,
    rigs: [
      { id: "gpu-a", hardware: "1× P100", busy: "speed-3", stale: false, model: "m-1" },
      { id: "gpu-b", hardware: "2× P100", stale: false },
      {
        id: "cpu-a",
        hardware: "6 CPU",
        off: "Other hardware: this campaign is measured on cuda, this rig on cpu.",
        stale: false,
      },
    ],
    models: [],
    from: "Control assigns the campaign again.",
  });
  const rigs = [
    ...html.matchAll(
      /<label class="sopt( dis)?"><input type="radio" name="rig" value="([^"]+)"[^>]*?( checked)?( disabled)?>[\s\S]*?<span class="sd">([\s\S]*?)<\/span><\/span><span class="sr">([\s\S]*?)<\/span><\/label>/g,
    ),
  ].map((m) => ({
    rig: m[2],
    checked: Boolean(m[3]),
    disabled: Boolean(m[1] && m[4]),
    says: (m[5] ?? "").replace(/<[^>]+>/g, ""),
    tag: (m[6] ?? "").replace(/<[^>]+>/g, ""),
  }));
  assert.deepEqual(rigs, [
    {
      rig: "gpu-a",
      checked: false,
      disabled: false,
      says: "Busy: speed-3 is at work there, and pauses when this run starts (a rig runs one run at a time). Agents' model: m-1.",
      tag: "busy",
    },
    {
      rig: "gpu-b",
      checked: true,
      disabled: false,
      says: "Free: no run at work. No model for its agents yet.",
      tag: "free",
    },
    {
      rig: "cpu-a",
      checked: false,
      disabled: true,
      says: "Other hardware: this campaign is measured on cuda, this rig on cpu.",
      tag: "",
    },
  ]);
});

test("History tells a compacted conversation, and how often a trial's was, in words (goal 070)", async () => {
  const { sentence } = await import("./words.ts");
  const u = { judge: { jobs: [] }, runs: [] } as never;
  const say = (kind: string, body: Record<string, unknown>) => {
    const x = sentence(u, {
      kind,
      subject: "r-1",
      actor: "harness",
      at: "2026-10-21T00:00:00Z",
      body,
    } as never);
    return [x?.text, x?.tone, x?.run];
  };
  assert.deepEqual(
    say("context_compacted", {
      trial: "t-1",
      lane: "lane-2",
      harness: "pi",
      number: 1,
      tokens_before: 104_000,
      tokens_after: 9_100,
      how: "summary",
      snapshot: "compactions/t-1-1.md",
    }),
    [
      "The harness compacted the conversation of lane-2's trial t-1 (compaction 1) at about 104,000 tokens, down to about 9,100, and it went on. The conversation before it is kept in the run's research folder, compactions/t-1-1.md.",
      "",
      "r-1",
    ],
  );
  assert.match(
    String(
      say("context_compacted", {
        trial: "t-2",
        lane: "lane-1",
        harness: "codex",
        number: 2,
        tokens_before: null,
        tokens_after: null,
        how: "harness",
        snapshot: null,
      })[0],
    ),
    /^Codex compacted the conversation of lane-1's trial t-2 \(compaction 2\), and it went on\.$/,
  );
  assert.match(
    String(
      say("trial_finished", {
        lane: "lane-1",
        attempt: "a-1",
        stopped: "submitted",
        compactions: 2,
      })[0],
    ),
    /ended submitted a-1\. Its conversation was compacted 2 times\.$/,
  );
});
