import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { modelEnv } from "./model.ts";
import { type ControlRoute, ModelSource } from "./model-source.ts";

const route: ControlRoute = {
  name: "opencode",
  version: 3,
  base_url: "https://models.example/v1/",
  model: "m-1",
  context_window: 262144,
  max_tokens: 0,
  reasoning: "none",
  key_hint: "…0001",
  revision: "0123456789abcdef",
  api_key: "sk-secret-0001",
};
const env = {
  baseUrl: "http://local/v1",
  model: "local-model",
  apiKey: "k",
  contextWindow: 0,
  maxTokens: 8192,
};

describe("the agents' model source", () => {
  test("control's route comes before the rig's settings, and its report never names the key", () => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-ms-")), "model-route.json");
    const m = new ModelSource(file, env);
    assert.equal(m.current()?.model, "local-model");
    assert.equal(m.info().source, "environment");
    m.set(route);
    const cur = m.current();
    assert.deepEqual(cur, {
      api: undefined,
      baseUrl: "https://models.example/v1",
      model: "m-1",
      apiKey: "sk-secret-0001",
      contextWindow: 262144,
      maxTokens: 8192,
      reasoning: "off",
    });
    assert.ok(!JSON.stringify(m.info()).includes("sk-secret"));
    // It survives a restart, and a worker gets it as THERMITE_MODEL_*.
    assert.equal(new ModelSource(file, env).current()?.apiKey, "sk-secret-0001");
    assert.equal(modelEnv(cur as NonNullable<typeof cur>).THERMITE_MODEL_REASONING_EFFORT, "none");
    m.clear();
    assert.equal(m.current()?.model, "local-model");
    assert.equal(new ModelSource(file, undefined).info().source, "none");
  });

  test("a broken route file is dropped, not trusted", () => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-ms-")), "model-route.json");
    writeFileSync(file, JSON.stringify({ ...route, base_url: "file:///etc/passwd" }));
    assert.equal(new ModelSource(file, undefined).current(), undefined);
    assert.ok(!existsSync(file));
  });
});
