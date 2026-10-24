import assert from "node:assert/strict";
import { test } from "node:test";
import { metricValues } from "../harness/judge/decide.ts";
import { figure, metricValuesOf, valuesByCase, valuesWords } from "./metric-values.ts";
import { gainChip, measuredWords, startWords } from "./ui/gains.ts";

test("the judge's values are each case's median of each side, as the gain compares them", () => {
  const block = (c: number, r: number) => ({
    candidate: { small: { ops: c } },
    reference: { small: { ops: r } },
  });
  const v = metricValues([block(600, 400), block(614, 412), block(650, 420)], "ops", [
    "small",
    "big",
  ]);
  // The big case has no values in these blocks: it is left out, never given a zero.
  assert.deepEqual(v, {
    metric: "ops",
    cells: [{ cell: "small", candidate: 614, reference: 412 }],
  });
});

test("an event's values are read leniently; one with none, or an older harness's, gives null", () => {
  assert.equal(metricValuesOf(undefined), null);
  assert.equal(metricValuesOf({ metric: "ops", cells: [] }), null);
  assert.deepEqual(
    metricValuesOf({
      metric: "ops",
      cells: [
        { cell: "a", candidate: 2, reference: 1 },
        { cell: "b", candidate: "x", reference: 1 },
      ],
    }),
    { metric: "ops", cells: [{ cell: "a", candidate: 2, reference: 1 }] },
  );
});

test("values in words: one case as it is, several as their geometric mean, with the unit", () => {
  const one = { metric: "tok_s", cells: [{ cell: "small", candidate: 614.2, reference: 412.4 }] };
  assert.equal(valuesWords(one, "tok/s"), "412 → 614 tok/s");
  const two = {
    metric: "tok_s",
    cells: [
      { cell: "small", candidate: 400, reference: 100 },
      { cell: "big", candidate: 100, reference: 100 },
    ],
  };
  assert.equal(valuesWords(two, "tok/s"), "100 → 200 tok/s, the mean of 2 cases");
  assert.equal(valuesByCase(two, "tok/s"), "small: 100 → 400 tok/s\nbig: 100 → 100 tok/s");
  assert.equal(figure(0.012345), "0.0123");
  assert.equal(figure(123456.7), "123,457");
});

test("a gain shows its values beside it, and the starting point its own, from the baseline", () => {
  const run = {
    baseline: {
      primary: { metric: "tok_s", direction: "max" },
      units: { tok_s: "tok/s" },
      cells: [{ cell: "small", metrics: [{ metric: "tok_s", median: 412, mad: 3, n: 9 }] }],
    },
  } as unknown as Parameters<typeof gainChip>[0];
  const values = { metric: "tok_s", cells: [{ cell: "small", candidate: 614, reference: 412 }] };
  const chip = gainChip(run, { delta: 0.4897, values });
  assert.match(chip, /<span class="chip ok"><b>\+49\.0%<\/b><\/span>/);
  assert.match(
    chip,
    /<span class="muted small" title="small: 412 → 614 tok\/s">412 → 614 tok\/s<\/span>/,
  );
  assert.equal(gainChip(run, { delta: null, values }), "");
  // An older harness's verdict, with no values: the chip alone.
  assert.doesNotMatch(gainChip(run, { delta: 0.1, values: null }), /→/);
  assert.equal(measuredWords(run, { delta: 0.4897, values }), "+49.0% (412 → 614 tok/s)");
  assert.equal(startWords(run), "412 tok/s");
  assert.equal(startWords({ baseline: null } as unknown as Parameters<typeof startWords>[0]), "");
});
