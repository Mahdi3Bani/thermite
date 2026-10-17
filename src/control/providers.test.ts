import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { listModels, providerBase } from "./providers.ts";
import { ControlStore } from "./store.ts";

const answer =
  (status: number, body: unknown, seen?: { url: string; headers: Headers }[]) =>
  async (input: string | URL | Request, init?: RequestInit) => {
    seen?.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json(body, { status });
  };

describe("a provider's model list", () => {
  test("an OpenAI-compatible provider's /models, with the key as a bearer and its context sizes", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const models = await listModels(
      "openai",
      "https://p.example/v1/",
      "sk-1",
      answer(
        200,
        { data: [{ id: "b-model", context_length: 131072 }, { id: "a-model" }, { id: "" }] },
        seen,
      ) as typeof fetch,
    );
    assert.deepEqual(models, [
      { id: "a-model", context_window: undefined },
      { id: "b-model", context_window: 131072 },
    ]);
    assert.equal(seen[0]?.url, "https://p.example/v1/models");
    assert.equal(seen[0]?.headers.get("authorization"), "Bearer sk-1");
  });

  test("Anthropic's /v1/models, paged, with its own key header", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    let n = 0;
    const pages = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json(
        n++ === 0
          ? { data: [{ id: "claude-b" }], has_more: true, last_id: "claude-b" }
          : { data: [{ id: "claude-a" }], has_more: false },
      );
    };
    const models = await listModels("anthropic", "", "sk-ant", pages as typeof fetch);
    assert.deepEqual(
      (models as { id: string }[]).map((m) => m.id),
      ["claude-a", "claude-b"],
    );
    assert.equal(seen[0]?.url, "https://api.anthropic.com/v1/models?limit=1000");
    assert.match(seen[1]?.url ?? "", /after_id=claude-b/);
    assert.equal(seen[0]?.headers.get("x-api-key"), "sk-ant");
    assert.equal(
      providerBase("anthropic", "https://api.anthropic.com/v1/"),
      "https://api.anthropic.com",
    );
    // A pasted endpoint URL comes back to its base.
    assert.equal(
      providerBase("openai", "https://p.example/zen/v1/models"),
      "https://p.example/zen/v1",
    );
    assert.equal(
      providerBase("openai", "https://p.example/v1/chat/completions/"),
      "https://p.example/v1",
    );
    assert.equal(
      providerBase("anthropic", "https://api.anthropic.com/v1/messages"),
      "https://api.anthropic.com",
    );
  });

  test("failures say what went wrong, never with the key", async () => {
    const denied = await listModels(
      "openai",
      "https://p.example/v1",
      "sk-secret",
      answer(401, {}) as typeof fetch,
    );
    assert.deepEqual(denied, { error: "could not list its models: HTTP 401 (is the key right?)" });
    const down = await listModels("openai", "https://p.example/v1", "sk-secret", (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } });
    }) as typeof fetch);
    assert.deepEqual(down, { error: "could not reach it to list its models (EAI_AGAIN)" });
    const odd = await listModels(
      "openai",
      "https://p.example/v1",
      "sk-secret",
      answer(200, { models: [] }) as typeof fetch,
    );
    assert.ok("error" in odd && !odd.error.includes("sk-secret"));
  });
});

describe("the first settings page's routes", () => {
  test("become providers with their model, and their rigs keep it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-migrate-")), "control.db");
    const old = new DatabaseSync(path);
    old.exec(`create table model_route (name text primary key, base_url text not null, model text not null,
      context_window integer not null default 0, max_tokens integer not null default 0, reasoning text,
      key_sealed text not null, key_hint text not null, version integer not null default 1, updated_at text not null);
      create table rig_model_route (rig text primary key, route text not null, assigned_at text not null);
      insert into model_route values ('oc', 'https://p.example/v1', 'm-1', 0, 0, null, 's1:x', '…0001', 3, '2026-10-17');
      insert into rig_model_route values ('rig-a', 'oc', '2026-10-17');`);
    old.close();
    const store = new ControlStore(path);
    const p = store.provider("oc");
    assert.equal(p?.type, "openai");
    assert.equal(p?.key_sealed, "s1:x");
    assert.deepEqual(p?.models, [{ id: "m-1", added: true }]);
    assert.deepEqual(store.rigModels(), {
      "rig-a": { provider: "oc", model: "m-1", harness: "pi" },
    });
    assert.equal(
      store.db.prepare("select 1 from sqlite_master where name = 'model_route'").get(),
      undefined,
    );
  });
});
