import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readNew } from "../../../../src/agents/programs/index.ts";

/**
 * A program's events file, which its run appends to and the harness follows: whole lines only, from
 * where the last read ended, and only from a plain file.
 */
describe("reading what a program's events file gained", () => {
  const dir = mkdtempSync(join(tmpdir(), "thermite-read-new-"));

  test("whole lines from where the last read ended, a cut last line left for the next", () => {
    const f = join(dir, "events.jsonl");
    writeFileSync(f, '{"a":1}\n{"b":"é"}\n{"c":');
    const first = readNew(f, 0);
    assert.deepEqual(first.lines, ['{"a":1}', '{"b":"é"}']);
    appendFileSync(f, "3}\n");
    const second = readNew(f, first.next);
    assert.deepEqual(second.lines, ['{"c":3}']);
    assert.deepEqual(readNew(f, second.next), { lines: [], next: second.next });
  });

  test("a file not there yet gives nothing", () => {
    assert.deepEqual(readNew(join(dir, "none.jsonl"), 0), { lines: [], next: 0 });
  });

  test("a link in the file's place is not followed", () => {
    const other = join(dir, "other.txt");
    writeFileSync(other, "a line of another file\n");
    const link = join(dir, "linked.jsonl");
    symlinkSync(other, link);
    assert.deepEqual(readNew(link, 0), { lines: [], next: 0 });
  });

  test("a folder in the file's place gives nothing", () => {
    assert.deepEqual(readNew(dir, 0), { lines: [], next: 0 });
  });
});
