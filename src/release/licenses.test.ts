import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The licence label each published image carries (.github/workflows/release.yml), as an SPDX
 * expression: Thermite is MIT, and the harness images, and the rig image built on the CUDA one,
 * also carry the Codex CLI (Apache-2.0, with its NOTICE) beside OpenCode (MIT).
 */
const workflow = readFileSync(
  join(import.meta.dirname, "..", "..", ".github", "workflows", "release.yml"),
  "utf8",
);

/** The matrix entry of one image, by its key, as its lines. */
const entry = (key: string) =>
  new RegExp(`- key: ${key}\\n((?: {12}[^\\n]*\\n)+)`).exec(workflow)?.[1] ?? "";

test("the published images' licence labels name every licence they carry", () => {
  assert.match(entry("control"), / {12}licenses: MIT\n/);
  assert.match(entry("supervisor"), / {12}licenses: MIT\n/);
  assert.match(entry("harness"), / {12}licenses: "MIT AND Apache-2\.0"\n/);
  assert.match(entry("harness-cuda"), / {12}licenses: "MIT AND Apache-2\.0"\n/);
  // Each image's labels and annotations take its entry's value. The rig image is built only in
  // the CUDA harness's job, so it takes that entry's: it carries the same harness.
  const set = [...workflow.matchAll(/org\.opencontainers\.image\.licenses=([^\n]*)/g)].map(
    (m) => m[1],
  );
  // A GitHub Actions expression, not a template: written with its dollar sign apart.
  assert.deepEqual(set, Array(4).fill(`$${"{{ matrix.licenses }}"}`));
  assert.match(workflow, /- id: rig-meta\n {8}if: matrix\.cuda\n/);
  const cuda = ["control", "harness", "harness-cuda", "supervisor"].filter((k) =>
    / {12}cuda: true\n/.test(entry(k)),
  );
  assert.deepEqual(cuda, ["harness-cuda"]);
});
