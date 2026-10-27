import { type NumberSpec, readNumber } from "../common/settings.ts";

/**
 * The supervisor's number settings (goal 125, T4): each one's name, what it takes and its default,
 * in its own unit. The supervisor reads them through this table at its start, so a bad value
 * stops it then with the setting's name (goal 164); the docs check holds the settings page to it.
 */
const OFF_AT_ZERO = { unit: "seconds", zeroMeans: "off" };
export const SUPERVISOR_NUMBERS = {
  pollSeconds: {
    name: "THERMITE_POLL_SECONDS",
    rule: { unit: "seconds", aboveMin: true },
    fallback: 60,
  },
  commandPollSeconds: {
    name: "THERMITE_COMMAND_POLL_SECONDS",
    rule: { unit: "seconds", zeroMeans: "with each report" },
    fallback: 5,
  },
  liveIntervalMs: {
    name: "THERMITE_LIVE_INTERVAL_MS",
    rule: { unit: "milliseconds", zeroMeans: "off" },
    fallback: 3000,
  },
  modelRoutePollSeconds: {
    name: "THERMITE_MODEL_ROUTE_POLL_SECONDS",
    rule: OFF_AT_ZERO,
    fallback: 30,
  },
  kbSyncSeconds: { name: "THERMITE_KB_SYNC_SECONDS", rule: OFF_AT_ZERO, fallback: 180 },
  tunnelPort: { name: "THERMITE_TUNNEL_PORT", rule: { integer: true, min: 1, max: 65535 } },
} satisfies Record<string, NumberSpec>;

/** A supervisor setting from its table, in milliseconds when its unit is seconds. */
export function supervisorMs(
  env: Record<string, string | undefined>,
  spec: NumberSpec & { fallback: number },
): number {
  const n = readNumber(env, spec);
  return spec.rule.unit === "seconds" ? n * 1000 : n;
}
