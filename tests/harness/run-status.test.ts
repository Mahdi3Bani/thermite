import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger } from "../../src/harness/ledger.ts";
import { statusEvents } from "../../src/harness/run-status.ts";

test("a run's status changes are read under the names from before 2026-10-15 too (goal 163)", () => {
  const ledger = Ledger.open(":memory:");
  ledger.appendEvent("harness", "instance_status", "r-1", { status: "paused" });
  ledger.appendEvent("harness", "run_status", "r-2", { status: "running" });
  const resumed = ledger.appendEvent("harness", "run_status", "r-1", { status: "running" });
  assert.deepEqual(
    statusEvents(ledger, "r-1").map((e) => e.status),
    ["paused", "running"],
  );
  assert.deepEqual(
    statusEvents(ledger, "r-1", resumed - 1).map((e) => [e.id, e.status]),
    [[resumed, "running"]],
  );
  ledger.close();
});
