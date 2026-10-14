import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted OpenAI-compatible chat completions server for tests (streaming SSE, tool calls).
 * The script sees the request's messages and tools and returns either text or tool calls.
 */

export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
}

export type Script = (req: {
  messages: { role: string; content?: unknown; tool_calls?: unknown; name?: string }[];
  tools: { function: { name: string } }[];
  /** The request's reasoning_effort, when one was sent. */
  reasoning_effort?: string | undefined;
}) => ScriptedTurn;

export interface FakeModel {
  url: string;
  requests: number;
  close(): Promise<void>;
}

export async function startFakeModel(script: Script): Promise<FakeModel> {
  const state = { requests: 0 };
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      state.requests++;
      const parsed = JSON.parse(body) as Parameters<Script>[0] & { model: string };
      const turn = script({
        messages: parsed.messages,
        tools: parsed.tools ?? [],
        reasoning_effort: parsed.reasoning_effort,
      });
      const id = `chatcmpl-${++n}`;
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: turn.text ?? "" }, null));
      (turn.toolCalls ?? []).forEach((t, i) => {
        res.write(
          chunk(
            {
              tool_calls: [
                {
                  index: i,
                  id: `call_${n}_${i}`,
                  type: "function",
                  function: { name: t.name, arguments: JSON.stringify(t.args) },
                },
              ],
            },
            null,
          ),
        );
      });
      res.write(chunk({}, turn.toolCalls?.length ? "tool_calls" : "stop"));
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
