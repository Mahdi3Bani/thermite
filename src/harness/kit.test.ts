import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseContract } from "../core/contract.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { expandArgv, KitSchema, kitProblems } from "./kit.ts";

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

  test("a contract is checked against its kit: target, cells, metrics and verifiers", () => {
    const kit = KitSchema.parse({ ...base, verifiers: { builds: { cells: ["small"] } } });
    const contract = (fields: Record<string, unknown>) => {
      const r = parseContract({
        schema_version: 1,
        campaign: "c",
        version: 1,
        title: "t",
        project: { repo: "p", kit: { repo: "k", commit: "a".repeat(40) } },
        target: { type: "cpu", class: "test" },
        editable_paths: ["src/**"],
        ...fields,
      });
      if (!r.ok) throw new Error(r.errors.join("; "));
      return r.contract;
    };
    const hill = contract({
      mode: "hill_climb",
      objective: { primary: { metric: "ops", direction: "max", min_effect: 0.05 } },
      cells: ["small"],
    });
    assert.deepEqual(kitProblems(hill, kit, "cpu"), []);
    assert.match(kitProblems(hill, kit, "cuda-gpu").join(), /measures on cpu.*target is cuda-gpu/);
    const wrong = contract({
      mode: "hill_climb",
      objective: { primary: { metric: "flops", direction: "max", min_effect: 0.05 } },
      cells: ["small", "large"],
      held_out_cells: ["held"],
    });
    assert.deepEqual(kitProblems(wrong, kit), [
      "cells names cell large, which the kit does not have",
      "held_out_cells names cell held, which the kit does not have",
      "the objective names metric flops, which the kit does not have",
    ]);
    const goal = contract({
      mode: "goal",
      deliverable: "d",
      goals: [
        { id: "builds", description: "b", verify: { type: "code", verifier: "builds" } },
        { id: "loads", description: "l", verify: { type: "code", verifier: "loads" } },
        {
          id: "fast",
          description: "f",
          verify: { type: "metric_threshold", metric: "ops", op: ">=", value: 1, cells: ["big"] },
        },
      ],
    });
    assert.deepEqual(kitProblems(goal, kit), [
      "goal loads names verifier loads, which the kit does not have",
      "goal fast names cell big, which the kit does not have",
    ]);
  });

  test("an assignment whose kit does not fit its contract is refused, with the reason, before any run", async () => {
    const env = makeJudgeEnv({ contract: { cells: ["small", "huge"] } });
    const out = (await env.service.applyCommand(env.assign)) as {
      accepted?: boolean;
      result?: unknown;
    };
    assert.equal(out.accepted, false);
    assert.match(
      JSON.stringify(out.result),
      /the kit does not fit the contract: cells names cell huge/,
    );
    assert.equal(env.ledger.getRun("js-1"), undefined);
  });

  test("a run assigned with its own promotion policy keeps it; one without follows the rig's", async () => {
    const env = makeJudgeEnv({ promotion: "auto" });
    const base = (env.assign as unknown as { envelope: { payload: Record<string, unknown> } })
      .envelope.payload;
    const out = (await env.service.applyCommand(
      env.sign("assign_campaign", { ...base, promotion: "owner_approval" }),
    )) as { accepted?: boolean; result?: unknown };
    assert.equal(out.accepted, true, JSON.stringify(out.result));
    assert.equal(env.ledger.getRun("js-1")?.promotion, "owner_approval");
    assert.equal(env.service.promotionFor("js-1"), "owner_approval");
    const created = env.ledger.eventsAfter(0, 1000).events.find((e) => e.kind === "run_created");
    assert.equal(
      (created?.body as { promotion?: string } | undefined)?.promotion,
      "owner_approval",
    );
    await env.service.applyCommand(env.sign("assign_campaign", { ...base, run: "js-2" }));
    assert.equal(env.ledger.getRun("js-2")?.promotion, null);
    assert.equal(env.service.promotionFor("js-2"), "auto");
  });
});
