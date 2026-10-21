import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { CHATGPT_LIMIT_CODE, type ModelConfig } from "./agents/model.ts";
import { chatgptRequest, chatgptRouteAllowed } from "./chatgpt.ts";

/**
 * One call through a key-adding model proxy: OpenCode and the Codex CLI reach a provider through
 * one, so the provider's key (or a ChatGPT sign-in's access token) never reaches them. The
 * harness's proxy (api.ts) serves the agents; the supervisor serves one for each call of an
 * advisor in OpenCode or Codex (supervisor/advisor-proxy.ts). Whoever calls this has checked the
 * caller's credential; this adds the real key, keeps a ChatGPT sign-in to what OpenAI accepts
 * from one, and streams the answer back.
 */

/** Where a call goes: the route's API, its base address and the key at the time of the call. */
export interface ForwardTarget {
  api: ModelConfig["api"];
  baseUrl: string;
  key: string;
}

export interface ForwardCall {
  method: string;
  /** The path after the proxy's own prefix, for example `chat/completions`. */
  rest: string;
  /** The query string, with its `?`, or empty. */
  search: string;
  header(name: string): string | undefined;
  /** The request's body (none for GET and HEAD). */
  body: Buffer | undefined;
}

/**
 * Forwards one call to the provider. `onUsageLimit`: OpenAI said a ChatGPT plan's usage is full,
 * which a program that keeps only an error's message (the Codex CLI) would lose.
 */
export async function forwardToProvider(
  call: ForwardCall,
  target: ForwardTarget,
  onUsageLimit?: (() => void) | undefined,
): Promise<Response> {
  // A ChatGPT sign-in reaches only OpenAI's Responses API and the account's model list.
  const chatgpt = target.api === "chatgpt";
  if (chatgpt && !chatgptRouteAllowed(call.method, call.rest))
    return Response.json(
      { error: "a ChatGPT sign-in reaches only POST /responses and GET /models" },
      { status: 403 },
    );
  const url = new URL(`${target.baseUrl}/${call.rest}${call.search}`);
  const headers: Record<string, string> = {};
  for (const k of ["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"]) {
    const v = call.header(k);
    if (v) headers[k] = v;
  }
  if (target.api === "anthropic") headers["x-api-key"] = target.key;
  else headers.authorization = `Bearer ${target.key}`;
  let body = call.body;
  if (body && chatgpt) {
    try {
      body = chatgptRequest(body);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  }
  if (body) headers["content-length"] = String(body.length);
  // node:http, not fetch: a long model call must not meet fetch's header timeout.
  return await new Promise<Response>((resolve) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: call.method, headers, agent: false }, (res) => {
      const status = res.statusCode ?? 502;
      const out = new Headers();
      for (const k of ["content-type", "cache-control"]) {
        const v = res.headers[k];
        if (typeof v === "string") out.set(k, v);
      }
      // A ChatGPT plan's refusal is read whole (an error's body is small): OpenAI's code in it
      // says when the plan's usage is full. The answer goes on as it came.
      if (chatgpt && status >= 400) {
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (d: Buffer) => {
          if (size >= 1024 * 1024) return;
          parts.push(d);
          size += d.length;
        });
        res.on("end", () => {
          const all = Buffer.concat(parts);
          if (all.toString("utf8").includes(CHATGPT_LIMIT_CODE)) onUsageLimit?.();
          resolve(new Response(new Uint8Array(all), { status, headers: out }));
        });
        res.on("error", (e) =>
          resolve(
            Response.json(
              { error: `the provider's answer broke off: ${e.message}` },
              { status: 502 },
            ),
          ),
        );
        return;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          res.on("data", (d: Buffer) => ctrl.enqueue(new Uint8Array(d)));
          res.on("end", () => ctrl.close());
          res.on("error", (e) => ctrl.error(e));
        },
        cancel() {
          res.destroy();
        },
      });
      resolve(new Response(stream, { status, headers: out }));
    });
    req.on("error", (e) =>
      resolve(
        Response.json(
          { error: `the provider could not be reached: ${e.message}` },
          { status: 502 },
        ),
      ),
    );
    if (body) req.write(body);
    req.end();
  });
}
