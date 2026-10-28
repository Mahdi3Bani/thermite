import type { Bus, BusMessage } from "../common/bus.ts";
import { log, redact } from "../common/env.ts";
import { errorText } from "../common/errors.ts";
import {
  REPORT_CONSUMER_CONFIG,
  REPORT_STREAM_CONFIG,
  readReport,
  reportSignedBy,
  rigOfSubject,
  type SignedReport,
} from "../core/link/report.ts";
import { type BuildInfo, buildFromHeaders, readBuild } from "../core/version.ts";
import type { ControlStore } from "./store.ts";
import { checkRig } from "./versions.ts";

/**
 * How control takes a rig's signed report: posted to `POST /v1/rigs/<rig>/ingest`, or read from
 * the message bus (goal 168). Both go through takeReport, with the same checks, refusals and
 * records.
 */

/** What taking a report needs: the store, control's build, and whether keys wait for the owner. */
export interface Intake {
  store: ControlStore;
  control: BuildInfo;
  /** Hold every rig's first report key for the owner's acceptance (no trust on first use). */
  requireKeyAcceptance: boolean;
}

/** A refusal, as the ingest route answers it: its words, and control's cursor after a gap. */
type Refused = { error: string; expected_cursor?: number | undefined };

/**
 * Takes a report for `rig`, read by readReport: its signature against the rig's pinned key (pinned
 * or held here at first contact), its place in the rig's event stream, its time, and the harness's
 * build. The status and the answer.
 */
export function takeReport(
  t: Intake,
  rig: string,
  read: { report: SignedReport; unknown: number },
): [200, { added: number }] | [400 | 403 | 409, Refused] {
  const { store, control } = t;
  const body = read.report;
  if (body.rig !== rig) return [403, { error: "rig mismatch" }];
  // Reports are signed by the harness: the supervisor relays them but cannot forge them.
  if (!body.signature || !body.rig_pubkey) return [400, { error: "unsigned report" }];
  const key = store.rigKey(rig);
  const offered = body.rig_pubkey.trim();
  // A key is pinned or held only if the report it came with verifies under it.
  if (!reportSignedBy(body, offered)) {
    store.audit(`rig:${rig}`, "report_rejected", { reason: "bad signature" });
    return [403, { error: "bad report signature" }];
  }
  if (!key.pubkey) {
    // First contact: pinned, unless the owner must accept every rig's first key.
    if (t.requireKeyAcceptance) {
      if (key.pending?.trim() !== offered) store.holdKey(rig, offered);
      return [409, { error: "the rig's key waits for the owner's acceptance" }];
    }
    store.pinKey(rig, offered);
  } else if (key.pubkey.trim() !== offered) {
    if (key.pending?.trim() !== offered) store.holdKey(rig, offered);
    return [409, { error: "rig key changed: the owner must accept the new key" }];
  }
  // Freshness and completeness: no report from a ledger this rig has left, no gap in the
  // event stream, and nothing older than the newest report already taken.
  const fresh = store.reportCheck(rig, {
    ledgerId: body.ledger_id,
    cursor: body.cursor,
    generatedAt: body.generated_at,
  });
  if (!fresh.ok) {
    store.audit(`rig:${rig}`, "report_refused", { reason: fresh.reason });
    return [409, { error: fresh.reason, expected_cursor: fresh.expectedCursor }];
  }
  if (Date.parse(body.generated_at) > Date.now() + 5 * 60_000)
    return [409, { error: "report from the future" }];
  // The harness's build, from the signed summary of a fresh report (none from a harness before
  // version checks): recorded, and the report refused while its protocol and control's do not
  // meet. A replayed old report never gets this far, so it cannot change the recorded build.
  store.setRigBuild(rig, "harness", readBuild((body.summary as { build?: unknown })?.build));
  const refused = checkRig(store, rig, control);
  if (refused) {
    store.countRefusedCall(rig);
    return [409, { error: refused }];
  }
  if (read.unknown) {
    const leftOut = { rig, left_out: read.unknown };
    log("control", "a report with fields control does not know", leftOut, "debug");
  }
  const added = store.ingest(body);
  // Into the knowledge base now, while this report's ledger is the rig's (it reads only a rig's
  // current ledger). After a failure the next report or read catches up.
  try {
    store.kb();
  } catch (err) {
    const error = redact(errorText(err));
    log("control", "knowledge base catch-up failed", { rig, error }, "error");
    store.audit("control", "kb_failed", { rig, error });
  }
  noteReportAfterWait(store, rig);
  return [200, { added }];
}

/**
 * A rig control marked failed (its update or start waited too long) that reports again works: say
 * so, and show it as running.
 */
function noteReportAfterWait(store: ControlStore, rig: string): void {
  if (store.clusterRig(rig)?.status !== "failed") return;
  store.setClusterRigStatus(rig, "running");
  // Named for the wait that ended: its first report, one after new images, or after a start.
  const failed = store
    .rigSetupEvents(rig)
    .filter((x) => !x.ok)
    .at(-1)?.step;
  const step =
    failed === "first_report"
      ? "first_report"
      : failed === "pods_running" || failed === "report_after_start"
        ? "report_after_start"
        : failed === "resources" ||
            failed === "resources_running" ||
            failed === "report_after_resources"
          ? "report_after_resources"
          : "report_after_images";
  store.rigSetupEvent(rig, step, true, "it reported after the wait ended");
}

/** What one message from the reports stream came to. */
export type Folded = { folded: number } | { skipped: string } | { refused: string };

/**
 * Whether control holds this report already: from the rig's current ledger, every event in it
 * taken, and a report at least as new taken too. It brings nothing new, such as a page the bus
 * hands again after control folded it but before its ack arrived.
 */
function alreadyTaken(store: ControlStore, rig: string, r: SignedReport): boolean {
  const u = store.db
    .prepare("select ledger_id, last_cursor, report_at from rig where id = ?")
    .get(rig) as { ledger_id: unknown; last_cursor: unknown; report_at: unknown } | undefined;
  return (
    u !== undefined &&
    u.ledger_id === r.ledger_id &&
    r.next <= Number(u.last_cursor) &&
    typeof u.report_at === "string" &&
    r.generated_at <= u.report_at
  );
}

/**
 * One message from the reports stream, through the checks a rig's call to the ingest route gets
 * (rigAuth in api.ts) and then takeReport. The subject's rig must be the report's signed rig. A
 * page control has already is skipped; a refusal, a gap among them, is recorded as over HTTP and
 * logged, since no answer goes back to the supervisor.
 */
export function foldReport(t: Intake, m: BusMessage): Folded {
  const { store, control } = t;
  const rig = rigOfSubject(m.subject);
  const refuse = (error: string, fields: Record<string, unknown> = {}): Folded => {
    log("control", "report from the bus refused", { rig, seq: m.seq, error, ...fields }, "warn");
    return { refused: error };
  };
  if (!rig) return refuse("not a rig's report subject", { subject: m.subject.slice(0, 200) });
  if (!store.knownRig(rig)) return refuse("no such rig: control has no token for it");
  if (store.rigRetired(rig)) return refuse("this rig is retired in control");
  let read: { report: SignedReport; unknown: number };
  try {
    read = readReport(JSON.parse(new TextDecoder().decode(m.data)));
  } catch {
    return refuse("not a report");
  }
  const r = read.report;
  const at = { ledger: r.ledger_id, cursor: r.cursor, next: r.next };
  if (alreadyTaken(store, rig, r)) {
    log("control", "report from the bus taken already", { rig, seq: m.seq, ...at }, "debug");
    return { skipped: "taken already" };
  }
  // Refused while the rig's recorded builds and control's do not meet, as a call over HTTP is.
  const early = checkRig(store, rig, control, { harness: null, endRefusal: false });
  if (early) {
    store.countRefusedCall(rig);
    return refuse(early, at);
  }
  const [status, answer] = takeReport(t, rig, read);
  if (status !== 200) {
    const why = answer as Refused;
    return refuse(why.error, { ...at, expected_cursor: why.expected_cursor });
  }
  // The supervisor's build from the message's headers, once its report verified: the bus has no
  // rig's token yet, so nothing else says who sent it.
  store.setRigBuild(rig, "supervisor", buildFromHeaders(m.header));
  return { folded: (answer as { added: number }).added };
}

/**
 * Folds the reports stream as it grows (goal 168): makes sure the stream and control's consumer
 * exist, then takes each message in order and acks it once folded, skipped or refused. Runs until
 * the bus is closed.
 */
export async function followReports(bus: Pick<Bus, "follow">, t: Intake): Promise<void> {
  await bus.follow(REPORT_STREAM_CONFIG, REPORT_CONSUMER_CONFIG, (m) => {
    foldReport(t, m);
  });
}
