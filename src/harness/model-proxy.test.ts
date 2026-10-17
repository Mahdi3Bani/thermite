import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { ModelSource } from "./agents/model-source.ts";
import { createHarnessApi } from "./api.ts";

/** A provider that answers every request and records what it was sent. */
async function provider() {
  const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: String(req.url), headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe("the model proxy", () => {
  test("adds the provider's key for a valid credential, and nothing else gets through", async () => {
    const p = await provider();
    try {
      const env = makeJudgeEnv();
      const file = join(mkdtempSync(join(tmpdir(), "thermite-proxy-")), "model-route.json");
      env.service.models = new ModelSource(file, {
        baseUrl: `${p.url}/v1`,
        model: "m",
        apiKey: "real-provider-key",
        contextWindow: 0,
        maxTokens: 8192,
      });
      const api = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
      const token = env.service.mintProxyToken();
      const ask = (headers: Record<string, string>) =>
        api.request("/v1/model-proxy/chat/completions?x=1", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ model: "m", stream: true }),
        });
      const ok = await ask({ authorization: `Bearer ${token}` });
      assert.equal(ok.status, 200);
      assert.equal(await ok.text(), "data: one\n\ndata: [DONE]\n\n");
      assert.equal(p.seen[0]?.url, "/v1/chat/completions?x=1");
      assert.equal(p.seen[0]?.headers.authorization, "Bearer real-provider-key");
      assert.equal(p.seen[0]?.body, JSON.stringify({ model: "m", stream: true }));
      // A wrong or missing credential, or a trial that is not open, reaches nothing.
      const refused: Record<string, string>[] = [
        {},
        { authorization: "Bearer proxy.nope" },
        { authorization: "Bearer trial.nope" },
      ];
      for (const h of refused) assert.equal((await ask(h)).status, 401);
      assert.equal(p.seen.length, 1);
      // An Anthropic route gets the key as x-api-key; its client may send the credential that way.
      env.service.models = new ModelSource(file, {
        api: "anthropic",
        baseUrl: p.url,
        model: "m",
        apiKey: "real-anthropic-key",
        contextWindow: 0,
        maxTokens: 8192,
      });
      const ant = await api.request("/v1/model-proxy/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
        body: "{}",
      });
      assert.equal(ant.status, 200);
      assert.equal(p.seen[1]?.url, "/v1/messages");
      assert.equal(p.seen[1]?.headers["x-api-key"], "real-anthropic-key");
      assert.equal(p.seen[1]?.headers["anthropic-version"], "2023-06-01");
      assert.equal(p.seen[1]?.headers.authorization, undefined);
    } finally {
      p.server.close();
    }
  });
});
