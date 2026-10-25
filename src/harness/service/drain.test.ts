import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { makeJudgeEnv } from "../../testing/judge-env.ts";
import { Ledger } from "../ledger.ts";
import { HarnessService } from "../service.ts";
import { drainSpans, endDrainAtStart, RESTARTED } from "./drain.ts";

const T0 = Date.parse("2026-10-25T00:00:00.000Z");
const min = (m: number) => T0 + m * 60_000;

/** A ledger whose events are written at the minute `at` says. */
function ledgerAt() {
  let now = T0;
  const path = join(mkdtempSync(join(tmpdir(), "thermite-drain-")), "ledger.db");
  const ledger = Ledger.open(path, () => new Date(now));
  const at = (m: number, kind: string, body: unknown = {}) => {
    now = min(m);
    ledger.appendEvent("t", kind, kind === "trial_started" ? "r-1" : null, body);
  };
  return { ledger, at };
}

describe("when the rig drained (goal 136)", () => {
  test("from each drain to its end, or to the first trial after it; one under way runs to now", () => {
    const { ledger, at } = ledgerAt();
    assert.deepEqual(drainSpans(ledger, min(1)), [], "no drain: none");
    at(5, "trial_started");
    // A drain called off.
    at(10, "rig_drain", { drain: true, reason: "its images are about to change" });
    at(20, "rig_drain", { drain: false });
    // Asked again while it drains: the same drain. A harness older than goal 136 recorded no end
    // at its restart; the first trial after it shows the drain had ended.
    at(30, "rig_drain", { drain: true });
    at(35, "rig_drain", { drain: true });
    at(50, "trial_started");
    // Then a drain that a restart ended, recorded as the harness started again.
    at(60, "rig_drain", { drain: true });
    at(70, "rig_drain", { drain: false, reason: RESTARTED });
    at(75, "trial_started");
    // And one under way.
    at(80, "rig_drain", { drain: true });
    assert.deepEqual(drainSpans(ledger, min(95)), [
      [min(10), min(20)],
      [min(30), min(50)],
      [min(60), min(70)],
      [min(80), min(95)],
    ]);
  });

  test("a restart ends a drain under way, and the harness records the end as it starts", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    assert.equal(endDrainAtStart(env.ledger, "harness"), false, "no drain: nothing to end");
    await env.service.applyCommand(env.sign("drain_rig", { drain: true, reason: "new images" }));
    const ends = () =>
      env.ledger.db
        .prepare("select actor, body from event where kind = 'rig_drain' order by id")
        .all()
        .map((r) => ({ actor: String(r.actor), ...JSON.parse(String(r.body)) }));
    assert.equal(ends().length, 1);
    // The harness starts again on the same ledger: the drain it kept in memory is gone.
    const again = new HarnessService({
      rig: env.service.rig,
      ledger: env.ledger,
      paths: env.paths,
      controlPublicKeyPem: env.keys.publicKeyPem,
    });
    assert.equal(again.draining, undefined);
    const last = ends().at(-1);
    assert.deepEqual(
      { actor: last?.actor, drain: last?.drain, reason: last?.reason },
      { actor: "harness", drain: false, reason: RESTARTED },
    );
    const spans = drainSpans(env.ledger, Date.now() + 60_000);
    assert.equal(spans.length, 1);
    assert.ok((spans[0]?.[1] ?? 0) <= Date.now(), "the drain ended at the restart, not now");
    // Started again with no drain open: nothing more is recorded.
    assert.equal(endDrainAtStart(env.ledger, "harness"), false);
    assert.equal(ends().length, 2);
  });
});
