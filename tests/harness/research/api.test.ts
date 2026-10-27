import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api.ts";
import { researchEnv } from "../../helpers/research-run.ts";

describe("research API", () => {
  test("a worker's calls go to its own trial's run and lane, whatever it asks", async () => {
    const { env, research } = await researchEnv();
    const registry = new Registry(env.service.ledger);
    registry.startTrial({
      id: "t-1",
      run: "r-1",
      lane: "lane-1",
      epoch: 1,
      family: "explore",
      parent: "research",
      token: "secret-token",
    });
    const api = createHarnessApi(env.service, { supervisor: "s", proposer: "p" }, { research });
    const call = (token: string, body: unknown) =>
      api.request("/v1/research/section", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await call("trial.secret-token", {
      run: "someone-else",
      lane: "owner",
      name: "summary",
      body: "text",
    });
    assert.equal(ok.status, 200);
    const row = env.service.ledger.db.prepare("select run, updated_by from report_section").get();
    assert.deepEqual({ ...row }, { run: "r-1", updated_by: "lane-1" });
    assert.equal((await call("trial.wrong", { name: "x", body: "y" })).status, 401);
    assert.equal((await call("p", { name: "x", body: "y" })).status, 401);
    registry.finishTrial(
      "t-1",
      { stopped: "finished", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "t",
    );
    assert.equal((await call("trial.secret-token", { name: "x", body: "y" })).status, 409);
  });
});
