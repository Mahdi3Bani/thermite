import { minutesSetting, numberSetting, optionalNumberSetting } from "../common/settings.ts";

/**
 * The harness controller's numeric settings, read once at its start through the one reading of
 * settings (goal 164), so a bad value stops the harness then, with the setting's name.
 */
export function harnessNumbers(env: Record<string, string | undefined>) {
  const mb = optionalNumberSetting(env, "THERMITE_RESEARCH_MAX_MB", { unit: "MB", aboveMin: true });
  const usd = { unit: "US dollars" };
  return {
    /** Turns per trial: none unless set. */
    maxTurns: optionalNumberSetting(env, "THERMITE_MAX_TURNS", { integer: true, min: 1 }) ?? null,
    /** The largest research corpus, in bytes: none unless set. */
    researchMaxBytes: mb === undefined ? undefined : mb * 1024 * 1024,
    calibrationBlocks: numberSetting(env, "THERMITE_CALIBRATION_BLOCKS", 6, { integer: true }),
    usdPerMTokIn: optionalNumberSetting(env, "THERMITE_LLM_USD_PER_MTOK_IN", usd),
    usdPerMTokOut: optionalNumberSetting(env, "THERMITE_LLM_USD_PER_MTOK_OUT", usd),
    exportEveryMs: minutesSetting(env, "THERMITE_EXPORT_MINUTES", 60),
  };
}
