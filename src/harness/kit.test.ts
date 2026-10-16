import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expandArgv, KitSchema } from "./kit.ts";

const base = {
  schema_version: 1,
  name: "k",
  target: "cpu",
  build: { command: ["make"], outputs: ["out"] },
  cells: { small: { work: 1 } },
  run: { command: ["{build:out/bench}", "{out}"] },
  metrics: { ops: { unit: "op/s", work: "work" } },
  check: { command: ["python3", "{kit:check.py}", "{out}"] },
};
const withRun = (run: Record<string, unknown>) => ({ ...base, run: { ...base.run, ...run } });

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

  test("a run reaches only the kit paths in run.copy", () => {
    const ok = KitSchema.parse(
      withRun({ copy: ["run", "data/x.txt"], command: ["python3", "{kit:run/cell.py}", "{kit}"] }),
    );
    assert.deepEqual(ok.run.copy, ["run", "data/x.txt"]);
    assert.deepEqual(KitSchema.parse(base).run.copy, []);
    for (const [copy, arg] of [
      [[], "{kit:run/cell.py}"],
      [[], "{kit}"],
      [["run"], "{kit:check.py}"],
      [["run"], "{kit:run/../refs/a1.json}"],
      [["run"], "{kit:runner/x}"],
    ] as const) {
      assert.throws(
        () => KitSchema.parse(withRun({ copy, command: ["python3", arg] })),
        /not in run\.copy/,
        `${JSON.stringify(copy)} ${arg}`,
      );
    }
  });

  test("copied kit paths stay inside the kit", () => {
    for (const bad of [".", "../x", "/etc", "run/../../x", "./run", "run/"]) {
      assert.throws(() => KitSchema.parse(withRun({ copy: [bad] })), /inside the kit/, bad);
      assert.throws(
        () => KitSchema.parse({ ...base, build: { ...base.build, copy: [bad] } }),
        /inside the kit/,
        bad,
      );
    }
  });

  test("verifier gates name other verifiers and never form a cycle", () => {
    const withVerifiers = (verifiers: unknown) => ({ ...base, verifiers });
    const ok = KitSchema.parse(
      withVerifiers({
        load: { cells: ["small"], priority: 1 },
        ppl: { cells: ["small"], requires: ["load"] },
      }),
    );
    assert.equal(ok.verifiers.ppl?.priority, 100);
    assert.deepEqual(ok.verifiers.load?.requires, []);
    assert.throws(
      () => KitSchema.parse(withVerifiers({ a: { cells: ["small"], requires: ["nope"] } })),
      /not another verifier/,
    );
    assert.throws(
      () => KitSchema.parse(withVerifiers({ a: { cells: ["small"], requires: ["a"] } })),
      /not another verifier/,
    );
    assert.throws(
      () =>
        KitSchema.parse(
          withVerifiers({
            a: { cells: ["small"], requires: ["b"] },
            b: { cells: ["small"], requires: ["a"] },
          }),
        ),
      /cycle/,
    );
  });
});
