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
  const refused = sentence(u, e({ n: 3, source: "fallback", assignments }));
  assert.match(String(refused?.text ?? JSON.stringify(refused)), /the model's plan was refused/);
});
