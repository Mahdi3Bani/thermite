import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CampaignDraft } from "../control/campaign-builder.ts";
import { assignRefusal } from "../control/issue.ts";
import { IDS, RoleSchema } from "../harness/broker/runner.ts";
import { lanesFromEnv } from "../harness/rig-settings.ts";
import { CommandPayloads, MESSAGE_TARGET } from "./commands.ts";
import { MAX_LANES, MAX_LANES_REASON, parseContract } from "./contract.ts";

/** A small valid research contract with the given lane count. */
const research = (count: number) => ({
  schema_version: 1,
  campaign: "lanes-check",
  version: 1,
  title: "Lanes",
  mode: "research",
  project: { repo: "notes" },
  topic: "t",
  questions: ["q"],
  min_duration: "30m",
  lanes: { count, trials_per_epoch: 1 },
});

describe("the most lanes a rig runs", () => {
  test("the harness image has a user for each lane, and no more", () => {
    const file = readFileSync(new URL("../../containers/harness/Containerfile", import.meta.url));
    const loop =
      /for n in \$\(seq 1 (\d+)\); do\s*\\\s*groupadd -g \$\(\(10100 \+ n\)\) lane-\$n/.exec(
        String(file),
      );
    assert.ok(loop, "the Containerfile's loop that makes the lane users");
    assert.equal(Number(loop[1]), MAX_LANES);
    assert.equal(IDS.maxLanes, MAX_LANES);
  });

  test("the broker's roles and the owner's message recipients stop at the same lane", () => {
    for (const role of [`lane-${MAX_LANES}`, `lane-${MAX_LANES}-dev`, `agent-${MAX_LANES}`])
      assert.ok(RoleSchema.safeParse(role).success, role);
    for (const role of [
      "lane-0",
      `lane-${MAX_LANES + 1}`,
      `lane-${MAX_LANES + 1}-dev`,
      `agent-${MAX_LANES + 1}`,
    ])
      assert.ok(!RoleSchema.safeParse(role).success, role);
    assert.match(`lane-${MAX_LANES}`, MESSAGE_TARGET);
    assert.doesNotMatch(`lane-${MAX_LANES + 1}`, MESSAGE_TARGET);
  });

  test("a contract, Edit rig and the campaign builder refuse more, with the reason", () => {
    assert.ok(parseContract(research(MAX_LANES)).ok);
    const more = parseContract(research(MAX_LANES + 1));
    assert.ok(!more.ok);
    assert.deepEqual(more.errors, [`lanes.count: ${MAX_LANES_REASON}`]);
    const settings = CommandPayloads.rig_settings;
    assert.ok(settings.safeParse({ lanes: MAX_LANES }).success);
    const edit = settings.safeParse({ lanes: MAX_LANES + 1 });
    assert.equal(edit.error?.issues[0]?.message, MAX_LANES_REASON);
    assert.ok(CampaignDraft.shape.lanes.safeParse(MAX_LANES).success);
    const draft = CampaignDraft.shape.lanes.safeParse(MAX_LANES + 1);
    assert.equal(draft.error?.issues[0]?.message, MAX_LANES_REASON);
  });

  test("control refuses to sign an assignment with more lanes than a rig runs", () => {
    assert.equal(assignRefusal({ contract: research(MAX_LANES) }), "");
    assert.equal(assignRefusal({ contract: { campaign: "x" } }), "");
    assert.equal(assignRefusal(null), "");
    assert.equal(
      assignRefusal({ contract: research(64) }),
      `This contract asks for 64 lanes. A rig runs ${MAX_LANES} at most: it has users for lanes 1 to ${MAX_LANES} only. Set lanes.count to ${MAX_LANES} or fewer.`,
    );
  });

  test("THERMITE_MAX_TRIALS: 1 to the most lanes, else the harness does not start", () => {
    assert.equal(lanesFromEnv(undefined), 1);
    assert.equal(lanesFromEnv(""), 1);
    assert.equal(lanesFromEnv("2"), 2);
    assert.equal(lanesFromEnv(String(MAX_LANES)), MAX_LANES);
    for (const bad of ["0", String(MAX_LANES + 1), "2.5", "two"])
      assert.throws(
        () => lanesFromEnv(bad),
        new RegExp(`THERMITE_MAX_TRIALS must be a whole number from 1 to ${MAX_LANES}, not `),
        bad,
      );
  });
});
