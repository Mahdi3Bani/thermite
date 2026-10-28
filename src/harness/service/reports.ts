import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type KeyPairPem, reportBody, signJson } from "../../core/commands.ts";
import { liveBody } from "../../core/live.ts";
import { writeExport } from "../outbox.ts";
import type { HarnessService } from "./index.ts";

/**
 * What the harness reports through its supervisor: the live log and the snapshot of events and
 * summary, each signed with the rig's own key (`rigKeys`, when it has one), and its exports.
 */

/** Lines of the live log after `after`, signed with the rig's key like a report. */
export function liveBatch(
  svc: HarnessService,
  rigKeys: KeyPairPem | undefined,
  after: number,
  limit: number,
): unknown {
  const { entries, next } = svc.live.since(after, limit);
  const batch = { rig: svc.rig, log_id: svc.live.id, from: after, next, entries };
  return rigKeys
    ? {
        ...batch,
        rig_pubkey: rigKeys.publicKeyPem,
        signature: signJson(liveBody(batch), rigKeys.privateKeyPem),
      }
    : batch;
}

/**
 * A page of events with the current summary, signed with the rig's own key so that control
 * can tell the harness's report from anything the supervisor (which relays it) might invent.
 */
export function snapshot(
  svc: HarnessService,
  rigKeys: KeyPairPem | undefined,
  cursor: number,
  limit: number,
): unknown {
  const page = svc.ledger.eventsAfter(cursor, limit);
  const report = {
    rig: svc.rig,
    ledger_id: svc.ledger.ledgerId(),
    cursor,
    next: page.next,
    events: page.events,
    summary: {
      ...(svc.ledger.summary() as Record<string, unknown>),
      ...(svc.hardware ? { hardware: svc.hardware } : {}),
      ...(svc.build ? { build: svc.build } : {}),
      // Which model route the agents use (its name and the key's hint, never the key).
      ...(svc.models ? { model: svc.models.info() } : {}),
      // What runs on this rig and how (Edit rig).
      settings: svc.settings.get(),
      ...(svc.settings.unreadable ? { settings_unreadable: svc.settings.unreadable } : {}),
      // What still runs, and whether the rig drains (goal 079): control restarts a draining
      // rig once nothing runs.
      work: svc.work(),
      ...(svc.gpuSplit ? { gpu_split: svc.gpuSplit } : {}),
      ...(svc.subscriptionUsage && svc.models?.info().source !== "none"
        ? {
            subscription_usage: {
              ...svc.subscriptionUsage,
              provider: svc.models?.info().name ?? null,
            },
          }
        : {}),
    },
    generated_at: svc.clock().toISOString(),
    latest_event: svc.ledger.latestEventId(),
  };
  return rigKeys
    ? {
        ...report,
        rig_pubkey: rigKeys.publicKeyPem,
        signature: signJson(reportBody(report), rigKeys.privateKeyPem),
      }
    : report;
}

/**
 * Exports the supervisor has pushed (or committed, without a remote) leave the outbox, so it
 * does not grow forever. Only recorded export names are removed.
 */
export function removeExports(svc: HarnessService, names: string[]): number {
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9TZ]+-[0-9a-f]{8}$/.test(name)) continue;
    const known = svc.ledger.exports.at(name);
    const dir = join(svc.paths.outboxDir, name);
    if (!known || !existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** An export for the supervisor: normal, full or one run's (outbox.ts says what each holds). */
export async function exportForSupervisor(
  svc: HarnessService,
  actor: string,
  o: { full?: boolean; run?: string | undefined },
) {
  return writeExport({
    ledger: svc.ledger,
    mirrorFor: (repo) => svc.mirrorFor(repo),
    outboxDir: svc.paths.outboxDir,
    rig: svc.rig,
    actor,
    ...o,
    researchDir: o.full || o.run ? join(svc.paths.stateDir, "research") : undefined,
    researchFolder: svc.researchFolder,
  });
}
