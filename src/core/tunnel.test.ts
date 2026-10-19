import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  enrollmentProof,
  generateTunnelKeys,
  newNonce,
  open,
  type RequestHead,
  sameHex,
  seal,
  signAnswer,
  signRequest,
  verifyAnswer,
  verifyRequest,
} from "./tunnel.ts";

describe("the tunnel's cryptography", () => {
  const control = generateTunnelKeys();
  const rig = generateTunnelKeys();
  const head: RequestHead = {
    method: "POST",
    path: "/x/exchange",
    rig: "rp-1",
    pod: "pod1",
    at: 1_000_000,
    nonce: newNonce(),
  };
  const body = Buffer.from('{"answers":[]}');

  test("a request verifies only unchanged, and only with control's key", () => {
    const sig = signRequest(head, body, control.signPrivatePem);
    assert.ok(verifyRequest(head, body, sig, control.signPublicPem));
    for (const changed of [
      { ...head, method: "GET" },
      { ...head, path: "/x/enroll" },
      { ...head, rig: "rp-2" },
      { ...head, pod: "pod2" },
      { ...head, at: head.at + 1 },
      { ...head, nonce: newNonce() },
    ])
      assert.ok(!verifyRequest(changed, body, sig, control.signPublicPem), JSON.stringify(changed));
    assert.ok(!verifyRequest(head, Buffer.from("{}"), sig, control.signPublicPem), "another body");
    assert.ok(!verifyRequest(head, body, sig, rig.signPublicPem), "another key");
    assert.ok(!verifyRequest(head, body, "not base64 at all", control.signPublicPem));
    const forged = signRequest(head, body, rig.signPrivatePem);
    assert.ok(!verifyRequest(head, body, forged, control.signPublicPem), "signed by anyone else");
  });

  test("an answer is bound to its request's nonce, status and body", () => {
    const sig = signAnswer(head.nonce, 200, body, rig.signPrivatePem);
    assert.ok(verifyAnswer(head.nonce, 200, body, sig, rig.signPublicPem));
    assert.ok(!verifyAnswer(newNonce(), 200, body, sig, rig.signPublicPem), "an old answer");
    assert.ok(!verifyAnswer(head.nonce, 404, body, sig, rig.signPublicPem));
    assert.ok(!verifyAnswer(head.nonce, 200, Buffer.from("x"), sig, rig.signPublicPem));
    assert.ok(!verifyAnswer(head.nonce, 200, body, sig, control.signPublicPem));
  });

  test("sealed bytes open only with the recipient's key, and not once changed", () => {
    const secret = Buffer.from('{"api_key":"a-made-up-model-key-0001"}');
    const sealed = seal(secret, rig.boxPublicPem);
    assert.ok(!sealed.includes(secret), "no plain text in what crosses the proxy");
    assert.ok(!sealed.toString("latin1").includes("model-key"));
    assert.deepEqual(open(sealed, rig.boxPrivatePem), secret);
    assert.notDeepEqual(seal(secret, rig.boxPublicPem), sealed, "a fresh key every time");
    assert.throws(() => open(sealed, control.boxPrivatePem));
    for (const at of [0, 33, 50, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = (bad[at] ?? 0) ^ 1;
      assert.throws(() => open(bad, rig.boxPrivatePem), `byte ${at} changed`);
    }
    assert.throws(() => open(Buffer.alloc(10), rig.boxPrivatePem), /too short/);
    assert.deepEqual(
      open(seal(Buffer.alloc(0), rig.boxPublicPem), rig.boxPrivatePem),
      Buffer.alloc(0),
    );
  });

  test("enrollment binds the rig's keys to its code", () => {
    const proof = enrollmentProof("code-1", rig.signPublicPem, rig.boxPublicPem);
    assert.ok(sameHex(proof, enrollmentProof("code-1", rig.signPublicPem, rig.boxPublicPem)));
    assert.ok(!sameHex(proof, enrollmentProof("code-2", rig.signPublicPem, rig.boxPublicPem)));
    assert.ok(!sameHex(proof, enrollmentProof("code-1", control.signPublicPem, rig.boxPublicPem)));
    assert.ok(!sameHex(proof, ""));
  });
});
