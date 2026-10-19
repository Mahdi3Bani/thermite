import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { listFiles, readFile, removeFile, searchFiles, writeFile } from "./research-files.ts";

/** A folder with a record, a lane's working area, and a secret next to it (outside). */
function folder() {
  const base = mkdtempSync(join(tmpdir(), "thermite-rf-"));
  const root = join(base, "folder");
  const work = join(root, "work", "lane-1");
  mkdirSync(join(root, "claims"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(root, "claims", "c-1.md"), "# Claim c-1: verified\n\nCaches help.\n");
  writeFileSync(join(base, "secret.txt"), "not for workers\n");
  return { base, f: { root, work } };
}

describe("a Pi research worker's file tools", () => {
  test("read and search the folder; a symlink out of it is refused, and search skips it", () => {
    const { base, f } = folder();
    symlinkSync(join(base, "secret.txt"), join(f.root, "claims", "peek.md"));
    assert.deepEqual(listFiles(f).entries, ["claims/", "work/"]);
    assert.match(readFile(f, "claims/c-1.md").text, /Caches help/);
    assert.match(readFile(f, "/claims/c-1.md", 2, 5).text, /^Claim$/);
    assert.throws(() => readFile(f, "claims/peek.md"), /outside the research folder/);
    assert.throws(() => readFile(f, "../secret.txt"), /outside the research folder/);
    assert.throws(() => listFiles(f, ".."), /outside the research folder/);
    assert.deepEqual(searchFiles(f, "CACHES").matches, ["claims/c-1.md:3: Caches help."]);
    assert.deepEqual(searchFiles(f, "^# Claim c-\\d+: verified", { regex: true }).matches, [
      "claims/c-1.md:1: # Claim c-1: verified",
    ]);
    assert.deepEqual(searchFiles(f, "not for workers").matches, [], "the symlink is not followed");
  });

  test("writes go only into the lane's working area, never through a symlink", () => {
    const { base, f } = folder();
    assert.deepEqual(writeFile(f, "work/lane-1/a/b.md", "one\n"), {
      path: join("work", "lane-1", "a", "b.md"),
      bytes: 4,
    });
    writeFile(f, "work/lane-1/a/b.md", "two\n", true);
    assert.equal(readFileSync(join(f.work, "a", "b.md"), "utf8"), "one\ntwo\n");
    assert.throws(() => writeFile(f, "claims/c-1.md", "forged"), /only in your working area/);
    assert.throws(() => writeFile(f, "work/lane-2/x.md", "x"), /only in your working area/);
    assert.throws(() => writeFile(f, "../secret.txt", "x"), /only in your working area/);
    // A link in the working area to a directory outside: nothing is written through it.
    symlinkSync(base, join(f.work, "out"));
    assert.throws(
      () => writeFile(f, "work/lane-1/out/secret.txt", "x"),
      /outside your working area/,
    );
    symlinkSync(join(base, "secret.txt"), join(f.work, "s.txt"));
    assert.throws(() => writeFile(f, "work/lane-1/s.txt", "x"), /is a symlink/);
    assert.equal(readFileSync(join(base, "secret.txt"), "utf8"), "not for workers\n");
    // Removing a link removes the link only; the area itself stays.
    removeFile(f, "work/lane-1/out");
    assert.ok(!existsSync(join(f.work, "out")) && existsSync(base));
    assert.throws(() => removeFile(f, "work/lane-1"), /the working area itself stays/);
    assert.throws(() => removeFile(f, "claims/c-1.md"), /only in your working area/);
  });
});
