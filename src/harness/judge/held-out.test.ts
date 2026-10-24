import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createControlApi } from "../../control/api.ts";
import { ControlStore } from "../../control/store.ts";
import { relayOnce } from "../../supervisor/relay.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../testing/judge-env.ts";
import { Registry } from "../agents/registry.ts";
import { Scheduler } from "../agents/scheduler.ts";
import { createHarnessApi } from "../api.ts";
import { LocalRunner } from "../broker/runner.ts";
import {
  HELD_OUT_INFRA,
  HELD_OUT_KINDS,
  heldOutCellsOf,
  heldOutKindOf,
  heldOutKinds,
  heldOutMeasure,
  heldOutWords,
  meetsThreshold,
} from "./held-out.ts";
import type { ArmRun } from "./measure.ts";

/**
 * Goal 082: a confirmation that fails on its held-out cells is named safely. The owner sees each
 * held-out case's name, kind and value against its threshold (the held_out record, its event,
 * control's pages, REST and MCP); the agents see only that a held-out check failed and its kind.
 * No one gets a held-out case's inputs, outputs or texts.
 */

/** A held-out case whose name, parameter and error output must never reach an agent. */
const HIDDEN = "zz-hidden-9";
const HIDDEN_PARAM = "HIDDEN-PARAM-7731";
const HIDDEN_STDERR = "HIDDEN-STDERR-MARKER";
/** Control's agent and reader tokens: the agent reads held-out checks as kinds alone. */
const AGENT_TOKEN = "agent-token-abcdef";
const READ_TOKEN = "read-token-abcdef";

const CELLS = {
  small: { n: 20000000, work: 20000000 },
  big: { n: 100000000, work: 100000000 },
  [HIDDEN]: { n: 15000000, work: 15000000, salt: HIDDEN_PARAM },
};

/** Fast and correct on every case but the hidden one, where it prints a marker and exits 4. */
const CRASHES_HIDDEN = `import { writeSync } from "node:fs";
export function work(n) {
  if (n === 15000000) {
    writeSync(2, "${HIDDEN_STDERR}: the input was ${HIDDEN_PARAM}\\n");
    process.exit(4);
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

/** Fast and correct everywhere, but it idles a long time on the hidden case. */
const SLOW_ON_HIDDEN = `export function work(n) {
  if (n === 15000000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

async function setup(opts: Parameters<typeof makeJudgeEnv>[0]) {
  const env = makeJudgeEnv({ realRuns: true, ...opts });
  const out = await env.service.applyCommand(env.assign);
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
        "proposer",
      )
    ).attempt;
  // Control, reached through the supervisor's relay as on a rig.
  const store = new ControlStore(":memory:");
  const ADMIN = "admin-token-abcdef";
  const control = createControlApi(
    store,
    {
      admin: ADMIN,
      agent: AGENT_TOKEN,
      read: READ_TOKEN,
      rigs: { "rig-a": "rig-token-abcdef" },
    },
    env.keys.privateKeyPem,
  );
  const harness = createHarnessApi(env.service, { supervisor: "s-token-abcdef" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    return (url.host === "harness" ? harness : control).request(
      `${url.pathname}${url.search}`,
      init as RequestInit,
    );
  };
  const relay = () =>
    relayOnce(
      {
        rig: "rig-a",
        harnessUrl: "http://harness",
        harnessToken: "s-token-abcdef",
        controlUrl: "http://control",
        controlToken: "rig-token-abcdef",
        fetchImpl,
      },
      { cursor: 0 },
    );
  const rest = async (path: string) =>
    (await control.request(path, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token: ADMIN }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = async (path: string) =>
    (await control.request(path, { headers: { cookie } })).text();
  const mcp = async (tool: string, args: Record<string, unknown>, token = ADMIN) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const f: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return control.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
    };
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: f }),
    );
    const r = (await client.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
    };
    await client.close();
    return r.content[0]?.text ?? "";
  };
  /** Every event the harness wrote, as text. */
  const events = () => JSON.stringify(env.ledger.eventsAfter(0, 100_000).events);
  const reasons = (id: string) =>
    (
      env.ledger.db
        .prepare("select reasons from verdict where attempt = ? order by id desc limit 1")
        .get(id) as { reasons: string }
    ).reasons;
  /** What the agents get: the planner's and the teachers' evidence, a worker's status. */
  const agentViews = (id: string) => ({
    evidence: JSON.stringify(new Registry(env.ledger).evidence("js-1")),
    teachers: JSON.stringify(env.service.brief("js-1")),
    status: JSON.stringify(env.service.attemptStatus(id)),
  });
  return { ...env, submit, relay, rest, page, mcp, events, reasons, agentViews };
}

/** Nothing of the hidden case's inputs or outputs anywhere in `text`. */
function noContent(text: string, where: string) {
  assert.ok(!text.includes(HIDDEN_PARAM), `${where} holds the hidden case's input`);
  assert.ok(!text.includes(HIDDEN_STDERR), `${where} holds the hidden case's output`);
}

describe("held-out failures, named safely (goal 082)", () => {
  test("a hill climb's held-out crash and regression: the owner sees the case and kind, the agents the kind", async () => {
    const env = await setup({
      kitCells: CELLS,
      contract: { held_out_cells: [HIDDEN] },
    });
    const crash = await env.submit(CRASHES_HIDDEN, "drop the waste, crash on one size");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(crash)?.verdict, "not_confirmed", env.explain(crash));
    // The agents' words: that a held-out check crashed, and the measured cells' own figures.
    assert.match(
      env.reasons(crash),
      /^confirmation failed: a held-out check crashed; on the measured cells: .*; vs champion seq 1$/,
    );
    const slow = await env.submit(SLOW_ON_HIDDEN, "drop the waste, idle on one size");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(slow)?.verdict, "not_confirmed", env.explain(slow));
    assert.match(env.reasons(slow), /^confirmation failed: a held-out check missed its threshold;/);
    assert.equal(env.ledger.currentChampion("js-1").seq, 1);

    // The record and the owner's event: the case, its kind, and the ratio against its threshold.
    const record = env.ledger.db
      .prepare("select attempt, pass, detail from held_out order by id")
      .all()
      .map((r) => ({
        attempt: r.attempt,
        pass: r.pass,
        cells: heldOutCellsOf(JSON.parse(String(r.detail))),
      }));
    assert.deepEqual(record[0], {
      attempt: crash,
      pass: 0,
      cells: [{ cell: HIDDEN, ok: false, kind: "crashed" }],
    });
    const slowCell = record[1]?.cells[0];
    assert.equal(slowCell?.kind, "threshold_missed");
    assert.equal(slowCell?.op, ">");
    assert.ok(Math.abs(Number(slowCell?.threshold) - 1 / 1.01) < 1e-9, String(slowCell?.threshold));
    assert.ok(Number(slowCell?.value) < Number(slowCell?.threshold), String(slowCell?.value));
    const ev = env.ledger
      .eventsAfter(0, 100_000)
      .events.filter((e) => e.kind === "held_out_checked");
    assert.equal(ev[0]?.subject, crash);
    assert.deepEqual(
      { ...(ev[0]?.body as object), job: 0 },
      {
        run: "js-1",
        job: 0,
        pass: false,
        cells: [{ cell: HIDDEN, ok: false, kind: "crashed" }],
        cells_total: 1,
      },
    );

    // The agents: the kind in words, never the case, its input or its output.
    for (const id of [crash, slow]) {
      const views = env.agentViews(id);
      for (const [where, text] of Object.entries(views)) {
        noContent(text, where);
        assert.ok(!text.includes(HIDDEN), `${where} names the hidden case`);
      }
      noContent(env.reasons(id), "the verdict's reasons");
      assert.ok(!env.reasons(id).includes(HIDDEN), "the verdict's reasons name the hidden case");
    }
    const views = env.agentViews(crash);
    assert.match(views.status, /"held_out":"a held-out check crashed"/);
    assert.match(views.evidence, /"held_out":"a held-out check crashed"/);
    assert.match(views.teachers, /"held_out":"a held-out check missed its threshold"/);
    // No event carries the hidden case's input or output; only the owner's event names it.
    noContent(env.events(), "the events");
    for (const e of env.ledger.eventsAfter(0, 100_000).events)
      if (e.kind !== "held_out_checked")
        assert.ok(!JSON.stringify(e.body).includes(HIDDEN), `${e.kind} names the hidden case`);

    // Control: the owner's page, REST and MCP show the case and its kind; still no content.
    await env.relay();
    const view = await env.rest("/v1/rigs/rig-a/view");
    noContent(view, "REST's rig view");
    const run = JSON.parse(view).runs[0] as {
      attempts: {
        id: string;
        held_out: { pass: boolean; cells: { cell: string; kind: string }[] };
      }[];
    };
    const owner = run.attempts.find((a) => a.id === crash)?.held_out;
    assert.equal(owner?.pass, false);
    assert.deepEqual(
      owner?.cells.map((c) => [c.cell, c.kind]),
      [[HIDDEN, "crashed"]],
    );
    const viaMcp = await env.mcp("get_run", { rig: "rig-a", run: "js-1" });
    noContent(viaMcp, "MCP's get_run");
    const slowHeld = (
      JSON.parse(viaMcp) as {
        attempts: { id: string; held_out: { cells: Record<string, unknown>[] } }[];
      }
    ).attempts.find((a) => a.id === slow)?.held_out.cells[0];
    assert.equal(slowHeld?.cell, HIDDEN);
    assert.equal(slowHeld?.kind, "threshold_missed");
    assert.ok(Number(slowHeld?.value) < Number(slowHeld?.threshold), JSON.stringify(slowHeld));
    // The agent token over MCP: each held-out check as its kinds, never a case, value or
    // threshold; its events too. The reader keeps the owner's view (goal 082).
    for (const [tool, args] of [
      ["get_run", { rig: "rig-a", run: "js-1" }],
      ["recent_events", { rig: "rig-a", limit: 500 }],
    ] as const) {
      const text = await env.mcp(tool, args, AGENT_TOKEN);
      noContent(text, `the agent's ${tool}`);
      assert.ok(!text.includes(HIDDEN), `the agent's ${tool} names the hidden case`);
      assert.doesNotMatch(text, /"threshold"|"value":0\.|"measure"/, `the agent's ${tool}`);
      assert.match(
        text,
        /"kinds":\s*\[\s*"threshold_missed"\s*\],\s*"words":\s*"a held-out check missed its threshold"/,
        tool,
      );
    }
    const agentRun = JSON.parse(
      await env.mcp("get_run", { rig: "rig-a", run: "js-1" }, AGENT_TOKEN),
    ) as { attempts: { id: string; held_out: unknown }[] };
    // The whole timeline, one list (goal 128: get_run gives each list's newest entries).
    const timeline = (
      JSON.parse(
        await env.mcp(
          "get_run",
          { rig: "rig-a", run: "js-1", list: "timeline", limit: 500 },
          AGENT_TOKEN,
        ),
      ) as { entries: { kind: string; body: unknown }[] }
    ).entries;
    assert.deepEqual(
      { ...(agentRun.attempts.find((a) => a.id === slow)?.held_out as object), at: "" },
      {
        at: "",
        pass: false,
        kinds: ["threshold_missed"],
        words: "a held-out check missed its threshold",
      },
    );
    assert.deepEqual(
      timeline.filter((e) => e.kind === "held_out_checked").map((e) => e.body),
      [
        { run: "js-1", pass: false, kinds: ["crashed"], words: "a held-out check crashed" },
        {
          run: "js-1",
          pass: false,
          kinds: ["threshold_missed"],
          words: "a held-out check missed its threshold",
        },
      ],
    );
    const viaReader = await env.mcp("get_run", { rig: "rig-a", run: "js-1" }, READ_TOKEN);
    assert.ok(viaReader.includes(HIDDEN), "the reader keeps the owner's view");
    noContent(viaReader, "the reader's get_run");
    const attemptPage = await env.page(`/ui/rigs/rig-a/attempts/${slow}`);
    noContent(attemptPage, "the attempt's page");
    assert.match(attemptPage, /<h2>Held-out checks<\/h2><span class="n">1 failed<\/span>/);
    assert.match(
      attemptPage,
      new RegExp(
        `<td><code>${HIDDEN}</code></td><td>no worse than the champion</td><td><span class="chip bad">missed its threshold</span></td><td>0\\.\\d+<div class="muted small">ops_per_s, the change's median over the champion's</div></td><td>&gt; 0\\.9901</td>`,
      ),
    );
    const history = await env.page("/ui/campaigns/js-sum?run=rig-a%2Fjs-1&view=history");
    assert.match(history, new RegExp(`failed its held-out check: ${HIDDEN} crashed\\.`));
  });

  test("a goal's held-out threshold: the case, its value and threshold for the owner; the kind for the agents", async () => {
    const env = await setup({
      goal: { opsPerSecond: 70e6 },
      kitCells: CELLS,
      contract: {
        held_out_cells: [HIDDEN],
        threshold_reps: 3,
        goals: [
          {
            id: "fast",
            description: "fast enough",
            verify: {
              type: "metric_threshold",
              metric: "ops_per_s",
              op: ">=",
              value: 70e6,
              cells: ["big", HIDDEN],
            },
          },
          {
            id: "correct",
            description: "still correct",
            verify: { type: "code", verifier: "correctness" },
          },
        ],
      },
    });
    await env.drain(); // validates the seed
    const id = await env.submit(SLOW_ON_HIDDEN, "drop the waste, idle on one size");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(id)?.verdict, "not_confirmed", env.explain(id));
    assert.equal(
      env.reasons(id),
      "confirmation failed: a held-out check missed its threshold; vs champion seq 1",
    );
    const ev = env.ledger
      .eventsAfter(0, 100_000)
      .events.find((e) => e.kind === "held_out_checked" && e.subject === id);
    assert.ok(ev, env.explain(id));
    const cell = (ev.body as { cells: Record<string, unknown>[] }).cells[0] ?? {};
    assert.equal(cell.cell, HIDDEN);
    assert.equal(cell.goal, "fast");
    assert.equal(cell.kind, "threshold_missed");
    assert.equal(cell.op, ">=");
    assert.equal(cell.threshold, 70e6);
    assert.equal(cell.measure, "ops_per_s");
    assert.equal(cell.unit, "op/s");
    assert.ok(Number(cell.value) > 0 && Number(cell.value) < 70e6, String(cell.value));
    assert.ok(Number(cell.low) <= Number(cell.value) && Number(cell.value) <= Number(cell.high));
    // The hidden case never ran as a measurement, a goal check or a report.
    assert.equal(
      env.ledger.db.prepare("select count(*) as n from measurement where cell = ?").get(HIDDEN)?.n,
      0,
    );
    const views = env.agentViews(id);
    for (const [where, text] of Object.entries(views)) {
      noContent(text, where);
      assert.ok(!text.includes(HIDDEN), `${where} names the hidden case`);
    }
    assert.match(views.status, /"held_out":"a held-out check missed its threshold"/);
    noContent(env.events(), "the events");
    await env.relay();
    const page = await env.page(`/ui/rigs/rig-a/attempts/${id}`);
    assert.match(
      page,
      new RegExp(
        `<td><code>${HIDDEN}</code></td><td>goal <b>fast</b></td><td><span class="chip bad">missed its threshold</span></td>`,
      ),
    );
    assert.match(page, /&gt;= 7\.000e\+7 op\/s/);
    // The agent token: the goal's checks without the held-out case, which the owner sees.
    const owner = JSON.parse(await env.mcp("get_run", { rig: "rig-a", run: "js-1" })) as {
      goal_checks: { goals: { goal: string; cells: { name: string }[] }[] };
    };
    assert.deepEqual(
      owner.goal_checks.goals.find((g) => g.goal === "fast")?.cells.map((c) => c.name),
      ["big", HIDDEN],
    );
    for (const [tool, args] of [
      ["get_run", { rig: "rig-a", run: "js-1" }],
      ["recent_events", { rig: "rig-a", limit: 500 }],
    ] as const) {
      const text = await env.mcp(tool, args, AGENT_TOKEN);
      noContent(text, `the agent's ${tool}`);
      assert.ok(!text.includes(HIDDEN), `the agent's ${tool} names the hidden case`);
    }
    const agent = JSON.parse(
      await env.mcp("get_run", { rig: "rig-a", run: "js-1" }, AGENT_TOKEN),
    ) as { goal_checks: { goals: { goal: string; cells: { name: string }[] }[] } };
    assert.deepEqual(
      agent.goal_checks.goals.find((g) => g.goal === "fast")?.cells.map((c) => c.name),
      ["big"],
    );
  });
});

/** Fast and correct on every case but the hidden one, where it prints a marker and answers wrong. */
const WRONG_ON_HIDDEN = `import { writeSync } from "node:fs";
export function work(n) {
  if (n === 15000000) {
    writeSync(2, "${HIDDEN_STDERR}: the input was ${HIDDEN_PARAM}\\n");
    return -1;
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += i % 7;
  return s;
}
`;

/**
 * A goal run whose goals the seed half meets: `correct` (met by the seed) has the hidden case,
 * `speedy` (not met: the seed idles 4 s on `quick`, stopped at 3) has none. A change that gains
 * `speedy` is confirmed on `speedy`'s held-out cases only, which are none.
 */
const CHAMPION_RUN = {
  goal: { opsPerSecond: 1 },
  kitCells: {
    small: { n: 20000000, work: 20000000 },
    quick: { params: { n: 200000000, work: 200000000 }, timeout_s: 3 },
    [HIDDEN]: { n: 15000000, work: 15000000, salt: HIDDEN_PARAM },
  },
  kitVerifiers: {
    correctness: { cells: ["small", HIDDEN] },
    speedy: { cells: ["small", "quick"] },
  },
  contract: {
    held_out_cells: [HIDDEN],
    goals: [
      {
        id: "correct",
        description: "still correct",
        verify: { type: "code", verifier: "correctness" },
      },
      {
        id: "speedy",
        description: "every case in time",
        verify: { type: "code", verifier: "speedy" },
      },
    ],
  },
};

describe("the champion's held-out check (goal 086)", () => {
  test("the second validation runs the held-out cases of every goal met: one fails, the run goes on and the agents read its kind; a change that passes it closes the run", async () => {
    const env = await setup(CHAMPION_RUN);
    await env.drain(); // the seed: correct is met, speedy is not
    const first = await env.submit(WRONG_ON_HIDDEN, "drop the idle, wrong on one size");
    const confirming = () =>
      Number(
        (
          env.ledger.db
            .prepare(
              "select count(*) as n from job where kind = 'validate' and state in ('queued', 'leased') and json_extract(spec, '$.confirm') = 1",
            )
            .get() as { n: number }
        ).n,
      );
    for (let i = 0; i < 30 && !confirming(); i++) await env.judge.tick();
    // Its own confirmation checked the goal it gained, speedy, which has no held-out case.
    assert.equal(env.ledger.currentVerdict(first)?.verdict, "goal_progress", env.explain(first));
    assert.equal(env.ledger.currentChampion("js-1").seq, 2);
    assert.equal(confirming(), 1, env.explain(first));
    // The lanes wait for the second validation.
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      owner: "s0",
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    const inside = scheduler as unknown as {
      waitingForConfirmation(run: string): boolean;
      goalReport(run: string, seq: number): unknown;
      brief(...args: unknown[]): string;
    };
    assert.equal(inside.waitingForConfirmation("js-1"), true);
    await env.drain();

    // A held-out case of correct failed: the run does not close, and the lanes go on.
    assert.equal(env.ledger.getRun("js-1")?.status, "running", env.explain(first));
    const all = () => env.ledger.eventsAfter(0, 100_000).events;
    assert.equal(all().filter((e) => e.kind === "goal_complete").length, 0);
    assert.equal(inside.waitingForConfirmation("js-1"), false);
    const live = JSON.stringify(env.service.live.since(0, 100_000));
    assert.match(live, /trials start again: the judge's confirmation of champion #2 did not close/);

    // The owner's record: the case and its kind, by run and champion, never an attempt's.
    const records = () =>
      env.ledger.db
        .prepare("select attempt, run, champion_seq, pass, detail from held_out order by id")
        .all()
        .map((r) => ({
          attempt: r.attempt,
          run: r.run,
          champion_seq: r.champion_seq,
          pass: r.pass,
          cells: heldOutCellsOf(JSON.parse(String(r.detail))),
        }));
    const failedCell = { cell: HIDDEN, verifier: "correctness", ok: false, kind: "check_failed" };
    assert.deepEqual(records(), [
      { attempt: first, run: null, champion_seq: null, pass: 1, cells: [] },
      { attempt: null, run: "js-1", champion_seq: 2, pass: 0, cells: [failedCell] },
    ]);
    const checked = all().filter((e) => e.kind === "held_out_checked" && e.subject === "js-1");
    assert.deepEqual(
      checked.map((e) => ({ ...(e.body as object), job: 0 })),
      [{ run: "js-1", job: 0, champion_seq: 2, pass: false, cells: [failedCell], cells_total: 1 }],
    );

    // The goal report: correct is not confirmed, by its kind alone; the run is not complete.
    const report = all()
      .filter((e) => e.kind === "goal_report")
      .at(-1)?.body as {
      champion_seq: number;
      complete: boolean;
      confirming?: boolean;
      not_confirmed?: string;
      goals: { goal: string; status: string; reasons: string }[];
    };
    assert.equal(report.champion_seq, 2);
    assert.equal(report.complete, false);
    assert.equal(report.confirming, undefined);
    assert.equal(report.not_confirmed, "a held-out check failed the kit's check");
    const correct = report.goals.find((g) => g.goal === "correct");
    assert.equal(correct?.status, "unmet");
    assert.match(
      String(correct?.reasons),
      /^not confirmed: a held-out check failed the kit's check; on the measured cells: verifier correctness passed on small: small: ops_per_s \S+, value \S+$/,
    );
    assert.equal(report.goals.find((g) => g.goal === "speedy")?.status, "met");
    // The goal tree: correct is not met, so a change that meets it again is progress.
    assert.deepEqual(
      Object.fromEntries(
        env.ledger.db
          .prepare("select id, status from goal where run = 'js-1'")
          .all()
          .map((g) => [g.id, g.status]),
      ),
      { correct: "unmet", speedy: "verified" },
    );

    // The agents: the kind in the judge's words, never the case, its input, its output or the
    // check's words. The attempt's own held-out record passed, and still says so.
    const goalReport = JSON.stringify(inside.goalReport("js-1", 2));
    assert.match(goalReport, /"not_confirmed":"a held-out check failed the kit's check"/);
    const brief = inside.brief(
      "js-1",
      env.service.contractFor("js-1"),
      2,
      { lane: "lane-1", family: "f" },
      { title: "fix it", added_by: "planner" },
      1,
      1,
      "the champion",
    );
    assert.match(
      brief,
      /# What the champion meets \(the judge's check of champion #2\)\nThe judge did not confirm it on the held-out cases: a held-out check failed the kit's check\. The run goes on: a goal not confirmed is not met yet\.\n- correct: unmet\. not confirmed: a held-out check failed the kit's check; /,
    );
    const views: Record<string, string> = {
      ...env.agentViews(first),
      goal_report: goalReport,
      brief,
      reasons: JSON.stringify(env.ledger.db.prepare("select reasons from verdict").all()),
      jobs: JSON.stringify(env.ledger.db.prepare("select result from job").all()),
      live,
    };
    assert.match(views.status ?? "", /"held_out":null/);
    for (const [where, text] of Object.entries(views)) {
      noContent(text, where);
      assert.ok(!text.includes(HIDDEN), `${where} names the hidden case`);
      assert.ok(!text.includes("wrong result"), `${where} holds the check's words`);
    }
    noContent(env.events(), "the events");
    for (const e of all())
      if (e.kind !== "held_out_checked" && e.kind !== "goal_checks")
        assert.ok(!JSON.stringify(e.body).includes(HIDDEN), `${e.kind} names the hidden case`);

    // Control: the owner sees the case and its kind; the agent token, the kind alone.
    await env.relay();
    const view = await env.rest("/v1/rigs/rig-a/view");
    noContent(view, "REST's rig view");
    const run = (
      JSON.parse(view) as {
        runs: {
          id: string;
          champion_held_out: {
            champion_seq: number;
            pass: boolean;
            cells: { cell: string; verifier: string; kind: string }[];
          } | null;
        }[];
      }
    ).runs.find((r) => r.id === "js-1");
    assert.equal(run?.champion_held_out?.champion_seq, 2);
    assert.equal(run?.champion_held_out?.pass, false);
    assert.deepEqual(
      run?.champion_held_out?.cells.map((c) => [c.cell, c.verifier, c.kind]),
      [[HIDDEN, "correctness", "check_failed"]],
    );
    for (const [tool, args] of [
      ["get_run", { rig: "rig-a", run: "js-1" }],
      ["recent_events", { rig: "rig-a", limit: 500 }],
    ] as const) {
      const text = await env.mcp(tool, args, AGENT_TOKEN);
      noContent(text, `the agent's ${tool}`);
      assert.ok(!text.includes(HIDDEN), `the agent's ${tool} names the hidden case`);
    }
    const agentRun = JSON.parse(
      await env.mcp("get_run", { rig: "rig-a", run: "js-1" }, AGENT_TOKEN),
    ) as { champion_held_out: Record<string, unknown> };
    assert.deepEqual(
      { ...agentRun.champion_held_out, at: "" },
      {
        at: "",
        pass: false,
        kinds: ["check_failed"],
        words: "a held-out check failed the kit's check",
        champion_seq: 2,
      },
    );
    const runPage = await env.page("/ui/campaigns/js-goal?run=rig-a%2Fjs-1");
    noContent(runPage, "the run's page");
    assert.match(
      runPage,
      /<h2>Held-out checks of champion #2<\/h2><span class="n">1 failed<\/span>/,
    );
    assert.match(
      runPage,
      new RegExp(
        `<td><code>${HIDDEN}</code></td><td>verifier <b>correctness</b></td><td><span class="chip bad">failed the kit's check</span></td>`,
      ),
    );
    const history = await env.page("/ui/campaigns/js-goal?run=rig-a%2Fjs-1&view=history");
    assert.match(
      history,
      new RegExp(
        `Champion #2 failed its held-out check: ${HIDDEN} failed the kit's check\\. The run does not close\\.`,
      ),
    );
    assert.match(
      history,
      /It was not confirmed on the held-out cases \(a held-out check failed the kit's check\): the lanes go on\./,
    );

    // A change right on every case meets correct again, passes its held-out case, and closes the
    // run. Its patch is written from the seed, so it names the seed as its parent.
    const fixed = (
      await env.service.submitAttempt(
        {
          run: "js-1",
          parent: env.seed,
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "drop the idle, right on every size",
          known_flaws: [],
        },
        "proposer",
      )
    ).attempt;
    await env.drain();
    assert.equal(env.ledger.currentVerdict(fixed)?.verdict, "goal_progress", env.explain(fixed));
    assert.equal(env.reasons(fixed), "confirmed: newly met correct; vs champion seq 2");
    assert.equal(env.ledger.getRun("js-1")?.status, "closed");
    assert.equal(all().filter((e) => e.kind === "goal_complete").length, 1);
    assert.deepEqual(
      records()
        .filter((r) => r.champion_seq !== null)
        .map((r) => [r.champion_seq, r.pass]),
      [
        [2, 0],
        [3, 1],
      ],
    );
    const last = all()
      .filter((e) => e.kind === "goal_report")
      .at(-1)?.body as { complete: boolean; not_confirmed?: string };
    assert.equal(last.complete, true);
    assert.equal(last.not_confirmed, undefined);
  });

  test("a contract with no held-out cases: the second validation runs none, and the run closes as before", async () => {
    const env = await setup({
      ...CHAMPION_RUN,
      contract: { ...CHAMPION_RUN.contract, held_out_cells: [] },
    });
    await env.drain();
    const id = await env.submit(FAST_KERNEL, "drop the idle");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(id)?.verdict, "goal_progress", env.explain(id));
    assert.equal(env.ledger.getRun("js-1")?.status, "closed");
    const events = env.ledger.eventsAfter(0, 100_000).events;
    assert.equal(events.filter((e) => e.kind === "held_out_checked").length, 0);
    assert.equal(
      Number(
        (env.ledger.db.prepare("select count(*) as n from held_out").get() as { n: number }).n,
      ),
      0,
    );
    const reports = events
      .filter((e) => e.kind === "goal_report")
      .map((e) => e.body as { complete: boolean; confirming?: boolean; not_confirmed?: string });
    assert.deepEqual(
      reports.slice(-2).map((r) => [r.complete, r.confirming ?? false, r.not_confirmed ?? null]),
      [
        [true, true, null],
        [true, false, null],
      ],
    );
  });
});

describe("a held-out pass the judge cannot finish (goal 082)", () => {
  test("its error reaches the agents in fixed words, never the case, its parameters or its time", async () => {
    const env = await setup({ kitCells: CELLS, contract: { held_out_cells: [HIDDEN] } });
    const id = await env.submit(FAST_KERNEL, "drop the waste");
    // Screen it: a win queues its confirmation.
    const confirming = () =>
      (
        env.ledger.db.prepare("select count(*) as n from job where kind = 'confirm'").get() as {
          n: number;
        }
      ).n;
    for (let i = 0; i < 20 && !confirming(); i++) await env.judge.tick();
    assert.equal(confirming(), 1, env.explain(id));
    // The rig's copy of the kit loses the rate's parameter on the held-out case only, as a kit
    // checked before the kit check refused that could: each held-out run then throws, with the
    // parameters and the run's time in its words.
    const file = join(env.paths.stateDir, "kits", env.kitCommit, "kit.json");
    chmodSync(file, 0o644);
    const kit = JSON.parse(readFileSync(file, "utf8")) as { cells: Record<string, unknown> };
    kit.cells[HIDDEN] = { n: 15000000, salt: HIDDEN_PARAM };
    writeFileSync(file, JSON.stringify(kit));
    await env.drain();
    // An infrastructure failure, retried once, never a research loss; its reasons fixed words.
    const verdicts = env.ledger.db
      .prepare("select verdict, reasons from verdict where attempt = ? and verdict = 'crash_infra'")
      .all(id) as { verdict: string; reasons: string }[];
    assert.equal(verdicts.length, 2, env.explain(id));
    for (const v of verdicts) assert.equal(v.reasons, HELD_OUT_INFRA);
    // Nowhere an agent or Live reads: the case, its parameters, or the throw's words and time.
    const live = JSON.stringify(env.service.live.since(0, 100_000));
    const jobs = JSON.stringify(env.ledger.db.prepare("select result from job").all());
    for (const [where, text] of Object.entries({
      ...env.agentViews(id),
      reasons: env.reasons(id),
      events: env.events(),
      live,
      jobs,
    })) {
      noContent(text, where);
      assert.ok(!text.includes(HIDDEN), `${where} names the hidden case`);
      assert.ok(!/bad work|or time \d/.test(text), `${where} holds the error's own words`);
    }
    assert.match(live, /could not finish \(an infrastructure failure\)/);
  });
});

describe("held-out kinds", () => {
  const run = (failure: string, kind: "crash" | "invalid") =>
    ({ kind, failure, reason: "secret text", outcome: {} }) as unknown as Exclude<
      ArmRun,
      { kind: "ok" }
    >;

  test("each way a run fails maps to one kind, never from its text", () => {
    assert.equal(heldOutKindOf(run("timeout", "crash")), "timed_out");
    for (const f of ["memory", "disk", "exit"])
      assert.equal(heldOutKindOf(run(f, "crash")), "crashed");
    assert.equal(heldOutKindOf(run("outputs", "invalid")), "check_failed");
    assert.equal(heldOutKindOf(run("check", "invalid")), "check_failed");
    assert.equal(heldOutKindOf(run("metric", "invalid")), "non_finite");
  });

  test("the agents' words: each kind once, in a fixed order; an old record says only that it failed", () => {
    const cells = [
      { cell: "a", ok: false, kind: "timed_out" as const },
      { cell: "b", ok: true },
      { cell: "c", ok: false, kind: "threshold_missed" as const },
      { cell: "d", ok: false, kind: "timed_out" as const },
    ];
    assert.deepEqual(heldOutKinds(cells), ["threshold_missed", "timed_out"]);
    assert.equal(
      heldOutWords(heldOutKinds(cells)),
      "a held-out check missed its threshold; a held-out check timed out",
    );
    assert.equal(heldOutWords([]), "a held-out check failed");
    // A record from before goal 082 kept {cell: {ratio, ok}}: it has no cells to read.
    assert.deepEqual(heldOutCellsOf({ held: { ratio: 0.5, ok: false } }), []);
    for (const k of HELD_OUT_KINDS) assert.match(heldOutWords([k]), /^a held-out check /);
  });

  test("a held-out ratio says which way it was taken: above 1 is better in both directions", () => {
    assert.equal(
      heldOutMeasure("ops_per_s", "max"),
      "ops_per_s, the change's median over the champion's",
    );
    assert.equal(
      heldOutMeasure("latency_ms", "min"),
      "latency_ms, the champion's median over the change's (lower is better)",
    );
  });

  test("a threshold's sides", () => {
    assert.ok(meetsThreshold(2, ">=", 2) && !meetsThreshold(2, ">", 2));
    assert.ok(meetsThreshold(2, "<=", 2) && !meetsThreshold(2, "<", 2));
  });
});
