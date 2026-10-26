import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { waitForHarness } from "../../src/supervisor/startup.ts";

describe("the supervisor's start", () => {
  test("waits until the harness answers, and stops waiting when told to", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) throw new Error("connection refused");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    assert.equal(await waitForHarness("http://h", () => false, { pollMs: 1, fetchImpl }), true);
    assert.equal(calls, 3);
    const never = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    let n = 0;
    assert.equal(
      await waitForHarness("http://h", () => ++n > 2, { pollMs: 1, fetchImpl: never }),
      false,
    );
  });
});
