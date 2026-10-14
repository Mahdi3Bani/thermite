import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { log } from "../../common/env.ts";
import { killScope, runSupervised } from "./process.ts";
import { BrokerRequest, type BrokerResponse, type BrokerRequest as Req } from "./protocol.ts";
import { IDS, insideRoot, type Role, RunRequest, roleIds } from "./runner.ts";

/**
 * The privileged side of the broker (root, inside the harness container). It runs work as the
 * named role's user, hands scratch directories to roles and takes them back. It runs no
 * research code of its own and accepts paths only under the scratch directory.
 */

export interface BrokerServerOptions {
  socketPath: string;
  scratchDir: string;
  /** Extra environment every role gets (for example PATH). Never secrets. */
  baseEnv: Record<string, string>;
}

const LANE_ROLES: Role[] = Array.from({ length: IDS.maxLanes }, (_, i) => [
  `lane-${i + 1}`,
  `lane-${i + 1}-dev`,
]).flat();
export const ALL_ROLES: Role[] = ["builder", "run", ...LANE_ROLES];

/**
 * Changes a tree's owner with coreutils: `chown -R -P` never follows symlinks and walks trees of
 * any depth (a candidate can make paths far longer than PATH_MAX). The top becomes 0700.
 */
function chownTree(path: string, uid: number, gid: number): void {
  execFileSync("chown", ["-R", "-P", `${uid}:${gid}`, path], { stdio: "ignore" });
  // The new owner must be able to read, enter and remove everything it now owns.
  execFileSync("chmod", ["-R", "u+rwX", path], { stdio: "ignore" });
  chmodSync(path, 0o700);
}

/** Per-role process limits (RLIMIT_NPROC): builds may run parallel compilers. */
const NPROC: Record<string, number> = { builder: 512, run: 256 };

export async function handle(req: Req, opts: BrokerServerOptions): Promise<unknown> {
  switch (req.op) {
    case "run": {
      const r = RunRequest.parse(req.req);
      insideRoot(opts.scratchDir, r.cwd);
      if (r.disk) insideRoot(opts.scratchDir, r.disk.path);
      const { uid, gid } = roleIds(r.role);
      return runSupervised({
        argv: r.argv,
        cwd: r.cwd,
        // The role's own directory is its home and its TMPDIR: /tmp is closed to roles.
        env: { ...opts.baseEnv, ...r.env, HOME: r.cwd, TMPDIR: r.cwd, USER: r.role },
        timeoutMs: r.timeoutMs,
        uid,
        gid,
        rssLimitBytes: r.rssLimitBytes,
        disk: r.disk,
        nproc: NPROC[r.role] ?? 256,
      });
    }
    case "handOver": {
      const { uid, gid } = roleIds(req.role);
      chownTree(insideRoot(opts.scratchDir, req.path), uid, gid);
      return null;
    }
    case "reclaim":
      chownTree(insideRoot(opts.scratchDir, req.path), IDS.thermite.uid, IDS.thermite.gid);
      return null;
    case "remove": {
      execFileSync("rm", ["-rf", "--one-file-system", insideRoot(opts.scratchDir, req.path)], {
        stdio: "ignore",
      });
      return null;
    }
    case "killRole":
      return killScope({ uid: roleIds(req.role).uid });
  }
}

export function startBrokerServer(opts: BrokerServerOptions): Server {
  const server = createServer((sock: Socket) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let id = -1;
        void (async () => {
          let res: BrokerResponse;
          try {
            const req = BrokerRequest.parse(JSON.parse(line));
            id = req.id;
            res = { id, ok: true, result: await handle(req, opts) };
          } catch (err) {
            res = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
            log("broker", "request refused", { error: res.error });
          }
          if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`);
        })();
      }
    });
    sock.on("error", () => undefined);
  });
  server.listen(opts.socketPath);
  return server;
}
