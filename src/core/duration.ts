const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const DURATION_PATTERN = /^(\d+(?:\.\d+)?)([smhd])$/;

/** Parses durations such as "90s", "30m", "8h" or "7d" into milliseconds. */
export function parseDuration(text: string): number {
  const m = DURATION_PATTERN.exec(text);
  if (!m) throw new RangeError(`invalid duration: ${text}`);
  const amount = Number(m[1]);
  const unit = m[2] as keyof typeof UNIT_MS;
  return amount * UNIT_MS[unit];
}
