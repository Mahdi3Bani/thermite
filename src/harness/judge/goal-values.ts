import type { Kit } from "../kit.ts";
import type { ArmRun } from "./measure.ts";

/**
 * What a code verifier's goal measured (goal 086). A met goal used to say only "verifier V passed
 * on a, b", so a report had no numbers (for example a quality ratio). Now each public cell's run
 * keeps its values, in the goal report, its event and the goal's reasons, in words as a metric
 * threshold goal gives its own.
 *
 * Never a held-out cell's: the held-out pass keeps names and kinds only (goal 082), so the judge
 * collects no values in it.
 */
export interface GoalCellValues {
  cell: string;
  /** Whether the cell's run passed the kit's check. */
  ok: boolean;
  /** The kit's metrics as the judge worked them out, by name, in the kit's order. */
  metrics: Record<string, number>;
}

/** At most this many cells' values a goal keeps. */
export const GOAL_VALUES_CELLS = 100;

/**
 * One run's values. A run that passed: every kit metric the judge worked out. A run whose output
 * the kit's check refused: the numbers the check reported for the kit's metrics taken from the
 * check, so an unmet goal shows by how much. A crash or refused outputs: none.
 */
export function runValues(kit: Pick<Kit, "metrics">, r: ArmRun): Record<string, number> {
  if (r.kind === "ok") {
    return Object.fromEntries(Object.entries(r.metrics).filter(([, v]) => Number.isFinite(v)));
  }
  if (r.kind !== "invalid") return {};
  const out: Record<string, number> = {};
  for (const [name, m] of Object.entries(kit.metrics)) {
    if (!("from" in m) || m.from !== "check") continue;
    const v = r.check.details[m.field];
    if (typeof v === "number" && Number.isFinite(v)) out[name] = v;
  }
  return out;
}

/**
 * A goal's values read back from a rig's goal report, each field checked: the report is data.
 * Null when it has none (another kind of goal, or a report from an older harness).
 */
export function parseGoalValues(raw: unknown): GoalCellValues[] | null {
  if (!Array.isArray(raw)) return null;
  const out: GoalCellValues[] = [];
  for (const c of raw.slice(0, GOAL_VALUES_CELLS)) {
    if (!c || typeof c !== "object") continue;
    const { cell, ok, metrics } = c as Record<string, unknown>;
    if (typeof cell !== "string" || !metrics || typeof metrics !== "object") continue;
    out.push({
      cell: cell.slice(0, 200),
      ok: ok === true,
      metrics: Object.fromEntries(
        Object.entries(metrics as Record<string, unknown>)
          .filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]))
          .map(([k, v]) => [k.slice(0, 200), v]),
      ),
    });
  }
  return out.length ? out : null;
}

/** A value as a threshold goal's reasons give one: six significant figures. */
const fig = (v: number) => v.toPrecision(6);

/**
 * Cells' values in words, as a threshold goal's reasons give its own: "small: ops_per_s
 * 4.51235e+7, value 4.20000e+7; big: ops_per_s 4.40000e+7". At most GOAL_VALUES_CELLS cells, and
 * how many more.
 */
export function valuesText(cells: readonly GoalCellValues[]): string {
  const shown = cells.slice(0, GOAL_VALUES_CELLS).map(
    (c) =>
      `${c.cell}: ${Object.entries(c.metrics)
        .map(([k, v]) => `${k} ${fig(v)}`)
        .join(", ")}`,
  );
  const more = cells.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more cells` : ""}`;
}
