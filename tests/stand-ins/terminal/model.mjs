// Test only (check.mjs, in the harness image): a stand-in model for the real programs in their
// own terminals: OpenAI's Responses API, which the Codex CLI calls, and chat completions, which
// OpenCode's OpenAI-compatible provider calls. It answers every call with a short text, streamed
// as each API streams it, naming the last marker (`TERMINAL-CHECK-<n>`) the conversation's user
// wrote, and the model list a program may ask for. It counts the calls by marker, and keeps no
// prompt.
import { createServer } from "node:http";

const textOf = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n")
      : "";

/** The last marker the user's messages hold, else "side" (a program's title calls). */
function marker(messages) {
  const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  for (const t of users.reverse()) {
    const m = /TERMINAL-CHECK-\d+/.exec(t);
    if (m) return m[0];
  }
  return "side";
}

const USAGE = { input_tokens: 100, output_tokens: 5 };

/** A Responses API stream of one message saying `text`. */
function responses(res, id, model, text) {
  let seq = 0;
  const ev = (type, data) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`,
    );
  const resp = {
    id: `resp_${id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model,
    output: [],
  };
  const item = {
    type: "message",
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const at = { output_index: 0, item_id: item.id, content_index: 0 };
  ev("response.created", { response: resp });
  ev("response.output_item.added", {
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  ev("response.content_part.added", {
    ...at,
    part: { type: "output_text", text: "", annotations: [] },
  });
  ev("response.output_text.delta", { ...at, delta: text });
  ev("response.output_text.done", { ...at, text });
  ev("response.content_part.done", { ...at, part: item.content[0] });
  ev("response.output_item.done", { output_index: 0, item });
  const usage = {
    ...USAGE,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: USAGE.input_tokens + USAGE.output_tokens,
  };
  ev("response.completed", { response: { ...resp, status: "completed", output: [item], usage } });
  res.end();
}

/** A chat completions stream of one message saying `text`. */
function chat(res, id, model, text) {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ id: `c${id}`, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(chunk({ role: "assistant", content: text }, null));
  res.write(chunk({}, "stop"));
  const usage = {
    prompt_tokens: USAGE.input_tokens,
    completion_tokens: USAGE.output_tokens,
    total_tokens: USAGE.input_tokens + USAGE.output_tokens,
  };
  res.write(
    `data: ${JSON.stringify({ id: `c${id}`, object: "chat.completion.chunk", created: 0, model, choices: [], usage })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

/** Starts the stand-in on localhost; `calls` counts the model calls by marker. */
export async function startModel() {
  const calls = {};
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }));
        return;
      }
      const api = path.endsWith("/responses")
        ? "responses"
        : path.endsWith("/chat/completions")
          ? "chat"
          : "";
      if (req.method !== "POST" || !api) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "only Responses and chat completions here" } }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const id = ++n;
      const m = marker(api === "responses" ? (body.input ?? []) : (body.messages ?? []));
      calls[m] = (calls[m] ?? 0) + 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      (api === "responses" ? responses : chat)(res, id, body.model, `${m} done.`);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, calls, close: () => server.close() };
}
