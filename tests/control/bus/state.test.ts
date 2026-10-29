import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type BusView, ConfigWritten } from "../../../src/control/bus/index.ts";
import { EventsApply, EventsMirror } from "../../../src/control/events/index.ts";
import { LiveTaken } from "../../../src/control/live/index.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { COMMAND_STREAM } from "../../../src/core/link/commands.ts";
import { CONFIG_MAX_BYTES, CONFIG_STREAM_CONFIG } from "../../../src/core/link/config.ts";
import { EVENT_MAX_BYTES, EVENT_STREAM_CONFIG } from "../../../src/core/link/events.ts";
import {
  LIVE_KEPT_BYTES,
  LIVE_KEPT_PER_SUBJECT,
  LIVE_KEPT_SECONDS,
  LIVE_MAX_BYTES,
  LIVE_STREAM_CONFIG,
} from "../../../src/core/link/live.ts";
import { REPORT_STREAM_CONFIG } from "../../../src/core/link/report.ts";
import { controlOnly, mcpClient, RIG_TOKEN } from "../../helpers/control-stack.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * The message bus's state (goal 168): its server, its streams and their consumers' backlog, and
 * the live stream's and the config bucket's figures from control and from each rig's supervisor,
 * over REST, MCP and /metrics, for the reader's token too.
 */

const READ = "read-token-abcdef";

/**
 * Control with the bus given as `bus` (none: off), on `store` when given, and calls with the
 * reader's token.
 */
function setup(bus?: BusView, store?: ControlStore) {
  const s = controlOnly({
    tokens: { read: READ, rigs: { "rig-a": RIG_TOKEN } },
    ...(bus ? { options: { bus } } : {}),
    ...(store ? { store } : {}),
  });
  const read = (path: string) =>
    s.control.request(path, { headers: { authorization: `Bearer ${READ}` } });
  /** The rig's supervisor's figures, with its live counts, and its config counts when given. */
  const figures = (live: unknown, config?: unknown) =>
    s.control.request("/v1/rigs/rig-a/supervisor", {
      method: "POST",
      headers: { authorization: `Bearer ${RIG_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ at: new Date().toISOString(), live, ...(config ? { config } : {}) }),
    });
  return { ...s, read, figures };
}

/**
 * A bus with the reports and live streams made, two live messages kept, and control's counts; and
 * the mirror of control's events table and the apply of the events stream, not started.
 */
async function onBus() {
  const store = new ControlStore(":memory:");
  const bus = new FakeBus();
  await bus.makeStream(REPORT_STREAM_CONFIG);
  await bus.makeStream(LIVE_STREAM_CONFIG);
  for (const [subject, id] of [
    ["thermite.run.r1.live.planner", "log:1-2"],
    ["thermite.rig.rig-a.live.judge", "log:3-3"],
  ] as const)
    await bus.publish(subject, "{}", { id });
  const live = new LiveTaken();
  live.messages = 2;
  live.lines = 3;
  live.leftOut = 1;
  live.refused["bad live signature"] = 1;
  live.rigs.set("rig-a", 3);
  const config = new ConfigWritten();
  const apply = new EventsApply({ store, bus, retryMs: 10 });
  const events = new EventsMirror({ store, bus, retryMs: 10, published: () => void apply.nudge() });
  const view = { server: "nats:4222", bus, events, apply, live, config };
  return { store, bus, events, apply, live, config, view };
}

describe("the message bus's state", () => {
  test("control made without its bus, as only a test makes it: it says so, and /metrics has none of its series", async () => {
    const s = setup();
    assert.deepEqual(await (await s.read("/v1/bus")).json(), { on: false });
    assert.equal((await s.control.request("/v1/bus")).status, 401);
    // Control's health says the bus is off, and needs no token.
    const health = await s.control.request("/v1/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, bus: "off" });
    const metrics = await (await s.read("/metrics")).text();
    assert.doesNotMatch(metrics, /thermite_bus_|thermite_live_/);
  });

  test("with the bus on: its streams, and the live stream's figures from control and the rig", async () => {
    const b = await onBus();
    const s = setup(b.view, b.store);
    const live = {
      published: 7,
      dropped: 2,
      subjects: {
        "thermite.run.r1.live.planner": { published: 5, dropped: 2 },
        "thermite.rig.rig-a.live.judge": { published: 2, dropped: 0 },
      },
    };
    assert.equal((await s.figures(live)).status, 200);
    const state = (await (await s.read("/v1/bus")).json()) as Record<string, unknown> & {
      streams: { name: string; messages: number; subjects: number }[];
      live: { rigs: unknown[]; taken: unknown; kept: unknown };
    };
    assert.equal(state.on, true);
    assert.equal(state.server, "nats:4222");
    assert.equal(state.reachable, true);
    assert.equal(state.error, null);
    // The streams control made, and not the one it has not made yet.
    assert.deepEqual(
      state.streams.map((x) => [x.name, x.messages, x.subjects]),
      [
        ["REPORTS", 0, 0],
        ["LIVE", 2, 2],
      ],
    );
    assert.ok(!state.streams.some((x) => x.name === COMMAND_STREAM));
    assert.deepEqual(state.live.kept, {
      seconds: LIVE_KEPT_SECONDS,
      messages_per_subject: LIVE_KEPT_PER_SUBJECT,
      bytes: LIVE_KEPT_BYTES,
      message_bytes: LIVE_MAX_BYTES,
    });
    assert.deepEqual(state.live.taken, {
      since: b.live.since,
      messages: 2,
      lines: 3,
      left_out: 1,
      refused: { "bad live signature": 1 },
    });
    const [rig] = state.live.rigs as { rig: string; taken: number; supervisor: { at: string } }[];
    assert.equal(rig?.rig, "rig-a");
    assert.equal(rig?.taken, 3);
    assert.deepEqual({ ...rig?.supervisor, at: undefined }, { ...live, at: undefined });
    assert.ok(rig?.supervisor.at, "when control had the figures");
    // MCP's tool says the same, to the reader's token too.
    const mcp = await mcpClient(s.control, READ);
    const said = (await mcp.callTool({ name: "bus_state", arguments: {} })) as {
      content: { text: string }[];
    };
    assert.deepEqual(JSON.parse(said.content[0]?.text ?? "{}"), state);
    // /metrics: bounded series by stream, consumer, rig and why.
    const metrics = await (await s.read("/metrics")).text();
    for (const series of [
      "thermite_bus_up 1",
      'thermite_bus_stream_messages{stream="LIVE"} 2',
      'thermite_bus_stream_bytes{stream="REPORTS"} 0',
      'thermite_live_lines_taken_total{rig="rig-a"} 3',
      "thermite_live_lines_left_out_total 1",
      'thermite_live_messages_refused_total{reason="bad live signature"} 1',
      'thermite_live_lines_published_total{rig="rig-a"} 7',
      'thermite_live_lines_dropped_total{rig="rig-a"} 2',
    ])
      assert.ok(metrics.includes(`\n${series}\n`), series);
    assert.match(metrics, /# TYPE thermite_live_lines_published_total counter/);
    assert.match(metrics, /# TYPE thermite_rig_up gauge/, "control's own series first");
  });

  test("with the bus on: the config bucket's stream, what control wrote, and each rig's updates", async () => {
    const b = await onBus();
    await b.bus.makeStream(CONFIG_STREAM_CONFIG);
    await b.bus.publish("thermite.rig.rig-a.config.model-route", "{}", { id: "c1" });
    b.config.written["model-route"] = 2;
    b.config.written["mcp-servers"] = 1;
    b.config.failed = 1;
    b.config.rigs.set("rig-a", 3);
    const s = setup(b.view, b.store);
    const config = {
      taken: 3,
      refused: 1,
      subjects: {
        "thermite.rig.rig-a.config.model-route": { taken: 2, refused: 1 },
        "thermite.rig.rig-a.config.mcp-servers": { taken: 1, refused: 0 },
      },
    };
    assert.equal((await s.figures({ published: 0, dropped: 0, subjects: {} }, config)).status, 200);
    const state = (await (await s.read("/v1/bus")).json()) as {
      streams: { name: string; messages: number }[];
      config: {
        keys: string[];
        message_bytes: number;
        written: Record<string, unknown>;
        rigs: { rig: string; sealed: boolean; written: number; supervisor: { at: string } }[];
      };
    };
    assert.deepEqual(
      state.streams.map((x) => [x.name, x.messages]),
      [
        ["REPORTS", 0],
        ["LIVE", 2],
        ["CONFIG", 1],
      ],
    );
    assert.deepEqual(state.config.keys, ["model-route", "advisor-routes", "mcp-servers"]);
    assert.equal(state.config.message_bytes, CONFIG_MAX_BYTES);
    assert.deepEqual(state.config.written, {
      since: b.config.since,
      values: { "model-route": 2, "advisor-routes": 0, "mcp-servers": 1 },
      failed: 1,
      too_large: 0,
      not_made: 0,
    });
    const [rig] = state.config.rigs;
    assert.equal(rig?.rig, "rig-a");
    // No seal key registered in this store: control writes it nothing of its own now.
    assert.equal(rig?.sealed, false);
    assert.equal(rig?.written, 3);
    assert.deepEqual({ ...rig?.supervisor, at: undefined }, { ...config, at: undefined });
    const metrics = await (await s.read("/metrics")).text();
    for (const series of [
      'thermite_bus_stream_messages{stream="CONFIG"} 1',
      'thermite_config_values_written_total{key="model-route"} 2',
      'thermite_config_values_written_total{key="advisor-routes"} 0',
      "thermite_config_writes_failed_total 1",
      'thermite_config_updates_taken_total{rig="rig-a"} 3',
      'thermite_config_updates_refused_total{rig="rig-a"} 1',
    ])
      assert.ok(metrics.includes(`\n${series}\n`), series);
    // The figures hold counts only: no value, revision or key reaches the state.
    assert.doesNotMatch(JSON.stringify(state.config), /"sealed":"|revision|api_key/);
  });

  test("with the bus on: the mirror of control's events table, the apply of the stream, and why the mirror stopped", async () => {
    const b = await onBus();
    await b.bus.makeStream(EVENT_STREAM_CONFIG);
    const page = (from: number, to: number, body: (id: number) => unknown = () => ({})) => {
      const ids = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      b.store.rigEvents.ingest({
        rig: "rig-a",
        ledger_id: "l-1",
        cursor: from - 1,
        next: to,
        summary: {},
        events: ids.map((id) => ({
          id,
          at: "2026-10-29T03:00:00.000Z",
          actor: "t",
          kind: "journal_note",
          subject: null,
          body: body(id),
        })),
      });
    };
    page(1, 3);
    const s = setup(b.view, b.store);
    const state = async () =>
      ((await (await s.read("/v1/bus")).json()) as { events: Record<string, unknown> }).events;
    // Before the mirror started: the table's last seq, and the stream's, as the server has it; the
    // apply's place, at the stream's start.
    assert.deepEqual(await state(), {
      stream: "EVENTS",
      since: b.events.since,
      table_seq: 3,
      stream_seq: 0,
      behind: 3,
      published: 0,
      waiting: null,
      stopped: null,
      apply: {
        place: 0,
        last_place: 0,
        behind: 0,
        applied: 0,
        refused: 0,
        waiting: null,
        stopped: null,
      },
    });
    await b.apply.start();
    await b.events.start();
    await b.apply.nudge();
    const copied = await state();
    assert.deepEqual(
      [copied.table_seq, copied.stream_seq, copied.behind, copied.published, copied.stopped],
      [3, 3, 0, 3, null],
    );
    assert.deepEqual(copied.apply, {
      place: 3,
      last_place: 3,
      behind: 0,
      applied: 3,
      refused: 0,
      waiting: null,
      stopped: null,
    });
    const metrics = await (await s.read("/metrics")).text();
    for (const series of [
      'thermite_bus_stream_messages{stream="EVENTS"} 3',
      "thermite_events_table_seq 3",
      "thermite_events_stream_seq 3",
      "thermite_events_behind 0",
      "thermite_events_published_total 3",
      "thermite_events_mirror_stopped 0",
      "thermite_events_applied_place 3",
      "thermite_events_unapplied 0",
      "thermite_events_applied_total 3",
      "thermite_events_apply_refused_total 0",
    ])
      assert.ok(metrics.includes(`\n${series}\n`), series);
    // A row too large for a message on the bus, stored before ingest refused such pages: the
    // mirror stops at it, naming its rig, ledger, seq and size, and the rows after it wait.
    page(4, 5, (id) => (id === 4 ? { text: "x".repeat(EVENT_MAX_BYTES) } : {}));
    await b.events.nudge();
    const stopped = await state();
    assert.equal(stopped.stream_seq, 3);
    assert.equal(stopped.behind, 2);
    const why = stopped.stopped as Record<string, unknown>;
    assert.deepEqual([why.rig, why.ledger, why.seq], ["rig-a", "l-1", 4]);
    assert.ok(Number(why.bytes) > EVENT_MAX_BYTES, String(why.bytes));
    assert.match(String(why.error), /more than a message on the bus holds/);
    const after = await (await s.read("/metrics")).text();
    assert.ok(after.includes("\nthermite_events_mirror_stopped 1\n"));
    assert.ok(after.includes("\nthermite_events_behind 2\n"));
    b.events.close();
    b.apply.close();
  });

  test("a server that does not answer is said in words; the rest still shows", async () => {
    const b = await onBus();
    b.bus.streams = async () => {
      throw new Error("connection refused: nats:4222");
    };
    const s = setup(b.view, b.store);
    const health = async () => (await s.control.request("/v1/health")).json();
    assert.deepEqual(await health(), { ok: true, bus: "connected" });
    // Control holds no connection to the server: its health says so, and control still serves.
    b.bus.up = false;
    const away = await s.control.request("/v1/health");
    assert.equal(away.status, 200);
    assert.deepEqual(await away.json(), { ok: true, bus: "away" });
    const state = (await (await s.read("/v1/bus")).json()) as Record<string, unknown>;
    assert.equal(state.reachable, false);
    assert.equal(state.error, "connection refused: nats:4222");
    assert.deepEqual(state.streams, []);
    // What the stream holds is not known; the table's last seq is control's own.
    const events = state.events as Record<string, unknown>;
    assert.deepEqual([events.table_seq, events.stream_seq, events.behind], [0, null, null]);
    const apply = events.apply as Record<string, unknown>;
    assert.deepEqual([apply.place, apply.last_place, apply.behind], [0, null, null]);
    assert.ok(state.live, "control's own figures still show");
    assert.match(await (await s.read("/metrics")).text(), /\nthermite_bus_up 0\n/);
  });
});
