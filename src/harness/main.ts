import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  log,
  optionalSecretFromFile,
  parseListen,
  requireEnv,
  secretFromFile,
  waitForFile,
} from "../common/env.ts";
import { createHarnessApi } from "./api.ts";
import { FakeExecutor } from "./executor.ts";
import { Ledger } from "./ledger.ts";
import { HarnessService } from "./service.ts";
import { CpuDriver } from "./targets/cpu.ts";

/** The harness controller: owns the ledger, serves the API and drives the executor. */
async function main(): Promise<void> {
  const env = process.env;
  const unit = requireEnv("THERMITE_UNIT_ID");
  const paths = {
    stateDir: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
    scratchDir: env.THERMITE_SCRATCH_DIR ?? "/scratch",
    inboxDir: env.THERMITE_INBOX_DIR ?? "/inbox",
    outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
  };
  for (const d of [paths.stateDir, paths.scratchDir, paths.outboxDir])
    mkdirSync(d, { recursive: true });
  const controlPublicKeyPem = await waitForFile(
    requireEnv("THERMITE_CONTROL_PUBKEY_FILE"),
    120_000,
  );
  const tokens = {
    supervisor: secretFromFile("THERMITE_SUPERVISOR_TOKEN_FILE"),
    proposer: optionalSecretFromFile("THERMITE_PROPOSER_TOKEN_FILE"),
  };
  const target = env.THERMITE_TARGET ?? "cpu";
  if (target !== "cpu") throw new Error(`target driver ${target} is not available in this build`);
  const driver = new CpuDriver(env.THERMITE_TARGET_CLASS ?? "generic-cpu");

  const ledger = Ledger.open(join(paths.stateDir, "ledger", "ledger.db"));
  const service = new HarnessService({ unit, ledger, paths, controlPublicKeyPem });
  // Startup reconciliation: anything still leased by this unit's executor belonged to a process
  // that died. Re-queue it now and record it once as crash_infra.
  const executorId = "executor-0";
  const reclaimed = ledger.reclaimLeases(executorId, "controller-start");
  if (reclaimed.length) log("harness", "reclaimed leases at start", { jobs: reclaimed });

  const { host, port } = parseListen(env.THERMITE_LISTEN ?? "0.0.0.0:8700");
  const server = serve({ fetch: createHarnessApi(service, tokens).fetch, hostname: host, port });
  log("harness", "listening", { unit, host, port, target: (await driver.identify()).id });

  const executor = new FakeExecutor(service, driver, executorId);
  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      let worked = false;
      try {
        worked = await executor.tick();
      } catch (err) {
        log("harness", "executor error", { error: String(err) });
      }
      if (!worked) await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const running = loop();

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("harness", "stopping", { signal });
    server.close();
    await running;
    ledger.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log("harness", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
