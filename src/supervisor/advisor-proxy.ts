import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type ForwardTarget, forwardToProvider } from "../harness/model-forward.ts";

/**
 * The model proxy for one call of an advisor in OpenCode or the Codex CLI (goal 073), as the
 * harness's proxy is for its workers: the CLI's configuration names this proxy as its provider,
 * with a credential made for this call in its environment (THERMITE_PROXY_AUTH), and the proxy
 * adds the route's real key. So the provider's key, or a ChatGPT sign-in's access token, never
 * reaches the CLI, its files or its environment. It listens on localhost for the length of one
 * call and takes no other credential.
 */

export interface AdvisorModelProxy {
  /** The provider's base address as the CLI's configuration names it (no credential in it). */
  root: string;
  /** The credential the proxy takes, as a bearer token or Anthropic's x-api-key. */
  token: string;
  close(): Promise<void>;
}

/** The path the proxy answers under, as the harness's proxy does. */
export const ADVISOR_PROXY_PATH = "/v1/model-proxy";

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Starts the proxy on a free local port. Close it when the call ends. */
export async function serveAdvisorModel(
  target: ForwardTarget,
  onUsageLimit?: (() => void) | undefined,
): Promise<AdvisorModelProxy> {
  const token = `proxy.${randomBytes(24).toString("hex")}`;
  const app = new Hono();
  app.all(`${ADVISOR_PROXY_PATH}/*`, bodyLimit({ maxSize: 64 * 1024 * 1024 }), async (c) => {
    const bearer = c.req.header("authorization") ?? "";
    const given = bearer.startsWith("Bearer ")
      ? bearer.slice(7)
      : (c.req.header("x-api-key") ?? "");
    if (!same(given, token)) return c.json({ error: "unauthorized" }, 401);
    return forwardToProvider(
      {
        method: c.req.method,
        rest: c.req.path.slice(`${ADVISOR_PROXY_PATH}/`.length),
        search: new URL(c.req.url).search,
        header: (k) => c.req.header(k),
        body:
          c.req.method === "GET" || c.req.method === "HEAD"
            ? undefined
            : Buffer.from(await c.req.arrayBuffer()),
      },
      target,
      onUsageLimit,
    );
  });
  app.all("*", (c) => c.json({ error: "not found" }, 404));
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  return {
    root: `http://127.0.0.1:${(server.address() as AddressInfo).port}${ADVISOR_PROXY_PATH}`,
    token,
    close: () =>
      new Promise<void>((r) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
