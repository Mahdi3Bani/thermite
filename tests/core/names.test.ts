import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { currentAgent, currentEvent } from "../../src/core/names.ts";

/** Records written under v0.1.0's names read under the public ones (goal 125, T1). */
describe("the agents' public names", () => {
  test("an agent alone, or naming a writer; other names unchanged", () => {
    assert.equal(currentAgent("combiner"), "merged_by");
    assert.equal(currentAgent("panel"), "review_panel");
    assert.equal(currentAgent("panel:reviewer-2"), "review_panel:reviewer-2");
    for (const name of ["review_panel", "teachers:teacher-1", "panelist", "lane-1", ""])
      assert.equal(currentAgent(name), name);
  });

  test("each kind's field that names an agent; the same event when nothing changes", () => {
    const old = (kind: string, body: Record<string, unknown>) =>
      currentEvent({ id: 1, kind, body }).body;
    assert.deepEqual(old("model_call", { agent: "combiner", model: "m" }), {
      agent: "merged_by",
      model: "m",
    });
    assert.deepEqual(old("advisor_answer", { role: "panel" }), { role: "review_panel" });
    assert.deepEqual(old("agent_message", { to: "panel" }), { to: "review_panel" });
    assert.deepEqual(old("agent_message_read", { by: "panel" }), { by: "review_panel" });
    assert.deepEqual(old("journal_note", { by: "panel:reviewer-1" }), {
      by: "review_panel:reviewer-1",
    });
    // Another kind's field of that name is not an agent's.
    assert.deepEqual(old("review_panel", { result: "panel" }), { result: "panel" });
    const now = { id: 2, kind: "model_call", body: { agent: "workers" } };
    assert.equal(currentEvent(now), now);
  });
});
