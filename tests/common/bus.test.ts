import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BUS_URL_SETTING, busUrl } from "../../src/common/bus.ts";

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
