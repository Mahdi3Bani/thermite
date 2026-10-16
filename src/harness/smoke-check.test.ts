import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { smokeCheck } from "./smoke-check.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the smoke rig check", () => {
  test("it builds the smoke campaign itself, gets each candidate's expected verdict, and resumes the rig's runs", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign); // a running run: paused for the smoke, resumed after
    let stop = false;
    const judging = (async () => {
      while (!stop) if (!(await env.judge.tick())) await new Promise((r) => setTimeout(r, 50));
    })();
    // Candidates whose verdicts do not depend on timing, so a busy test host cannot change them.
    // The kit's build needs GNU ld (the Linux image): elsewhere, only the ones refused unbuilt.
    const only =
      process.platform === "linux"
        ? ["timer", "ref-edit", "broken", "nobuild"]
        : ["timer", "ref-edit"];
    const r = await smokeCheck({
      service: env.service,
      targetType: "cpu",
      targetClass: "test",
      checksDir: repoRoot,
      scratchDir: env.paths.scratchDir,
      only,
      pollMs: 100,
      timeoutMs: 600_000,
    }).finally(() => {
      stop = true;
    });
    await judging;
    assert.equal(r.ok, true, r.summary);
    assert.match(
      r.summary,
      new RegExp(`smoke on smoke-cpu: all ${only.length} candidates were judged as expected`),
    );
    const got = (r.detail?.candidates ?? {}) as Record<string, { got: string }>;
    assert.equal(got.timer?.got, "rejected_v0");
    assert.equal(got["ref-edit"]?.got, "rejected_v0");
    if (only.includes("broken")) assert.equal(got.broken?.got, "invalid");
    const smokeRun = String(r.detail?.run);
    assert.equal(env.ledger.getRun(smokeRun)?.status, "closed");
    assert.equal(env.ledger.getRun("js-1")?.status, "running", "the rig's run is resumed");
    // A second smoke reuses the same deterministic repositories and contract.
    const again = await smokeCheck({
      service: env.service,
      targetType: "cpu",
      targetClass: "test",
      checksDir: repoRoot,
      scratchDir: env.paths.scratchDir,
      only: ["timer"],
      pollMs: 100,
    });
    assert.equal(again.ok, true, again.summary);
  });

  test("a target without a smoke kit is reported, not attempted", async () => {
    const env = makeJudgeEnv();
    const r = await smokeCheck({
      service: env.service,
      targetType: "tpu",
      targetClass: "x",
      checksDir: repoRoot,
      scratchDir: env.paths.scratchDir,
    });
    assert.equal(r.ok, false);
    assert.match(r.summary, /no smoke kit for a tpu target/);
  });
});
