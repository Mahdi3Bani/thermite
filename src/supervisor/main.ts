import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, optionalSecretFromFile, requireEnv, secretFromFile } from "../common/env.ts";
import { type RelayState, relayOnce } from "./relay.ts";

/** Supervisor entry point (v1 core): the 60-second report and command relay loop. */
async function main(): Promise<void> {
  const env = process.env;
  const home = env.THERMITE_SUPERVISOR_HOME ?? "/var/lib/thermite-supervisor";
  mkdirSync(home, { recursive: true });
  const statePath = join(home, "relay-state.json");
  let state: RelayState = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as RelayState)
    : { cursor: 0 };
  const cfg = {
    unit: requireEnv("THERMITE_UNIT_ID"),
    harnessUrl: requireEnv("HARNESS_URL").replace(/\/$/, ""),
    harnessToken: secretFromFile("THERMITE_HARNESS_TOKEN_FILE"),
    controlUrl: env.CONTROL_URL?.replace(/\/$/, ""),
    controlToken: optionalSecretFromFile("THERMITE_CONTROL_TOKEN_FILE"),
  };
  const intervalMs = Number(env.THERMITE_POLL_SECONDS ?? "60") * 1000;
  log("supervisor", "starting", {
    unit: cfg.unit,
    interval_ms: intervalMs,
    control: Boolean(cfg.controlUrl),
  });
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      const next = await relayOnce(cfg, state);
      if (next.cursor !== state.cursor || next.ledgerId !== state.ledgerId) {
        writeFileSync(`${statePath}.tmp`, JSON.stringify(next));
        renameSync(`${statePath}.tmp`, statePath);
        log("supervisor", "reported", { cursor: next.cursor });
      }
      state = next;
    } catch (err) {
      log("supervisor", "relay error", { error: String(err) });
    }
    const until = Date.now() + intervalMs;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  }
  process.exit(0);
}

main().catch((err) => {
  log("supervisor", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
