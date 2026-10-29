import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { keepChampionPatch } from "../../src/control/champions.ts";
import { issueCommand } from "../../src/control/issue/index.ts";
import { nextRunName } from "../../src/control/run-names.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { findRun } from "../../src/control/views/index.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";

/** A rig's report of these events, in `ledger`. */
function report(
  store: ControlStore,
  rig: string,
  ledger: string,
  events: [string, string, object][],
) {
  store.rigEvents.ingest({
    rig,
    ledger_id: ledger,
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([kind, subject, body], i) => ({
      id: i + 1,
      at: new Date().toISOString(),
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

describe("a run's name is used once on control (goal 170)", () => {
  const keys = generateSigningKeys();
  const assign = (store: ControlStore, rig: string, run: string) =>
    issueCommand(store, keys.privateKeyPem, {
      rig,
      kind: "assign_campaign",
      payload: {
        run,
        contract: { campaign: "sort-speed", mode: "hill_climb" },
        contract_sha: "a".repeat(64),
        imports: [],
      },
      issuedBy: "owner:api",
    });

  test("a used name is refused on every rig, also after a full reset; a failed one is free", () => {
    const store = new ControlStore(":memory:");
    store.enrollments.setConfiguredRigs(["rig-a", "rig-b"]);
    const first = assign(store, "rig-a", "sort-speed-1");
    // On its way: refused on the other rig too, and Start a run names the next.
    assert.throws(
      () => assign(store, "rig-b", "sort-speed-1"),
      /^Error: run sort-speed-1 was used already, on rig-a: a run's name is used once on control, on every rig\. Choose another, such as sort-speed-2$/,
    );
    assert.equal(nextRunName(store, "sort-speed"), "sort-speed-2");
    // The rig ran it, then a full reset gave it a new ledger: the name stays used.
    store.commands.ack("rig-a", first.id, "delivered", { source: "harness" });
    report(store, "rig-a", "ledger-1", [
      ["run_created", "sort-speed-1", { campaign: "sort-speed" }],
    ]);
    report(store, "rig-a", "ledger-2", []);
    assert.throws(() => assign(store, "rig-a", "sort-speed-1"), /was used already, on rig-a/);
    // An assignment that failed started nothing: its name is free again.
    const failed = assign(store, "rig-b", "sort-speed-7");
    store.commands.ack("rig-b", failed.id, "failed", { error: "staging failed" });
    assert.ok(assign(store, "rig-b", "sort-speed-7").id);
  });

  test("a champion of the same run name in another ledger keeps its own patch", () => {
    const store = new ControlStore(":memory:");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const old = Buffer.from("old run's champion\n");
    const now = Buffer.from("new run's champion\n");
    const published = (patch: Buffer) => ({
      seq: 2,
      sha256: sha(patch),
      base_commit: "c".repeat(40),
    });
    // The patch the owner reads: the one of the run's view, in the ledger it gives.
    const patchOf = () => {
      const x = findRun(store, "r-1");
      return x && store.championPatches.get("rig-a", x.rig.ledger_id, "r-1", 2);
    };
    report(store, "rig-a", "ledger-1", [
      ["run_created", "r-1", { campaign: "sort-speed" }],
      ["champion_published", "r-1", published(old)],
    ]);
    assert.equal(keepChampionPatch(store, "rig-a", "r-1", 2, old), "stored");
    // A run of the same name in the rig's next ledger publishes its own champion 2.
    report(store, "rig-a", "ledger-2", [
      ["run_created", "r-1", { campaign: "sort-speed" }],
      ["champion_published", "r-1", published(now)],
    ]);
    assert.equal(patchOf(), undefined, "not the old run's patch");
    assert.equal(keepChampionPatch(store, "rig-a", "r-1", 2, now), "stored");
    assert.equal(patchOf()?.patch.toString(), now.toString());
  });
});
