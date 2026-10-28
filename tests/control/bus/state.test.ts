import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BusView } from "../../../src/control/bus/index.ts";
import { LiveTaken } from "../../../src/control/live/index.ts";
import { COMMAND_STREAM } from "../../../src/core/link/commands.ts";
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
 * the live stream's figures from control and from each rig's supervisor, over REST, MCP and
 * /metrics, for the reader's token too.
 */

const READ = "read-token-abcdef";

/** Control with the bus given as `bus` (none: off), and calls with the reader's token. */
function setup(bus?: BusView) {
  const s = controlOnly({
    tokens: { read: READ, rigs: { "rig-a": RIG_TOKEN } },
    ...(bus ? { options: { bus } } : {}),
  });
  const read = (path: string) =>
    s.control.request(path, { headers: { authorization: `Bearer ${READ}` } });
  /** The rig's supervisor's figures, with its live counts. */
  const figures = (live: unknown) =>
    s.control.request("/v1/rigs/rig-a/supervisor", {
      method: "POST",
      headers: { authorization: `Bearer ${RIG_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ at: new Date().toISOString(), live }),
    });
  return { ...s, read, figures };
}

/** A bus with the reports and live streams made, two live messages kept, and control's counts. */
async function onBus() {
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
  return { bus, live, view: { server: "nats:4222", bus, live } };
}

describe("the message bus's state", () => {
  test("with the bus off, it says so, and /metrics has none of its series", async () => {
    const s = setup();
    assert.deepEqual(await (await s.read("/v1/bus")).json(), { on: false });
    assert.equal((await s.control.request("/v1/bus")).status, 401);
    const metrics = await (await s.read("/metrics")).text();
    assert.doesNotMatch(metrics, /thermite_bus_|thermite_live_/);
  });

  test("with the bus on: its streams, and the live stream's figures from control and the rig", async () => {
    const b = await onBus();
    const s = setup(b.view);
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

  test("a server that does not answer is said in words; the rest still shows", async () => {
    const b = await onBus();
    b.bus.streams = async () => {
      throw new Error("connection refused: nats:4222");
    };
    const s = setup(b.view);
    const state = (await (await s.read("/v1/bus")).json()) as Record<string, unknown>;
    assert.equal(state.reachable, false);
    assert.equal(state.error, "connection refused: nats:4222");
    assert.deepEqual(state.streams, []);
    assert.ok(state.live, "control's own figures still show");
    assert.match(await (await s.read("/metrics")).text(), /\nthermite_bus_up 0\n/);
  });
});
