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
  assert.equal(runState(r("running", audit)).text, "Audit");
  assert.equal(runState(r("closed", approval)).text, "Finished");
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

test("a research run's rounds read as set by the research plan, not as a refused plan", async () => {
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
    /The research plan set round 3: lane-1 on contradict\./,
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
    'The teacher pair added "vector loads" to the queue.',
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
    "The teacher pair named a direction this research run doesn't have (avoid :blogs:): left out. A research run's directions are its task kinds.",
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
