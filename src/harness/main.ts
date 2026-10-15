import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  log,
  optionalSecretFromFile,
  parseListen,
  requireEnv,
  secretFromFile,
  waitForFile,
} from "../common/env.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { DevRuns } from "./agents/devrun.ts";
import { modelConfigFromEnv } from "./agents/model.ts";
import { Scheduler } from "./agents/scheduler.ts";
import { spawnTrial } from "./agents/spawn.ts";
import { createHarnessApi } from "./api.ts";
import { BrokerClient } from "./broker/client.ts";
import { type GpuLayout, readLayout } from "./broker/devices.ts";
import { LocalRunner, type Runner } from "./broker/runner.ts";
import { collectHardware } from "./hardware.ts";
import { Judge, type PromotionPolicy } from "./judge/judge.ts";
import { Ledger } from "./ledger.ts";
import { settlePropagations } from "./propagation.ts";
import { Research } from "./research/research.ts";
import { HarnessService, NOT_BEFORE_FILE, wipeIfRequested } from "./service.ts";
import { CpuDriver } from "./targets/cpu.ts";
import { CudaDriver, smiAs, smiAsRun } from "./targets/cuda.ts";
import type { TargetDriver } from "./targets/driver.ts";

/** The harness controller: owns the ledger, serves the API and drives the executor. */
async function main(): Promise<void> {
  // Exports and builds are read by other users (the supervisor, the run user): no group or
  // world write.
  process.umask(0o022);
  const env = process.env;
  const rig = requireEnv("THERMITE_RIG_ID");
  const paths = {
    stateDir: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
    // Under the broker the scratch root belongs to root; the controller works in its own area.
    scratchDir: join(
      env.THERMITE_SCRATCH_DIR ?? "/scratch",
      env.THERMITE_BROKER_SOCKET ? "thermite" : "",
    ),
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
    // The broker passes secret values in the environment (it alone can read the files).
    supervisor: env.THERMITE_SUPERVISOR_TOKEN || secretFromFile("THERMITE_SUPERVISOR_TOKEN_FILE"),
    proposer: env.THERMITE_PROPOSER_TOKEN || optionalSecretFromFile("THERMITE_PROPOSER_TOKEN_FILE"),
  };
  const runner: Runner = env.THERMITE_BROKER_SOCKET
    ? new BrokerClient(env.THERMITE_BROKER_SOCKET)
    : new LocalRunner(paths.scratchDir);
  const target = env.THERMITE_TARGET ?? "cpu";
  // A dedicated development card: the broker sets it up; without its layout nothing times.
  let devCard: { layout?: GpuLayout; error?: string } | undefined;
  if (env.THERMITE_DEV_GPU_INDEX !== undefined) {
    if (target !== "cuda-gpu")
      throw new Error("THERMITE_DEV_GPU_INDEX needs THERMITE_TARGET=cuda-gpu");
    devCard = readLayout(env.THERMITE_BROKER_SOCKET);
    log(
      "harness",
      devCard.error ? "dedicated development card unavailable" : "dedicated development card",
      devCard,
    );
  }
  let driver: TargetDriver;
  if (target === "cpu") driver = new CpuDriver(env.THERMITE_TARGET_CLASS ?? "generic-cpu");
  else if (target === "cuda-gpu") {
    driver = new CudaDriver({
      targetClass: env.THERMITE_TARGET_CLASS ?? "cuda-gpu",
      index: Number(env.THERMITE_GPU_INDEX ?? "0"),
      uuid: devCard?.layout?.judge.uuid,
      smi: smiAsRun(runner, join(paths.scratchDir, "thermite", "gpu-query")),
      unusable: devCard?.error,
    });
  } else throw new Error(`no target driver ${target}; this build has cpu and cuda-gpu`);

  // Private state: only the controller's user may enter. Builds and models are reachable by
  // exact path only (0711), because the run user executes builds and loads models.
  for (const [dir, mode] of [
    ["ledger", 0o700],
    ["git", 0o700],
    ["kits", 0o700],
    ["imports", 0o700],
    ["models", 0o711],
  ] as const) {
    mkdirSync(join(paths.stateDir, dir), { recursive: true });
    chmodSync(join(paths.stateDir, dir), mode);
  }
  // A full reset's wipe, requested by the last controller run: done before anything opens.
  if (
    wipeIfRequested(paths, [
      "rig-signing.key",
      "rig-signing.key.pub",
      "unit-signing.key",
      "unit-signing.key.pub",
    ])
  ) {
    log("harness", "state wiped (full reset); starting with a fresh ledger");
    for (const [dir, mode] of [
      ["ledger", 0o700],
      ["git", 0o700],
      ["kits", 0o700],
      ["imports", 0o700],
      ["models", 0o711],
    ] as const) {
      mkdirSync(join(paths.stateDir, dir), { recursive: true });
      chmodSync(join(paths.stateDir, dir), mode);
    }
  }
  const ledger = Ledger.open(join(paths.stateDir, "ledger", "ledger.db"));
  // After a wipe: commands issued before it belonged to the old ledger.
  const notBefore = join(paths.stateDir, "ledger", NOT_BEFORE_FILE);
  if (existsSync(notBefore)) {
    ledger.db
      .prepare("insert or replace into meta (key, value) values ('not_before', ?)")
      .run(readFileSync(notBefore, "utf8").trim());
    rmSync(notBefore, { force: true });
  }
  // The rig's report-signing key: created once, kept with the ledger (0700).
  const rigKeyPath = join(paths.stateDir, "ledger", "rig-signing.key");
  // Before the 2026-10-15 rename the key was the "unit" key: kept, so control's pin still holds.
  const oldKeyPath = join(paths.stateDir, "ledger", "unit-signing.key");
  if (!existsSync(rigKeyPath) && existsSync(oldKeyPath) && existsSync(`${oldKeyPath}.pub`)) {
    renameSync(`${oldKeyPath}.pub`, `${rigKeyPath}.pub`);
    renameSync(oldKeyPath, rigKeyPath);
  }
  if (!existsSync(rigKeyPath)) {
    const k = generateSigningKeys();
    writeFileSync(rigKeyPath, k.privateKeyPem, { mode: 0o600 });
    writeFileSync(`${rigKeyPath}.pub`, k.publicKeyPem, { mode: 0o644 });
  }
  const rigKeys = {
    privateKeyPem: readFileSync(rigKeyPath, "utf8"),
    publicKeyPem: readFileSync(`${rigKeyPath}.pub`, "utf8"),
  };
  // D8, the owner's promotion policy (2026-10-15): confirmed wins promote on their own; audits
  // still hold surprising ones, and a gain above the absolute trigger still waits for the owner.
  // owner_approval makes every promotion wait.
  const promotion = (env.THERMITE_PROMOTION ?? "auto") as PromotionPolicy;
  if (promotion !== "auto" && promotion !== "owner_approval") {
    throw new Error(`THERMITE_PROMOTION must be auto or owner_approval, not ${promotion}`);
  }
  const service = new HarnessService({
    rig,
    ledger,
    paths,
    controlPublicKeyPem,
    rigKeys,
    promotion,
  });
  service.onWipe = () => {
    log("harness", "wipe requested: exiting so the next start wipes the state");
    process.exit(0);
  };
  // Startup reconciliation: anything still leased by this rig's executor belonged to a process
  // that died. Re-queue it now and record it once as crash_infra.
  // What the rig runs on, for the dashboard: collected once, before the judge starts timing.
  const gpuQuery = join(paths.scratchDir, "thermite", "gpu-query");
  const layout = devCard?.layout;
  service.hardware = await collectHardware({
    driver,
    cards:
      driver.type !== "cuda-gpu" || devCard?.error
        ? []
        : layout
          ? [
              { role: "judge", select: layout.judge.uuid, smi: smiAsRun(runner, gpuQuery) },
              {
                role: "dev",
                select: layout.dev.uuid,
                smi: smiAs(
                  runner,
                  "lane-1-dev",
                  join(paths.scratchDir, "thermite", "gpu-query-dev"),
                ),
              },
            ]
          : [
              {
                role: "shared",
                select: env.THERMITE_GPU_INDEX ?? "0",
                smi: smiAsRun(runner, gpuQuery),
              },
            ],
    deviceMode: driver.type !== "cuda-gpu" ? "none" : devCard ? "dedicated" : "shared",
    stateDir: paths.stateDir,
    scratchDir: paths.scratchDir,
  });
  if (devCard?.error) service.hardware.errors.push(devCard.error);
  log("harness", "hardware", {
    devices: service.hardware.devices.map((d) => `${d.role}: ${d.name} ${d.uuid}`),
    errors: service.hardware.errors,
  });

  const executorId = "executor-0";
  const reclaimed = ledger.reclaimLeases(executorId, "controller-start");
  if (reclaimed.length) log("harness", "reclaimed leases at start", { jobs: reclaimed });

  const devRuns = new DevRuns({
    runner,
    ledger,
    scratchDir: paths.scratchDir,
    gpu: driver.type === "cuda-gpu",
    dedicated: devCard?.layout !== undefined,
    unavailable: devCard?.error,
  });

  const research = new Research(ledger, paths.stateDir, {
    maxCorpusBytes: Number(env.THERMITE_RESEARCH_MAX_MB ?? "2048") * 1024 * 1024,
  });

  const { host, port } = parseListen(env.THERMITE_LISTEN ?? "0.0.0.0:8700");
  const server = serve({
    fetch: createHarnessApi(service, tokens, {
      devRuns,
      research,
      lanes: {
        runner,
        laneTool: [
          process.execPath,
          fileURLToPath(new URL("./agents/lanetool.js", import.meta.url)),
        ],
      },
    }).fetch,
    hostname: host,
    port,
  });
  log("harness", "listening", { rig, host, port, target: (await driver.identify()).id });

  const executor = new Judge({
    service,
    runner,
    driver,
    owner: executorId,
    promotion,
    calibrationBlocks: Number(env.THERMITE_CALIBRATION_BLOCKS ?? "6"),
    deviceGate: devRuns,
  });
  log("harness", "judge ready", { separated: runner.separated, promotion });

  // Agents run only with a model route (QWEN_* from the rig's configuration; the key from the
  // broker). Each trial is its own worker process.
  const model = modelConfigFromEnv(env);
  const scheduler = model
    ? new Scheduler({
        service,
        runner,
        model,
        owner: "scheduler",
        maxConcurrent: Number(env.THERMITE_MAX_TRIALS ?? "1"),
        trialWallMs: Number(env.THERMITE_TRIAL_MINUTES ?? "20") * 60_000,
        runTrial: (spec, signal) =>
          spawnTrial({ kind: "code", spec }, runner, paths.scratchDir, port, signal),
        research,
        runResearchTrial: (spec, signal) =>
          spawnTrial({ kind: "research", spec }, runner, paths.scratchDir, port, signal),
        devRuns,
        usdPerMTokIn: env.THERMITE_LLM_USD_PER_MTOK_IN
          ? Number(env.THERMITE_LLM_USD_PER_MTOK_IN)
          : undefined,
        usdPerMTokOut: env.THERMITE_LLM_USD_PER_MTOK_OUT
          ? Number(env.THERMITE_LLM_USD_PER_MTOK_OUT)
          : undefined,
      })
    : undefined;
  log("harness", scheduler ? "agents ready" : "no model route: agents off", {
    model: model?.model ?? null,
  });
  const exportEveryMs = Number(env.THERMITE_EXPORT_MINUTES ?? "60") * 60_000;
  let stopping = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Three independent loops: a judging job never holds up the scheduler (trials, epochs) or the
  // exports, and a slow planner call never holds up the judge.
  const judging = async () => {
    while (!stopping) {
      let worked = false;
      try {
        worked = await executor.tick();
      } catch (err) {
        log("harness", "executor error", { error: String(err) });
      }
      if (!worked) await sleep(1000);
    }
  };
  const scheduling = async () => {
    while (!stopping && scheduler) {
      try {
        await scheduler.tick();
      } catch (err) {
        log("harness", "scheduler error", { error: String(err) });
      }
      await sleep(2000);
    }
  };
  const exporting = async () => {
    while (!stopping) {
      try {
        settlePropagations(ledger, "harness");
      } catch (err) {
        log("harness", "propagation settle error", { error: String(err) });
      }
      // Hourly export for the supervisor to push (and an export command can force one). An
      // export's own event is not news, or an idle rig would export every hour forever.
      const last = ledger.lastExport();
      const lastAt = last ? Date.parse(last.created_at) : 0;
      if (
        ledger.recordedAfter(last?.through_event ?? 0, ["export_written"]) &&
        Date.now() - lastAt >= exportEveryMs
      ) {
        try {
          await service.export("scheduler");
        } catch (err) {
          log("harness", "export error", { error: String(err) });
        }
      }
      await sleep(5000);
    }
  };
  const running = Promise.all([judging(), scheduling(), exporting()]);

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
