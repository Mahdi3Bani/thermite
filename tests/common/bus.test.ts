import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JetStreamApiError } from "@nats-io/jetstream";
import { errors } from "@nats-io/transport-node";
import {
  BUS_CA_FILE_SETTING,
  BUS_CA_SETTING,
  BUS_URL_SETTING,
  busTrust,
  busUrl,
  refusedForGood,
} from "../../src/common/bus.ts";
import { makeCa, makeServerCert } from "../../src/control/bus/cert.ts";

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

describe("the authority a part trusts the bus's server through", () => {
  test("the certificate itself, or a file read at each connection; neither: the system's", () => {
    assert.equal(BUS_CA_SETTING, "THERMITE_NATS_CA");
    assert.equal(BUS_CA_FILE_SETTING, "THERMITE_NATS_CA_FILE");
    assert.equal(busTrust({}), undefined);
    assert.equal(busTrust({ THERMITE_NATS_CA: " ", THERMITE_NATS_CA_FILE: "" }), undefined);
    // The file need not be there yet: control may write it after the supervisor starts.
    assert.deepEqual(busTrust({ THERMITE_NATS_CA_FILE: " /keys/bus-ca.pem " }), {
      caFile: "/keys/bus-ca.pem",
    });
    const ca = makeCa(new Date(), 1).cert;
    assert.deepEqual(busTrust({ THERMITE_NATS_CA: ca }), { ca });
  });

  test("both, or a certificate that is not an authority's, stops the part at start", () => {
    const ca = makeCa(new Date(), 1);
    assert.throws(
      () => busTrust({ THERMITE_NATS_CA: ca.cert, THERMITE_NATS_CA_FILE: "/keys/bus-ca.pem" }),
      /^Error: set THERMITE_NATS_CA or THERMITE_NATS_CA_FILE, not both$/,
    );
    const server = makeServerCert(ca, ["nats"], new Date(), 1).cert;
    for (const bad of ["not a certificate", server])
      assert.throws(
        () => busTrust({ THERMITE_NATS_CA: bad }),
        /^Error: THERMITE_NATS_CA takes the PEM certificate of the authority that signed the bus's server's certificate$/,
      );
  });

  test("another setting that names the bus is read the same way, in its own name", () => {
    assert.equal(busUrl({ OTHER: "nats://bus:4222" }, "OTHER"), "nats://bus:4222");
    assert.throws(
      () => busUrl({ OTHER: "bus" }, "OTHER"),
      /^Error: OTHER takes a nats:\/\/ address/,
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
