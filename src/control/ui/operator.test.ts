import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Decision } from "../store.ts";
import { decidedState } from "./operator.ts";

const NOW = Date.parse("2026-10-21T21:00:00Z");
const item = { rig: "rig-a", run: "run-1", attempt: "a-1" };
const label = (d: Decision) =>
  d.kind === "approve_promotion" ? "Make it the champion" : "Reject it";
const decision = (o: Partial<Decision>): Decision => ({
  id: "c-1",
  rig: "rig-a",
  kind: "decline_promotion",
  run: "run-1",
  attempt: "a-1",
  issued_at: "2026-10-21T20:59:50Z",
  status: "pending",
  acked_at: null,
  outcome: null,
  ...o,
});

describe("a decision the owner made", () => {
  test("sent, or done by the rig: the item leaves the lists at once", () => {
    const pending = decidedState([decision({})], item, "2026-10-21T20:00:00Z", label, NOW);
    assert.equal(pending?.sent, true);
    assert.match(pending?.html ?? "", /Control sent it to the rig/);
    const done = decidedState(
      [decision({ status: "delivered", outcome: { accepted: true, result: {} } })],
      item,
      "2026-10-21T20:00:00Z",
      label,
      NOW,
    );
    assert.equal(done?.sent, true);
    assert.match(done?.html ?? "", /The rig rejected the change\./);
    assert.doesNotMatch(done?.html ?? "", /goes away after the next report/);
  });

  test("refused by the rig: the item comes back, with the cause and its buttons", () => {
    const refused = decidedState(
      [
        decision({
          status: "delivered",
          outcome: { accepted: false, result: { error: "the run is closed" } },
        }),
      ],
      item,
      "2026-10-21T20:00:00Z",
      label,
      NOW,
    );
    assert.equal(refused?.sent, false);
    assert.match(
      refused?.html ?? "",
      /The rig did not do it\. The cause from the rig: the run is closed\./,
    );
    const expired = decidedState([decision({ status: "expired" })], item, undefined, label, NOW);
    assert.equal(expired?.sent, false);
  });

  test("an item that waits again, after the choice, needs the owner again", () => {
    // The item began waiting after the owner's choice: the old choice is not this wait's.
    const again = decidedState([decision({})], item, "2026-10-21T20:59:55Z", label, NOW);
    assert.equal(again, undefined);
  });
});
