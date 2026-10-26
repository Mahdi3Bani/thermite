import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  logImprovement,
  meanInterval,
  studentTCdf,
  studentTQuantile,
  toFraction,
  toLog,
} from "../../src/core/stats.ts";

const reference = JSON.parse(
  readFileSync(new URL("../helpers/data/stats-reference.json", import.meta.url), "utf8"),
) as {
  t_quantile: [number, number, number][];
  t_cdf: [number, number, number][];
  mean_interval: { xs: number[]; alpha: number; mean: number; low: number; high: number }[];
};

const close = (got: number, want: number, rel = 1e-9) =>
  assert.ok(Math.abs(got - want) <= rel * Math.max(1, Math.abs(want)), `got ${got}, want ${want}`);

describe("statistics against offline reference values", () => {
  test("Student-t quantiles", () => {
    for (const [p, df, want] of reference.t_quantile) close(studentTQuantile(p, df), want);
  });

  test("Student-t distribution function", () => {
    for (const [t, df, want] of reference.t_cdf) close(studentTCdf(t, df), want);
  });

  test("mean intervals", () => {
    for (const r of reference.mean_interval) {
      const i = meanInterval(r.xs, r.alpha);
      close(i.estimate, r.mean);
      close(i.low, r.low);
      close(i.high, r.high);
    }
  });
});

describe("log improvements", () => {
  test("positive means better in both directions", () => {
    assert.ok(logImprovement(110, 100, "max") > 0);
    assert.ok(logImprovement(90, 100, "min") > 0);
    close(toFraction(logImprovement(110, 100, "max")), 0.1);
    close(toFraction(toLog(0.005)), 0.005);
  });

  test("NaN, infinities, zeros and negatives are never scores", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      assert.throws(() => logImprovement(bad, 1, "max"), RangeError);
      assert.throws(() => logImprovement(1, bad, "max"), RangeError);
    }
    assert.throws(() => meanInterval([1, Number.NaN, 2], 0.05), RangeError);
    assert.throws(() => meanInterval([1], 0.05), RangeError);
  });
});
