import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type GoalContract, type HillClimbContract, parseContract } from "../../core/contract.ts";
import { goalFixture, hillClimbFixture } from "../../testing/fixtures.ts";
import { type Block, decideConfirm, decideScreen, decideThresholdGoal } from "./decide.ts";

function hillClimb(overrides: Record<string, unknown> = {}): HillClimbContract {
  const r = parseContract({ ...hillClimbFixture, ...overrides });
  if (!r.ok || r.contract.mode !== "hill_climb") throw new Error("fixture");
  return r.contract;
}

/** Deterministic normal noise (mulberry32 + Box-Muller). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

/** Blocks where the candidate's metric is `gain` times the reference's, with relative noise. */
function blocks(
  n: number,
  cells: string[],
  effects: Record<string, number>,
  noise = 0.002,
  seed = 1,
): Block[] {
  const z = rng(seed);
  return Array.from({ length: n }, () => {
    const b: Block = { candidate: {}, reference: {} };
    for (const [metric, gain] of Object.entries(effects)) {
      b.candidate[metric] = {};
      b.reference[metric] = {};
      for (const c of cells) {
        const base = 100 * (1 + noise * z());
        b.reference[metric][c] = base;
        b.candidate[metric][c] = base * gain * (1 + noise * z());
      }
    }
    return b;
  });
}

describe("screening", () => {
  const policy = hillClimb({
    guards: [
      {
        metric: "mem_mib",
        direction: "min",
        max_step_regression: 0.01,
        max_total_regression: 0.02,
      },
    ],
  });
  const cells = policy.cells;

  test("a no-op is neutral", () => {
    const d = decideScreen(policy, blocks(9, cells, { gflops: 1, mem_mib: 1 }, 0.0005));
    assert.equal(d.verdict, "neutral", d.reasons);
  });

  test("a clear gain with guards held is win_screened at the first look", () => {
    const d = decideScreen(policy, blocks(3, cells, { gflops: 1.05, mem_mib: 1 }));
    assert.equal(d.verdict, "win_screened", d.reasons);
  });

  test("a clear loss is regress", () => {
    assert.equal(
      decideScreen(policy, blocks(3, cells, { gflops: 0.95, mem_mib: 1 })).verdict,
      "regress",
    );
  });

  test("a gain bought with a guard regression is a tradeoff", () => {
    // Memory is minimized, so 5% more memory is a 5% regression against a 1% step margin.
    const d = decideScreen(policy, blocks(3, cells, { gflops: 1.05, mem_mib: 1.05 }));
    assert.equal(d.verdict, "tradeoff", d.reasons);
  });

  test("an undecided early look continues, and the last look decides", () => {
    const noisy = blocks(9, cells, { gflops: 1.004, mem_mib: 1 }, 0.02, 3);
    assert.equal(decideScreen(policy, noisy.slice(0, 3)).verdict, undefined);
    assert.equal(decideScreen(policy, noisy).verdict, "inconclusive");
  });

  test("hard constraints make a candidate infeasible", () => {
    const p = hillClimb({
      guards: [],
      hard_constraints: [{ kind: "max", metric: "mem_mib", value: 50 }],
    });
    const d = decideScreen(p, blocks(3, p.cells, { gflops: 1.1, mem_mib: 1 }));
    assert.equal(d.verdict, "infeasible", d.reasons);
  });

  test("NaN never becomes a score", () => {
    const b = blocks(3, cells, { gflops: 1.05, mem_mib: 1 });
    (b[1] as Block).candidate.gflops = {
      ...(b[1] as Block).candidate.gflops,
      [cells[0] as string]: Number.NaN,
    };
    assert.throws(() => decideScreen(policy, b), RangeError);
  });

  test("A/A false wins stay under the screen's alpha", () => {
    const p = hillClimb({
      guards: [],
      objective: { primary: { metric: "gflops", direction: "max", min_effect: 0.001 } },
    });
    let wins = 0;
    const trials = 1500;
    for (let s = 0; s < trials; s++) {
      const all = blocks(9, p.cells, { gflops: 1 }, 0.01, 1000 + s);
      for (const look of p.acceptance.looks) {
        const v = decideScreen(p, all.slice(0, look)).verdict;
        if (v === "win_screened") wins++;
        if (v !== undefined) break;
      }
    }
    assert.ok(wins / trials < p.acceptance.alpha_screen / 2, `false win rate ${wins / trials}`);
  });
});

describe("confirmation", () => {
  const policy = hillClimb({
    guards: [
      {
        metric: "mem_mib",
        direction: "min",
        max_step_regression: 0.01,
        max_total_regression: 0.02,
      },
    ],
  });

  test("a real gain confirms on fresh data; no gain does not", () => {
    assert.equal(
      decideConfirm(policy, blocks(5, policy.cells, { gflops: 1.05, mem_mib: 1 }, 0.002, 9))
        .verdict,
      "win_confirmed",
    );
    assert.equal(
      decideConfirm(policy, blocks(5, policy.cells, { gflops: 1, mem_mib: 1 }, 0.002, 9)).verdict,
      "not_confirmed",
    );
  });

  test("a step within its margin still fails once the cumulative allowance is spent", () => {
    const fresh = blocks(5, policy.cells, { gflops: 1.05, mem_mib: 1.006 }, 0.0005, 4);
    assert.equal(decideConfirm(policy, fresh).verdict, "win_confirmed");
    const d = decideConfirm(policy, fresh, { mem_mib: -0.018 });
    assert.equal(d.verdict, "tradeoff", d.reasons);
  });
});

describe("goal thresholds", () => {
  const r = parseContract(goalFixture);
  if (!r.ok || r.contract.mode !== "goal") throw new Error("fixture");
  const contract: GoalContract = r.contract;
  const goal = contract.goals.find((g) => g.verify.type === "metric_threshold");
  const verify = goal?.verify;
  if (!goal || verify?.type !== "metric_threshold")
    throw new Error("fixture has no threshold goal");
  const cells = verify.cells ?? ["c1"];
  const target = verify.value;
  const around = (centre: number, spread: number) =>
    Object.fromEntries(cells.map((c) => [c, [centre - spread, centre, centre + spread]]));

  test("met, unmet, inconclusive and not runnable", () => {
    const passSide = verify.op.startsWith(">") ? 1 : -1;
    assert.equal(
      decideThresholdGoal(goal, around(target + passSide * 10, 0.1), 0.05).status,
      "met",
    );
    assert.equal(
      decideThresholdGoal(goal, around(target - passSide * 10, 0.1), 0.05).status,
      "unmet",
    );
    assert.equal(decideThresholdGoal(goal, around(target, 1), 0.05).status, "inconclusive");
    assert.equal(decideThresholdGoal(goal, {}, 0.05).status, "not_runnable");
    const single = Object.fromEntries(cells.map((c) => [c, [target + passSide * 10]]));
    assert.equal(decideThresholdGoal(goal, single, 0.05).status, "inconclusive");
  });
});
