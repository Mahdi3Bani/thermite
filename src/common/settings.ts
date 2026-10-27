/**
 * Numeric settings from the environment (goal 164): one reading for every part, so a typo stops
 * the part at start with the setting's name and what it takes, never passing as a value. Before
 * this, `THERMITE_EXPORT_MINUTES=6O` gave NaN and the rig never exported again, and an empty value
 * gave 0 and an export every few seconds.
 */

type Env = Record<string, string | undefined>;

/** What a numeric setting takes. */
export interface NumberRule {
  /** One of it in words, such as "seconds" or "MiB"; none for a count. */
  unit?: string | undefined;
  /** The smallest value it takes (default 0). */
  min?: number | undefined;
  /** The largest value it takes (default none). */
  max?: number | undefined;
  /** Above `min`, never equal to it: an interval of 0 would spin a loop. */
  aboveMin?: boolean | undefined;
  /** Whole numbers only: a count, a group id, a port. */
  integer?: boolean | undefined;
  /** What 0 means, where it means something of its own, such as "off". */
  zeroMeans?: string | undefined;
}

/** What a rule takes, in words: "a number of seconds above 0", "a whole number from 1 to 65535". */
export function ruleWords(rule: NumberRule = {}): string {
  const min = rule.min ?? 0;
  const kind = `${rule.integer ? "a whole number" : "a number"}${rule.unit ? ` of ${rule.unit}` : ""}`;
  const from = rule.aboveMin ? `above ${min}` : `from ${min}`;
  const zero = rule.zeroMeans ? ` (0: ${rule.zeroMeans})` : "";
  return `${kind} ${from}${rule.max !== undefined ? ` to ${rule.max}` : ""}${zero}`;
}

/** The setting as a number within its rule, or undefined when it is unset or empty. */
export function optionalNumberSetting(
  env: Env,
  name: string,
  rule: NumberRule = {},
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  const min = rule.min ?? 0;
  const ok =
    Number.isFinite(n) &&
    (rule.aboveMin ? n > min : n >= min) &&
    (rule.max === undefined || n <= rule.max) &&
    (!rule.integer || Number.isInteger(n));
  if (!ok) throw new Error(`${name} takes ${ruleWords(rule)}, not "${env[name]}"`);
  return n;
}

/** The setting as a number within its rule, or `fallback` when it is unset or empty. */
export function numberSetting(env: Env, name: string, fallback: number, rule?: NumberRule): number {
  return optionalNumberSetting(env, name, rule) ?? fallback;
}

/** An interval in seconds, above 0 unless the rule says otherwise, in milliseconds. */
export function secondsSetting(env: Env, name: string, fallback: number, rule?: NumberRule) {
  return numberSetting(env, name, fallback, { unit: "seconds", aboveMin: true, ...rule }) * 1000;
}

/** An interval in minutes, above 0 unless the rule says otherwise, in milliseconds. */
export function minutesSetting(env: Env, name: string, fallback: number, rule?: NumberRule) {
  return numberSetting(env, name, fallback, { unit: "minutes", aboveMin: true, ...rule }) * 60_000;
}
