import { existsSync, readFileSync } from "node:fs";

/**
 * CPU throttling of the harness's own cgroup (cgroup v2 `cpu.stat`). With a CFS quota and no
 * exclusive cores, the kernel may throttle the container in the middle of a timed run; such
 * a block is not a valid measurement. Returns undefined where cgroup v2 is not available.
 */
export interface ThrottleSample {
  nr_throttled: number;
  throttled_usec: number;
}

export function readThrottle(path = "/sys/fs/cgroup/cpu.stat"): ThrottleSample | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const field = (k: string) =>
    Number(new RegExp(`^${k} (\\d+)$`, "m").exec(text)?.[1] ?? Number.NaN);
  const s = { nr_throttled: field("nr_throttled"), throttled_usec: field("throttled_usec") };
  return Number.isFinite(s.nr_throttled) && Number.isFinite(s.throttled_usec) ? s : undefined;
}

/** Fraction of `wallMs` the cgroup spent throttled between two samples. */
export function throttledFraction(
  before: ThrottleSample | undefined,
  after: ThrottleSample | undefined,
  wallMs: number,
): number | undefined {
  if (!before || !after || !(wallMs > 0)) return undefined;
  return (after.throttled_usec - before.throttled_usec) / 1000 / wallMs;
}
