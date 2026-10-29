import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { answerOf, BadInput, Refusal } from "../../../src/common/errors.ts";
import { ADMIN, controlOnly } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

function control() {
  const { store, control: api } = controlOnly({
    tokens: { rigs: { "rig-a": "rig-token-aaaaaa", "rig-b": "rig-token-bbbbbb" } },
  });
  // The body as given, not as JSON: some tests send one that isn't.
  const post = async (path: string, body: string) => {
    const r = await api.request(path, {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    });
    return { status: r.status, error: ((await r.json()) as { error?: string }).error };
  };
  return { store, post };
}

describe("refusals over REST are answered as refusals, never as server errors (goal 161)", () => {
  test("a body that is not JSON is a 400 with its words", async () => {
    const { post } = control();
    assert.deepEqual(await post("/v1/propagate", "{not json"), {
      status: 400,
      error: "the request's body is not JSON",
    });
    assert.deepEqual(await post("/v1/rigs/rig-a/reset", "{"), {
      status: 400,
      error: "the request's body is not JSON",
    });
  });

  test("a body that doesn't fit its schema is a 400", async () => {
    const { post } = control();
    assert.deepEqual(await post("/v1/propagate", JSON.stringify({ run: "r-1" })), {
      status: 400,
      error: "invalid request",
    });
  });

  test("propagate's refusals are 409s with their words", async () => {
    const { store, post } = control();
    const body = { run: "r-1", to_run: "r-2" };
    assert.deepEqual(await post("/v1/propagate", JSON.stringify(body)), {
      status: 409,
      error: "no run r-1",
    });
    // Two runs of one rig: control knows where each ran (goal 170).
    const created = (run: string, at: string) => ({
      id: Number(run.slice(2)),
      at,
      actor: "harness",
      kind: "run_created",
      subject: run,
      body: { campaign: "c", mode: "hill_climb", seed: { repo: "p", commit: "s" } },
    });
    const at = new Date().toISOString();
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "l-a",
      cursor: 0,
      next: 2,
      summary: {},
      events: [created("r-1", at), created("r-2", at)],
    });
    assert.deepEqual(await post("/v1/propagate", JSON.stringify(body)), {
      status: 409,
      error: "r-1 and r-2 are on one rig: propagate between two rigs",
    });
  });

  test("a reset's confirm and cancel of no such reset, and a second reset, are 409s", async () => {
    const { store, post } = control();
    assert.deepEqual(await post("/v1/resets/99/confirm", "{}"), {
      status: 409,
      error: "no reset 99",
    });
    assert.deepEqual(await post("/v1/resets/99/cancel", "{}"), {
      status: 409,
      error: "no reset 99",
    });
    store.fullResets.create("rig-a", "owner:api");
    assert.deepEqual(
      await post("/v1/rigs/rig-a/reset", JSON.stringify({ confirm: "reset rig-a" })),
      {
        status: 409,
        error: "a reset of rig-a is already in progress",
      },
    );
  });

  test("each error has one answer; anything else stays a 500", () => {
    assert.deepEqual(answerOf(new Refusal("no")), { status: 409, error: "no" });
    assert.deepEqual(answerOf(new BadInput("bad")), { status: 400, error: "bad" });
    assert.deepEqual(answerOf(new Error("broke")), { status: 500, error: "broke" });
  });
});
