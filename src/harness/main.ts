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
import { claudeModelCheck, claudeOnce, runClaudeTrial } from "./agents/claude-code.ts";
import { DevRuns } from "./agents/devrun.ts";
import { modelConfigFromEnv } from "./agents/model.ts";
import { checkModel } from "./agents/model-check.ts";
import { ModelSource } from "./agents/model-source.ts";
import {
  opencodeModelCheck,
  opencodeOnce,
  runOpencodeResearchTrial,
  runOpencodeTrial,
} from "./agents/opencode.ts";
import { Scheduler } from "./agents/scheduler.ts";
import { spawnTrial } from "./agents/spawn.ts";
import { laneCacheEnv, prepareResearchArea } from "./agents/workspace.ts";
import { createHarnessApi } from "./api.ts";
import { BrokerClient } from "./broker/client.ts";
import {
  cardsOf,
  effectiveGpuLists,
  type GpuLayout,
  parseIndexList,
  readLayout,
  runRole,
} from "./broker/devices.ts";
import { LocalRunner, type Role, type Runner } from "./broker/runner.ts";
import { collectHardware } from "./hardware.ts";
import { Judge, type PromotionPolicy, serial } from "./judge/judge.ts";
import { Ledger } from "./ledger.ts";
import { settlePropagations } from "./propagation.ts";
import { Research } from "./research/research.ts";
import { RigSettingsStore } from "./rig-settings.ts";
import { busyReason, isolationSelftest, isolationSummary } from "./selftest.ts";
import { HarnessService, NOT_BEFORE_FILE, wipeIfRequested } from "./service.ts";
import { checksDir, smokeCheck } from "./smoke-check.ts";
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
  // The broker restricts the GPU's device nodes (and sets up a dedicated development card when
  // one is configured); without its record of that, a GPU rig neither times nor runs dev runs.
  let devCard: { layout?: GpuLayout; error?: string } | undefined;
  if (env.THERMITE_DEV_GPU_INDEX !== undefined && target !== "cuda-gpu") {
    throw new Error("THERMITE_DEV_GPU_INDEX needs THERMITE_TARGET=cuda-gpu");
  }
  if (
    target === "cuda-gpu" &&
    (env.THERMITE_DEV_GPU_INDEX !== undefined || env.THERMITE_BROKER_SOCKET)
  ) {
    devCard = readLayout(env.THERMITE_BROKER_SOCKET);
    log(
      "harness",
      devCard.error
        ? "GPU devices unavailable: the rig will not time"
        : devCard.layout
          ? "dedicated development card"
          : "GPU device nodes restricted to the gpu group",
      devCard,
    );
  }
  // One driver per judge card: each executor times on its own card, as its own user.
  const judgeCards = devCard?.layout ? cardsOf(devCard.layout).judges : [];
  const devCards = devCard?.layout ? cardsOf(devCard.layout).devs : [];
  let drivers: TargetDriver[];
  if (target === "cpu") drivers = [new CpuDriver(env.THERMITE_TARGET_CLASS ?? "generic-cpu")];
  else if (target === "cuda-gpu") {
    const first = parseIndexList(env.THERMITE_GPU_INDEX ?? "0", "THERMITE_GPU_INDEX")[0] ?? 0;
    const cards = judgeCards.length ? judgeCards : [{ index: first, uuid: undefined }];
    drivers = cards.map(
      (c, i) =>
        new CudaDriver({
          targetClass: env.THERMITE_TARGET_CLASS ?? "cuda-gpu",
          index: c.index,
          uuid: c.uuid,
          smi: smiAs(
            runner,
            runRole(i),
            join(paths.scratchDir, "thermite", i ? `gpu-query-${i}` : "gpu-query"),
          ),
          unusable: devCard?.error,
        }),
    );
  } else throw new Error(`no target driver ${target}; this build has cpu and cuda-gpu`);
  const driver = drivers[0] as TargetDriver;

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
  // The promotion policy: confirmed wins promote on their own (auto); audits still hold
  // surprising ones, and a gain above the absolute trigger still waits for the owner.
  // owner_approval makes every promotion wait.
  const promotion = (env.THERMITE_PROMOTION ?? "auto") as PromotionPolicy;
  if (promotion !== "auto" && promotion !== "owner_approval") {
    throw new Error(`THERMITE_PROMOTION must be auto or owner_approval, not ${promotion}`);
  }
  // The rig's settings (Edit rig): the environment gives the defaults, owner commands change them.
  const settings = new RigSettingsStore(
    {
      judge: true,
      workers: true,
      lanes: Number(env.THERMITE_MAX_TRIALS ?? "1"),
      planner: true,
      auditor: true,
      teachers: true,
      review: true,
      exports: true,
      trial_minutes: Number(env.THERMITE_TRIAL_MINUTES ?? "20"),
      max_turns: env.THERMITE_MAX_TURNS ? Number(env.THERMITE_MAX_TURNS) : null,
      promotion,
      judge_gpus: null,
    },
    join(paths.stateDir, "rig-settings.json"),
  );
  // A rig configured with its GPU set: the broker split it for this start (the lists it gave).
  const gpuSet = env.THERMITE_GPUS ? parseIndexList(env.THERMITE_GPUS, "THERMITE_GPUS").length : 0;
  const judgeNow =
    gpuSet >= 2 ? parseIndexList(env.THERMITE_GPU_INDEX ?? "0", "THERMITE_GPU_INDEX").length : 0;
  const service = new HarnessService({
    rig,
    ledger,
    paths,
    controlPublicKeyPem,
    rigKeys,
    promotion,
    targetType: driver.type,
    settings,
  });
  if (gpuSet >= 2) service.gpuSplit = { set: gpuSet, judge: judgeNow };
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
              ...judgeCards.map((c, i) => ({
                role: "judge" as const,
                select: c.uuid,
                smi: i
                  ? smiAs(runner, runRole(i), join(paths.scratchDir, "thermite", `gpu-query-${i}`))
                  : smiAsRun(runner, gpuQuery),
              })),
              ...devCards.map((c, k) => ({
                role: "dev" as const,
                select: c.uuid,
                smi: k
                  ? smiAs(
                      runner,
                      "lane-1",
                      join(paths.scratchDir, "thermite", `gpu-query-dev-${k}`),
                      k,
                    )
                  : smiAs(
                      runner,
                      "lane-1-dev",
                      join(paths.scratchDir, "thermite", "gpu-query-dev"),
                    ),
              })),
            ]
          : [
              {
                role: "shared",
                select: env.THERMITE_GPU_INDEX ?? "0",
                smi: smiAsRun(runner, gpuQuery),
              },
            ],
    deviceMode:
      driver.type !== "cuda-gpu"
        ? "none"
        : env.THERMITE_DEV_GPU_INDEX !== undefined
          ? "dedicated"
          : "shared",
    stateDir: paths.stateDir,
    scratchDir: paths.scratchDir,
  });
  if (devCard?.error) service.hardware.errors.push(devCard.error);
  // One GPU model per rig: its judge cards share one target class. Mixed cards are separate rigs;
  // until then only the first judge card judges.
  const cardModels = new Set(
    service.hardware.devices.filter((d) => d.role === "judge").map((d) => d.name),
  );
  const judging = cardModels.size > 1 ? drivers.slice(0, 1) : drivers;
  if (cardModels.size > 1)
    service.hardware.errors.push(
      `the judge cards are different models (${[...cardModels].join(", ")}): only the first judges; put different models in separate rigs`,
    );
  log("harness", "hardware", {
    devices: service.hardware.devices.map((d) => `${d.role}: ${d.name} ${d.uuid}`),
    errors: service.hardware.errors,
  });

  // One executor per judge card that judges (executor-0 is the first card's, as always).
  const executorIds = judging.map((_, i) => `executor-${i}`);
  for (const id of executorIds) {
    const reclaimed = ledger.reclaimLeases(id, "controller-start");
    if (reclaimed.length)
      log("harness", "reclaimed leases at start", { executor: id, jobs: reclaimed });
  }

  const devRuns = new DevRuns({
    runner,
    ledger,
    scratchDir: paths.scratchDir,
    gpu: driver.type === "cuda-gpu",
    dedicated: devCard?.layout !== undefined,
    cards: devCards.length || undefined,
    unavailable: devCard?.error,
  });

  const research = new Research(ledger, paths.stateDir, {
    maxCorpusBytes: env.THERMITE_RESEARCH_MAX_MB
      ? Number(env.THERMITE_RESEARCH_MAX_MB) * 1024 * 1024
      : undefined,
  });

  // The route control sets for this rig: kept in the state directory, root only.
  const routeFile = join(paths.stateDir, "model-route.json");
  // A check a previous controller left running is over.
  service.reconcileRigChecks();
  if (env.THERMITE_BROKER_SOCKET) {
    const socketPath = env.THERMITE_BROKER_SOCKET;
    service.rigChecks.isolation = {
      notNow: () => busyReason(paths.stateDir),
      run: async ({ force }) => {
        const report = await isolationSelftest({
          socketPath,
          stateDir: paths.stateDir,
          // The scratch root, as the command-line selftest uses it (the controller's own area,
          // paths.scratchDir, is a directory inside it).
          scratchDir: env.THERMITE_SCRATCH_DIR ?? "/scratch",
          outboxDir: paths.outboxDir,
          secretFiles: [
            routeFile,
            env.THERMITE_SUPERVISOR_TOKEN_FILE,
            env.THERMITE_PROPOSER_TOKEN_FILE,
            env.THERMITE_MODEL_API_KEY_FILE,
            env.QWEN_API_KEY_FILE,
          ].filter((f): f is string => Boolean(f)),
          dedicated: env.THERMITE_DEV_GPU_INDEX !== undefined,
          force,
          controllerPid: process.pid,
        });
        return { ok: report.ok, summary: isolationSummary(report), detail: { ...report } };
      },
    };
  }
  // The isolation check at every start, before the API, the judge or any agent runs: nothing of
  // theirs can be running yet, and control sees the result beside the rig's hardware.
  await service.checkAtStart("isolation");

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

  const buildLock = serial();
  const executors = judging.map(
    (d, i) =>
      new Judge({
        service,
        runner,
        driver: d,
        owner: executorIds[i] as string,
        promotion,
        calibrationBlocks: Number(env.THERMITE_CALIBRATION_BLOCKS ?? "6"),
        deviceGate: devRuns,
        buildLock,
        ...(judging.length > 1
          ? {
              card: {
                index: i,
                uuid: (judgeCards[i] as { uuid: string }).uuid,
                count: judging.length,
              },
            }
          : {}),
      }),
  );
  log("harness", "judge ready", {
    separated: runner.separated,
    promotion,
    judge_cards: executors.length,
  });

  // Agents run only with a model route (THERMITE_MODEL_* from the rig's configuration; the key from the
  // broker). Each trial is its own worker process.
  // The route control sets (kept in the state directory, root only) comes before the rig's own
  // settings; every plan and trial takes the route current when it starts.
  const models = new ModelSource(routeFile, modelConfigFromEnv(env));
  service.models = models;
  const model = () => models.current();
  // Rig checks control can ask for: the model route, and the isolation selftest under the broker.
  // OpenCode (the worker harness a rig may choose) reaches the harness API on loopback.
  const apiUrl = `http://127.0.0.1:${port}`;
  const once = {
    runner,
    apiUrl,
    scratchDir: paths.scratchDir,
    mintProxyToken: () => service.mintProxyToken(),
  };
  service.rigChecks.model = {
    run: async () => {
      const m = model();
      return m
        ? m.harness === "opencode"
          ? opencodeModelCheck(m, once)
          : m.harness === "claude-code"
            ? claudeModelCheck(m, once)
            : checkModel(m)
        : {
            ok: false,
            summary:
              "no model route: set one on control's settings page (or in the rig's settings)",
          };
    },
  };
  // The smoke check: a judge-only campaign from the smoke kit in the image, on this target.
  service.rigChecks.smoke = {
    notNow: () => busyReason(paths.stateDir),
    run: async () =>
      smokeCheck({
        service,
        targetType: driver.type,
        targetClass: (await driver.identify()).class,
        checksDir: checksDir(env),
        scratchDir: paths.scratchDir,
      }),
  };
  // Agents wait while no route is set; one set later starts them without a restart.
  const scheduler = new Scheduler({
    service,
    runner,
    model,
    owner: "scheduler",
    maxConcurrent: settings.get().lanes,
    trialWallMs: settings.get().trial_minutes * 60_000,
    // No cap on a trial's turns unless one is configured.
    maxTurns: settings.get().max_turns ?? undefined,
    workersOn: () => settings.get().workers,
    plannerOn: () => settings.get().planner,
    // Each trial runs in the harness the rig's route names: Pi (a worker process) or OpenCode.
    runTrial: (spec, signal) => {
      const m = model();
      if (m?.harness === "claude-code")
        return runClaudeTrial(spec, {
          runner,
          model: m,
          apiUrl,
          live: (entries) => {
            for (const e of entries)
              service.live.append({
                source: `trial:${spec.trialId}`,
                kind: e.kind,
                text: e.text,
                lane: spec.lane,
                run: spec.run,
              });
          },
          progress: (p) => service.trialProgress.set(spec.trialId, p),
          submitted: () => service.trialSubmission(spec.trialId),
          messages: () =>
            service.takeMessages({ id: spec.trialId, run: spec.run, lane: spec.lane }),
          // The subscription's windows, as Claude Code reports them: in the rig's report.
          usage: (u) => {
            service.subscriptionUsage = { ...u, at: new Date().toISOString() };
          },
          env: laneCacheEnv(paths.scratchDir, spec.lane),
          signal,
        });
      if (m?.harness !== "opencode")
        return spawnTrial({ kind: "code", spec }, runner, paths.scratchDir, port, signal, m);
      return runOpencodeTrial(spec, {
        runner,
        model: m,
        apiUrl,
        live: (entries) => {
          for (const e of entries)
            service.live.append({
              source: `trial:${spec.trialId}`,
              kind: e.kind,
              text: e.text,
              lane: spec.lane,
              run: spec.run,
            });
        },
        progress: (p) => service.trialProgress.set(spec.trialId, p),
        submitted: () => service.trialSubmission(spec.trialId),
        messages: () => service.takeMessages({ id: spec.trialId, run: spec.run, lane: spec.lane }),
        env: laneCacheEnv(paths.scratchDir, spec.lane),
        signal,
      });
    },
    askOpencode: async (m, prompt, signal) => {
      const t = await opencodeOnce(m, prompt, once, 300_000, signal);
      if (!t.lastText) throw new Error(t.errors.at(-1) ?? "OpenCode gave no answer");
      return t.lastText;
    },
    // The planner's own model, when control gave it one.
    plannerModel: () => models.planner(),
    // The planner on a Claude subscription: Claude Code with no tools, as an unprivileged user.
    askClaude: async (m, prompt, signal) => {
      const t = await claudeOnce(m, prompt, once, { tools: "", timeoutMs: 300_000, signal });
      if (t.usage) service.subscriptionUsage = { ...t.usage, at: new Date().toISOString() };
      const answer = t.result ?? t.lastText;
      if (!answer) throw new Error(t.errors.at(-1) ?? "Claude Code gave no answer");
      return answer;
    },
    research,
    // Research workers run in the harness the rig's route names: Pi (a worker process with the
    // research tools only) or OpenCode (its own tools plus `thermite-trial research`). A Claude
    // subscription runs only in Claude Code, and OpenCode's own (free) models only in OpenCode:
    // say so, in words.
    runResearchTrial: async (spec, signal) => {
      const m = model();
      const cannot = !m
        ? "this rig has no model for its agents: give it one on its Edit rig page"
        : m.api === "claude"
          ? "research workers run in Pi or OpenCode, and a Claude subscription runs only in Claude Code: give this rig another model for research"
          : m.api === "opencode" && m.harness !== "opencode"
            ? `${m.model} is one of OpenCode's own models, which work only inside OpenCode: set this rig's agents' harness to OpenCode on its Edit rig page`
            : undefined;
      if (cannot)
        return {
          stopped: "error",
          turns: 0,
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
          error: cannot,
        };
      if (m?.harness !== "opencode")
        return spawnTrial({ kind: "research", spec }, runner, paths.scratchDir, port, signal, m);
      const lane = spec.lane as Role;
      const area = await prepareResearchArea({ runner, scratchDir: paths.scratchDir, lane });
      try {
        return await runOpencodeResearchTrial(spec, {
          runner,
          model: m,
          apiUrl,
          area: area.dir,
          workdir: area.workdir,
          live: (entries) => {
            for (const e of entries)
              service.live.append({
                source: `trial:${spec.trialId}`,
                kind: e.kind,
                text: e.text,
                lane: spec.lane,
                run: spec.run,
              });
          },
          progress: (p) => service.trialProgress.set(spec.trialId, p),
          messages: () =>
            service.takeMessages({ id: spec.trialId, run: spec.run, lane: spec.lane }),
          env: laneCacheEnv(paths.scratchDir, spec.lane),
          signal,
        });
      } finally {
        // What the agent started from its shell ends with the trial, and so does its directory.
        await runner.killRole(lane).catch(() => 0);
        await runner.remove(area.dir).catch(() => undefined);
      }
    },
    devRuns,
    usdPerMTokIn: env.THERMITE_LLM_USD_PER_MTOK_IN
      ? Number(env.THERMITE_LLM_USD_PER_MTOK_IN)
      : undefined,
    usdPerMTokOut: env.THERMITE_LLM_USD_PER_MTOK_OUT
      ? Number(env.THERMITE_LLM_USD_PER_MTOK_OUT)
      : undefined,
  });
  settings.onChange((s) => {
    scheduler.configure({
      maxConcurrent: s.lanes,
      trialWallMs: s.trial_minutes * 60_000,
      maxTurns: s.max_turns ?? undefined,
    });
    log("harness", "settings changed", { ...s });
    // A new GPU split is applied by the broker when the harness starts: exit, and it restarts.
    if (gpuSet >= 2) {
      const next = effectiveGpuLists(env, s.judge_gpus).judge.split(",").length;
      if (next !== judgeNow) {
        log("harness", "the GPU split changed: restarting to regroup the cards", {
          judge: next,
          agents: gpuSet - next,
        });
        setTimeout(() => process.exit(0), 1500).unref();
      }
    }
  });
  const info = models.info();
  log("harness", info.source === "none" ? "agents wait for a model route" : "agents ready", {
    route: info.source,
    model: info.model ?? null,
  });
  const exportEveryMs = Number(env.THERMITE_EXPORT_MINUTES ?? "60") * 60_000;
  let stopping = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Three independent loops: a judging job never holds up the scheduler (trials, epochs) or the
  // exports, and a slow planner call never holds up the judge.
  // One judging loop per judge card.
  const judgeLoop = async (executor: Judge, id: string) => {
    while (!stopping) {
      let worked = false;
      try {
        // The judge off (Edit rig): jobs wait in the queue, nothing is measured.
        worked = settings.get().judge ? await executor.tick() : false;
      } catch (err) {
        log("harness", "executor error", { executor: id, error: String(err) });
      }
      if (!worked) await sleep(1000);
    }
  };
  const scheduling = async () => {
    while (!stopping) {
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
        settings.get().exports &&
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
  const running = Promise.all([
    ...executors.map((e, i) => judgeLoop(e, executorIds[i] as string)),
    scheduling(),
    exporting(),
  ]);

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
