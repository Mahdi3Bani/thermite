import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { waitForFile } from "./env.ts";

describe("waiting for a file", () => {
  test("with a timeout, it gives up", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wait-")), "control-signing.pub");
    await assert.rejects(waitForFile(path, 50, { pollMs: 10 }), /timed out waiting for/);
  });

  test("without one, it waits past any timeout, says so, and returns the file once written", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wait-")), "control-signing.pub");
    const said: number[] = [];
    const waiting = waitForFile(path, undefined, {
      waiting: (ms) => said.push(ms),
      sayEveryMs: 40,
      pollMs: 10,
    });
    await new Promise((r) => setTimeout(r, 150));
    // An empty file is not there yet.
    writeFileSync(path, "");
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(path, "the key\n");
    assert.equal(await waiting, "the key\n");
    assert.ok(said.length >= 2, `said ${said.length} times`);
    assert.ok((said[0] ?? 99) < 20, "it says so at once");
  });
});
