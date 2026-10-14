import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startFakeModel } from "../../testing/fake-model.ts";
import { modelConfigFromEnv } from "./model.ts";
import { fallbackPlan, type PlannerInput, plan, validatePlan } from "./planner.ts";

const base: PlannerInput = {
  instance: "i",
  epoch: 2,
  laneCount: 2,
  objective: "increase x",
  editablePaths: ["src/**"],
  champion: { seq: 1, gain: 0 },
  families: [
    {
      id: "tiling",
      description: "tile loops",
      status: "live",
      attempts: 3,
      verdicts: {},
      best_delta: 0.1,
    },
    {
      id: "unroll",
      description: "unroll loops",
      status: "live",
      attempts: 1,
      verdicts: {},
      best_delta: null,
    },
  ],
  evidence: [],
  directives: [],
  laneBests: { "lane-1": null, "lane-2": null },
};
const model = (url: string) => ({
  baseUrl: url,
  model: "m",
  apiKey: "k",
  contextWindow: 32000,
  maxTokens: 2000,
});

describe("planner", () => {
  test("AVOID families are never assigned and MANDATE families always are", () => {
    const input: PlannerInput = {
      ...base,
      directives: [
        {
          id: 1,
          body: { kind: "avoid", family: "tiling", rationale: "measured null", citations: [] },
        },
        {
          id: 2,
          body: { kind: "mandate", family: "vectorize", rationale: "try SIMD", citations: [] },
        },
      ],
    };
    const bad = validatePlan(
      {
        assignments: [
          { lane: "lane-1", family: "tiling", focus: "x tiles", parent: "champion" },
          { lane: "lane-2", family: "unroll", focus: "unroll 4", parent: "champion" },
        ],
      },
      input,
    );
    assert.ok(bad.errors.some((e) => /AVOID/.test(e)));
    assert.ok(bad.errors.some((e) => /MANDATE/.test(e)));
    const f = fallbackPlan(input);
    assert.ok(!f.assignments.some((a) => a.family === "tiling"));
    assert.ok(f.assignments.some((a) => a.family === "vectorize"));
    assert.deepEqual(
      f.newFamilies.map((x) => x.id),
      ["vectorize"],
    );
  });

  test("a valid model plan is used; an invalid one is retried, then the fallback takes over", async () => {
    let call = 0;
    const good = {
      assignments: [
        { lane: "lane-1", family: "unroll", focus: "unroll by 4", parent: "champion" },
        { lane: "lane-2", family: "simd", focus: "use vectors", parent: "champion" },
      ],
      new_families: [{ id: "simd", description: "vector instructions" }],
    };
    const wrong = {
      assignments: [{ lane: "lane-1", family: "nonexistent", focus: "?", parent: "lane_best" }],
    };
    const fake = await startFakeModel(() => {
      call++;
      return { toolCalls: [{ name: "submit_plan", args: call === 1 ? wrong : good }] };
    });
    const p = await plan(base, model(fake.url));
    assert.equal(p.source, "planner");
    assert.equal(p.tries, 2);
    assert.ok(p.rawViolations.length > 0);
    assert.deepEqual(
      p.newFamilies.map((f) => f.id),
      ["simd"],
    );
    await fake.close();

    const never = await startFakeModel(() => ({ text: "I would rather not plan." }));
    const q = await plan(base, model(never.url));
    assert.equal(q.source, "fallback");
    assert.equal(q.valid, false);
    assert.equal(q.assignments.length, 2);
    await never.close();
  });

  test("reasoning effort is sent only when configured; off sends none", async () => {
    const seen: (string | undefined)[] = [];
    const fake = await startFakeModel(({ reasoning_effort }) => {
      seen.push(reasoning_effort);
      return { text: "no plan" };
    });
    const env = { QWEN_BASE_URL: fake.url, QWEN_MODEL: "m", QWEN_API_KEY: "k" };
    for (const effort of [undefined, "none", "high"]) {
      const cfg = modelConfigFromEnv({ ...env, QWEN_REASONING_EFFORT: effort });
      assert.ok(cfg);
      seen.length = 0;
      await plan(base, cfg);
      assert.ok(seen.length > 0);
      assert.deepEqual(new Set(seen), new Set([effort]));
    }
    assert.throws(() => modelConfigFromEnv({ ...env, QWEN_REASONING_EFFORT: "max" }), /must be/);
    await fake.close();
  });
});
