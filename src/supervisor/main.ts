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
import { type AdviseState, adviseOnce, emptyAdviseState } from "./advise.ts";
import { AdvisorsConfig } from "./advisors.ts";
import { type ExportState, exportOnce } from "./git-export.ts";
import { RelayError, type RelayState, relayOnce } from "./relay.ts";
import { dailyReport } from "./report.ts";
import { stageCommand } from "./staging.ts";

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
  const unit = requireEnv("THERMITE_UNIT_ID");
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
    unit,
    harnessUrl,
    harnessToken,
    controlUrl,
    controlToken,
    stage: (cmd: Parameters<typeof stageCommand>[1]) =>
      stageCommand(
        {
          unit,
          inboxDir,
          resultsRepo: join(home, "results.git"),
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
  const exportCfg = {
    unit,
    outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
    workDir: home,
    remote,
    sshKeyFile,
    knownHostsFile,
  };
  const advisorsFile = env.THERMITE_ADVISORS_FILE;
  const advisors = advisorsFile
    ? AdvisorsConfig.parse(JSON.parse(readFileSync(advisorsFile, "utf8")))
    : undefined;
  const advisePath = join(home, "advise-state.json");
  let adviseState: AdviseState = load(advisePath, emptyAdviseState());
  const reportPath = join(home, "report-state.json");
  let reportState = load<{ lastDailyAt?: string }>(reportPath, {});
  log("supervisor", "starting", {
    unit,
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
    const res = await fetch(`${controlUrl}/v1/units/${encodeURIComponent(unit)}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  };

  // Advisors run on their own: a teacher round can take many minutes.
  const advising = async () => {
    while (!stopping && advisors) {
      try {
        adviseState = await adviseOnce({ harnessUrl, harnessToken, home, advisors }, adviseState);
        save(advisePath, adviseState);
      } catch (err) {
        log("supervisor", "advisor loop error", { error: String(err) });
      }
      const until = Date.now() + Math.max(intervalMs, 30_000);
      while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    }
  };
  const advisingDone = advising();

  while (!stopping) {
    try {
      const next = await relayOnce(cfg, state);
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
        advisors: advisors ? adviseState.stats : null,
      });
      const lastDaily = reportState.lastDailyAt ? Date.parse(reportState.lastDailyAt) : 0;
      if (Date.now() - lastDaily >= 24 * 3_600_000) {
        const body = await dailyReport({
          unit,
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
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  }
  await advisingDone;
  process.exit(0);
}

main().catch((err) => {
  log("supervisor", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
