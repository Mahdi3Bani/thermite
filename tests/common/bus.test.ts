import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JetStreamApiError } from "@nats-io/jetstream";
import { errors } from "@nats-io/transport-node";
import { BUS_URL_SETTING, busUrl, refusedForGood } from "../../src/common/bus.ts";

describe("the message bus's setting", () => {
  test("not set or empty keeps the part to HTTP; a nats:// address is taken", () => {
    assert.equal(BUS_URL_SETTING, "THERMITE_NATS_URL");
    assert.equal(busUrl({}), undefined);
    assert.equal(busUrl({ THERMITE_NATS_URL: "" }), undefined);
    assert.equal(busUrl({ THERMITE_NATS_URL: "  " }), undefined);
    assert.equal(busUrl({ THERMITE_NATS_URL: "nats://nats:4222" }), "nats://nats:4222");
    assert.equal(busUrl({ THERMITE_NATS_URL: " nats://127.0.0.1:4222 " }), "nats://127.0.0.1:4222");
  });

  test("anything else stops the part at start, with the setting's name", () => {
    for (const bad of ["http://nats:4222", "nats:4222", "nats://", "tls://nats:4222", "nats"])
      assert.throws(
        () => busUrl({ THERMITE_NATS_URL: bad }),
        new RegExp(
          `^Error: THERMITE_NATS_URL takes a nats:// address, such as nats://nats:4222, not "${bad}"$`,
        ),
        bad,
      );
  });
});

describe("a publish the server refused", () => {
  test("for good: its user may not publish there, or the stream refused the message itself", () => {
    const denied = new errors.PermissionViolationError(
      'Permissions Violation for Publish to "thermite.run.r1.live.planner"',
      "publish",
      "thermite.run.r1.live.planner",
    );
    // The library hands it over wrapped in the request's own error.
    assert.ok(refusedForGood(new errors.RequestError(denied.message, { cause: denied })));
    assert.ok(refusedForGood(denied));
    const tooLarge = new JetStreamApiError({
      code: 400,
      err_code: 10054,
      description: "message size exceeds maximum allowed",
    });
    assert.ok(refusedForGood(tooLarge));
  });

  test("not for good: no ack in time, no stream yet, a dropped connection", () => {
    assert.ok(!refusedForGood(new errors.TimeoutError()));
    const none = new Error(
      "no stream on the bus takes thermite.rig.rig-a.live.judge yet: control makes it",
    );
    assert.ok(!refusedForGood(none));
    assert.ok(!refusedForGood(new errors.ClosedConnectionError()));
    assert.ok(!refusedForGood("refused"));
  });
});
