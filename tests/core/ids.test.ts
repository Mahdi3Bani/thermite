import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandPayloads } from "../../src/core/commands.ts";
import { IdSchema } from "../../src/core/contract.ts";
import { CampaignId, RIG_ID, RunId } from "../../src/core/ids.ts";

test("a campaign's and a run's name have no dot; a kit's, a repository's and a case's keep theirs (goal 170)", () => {
  for (const ok of ["sort-speed", "sort_speed-2", "q4"]) {
    assert.ok(CampaignId.safeParse(ok).success, ok);
    assert.ok(RunId.safeParse(ok).success, ok);
  }
  for (const bad of ["llama.cpp-speed", "Sort", "-x", "a".repeat(65), ""]) {
    assert.ok(!CampaignId.safeParse(bad).success, bad);
    assert.ok(!RunId.safeParse(bad).success, bad);
  }
  assert.match(
    String(RunId.safeParse("a.b").error?.issues[0]?.message),
    /^a run's name is lowercase letters, digits, dashes and underscores/,
  );
  assert.ok(IdSchema.safeParse("llama.cpp").success, "a repository's name keeps its dots");
  // Every command that names a run takes the run's rule.
  assert.ok(!CommandPayloads.pause_run.safeParse({ run: "a.b", reason: "x" }).success);
  assert.ok(CommandPayloads.pause_run.safeParse({ run: "a-b", reason: "x" }).success);
  assert.ok(RIG_ID.test("rig-1") && !RIG_ID.test("rig-") && !RIG_ID.test("r"));
});
