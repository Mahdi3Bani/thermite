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
import type { CliCompacted } from "./agents/cli-compaction.ts";
import { codexModelCheck, codexOnce, runCodexTrial } from "./agents/codex.ts";
import { DevRuns } from "./agents/devrun.ts";
import { type ModelConfig, modelConfigFromEnv, withAgentsContext } from "./agents/model.ts";
import { checkModel } from "./agents/model-check.ts";
import { ModelSource } from "./agents/model-source.ts";
import {
  opencodeModelCheck,
  opencodeOnce,
  PLANNER_ROLE,
  runOpencodeResearchTrial,
  runOpencodeTrial,
  takeUsage,
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
import { Compactions, compactionOf } from "./compactions.ts";
import { collectHardware } from "./hardware.ts";
import { Judge, type PromotionPolicy, serial } from "./judge/judge.ts";
import { Ledger } from "./ledger.ts";
import { settlePropagations } from "./propagation.ts";
import { ResearchFolder } from "./research/folder.ts";
import { Research } from "./research/research.ts";
import { lanesFromEnv, RigSettingsStore, trialMinutesFromEnv } from "./rig-settings.ts";
import {
  busyReason,
  isolationBusy,
  isolationSelftest,
  isolationSummary,
  oneContainerTargets,
} from "./selftest.ts";
import { HarnessService, NOT_BEFORE_FILE, wipeIfRequested } from "./service.ts";
import { checksDir, smokeCheck } from "./smoke-check.ts";
import { CpuDriver } from "./targets/cpu.ts";
import { CudaDriver, smiAs, smiAsRun } from "./targets/cuda.ts";
import type { TargetDriver } from "./targets/driver.ts";
import { routeOf } from "./usage.ts";

/** Minutes as milliseconds; none stays none. */
const minutesMs = (m: number | null) => (m === null ? undefined : m * 60_000);

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
  // In pull mode the broker starts the harness only once root has put control's key here.
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
      lanes: lanesFromEnv(env.THERMITE_MAX_TRIALS),
      planner: true,
      auditor: true,
      teachers: true,
      review: true,
      exports: true,
      // No trial length unless one is set (goal 079).
      trial_minutes: trialMinutesFromEnv(env.THERMITE_TRIAL_MINUTES),
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

  // Each run's research folder: what it has learned, as files its workers search (and, in a
  // research run, add to), with past research under knowledge/ (the same folders the service's
  // knowledge store writes).
  const researchFolder = new ResearchFolder({
    ledger,
    scratchRoot: join(paths.scratchDir, "research"),
    stateRoot: join(paths.stateDir, "research-work"),
    runner,
    knowledge: service.knowledge,
  });
  const research = new Research(ledger, paths.stateDir, {
    maxCorpusBytes: env.THERMITE_RESEARCH_MAX_MB
      ? Number(env.THERMITE_RESEARCH_MAX_MB) * 1024 * 1024
      : undefined,
    onChange: (run) => void researchFolder.sync(run),
  });
  service.researchFolder = (run) => researchFolder.exportFiles(run);
  // Each compaction's conversation, kept in the run's research folder, and its record (goal 070).
  service.compactions = new Compactions({ ledger, live: service.live, folder: researchFolder });

  // The route control sets for this rig: kept in the state directory, root only.
  const routeFile = join(paths.stateDir, "model-route.json");
  // A check a previous controller left running is over.
  service.reconcileRigChecks();
  if (env.THERMITE_BROKER_SOCKET) {
    const socketPath = env.THERMITE_BROKER_SOCKET;
    service.rigChecks.isolation = {
      // Open trials or judge jobs, or a planner call: each probe kills its role's processes.
      notNow: () => isolationBusy(paths.stateDir),
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
            // In one container with the supervisor (pull mode): the keys its tunnel signs with.
            env.THERMITE_TUNNEL_DIR ? join(env.THERMITE_TUNNEL_DIR, "keys.json") : undefined,
          ].filter((f): f is string => Boolean(f)),
          dedicated: env.THERMITE_DEV_GPU_INDEX !== undefined,
          force,
          controllerPid: process.pid,
          oneContainer: oneContainerTargets(env),
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
  log("harness", "listening", {
    rig,
    host,
    port,
    target: (await driver.identify()).id,
    build: service.build,
  });

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
  // A run's workers: the route, with the campaign's own context settings when its contract has
  // them (goal 070): the lower window, and the campaign's compaction point.
  const modelFor = (run: string) =>
    withAgentsContext(model(), service.contractFor(run).agents_context);
  // Rig checks control can ask for: the model route, and the isolation selftest under the broker.
  // OpenCode and Codex (worker harnesses a rig may choose) reach the harness API on loopback.
  const apiUrl = `http://127.0.0.1:${port}`;
  const once = {
    runner,
    apiUrl,
    scratchDir: paths.scratchDir,
    mintProxyToken: (m?: ModelConfig) => service.mintProxyToken(m),
  };
  service.rigChecks.model = {
    run: async () => {
      const m = model();
      return m
        ? m.harness === "opencode"
          ? opencodeModelCheck(m, once)
          : m.harness === "claude-code"
            ? claudeModelCheck(m, once)
            : m.harness === "codex"
              ? codexModelCheck(m, once)
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
  const trialOf = (spec: { trialId: string; run: string; lane: string }) => ({
    id: spec.trialId,
    run: spec.run,
    lane: spec.lane,
  });
  // A compaction OpenCode, Codex or Claude Code reported (goal 070): kept and recorded as a Pi
  // worker's are, with the program's own conversation where Thermite could read it.
  const compactedIn =
    (
      spec: { trialId: string; run: string; lane: string },
      harness: "opencode" | "codex" | "claude-code",
    ) =>
    (c: CliCompacted) =>
      service.compactions?.fromHarness(compactionOf(trialOf(spec)), harness, c);
  // Where a trial's conversation is kept before each compaction, for the program's own summary to
  // name it: the run's research folder, which the worker may read (goal 070).
  const keptAtFor = (spec: { trialId: string; run: string; lane: string }) =>
    service.compactions?.keptAt(compactionOf(trialOf(spec)), true);
  // Each model call's usage (goal 075): the harness records what OpenCode, Codex and Claude Code
  // report of a trial's calls; a Pi worker's own code hands its records over, with the trial's
  // token, while the trial runs.
  const workerUsage = (spec: { trialId: string; run: string }, m: ModelConfig) =>
    service.usage.recorder(spec.run, { trial: spec.trialId, agent: "workers" }, routeOf(m));
  const inPi = async <T>(
    spec: { trialId: string; run: string },
    m: ModelConfig | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (m) service.usage.open({ id: spec.trialId, run: spec.run }, routeOf(m, "pi"));
    try {
      return await run();
    } finally {
      service.usage.close(spec.trialId);
    }
  };
  // Agents wait while no route is set; one set later starts them without a restart.
  const scheduler = new Scheduler({
    service,
    runner,
    model,
    owner: "scheduler",
    maxConcurrent: settings.get().lanes,
    trialWallMs: minutesMs(settings.get().trial_minutes),
    // No cap on a trial's turns unless one is configured.
    maxTurns: settings.get().max_turns ?? undefined,
    workersOn: () => settings.get().workers,
    plannerOn: () => settings.get().planner,
    // A draining rig starts no trial or plan (goal 079).
    draining: () => service.draining !== undefined,
    // Each trial runs in the harness the rig's route names: Pi (a worker process), OpenCode,
    // Claude Code or Codex.
    runTrial: (spec, signal) => {
      const m = modelFor(spec.run);
      if (m?.harness === "codex")
        return runCodexTrial(spec, {
          runner,
          model: m,
          apiUrl,
          live: (entries) => service.trialReport(trialOf(spec), { entries }),
          progress: (progress) => service.trialReport(trialOf(spec), { progress }),
          submitted: () => service.trialSubmission(spec.trialId),
          messages: service.trialInbox({ id: spec.trialId, run: spec.run, lane: spec.lane }),
          // A full ChatGPT plan, as the model proxy saw OpenAI say it.
          usageLimitSince: (since) => service.usageLimitSince(since),
          compacted: compactedIn(spec, "codex"),
          keptAt: keptAtFor(spec),
          modelUsage: workerUsage(spec, m),
          // The provider's error answers the model proxy saw, and each wait for it (goal 079).
          providerAnswer: (since) => service.providerAnswerSince(spec.trialId, since),
          waiting: (w) => service.trialWait(trialOf(spec), w),
          env: laneCacheEnv(paths.scratchDir, spec.lane),
          signal,
        });
      if (m?.harness === "claude-code")
        return runClaudeTrial(spec, {
          runner,
          model: m,
          apiUrl,
          live: (entries) => service.trialReport(trialOf(spec), { entries }),
          progress: (progress) => service.trialReport(trialOf(spec), { progress }),
          submitted: () => service.trialSubmission(spec.trialId),
          messages: service.trialInbox({ id: spec.trialId, run: spec.run, lane: spec.lane }),
          // The subscription's windows, as Claude Code reports them: in the rig's report.
          usage: (u) => {
            service.subscriptionUsage = { ...u, at: new Date().toISOString() };
          },
          compacted: compactedIn(spec, "claude-code"),
          keptAt: keptAtFor(spec),
          modelUsage: workerUsage(spec, m),
          // The provider's error answers the model proxy saw, and each wait for it (goal 079).
          providerAnswer: (since) => service.providerAnswerSince(spec.trialId, since),
          waiting: (w) => service.trialWait(trialOf(spec), w),
          env: laneCacheEnv(paths.scratchDir, spec.lane),
          signal,
        });
      if (m?.harness !== "opencode")
        return inPi(spec, m, () =>
          spawnTrial({ kind: "code", spec }, runner, paths.scratchDir, port, signal, m),
        );
      return runOpencodeTrial(spec, {
        runner,
        model: m,
        apiUrl,
        live: (entries) => service.trialReport(trialOf(spec), { entries }),
        progress: (progress) => service.trialReport(trialOf(spec), { progress }),
        submitted: () => service.trialSubmission(spec.trialId),
        messages: service.trialInbox({ id: spec.trialId, run: spec.run, lane: spec.lane }),
        compacted: compactedIn(spec, "opencode"),
        keptAt: keptAtFor(spec),
        modelUsage: workerUsage(spec, m),
        // The provider's error answers the model proxy saw, and each wait for it (goal 079).
        providerAnswer: (since) => service.providerAnswerSince(spec.trialId, since),
        waiting: (w) => service.trialWait(trialOf(spec), w),
        env: laneCacheEnv(paths.scratchDir, spec.lane),
        signal,
      });
    },
    // The planner through OpenCode, as the planner's own user: its own tools; with past research,
    // the prompt names the run's knowledge/ folder, which every agent user may read and none may
    // change.
    askOpencode: async (m, prompt, signal, o) => {
      const t = await opencodeOnce(m, prompt, once, {
        role: PLANNER_ROLE,
        signal,
        // The MCP servers the run's kit gives the planner, at the gateway (goal 068).
        mcp: o?.mcp,
        // Its conversation before each of the program's own compactions (goal 070).
        compaction: o?.compaction,
      });
      takeUsage(t, o?.usage);
      if (!t.lastText) throw new Error(t.errors.at(-1) ?? "OpenCode gave no answer");
      return t.lastText;
    },
    // The planner's own model, when control gave it one.
    plannerModel: () => models.planner(),
    // The planner on a Claude subscription: Claude Code as the planner's own user, with no tools,
    // or with the read-only file tools when it has past research to read (the run's knowledge/,
    // which every agent user may read and none may change).
    askClaude: async (m, prompt, signal, o) => {
      const t = await claudeOnce(m, prompt, once, {
        tools: o?.read ? "Read,Grep,Glob" : "",
        signal,
        role: PLANNER_ROLE,
        mcp: o?.mcp,
        // Its conversation before each of Claude Code's own compactions (goal 070).
        compaction: o?.compaction,
      });
      takeUsage(t, o?.usage);
      if (t.usage) service.subscriptionUsage = { ...t.usage, at: new Date().toISOString() };
      const answer = t.result ?? t.lastText;
      if (!answer) throw new Error(t.errors.at(-1) ?? "Claude Code gave no answer");
      return answer;
    },
    // The planner of a route whose agents run in Codex: Codex as the planner's own user, through
    // the model proxy with a credential minted for the call; with past research, the prompt names
    // the run's knowledge/ folder, which every agent user may read and none may change.
    askCodex: async (m, prompt, signal, o) => {
      const t = await codexOnce(m, prompt, once, {
        role: PLANNER_ROLE,
        signal,
        // The MCP servers the run's kit gives the planner, at the gateway (goal 068).
        mcp: o?.mcp,
        // Its conversation before each of the program's own compactions (goal 070).
        compaction: o?.compaction,
      });
      takeUsage(t, o?.usage);
      if (!t.lastText) throw new Error(t.errors.at(-1) ?? "Codex gave no answer");
      return t.lastText;
    },
    research,
    // Research workers run in the harness the rig's route names: Pi (a worker process with the
    // research tools only) or OpenCode (its own tools plus `thermite-trial research`); a route
    // whose code trials run in Codex runs its research workers in Pi, which reaches the same
    // provider (a ChatGPT sign-in or an OpenAI-compatible route). A Claude
    // subscription runs only in Claude Code, and OpenCode's own (free) models only in OpenCode:
    // say so, in words.
    runResearchTrial: async (spec, signal) => {
      const m = modelFor(spec.run);
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
      // The run's research folder, with the lane's working area given to the user the trial
      // runs as: the worker's (Pi) or the lane's (OpenCode). Its files are saved when it ends.
      const pi = m?.harness !== "opencode";
      const lane = spec.lane as Role;
      const as = (pi ? spec.lane.replace(/^lane-/, "agent-") : spec.lane) as Role;
      const folder = await researchFolder.prepareLane(spec.run, spec.lane, as);
      const save = () =>
        researchFolder.captureLane(spec.run, spec.lane, spec.trialId).catch((err) => {
          log("harness", "research files not saved", { lane: spec.lane, error: String(err) });
        });
      if (pi) {
        try {
          return await inPi(spec, m, () =>
            spawnTrial(
              { kind: "research", spec: { ...spec, folder } },
              runner,
              paths.scratchDir,
              port,
              signal,
              m,
            ),
          );
        } finally {
          await save();
        }
      }
      const area = await prepareResearchArea({ runner, scratchDir: paths.scratchDir, lane });
      try {
        return await runOpencodeResearchTrial(spec, {
          runner,
          model: m,
          apiUrl,
          area: area.dir,
          folder,
          live: (entries) => service.trialReport(trialOf(spec), { entries }),
          progress: (progress) => service.trialReport(trialOf(spec), { progress }),
          messages: service.trialInbox({ id: spec.trialId, run: spec.run, lane: spec.lane }),
          compacted: compactedIn(spec, "opencode"),
          keptAt: keptAtFor(spec),
          modelUsage: m ? workerUsage(spec, m) : undefined,
          // The provider's error answers the model proxy saw, and each wait for it (goal 079).
          providerAnswer: (since) => service.providerAnswerSince(spec.trialId, since),
          waiting: (w) => service.trialWait(trialOf(spec), w),
          env: laneCacheEnv(paths.scratchDir, spec.lane),
          signal,
        });
      } finally {
        // What the agent started from its shell ends with the trial, and so does its own area;
        // its working area in the folder is saved.
        await runner.killRole(lane).catch(() => 0);
        await runner.remove(area.dir).catch(() => undefined);
        await save();
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
      trialWallMs: minutesMs(s.trial_minutes),
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
        // The judge off (Edit rig): jobs wait in the queue, nothing is measured. A draining rig
        // takes no new job (goal 079): the one under way finishes first.
        worked = settings.get().judge && !service.draining ? await executor.tick() : false;
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

  // A stop (goal 079): running trials stop and are recorded as interrupted, with the counters
  // their workers last reported. The judge's job under way is not waited for longer than a few
  // seconds: a container's stop gives little time, and its lease is taken back at the next start.
  // To let it finish, control drains the rig first (Update to these images).
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("harness", "stopping", { signal });
    server.close();
    await scheduler
      .shutdown(`the harness is stopping (${signal})`)
      .catch((err) => log("harness", "trials not recorded at the stop", { error: String(err) }));
    const ended = await Promise.race([running.then(() => true), sleep(5000).then(() => false)]);
    if (ended) ledger.close();
    else
      log(
        "harness",
        "a judge job was under way at the stop: its lease is taken back at the next start",
      );
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log("harness", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
