import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CommandPayloads, StructuredDirective } from "./commands.ts";
import {
  directionName,
  directionOf,
  directionsToDesign,
  directionTokens,
  isLegacyRule,
  notADirection,
  parseDirections,
  researchDirectionRefusal,
} from "./directions.ts";

describe("directions, written as plain words or :name: (goal 066)", () => {
  test("a direction's name: case, spaces and dashes don't matter; colons are optional", () => {
    for (const written of [
      "shared memory tiling",
      "Shared Memory Tiling",
      ":shared memory tiling:",
      " :shared-memory  tiling: ",
      "shared-memory-tiling",
    ])
      assert.equal(directionName(written), "shared-memory-tiling", written);
    assert.equal(directionName(":split-k:"), "split-k");
    // An experiment's words map to the same name, so a rule and an experiment meet.
    assert.equal(directionOf("Shared memory tiling"), "shared-memory-tiling");
  });

  test("text that can't be a direction's name is refused in plain words", () => {
    for (const bad of ["", "x", ":x:", "anything with $hared memory!", "tiles; and more", "::"])
      assert.equal(directionName(bad), undefined, bad);
    assert.match(
      notADirection("anything with $hared memory!"),
      /is not a direction's name: write it in letters, digits, spaces and dashes, such as shared memory tiling or :shared memory tiling:/,
    );
    assert.match(
      notADirection("a direction whose name is far too long to be one"),
      /is too long for a direction's name: use at most 41 letters/,
    );
    assert.equal(notADirection("loop tiling"), "");
  });

  test("a text such as a message names directions as :name:, each once, and nothing else does", () => {
    assert.deepEqual(
      directionTokens("stop :gemv tiling: and put :Vector-Loads: first, then :gemv-tiling: again"),
      ["gemv-tiling", "vector-loads"],
    );
    for (const none of [
      "stop trying tiling",
      "at 10:30:45 it stalled",
      "note: try it",
      "a ratio 1 :2 vs 3",
      ":x: is too short",
      "http://example.com:8080/x",
    ])
      assert.deepEqual(directionTokens(none), [], none);
    assert.deepEqual(directionTokens("(see :split k:)"), ["split-k"]);
  });

  test("the rule box: one direction in plain words, or several as :name:; other words are refused", () => {
    assert.deepEqual(parseDirections("shared memory tiling"), {
      names: ["shared-memory-tiling"],
      rest: "",
    });
    assert.deepEqual(parseDirections(":gemv tiling: :vector loads:, and :gemv-tiling:"), {
      names: ["gemv-tiling", "vector-loads"],
      rest: "",
    });
    assert.deepEqual(parseDirections(":gemv tiling: because it was slow"), {
      names: ["gemv-tiling"],
      rest: "because it was slow",
    });
    assert.deepEqual(parseDirections("anything that uses $hared memory"), {
      names: [],
      rest: "anything that uses $hared memory",
    });
    assert.deepEqual(parseDirections("   "), { names: [], rest: "" });
  });

  test("a rule's direction is kept as its name; words (match) are no longer a rule", () => {
    const ok = StructuredDirective.parse({
      kind: "avoid",
      family: ":Shared memory tiling:",
      rationale: "slow",
    });
    assert.equal(ok.family, "shared-memory-tiling");
    const words = StructuredDirective.safeParse({
      kind: "avoid",
      match: "anything with shared memory",
      rationale: "slow",
    });
    assert.ok(!words.success);
    assert.match(
      words.error.issues.map((i) => i.message).join("; "),
      /a rule no longer takes match: name its direction in family, in plain words or as :name:/,
    );
    // An experiment's direction written :name: is kept without its colons.
    const add = CommandPayloads.queue_add.parse({ run: "r-1", title: "t", family: ":split k:" });
    assert.equal(add.family, "split k");
    assert.equal(
      CommandPayloads.queue_add.parse({ run: "r-1", title: "t", family: "Loop: order" }).family,
      "Loop: order",
    );
  });

  test("an old rule in words is legacy; the directions rules name that the run lacks wait for the planner", () => {
    assert.ok(isLegacyRule({ kind: "avoid", match: "anything slow" }));
    assert.ok(!isLegacyRule({ kind: "avoid", family: "tiling" }));
    assert.ok(!isLegacyRule({ kind: "note", value: "x" }));
    assert.deepEqual(
      directionsToDesign(
        [
          { id: 1, body: { kind: "avoid", family: "tiling", rationale: "a" } },
          { id: 2, body: { kind: "try", family: "split-k", rationale: "b" } },
          { id: 3, body: { kind: "mandate", family: "split-k", rationale: "c" } },
          { id: 4, body: { kind: "avoid", match: "anything slow", rationale: "d" } },
        ],
        ["tiling"],
      ),
      [
        {
          name: "split-k",
          rules: [
            { id: 2, kind: "try", rationale: "b" },
            { id: 3, kind: "mandate", rationale: "c" },
          ],
        },
      ],
    );
    assert.match(
      researchDirectionRefusal(["blogs"]),
      /^A research run's directions are its task kinds: :explore:, :primary:, :contradict:, :consolidate:\. It has no planner to design a new direction, so a rule for :blogs: would do nothing\. Name a task kind\.$/,
    );
  });
});
