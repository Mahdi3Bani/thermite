import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { goalFixture, hillClimbFixture, researchFixture } from "../testing/fixtures.ts";
import { canonicalJson, canonicalSha } from "./canonical.ts";
import { type Envelope, generateSigningKeys, signEnvelope, verifyCommand } from "./commands.ts";
import { parseContract } from "./contract.ts";
import { parseDuration } from "./duration.ts";
import { globToRegExp, matchesAny } from "./glob.ts";

describe("canonical JSON", () => {
  test("sorts keys and omits undefined", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null], c: undefined }), '{"a":[true,null],"b":1}');
  });
  test("is independent of key order", () => {
    assert.equal(
      canonicalSha({ x: 1, y: { b: 2, a: 1 } }),
      canonicalSha({ y: { a: 1, b: 2 }, x: 1 }),
    );
  });
  test("rejects non-finite numbers", () => {
    assert.throws(() => canonicalJson({ score: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson([Number.POSITIVE_INFINITY]), /non-finite/);
  });
});

describe("contracts", () => {
  test("accepts one fixture per mode and applies defaults", () => {
    for (const fixture of [hillClimbFixture, goalFixture, researchFixture]) {
      const r = parseContract(fixture);
      assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
      assert.match(r.sha, /^[0-9a-f]{64}$/);
    }
    const hc = parseContract(hillClimbFixture);
    assert.ok(hc.ok && hc.contract.mode === "hill_climb");
    if (hc.ok && hc.contract.mode === "hill_climb") {
      assert.equal(hc.contract.acceptance.alpha_screen, 0.1);
      assert.deepEqual(hc.contract.acceptance.looks, [3, 6, 9]);
    }
  });

  test("an edit changes the content hash", () => {
    const a = parseContract(hillClimbFixture);
    const b = parseContract({ ...hillClimbFixture, cells: ["n256"] });
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.ok && a.sha, b.ok && b.sha);
  });

  test("goal mode keeps insufficient outcomes and checklist, and checks its goal graph", () => {
    const g = parseContract(goalFixture);
    assert.ok(g.ok && g.contract.mode === "goal");
    if (g.ok && g.contract.mode === "goal") {
      assert.equal(g.contract.insufficient.length, 2);
      assert.equal(g.contract.infeasibility.allowed, false);
    }
    const dupe = parseContract({
      ...goalFixture,
      goals: [...goalFixture.goals, goalFixture.goals[0]],
    });
    assert.ok(!dupe.ok && dupe.errors.some((e) => e.includes("duplicate goal id")));
    const badParent = parseContract({
      ...goalFixture,
      goals: [{ ...goalFixture.goals[0], parent: "missing" }],
    });
    assert.ok(!badParent.ok && badParent.errors.some((e) => e.includes("unknown parent")));
    const infeasibleNoEvidence = parseContract({
      ...goalFixture,
      infeasibility: { allowed: true },
    });
    assert.ok(!infeasibleNoEvidence.ok);
  });

  test("research needs a minimum duration, and max is not below min", () => {
    const { min_duration: _m, ...noMin } = researchFixture;
    assert.ok(!parseContract(noMin).ok);
    assert.ok(!parseContract({ ...researchFixture, max_duration: "1h" }).ok);
    const r = parseContract(researchFixture);
    assert.ok(r.ok && r.contract.mode === "research" && r.contract.quality.verbatim_quotes);
  });

  test("rejects unknown modes and missing edit policy", () => {
    assert.ok(!parseContract({ ...hillClimbFixture, mode: "freestyle" }).ok);
    const { editable_paths: _e, ...noEdit } = hillClimbFixture;
    assert.ok(!parseContract(noEdit).ok);
  });
});

describe("signed commands", () => {
  const keys = generateSigningKeys();
  const now = new Date("2026-10-14T12:00:00Z");
  const envelope = (over: Partial<Envelope> = {}): Envelope => ({
    v: 1,
    id: randomUUID(),
    unit: "unit-a",
    kind: "pause_instance",
    issued_by: "owner",
    issued_at: "2026-10-14T11:59:00Z",
    expires_at: "2026-10-14T13:00:00Z",
    payload: { instance: "smoke-1", reason: "maintenance" },
    ...over,
  });

  test("accepts a correctly signed command for this unit", () => {
    const r = verifyCommand(
      signEnvelope(envelope(), keys.privateKeyPem),
      keys.publicKeyPem,
      "unit-a",
      now,
    );
    assert.ok(r.ok);
  });
  test("rejects unsigned, tampered and wrongly signed commands", () => {
    const signed = signEnvelope(envelope(), keys.privateKeyPem);
    assert.equal(
      verifyCommand({ envelope: signed.envelope }, keys.publicKeyPem, "unit-a", now).ok,
      false,
    );
    const tampered = {
      ...signed,
      envelope: { ...signed.envelope, payload: { instance: "other", reason: "x" } },
    };
    const t = verifyCommand(tampered, keys.publicKeyPem, "unit-a", now);
    assert.ok(!t.ok && t.reason === "bad signature");
    const other = generateSigningKeys();
    const w = verifyCommand(
      signEnvelope(envelope(), other.privateKeyPem),
      keys.publicKeyPem,
      "unit-a",
      now,
    );
    assert.ok(!w.ok && w.reason === "bad signature");
  });
  test("rejects another unit's command, expired commands and bad payloads", () => {
    const wrongUnit = verifyCommand(
      signEnvelope(envelope({ unit: "unit-b" }), keys.privateKeyPem),
      keys.publicKeyPem,
      "unit-a",
      now,
    );
    assert.ok(!wrongUnit.ok && wrongUnit.reason.includes("unit-b"));
    const expired = verifyCommand(
      signEnvelope(envelope({ expires_at: "2026-10-14T11:00:00Z" }), keys.privateKeyPem),
      keys.publicKeyPem,
      "unit-a",
      now,
    );
    assert.ok(!expired.ok && expired.reason === "expired");
    const badPayload = verifyCommand(
      signEnvelope(envelope({ payload: { instance: "Bad Id" } }), keys.privateKeyPem),
      keys.publicKeyPem,
      "unit-a",
      now,
    );
    assert.ok(!badPayload.ok && badPayload.reason.startsWith("bad payload"));
  });
});

describe("helpers", () => {
  test("durations", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("8h"), 8 * 3_600_000);
    assert.throws(() => parseDuration("8 hours"));
  });
  test("globs", () => {
    assert.ok(matchesAny("src/kernel/a/b.cu", ["src/kernel/**"]));
    assert.ok(!matchesAny("src/bench/timer.cpp", ["src/kernel/**"]));
    assert.ok(globToRegExp("src/*.cu").test("src/a.cu"));
    assert.ok(!globToRegExp("src/*.cu").test("src/x/a.cu"));
    assert.ok(globToRegExp("**/*.md").test("README.md"));
  });
});
