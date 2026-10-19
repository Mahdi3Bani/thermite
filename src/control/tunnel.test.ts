import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { newNonce, type RequestHead, signRequest } from "../core/tunnel.ts";
import { PodTunnel } from "../supervisor/tunnel-pod.ts";
import { createControlApi } from "./api.ts";
import { issueCommand } from "./issue.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";
import { ControlTunnels, tunnelRouteAllowed } from "./tunnel.ts";

const MARKER = "a-made-up-secret-marker-0001";
const LOCAL = "local-token-of-the-supervisor-0001";

/**
 * Control, a pod's end of the tunnel on local ports, and between them a "proxy" that records
 * every byte and can change answers, as RunPod's proxy could.
 */
async function setup(o: { now?: () => number } = {}) {
  const store = new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  const control = generateSigningKeys();
  const api = createControlApi(
    store,
    { admin: "admin-token-abcdef", rigs: {} },
    control.privateKeyPem,
    {
      staleAfterMs: 180_000,
      secrets,
    },
  );
  const wire: Buffer[] = [];
  let tamper = false;
  let last: { url: string; init: RequestInit } | undefined;
  const proxy: typeof fetch = async (input, init) => {
    last = { url: String(input), init: { ...init, signal: undefined } as RequestInit };
    if (init?.body) wire.push(Buffer.from(init.body as Uint8Array));
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      wire.push(Buffer.from(`${k}: ${v}`));
    const res = await fetch(input, init);
    const body = Buffer.from(await res.arrayBuffer());
    wire.push(body);
    if (tamper && body.length) body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 1;
    return new Response(body.length ? new Uint8Array(body) : null, {
      status: res.status,
      headers: res.headers,
    });
  };
  const tunnels = new ControlTunnels(
    store,
    secrets,
    control.privateKeyPem,
    async (rig, call) =>
      api.request(
        call.path,
        {
          method: call.method,
          headers: call.headers,
          ...(call.method === "GET" ? {} : { body: new Uint8Array(call.body) }),
        },
        { tunnelRig: rig },
      ),
    { fetch: proxy, ...(o.now ? { now: o.now } : {}) },
  );
  // The pod's address is known only once it listens: record the rig, then start the pod.
  const pod = { tunnel: undefined as unknown as PodTunnel, url: "" };
  const launch = tunnels.create("rp-1", "pod1", "http://127.0.0.1:1", "owner:ui");
  pod.tunnel = new PodTunnel({
    rig: "rp-1",
    pod: "pod1",
    prefix: launch.THERMITE_TUNNEL_PREFIX,
    controlSignPublicPem: control.publicKeyPem,
    controlBoxPublicPem: launch.THERMITE_TUNNEL_CONTROL_BOX,
    enrollCode: launch.THERMITE_TUNNEL_ENROLL_CODE,
    keysPath: join(mkdtempSync(join(tmpdir(), "thermite-tunnel-")), "keys.json"),
    publicPort: 0,
    localPort: 0,
    localToken: LOCAL,
    callTimeoutMs: 10_000,
  });
  await pod.tunnel.start();
  const { public_port, local_port } = pod.tunnel.ports();
  pod.url = `http://127.0.0.1:${public_port}`;
  store.db.prepare("update tunnel_rig set url = ? where rig = ?").run(pod.url, "rp-1");
  /** The supervisor's own call to control, through its local port. */
  const call = (path: string, init: RequestInit = {}, token = LOCAL) =>
    fetch(`http://127.0.0.1:${local_port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...((init.headers as object) ?? {}) },
    });
  return {
    store,
    api,
    control,
    tunnels,
    pod,
    launch,
    call,
    wire,
    setTamper: (v: boolean) => {
      tamper = v;
    },
    /** The last request control sent through the proxy, sent again as the proxy could. */
    replayLast: () => fetch(last?.url ?? "", last?.init),
  };
}

describe("the tunnel to a rig behind a proxy", () => {
  test("only the paths a rig may use, only for itself", () => {
    for (const [m, p] of [
      ["POST", "/v1/rigs/rp-1/ingest"],
      ["GET", "/v1/rigs/rp-1/commands/pending"],
      ["POST", "/v1/rigs/rp-1/commands/c-1/ack"],
      ["GET", "/v1/rigs/rp-1/model-route"],
      ["GET", "/v1/rigs/rp-1/git-access/deploy"],
      ["GET", "/v1/rigs/rp-1/git/kits/smoke.git/info/refs"],
    ])
      assert.ok(tunnelRouteAllowed("rp-1", m as string, p as string), `${m} ${p}`);
    for (const [m, p] of [
      ["GET", "/v1/rigs/rp-2/commands/pending"],
      ["POST", "/v1/rigs/rp-1/retire"],
      ["POST", "/v1/rigs/rp-1/token"],
      ["GET", "/v1/rigs/rp-1/events"],
      ["GET", "/v1/rigs/rp-1/view"],
      ["GET", "/v1/rigs"],
      ["POST", "/v1/commands"],
      ["GET", "/v1/rigs/rp-1/git/kits/../../secrets"],
      ["DELETE", "/v1/rigs/rp-1/ingest"],
      ["POST", "/v1/rigs/rp-1/model-route"],
    ])
      assert.ok(!tunnelRouteAllowed("rp-1", m as string, p as string), `${m} ${p}`);
  });

  test("enrolls once, carries the supervisor's calls both ways sealed, and never shows a secret on the wire", async () => {
    const s = await setup();
    try {
      assert.equal(await s.tunnels.step("rp-1"), "enrolled");
      assert.ok(s.store.tunnelRig("rp-1")?.enrolled_at);
      assert.equal(s.store.pinTunnelRig("rp-1", "x", "y"), false, "a second enrollment");
      issueCommand(s.store, s.control.privateKeyPem, {
        rig: "rp-1",
        kind: "pause_run",
        payload: { run: "r-1", reason: MARKER },
        issuedBy: "owner:ui",
      });
      // The supervisor asks for its commands; control collects the call, answers, delivers.
      const pending = s.call("/v1/rigs/rp-1/commands/pending");
      await new Promise((r) => setTimeout(r, 50));
      assert.match(await s.tunnels.step("rp-1"), /1 call\(s\) collected/);
      assert.match(await s.tunnels.step("rp-1"), /1 answer\(s\) delivered/);
      const res = await pending;
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        commands: { envelope: { payload: { reason: string } } }[];
      };
      assert.equal(body.commands[0]?.envelope.payload.reason, MARKER);
      // What crossed the proxy: no marker, no local token, no plain JSON of the answer.
      const all = Buffer.concat(s.wire).toString("latin1");
      assert.ok(!all.includes(MARKER), "the command crossed the proxy sealed");
      assert.ok(!all.includes(LOCAL), "the supervisor's token never leaves the pod");
      assert.ok(!all.includes('"commands"'));
      assert.ok(!all.includes(s.launch.THERMITE_TUNNEL_ENROLL_CODE), "the code never crosses");
    } finally {
      await s.pod.tunnel.stop();
    }
  });

  test("everyone but control gets the same empty 404, and nothing changes; refusals are counted", async () => {
    const s = await setup();
    try {
      assert.equal(await s.tunnels.step("rp-1"), "enrolled");
      const prefix = s.launch.THERMITE_TUNNEL_PREFIX;
      const other = generateSigningKeys();
      const signed = (
        h: Partial<RequestHead>,
        key = s.control.privateKeyPem,
        path = `/${prefix}/exchange`,
      ) => {
        const head: RequestHead = {
          method: "POST",
          path,
          rig: "rp-1",
          pod: "pod1",
          at: Date.now(),
          nonce: newNonce(),
          ...h,
        };
        const body = Buffer.from("{}");
        return {
          head,
          init: {
            method: "POST",
            headers: {
              "x-thermite-at": String(head.at),
              "x-thermite-nonce": head.nonce,
              "x-thermite-signature": signRequest(head, body, key),
            },
            body,
          } as RequestInit,
        };
      };
      const tries: [string, string, RequestInit][] = [
        ["no signature", `/${prefix}/exchange`, { method: "POST", body: "{}" }],
        ["a wrong path", "/exchange", signed({}).init],
        ["a GET", `/${prefix}/exchange`, { method: "GET" }],
        ["signed by another key", `/${prefix}/exchange`, signed({}, other.privateKeyPem).init],
        ["stale", `/${prefix}/exchange`, signed({ at: Date.now() - 5 * 60_000 }).init],
        ["from the future", `/${prefix}/exchange`, signed({ at: Date.now() + 5 * 60_000 }).init],
        ["for another rig", `/${prefix}/exchange`, signed({ rig: "rp-2" }).init],
        ["for another pod", `/${prefix}/exchange`, signed({ pod: "pod2" }).init],
        ["the root", "/", { method: "GET" }],
      ];
      for (const [what, path, init] of tries) {
        const r = await fetch(`${s.pod.url}${path}`, init);
        assert.equal(r.status, 404, what);
        assert.equal((await r.arrayBuffer()).byteLength, 0, `${what}: no body`);
      }
      // Signed by control but not sealed to the pod: refused too.
      assert.equal((await fetch(`${s.pod.url}/${prefix}/exchange`, signed({}).init)).status, 404);
      // A real exchange works, and reports the refusals; sent again by the proxy, it is refused.
      assert.match(await s.tunnels.step("rp-1"), /^exchanged/);
      const replay = await s.replayLast();
      assert.equal(replay.status, 404, "a replay of control's own request");
      assert.equal((await replay.arrayBuffer()).byteLength, 0);
      assert.ok((s.store.tunnelRig("rp-1")?.refused_total ?? 0) >= tries.length);
      assert.ok(
        s.store.listAudit(20).some((a) => a.action === "tunnel_refusals"),
        "refusals reach control's log",
      );
    } finally {
      await s.pod.tunnel.stop();
    }
  });

  test("a changed answer is dropped and its answers go again; a forbidden call is not found; the local port takes only the supervisor", async () => {
    const s = await setup();
    try {
      assert.equal(await s.tunnels.step("rp-1"), "enrolled");
      const retire = s.call("/v1/rigs/rp-1/retire", { method: "POST", body: "{}" });
      await new Promise((r) => setTimeout(r, 50));
      s.setTamper(true);
      assert.match(await s.tunnels.step("rp-1"), /did not verify/);
      s.setTamper(false);
      // The pod offers the call again after a while; control then takes and answers it.
      await new Promise((r) => setTimeout(r, 5_200));
      assert.match(await s.tunnels.step("rp-1"), /1 call\(s\) collected/);
      await s.tunnels.step("rp-1");
      assert.equal((await retire).status, 404, "control answers no route outside the rig's own");
      assert.equal((await s.call("/v1/rigs/rp-1/model-route", {}, "a-lane-guessing")).status, 401);
      assert.equal((await s.call("/v1/rigs/rp-2/model-route")).status, 401, "another rig's path");
      // From the network, control's rig routes still need a token: the tunnel's binding is
      // only for in-process calls.
      assert.equal((await s.api.request("/v1/rigs/rp-1/commands/pending")).status, 401);
    } finally {
      await s.pod.tunnel.stop();
    }
  });

  test("an enrollment code expires", async () => {
    let now = Date.now();
    const s = await setup({ now: () => now });
    try {
      now += 31 * 60_000;
      assert.match(await s.tunnels.step("rp-1"), /enrollment code expired/);
      assert.equal(s.store.tunnelRig("rp-1")?.enrolled_at, null);
    } finally {
      await s.pod.tunnel.stop();
    }
  });
});
