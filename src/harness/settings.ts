import { type NumberSpec, readNumber } from "../common/settings.ts";
import { MAX_LANES } from "../core/contract.ts";

/**
 * The harness's number settings (goal 125, T4): each one's name, what it takes and its default,
 * in its own unit. The harness reads them through this table at its start, so a bad value stops
 * it then with the setting's name (goal 164); the docs check holds the settings page to it. The
 * model's settings, which the supervisor reads too, are the agents' (src/agents/settings.ts).
 */
export const HARNESS_NUMBERS = {
  maxTurns: { name: "THERMITE_MAX_TURNS", rule: { integer: true, min: 1 } },
  researchMaxMb: { name: "THERMITE_RESEARCH_MAX_MB", rule: { unit: "MiB", aboveMin: true } },
  calibrationBlocks: { name: "THERMITE_CALIBRATION_BLOCKS", rule: { integer: true }, fallback: 6 },
  usdPerMTokIn: { name: "THERMITE_LLM_USD_PER_MTOK_IN", rule: { unit: "US dollars" } },
  usdPerMTokOut: { name: "THERMITE_LLM_USD_PER_MTOK_OUT", rule: { unit: "US dollars" } },
  exportMinutes: {
    name: "THERMITE_EXPORT_MINUTES",
    rule: { unit: "minutes", aboveMin: true },
    fallback: 60,
  },
  trialMinutes: {
    name: "THERMITE_TRIAL_MINUTES",
    rule: { unit: "minutes", integer: true, min: 1, max: 1440 },
  },
  maxTrials: {
    name: "THERMITE_MAX_TRIALS",
    rule: { integer: true, max: MAX_LANES, zeroMeans: "no trials" },
    fallback: 1,
  },
  judgeGpus: { name: "THERMITE_JUDGE_GPUS", rule: { integer: true, min: 1 } },
} satisfies Record<string, NumberSpec>;

/** The harness controller's number settings, in the units its code uses, read at its start. */
export function harnessNumbers(env: Record<string, string | undefined>) {
  const n = HARNESS_NUMBERS;
  const mb = readNumber(env, n.researchMaxMb);
  return {
    /** Turns per trial: none unless set. */
    maxTurns: readNumber(env, n.maxTurns) ?? null,
    /** The largest research corpus, in bytes: none unless set. */
    researchMaxBytes: mb === undefined ? undefined : mb * 1024 * 1024,
    calibrationBlocks: readNumber(env, n.calibrationBlocks),
    usdPerMTokIn: readNumber(env, n.usdPerMTokIn),
    usdPerMTokOut: readNumber(env, n.usdPerMTokOut),
    exportEveryMs: readNumber(env, n.exportMinutes) * 60_000,
  };
}
