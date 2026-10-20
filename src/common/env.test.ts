import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { waitForFile } from "./env.ts";

describe("waiting for a file", () => {
  test("it gives up after its timeout", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wait-")), "control-signing.pub");
    await assert.rejects(waitForFile(path, 50), /timed out waiting for/);
  });

  test("an empty file is not there yet; the file is returned once written", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wait-")), "control-signing.pub");
    writeFileSync(path, "");
    const waiting = waitForFile(path, 10_000);
    await new Promise((r) => setTimeout(r, 700));
    writeFileSync(path, "the key\n");
    assert.equal(await waiting, "the key\n");
  });
});
