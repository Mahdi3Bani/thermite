import { numberSetting } from "../../common/settings.ts";

/**
 * The broker's numeric settings, read at its start through the one reading of settings (goal
 * 164), so a bad value stops it then, with the setting's name.
 */
export function brokerNumbers(env: Record<string, string | undefined>) {
  return {
    /** The supervisor's group: it reads exports from the shared outbox; roles may not. */
    outboxGid: numberSetting(env, "THERMITE_OUTBOX_GID", 10001, { integer: true }),
    /** How long a fatal stop at start holds before the broker exits, at most 600 s. */
    fatalHoldMs:
      Math.min(numberSetting(env, "THERMITE_FATAL_HOLD_SECONDS", 0, { unit: "seconds" }), 600) *
      1000,
  };
}
