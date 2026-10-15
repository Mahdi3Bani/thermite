import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { copyForRun } from "./measure.ts";

function kitDir(): string {
  const kit = mkdtempSync(join(tmpdir(), "thermite-kit-"));
  mkdirSync(join(kit, "run", "lib"), { recursive: true });
  mkdirSync(join(kit, "data"));
  mkdirSync(join(kit, "refs"));
  writeFileSync(join(kit, "run", "cell.py"), "print('cell')\n", { mode: 0o644 });
  writeFileSync(join(kit, "run", "lib", "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(kit, "data", "corpus.txt"), "text\n");
  writeFileSync(join(kit, "refs", "a1.json"), "{}\n");
  return kit;
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("run.copy", () => {
  test("copies only the listed paths, read-only, keeping the execute bit", () => {
    const kit = kitDir();
    const dest = join(mkdtempSync(join(tmpdir(), "thermite-run-")), "kit");
    copyForRun(kit, ["run", "data/corpus.txt"], dest);
    assert.equal(readFileSync(join(dest, "run", "cell.py"), "utf8"), "print('cell')\n");
    assert.equal(mode(join(dest, "run", "cell.py")), 0o444);
    assert.equal(mode(join(dest, "run", "lib", "tool.sh")), 0o555);
    assert.equal(mode(join(dest, "data", "corpus.txt")), 0o444);
    for (const d of [dest, join(dest, "run"), join(dest, "run", "lib"), join(dest, "data")]) {
      assert.equal(mode(d), 0o555, d);
    }
    assert.throws(() => statSync(join(dest, "refs")), /ENOENT/);
  });

  test("a link or a missing path is refused", () => {
    const kit = kitDir();
    symlinkSync("../refs/a1.json", join(kit, "run", "a1.json"));
    const run = mkdtempSync(join(tmpdir(), "thermite-run-"));
    assert.throws(() => copyForRun(kit, ["run"], join(run, "a")), /not a regular file/);
    assert.throws(() => copyForRun(kit, ["nothing"], join(run, "b")), /not in the kit/);
  });
});
