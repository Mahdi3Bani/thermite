import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CallUsage,
  callUsage,
  quantile,
  sumUsage,
  type UsageRow,
  usageReport,
  usageSince,
} from "./usage.ts";

const row = (o: Partial<UsageRow> = {}): UsageRow => ({
  rig: "rig-1",
  run: "run-1",
  campaign: "matmul",
  agent: "workers",
  harness: "pi",
  provider: "p",
  model: "m-1",
  calls: 1,
  at: "2026-10-21T10:00:00.000Z",
  tokens_in: 1000,
  cached_in: null,
  tokens_out: 100,
  reasoning: null,
  first_token_ms: null,
  call_ms: null,
  ...o,
});

describe("model usage records", () => {
  test("a measure becomes a record: whole numbers, cached input within the input, the rest not cached", () => {
    const u = callUsage({
      at: Date.parse("2026-10-21T10:00:00Z"),
      calls: 1,
      tokensIn: 1200.4,
      cachedIn: 1500,
      tokensOut: 50,
      reasoning: 80,
      firstTokenMs: -5,
      callMs: 2000,
    });
    assert.deepEqual(u, {
      calls: 1,
      at: "2026-10-21T10:00:00.000Z",
      tokens_in: 1200,
      cached_in: 1200,
      uncached_in: 0,
      tokens_out: 50,
      reasoning: 50,
      first_token_ms: 0,
      call_ms: 2000,
    });
    assert.ok(CallUsage.safeParse(u).success);
  });

  test("a figure the harness does not report stays null, never 0", () => {
    const u = callUsage({ at: 0, tokensIn: 300, tokensOut: 20 });
    assert.equal(u.calls, null);
    assert.equal(u.cached_in, null);
    assert.equal(u.uncached_in, null);
    assert.equal(u.reasoning, null);
    assert.equal(u.first_token_ms, null);
    assert.equal(u.call_ms, null);
    // A time beyond a week is not a call's time.
    assert.equal(
      callUsage({ at: 0, tokensIn: 1, tokensOut: 1, callMs: 8 * 86_400_000 }).call_ms,
      null,
    );
  });

  test("a record whose cache figures do not add up, or whose reasoning passes its output, is refused", () => {
    const good = callUsage({ at: 0, tokensIn: 100, cachedIn: 40, tokensOut: 10 });
    assert.ok(CallUsage.safeParse(good).success);
    assert.equal(CallUsage.safeParse({ ...good, uncached_in: 59 }).success, false);
    assert.equal(CallUsage.safeParse({ ...good, cached_in: null }).success, false);
    assert.equal(CallUsage.safeParse({ ...good, reasoning: 11 }).success, false);
    assert.equal(CallUsage.safeParse({ ...good, tokens_in: -1 }).success, false);
  });
});

describe("model usage sums", () => {
  test("quantiles interpolate between ranks, as R's type 7 does", () => {
    const xs = [1, 2, 3, 4];
    assert.equal(quantile(xs, 0.5), 2.5);
    assert.ok(Math.abs((quantile(xs, 0.1) as number) - 1.3) < 1e-9);
    assert.ok(Math.abs((quantile(xs, 0.9) as number) - 3.7) < 1e-9);
    assert.equal(quantile([7], 0.9), 7);
    assert.equal(quantile([], 0.5), undefined);
  });

  test("sums count each figure over the records that report it, and say how many do not", () => {
    const rows = [
      row({ cached_in: 600, reasoning: 30, call_ms: 1000, first_token_ms: 200, tokens_out: 100 }),
      row({ cached_in: 0, call_ms: 2000, first_token_ms: 400, tokens_out: 100 }),
      row({ call_ms: 4000, tokens_out: 100 }),
      // A Codex turn: no count of calls, no time.
      row({ calls: null, harness: "codex", tokens_in: 5000, tokens_out: 0 }),
      // A call that failed: a time, no output; left out of the speed.
      row({ call_ms: 500, tokens_in: 0, tokens_out: 0 }),
    ];
    const s = sumUsage(rows);
    assert.equal(s.records, 5);
    assert.equal(s.calls, 4);
    assert.equal(s.calls_not_reported, 1);
    assert.equal(s.tokens_in, 8000);
    assert.equal(s.tokens_out, 300);
    assert.equal(s.cached_in, 600);
    assert.equal(s.uncached_in, 1400);
    assert.equal(s.cached_share, 0.3);
    assert.equal(s.reasoning, 30);
    assert.equal(s.call_ms, 7500);
    // Speeds 100, 50 and 25 tokens a second.
    assert.deepEqual(s.out_per_s, { median: 50, p10: 30, p90: 90 });
    assert.equal(s.first_token_ms, 300);
    assert.deepEqual(s.not_reported, { cached: 3, reasoning: 4, time: 1, first_token: 3 });
  });

  test("with no record reporting a figure, its sum is null, never 0", () => {
    const s = sumUsage([row(), row({ calls: null })]);
    assert.equal(s.cached_in, null);
    assert.equal(s.uncached_in, null);
    assert.equal(s.cached_share, null);
    assert.equal(s.reasoning, null);
    assert.equal(s.out_per_s, null);
    assert.equal(s.call_ms, null);
    assert.equal(s.first_token_ms, null);
    const none = sumUsage([]);
    assert.equal(none.records, 0);
    assert.equal(none.tokens_in, 0);
    assert.equal(none.cached_in, null);
  });

  test("periods: today from midnight UTC, the last 7 days, or all", () => {
    const now = new Date("2026-10-21T15:30:00Z");
    assert.equal(usageSince("today", now), "2026-10-21T00:00:00.000Z");
    assert.equal(usageSince("7d", now), "2026-10-14T15:30:00.000Z");
    assert.equal(usageSince("all", now), null);
  });

  test("a report: by agent in the agents' order, by model most tokens first, a campaign's runs with their shares", () => {
    const rows = [
      row({ agent: "panel", tokens_in: 100, tokens_out: 0 }),
      row({ agent: "workers", run: "run-2", rig: "rig-2", tokens_in: 2900, tokens_out: 100 }),
      row({ agent: "planner", model: "m-2", tokens_in: 900, tokens_out: 0 }),
    ];
    const r = usageReport(rows, { kind: "campaign", campaign: "matmul" }, "all", null);
    assert.deepEqual(
      r.by_agent.map((a) => [a.agent, a.name]),
      [
        ["workers", "Workers"],
        ["planner", "Planner"],
        ["panel", "Review panel"],
      ],
    );
    assert.deepEqual(
      r.by_model.map((m) => [m.model, m.tokens_in + m.tokens_out]),
      [
        ["m-1", 3100],
        ["m-2", 900],
      ],
    );
    assert.deepEqual(
      r.by_run?.map((x) => [x.rig, x.run, x.share]),
      [
        ["rig-2", "run-2", 0.75],
        ["rig-1", "run-1", 0.25],
      ],
    );
    assert.equal(r.by_campaign, undefined);
    const all = usageReport(rows, { kind: "system" }, "today", "2026-10-21T00:00:00.000Z");
    assert.deepEqual(
      all.by_campaign?.map((c) => [c.campaign, c.share]),
      [["matmul", 1]],
    );
    assert.equal(all.by_run, undefined);
    assert.equal(all.since, "2026-10-21T00:00:00.000Z");
  });
});
