import { matchesAny } from "../core/glob.ts";

/**
 * V0 static policy: a candidate may change only the paths the contract allows, and its added
 * lines must not match a forbidden pattern (timers, benchmark tricks, disabled checks).
 */
export interface V0Result {
  ok: boolean;
  violations: string[];
}

export function checkV0(
  policy: { editable_paths: readonly string[]; forbidden_patterns: readonly string[] },
  changedFiles: readonly string[],
  addedLines: readonly string[],
  binaryFiles: readonly string[] = [],
  specialFiles: readonly string[] = [],
): V0Result {
  const violations: string[] = [];
  if (changedFiles.length === 0) violations.push("no files changed");
  // Binary changes cannot be scanned for forbidden patterns, so they are refused.
  for (const f of binaryFiles) violations.push(`binary change: ${f}`);
  // A symlink could point a build or the judge at private files; a submodule pulls in code.
  for (const f of specialFiles) violations.push(`symlink or submodule: ${f}`);
  for (const f of changedFiles) {
    if (!matchesAny(f, policy.editable_paths)) violations.push(`path not editable: ${f}`);
  }
  const patterns = policy.forbidden_patterns.map((p) => ({ p, re: new RegExp(p) }));
  for (const line of addedLines) {
    for (const { p, re } of patterns) {
      if (re.test(line)) violations.push(`forbidden pattern ${p}: ${line.trim().slice(0, 120)}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The most violations an event, a brief or a page carries for one attempt, each cut to 300
 * characters; the attempt's record keeps them all (goal 082).
 */
export const VIOLATIONS_SHOWN = 20;

/** A refused change's violations, from its record (the attempt's `v0`, as JSON or parsed). */
export function violationsOf(v0: unknown): string[] {
  let v: unknown = v0;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const list = (v as { violations?: unknown } | null | undefined)?.violations;
  return Array.isArray(list) ? list.map(String) : [];
}

/** Violations bounded for an event, a brief or a page: the first `max`, and how many in all. */
export function shownViolations(
  list: readonly string[],
  max = VIOLATIONS_SHOWN,
): { violations: string[]; total: number } {
  return {
    violations: list.slice(0, max).map((x) => (x.length > 300 ? `${x.slice(0, 299)}…` : x)),
    total: list.length,
  };
}

/** Violations in words for a brief: `a; b; c`, then how many more when there are more. */
export function violationsText(list: readonly string[], max = VIOLATIONS_SHOWN): string {
  const { violations, total } = shownViolations(list, max);
  return `${violations.join("; ")}${total > violations.length ? `; and ${total - violations.length} more` : ""}`;
}
