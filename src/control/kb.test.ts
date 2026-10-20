import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { KbSync } from "../core/kb.ts";
import { assigned } from "../testing/assignments.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";

type Ev = [string, string, string, Record<string, unknown>];

/** A rig's events as control receives them (subject first, then the body). */
function ingest(
  store: ControlStore,
  rig: string,
  events: Ev[],
  from = 0,
  ledger = `ledger-${rig}`,
) {
  store.ingest({
    rig,
    ledger_id: ledger,
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

/** Two rigs: a goal campaign with a run's journal and experiments, and a research campaign. */
function twoCampaigns(store: ControlStore) {
  ingest(store, "rig-a", [
    ["harness", "run_created", "gs-3", { campaign: "gemv-speed", mode: "goal" }],
    [
      "planner",
      "experiment_added",
      "gs-3",
      {
        id: "x-1",
        title: "Load int4 weights with vector loads",
        details: "128-bit loads of the packed weights",
        why: "the guide says twice the bandwidth",
        family: "memory-layout",
        by: "teacher",
      },
    ],
    [
      "lane-1",
      "journal_note",
      "gs-3",
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
      { run: "gs-3", lane: "lane-1", hypothesis: "vector loads for the weights" },
    ],
    ["judge", "verdict", "a-1", { verdict: "win_confirmed", delta: 0.061 }],
    [
      "harness",
      "experiment_finished",
      "gs-3",
      { id: "x-1", lane: "lane-1", trial: "t-1", attempt: "a-1", result: "submitted" },
    ],
  ]);
  ingest(store, "rig-b", [
    ["harness", "run_created", "sv-2", { campaign: "survey-study", mode: "research" }],
    [
      "lane-1",
      "source_fetched",
      "sv-2",
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
      "sv-2",
      { claim: "c-1", question: 2, verified: true, text: "gains vanish without a verifier" },
    ],
    [
      "lane-2",
      "finding_added",
      "sv-2",
      {
        finding: "f-1",
        claims: 6,
        supported: true,
        statement: "Self-training helps only where a verifier exists",
      },
    ],
  ]);
}

test("each campaign's folder is built from its runs' events; folders are read only where granted", () => {
  const store = new ControlStore(":memory:");
  twoCampaigns(store);
  const kb = store.kb();
  assert.equal(kb.catchUp(), 0, "store.kb() caught up already: nothing new");
  const folders = kb.folders();
  const pn = folders.find((f) => f.campaign === "gemv-speed");
  assert.deepEqual(pn?.counts, { attempt: 1, experiment: 1, note: 1 });
  assert.equal(pn?.journal, 1, "the observation is a field note");
  assert.equal(pn?.runs, 1);
  // The experiment carries its result, the attempt its verdict, the note its kind.
  const [exp] = kb.search("vector", ["gemv-speed"], { kinds: ["experiment"] });
  assert.match(
    String(exp?.body),
    /Why: the guide says twice the bandwidth[\s\S]*Result: attempt a-1 \(submitted\)/,
  );
  assert.deepEqual(exp?.meta, {
    details: "128-bit loads of the packed weights",
    why: "the guide says twice the bandwidth",
    family: "memory-layout",
  });
  assert.equal(exp && kb.resultOf(exp), "tried: attempt a-1 (submitted), win confirmed (+6.10%)");
  const [att] = kb.search("vector", ["gemv-speed"], { kinds: ["attempt"] });
  assert.match(String(att?.body), /Verdict: win_confirmed \(\+6\.10%\)/);
  const [note] = kb.search("working set", ["gemv-speed"]);
  assert.equal(note?.kind, "note");
  assert.equal(note?.sub, "observation");
  assert.equal(note?.by, "lane-1");
  assert.equal(note?.rig, "rig-a");
  assert.equal(note?.run, "gs-3");
  // Search stays inside the folders given; a grant adds another campaign's folder.
  assert.deepEqual(kb.search("verifier", ["gemv-speed"]), []);
  assert.equal(kb.search("verifier", ["survey-study"]).length, 2);
  assert.equal(kb.grant("gemv-speed", "survey-study", "owner:ui"), true);
  assert.equal(kb.grant("gemv-speed", "survey-study", "owner:ui"), false, "granted already");
  assert.deepEqual(kb.reads("gemv-speed"), ["survey-study"]);
  assert.deepEqual(kb.readBy("survey-study"), ["gemv-speed"]);
  assert.deepEqual(kb.readable("gemv-speed"), ["gemv-speed", "survey-study"]);
  assert.equal(kb.search("verifier", kb.readable("gemv-speed")).length, 2);
  assert.equal(kb.revoke("gemv-speed", "survey-study"), true);
  assert.equal(kb.revoke("gemv-speed", "survey-study"), false);
  assert.deepEqual(kb.reads("gemv-speed"), []);
  // A campaign never reads itself as a grant.
  assert.equal(kb.grant("gemv-speed", "gemv-speed", "owner:ui"), false);
  assert.deepEqual(kb.reads("gemv-speed"), []);
  // Later events update the same items, and new ones are added.
  ingest(
    store,
    "rig-a",
    [
      [
        "planner",
        "experiment_dropped",
        "gs-3",
        { id: "x-1", by: "planner", why: "a rule avoids it" },
      ],
    ],
    6,
  );
  const [dropped] = store.kb().search("vector", ["gemv-speed"], { kinds: ["experiment"] });
  assert.match(String(dropped?.body), /Dropped: a rule avoids it/);
  assert.doesNotMatch(String(dropped?.body), /Result:/);
  assert.ok(Number(dropped?.seq) > Number(exp?.seq), "an update gives the item a new seq");
});

test("the knowledge base carries on after a restart of control: its cursor and seqs are kept", () => {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-kb-")), "control.db");
  const first = new ControlStore(path);
  twoCampaigns(first);
  const before = first.kb().folders();
  const top = Math.max(
    ...first
      .kb()
      .changedAfter(["gemv-speed", "survey-study"], 0)
      .map((x) => x.seq),
  );
  // Control restarts: a new store on the same file indexes nothing twice.
  const second = new ControlStore(path);
  const kb = second.kb();
  assert.equal(kb.catchUp(), 0);
  assert.deepEqual(kb.folders(), before);
  ingest(
    second,
    "rig-a",
    [
      [
        "lane-2",
        "journal_note",
        "gs-3",
        { id: 2, by: "lane-2", kind: "lesson", text: "tiling lost" },
      ],
    ],
    6,
  );
  const [lesson] = second.kb().search("tiling", ["gemv-speed"]);
  assert.ok(Number(lesson?.seq) > top, "seqs go on from where they were");
});

test("a rig's new ledger never mixes its runs' items with the old ledger's", () => {
  const store = new ControlStore(":memory:");
  ingest(store, "rig-a", [
    ["harness", "run_created", "r-1", { campaign: "old-campaign", mode: "goal" }],
    ["planner", "experiment_added", "r-1", { id: "x-1", title: "the old idea", by: "planner" }],
    ["harness", "attempt_recorded", "a-1", { run: "r-1", lane: "lane-1", hypothesis: "old try" }],
  ]);
  store.kb();
  // A reset: the rig reports a new ledger that starts again at event 1, with the same names.
  ingest(
    store,
    "rig-a",
    [
      ["harness", "run_created", "r-1", { campaign: "new-campaign", mode: "goal" }],
      ["planner", "experiment_added", "r-1", { id: "x-1", title: "the new idea", by: "planner" }],
      ["judge", "verdict", "a-1", { verdict: "regress", delta: -0.05 }],
    ],
    0,
    "ledger-rig-a-2",
  );
  const kb = store.kb();
  const [old] = kb.search("idea", ["old-campaign"]);
  const [neu] = kb.search("idea", ["new-campaign"]);
  assert.equal(old?.title, "the old idea");
  assert.equal(neu?.title, "the new idea");
  assert.notEqual(old?.ledger, neu?.ledger);
  // The new ledger's verdict names an attempt the new ledger never recorded: the old one keeps
  // no verdict from it.
  const [att] = kb.search("old try", ["old-campaign"], { kinds: ["attempt"] });
  assert.doesNotMatch(String(att?.body), /Verdict/);
  // The sync knows the rig's runs in its current ledger only.
  assert.equal(kb.sync("rig-a", "r-1", 0)?.campaign, "new-campaign");
});

test("a run's sync: its readable folders by seq, never its own items, in pages, updates again", () => {
  const store = new ControlStore(":memory:");
  twoCampaigns(store);
  // A second run of gemv-speed on another rig, and a third campaign nobody granted.
  ingest(store, "rig-c", [
    ["harness", "run_created", "gs-4", { campaign: "gemv-speed", mode: "goal" }],
    [
      "lane-1",
      "journal_note",
      "gs-4",
      { id: 1, by: "lane-1", kind: "decision", text: "kept the old path below n = 4096" },
    ],
  ]);
  ingest(store, "rig-d", [
    ["harness", "run_created", "x-9", { campaign: "secret-campaign", mode: "goal" }],
    ["planner", "experiment_added", "x-9", { id: "x-1", title: "not for pn", by: "planner" }],
  ]);
  const kb = store.kb();
  const all = (rig: string, run: string, after = 0, limit = 500) => {
    const out: KbSync["items"] = [];
    let cur = after;
    for (let i = 0; i < 50; i++) {
      // As the route does: caught up with every report first.
      const page = store.kb().sync(rig, run, cur, limit);
      assert.ok(page);
      KbSync.parse(page);
      out.push(...page.items);
      assert.ok(page.next >= cur, "the cursor never goes back");
      cur = page.next;
      if (!page.more) return { items: out, next: cur, folders: page.folders };
    }
    throw new Error("the sync never ended");
  };
  // Its own folder only, without its own items: the other run's note.
  const s = all("rig-c", "gs-4");
  assert.deepEqual(s.folders, ["gemv-speed"]);
  assert.deepEqual(s.items.map((x) => `${x.run}/${x.kind}`).sort(), [
    "gs-3/attempt",
    "gs-3/experiment",
    "gs-3/note",
  ]);
  assert.ok(
    s.items.every((x) => x.campaign === "gemv-speed"),
    "never a folder not granted",
  );
  // Each item says which rig's run it came from (run names are unique per rig only).
  assert.ok(s.items.every((x) => x.rig === "rig-a" && x.run === "gs-3"));
  const seqs = s.items.map((x) => x.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    "in seq order",
  );
  // Pages of one item: the same items, with more until the last.
  const paged = all("rig-c", "gs-4", 0, 1);
  assert.deepEqual(
    paged.items.map((x) => x.seq),
    seqs,
  );
  assert.equal(kb.sync("rig-c", "gs-4", 0, 1)?.more, true);
  // Nothing new: nothing comes, and the cursor stays.
  const quiet = kb.sync("rig-c", "gs-4", s.next);
  assert.deepEqual(quiet?.items, []);
  assert.equal(quiet?.next, s.next);
  assert.equal(quiet?.more, false);
  // An updated item comes again, with a seq after the cursor.
  ingest(
    store,
    "rig-a",
    [["planner", "experiment_dropped", "gs-3", { id: "x-1", by: "owner", why: "done elsewhere" }]],
    6,
  );
  const again = all("rig-c", "gs-4", s.next);
  assert.equal(again.items.length, 1);
  assert.equal(again.items[0]?.ref, "x-1");
  assert.match(String(again.items[0]?.body), /Dropped: done elsewhere/);
  // A grant made while the run is at work: the granted folder's items come at the next sync,
  // although their seqs are behind the run's cursor.
  assert.equal(kb.grant("gemv-speed", "survey-study", "owner:ui"), true);
  const granted = all("rig-c", "gs-4", again.next);
  assert.deepEqual(granted.folders, ["gemv-speed", "survey-study"]);
  assert.deepEqual(granted.items.map((x) => x.kind).sort(), ["claim", "finding", "source"]);
  assert.ok(granted.items.every((x) => x.campaign === "survey-study" && x.rig === "rig-b"));
  assert.deepEqual(all("rig-c", "gs-4", granted.next).items, [], "and only once");
  // The secret campaign's folder never comes.
  assert.ok(
    ![...s.items, ...again.items, ...granted.items].some((x) => x.campaign === "secret-campaign"),
  );
  // After a revoke, the folder leaves the run's folders at once (its supervisor removes its
  // copy), and its items no longer come, even from the start.
  kb.revoke("gemv-speed", "survey-study");
  const after = store.kb().sync("rig-c", "gs-4", granted.next);
  assert.deepEqual(after?.folders, ["gemv-speed"]);
  assert.deepEqual(after?.items, []);
  const fresh = all("rig-c", "gs-4", 0);
  assert.deepEqual(fresh.folders, ["gemv-speed"]);
  assert.ok(fresh.items.every((x) => x.campaign === "gemv-speed"));
  // An unknown run, or another rig's run, has no sync.
  assert.equal(kb.sync("rig-c", "nope", 0), undefined);
  assert.equal(kb.sync("rig-c", "gs-3", 0), undefined, "gs-3 is rig-a's");
});

test("the rigs' route: the rig's own token, its own runs, a KbSync", async () => {
  const keys = generateSigningKeys();
  const store = new ControlStore(":memory:");
  const control = createControlApi(
    store,
    {
      admin: "admin-token-abcdef",
      rigs: { "rig-a": "rig-a-token-abcd", "rig-b": "rig-b-token-abcd" },
    },
    keys.privateKeyPem,
  );
  twoCampaigns(store);
  const get = (path: string, token: string) =>
    control.request(path, { headers: { authorization: `Bearer ${token}` } });
  // A run control did not assign gets nothing, whatever its own events name.
  assert.equal((await get("/v1/rigs/rig-b/kb?run=sv-2&after=0", "rig-b-token-abcd")).status, 404);
  assigned(store, "rig-b", "sv-2", "survey-study");
  const ok = await get("/v1/rigs/rig-b/kb?run=sv-2&after=0", "rig-b-token-abcd");
  assert.equal(ok.status, 200);
  const body = KbSync.parse(await ok.json());
  assert.equal(body.campaign, "survey-study");
  assert.deepEqual(body.items, [], "a run's own items are left out: it has them");
  store.kb().grant("survey-study", "gemv-speed", "owner:ui");
  const withGrant = KbSync.parse(
    await (await get("/v1/rigs/rig-b/kb?run=sv-2&after=0", "rig-b-token-abcd")).json(),
  );
  assert.deepEqual(withGrant.folders, ["survey-study", "gemv-speed"]);
  assert.deepEqual(withGrant.items.map((x) => x.kind).sort(), ["attempt", "experiment", "note"]);
  assert.ok(withGrant.items.every((x) => x.rig === "rig-a"));
  // Another rig's token, another rig's run, an unknown run, a bad cursor.
  assert.equal((await get("/v1/rigs/rig-b/kb?run=sv-2", "rig-a-token-abcd")).status, 401);
  assert.equal((await get("/v1/rigs/rig-a/kb?run=sv-2", "rig-a-token-abcd")).status, 404);
  assert.equal((await get("/v1/rigs/rig-b/kb?run=nope", "rig-b-token-abcd")).status, 404);
  assert.equal((await get("/v1/rigs/rig-b/kb", "rig-b-token-abcd")).status, 400);
  assert.equal((await get("/v1/rigs/rig-b/kb?run=sv-2&after=-1", "rig-b-token-abcd")).status, 400);
  assert.equal((await get("/v1/rigs/rig-b/kb?run=sv-2", "admin-token-abcdef")).status, 401);
});

test("a research note is a note of its own in the folder and in the run's journal", async () => {
  const store = new ControlStore(":memory:");
  ingest(store, "rig-c", [
    ["harness", "run_created", "g-1", { campaign: "gemv-speed", mode: "goal" }],
    [
      "lane-1",
      "journal_note",
      "g-1",
      { id: 1, by: "lane-1", kind: "observation", text: "the kernel is memory bound" },
    ],
    [
      "lane-1",
      "research_note",
      "g-1",
      {
        note: 1,
        by: "lane-1",
        text: "The vendor guide says 128-bit loads double the bandwidth",
        sources: ["s-1"],
        url: "https://example.com/guide",
      },
    ],
  ]);
  const kb = store.kb();
  const notes = kb.search("bandwidth", ["gemv-speed"], { kinds: ["note"] });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.ref, "rn-1", "never the field note's id");
  assert.equal(notes[0]?.sub, "note");
  assert.equal(notes[0]?.url, "https://example.com/guide");
  assert.match(String(notes[0]?.body), /Sources: s-1/);
  assert.equal(kb.search("memory bound", ["gemv-speed"])[0]?.sub, "observation");
  const { rigView } = await import("./views.ts");
  const run = rigView(store, "rig-c", { staleAfterMs: 600_000 })?.runs.find((r) => r.id === "g-1");
  assert.deepEqual(
    run?.journal.map((n) => [n.id, n.kind, n.about?.type ?? null]),
    [
      [1, "observation", "run"],
      [-1, "note", "source"],
    ],
  );
  assert.ok(!run?.timeline.some((e) => e.kind === "research_note"));
});

test("a rig files a run's items only under a campaign control gave it", () => {
  const store = new ControlStore(":memory:");
  // Control assigned gemv-speed to rig-a's g-1.
  assigned(store, "rig-a", "g-1", "gemv-speed");
  ingest(store, "rig-a", [
    ["harness", "run_created", "g-1", { campaign: "gemv-speed", mode: "goal" }],
    ["lane-1", "journal_note", "g-1", { id: 1, by: "lane-1", kind: "lesson", text: "real lesson" }],
  ]);
  // rig-b names gemv-speed for a run control never assigned it: nothing goes in that folder.
  ingest(store, "rig-b", [
    ["harness", "run_created", "g-9", { campaign: "gemv-speed", mode: "goal" }],
    ["lane-1", "journal_note", "g-9", { id: 1, by: "lane-1", kind: "lesson", text: "planted" }],
    // A campaign control never assigned anywhere (a local run) is still filed as named.
    ["harness", "run_created", "l-1", { campaign: "local-try", mode: "goal" }],
    ["lane-1", "journal_note", "l-1", { id: 2, by: "lane-1", kind: "lesson", text: "local" }],
  ]);
  const kb = store.kb();
  assert.deepEqual(
    kb.search("lesson", ["gemv-speed"]).map((x) => x.body),
    ["real lesson\nAbout: run g-1"],
  );
  assert.equal(kb.search("planted", ["gemv-speed"]).length, 0);
  assert.equal(kb.search("local", ["local-try"]).length, 1);
});
