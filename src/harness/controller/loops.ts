import type { ServerType } from "@hono/node-server";
import { log } from "../../common/log.ts";
import type { Scheduler } from "../agents/index.ts";
import type { Judge } from "../judge/index.ts";
import type { Ledger } from "../ledger/index.ts";
import { settlePropagations } from "../propagation.ts";
import type { RigSettingsStore } from "../rig-settings.ts";
import type { HarnessService } from "../service/index.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The controller's loops: the judging loops, the scheduler's and the exports', and the stop on
 * SIGTERM or SIGINT.
 */
export function startLoops(
  ctx: ControllerContext,
  {
    ledger,
    service,
    settings,
    scheduler,
    executors,
    executorIds,
    server,
  }: {
    ledger: Ledger;
    service: HarnessService;
    settings: RigSettingsStore;
    scheduler: Scheduler;
    executors: Judge[];
    executorIds: string[];
    server: ServerType;
  },
): void {
  const { numbers } = ctx;
  const exportEveryMs = numbers.exportEveryMs;
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
        // takes no new job (goal 079): the one under way finishes first. It still takes back a
        // lease that ran out, which starts nothing: its holder is gone.
        if (settings.get().judge && !service.draining) worked = await executor.tick();
        else if (service.draining) executor.expireLeases();
      } catch (err) {
        log("harness", "executor error", { executor: id, error: String(err) }, "error");
      }
      if (!worked) await sleep(1000);
    }
  };
  const scheduling = async () => {
    while (!stopping) {
      try {
        await scheduler.tick();
      } catch (err) {
        log("harness", "scheduler error", { error: String(err) }, "error");
      }
      await sleep(2000);
    }
  };
  const exporting = async () => {
    while (!stopping) {
      try {
        settlePropagations(ledger, "harness");
      } catch (err) {
        log("harness", "propagation settle error", { error: String(err) }, "error");
      }
      // Hourly export for the supervisor to push (and an export command can force one). An
      // export's own event is not news, or an idle rig would export every hour forever.
      const last = ledger.exports.last();
      const lastAt = last ? Date.parse(last.created_at) : 0;
      if (
        settings.get().exports &&
        ledger.recordedAfter(last?.through_event ?? 0, ["export_written"]) &&
        Date.now() - lastAt >= exportEveryMs
      ) {
        try {
          await service.export("scheduler");
        } catch (err) {
          log("harness", "export error", { error: String(err) }, "error");
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
