import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseContract } from "../core/contract.ts";
import { KitSchema, paramsText } from "../harness/kit.ts";
import {
  type BuiltKit,
  buildCampaign,
  type CampaignDraft,
  shellCommand,
} from "./campaign-builder.ts";

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const here = {
  source: "here",
  build: "make bench",
  outputs: ["bench"],
  cases: [
    { name: "small", params: { n: 64 }, work: 524288 },
    { name: "large", params: { n: 512 }, work: 268435456 },
    { name: "held", params: { n: 300 }, work: 54000000 },
  ],
  run: "{build}/bench --n {n} --out {out}/result.txt",
  check: 'test "$(cat {out}/result.txt)" = "{n}" && test -f {kit}/expected.txt',
  files: [{ name: "expected.txt", content_base64: Buffer.from("ok\n").toString("base64") }],
  held_out: ["held"],
} as const satisfies CampaignDraft["kit"];

const hillClimb: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: { type: "cpu", class: "generic-cpu" },
  project: {
    url: "https://git.example.com/team/fastmat.git",
    ref: "main",
    commit: C,
    repo: "fastmat",
    editable_paths: ["src/kernels/**"],
  },
  kit: here,
  score: { name: "throughput", unit: "FLOP/s", direction: "max", min_effect: 0.05 },
  lanes: 2,
};

/** Writes a built kit to a directory, as a rig would check it out. */
function checkout(kit: BuiltKit): string {
  const dir = mkdtempSync(join(tmpdir(), "thermite-kit-"));
  for (const [path, body] of Object.entries(kit.files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("the new-campaign page's builder", () => {
  test("a hill climb with a kit described on the page is a contract and kit the harness accepts", () => {
    const b = buildCampaign(hillClimb);
    assert.ok(b.ok, JSON.stringify(!b.ok && b.errors));
    const parsed = parseContract({ ...b.contract });
    assert.ok(parsed.ok);
    if (!parsed.ok || parsed.contract.mode !== "hill_climb") return;
    assert.deepEqual(parsed.contract.cells, ["small", "large"]);
    assert.deepEqual(parsed.contract.held_out_cells, ["held"]);
    assert.equal(parsed.contract.objective.primary.metric, "throughput");
    assert.equal(parsed.contract.project.kit?.repo, "matmul-speed-kit");
    const kit = KitSchema.parse(JSON.parse(String(b.kit?.files["kit.json"])));
    assert.equal(kit.target, "cpu");
    assert.deepEqual(kit.cells.large, { n: 512, work: 268435456 });
    assert.deepEqual(kit.metrics, { throughput: { unit: "FLOP/s", work: "work" } });
    assert.deepEqual(kit.run.copy, ["run"]);
    // A file for the check only is not in what the run may read.
    assert.ok(b.kit?.files["check/expected.txt"]);
    assert.equal(b.kit?.files["run/expected.txt"], undefined);
  });

  test("the wrappers run the commands as written, with the case's parameters, and the check's exit is the verdict", () => {
    const b = buildCampaign(hillClimb);
    assert.ok(b.ok && b.kit);
    if (!b.ok || !b.kit) return;
    const kit = checkout(b.kit);
    const build = mkdtempSync(join(tmpdir(), "thermite-build-"));
    // A "build" whose bench writes the n it was given.
    writeFileSync(
      join(build, "bench"),
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --n) n="$2"; shift 2;; --out) out="$2"; shift 2;; *) shift;; esac; done\necho "$n" > "$out"\n',
    );
    chmodSync(join(build, "bench"), 0o755);
    const out = mkdtempSync(join(tmpdir(), "thermite-out-"));
    const params = join(out, "..", `params-${process.pid}.txt`);
    writeFileSync(params, paramsText({ n: 512, work: 268435456 }));
    execFileSync("sh", [join(kit, "run/run.sh"), build, out, params, join(kit, "run")]);
    const pass = execFileSync(
      "sh",
      [join(kit, "check/check.sh"), build, out, params, join(kit, "check")],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(pass.trim().split("\n").at(-1) ?? ""), { pass: true, reasons: [] });
    // A wrong output fails, with the check's exit status and its last words as the reason.
    writeFileSync(join(out, "result.txt"), "7\n");
    const fail = JSON.parse(
      execFileSync("sh", [join(kit, "check/check.sh"), build, out, params, join(kit, "check")], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .at(-1) ?? "",
    ) as { pass: boolean; reasons: string[] };
    assert.equal(fail.pass, false);
    assert.match(fail.reasons[0] ?? "", /^the check exited 1/);
  });

  test("a command with quotes survives the wrapper, and an unknown placeholder is refused in words", () => {
    const quoted = shellCommand(`echo 'it''s {n}' > {out}/x`, new Set(["n"]));
    assert.equal(quoted.text, `echo 'it''s "$P_n"' > "$OUT"/x`);
    const b = buildCampaign({
      ...hillClimb,
      kit: { ...here, run: "{build}/bench --size {size}" },
    });
    assert.equal(b.ok, false);
    assert.match(JSON.stringify(!b.ok && b.errors), /\{size\} is not a placeholder here/);
  });

  test("a hill climb needs each case's work; goals become verifiers and thresholds", () => {
    const noWork = buildCampaign({
      ...hillClimb,
      kit: { ...here, cases: [{ name: "small", params: { n: 64 } }], held_out: [] },
    });
    assert.equal(noWork.ok, false);
    assert.match(JSON.stringify(!noWork.ok && noWork.errors), /needs its work per run/);
    const goal = buildCampaign({
      ...hillClimb,
      mode: "goal",
      campaign: "codec-support",
      kit: { ...here, held_out: [] },
      goals: [
        {
          id: "builds",
          description: "it builds and passes",
          verify: { type: "check", cells: ["small"] },
        },
        {
          id: "fast",
          description: "large runs fast",
          verify: { type: "metric", op: ">=", value: 1e9, cells: ["large"] },
        },
        {
          id: "clear",
          description: "readable",
          required: false,
          verify: { type: "review", criteria: ["clear names"] },
        },
      ],
    });
    assert.ok(goal.ok, JSON.stringify(!goal.ok && goal.errors));
    if (!goal.ok) return;
    const kit = KitSchema.parse(JSON.parse(String(goal.kit?.files["kit.json"])));
    assert.deepEqual(kit.verifiers.builds?.cells, ["small"]);
    const goals = goal.contract.goals as { id: string; verify: Record<string, unknown> }[];
    assert.deepEqual(goals[0]?.verify, { type: "code", verifier: "builds" });
    assert.equal(goals[1]?.verify.type, "metric_threshold");
    assert.equal(goals[1]?.verify.metric, "throughput");
    assert.equal(goals[2]?.verify.type, "review");
  });

  test("a kit from a repository names its cases; research needs no project or kit", () => {
    const repo = buildCampaign({
      ...hillClimb,
      kit: {
        source: "repo",
        url: "https://git.example.com/team/fastmat-kit.git",
        commit: C,
        repo: "fastmat-kit",
        cells: ["small", "large"],
      },
    });
    assert.ok(repo.ok, JSON.stringify(!repo.ok && repo.errors));
    if (repo.ok) {
      assert.equal(repo.kit, undefined);
      assert.deepEqual(repo.contract.project, {
        repo: "fastmat",
        kit: { repo: "fastmat-kit", commit: C },
      });
    }
    const research = buildCampaign({
      mode: "research",
      campaign: "two-bit-decoding",
      title: "2-bit decoding on old GPUs",
      target: { type: "cpu", class: "generic-cpu" },
      research: {
        topic: "Decoding speed of 2-bit models on Pascal GPUs",
        questions: ["Which kernels are fastest?"],
        min_duration: "8h",
      },
    });
    assert.ok(research.ok, JSON.stringify(!research.ok && research.errors));
    const missing = buildCampaign({ ...hillClimb, project: undefined });
    assert.equal(missing.ok, false);
  });
});
