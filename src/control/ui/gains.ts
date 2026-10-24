import { figure, type MetricValues, valuesByCase, valuesWords } from "../metric-values.ts";
import type { RunView } from "../views.ts";
import { esc } from "./components.ts";
import { signed } from "./words.ts";

/**
 * A hill climb's gains with the real values they come from (goal 133): a chip `+49.0%` and, beside
 * it, `412 → 614 tok/s`, each case's values on hover. The unit is the main metric's in the run's
 * baseline (goal 115); a run without one shows the values with no unit.
 */

type Run = Pick<RunView, "baseline">;

/** The run's main metric's unit, from its baseline; undefined without one. */
export function metricUnit(r: Run): string | undefined {
  const p = r.baseline?.primary;
  return p ? r.baseline?.units[p.metric] : undefined;
}

/** A change's gain as a chip, with its values beside it when the verdict carried them. */
export function gainChip(
  r: Run,
  a: { delta: number | null; values?: MetricValues | null | undefined },
  tone = typeof a.delta === "number" ? (a.delta > 0 ? "ok" : a.delta < 0 ? "bad" : "") : "",
): string {
  if (typeof a.delta !== "number") return "";
  const unit = metricUnit(r);
  const v = a.values
    ? ` <span class="muted small" title="${esc(valuesByCase(a.values, unit))}">${esc(valuesWords(a.values, unit))}</span>`
    : "";
  return `<span class="chip ${tone}"><b>${esc(signed(a.delta))}</b></span>${v}`;
}

/** What the judge measured, in words: `+49.0% (412 → 614 tok/s)`, without the values when none. */
export function measuredWords(
  r: Run,
  a: { delta: number; values?: MetricValues | null | undefined },
): string {
  const v = a.values ? ` (${valuesWords(a.values, metricUnit(r))})` : "";
  return `${signed(a.delta)}${v}`;
}

/**
 * The starting point's value of the main metric, from the run's baseline: one case's median, or the
 * cases' geometric mean, with the unit (`412 tok/s`); empty without a baseline.
 */
export function startWords(r: Run): string {
  const b = r.baseline;
  const metric = b?.primary?.metric;
  if (!b || !metric) return "";
  const xs = b.cells.flatMap((c) =>
    c.metrics.filter((m) => m.metric === metric && m.median > 0).map((m) => m.median),
  );
  if (!xs.length) return "";
  const mean = Math.exp(xs.reduce((n, x) => n + Math.log(x), 0) / xs.length);
  const unit = metricUnit(r);
  return `${figure(mean)}${unit ? ` ${unit}` : ""}${xs.length > 1 ? `, the mean of ${xs.length} cases` : ""}`;
}
