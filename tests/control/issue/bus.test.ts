import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { COMMANDS_WAITING_MAX, sendCommandsOn } from "../../../src/control/issue/bus.ts";
import { issueCommand } from "../../../src/control/issue.ts";
import { verifyCommand } from "../../../src/core/commands.ts";
import {
  COMMAND_STREAM,
  COMMAND_STREAM_CONFIG,
  commandSubject,
} from "../../../src/core/link/commands.ts";
import { controlOnly, RIG_TOKEN } from "../../helpers/control-stack.ts";
import { FakeBus, settle } from "../../helpers/fake-bus.ts";

const SUBJECT = commandSubject("rig-a");

/** Control with rig-a, its commands sent on a bus unless `bus` is false. */
async function control(o: { bus?: boolean } = {}) {
  const c = controlOnly();
  const bus = new FakeBus();
  if (o.bus !== false) await sendCommandsOn(c.store, bus);
  /** A pause of run-1 on rig-a, as the dashboard, MCP and the API issue a command: its id. */
  const pause = (reason = "a test") =>
    issueCommand(c.store, c.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "pause_run",
      payload: { run: "run-1", reason },
      issuedBy: "owner:test",
    }).id;
  /** The ids of rig-a's pending commands, as its supervisor's poll over HTTP fetches them. */
  const pending = async () => {
    const r = await c.api("GET", "/v1/rigs/rig-a/commands/pending", undefined, RIG_TOKEN);
    const body = (await r.json()) as { commands: { envelope: { id: string } }[] };
    return body.commands.map((x) => x.envelope.id);
  };
  /** The command as control's store records it. */
  const recorded = (id: string) =>
    String(
      (c.store.db.prepare("select signed from command where id = ?").get(id) as { signed: string })
        .signed,
    );
  return { ...c, bus, pause, pending, recorded };
}

describe("control's commands on the message bus", () => {
  test("a command control issues is recorded, and published to its rig's subject as signed", async () => {
    const c = await control();
    assert.deepEqual(c.bus.streams.get(COMMAND_STREAM), COMMAND_STREAM_CONFIG, "control made it");
    const id = c.pause();
    // Recorded at once: the store stays the record, and the command's status there the truth.
    assert.equal(c.store.command(id)?.status, "pending");
    await settle();
    const [m, ...more] = c.bus.on(SUBJECT);
    assert.equal(more.length, 0);
    assert.equal(m?.id, id, "its message id is the command's");
    assert.equal(m?.data, c.recorded(id), "the message is the command as control records it");
    assert.ok(verifyCommand(JSON.parse(m?.data ?? "{}"), c.keys.publicKeyPem, "rig-a").ok);
    assert.deepEqual(await c.pending(), [id], "and the poll over HTTP still finds it");

    // A command issued over REST goes the same way.
    const r = await c.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "resume_run",
      payload: { run: "run-1" },
    });
    assert.equal(r.status, 201);
    const { id: resumed } = (await r.json()) as { id: string };
    await settle();
    assert.deepEqual(
      c.bus.on(SUBJECT).map((x) => x.id),
      [id, resumed],
    );
  });

  test("a publish that fails leaves the command pending, where the rig's poll finds it", async () => {
    const c = await control();
    c.bus.failing = true;
    const lost = c.pause("the bus is away");
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, 0);
    assert.equal(c.store.command(lost)?.status, "pending");
    assert.deepEqual(await c.pending(), [lost]);
    // The bus is back: the next command goes on it, and the first still comes over HTTP.
    c.bus.failing = false;
    const next = c.pause("the bus is back");
    await settle();
    assert.deepEqual(
      c.bus.on(SUBJECT).map((m) => m.id),
      [next],
    );
    assert.deepEqual(await c.pending(), [lost, next]);
  });

  test("a rig's commands reach the bus in the order issued, and too many waiting go over HTTP", async () => {
    const c = await control();
    let answer = () => {};
    c.bus.hold = new Promise((r) => {
      answer = r;
    });
    const ids = Array.from({ length: COMMANDS_WAITING_MAX + 2 }, (_, i) => c.pause(`step ${i}`));
    await settle();
    assert.equal(c.bus.kept.length, 0, "the bus has not answered yet");
    answer();
    await settle();
    const published = c.bus.on(SUBJECT).map((m) => m.id);
    assert.deepEqual(published, ids.slice(0, COMMANDS_WAITING_MAX), "each in its turn, in order");
    // The two past the limit stay off the bus, and every one is pending in the store.
    assert.equal((await c.pending()).length, ids.length);
  });

  test("a command the owner cancels is taken off the bus, even before its publish", async () => {
    const c = await control();
    const cancel = async (id: string) =>
      (await c.api("POST", `/v1/commands/${id}/cancel`)).json() as Promise<object>;
    const id = c.pause();
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, 1);
    assert.deepEqual(await cancel(id), { cancelled: true });
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, 0, "its supervisor will never take it");
    assert.equal(c.store.command(id)?.status, "failed");
    assert.deepEqual(await c.pending(), []);

    // Cancelled while its publish still waits its turn: taken off once it is on.
    let answer = () => {};
    c.bus.hold = new Promise((r) => {
      answer = r;
    });
    const early = c.pause();
    assert.deepEqual(await cancel(early), { cancelled: true });
    answer();
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, 0);
    // A command no longer pending is not cancelled again.
    assert.deepEqual(await cancel(early), { error: "no such pending command" });
  });

  test("without the bus, control's commands stay on HTTP", async () => {
    const c = await control({ bus: false });
    const id = c.pause();
    await settle();
    assert.equal(c.bus.kept.length, 0);
    assert.deepEqual(await c.pending(), [id]);
  });
});
