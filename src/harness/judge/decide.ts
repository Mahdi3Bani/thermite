import type { GoalContract, HillClimbContract } from "../../core/contract.ts";
import {
  type Interval,
  logImprovement,
  meanInterval,
  toFraction,
  toLog,
} from "../../core/stats.ts";

/**
 * The judge's decision rules. Pure functions over measured blocks: no I/O, no clock, so the
 * same data always gives the same verdict. Effects are log ratios, positive meaning better.
 */

/** One interleaved block: per arm, metric -> cell -> value. */
export interface Block {
  candidate: Record<string, Record<string, number>>;
  reference: Record<string, Record<string, number>>;
}

export type ScreenVerdict =
  | "win_screened"
  | "neutral"
  | "regress"
  | "tradeoff"
  | "infeasible"
  | "inconclusive";

export type ConfirmVerdict = "win_confirmed" | "not_confirmed" | "tradeoff" | "infeasible";

export interface GuardResult {
  metric: string;
  interval: Interval;
  /** ok: confidently within the step margin; violated: confidently beyond it. */
  status: "ok" | "violated" | "unsure";
}

export interface Decision<V> {
  /** Undefined when the look is not final and nothing is decided yet. */
  verdict: V | undefined;
  primary: Interval;
  guards: GuardResult[];
  reasons: string;
}

type Policy = Pick<
  HillClimbContract,
  "objective" | "guards" | "cells" | "hard_constraints" | "acceptance"
>;

/** Per-block effect for one metric: the mean log ratio over cells (a geometric mean ratio). */
export function blockEffects(
  blocks: readonly Block[],
  metric: string,
  direction: "max" | "min",
  cells: readonly string[],
): number[] {
  return blocks.map((b, i) => {
    const logs = cells.map((cell) => {
      const c = b.candidate[metric]?.[cell];
      const r = b.reference[metric]?.[cell];
      if (c === undefined || r === undefined) {
        throw new RangeError(`block ${i + 1} has no ${metric} for cell ${cell}`);
      }
      return logImprovement(c, r, direction);
    });
    return logs.reduce((s, x) => s + x, 0) / logs.length;
  });
}

/** Hard constraints on absolute values: the candidate's mean per cell must satisfy each. */
export function hardConstraintFailures(policy: Policy, blocks: readonly Block[]): string[] {
  const failures: string[] = [];
  for (const h of policy.hard_constraints) {
    if (h.kind === "check") continue; // named checks are gates, decided before measurement
    for (const cell of policy.cells) {
      const values = blocks.map((b) => b.candidate[h.metric]?.[cell]);
      if (values.some((v) => v === undefined || !Number.isFinite(v))) {
        failures.push(`${h.metric}/${cell}: missing or non-finite`);
        continue;
      }
      const m = (values as number[]).reduce((s, x) => s + x, 0) / values.length;
      if (h.kind === "min" ? m < h.value : m > h.value) {
        failures.push(
          `${h.metric}/${cell}: mean ${m} is ${h.kind === "min" ? "below" : "above"} ${h.value}`,
        );
      }
    }
  }
  return failures;
}

function guardResults(policy: Policy, blocks: readonly Block[], alpha: number): GuardResult[] {
  return policy.guards.map((g) => {
    const interval = meanInterval(blockEffects(blocks, g.metric, g.direction, policy.cells), alpha);
    const margin = -toLog(g.max_step_regression);
    const status = interval.low > margin ? "ok" : interval.high < margin ? "violated" : "unsure";
    return { metric: g.metric, interval, status };
  });
}

const pct = (logRatio: number) => `${(toFraction(logRatio) * 100).toFixed(2)}%`;
const describe = (i: Interval) => `${pct(i.estimate)} [${pct(i.low)}, ${pct(i.high)}] n=${i.n}`;

/**
 * Screening against the champion at one of the contract's looks. The screen's alpha is split
 * evenly across the looks (Bonferroni), so stopping early does not inflate false wins.
 */
export function decideScreen(policy: Policy, blocks: readonly Block[]): Decision<ScreenVerdict> {
  const { acceptance } = policy;
  const final = blocks.length >= Math.max(...acceptance.looks);
  const alpha = acceptance.alpha_screen / acceptance.looks.length;
  const { metric, direction, min_effect } = policy.objective.primary;
  const primary = meanInterval(blockEffects(blocks, metric, direction, policy.cells), alpha);
  const guards = guardResults(policy, blocks, alpha);
  const result = (verdict: ScreenVerdict | undefined, reasons: string) => ({
    verdict,
    primary,
    guards,
    reasons: `${reasons}; ${metric} ${describe(primary)}`,
  });

  const failures = hardConstraintFailures(policy, blocks);
  if (failures.length) return result("infeasible", `hard constraints: ${failures.join("; ")}`);

  const band = toLog(acceptance.equivalence_band);
  if (primary.low > -band && primary.high < band) return result("neutral", "equivalent");
  if (primary.low > 0) {
    if (primary.high < toLog(min_effect)) return result("neutral", "gain below min_effect");
    if (primary.estimate >= toLog(min_effect)) {
      const violated = guards.filter((g) => g.status === "violated").map((g) => g.metric);
      if (violated.length) return result("tradeoff", `guards violated: ${violated.join(", ")}`);
      const unsure = guards.filter((g) => g.status === "unsure").map((g) => g.metric);
      if (!unsure.length) return result("win_screened", "better beyond min_effect");
      if (final) return result("inconclusive", `guards unresolved: ${unsure.join(", ")}`);
      return result(undefined, `guards unresolved: ${unsure.join(", ")}`);
    }
  }
  if (primary.high < 0) return result("regress", "worse");
  return result(
    final ? "inconclusive" : undefined,
    final ? "no decision by the last look" : "continue",
  );
}

/**
 * Confirmation: fresh blocks, decided on confirmation data alone at alpha_confirm. Cumulative
 * guard totals (log ratios of earlier promoted steps against the campaign baseline) are checked
 * against each guard's total allowance.
 */
export function decideConfirm(
  policy: Policy,
  blocks: readonly Block[],
  priorGuardTotals: Readonly<Record<string, number>> = {},
): Decision<ConfirmVerdict> {
  const alpha = policy.acceptance.alpha_confirm;
  const { metric, direction } = policy.objective.primary;
  const primary = meanInterval(blockEffects(blocks, metric, direction, policy.cells), alpha);
  const guards = guardResults(policy, blocks, alpha);
  const result = (verdict: ConfirmVerdict, reasons: string) => ({
    verdict,
    primary,
    guards,
    reasons: `${reasons}; ${metric} ${describe(primary)}`,
  });

  const failures = hardConstraintFailures(policy, blocks);
  if (failures.length) return result("infeasible", `hard constraints: ${failures.join("; ")}`);
  const violated = guards.filter((g) => g.status === "violated").map((g) => g.metric);
  if (violated.length) return result("tradeoff", `guards violated: ${violated.join(", ")}`);
  const overTotal = policy.guards
    .filter((g) => {
      const est = guards.find((r) => r.metric === g.metric)?.interval.estimate ?? 0;
      return (priorGuardTotals[g.metric] ?? 0) + est < -toLog(g.max_total_regression);
    })
    .map((g) => g.metric);
  if (overTotal.length) {
    return result("tradeoff", `cumulative guard allowance spent: ${overTotal.join(", ")}`);
  }
  if (primary.low <= 0) return result("not_confirmed", "gain not confirmed on fresh data");
  const unsure = guards.filter((g) => g.status === "unsure").map((g) => g.metric);
  if (unsure.length) return result("not_confirmed", `guards unresolved: ${unsure.join(", ")}`);
  return result("win_confirmed", "confirmed on fresh data");
}

export type GoalStatus = "met" | "unmet" | "inconclusive" | "not_runnable";

export interface GoalDecision {
  goal: string;
  status: GoalStatus;
  /** Per cell: the interval of the measured value. Absent for code verifiers. */
  cells: Record<string, Interval>;
  reasons: string;
}

type GoalItem = GoalContract["goals"][number];

/**
 * A metric threshold goal is met only when every cell's interval lies on the passing side of
 * the threshold, unmet when any cell's interval lies wholly on the failing side, and
 * inconclusive otherwise. One rep per cell cannot give an interval, so it is inconclusive.
 */
export function decideThresholdGoal(
  goal: GoalItem,
  valuesByCell: Readonly<Record<string, readonly number[]>>,
  alpha: number,
): GoalDecision {
  if (goal.verify.type !== "metric_threshold") {
    throw new TypeError(`goal ${goal.id} is not a metric threshold goal`);
  }
  const { op, value, metric } = goal.verify;
  const cellNames = goal.verify.cells ?? Object.keys(valuesByCell);
  const missing = cellNames.filter((c) => !valuesByCell[c]?.length);
  if (missing.length || cellNames.length === 0) {
    return {
      goal: goal.id,
      status: "not_runnable",
      cells: {},
      reasons: `no ${metric} for ${missing.join(", ") || "any cell"}`,
    };
  }
  const passes = (x: number) =>
    op === ">=" ? x >= value : op === ">" ? x > value : op === "<=" ? x <= value : x < value;
  const cells: Record<string, Interval> = {};
  let allPass = true;
  let anyFail = false;
  const notes: string[] = [];
  for (const c of cellNames) {
    const xs = valuesByCell[c] as readonly number[];
    if (xs.length < 2) {
      allPass = false;
      notes.push(`${c}: one value (${xs[0]}), no interval`);
      continue;
    }
    const i = meanInterval(xs, alpha);
    cells[c] = i;
    const lowPass = passes(i.low);
    const highPass = passes(i.high);
    if (!(lowPass && highPass)) allPass = false;
    if (!lowPass && !highPass) anyFail = true;
    notes.push(
      `${c}: ${i.estimate.toPrecision(6)} [${i.low.toPrecision(6)}, ${i.high.toPrecision(6)}]`,
    );
  }
  const status: GoalStatus = anyFail ? "unmet" : allPass ? "met" : "inconclusive";
  return {
    goal: goal.id,
    status,
    cells,
    reasons: `${metric} ${op} ${value}: ${notes.join("; ")}`,
  };
}

/**
 * A goal candidate against the champion's goal statuses: goals it newly meets, goals the
 * champion meets that it fails (lost), and goals the champion meets that it could not check
 * (inconclusive or not runnable: unknown, which is neither a regression nor progress).
 */
export function goalDelta(
  results: { goal: string; status: GoalStatus }[],
  champion: Map<string, string>,
): { gained: string[]; lost: string[]; unsure: string[] } {
  const verified = (g: string) => champion.get(g) === "verified";
  return {
    gained: results.filter((r) => r.status === "met" && !verified(r.goal)).map((r) => r.goal),
    lost: results.filter((r) => r.status === "unmet" && verified(r.goal)).map((r) => r.goal),
    unsure: results
      .filter(
        (r) => (r.status === "inconclusive" || r.status === "not_runnable") && verified(r.goal),
      )
      .map((r) => r.goal),
  };
}
