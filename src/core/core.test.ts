import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { goalFixture, hillClimbFixture, researchFixture } from "../testing/fixtures.ts";
import { canonicalJson, canonicalSha } from "./canonical.ts";
import {
  CommandPayloads,
  type Envelope,
  generateSigningKeys,
  signEnvelope,
  verifyCommand,
} from "./commands.ts";
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

  test("a misspelled key anywhere is refused, not dropped", () => {
    const r = parseContract({ ...hillClimbFixture, acceptance: { look: [3] } });
    assert.equal(r.ok, false);
    const g = parseContract({ ...hillClimbFixture, held_out_cell: ["x"] });
    assert.equal(g.ok, false);
  });

  test("a project can be one folder of its repository; a folder that leaves it is refused", () => {
    const withFolder = (folder: unknown) =>
      parseContract({ ...hillClimbFixture, project: { ...hillClimbFixture.project, folder } });
    for (const ok of ["examples/matmul-cpu/project", "kernels", "a_b/c-d/v1.2", "@scope/pkg"]) {
      const r = withFolder(ok);
      assert.ok(r.ok, `${ok}: ${r.ok ? "" : r.errors.join("; ")}`);
      assert.equal(r.ok && r.contract.project.folder, ok);
    }
    for (const bad of [
      "",
      "/abs",
      "trailing/",
      "a//b",
      ".",
      "..",
      "a/../b",
      "./a",
      ".git",
      "a/.git",
      "a b",
      "a\\b",
    ]) {
      const r = withFolder(bad);
      assert.ok(!r.ok, `${JSON.stringify(bad)} was accepted`);
      assert.ok(r.errors.some((e) => e.startsWith("project.folder: a folder in the repository")));
    }
    // Optional and without a default: a contract written before it keeps its hash.
    const before = parseContract(hillClimbFixture);
    assert.ok(before.ok && !("folder" in before.contract.project));
    const a = withFolder("kernels");
    assert.ok(
      a.ok && before.ok && a.sha !== before.sha,
      "the folder is part of the contract's hash",
    );
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
    rig: "rig-a",
    kind: "pause_run",
    issued_by: "owner",
    issued_at: "2026-10-14T11:59:00Z",
    expires_at: "2026-10-14T13:00:00Z",
    payload: { run: "smoke-1", reason: "maintenance" },
    ...over,
  });

  test("accepts a correctly signed command for this rig", () => {
    const r = verifyCommand(
      signEnvelope(envelope(), keys.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(r.ok);
  });
  test("rejects unsigned, tampered and wrongly signed commands", () => {
    const signed = signEnvelope(envelope(), keys.privateKeyPem);
    assert.equal(
      verifyCommand({ envelope: signed.envelope }, keys.publicKeyPem, "rig-a", now).ok,
      false,
    );
    const tampered = {
      ...signed,
      envelope: { ...signed.envelope, payload: { run: "other", reason: "x" } },
    };
    const t = verifyCommand(tampered, keys.publicKeyPem, "rig-a", now);
    assert.ok(!t.ok && t.reason === "bad signature");
    const other = generateSigningKeys();
    const w = verifyCommand(
      signEnvelope(envelope(), other.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(!w.ok && w.reason === "bad signature");
  });
  test("rejects another rig's command, expired commands and bad payloads", () => {
    const wrongRig = verifyCommand(
      signEnvelope(envelope({ rig: "rig-b" }), keys.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(!wrongRig.ok && wrongRig.reason.includes("rig-b"));
    const expired = verifyCommand(
      signEnvelope(envelope({ expires_at: "2026-10-14T11:00:00Z" }), keys.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(!expired.ok && expired.reason === "expired");
    const badPayload = verifyCommand(
      signEnvelope(envelope({ payload: { run: "Bad Id" } }), keys.privateKeyPem),
      keys.publicKeyPem,
      "rig-a",
      now,
    );
    assert.ok(!badPayload.ok && badPayload.reason.startsWith("bad payload"));
  });

  test("an owner's message goes to everyone working, a lane, a trial, the planner or an advisor role; only all or a lane can be kept", () => {
    const msg = CommandPayloads.message_agent;
    for (const to of [
      "all",
      "planner",
      "advisors",
      "teachers",
      "auditor",
      "panel",
      "lane-1",
      "lane-16",
      "trial:t-0123456789abcdef",
    ])
      assert.ok(msg.safeParse({ run: "r-1", to, text: "x" }).success, to);
    for (const to of ["judge", "lane-0", "lane-17", "trial:x", "everyone", "supervisor"])
      assert.ok(!msg.safeParse({ run: "r-1", to, text: "x" }).success, to);
    assert.ok(msg.safeParse({ run: "r-1", to: "all", text: "x", keep: true }).success);
    assert.ok(msg.safeParse({ run: "r-1", to: "lane-2", text: "x", keep: true }).success);
    for (const to of ["planner", "advisors", "auditor", "trial:t-0123456789abcdef"]) {
      const r = msg.safeParse({ run: "r-1", to, text: "x", keep: true });
      assert.ok(!r.success, to);
      assert.match(String(r.error?.issues[0]?.message), /only a message to everyone working/);
    }
    assert.ok(msg.safeParse({ run: "r-1", to: "planner", text: "x", keep: false }).success);
    const unkeep = CommandPayloads.unkeep_message;
    assert.ok(unkeep.safeParse({ run: "r-1", message: 3 }).success);
    assert.ok(!unkeep.safeParse({ run: "r-1", message: 0 }).success);
    assert.ok(!unkeep.safeParse({ run: "r-1" }).success);
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

describe("commands signed before the rename", () => {
  test("a command naming its unit and instance is verified as signed and read as rig and run", async () => {
    const { createPrivateKey, sign } = await import("node:crypto");
    const keys = generateSigningKeys();
    const old = {
      v: 1,
      id: randomUUID(),
      unit: "gpu-1",
      kind: "pause_instance",
      issued_by: "owner:ui",
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      payload: { instance: "smoke-1", reason: "owner check" },
    };
    const signature = sign(
      null,
      Buffer.from(canonicalJson(old)),
      createPrivateKey(keys.privateKeyPem),
    ).toString("base64");
    const r = verifyCommand({ envelope: old, signature }, keys.publicKeyPem, "gpu-1");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ok && r.envelope.kind, "pause_run");
    assert.equal(r.ok && r.envelope.rig, "gpu-1");
    assert.deepEqual(r.ok && r.payload, { run: "smoke-1", reason: "owner check" });
    // Changed after signing: refused, as any other command.
    const tampered = {
      envelope: { ...old, payload: { instance: "other-1", reason: "x" } },
      signature,
    };
    assert.equal(verifyCommand(tampered, keys.publicKeyPem, "gpu-1").ok, false);
    assert.equal(verifyCommand({ envelope: old, signature }, keys.publicKeyPem, "gpu-2").ok, false);
  });
});
