import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expandArgv } from "./kit.ts";

describe("kit commands", () => {
  test("placeholders expand, a model is named by its sha256, and unknown ones are refused", () => {
    const sha = "a".repeat(64);
    assert.deepEqual(
      expandArgv(["{build:out/run}", "--model", `{models:${sha}}`, "{params}", "{out}"], {
        build: "/b",
        models: "/state/models",
        params: "/r/params.txt",
        out: "/r/out",
      }),
      ["/b/out/run", "--model", `/state/models/${sha}`, "/r/params.txt", "/r/out"],
    );
    assert.throws(() => expandArgv(["{model:x}"], { models: "/m" }), /unknown placeholder/);
  });
});
