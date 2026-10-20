import assert from "node:assert/strict";
import { test } from "node:test";
import { KnowledgeBase } from "./kb.ts";
import { ControlStore } from "./store.ts";

/** A rig's events as control receives them (subject first, then the body). */
function ingest(
  store: ControlStore,
  rig: string,
  events: [string, string, string, Record<string, unknown>][],
  from = 0,
) {
  store.ingest({
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: from,
    next: from + events.length,
    generated_at: new Date(Date.parse("2026-10-20T01:00:00Z") + from * 1000).toISOString(),
    events: events.map(([actor, kind, subject, body], i) => ({
      id: from + i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + (from + i) * 60_000).toISOString(),
      actor,
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

test("each campaign's folder is built from its runs' events; folders are read only where granted", () => {
  const store = new ControlStore(":memory:");
  const kb = new KnowledgeBase(store.db);
  ingest(store, "rig-a", [
    ["harness", "run_created", "pn-3", { campaign: "pn-engine", mode: "goal" }],
    [
      "planner",
      "experiment_added",
      "pn-3",
      {
        id: "x-1",
        title: "Load int4 weights with vector loads",
        why: "the guide says twice the bandwidth",
        family: "memory-layout",
        by: "teacher",
      },
    ],
    [
      "lane-1",
      "journal_note",
      "pn-3",
      {
        id: 1,
        by: "lane-1",
        kind: "observation",
        text: "The L2 is 4 MB; the working set is 6.3 MB, so weights stream from memory.",
        about: { type: "trial", id: "t-1" },
      },
    ],
    [
      "harness",
      "attempt_recorded",
      "a-1",
      { run: "pn-3", lane: "lane-1", hypothesis: "vector loads for the weights" },
    ],
    ["judge", "verdict", "a-1", { verdict: "win_confirmed", delta: 0.061 }],
    [
      "harness",
      "experiment_finished",
      "pn-3",
      { id: "x-1", lane: "lane-1", trial: "t-1", attempt: "a-1", result: "submitted" },
    ],
  ]);
  ingest(store, "rig-b", [
    ["harness", "run_created", "rl-2", { campaign: "rl-research", mode: "research" }],
    [
      "lane-1",
      "source_fetched",
      "rl-2",
      {
        source: "s-1",
        domain: "arxiv.org",
        url: "https://arxiv.org/abs/1",
        title: "Limits of self-training",
      },
    ],
    [
      "lane-1",
      "claim_added",
      "rl-2",
      { claim: "c-1", question: 2, verified: true, text: "gains vanish without a verifier" },
    ],
    [
      "lane-2",
      "finding_added",
      "rl-2",
      {
        finding: "f-1",
        claims: 6,
        supported: true,
        statement: "Self-training helps only where a verifier exists",
      },
    ],
  ]);
  assert.ok(kb.catchUp() >= 10);
  assert.equal(kb.catchUp(), 0, "nothing new: the cursor moved on");
  const folders = kb.folders();
  const pn = folders.find((f) => f.campaign === "pn-engine");
  assert.deepEqual(pn?.counts, { attempt: 1, experiment: 1, note: 1 });
  // The experiment carries its result, the attempt its verdict, the note its kind.
  const [exp] = kb.search("vector", ["pn-engine"], { kinds: ["experiment"] });
  assert.match(
    String(exp?.body),
    /Why: the guide says twice the bandwidth[\s\S]*Result: attempt a-1 \(submitted\)/,
  );
  const [att] = kb.search("vector", ["pn-engine"], { kinds: ["attempt"] });
  assert.match(String(att?.body), /Verdict: win_confirmed \(\+6\.10%\)/);
  const [note] = kb.search("working set", ["pn-engine"]);
  assert.equal(note?.kind, "note");
  assert.equal(note?.sub, "observation");
  assert.equal(note?.by, "lane-1");
  // Search stays inside the folders given; a grant adds another campaign's folder.
  assert.deepEqual(kb.search("verifier", ["pn-engine"]), []);
  assert.equal(kb.search("verifier", ["rl-research"]).length, 2);
  kb.grant("pn-engine", "rl-research", "owner:ui");
  assert.deepEqual(kb.reads("pn-engine"), ["rl-research"]);
  assert.deepEqual(kb.readBy("rl-research"), ["pn-engine"]);
  assert.equal(kb.search("verifier", ["pn-engine", ...kb.reads("pn-engine")]).length, 2);
  assert.equal(kb.revoke("pn-engine", "rl-research"), true);
  assert.deepEqual(kb.reads("pn-engine"), []);
  // A campaign never reads itself as a grant.
  kb.grant("pn-engine", "pn-engine", "owner:ui");
  assert.deepEqual(kb.reads("pn-engine"), []);
  // Later events update the same items, and new ones are added.
  ingest(
    store,
    "rig-a",
    [
      [
        "planner",
        "experiment_dropped",
        "pn-3",
        { id: "x-1", by: "planner", why: "a rule avoids it" },
      ],
    ],
    6,
  );
  kb.catchUp();
  const [dropped] = kb.search("vector", ["pn-engine"], { kinds: ["experiment"] });
  assert.match(String(dropped?.body), /Dropped: a rule avoids it/);
  assert.doesNotMatch(String(dropped?.body), /Result:/);
});
