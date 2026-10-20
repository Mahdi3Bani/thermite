import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { log, optionalSecretFromFile, requireEnv, secretFromFile } from "../common/env.ts";
import { type AdviseState, adviseOnce, emptyAdviseState, teachersCalled } from "./advise.ts";
import { type ControlAdvisors, fetchControlAdvisors, mergeAdvisors } from "./advisor-routes.ts";
import { AdvisorsConfig } from "./advisors.ts";
import { type ChampionUpload, championsIn, uploadChampions } from "./champions.ts";
import { type ExportState, exportOnce } from "./git-export.ts";
import { emptyKbSyncState, type KbSyncState, syncKnowledgeOnce } from "./kb-sync.ts";
import { type LiveRelayState, relayLiveOnce, supervisorLive } from "./live.ts";
import { syncModelRoute } from "./model-route.ts";
import { RelayError, type RelayState, relayCommandsOnce, relayOnce } from "./relay.ts";
import { dailyReport } from "./report.ts";
import { stageCommand } from "./staging.ts";
import { waitForHarness } from "./startup.ts";

function load<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function save(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

/**
 * Supervisor entry point: the 60-second report and command relay loop (with content staging),
 * git exports, supervisor figures and a daily report to control, and, when advisors are
 * configured, the teacher pair, auditor and review panel in a loop of their own.
 */
async function main(): Promise<void> {
  const env = process.env;
  const home = env.THERMITE_SUPERVISOR_HOME ?? "/var/lib/thermite-supervisor";
  mkdirSync(home, { recursive: true });
  const statePath = join(home, "relay-state.json");
  let state: RelayState = load(statePath, { cursor: 0 });
  const rig = requireEnv("THERMITE_RIG_ID");
  const harnessUrl = requireEnv("HARNESS_URL").replace(/\/$/, "");
  const harnessToken = secretFromFile("THERMITE_HARNESS_TOKEN_FILE");
  const controlUrl = env.CONTROL_URL?.replace(/\/$/, "");
  const controlToken = optionalSecretFromFile("THERMITE_CONTROL_TOKEN_FILE");
  const remote = env.THERMITE_RESULTS_REMOTE || undefined;
  const sshKeyFile = env.THERMITE_RESULTS_KEY_FILE || undefined;
  const knownHostsFile = env.THERMITE_RESULTS_KNOWN_HOSTS || undefined;
  const inboxDir = env.THERMITE_INBOX_DIR ?? "/inbox";
  let wipeRequested = false;
  const cfg = {
    rig,
    harnessUrl,
    harnessToken,
    controlUrl,
    controlToken,
    stage: (cmd: Parameters<typeof stageCommand>[1]) =>
      stageCommand(
        {
          rig,
          inboxDir,
          resultsRepo: join(home, "results.git"),
          sourcesDir: join(home, "sources"),
          controlUrl,
          controlToken,
          remote,
          sshKeyFile,
          knownHostsFile,
        },
        cmd,
      ),
    onDelivered: (kind: string, accepted: boolean) => {
      if (kind === "wipe_state" && accepted) wipeRequested = true;
    },
  };
  const intervalMs = Number(env.THERMITE_POLL_SECONDS ?? "60") * 1000;
  const exportPath = join(home, "export-state.json");
  let exportState: ExportState = load(exportPath, { done: [] });
  // Champion patches waiting to reach control (kept across restarts).
  const championQueuePath = join(home, "champion-uploads.json");
  let championQueue: ChampionUpload[] = load(championQueuePath, []);
  const exportCfg = {
    rig,
    outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
    workDir: home,
    remote,
    sshKeyFile,
    knownHostsFile,
  };
  const advisorsFile = env.THERMITE_ADVISORS_FILE;
  const fileAdvisors = advisorsFile
    ? AdvisorsConfig.parse(JSON.parse(readFileSync(advisorsFile, "utf8")))
    : undefined;
  // The roles control gives models (the owner's choice per rig) over the file's; read each round.
  let controlAdvisors: ControlAdvisors = {};
  let advisors = mergeAdvisors(fileAdvisors, controlAdvisors);
  const refreshAdvisors = async () => {
    if (controlUrl && controlToken) {
      try {
        controlAdvisors = await fetchControlAdvisors({ rig, controlUrl, controlToken });
      } catch (err) {
        // Control unreachable: the last roles it gave stay.
        log("supervisor", "advisor routes unavailable", { error: String(err).slice(0, 300) });
      }
    }
    advisors = mergeAdvisors(fileAdvisors, controlAdvisors);
    return advisors;
  };
  const advisePath = join(home, "advise-state.json");
  let adviseState: AdviseState = load(advisePath, emptyAdviseState());
  const reportPath = join(home, "report-state.json");
  let reportState = load<{ lastDailyAt?: string }>(reportPath, {});
  log("supervisor", "starting", {
    rig,
    interval_ms: intervalMs,
    control: Boolean(controlUrl),
    results_remote: Boolean(remote),
    advisors: advisors
      ? {
          teachers: advisors.teachers.length,
          combiner: Boolean(advisors.combiner),
          auditor: Boolean(advisors.auditor),
          panel: advisors.panel.length,
        }
      : null,
  });
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });

  const toControl = async (path: string, body: unknown) => {
    if (!controlUrl || !controlToken) return;
    const res = await fetch(`${controlUrl}/v1/rigs/${encodeURIComponent(rig)}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  };

  // The harness may still be starting: wait for it once, before the relays begin.
  await waitForHarness(harnessUrl, () => stopping);

  /** The rig's settings from the harness; all advisors on when it can't say (an older harness). */
  let lastSettings = { teachers: true, auditor: true, review: true };
  const rigSettings = async () => {
    try {
      const r = await fetch(`${harnessUrl}/v1/settings`, {
        headers: { authorization: `Bearer ${harnessToken}` },
      });
      if (r.ok) lastSettings = { ...lastSettings, ...((await r.json()) as typeof lastSettings) };
    } catch {}
    return lastSettings;
  };
  // How often the pause between advisor rounds looks for a new owner's message to the teachers.
  const ownerCheckMs = 5000;
  // Advisors run on their own: a teacher round can take many minutes.
  const advising = async () => {
    while (!stopping) {
      const advisors = await refreshAdvisors();
      if (!advisors) {
        // No role has an advisor: look again later (the owner may give one a model).
        const until = Date.now() + Math.max(intervalMs, 30_000);
        while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      const before = { ...adviseState.stats };
      try {
        // Only the roles both configured and switched on in the rig's settings (Edit rig).
        const on = await rigSettings();
        const active = {
          ...advisors,
          teachers: on.teachers ? advisors.teachers : [],
          combiner: on.teachers ? advisors.combiner : undefined,
          auditor: on.auditor ? advisors.auditor : undefined,
          panel: on.review ? advisors.panel : [],
        };
        adviseState = await adviseOnce(
          {
            harnessUrl,
            harnessToken,
            home,
            advisors: active,
            // Each step of a round (a teacher's review, the directives and why, an audit, a
            // review) is a line in the live view, with its run.
            live: (line) => supervisorLive.append({ source: "supervisor", ...line }),
          },
          adviseState,
        );
        save(advisePath, adviseState);
        const a = adviseState.stats;
        const did = {
          teachers: a.teacher_runs - before.teacher_runs,
          sets: a.directive_sets - before.directive_sets,
          audits: a.audits - before.audits,
          reviews: a.reviews - before.reviews,
          errors: a.errors - before.errors,
        };
        // A round that did nothing says nothing: the live view is for what happens.
        if (Object.values(did).some((n) => n > 0))
          supervisorLive.append({
            source: "supervisor",
            kind: "status",
            text: `advisor round done: ${did.teachers} teacher runs, ${did.sets} directive sets, ${did.audits} audits, ${did.reviews} reviews, ${did.errors} errors`,
          });
      } catch (err) {
        log("supervisor", "advisor loop error", { error: String(err) });
        supervisorLive.append({
          source: "supervisor",
          kind: "status",
          text: `advisor round failed: ${String(err).slice(0, 300)}`,
        });
      }
      // The pause between rounds ends early when the owner writes to the teacher pair: its
      // round starts at once (checked every few seconds), not at the next hour.
      const until = Date.now() + Math.max(intervalMs, 30_000);
      let checked = Date.now();
      while (!stopping && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 250));
        if (Date.now() - checked < ownerCheckMs || !advisors.teachers.length) continue;
        checked = Date.now();
        const called = await teachersCalled(
          { harnessUrl, harnessToken, advisors },
          adviseState,
        ).catch(() => false);
        if (called && lastSettings.teachers) break;
      }
    }
  };
  const advisingDone = advising();

  // The live view: the harness's live log (signed) and the supervisor's own lines, every few
  // seconds. Independent of the 60 s report relay.
  const liveMs = Number(env.THERMITE_LIVE_INTERVAL_MS ?? "3000");
  const living = async () => {
    let liveState: LiveRelayState = { cursor: 0, ownCursor: 0 };
    let failing = false;
    while (!stopping && controlUrl && liveMs > 0) {
      try {
        liveState = await relayLiveOnce(
          { rig, harnessUrl, harnessToken, controlUrl, controlToken },
          liveState,
        );
        failing = false;
      } catch (err) {
        if (!failing) log("supervisor", "live relay error", { error: String(err) });
        failing = true;
      }
      const until = Date.now() + liveMs;
      while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    }
  };
  const livingDone = living();

  // Commands on their own short interval: a pause or a message should not wait for the next
  // report. The report loop below leaves commands to this one.
  const commandMs = Number(env.THERMITE_COMMAND_POLL_SECONDS ?? "5") * 1000;
  const commanding = async () => {
    let failing = false;
    while (!stopping && controlUrl && commandMs > 0) {
      try {
        await relayCommandsOnce(cfg);
        failing = false;
      } catch (err) {
        if (!failing) log("supervisor", "command relay error", { error: String(err) });
        failing = true;
      }
      if (wipeRequested) break;
      const until = Date.now() + commandMs;
      while (!stopping && !wipeRequested && Date.now() < until)
        await new Promise((r) => setTimeout(r, 250));
    }
  };
  const commandingDone = commanding();

  // The agents' model route, from control's settings page: checked every half minute.
  const routeMs = Number(env.THERMITE_MODEL_ROUTE_POLL_SECONDS ?? "30") * 1000;
  const routing = async () => {
    let failing = false;
    while (!stopping && controlUrl && controlToken && routeMs > 0) {
      try {
        await syncModelRoute({ rig, controlUrl, controlToken, harnessUrl, harnessToken });
        failing = false;
      } catch (err) {
        if (!failing) log("supervisor", "model route error", { error: String(err) });
        failing = true;
      }
      const until = Date.now() + routeMs;
      while (!stopping && !wipeRequested && Date.now() < until)
        await new Promise((r) => setTimeout(r, 250));
    }
  };
  const routingDone = routing();

  // Past research for each running run, from control's knowledge base into the run's research
  // folder (knowledge/), every few minutes. The cursor of each run is kept here.
  const kbPath = join(home, "kb-state.json");
  let kbState: KbSyncState = load(kbPath, emptyKbSyncState());
  const kbMs = Number(env.THERMITE_KB_SYNC_SECONDS ?? "180") * 1000;
  const syncingKb = async () => {
    let failing = false;
    while (!stopping && controlUrl && controlToken && kbMs > 0) {
      try {
        const r = await syncKnowledgeOnce(
          { rig, controlUrl, controlToken, harnessUrl, harnessToken },
          kbState,
        );
        if (JSON.stringify(r.state) !== JSON.stringify(kbState)) save(kbPath, r.state);
        kbState = r.state;
        if (r.items) log("supervisor", "past research synced", { items: r.items });
        if (r.errors.length && !failing)
          log("supervisor", "past research sync error", { errors: r.errors.slice(0, 5) });
        failing = r.errors.length > 0;
      } catch (err) {
        if (!failing) log("supervisor", "past research sync error", { error: String(err) });
        failing = true;
      }
      const until = Date.now() + kbMs;
      while (!stopping && !wipeRequested && Date.now() < until)
        await new Promise((r) => setTimeout(r, 250));
    }
  };
  const syncingKbDone = syncingKb();

  while (!stopping) {
    try {
      const next = await relayOnce({ ...cfg, skipCommands: commandMs > 0 }, state);
      if (next.cursor !== state.cursor || next.ledgerId !== state.ledgerId) {
        save(statePath, next);
        log("supervisor", "reported", { cursor: next.cursor });
      }
      state = next;
    } catch (err) {
      // Reporting failed; commands were still relayed. Keep whatever progress the round made.
      if (err instanceof RelayError) state = err.state;
      log("supervisor", "relay error", { error: String(err) });
    }
    if (wipeRequested) {
      // A full reset: the harness accepted its wipe. The supervisor wipes its own home too
      // (relay cursor, export record, local results repository, advisor records) and restarts.
      log("supervisor", "wiping the supervisor's state (full reset)");
      for (const name of readdirSync(home))
        rmSync(join(home, name), { recursive: true, force: true });
      process.exit(0);
    }
    try {
      const before = exportState.done.length;
      const next = await exportOnce(exportCfg, exportState);
      // Champions in the exports just made go to control too (downloadable from the dashboard).
      const fresh = next.done.filter((n) => !exportState.done.includes(n));
      if (fresh.length) {
        championQueue.push(...championsIn(exportCfg.outboxDir, fresh));
        save(championQueuePath, championQueue);
      }
      if (next.done.length !== before || next.lastError !== exportState.lastError) {
        save(exportPath, next);
        log("supervisor", "exported", {
          exports: next.done.length - before,
          pushed: Boolean(exportCfg.remote),
          error: next.lastError ?? null,
        });
      }
      // Exports safe in the results repository (or, without a remote, committed here) leave
      // the harness's outbox.
      const safe = remote
        ? (next.pushed ?? []).filter((n) => !(exportState.pushed ?? []).includes(n))
        : next.done.filter((n) => !exportState.done.includes(n));
      exportState = next;
      if (safe.length) {
        await fetch(`${harnessUrl}/v1/exports/done`, {
          method: "POST",
          headers: { authorization: `Bearer ${harnessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ names: safe }),
        }).catch((err) => log("supervisor", "outbox cleanup error", { error: String(err) }));
      }
    } catch (err) {
      log("supervisor", "export error", { error: String(err) });
    }
    if (championQueue.length && controlUrl && controlToken) {
      const left = await uploadChampions(
        { rig, controlUrl, controlToken, resultsRepo: join(home, "results.git") },
        championQueue,
      );
      if (left.length !== championQueue.length) save(championQueuePath, left);
      championQueue = left;
    }
    try {
      // Supervisor figures for control: git sync, advisors, relay.
      await toControl("/supervisor", {
        at: new Date().toISOString(),
        relay: { cursor: state.cursor },
        export: {
          remote: Boolean(remote),
          exports: exportState.done.length,
          pushed: exportState.pushed ?? [],
          pushed_commit: exportState.pushedCommit ?? null,
          last_push_at: exportState.lastPushAt ?? null,
          last_error: exportState.lastError?.slice(0, 900) ?? null,
        },
        advisors: advisors
          ? {
              ...adviseState.stats,
              // Which roles are configured and on, so control can say whether an audit will be
              // decided.
              roles: {
                teachers: lastSettings.teachers ? advisors.teachers.length : 0,
                combiner: lastSettings.teachers && Boolean(advisors.combiner),
                auditor: lastSettings.auditor && Boolean(advisors.auditor),
                panel: lastSettings.review ? advisors.panel.length : 0,
              },
            }
          : null,
      });
      const lastDaily = reportState.lastDailyAt ? Date.parse(reportState.lastDailyAt) : 0;
      if (Date.now() - lastDaily >= 24 * 3_600_000) {
        const body = await dailyReport({
          rig,
          harnessUrl,
          harnessToken,
          exportState,
          adviseState,
        });
        await toControl("/reports", { kind: "daily", body });
        reportState = { lastDailyAt: new Date().toISOString() };
        save(reportPath, reportState);
      }
    } catch (err) {
      log("supervisor", "control report error", { error: String(err) });
    }
    const until = Date.now() + intervalMs;
    // A wipe the command loop delivered is acted on at once, not at the next report.
    while (!stopping && !wipeRequested && Date.now() < until)
      await new Promise((r) => setTimeout(r, 250));
  }
  await advisingDone;
  await livingDone;
  await commandingDone;
  await routingDone;
  await syncingKbDone;
  process.exit(0);
}

main().catch((err) => {
  log("supervisor", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
