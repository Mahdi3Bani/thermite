import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { log } from "../common/env.ts";
import {
  enrollmentProof,
  generateTunnelKeys,
  open,
  type RequestHead,
  seal,
  signAnswer,
  TUNNEL_NONCE_MS,
  TUNNEL_SKEW_MS,
  type TunnelKeys,
  verifyRequest,
} from "../core/tunnel.ts";

/**
 * The rig's end of the tunnel, for a rig control reaches through a public proxy (a RunPod pod:
 * docs/plan/goals/019-rig-only-entry.goal). The rig never connects to control. Instead:
 *
 * - The supervisor makes its usual calls to control at a local address (127.0.0.1) that takes
 *   only the supervisor's own token. Each call waits there as a request for control.
 * - Control connects to the public port, behind the proxy, and in each exchange collects the
 *   waiting requests and returns the answers to earlier ones. Control answers them as this rig.
 *
 * The public port answers only a request control signed for this rig and this pod, fresh and
 * never seen before, under the secret path. Everything else gets the same empty 404, before its
 * body is read when the path is wrong. Bodies are sealed both ways and answers are signed, so the
 * proxy only moves bytes.
 */

export interface PodTunnelOptions {
  rig: string;
  /** The pod's ID, as control knows it (RUNPOD_POD_ID). */
  pod: string;
  /** The secret path prefix control set at launch (no slashes). */
  prefix: string;
  /** Control's Ed25519 public key: it signs every request. */
  controlSignPublicPem: string;
  /** This rig's X25519 key at control: what goes to control is sealed to it. */
  controlBoxPublicPem: string;
  /** The one-time enrollment code from launch; it proves these keys belong to this launch. */
  enrollCode: string;
  /** Where this rig keeps its own keys (made at the first start; only the supervisor reads it). */
  keysPath: string;
  /** The public port (all interfaces, for the proxy) and the supervisor's local one. */
  publicPort: number;
  localPort: number;
  /** The token the supervisor's calls to the local port carry. */
  localToken: string;
  now?: () => number;
  /** How long a supervisor's call waits for control's answer. */
  callTimeoutMs?: number;
}

interface Waiting {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  respond: (status: number, headers: Record<string, string>, body: Buffer) => void;
  /** When it last went to control (0: never). Unanswered calls go again after a while. */
  offeredAt: number;
}

/** Requests from control: at most this many bytes; the supervisor's calls, a little more. */
const MAX_FROM_CONTROL = 64 * 1024 * 1024;
const MAX_LOCAL_CALL = 40 * 1024 * 1024;
/** At most this many of the supervisor's calls wait at once; more are refused (503). */
const MAX_WAITING = 64;
/** Requests to the public port in any one second, refused or not. */
const MAX_PER_SECOND = 20;
/** Long-poll: an exchange with nothing to collect waits at most this long for a new call. */
const MAX_HOLD_MS = 25_000;
/** A call control has not answered is offered again after this long. */
const REOFFER_MS = 5_000;
/** Headers of the supervisor's calls carried to control (never its token). */
const CARRIED = ["content-type", "accept", "git-protocol", "content-encoding"];

/** This rig's keys: made once, then read back (the supervisor's file, mode 0600). */
export function podKeys(path: string): TunnelKeys {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as TunnelKeys;
  const keys = generateTunnelKeys();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  return keys;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(undefined));
  });
}

export class PodTunnel {
  private readonly o: PodTunnelOptions;
  private readonly keys: TunnelKeys;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly nonces = new Map<string, number>();
  private readonly waiting = new Map<string, Waiting>();
  private holders: (() => void)[] = [];
  private second = { at: 0, n: 0 };
  /** Requests refused at the public port since the last exchange (reported to control). */
  private refused = 0;
  private servers: Server[] = [];

  constructor(o: PodTunnelOptions) {
    this.o = o;
    this.keys = podKeys(o.keysPath);
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
  }

  publicKeys(): { sign: string; box: string } {
    return { sign: this.keys.signPublicPem, box: this.keys.boxPublicPem };
  }

  async start(): Promise<void> {
    const pub = createServer((req, res) => {
      void this.onPublic(req, res);
    });
    // Small and short: headers in 10 s, the whole request in 60 s, few connections at once.
    pub.headersTimeout = 10_000;
    pub.requestTimeout = 60_000;
    pub.maxHeadersCount = 30;
    pub.maxConnections = 8;
    const local = createServer((req, res) => {
      void this.onLocal(req, res);
    });
    await Promise.all([
      new Promise<void>((r) => pub.listen(this.o.publicPort, "0.0.0.0", r)),
      new Promise<void>((r) => local.listen(this.o.localPort, "127.0.0.1", r)),
    ]);
    this.servers = [pub, local];
    log("supervisor", "tunnel listening", this.ports());
  }

  /** The ports listened on (the ones given, or those the system chose for 0). */
  ports(): { public_port: number; local_port: number } {
    const port = (s?: Server) => {
      const a = s?.address();
      return typeof a === "object" && a ? a.port : 0;
    };
    return { public_port: port(this.servers[0]), local_port: port(this.servers[1]) };
  }

  async stop(): Promise<void> {
    for (const w of this.waiting.values()) w.respond(503, {}, Buffer.from("stopping"));
    this.waiting.clear();
    await Promise.all(this.servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  }

  /** The same empty 404 for everything refused: nothing says why. */
  private nothing(res: ServerResponse): void {
    this.refused++;
    res.writeHead(404, { "content-length": "0" });
    res.end();
  }

  private async onPublic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = this.now();
    if (t - this.second.at >= 1000) this.second = { at: t, n: 0 };
    if (++this.second.n > MAX_PER_SECOND) return this.nothing(res);
    const path = (req.url ?? "").split("?")[0] ?? "";
    const op =
      path === `/${this.o.prefix}/enroll`
        ? "enroll"
        : path === `/${this.o.prefix}/exchange`
          ? "exchange"
          : "";
    // Wrong path or method: refused before the body is read.
    if (!op || req.method !== "POST") {
      req.resume();
      return this.nothing(res);
    }
    const at = Number(req.headers["x-thermite-at"]);
    const nonce = String(req.headers["x-thermite-nonce"] ?? "");
    const signature = String(req.headers["x-thermite-signature"] ?? "");
    if (!Number.isFinite(at) || !/^[0-9a-f]{64}$/.test(nonce) || !signature) {
      req.resume();
      return this.nothing(res);
    }
    const body = await readBody(req, MAX_FROM_CONTROL);
    if (!body) return this.nothing(res);
    const head: RequestHead = { method: "POST", path, rig: this.o.rig, pod: this.o.pod, at, nonce };
    if (Math.abs(t - at) > TUNNEL_SKEW_MS) return this.nothing(res);
    if (!verifyRequest(head, body, signature, this.o.controlSignPublicPem))
      return this.nothing(res);
    // Seen before: a replay. Remembered for longer than a timestamp stays fresh.
    for (const [n, until] of this.nonces) if (until < t) this.nonces.delete(n);
    if (this.nonces.has(nonce) || this.nonces.size > 100_000) return this.nothing(res);
    this.nonces.set(nonce, t + TUNNEL_NONCE_MS);
    try {
      const out = op === "enroll" ? this.enroll(t) : await this.exchange(body);
      if (!out) return this.nothing(res);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(out.length),
        "x-thermite-signature": signAnswer(nonce, 200, out, this.keys.signPrivatePem),
      });
      res.end(out);
    } catch (err) {
      log("supervisor", "tunnel exchange failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.nothing(res);
    }
  }

  /** The rig's public keys, bound to the launch's code. Only while the code is young. */
  private enroll(t: number): Buffer | undefined {
    if (t - this.startedAt > 30 * 60_000) return undefined;
    return Buffer.from(
      JSON.stringify({
        sign: this.keys.signPublicPem,
        box: this.keys.boxPublicPem,
        proof: enrollmentProof(this.o.enrollCode, this.keys.signPublicPem, this.keys.boxPublicPem),
      }),
    );
  }

  /**
   * Control's answers to earlier calls in, the calls waiting now out. With nothing to hand over,
   * it waits for a call (long poll), up to the time control asked for.
   */
  private async exchange(sealed: Buffer): Promise<Buffer> {
    const msg = JSON.parse(open(sealed, this.keys.boxPrivatePem).toString("utf8")) as {
      answers?: { id: string; status: number; headers?: Record<string, string>; body: string }[];
      wait_ms?: number;
    };
    for (const a of msg.answers ?? []) {
      const w = this.waiting.get(a.id);
      if (!w) continue;
      this.waiting.delete(a.id);
      w.respond(a.status, a.headers ?? {}, Buffer.from(a.body, "base64"));
    }
    // A call goes to control once, and again if no answer came for a while (an answer the
    // proxy changed is dropped by control, and that exchange's calls with it).
    const fresh = () =>
      [...this.waiting.values()].filter(
        (w) => !w.offeredAt || this.now() - w.offeredAt > REOFFER_MS,
      );
    const wait = Math.min(Math.max(Number(msg.wait_ms) || 0, 0), MAX_HOLD_MS);
    if (!fresh().length && wait > 0)
      await new Promise<void>((r) => {
        const timer = setTimeout(r, wait);
        this.holders.push(() => {
          clearTimeout(timer);
          r();
        });
      });
    const calls = fresh();
    for (const w of calls) w.offeredAt = this.now();
    const refused = this.refused;
    this.refused = 0;
    return seal(
      Buffer.from(
        JSON.stringify({
          requests: calls.map((w) => ({
            id: w.id,
            method: w.method,
            path: w.path,
            headers: w.headers,
            body: w.body,
          })),
          refused,
        }),
      ),
      this.o.controlBoxPublicPem,
    );
  }

  /** The supervisor's call to control: kept until control's answer comes back. */
  private async onLocal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = String(req.headers.authorization ?? "");
    const path = req.url ?? "";
    if (
      auth !== `Bearer ${this.o.localToken}` ||
      !path.startsWith(`/v1/rigs/${encodeURIComponent(this.o.rig)}/`)
    ) {
      req.resume();
      res.writeHead(401, { "content-length": "0" });
      res.end();
      return;
    }
    if (this.waiting.size >= MAX_WAITING) {
      req.resume();
      res.writeHead(503, { "content-length": "0" });
      res.end();
      return;
    }
    const body = await readBody(req, MAX_LOCAL_CALL);
    if (!body) {
      res.writeHead(413, { "content-length": "0" });
      res.end();
      return;
    }
    const headers: Record<string, string> = {};
    for (const h of CARRIED) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const id = randomBytes(12).toString("hex");
    let done = false;
    const timer = setTimeout(() => {
      this.waiting.delete(id);
      if (!done) {
        done = true;
        res.writeHead(504, { "content-length": "0" });
        res.end();
      }
    }, this.o.callTimeoutMs ?? 120_000);
    this.waiting.set(id, {
      id,
      method: req.method ?? "GET",
      path,
      headers,
      body: body.toString("base64"),
      offeredAt: 0,
      respond: (status, h, b) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        const out: Record<string, string> = { "content-length": String(b.length) };
        if (h["content-type"]) out["content-type"] = h["content-type"];
        res.writeHead(status, out);
        res.end(b);
      },
    });
    // An exchange waiting for work goes now.
    const holders = this.holders;
    this.holders = [];
    for (const wake of holders) wake();
  }
}
