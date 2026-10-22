import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hillClimbFixture } from "../testing/fixtures.ts";
import { contractSha, parseContract } from "./contract.ts";
import { ideaWords, queueTarget, queueTargetWords, ruleRefusal } from "./queue-target.ts";

describe("a run's target queue depth (goal 081)", () => {
  test("two for each lane by default; the contract's own number when it sets one", () => {
    assert.equal(queueTarget({ lanes: { count: 3 } }), 6);
    assert.equal(queueTarget({ lanes: { count: 3 } }, 2), 4, "the lanes now count");
    assert.equal(queueTarget({ lanes: { count: 3, queue_target: 9 } }, 2), 9);
    assert.equal(queueTarget({ lanes: { count: 3, queue_target: 0 } }), 0);
    assert.equal(queueTargetWords({ lanes: { count: 2 } }), "4 (2 for each of 2 lanes)");
    assert.equal(queueTargetWords({ lanes: { count: 1 } }), "2 (2 for each of 1 lane)");
    assert.equal(
      queueTargetWords({ lanes: { count: 2, queue_target: 7 } }),
      "7 (the campaign's own number)",
    );
    assert.equal(
      queueTargetWords({ lanes: { count: 2, queue_target: 0 } }),
      "0 (no ideas are asked for)",
    );
  });

  test("the contract takes it in lanes, and a contract without it keeps its hash", () => {
    const base = hillClimbFixture;
    const before = parseContract(base);
    assert.ok(before.ok);
    const lanes = { count: 2, trials_per_epoch: 3 };
    const set = parseContract({ ...base, lanes: { ...lanes, queue_target: 8 } });
    assert.ok(set.ok);
    assert.equal(set.contract.lanes.queue_target, 8);
    assert.equal(before.contract.lanes.queue_target, undefined);
    assert.equal(contractSha(before.contract), before.sha);
    const bad = parseContract({ ...base, lanes: { ...lanes, queue_target: -1 } });
    assert.ok(!bad.ok);
    assert.match(bad.errors.join(";"), /lanes\.queue_target/);
  });

  test("two ideas with the same words are one", () => {
    assert.equal(ideaWords("  Wider loads (float4)! "), "wider loads float4");
    assert.equal(ideaWords("wider-loads float4"), ideaWords("Wider loads: float4"));
    assert.notEqual(ideaWords("wider loads"), ideaWords("narrow loads"));
  });
});

describe("rules code refuses (goal 081)", () => {
  const rule = (rationale: string, more: Record<string, unknown> = {}) =>
    ruleRefusal({ kind: "note", rationale, ...more });

  test("a rule that freezes the queue's size is refused, with why", () => {
    for (const words of [
      "Do not add queue entries until the sweep finishes",
      "keep the queue unchanged",
      "Keep the queue as it is for now",
      "freeze the queue",
      "No new experiments: the lanes have enough",
      "don't propose more experiments for the queue",
      "the queue is frozen",
      "at most 2 experiments in the queue",
    ]) {
      const r = rule(words);
      assert.equal(r?.reason, "freezes_queue", words);
      assert.match(r?.why ?? "", /may not freeze the queue's size/);
    }
    // In the value or the direction too.
    assert.equal(
      ruleRefusal({ kind: "note", value: "Do not add queue entries", rationale: "steady" })?.reason,
      "freezes_queue",
    );
  });

  test("a rule that pins an experiment is refused, with why", () => {
    for (const r of [
      rule("keep x-0123456789ab at the top until it is measured"),
      rule("retry x-0123456789ab first"),
      ruleRefusal({ kind: "priority", value: "x-0123456789ab", rationale: "it was tried again" }),
      ruleRefusal({ kind: "mandate", family: "tiling", rationale: "x-0123456789ab must run" }),
    ]) {
      assert.equal(r?.reason, "pins_experiment");
      assert.match(r?.why ?? "", /may not pin an experiment \(x-0123456789ab\)/);
    }
  });

  test("ordinary rules stand", () => {
    for (const words of [
      "tiling measured null three times (a-1, a-2, a-3)",
      "the queue holds two tiling experiments; prefer the memory ones",
      "x-0123456789ab showed reads dominate: look at the loads",
      "add experiments on vector loads",
    ])
      assert.equal(rule(words), undefined, words);
    assert.equal(
      ruleRefusal({ kind: "avoid", family: "loop-tiling", rationale: "null in a-4" }),
      undefined,
    );
  });
});
