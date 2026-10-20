import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { createControlApi } from "../control/api.ts";
import { ControlStore } from "../control/store.ts";
import { generateSigningKeys } from "../core/commands.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "thermite.ts");
const CONTRACT = join(import.meta.dirname, "../../examples/contracts/smoke-cpu.json");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Runs the command line; a refusal comes back with its exit code instead of throwing. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      ...args,
    ]);
    return { code: 0, ...r };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** A rig whose runs reported these events, in order (subject: the run). */
function report(store: ControlStore, events: [string, string, string, Record<string, unknown>][]) {
  store.ingest({
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([subject, actor, kind, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + i * 60_000).toISOString(),
      actor,
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

describe("thermite assign --queue-from (goal 067)", () => {
  test("copies a past run's untried experiments from control's records, as Start a run does; off unless asked", async () => {
    const keys = generateSigningKeys();
    const store = new ControlStore(":memory:");
    const api = createControlApi(
      store,
      { admin: "owner-token-abcdef", rigs: {} },
      keys.privateKeyPem,
    );
    const past = "smoke-cpu-1";
    const add = (id: string, by: string, more: Record<string, unknown> = {}) =>
      [past, "harness", "experiment_added", { id, title: `try ${id}`, by, ...more }] as [
        string,
        string,
        string,
        Record<string, unknown>,
      ];
    report(store, [
      [
        past,
        "harness",
        "run_created",
        { campaign: "smoke-cpu", mode: "hill_climb", version: 1, agents: true },
      ],
      add("x-000000000001", "planner", { family: "tiling", why: "the profile says so" }),
      add("x-000000000002", "owner", { position: 0 }),
      add("x-000000000003", "lane-2", { state: "proposed" }),
      add("x-000000000004", "teacher", { details: "first words" }),
      [
        past,
        "control:owner:ui",
        "experiment_edited",
        { id: "x-000000000004", title: "try four, edited", details: "kept" },
      ],
      add("x-000000000005", "planner"),
      [
        past,
        "planner",
        "experiment_assigned",
        { id: "x-000000000005", lane: "lane-1", trial: "t-1" },
      ],
      [
        past,
        "harness",
        "experiment_finished",
        { id: "x-000000000005", lane: "lane-1", trial: "t-1", result: "no_attempt" },
      ],
      add("x-000000000006", "planner"),
      [
        past,
        "planner",
        "experiment_dropped",
        { id: "x-000000000006", by: "planner", why: "slower" },
      ],
      // A run of a campaign smoke-cpu may not read: its words stay, its authors become "copied".
      [
        "other-1",
        "harness",
        "run_created",
        { campaign: "other", mode: "hill_climb", version: 1, agents: true },
      ],
      [
        "other-1",
        "harness",
        "experiment_added",
        { id: "x-00000000000a", title: "other words", by: "planner" },
      ],
      [
        "bare-1",
        "harness",
        "run_created",
        { campaign: "smoke-cpu", mode: "hill_climb", version: 1, agents: true },
      ],
    ]);
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-assign-"));
      const owner = join(dir, "owner-token");
      writeFileSync(owner, "owner-token-abcdef\n", { mode: 0o600 });
      const base = [
        "assign",
        "--contract",
        CONTRACT,
        "--run",
        "smoke-cpu-2",
        "--seed-commit",
        COMMIT,
      ];
      const at = ["--control", control, "--token-file", owner];
      const printed = await cli(...base, ...at, "--queue-from", `rig-a/${past}`, "--print");
      assert.equal(printed.code, 0, printed.stderr);
      const from = (id: string) => ({ run: past, id });
      // Up next in its order, then the lanes' ideas; the tried and the dropped stay with their run.
      assert.deepEqual(JSON.parse(printed.stdout).queue, [
        { title: "try x-000000000002", by: "owner", state: "queued", from: from("x-000000000002") },
        {
          title: "try x-000000000001",
          family: "tiling",
          why: "the profile says so",
          by: "planner",
          state: "queued",
          from: from("x-000000000001"),
        },
        {
          title: "try four, edited",
          details: "kept",
          by: "teacher",
          state: "queued",
          from: from("x-000000000004"),
        },
        {
          title: "try x-000000000003",
          by: "lane-2",
          state: "proposed",
          from: from("x-000000000003"),
        },
      ]);
      // Off unless asked for.
      const plain = await cli(...base, ...at, "--print");
      assert.equal(plain.code, 0, plain.stderr);
      assert.equal(JSON.parse(plain.stdout).queue, undefined);
      // Another campaign's run, which smoke-cpu may not read: as over MCP, its author is "copied".
      const other = await cli(...base, ...at, "--queue-from", "rig-a/other-1", "--print");
      assert.deepEqual(
        JSON.parse(other.stdout).queue.map((x: { by: string; title: string }) => [x.by, x.title]),
        [["copied", "other words"]],
      );
      // Refusals: a run without agents, no control to read from, no rig for the run, no such run.
      const tryRun = await cli(
        ...base,
        ...at,
        "--agents",
        "off",
        "--queue-from",
        `rig-a/${past}`,
        "--print",
      );
      assert.deepEqual(
        [tryRun.code, tryRun.stderr.trim()],
        [2, "a run without agents has no queue: leave out --queue-from"],
      );
      const noControl = await cli(...base, "--queue-from", `rig-a/${past}`, "--print");
      assert.deepEqual(
        [noControl.code, noControl.stderr.trim()],
        [2, "--queue-from reads the past run from control: give --control and --token-file"],
      );
      const noRig = await cli(...base, ...at, "--queue-from", past, "--print");
      assert.deepEqual(
        [noRig.code, noRig.stderr.trim()],
        [2, "--queue-from RUN is a run on --rig: give --rig, or RIG/RUN"],
      );
      const noRun = await cli(...base, ...at, "--queue-from", "rig-a/", "--print");
      assert.deepEqual(
        [noRun.code, noRun.stderr.trim()],
        [2, "--queue-from names a run: RUN or RIG/RUN"],
      );
      const missing = await cli(...base, ...at, "--queue-from", "rig-a/nope", "--print");
      assert.equal(missing.code, 2);
      assert.match(missing.stderr, /-> 404 \{"error":"no run nope on rig-a"\}/);
      // Sent: RUN alone is a run on --rig, and the signed command carries the same queue.
      const sent = await cli(...base, ...at, "--rig", "rig-a", "--queue-from", past);
      assert.equal(sent.code, 0, sent.stderr);
      const signed = store.db
        .prepare("select signed from command where id = ?")
        .get(JSON.parse(sent.stdout).id) as {
        signed: string;
      };
      const payload = (JSON.parse(signed.signed) as { envelope: { payload: { queue: unknown[] } } })
        .envelope.payload;
      assert.deepEqual(payload.queue, JSON.parse(printed.stdout).queue);
      // A run with nothing untried: the queue starts empty, and the command says so.
      const empty = await cli(...base, ...at, "--queue-from", "rig-a/bare-1", "--print");
      assert.equal(empty.code, 0, empty.stderr);
      assert.equal(JSON.parse(empty.stdout).queue, undefined);
      assert.equal(
        empty.stderr.trim(),
        "bare-1 on rig-a has no untried experiments: the new run's queue starts empty",
      );
    } finally {
      server.close();
    }
  });
});
