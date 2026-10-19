import { randomBytes } from "node:crypto";
import { log, redact } from "../common/env.ts";
import {
  enrollmentProof,
  generateTunnelKeys,
  newNonce,
  open,
  type RequestHead,
  sameHex,
  seal,
  signRequest,
  verifyAnswer,
} from "../core/tunnel.ts";
import type { SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store.ts";

/**
 * Control's end of the tunnel to a rig it reaches through a public proxy (a RunPod pod:
 * docs/plan/goals/019-rig-only-entry.goal, and src/supervisor/tunnel-pod.ts for the rig's end).
 *
 * Control enrolls the pod once (it pins the keys the pod made, bound to the launch's one-time
 * code), then exchanges with it: each exchange returns the answers to the rig's earlier calls and
 * collects the calls waiting now. Control answers each call itself, as that rig, and only on the
 * routes a rig may use. Every request is signed; every answer must verify against the pinned key
 * and is sealed to this rig's key at control.
 */

/** A call the rig made to control, carried through the tunnel. */
export interface TunnelCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Answers a rig's call in-process, as that rig (createControlApi gives it). */
export type TunnelDispatch = (rig: string, call: TunnelCall) => Promise<Response>;

/** The routes a rig may use, and only for itself. Anything else is not found. */
export function tunnelRouteAllowed(rig: string, method: string, path: string): boolean {
  const base = `/v1/rigs/${encodeURIComponent(rig)}/`;
  if (!path.startsWith(base)) return false;
  const rest = (path.slice(base.length).split("?")[0] ?? "").replace(/\/+$/, "");
  if (rest.includes("..") || rest.includes("//")) return false;
  const get = method === "GET";
  const post = method === "POST";
  return (
    (post && ["ingest", "supervisor", "live", "reports"].includes(rest)) ||
    (get && ["commands/pending", "model-route", "advisor-routes"].includes(rest)) ||
    (post && /^commands\/[A-Za-z0-9._-]+\/ack$/.test(rest)) ||
    (get && /^git-access\/[A-Za-z0-9._-]+$/.test(rest)) ||
    (get && /^git\/kits\/[A-Za-z0-9._-]+\.git\/[A-Za-z0-9._/-]+$/.test(rest))
  );
}

/** What a pod launched as a tunnel rig gets in its environment: public material and the code. */
export interface TunnelLaunch {
  THERMITE_TUNNEL_PREFIX: string;
  THERMITE_TUNNEL_CONTROL_BOX: string;
  THERMITE_TUNNEL_ENROLL_CODE: string;
}

interface Answer {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class ControlTunnels {
  private readonly store: ControlStore;
  private readonly secrets: SecretBox;
  private readonly signPrivatePem: string;
  private readonly dispatch: TunnelDispatch;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Answers waiting to go back to each rig in its next exchange. */
  private readonly pending = new Map<string, Answer[]>();
  private readonly running = new Set<string>();
  /** Calls each rig has offered that control has taken: one offered again is not run twice. */
  private readonly taken = new Map<string, Set<string>>();

  constructor(
    store: ControlStore,
    secrets: SecretBox,
    signPrivatePem: string,
    dispatch: TunnelDispatch,
    opts: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.store = store;
    this.secrets = secrets;
    this.signPrivatePem = signPrivatePem;
    this.dispatch = dispatch;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Records a rig control will reach at `url`, and what its pod must be launched with. */
  create(rig: string, pod: string, url: string, by: string): TunnelLaunch {
    const keys = generateTunnelKeys();
    const prefix = randomBytes(32).toString("hex");
    const code = randomBytes(32).toString("hex");
    this.store.addTunnelRig({
      rig,
      pod,
      url: url.replace(/\/$/, ""),
      prefix_sealed: this.secrets.seal(prefix),
      box_private_sealed: this.secrets.seal(keys.boxPrivatePem),
      box_public: keys.boxPublicPem,
      code_sealed: this.secrets.seal(code),
      code_expires_at: new Date(this.now() + 30 * 60_000).toISOString(),
      created_by: by,
    });
    return {
      THERMITE_TUNNEL_PREFIX: prefix,
      THERMITE_TUNNEL_CONTROL_BOX: keys.boxPublicPem,
      THERMITE_TUNNEL_ENROLL_CODE: code,
    };
  }

  private async post(
    rig: string,
    pod: string,
    url: string,
    path: string,
    body: Buffer,
  ): Promise<{ nonce: string; status: number; body: Buffer; signature: string }> {
    const head: RequestHead = { method: "POST", path, rig, pod, at: this.now(), nonce: newNonce() };
    const res = await this.fetchImpl(`${url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-thermite-at": String(head.at),
        "x-thermite-nonce": head.nonce,
        "x-thermite-signature": signRequest(head, body, this.signPrivatePem),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(60_000),
    });
    return {
      nonce: head.nonce,
      status: res.status,
      body: Buffer.from(await res.arrayBuffer()),
      signature: res.headers.get("x-thermite-signature") ?? "",
    };
  }

  /**
   * One step for a rig: enrollment until its keys are pinned, then one exchange. Returns what
   * happened, in words; errors are kept on the rig's record and in control's log.
   */
  async step(rig: string, waitMs = 0): Promise<string> {
    const t = this.store.tunnelRig(rig);
    if (!t) return `no tunnel rig ${rig}`;
    const prefix = this.secrets.open(t.prefix_sealed);
    const fail = (why: string) => {
      const error = redact(why);
      this.store.tunnelExchanged(rig, { error });
      log("control", "tunnel", { rig, error });
      return error;
    };
    try {
      if (!t.enrolled_at) {
        if (Date.parse(t.code_expires_at) < this.now())
          return fail("its enrollment code expired before the pod answered: launch it again");
        const r = await this.post(rig, t.pod, t.url, `/${prefix}/enroll`, Buffer.alloc(0));
        if (r.status !== 200) return fail(`the pod did not enroll (answer ${r.status})`);
        const keys = JSON.parse(r.body.toString("utf8")) as {
          sign: string;
          box: string;
          proof: string;
        };
        const code = this.secrets.open(t.code_sealed);
        if (!sameHex(keys.proof, enrollmentProof(code, keys.sign, keys.box)))
          return fail("the pod's keys are not bound to its launch code: not enrolled");
        if (!verifyAnswer(r.nonce, 200, r.body, r.signature, keys.sign))
          return fail("the pod's enrollment answer is not signed by its key: not enrolled");
        if (!this.store.pinTunnelRig(rig, keys.sign, keys.box))
          return fail("it was enrolled already: a second enrollment is refused");
        return "enrolled";
      }
      const answers = this.pending.get(rig) ?? [];
      this.pending.set(rig, []);
      const out = seal(
        Buffer.from(JSON.stringify({ answers, wait_ms: waitMs })),
        t.pod_box_public as string,
      );
      let r: Awaited<ReturnType<ControlTunnels["post"]>>;
      try {
        r = await this.post(rig, t.pod, t.url, `/${prefix}/exchange`, out);
      } catch (err) {
        // Not delivered: the answers go again next time.
        this.pending.set(rig, [...answers, ...(this.pending.get(rig) ?? [])]);
        throw err;
      }
      if (
        r.status !== 200 ||
        !verifyAnswer(r.nonce, 200, r.body, r.signature, t.pod_sign_public as string)
      ) {
        this.pending.set(rig, [...answers, ...(this.pending.get(rig) ?? [])]);
        return fail(`the pod's answer did not verify (status ${r.status}): dropped`);
      }
      const msg = JSON.parse(
        open(r.body, this.secrets.open(t.box_private_sealed)).toString("utf8"),
      ) as {
        requests?: {
          id: string;
          method: string;
          path: string;
          headers?: Record<string, string>;
          body: string;
        }[];
        refused?: number;
      };
      // Delivered: those calls are answered at the pod and won't come again.
      const taken = this.taken.get(rig) ?? new Set<string>();
      this.taken.set(rig, taken);
      for (const a of answers) taken.delete(a.id);
      const calls = (msg.requests ?? []).filter((c) => !taken.has(c.id));
      for (const c of calls) taken.add(c.id);
      const done = await Promise.all(
        calls.map(async (c): Promise<Answer> => {
          if (!tunnelRouteAllowed(rig, c.method, c.path))
            return { id: c.id, status: 404, headers: {}, body: "" };
          const res = await this.dispatch(rig, {
            method: c.method,
            path: c.path,
            headers: c.headers ?? {},
            body: Buffer.from(c.body, "base64"),
          });
          const body = Buffer.from(await res.arrayBuffer());
          const ct = res.headers.get("content-type");
          return {
            id: c.id,
            status: res.status,
            headers: ct ? { "content-type": ct } : {},
            body: body.toString("base64"),
          };
        }),
      );
      this.pending.set(rig, [...(this.pending.get(rig) ?? []), ...done]);
      this.store.tunnelExchanged(rig, { refused: Number(msg.refused) || 0, error: null });
      return `exchanged: ${answers.length} answer(s) delivered, ${calls.length} call(s) collected`;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Keeps every tunnel rig going: control's loop calls this; one exchange per rig at a time. */
  async advance(waitMs = 20_000): Promise<void> {
    await Promise.all(
      this.store.tunnelRigs().map(async (t) => {
        if (this.running.has(t.rig)) return;
        this.running.add(t.rig);
        try {
          // Answers waiting go at once; otherwise the pod holds the exchange until a call comes.
          const has = (this.pending.get(t.rig) ?? []).length > 0;
          await this.step(t.rig, has || !t.enrolled_at ? 0 : waitMs);
        } finally {
          this.running.delete(t.rig);
        }
      }),
    );
  }
}
