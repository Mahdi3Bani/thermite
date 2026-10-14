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
): V0Result {
  const violations: string[] = [];
  if (changedFiles.length === 0) violations.push("no files changed");
  // Binary changes cannot be scanned for forbidden patterns, so they are refused.
  for (const f of binaryFiles) violations.push(`binary change: ${f}`);
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
