import { createServer, type Server } from "node:http";
import { parseListen } from "../common/env.ts";
import type { Loops } from "../common/health.ts";
import { log } from "../common/log.ts";
import { SUPERVISOR_HEALTH_LISTEN } from "../core/health.ts";

/** Where the supervisor answers its health route: `host:port`, in its own container by default. */
export const HEALTH_LISTEN_SETTING = "THERMITE_SUPERVISOR_HEALTH_LISTEN";

/**
 * The supervisor's health route (goal 173): `GET /v1/health` answers `{ok, rig, loops}`, each of
 * its report, command and live loops with the time since it last came around, and 503 when one is
 * past its limit. It is all the server answers: anything else is a 404. It listens on the
 * container's loopback by default, so only a check inside the container reaches it.
 */
export function serveHealth(
  env: Record<string, string | undefined>,
  rig: string,
  loops: Loops,
): Server {
  const { host, port } = parseListen(env[HEALTH_LISTEN_SETTING] || SUPERVISOR_HEALTH_LISTEN);
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/v1/health") {
      res.writeHead(404).end();
      return;
    }
    const h = loops.health();
    res
      .writeHead(h.ok ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify({ ...h, rig }));
  });
  server.on("error", (err) =>
    log("supervisor", "the health route can't listen", { host, port, error: err.message }, "error"),
  );
  server.listen(port, host);
  server.unref();
  return server;
}
