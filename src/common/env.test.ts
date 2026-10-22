import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { redact, waitForFile } from "./env.ts";

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

describe("what a log line never holds (redact)", () => {
  test("a launch value with a secret's name is taken out, as NAME=value or in JSON", () => {
    const key = randomBytes(32).toString("base64url");
    const code = "c".repeat(64);
    const lines = [
      `THERMITE_STATE_SNAPSHOT_KEY=${key} THERMITE_TUNNEL_ENROLL_CODE=${code}`,
      JSON.stringify({ THERMITE_STATE_SNAPSHOT_KEY: key, THERMITE_TUNNEL_PREFIX: code }),
      // JSON within a string, as an error's message carries it.
      JSON.stringify(JSON.stringify({ THERMITE_STATE_SNAPSHOT_KEY: key, RUNPOD_API_KEY: code })),
      `THERMITE_STATE_SNAPSHOT_KEY="${key}"`,
    ];
    for (const line of lines) {
      const out = redact(line);
      assert.ok(!out.includes(key) && !out.includes(code), out);
      assert.match(out, /\*\*\*/);
    }
    assert.equal(redact(`THERMITE_STATE_SNAPSHOT_KEY=${key}`), "THERMITE_STATE_SNAPSHOT_KEY=***");
    // Public values and words about a setting stay as they are.
    for (const kept of [
      `THERMITE_TUNNEL_CONTROL_KEY_SHA256=${"a".repeat(64)}`,
      "THERMITE_MODEL_API_KEY: the model needs it",
      "set THERMITE_STATE_SNAPSHOT_KEY at launch",
      "THERMITE_STATE_SNAPSHOT_DIR=/workspace/thermite",
    ])
      assert.equal(redact(kept), kept);
  });
});
