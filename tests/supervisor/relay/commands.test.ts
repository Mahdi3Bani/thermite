import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { sendCommandsOn } from "../../../src/control/issue/bus.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { canonicalJson } from "../../../src/core/canonical.ts";
import { signEnvelope } from "../../../src/core/commands.ts";
import { commandSubject } from "../../../src/core/link/commands.ts";
import {
  COMMAND_AGAIN_MS,
  COMMAND_FALLBACK_SECONDS,
  commandPollMs,
  takeCommand,
} from "../../../src/supervisor/relay/commands.ts";
import {
  oneAtATime,
  type RelayConfig,
  relayCommandsOnce,
} from "../../../src/supervisor/relay/index.ts";
import { controlStack } from "../../helpers/control-stack.ts";
import { FakeBus, settle } from "../../helpers/fake-bus.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

const SUBJECT = commandSubject("rig-a");

/**
 * Control, rig-a's harness and its supervisor's relay, with control's commands sent on a bus.
 * `take()` hands the bus's messages to the supervisor as its consumer does; `failAcks` makes
 * control refuse that many of the supervisor's acks of an outcome, as when control is away.
 */
async function rig() {
  const s = controlStack({ env: makeHarnessEnv("rig-a") });
  const bus = new FakeBus();
  await sendCommandsOn(s.store, bus);
  const delivered: string[] = [];
  let failAcks = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "harness" && url.pathname === "/v1/commands")
      delivered.push((JSON.parse(String(init?.body)) as { envelope: { id: string } }).envelope.id);
    if (url.pathname.endsWith("/ack") && failAcks > 0) {
      failAcks--;
      return Response.json({ error: "control is away" }, { status: 503 });
    }
    return s.fetchImpl(input, init);
  };
  const cfg: RelayConfig = {
    ...s.cfg,
    fetchImpl,
    held: new Map(),
    staging: new Set(),
    delivered: new Set(),
    turn: oneAtATime(),
  };
  const issue = async (kind: string, payload: unknown) => {
    const r = await s.api("POST", "/v1/commands", { rig: "rig-a", kind, payload });
    assert.equal(r.status, 201, await r.clone().text());
    await settle();
    return ((await r.json()) as { id: string }).id;
  };
  return {
    ...s,
    bus,
    cfg,
    delivered,
    issue,
    take: () => bus.take(SUBJECT, (m) => takeCommand(cfg, m)),
    failAcks: (n: number) => {
      failAcks = n;
    },
    status: (id: string) => s.store.commands.get(id)?.status,
  };
}

describe("the supervisor's commands from the message bus", () => {
  test("a command is delivered as it comes, and acked only once control has its outcome", async () => {
    const r = await rig();
    const id = await r.issue("assign_campaign", r.env.assignPayload());
    // Control does not take the outcome: the harness has the command, the bus keeps it.
    r.failAcks(1);
    assert.deepEqual(await r.take(), { acked: 0, again: 1 });
    assert.equal(r.env.service.ledger.runs.get("smoke-1")?.status, "running");
    assert.equal(r.status(id), "pending");
    assert.equal(r.bus.on(SUBJECT).length, 1);
    // Handed again: the harness answers from what it applied, control takes it, the bus lets go.
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    assert.equal(r.status(id), "delivered");
    assert.deepEqual(r.delivered, [id, id]);
    assert.equal(r.bus.kept.length, 0);
    assert.equal(r.cfg.held?.size, 0);

    // The bus hands it once more, after its duplicate window: acked, and not delivered again.
    r.bus.forgetIds();
    const signed = r.store.db.prepare("select signed from command where id = ?").get(id) as {
      signed: string;
    };
    await r.bus.publish(SUBJECT, signed.signed, { id });
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    assert.deepEqual(r.delivered, [id, id]);
  });

  test("a command that waits for its sources is handed again, and the ones after it go on", async () => {
    const r = await rig();
    let ready = false;
    r.cfg.stage = async (cmd) =>
      cmd.envelope.kind === "assign_campaign" && !ready ? "wait" : "ready";
    const assign = await r.issue("assign_campaign", r.env.assignPayload());
    const check = await r.issue("pause_run", { run: "smoke-1", reason: "after it" });
    assert.deepEqual(await r.take(), { acked: 1, again: 1 });
    assert.equal(r.status(assign), "pending");
    assert.ok(r.cfg.staging?.has(assign), "its sources stage: control keeps it alive");
    assert.ok(r.cfg.held?.has(assign), "the poll over HTTP names it to control");
    // The next one went on: the harness refused it (no such run yet), and control has that.
    assert.equal(r.status(check), "failed");
    assert.equal(COMMAND_AGAIN_MS, 5000);
    ready = true;
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    assert.equal(r.status(assign), "delivered");
    assert.equal(r.cfg.staging?.size, 0);
  });

  test("the poll over HTTP stays, slower, for a command the bus never had", async () => {
    assert.equal(commandPollMs({}, false), 5000);
    assert.equal(commandPollMs({}, true), COMMAND_FALLBACK_SECONDS * 1000);
    assert.ok(COMMAND_FALLBACK_SECONDS >= 60 && COMMAND_FALLBACK_SECONDS < 600, "minutes");
    assert.equal(commandPollMs({ THERMITE_COMMAND_POLL_SECONDS: "0" }, true), 180_000);
    assert.throws(() => commandPollMs({ THERMITE_COMMAND_POLL_SECONDS: "soon" }, true));

    const r = await rig();
    const assign = await r.issue("assign_campaign", r.env.assignPayload());
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    r.bus.failing = true;
    const pause = await r.issue("pause_run", { run: "smoke-1", reason: "off the bus" });
    assert.deepEqual(await r.take(), { acked: 0, again: 0 }, "the bus never had it");
    await relayCommandsOnce(r.cfg);
    assert.equal(r.status(pause), "delivered");
    assert.equal(r.env.service.ledger.runs.get("smoke-1")?.status, "paused");
    // It reaches the bus late: acked there, and not delivered a second time.
    r.bus.failing = false;
    const signed = r.store.db.prepare("select signed from command where id = ?").get(pause) as {
      signed: string;
    };
    await r.bus.publish(SUBJECT, signed.signed, { id: pause });
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    assert.deepEqual(r.delivered, [assign, pause]);
  });

  test("the bus and the poll over HTTP take turns, and deliver a command once", async () => {
    const r = await rig();
    let staging = 0;
    let most = 0;
    r.cfg.stage = async () => {
      most = Math.max(most, ++staging);
      await new Promise((ok) => setTimeout(ok, 20));
      staging--;
      return "ready";
    };
    const id = await r.issue("assign_campaign", r.env.assignPayload());
    // On the bus and pending on control at once: both find it at the same time.
    await Promise.all([r.take(), relayCommandsOnce(r.cfg)]);
    assert.equal(most, 1, "one command staged at a time");
    assert.deepEqual(r.delivered, [id], "the harness had it once");
    assert.equal(r.status(id), "delivered");
    assert.equal(r.bus.kept.length, 0);
  });

  test("a cancelled command is never delivered; nor are an expired one and another rig's", async () => {
    const r = await rig();
    const cancelled = await r.issue("pause_run", { run: "smoke-1", reason: "never mind" });
    await r.api("POST", `/v1/commands/${cancelled}/cancel`);
    await settle();
    assert.deepEqual(await r.take(), { acked: 0, again: 0 }, "control took it off the bus");
    await relayCommandsOnce(r.cfg);
    assert.equal(r.status(cancelled), "failed");

    const expired = issueCommand(r.store, r.env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "pause_run",
      payload: { run: "smoke-1", reason: "too late" },
      ttlMinutes: 0.0001,
      issuedBy: "owner:test",
    }).id;
    await settle();
    await new Promise((ok) => setTimeout(ok, 20));
    const now = new Date().toISOString();
    const forRigB = signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-b",
        kind: "pause_run",
        issued_by: "owner:test",
        issued_at: now,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        payload: { run: "smoke-1", reason: "for rig-b" },
      },
      r.env.keys.privateKeyPem,
    );
    await r.bus.publish(SUBJECT, canonicalJson(forRigB), { id: forRigB.envelope.id });
    await r.bus.publish(SUBJECT, "{", { id: "not-a-command" });
    assert.deepEqual(await r.take(), { acked: 3, again: 0 });
    assert.deepEqual(r.delivered, [], "the harness had none of them");
    // Control marks the expired one when its rig next asks over HTTP.
    await relayCommandsOnce(r.cfg);
    assert.equal(r.status(expired), "expired");
  });
});
