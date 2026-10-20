import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BUILD_HEADERS,
  type BuildInfo,
  buildHeaders,
  buildInfo,
  OLDEST_PROTOCOL,
  PROTOCOL,
} from "../core/version.ts";
import { createHarnessApi } from "../harness/api.ts";
import { RelayError, relayOnce } from "../supervisor/relay.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";
import type { RigVersions } from "./versions.ts";
import { reportingState, rigView } from "./views.ts";

const tokens = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };
const owner = { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" };

interface Listed {
  control: BuildInfo;
  rigs: { id: string; state: string; version: RigVersions }[];
}

/**
 * Control and one rig (harness and supervisor) wired in-process. `supervisor` changes the build
 * headers the supervisor sends: null sends none, as a supervisor from before version checks.
 */
function setup(control?: BuildInfo) {
  const env = makeHarnessEnv("rig-a");
  const harness = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
  const store = new ControlStore(":memory:");
  const api = createControlApi(store, tokens, env.keys.privateKeyPem, {
    staleAfterMs: 180_000,
    ...(control ? { build: control } : {}),
  });
  const rig: { supervisor: Record<string, string> | null | undefined; seen: Headers[] } = {
    supervisor: undefined,
    seen: [],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "harness")
      return harness.request(`${url.pathname}${url.search}`, init as RequestInit);
    const headers = new Headers(init?.headers);
    if (rig.supervisor !== undefined)
      for (const h of Object.values(BUILD_HEADERS)) {
        const v = rig.supervisor?.[h];
        if (v === undefined) headers.delete(h);
        else headers.set(h, v);
      }
    rig.seen.push(headers);
    return api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
  };
  const cfg = {
    rig: "rig-a",
    harnessUrl: "http://harness",
    harnessToken: "sup-token-abcdef",
    controlUrl: "http://control",
    controlToken: tokens.rigs["rig-a"],
    fetchImpl,
  };
  const listed = async () =>
    (await (await api.request("/v1/rigs", { headers: owner })).json()) as Listed;
  const issue = () =>
    api.request("/v1/commands", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ rig: "rig-a", kind: "assign_campaign", payload: env.assignPayload() }),
    });
  const audits = (action: string) =>
    store.listAudit(1000).filter((a) => a.action === action) as { body: unknown }[];
  return { env, store, api, rig, cfg, listed, issue, audits };
}

const hdrs = (b: Partial<BuildInfo>) => ({
  ...(b.version ? { [BUILD_HEADERS.version]: b.version } : {}),
  ...(b.commit ? { [BUILD_HEADERS.commit]: b.commit } : {}),
  ...(b.protocol !== undefined ? { [BUILD_HEADERS.protocol]: String(b.protocol) } : {}),
  ...(b.oldest_protocol !== undefined
    ? { [BUILD_HEADERS.oldest_protocol]: String(b.oldest_protocol) }
    : {}),
});

describe("versions between control and its rigs", () => {
  test("a control update never cuts off a rig on the build before version checks: it reports, takes commands, and shows as unknown", async () => {
    const s = setup();
    // The build before: its supervisor sends no build headers, its harness no build.
    s.rig.supervisor = null;
    s.env.service.build = undefined;
    const issued = await s.issue();
    assert.equal(issued.status, 201);
    const { id } = (await issued.json()) as { id: string };
    let state = await relayOnce(s.cfg, { cursor: 0 });
    state = await relayOnce(s.cfg, state);
    assert.equal(s.store.command(id)?.status, "delivered");
    assert.ok(s.store.events("rig-a", 0, 100).length > 0);
    const r = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(r?.state, "reporting");
    assert.equal(r?.version.state, "unknown");
    assert.equal(r?.version.refused, null);
    assert.equal(r?.version.harness, null);
    assert.equal(r?.version.supervisor, null);
    assert.match(
      String(r?.version.notice),
      /harness and supervisor send no version\. Their images are older than version checks\. Control still works with it\./,
    );
    assert.equal(s.audits("rig_refused").length, 0);
  });

  test("a control one protocol newer still works with rigs on the protocol before it, and marks them behind", async () => {
    const own = buildInfo();
    // The next control, as the rule for PROTOCOL and OLDEST_PROTOCOL makes it.
    const next = {
      version: "99.0.0",
      commit: "abcdef123456",
      protocol: PROTOCOL + 1,
      oldest_protocol: Math.max(OLDEST_PROTOCOL, PROTOCOL),
    };
    const s = setup(next);
    // Every call the supervisor makes to control carries its build.
    const issued = await s.issue();
    const { id } = (await issued.json()) as { id: string };
    let state = await relayOnce(s.cfg, { cursor: 0 });
    state = await relayOnce(s.cfg, state);
    assert.equal(s.store.command(id)?.status, "delivered");
    assert.ok(s.rig.seen.length >= 3);
    for (const h of s.rig.seen) {
      assert.equal(h.get(BUILD_HEADERS.version), own.version);
      assert.equal(h.get(BUILD_HEADERS.protocol), String(own.protocol));
    }
    // The harness's build rides in its signed report.
    const snap = s.env.service.snapshot(0, 1) as { summary: { build?: unknown } };
    assert.deepEqual(snap.summary.build, own);
    const list = await s.listed();
    assert.deepEqual(list.control, next);
    const r = list.rigs.find((x) => x.id === "rig-a");
    assert.equal(r?.version.state, "behind");
    assert.equal(r?.version.refused, null);
    assert.equal(r?.version.harness?.version, own.version);
    assert.equal(r?.version.supervisor?.protocol, own.protocol);
    assert.equal(
      r?.version.notice,
      `This rig runs an older Thermite than control: harness ${own.version}, supervisor ${own.version}. Control runs 99.0.0. Control still works with it. Update the rig's images.`,
    );
    // The rig's own view says the same.
    const view = (await (
      await s.api.request("/v1/rigs/rig-a/view", { headers: owner })
    ).json()) as {
      state: string;
      version: RigVersions;
    };
    assert.equal(view.state, "reporting");
    assert.equal(view.version.state, "behind");
  });

  test("an incompatible rig is refused, with the reason, on its reports and commands, until it runs a build control works with", async () => {
    const control = { version: "0.9.0", commit: null, protocol: 3, oldest_protocol: 2 };
    const s = setup(control);
    s.env.service.ledger.appendEvent("t", "one", null, {});
    s.rig.supervisor = hdrs({ version: "0.1.0", protocol: 1, oldest_protocol: 1 });
    const why =
      "Control cannot work with this rig: its supervisor speaks protocol 1, and control works with protocols 2 to 3. Update the rig's images.";
    // Its report is refused, and so are its commands: none reach the harness.
    await assert.rejects(
      relayOnce({ ...s.cfg, skipCommands: true }, { cursor: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof RelayError);
        assert.match(err.message, /ingest -> 409/);
        assert.ok(err.message.includes("speaks protocol 1"));
        return true;
      },
    );
    const pending = await s.api.request("/v1/rigs/rig-a/commands/pending", {
      headers: { authorization: "Bearer rig-token-abcdef", ...s.rig.supervisor },
    });
    assert.equal(pending.status, 409);
    assert.deepEqual(await pending.json(), { error: why });
    assert.equal(s.store.events("rig-a", 0, 100).length, 0);
    // Listed, though it never reported: offline, refused, and why.
    const r = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(r?.state, "offline");
    assert.equal(r?.version.state, "refused");
    assert.equal(r?.version.refused?.reason, why);
    assert.equal(r?.version.notice, why);
    assert.equal(r?.version.supervisor?.protocol, 1);
    // In the audit log once, not once for each call it makes.
    const refused = s.audits("rig_refused");
    assert.equal(refused.length, 1);
    const body = refused[0]?.body as { reason: string; control: BuildInfo } | undefined;
    assert.equal(body?.reason, why);
    assert.equal(body?.control.protocol, 3);
    // A command for it is refused when issued, and why.
    const issued = await s.issue();
    assert.equal(issued.status, 400);
    assert.deepEqual(await issued.json(), {
      error: `Control sends no commands to rig-a. ${why}`,
    });
    // Its images updated: it reports again, and the refusal ends (in the audit log too).
    s.rig.supervisor = hdrs({ version: "0.9.0", protocol: 3, oldest_protocol: 2 });
    s.env.service.build = { version: "0.9.0", commit: null, protocol: 3, oldest_protocol: 2 };
    await relayOnce(s.cfg, { cursor: 0 });
    assert.ok(s.store.events("rig-a", 0, 100).length > 0);
    const after = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(after?.version.state, "current");
    assert.equal(after?.version.refused, null);
    assert.equal(after?.version.notice, null);
    assert.equal(s.audits("rig_refusal_ended").length, 1);
    assert.equal((await s.issue()).status, 201);
  });

  test("a harness control cannot work with is refused, though its supervisor is fine", async () => {
    const s = setup();
    s.env.service.ledger.appendEvent("t", "one", null, {});
    const own = buildInfo();
    s.env.service.build = { version: "9.0.0", commit: null, protocol: 70, oldest_protocol: 70 };
    const why = `Control cannot work with this rig: its harness works with protocol 70 or later, and control speaks protocol ${own.protocol}. Update control.`;
    await assert.rejects(relayOnce({ ...s.cfg, skipCommands: true }, { cursor: 0 }), RelayError);
    assert.equal(s.store.rigRefusal("rig-a")?.reason, why);
    assert.equal(s.store.rigBuild("rig-a", "harness")?.protocol, 70);
    // Its commands wait on the harness too: the supervisor's own build is not enough.
    const pending = await s.api.request("/v1/rigs/rig-a/commands/pending", {
      headers: { authorization: "Bearer rig-token-abcdef", ...buildHeaders() },
    });
    assert.equal(pending.status, 409);
    s.env.service.build = own;
    await relayOnce(s.cfg, { cursor: 0 });
    assert.equal(s.store.rigRefusal("rig-a"), undefined);
    assert.ok(s.store.events("rig-a", 0, 100).length > 0);
  });

  test("a protocol control does not know is never a reason to refuse", async () => {
    const s = setup();
    // A newer supervisor that does not say how old a control it works with, and a harness that
    // sends a malformed protocol.
    s.rig.supervisor = hdrs({ version: "5.0.0", protocol: 9 });
    s.env.service.build = {
      version: "5.0.0",
      commit: null,
      protocol: "nine" as unknown as number,
      oldest_protocol: 0,
    };
    await relayOnce(s.cfg, { cursor: 0 });
    const r = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(r?.version.refused, null);
    assert.equal(r?.version.state, "ahead");
    assert.equal(r?.version.harness?.protocol, null);
    assert.match(String(r?.version.notice), /a newer Thermite than control.*Update control\./);
  });

  test("a new control checks refused rigs again: one it can work with is no longer refused", () => {
    const store = new ControlStore(":memory:");
    const env = makeHarnessEnv("rig-a");
    store.setRigBuild("rig-a", "supervisor", {
      version: "0.1.0",
      commit: null,
      protocol: 1,
      oldest_protocol: 1,
    });
    store.setRigRefusal("rig-a", "an older control's reason");
    createControlApi(store, tokens, env.keys.privateKeyPem, {
      staleAfterMs: 180_000,
      build: { version: "0.2.0", commit: null, protocol: 2, oldest_protocol: 1 },
    });
    assert.equal(store.rigRefusal("rig-a"), undefined);
    assert.equal(store.listAudit(100).filter((a) => a.action === "rig_refusal_ended").length, 1);
  });

  test("a rig that stops reporting is stale, then offline; one that never reported is offline", async () => {
    const at = Date.parse("2026-10-20T12:00:00Z");
    const opts = { staleAfterMs: 180_000, offlineAfterMs: 900_000 };
    const seen = (ago: number) => new Date(at - ago).toISOString();
    assert.equal(reportingState(seen(60_000), { ...opts, now: at }), "reporting");
    assert.equal(reportingState(seen(181_000), { ...opts, now: at }), "stale");
    assert.equal(reportingState(seen(900_000), { ...opts, now: at }), "stale");
    assert.equal(reportingState(seen(901_000), { ...opts, now: at }), "offline");
    assert.equal(reportingState(new Date(0).toISOString(), { ...opts, now: at }), "offline");
    // Never offline before it is stale, and the default offline time is 15 minutes.
    assert.equal(
      reportingState(seen(200_000), { staleAfterMs: 300_000, offlineAfterMs: 60_000, now: at }),
      "reporting",
    );
    assert.equal(reportingState(seen(899_000), { staleAfterMs: 180_000, now: at }), "stale");
    assert.equal(reportingState(seen(901_000), { staleAfterMs: 180_000, now: at }), "offline");
    // The rig view says it, with stale kept for both.
    const s = setup();
    await relayOnce(s.cfg, { cursor: 0 });
    const last = Date.parse(String(s.store.rigs()[0]?.last_seen));
    const view = (now: number) => rigView(s.store, "rig-a", { ...opts, now });
    assert.deepEqual([view(last)?.state, view(last)?.stale], ["reporting", false]);
    assert.deepEqual([view(last + 200_000)?.state, view(last + 200_000)?.stale], ["stale", true]);
    assert.deepEqual(
      [view(last + 1_000_000)?.state, view(last + 1_000_000)?.stale],
      ["offline", true],
    );
  });

  test("MCP's list_rigs shows each rig's state and versions", async () => {
    const s = setup({
      version: "99.0.0",
      commit: null,
      protocol: PROTOCOL,
      oldest_protocol: OLDEST_PROTOCOL,
    });
    await relayOnce(s.cfg, { cursor: 0 });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://control/mcp"), {
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${tokens.admin}`);
          return s.api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
        },
      }),
    );
    assert.equal(client.getServerVersion()?.version, "99.0.0");
    const r = await client.callTool({ name: "list_rigs", arguments: {} });
    const rigs = JSON.parse((r.content as { text: string }[])[0]?.text ?? "") as {
      rig: string;
      state: string;
      stale: boolean;
      version: RigVersions;
    }[];
    assert.equal(rigs[0]?.rig, "rig-a");
    assert.equal(rigs[0]?.state, "reporting");
    assert.equal(rigs[0]?.version.state, "behind");
    assert.equal(rigs[0]?.version.control.version, "99.0.0");
    assert.match(String(rigs[0]?.version.notice), /Update the rig's images\./);
    await client.close();
  });
});
