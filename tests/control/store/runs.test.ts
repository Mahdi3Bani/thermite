import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runNameUsed } from "../../../src/control/run-names.ts";
import { ControlStore } from "../../../src/control/store.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";

/**
 * Control's run registry (goal 170): every run control signed an assignment for and every run a
 * rig created. A name is used while its assignment goes through, or once a rig created it.
 */
const assignment = (id: string, rig: string, run: string, campaign = "sort-speed") =>
  ({
    envelope: {
      v: 1,
      id,
      rig,
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run, contract: { campaign } },
    },
    signature: "not checked by the store",
  }) as unknown as SignedCommand;

const created = (store: ControlStore, rig: string, run: string, campaign = "sort-speed") =>
  store.rigEvents.ingest({
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: 0,
    next: 1,
    events: [
      {
        id: 1,
        at: new Date().toISOString(),
        actor: "harness",
        kind: "run_created",
        subject: run,
        body: { campaign },
      },
    ],
    summary: {},
  });

describe("control's run registry", () => {
  test("an assignment uses its name until it is refused; a run a rig created keeps it", () => {
    const store = new ControlStore(":memory:");
    store.commands.enqueue(assignment("c-1", "rig-a", "sort-speed-1"));
    store.commands.enqueue(assignment("c-2", "rig-a", "sort-speed-2"));
    assert.equal(runNameUsed(store, "sort-speed-1"), "rig-a");
    assert.deepEqual([...store.runRegistry.usedNames("sort-speed-")].sort(), [
      "sort-speed-1",
      "sort-speed-2",
    ]);
    // A refused assignment frees its name; a delivered one keeps it.
    store.commands.ack("rig-a", "c-2", "failed", { error: "x" });
    store.commands.ack("rig-a", "c-1", "delivered", {});
    assert.equal(runNameUsed(store, "sort-speed-2"), undefined);
    assert.deepEqual(
      store.runRegistry.assignedCampaigns("rig-a"),
      new Map([["sort-speed-1", "sort-speed"]]),
    );
    // A run a rig reports creating uses its name, though control never assigned it there.
    created(store, "rig-b", "other-1", "other");
    assert.equal(runNameUsed(store, "other-1"), "rig-b");
    // What a rig claims is not what control assigned it.
    assert.deepEqual(store.runRegistry.assignedCampaigns("rig-b"), new Map());
  });

  test("a store from before has its registry made from its commands and its rigs' events", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");
    const old = new ControlStore(path);
    old.commands.enqueue(assignment("c-1", "rig-a", "sort-speed-1"));
    old.commands.enqueue(assignment("c-2", "rig-a", "sort-speed-2"));
    old.commands.ack("rig-a", "c-2", "failed", { error: "x" });
    created(old, "rig-b", "other-1", "other");
    // As a store at version 5 left it: no registry yet.
    old.db.exec("drop table run_registry; delete from schema_migrations where version >= 6");
    old.db.close();
    const store = new ControlStore(path);
    assert.deepEqual([...store.runRegistry.usedNames()].sort(), ["other-1", "sort-speed-1"]);
    assert.deepEqual(
      store.runRegistry.assignedCampaigns("rig-a"),
      new Map([["sort-speed-1", "sort-speed"]]),
    );
    store.db.close();
  });
});
