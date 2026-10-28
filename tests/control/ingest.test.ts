import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bus, BusMessage } from "../../src/common/bus.ts";
import { foldReport, followReports, type Intake } from "../../src/control/ingest.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { REPORT_CONSUMER, REPORT_STREAM, reportSubject } from "../../src/core/link/report.ts";
import { buildHeaders, buildInfo } from "../../src/core/version.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { appendOther } from "../helpers/kinds.ts";

/** Control's store and what taking reports needs, with rig-a and rig-b given tokens. */
function intake(): Intake {
  const store = new ControlStore(":memory:");
  store.enrollments.setConfiguredRigs(["rig-a", "rig-b"]);
  return { store, control: buildInfo(), requireKeyAcceptance: false };
}

let seq = 0;
/** A report as it comes off the bus: on `subject`, with the supervisor's build in its headers. */
function message(report: unknown, subject = reportSubject("rig-a")): BusMessage {
  const h = buildHeaders();
  return {
    subject,
    seq: ++seq,
    data: new TextEncoder().encode(JSON.stringify(report)),
    header: (name) => h[name],
  };
}

/** A harness of rig-a with `n` events, and its signed pages. */
function harness(n: number) {
  const env = makeHarnessEnv("rig-a");
  for (let i = 0; i < n; i++) appendOther(env.service.ledger, "t", "step", null, { i });
  const page = (cursor: number, limit: number) =>
    env.service.snapshot(cursor, limit) as {
      ledger_id: string;
      cursor: number;
      next: number;
      events: unknown[];
      generated_at: string;
    };
  return { env, page };
}

const kinds = (t: Intake, rig = "rig-a") =>
  (t.store.rigEvents.after(rig, 0, 1000) as { kind: string }[]).map((e) => e.kind);
const refusals = (t: Intake) =>
  t.store.auditLog
    .list(50)
    .filter((a) => a.action === "report_refused")
    .map((a) => (a.body as { reason: string }).reason);

describe("control folds rigs' reports from the message bus", () => {
  test("a stream of reports is folded through the ingest checks, each message acked", async () => {
    const t = intake();
    const { page } = harness(25);
    const pages = [page(0, 10), page(10, 10), page(20, 10)];
    const acked: number[] = [];
    let followed: { stream?: string; consumer?: string } = {};
    // The bus as followReports sees it: each message handed over in order, and acked after.
    const bus: Pick<Bus, "follow"> = {
      async follow(stream, consumer, handle) {
        const name = typeof stream === "string" ? stream : stream.name;
        followed = { stream: name, consumer: consumer.durable_name };
        for (const p of pages) {
          const m = message(p);
          await handle(m);
          acked.push(m.seq);
        }
      },
    };
    await followReports(bus, t);
    assert.deepEqual(followed, { stream: REPORT_STREAM, consumer: REPORT_CONSUMER });
    assert.equal(acked.length, 3);
    assert.equal(kinds(t).length, 25);
    // The first report pinned the rig's key, and the supervisor's build came with the message.
    assert.ok(t.store.reportedRigs.key("rig-a").pubkey);
    assert.equal(t.store.builds.ofRig("rig-a", "supervisor")?.version, buildInfo().version);
    assert.equal(t.store.builds.ofRig("rig-a", "harness")?.version, buildInfo().version);
    assert.equal(t.store.reportedRigs.list()[0]?.last_cursor, 25);
  });

  test("a page the bus hands twice is skipped, and so is an older one", async () => {
    const t = intake();
    const { env, page } = harness(10);
    const first = page(0, 10);
    assert.deepEqual(foldReport(t, message(first)), { folded: 10 });
    assert.deepEqual(foldReport(t, message(first)), { skipped: "taken already" });
    // A newer report with nothing new is taken: it says the rig is alive.
    await new Promise((r) => setTimeout(r, 5));
    const alive = page(10, 10);
    assert.deepEqual(foldReport(t, message(alive)), { folded: 0 });
    // The first page again, after a newer one was taken: skipped, never refused as old.
    assert.deepEqual(foldReport(t, message(first)), { skipped: "taken already" });
    // A page that brings new events after a skip is folded.
    appendOther(env.service.ledger, "t", "late", null, {});
    assert.deepEqual(foldReport(t, message(page(10, 10))), { folded: 1 });
    assert.equal(kinds(t).length, 11);
    assert.deepEqual(refusals(t), []);
  });

  test("a gap is refused and recorded as over HTTP, and the pages after it still fold", () => {
    const t = intake();
    const { page } = harness(25);
    assert.deepEqual(foldReport(t, message(page(0, 10))), { folded: 10 });
    const ahead = page(20, 10);
    assert.deepEqual(foldReport(t, message(ahead)), { refused: "a gap in the event stream" });
    assert.deepEqual(refusals(t), ["a gap in the event stream"]);
    assert.equal(kinds(t).length, 10);
    // The page that closes the gap, from where control is, folds; then the one after it.
    assert.deepEqual(foldReport(t, message(page(10, 10))), { folded: 10 });
    assert.deepEqual(foldReport(t, message(page(20, 10))), { folded: 5 });
    assert.equal(kinds(t).length, 25);
  });

  test("a report whose signed rig is not the subject's rig is refused", () => {
    const t = intake();
    const { page } = harness(3);
    const forRigA = page(0, 10);
    // Published on rig-b's subject: the signature says rig-a, so nothing is taken for either.
    const refused = foldReport(t, message(forRigA, reportSubject("rig-b")));
    assert.deepEqual(refused, { refused: "rig mismatch" });
    assert.deepEqual(kinds(t, "rig-a"), []);
    assert.deepEqual(kinds(t, "rig-b"), []);
    assert.equal(t.store.reportedRigs.key("rig-b").pubkey, null, "no key is pinned for rig-b");
    // Its own subject takes it.
    assert.deepEqual(foldReport(t, message(forRigA)), { folded: 3 });
  });

  test("a subject or rig control does not know, a retired rig and a forged report are refused", () => {
    const t = intake();
    const { page } = harness(2);
    const report = page(0, 10);
    const refusedFor = (m: BusMessage) => (foldReport(t, m) as { refused?: string }).refused;
    assert.equal(
      refusedFor(message(report, "thermite.rig.rig-a.cmd")),
      "not a rig's report subject",
    );
    assert.equal(
      refusedFor(message(report, reportSubject("rig-c"))),
      "no such rig: control has no token for it",
    );
    const notJson = { ...message(report), data: new TextEncoder().encode("{") };
    assert.equal(refusedFor(notJson), "not a report");
    assert.equal(refusedFor(message({ ...report, events: "none" })), "not a report");
    const forged = { ...report, next: report.next + 1 };
    assert.equal(refusedFor(message(forged)), "bad report signature");
    const { signature: _s, ...unsigned } = report as typeof report & { signature: string };
    assert.equal(refusedFor(message(unsigned)), "unsigned report");
    t.store.retired.add("rig-a", "owner:test");
    assert.equal(refusedFor(message(report)), "this rig is retired in control");
    assert.deepEqual(kinds(t), []);
  });

  test("a rig whose supervisor control cannot work with is refused, and its calls counted", () => {
    const t = intake();
    const { page } = harness(2);
    // Its supervisor said so on a call over HTTP: it works with protocol 99 or later only.
    const newer = { version: "9.0.0", commit: null, protocol: 99, oldest_protocol: 99 };
    t.store.builds.setRig("rig-a", "supervisor", newer);
    const refused = (foldReport(t, message(page(0, 10))) as { refused?: string }).refused;
    assert.match(refused ?? "", /^Control cannot work with this rig: its supervisor works with/);
    assert.equal(t.store.refusals.get("rig-a")?.calls, 1);
    assert.deepEqual(kinds(t), []);
  });
});
