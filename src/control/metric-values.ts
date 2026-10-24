import type { RunView } from "./views.ts";

/**
 * A hill climb's main metric in real values beside its gains (goal 133). The judge's verdict event
 * carries the values the gain comes from: in each case, the median of the candidate and of the
 * champion it was compared with. A page shows `412 → 614 tok/s (+49.0%)`, not only `+49.0%`.
 */

export interface MetricValues {
  metric: string;
  cells: { cell: string; candidate: number; reference: number }[];
}

/** A verdict event's `values`, or null when it has none (an older harness, a crash, a goal run). */
export function metricValuesOf(raw: unknown): MetricValues | null {
  const v = raw as { metric?: unknown; cells?: unknown } | null | undefined;
  if (typeof v?.metric !== "string" || !Array.isArray(v.cells)) return null;
  const cells = (v.cells as Record<string, unknown>[]).flatMap((c) =>
    typeof c.cell === "string" &&
    typeof c.candidate === "number" &&
    typeof c.reference === "number" &&
    Number.isFinite(c.candidate) &&
    Number.isFinite(c.reference)
      ? [{ cell: c.cell, candidate: c.candidate, reference: c.reference }]
      : [],
  );
  return cells.length ? { metric: v.metric, cells } : null;
}

/** A number as people read it: three significant figures, with thousands separators. */
export function figure(x: number): string {
  if (x === 0) return "0";
  const digits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(x))));
  return x.toLocaleString("en-US", { maximumFractionDigits: Math.min(digits, 6) });
}

/** The geometric mean of positive numbers, as the gain over several cases is; else the mean. */
export function mean(xs: number[]): number {
  if (xs.length === 1) return xs[0] as number;
  return xs.every((x) => x > 0)
    ? Math.exp(xs.reduce((n, x) => n + Math.log(x), 0) / xs.length)
    : xs.reduce((n, x) => n + x, 0) / xs.length;
}

/**
 * Both sides in words, the reference first: `412 → 614 tok/s` for one case; for several, their
 * geometric means, with how many cases (`412 → 614 tok/s, the mean of 3 cases`).
 */
export function valuesWords(v: MetricValues, unit?: string | undefined): string {
  const u = unit ? ` ${unit}` : "";
  const ref = mean(v.cells.map((c) => c.reference));
  const cand = mean(v.cells.map((c) => c.candidate));
  const many = v.cells.length > 1 ? `, the mean of ${v.cells.length} cases` : "";
  return `${figure(ref)} → ${figure(cand)}${u}${many}`;
}

/** Each case's values, a line each, for a tooltip: `small: 412 → 614 tok/s`. */
export function valuesByCase(v: MetricValues, unit?: string | undefined): string {
  const u = unit ? ` ${unit}` : "";
  return v.cells
    .map((c) => `${c.cell}: ${figure(c.reference)} → ${figure(c.candidate)}${u}`)
    .join("\n");
}

/**
 * The champion's measured value against the starting point's, on the run's own rig: the starting
 * point's from the run's baseline (goal 115), the champion's from its confirming verdict's values
 * (its own side). Each null when the run has none; null when it has neither.
 */
export function championValues(
  r: Pick<RunView, "baseline" | "champion" | "attempts">,
): { start: number | null; champion: number | null; unit: string | null } | null {
  const metric = r.baseline?.primary?.metric;
  const starts = (r.baseline?.cells ?? []).flatMap((c) =>
    c.metrics.filter((m) => m.metric === metric).map((m) => m.median),
  );
  const step = r.champion.filter((c) => !c.reopened).at(-1);
  const values = step?.attempt ? r.attempts.find((a) => a.id === step.attempt)?.values : null;
  const start = starts.length ? mean(starts) : null;
  const champion = values
    ? mean(values.cells.map((c) => c.candidate))
    : step?.attempt
      ? null
      : start;
  if (start === null && champion === null) return null;
  const unit = metric ? (r.baseline?.units[metric] ?? null) : null;
  return { start, champion, unit };
}

/** championValues in words: `412 → 614 tok/s`, or only the side known; empty with neither. */
export function championWords(r: Pick<RunView, "baseline" | "champion" | "attempts">): string {
  return pairWords(championValues(r));
}

/** A start and a champion value in words (championWords). */
export function pairWords(v: ReturnType<typeof championValues>): string {
  if (!v) return "";
  const u = v.unit ? ` ${v.unit}` : "";
  if (v.start !== null && v.champion !== null)
    return `${figure(v.start)} → ${figure(v.champion)}${u}`;
  return `${figure((v.champion ?? v.start) as number)}${u}`;
}
