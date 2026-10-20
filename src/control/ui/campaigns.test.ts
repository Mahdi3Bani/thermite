import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignView, RigView, RunView } from "../views.ts";
import { campaignFilter, campaignKind, campaignsListBody, isRigCheck } from "./campaigns.ts";

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
  // Neither a planner switched off nor a missing model reads as a refused plan.
  assert.match(
    said({ planner_tries: 0, notes: "the planner is off on this rig (Edit rig)" }),
    /round 3 \(by the fixed rules: the planner is off on this rig \(Edit rig\)\)/,
  );
  assert.match(said({ planner_tries: 0 }), /round 3 \(by the fixed rules: no model\)/);
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
    "You set a rule for the plan: avoid shared memory.",
  );
});
