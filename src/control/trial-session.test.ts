import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveEntry } from "../core/live.ts";
import { DETAIL_CHARS } from "./run-lists.ts";
import { ControlStore } from "./store.ts";
import { SESSION_LINES, trialSession } from "./trial-session.ts";

const at = (i: number) => new Date(Date.UTC(2026, 9, 25, 8, 0, i)).toISOString();

/** Two trials on lane-1 and lane-2 of r-1, one on r-2, and the judge's lines between them. */
function rigWithTrials(): ControlStore {
  const store = new ControlStore(":memory:");
  const lines: LiveEntry[] = [];
  const add = (
    source: string,
    kind: LiveEntry["kind"],
    text: string,
    lane?: string,
    run?: string,
  ) =>
    lines.push({
      seq: lines.length + 1,
      at: at(lines.length),
      source,
      kind,
      text,
      ...(lane ? { lane } : {}),
      ...(run ? { run } : {}),
    });
  add(
    "trial:t-a",
    "status",
    "trial on lane-1: shared staging, stage the activations",
    "lane-1",
    "r-1",
  );
  add("trial:t-b", "status", "trial on lane-2: loop order, interleave the rows", "lane-2", "r-1");
  for (let i = 0; i < 450; i++) {
    add("trial:t-b", "tool", `bash: python3 devbench.py cand ${i}`, "lane-2", "r-1");
    add("trial:t-b", "result", `cand ${i}: 13.${i % 10} tok/s`, "lane-2", "r-1");
    if (i % 100 === 0) add("judge", "log", `job ${i} building`);
  }
  add("trial:t-a", "tool", "submit_attempt", "lane-1", "r-1");
  add("trial:t-a", "status", "trial ended: submitted a-1", "lane-1", "r-1");
  add("trial:t-c", "status", "trial on lane-1: other run", "lane-1", "r-2");
  store.addLive("rig-a", "log-1", lines, true);
  return store;
}
const base = { rig: "rig-a", after: 0, limit: SESSION_LINES };

test("trial_session lists the trials' sessions newest first, and one run's (goal 139)", () => {
  const store = rigWithTrials();
  const all = trialSession(store, base) as { total: number; sessions: Record<string, unknown>[] };
  assert.deepEqual(
    all.sessions.map((s) => s.trial),
    ["t-c", "t-a", "t-b"],
  );
  assert.deepEqual(all.sessions[1], {
    trial: "t-a",
    lane: "lane-1",
    run: "r-1",
    started_at: at(0),
    last_at: at(908),
    asked: "trial on lane-1: shared staging, stage the activations",
    last_tool: "submit_attempt",
    last_tool_at: at(907),
    ended: "trial ended: submitted a-1",
    lines: 3,
  });
  // A session still at work, or cut off, has not ended.
  assert.equal(all.sessions[2]?.ended, null);
  assert.equal(all.sessions[2]?.lines, 901);
  const one = trialSession(store, { ...base, run: "r-2" }) as { sessions: { trial: string }[] };
  assert.deepEqual(
    one.sessions.map((s) => s.trial),
    ["t-c"],
  );
});

test("one session's lines, oldest first, paged forward to its newest; the judge's lines are not in it", () => {
  const store = rigWithTrials();
  type Page = { lines: { id: number; kind: string; text: string }[]; next_after: number | null };
  const first = trialSession(store, { ...base, trial: "t-b" }) as Page & Record<string, unknown>;
  assert.equal(first.lines_total, 901);
  assert.equal(first.lane, "lane-2");
  assert.equal(first.lines.length, SESSION_LINES);
  assert.equal(first.lines[0]?.text, "trial on lane-2: loop order, interleave the rows");
  const seen = [...first.lines];
  let next = first.next_after;
  while (next !== null) {
    const page = trialSession(store, { ...base, trial: "trial:t-b", after: next }) as Page;
    seen.push(...page.lines);
    next = page.next_after;
  }
  assert.equal(seen.length, 901);
  assert.ok(seen.every((l, i) => i === 0 || l.id > (seen[i - 1]?.id ?? 0)));
  assert.equal(seen.at(-1)?.text, "cand 449: 13.9 tok/s");
  assert.ok(!seen.some((l) => l.text.startsWith("job ")));
});

test("a long session's answer keeps to the budget and says how to read its lines whole; an unknown trial is refused in words", () => {
  const store = new ControlStore(":memory:");
  const big = "Reading the kernel's inner loop. ".repeat(200);
  store.addLive(
    "rig-a",
    "log-1",
    Array.from({ length: 60 }, (_, i) => ({
      seq: i + 1,
      at: at(i),
      source: "trial:t-d",
      kind: "thinking" as const,
      text: big,
      lane: "lane-2",
      run: "r-1",
    })),
    true,
  );
  const page = trialSession(store, { ...base, trial: "t-d" }) as {
    lines: { text: string }[];
    cut: string[];
  };
  assert.ok(JSON.stringify(page, null, 2).length <= DETAIL_CHARS);
  assert.equal(page.lines.length, 60, "every line stays; only its text is shorter");
  assert.match(page.cut[0] ?? "", /\(a smaller limit gives each line whole\)$/);
  const whole = trialSession(store, { ...base, trial: "t-d", limit: 5 }) as {
    lines: { text: string }[];
    cut?: string[];
  };
  assert.equal(whole.lines[0]?.text, big);
  assert.equal(whole.cut, undefined);
  assert.throws(
    () => trialSession(store, { ...base, trial: "t-nope" }),
    /^Error: control has no lines of trial t-nope on rig-a: it keeps a rig's newest 20,000 lines, and trial_session with no trial lists the sessions it has$/,
  );
});
