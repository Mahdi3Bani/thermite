import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHarnessApi } from "../harness/api.ts";
import { relayLiveOnce, supervisorLive } from "../supervisor/live.ts";
import { relayOnce } from "../supervisor/relay.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";

const tokens = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };

function setup() {
  const env = makeHarnessEnv("rig-a");
  const harness = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
  const store = new ControlStore(":memory:");
  const control = createControlApi(store, tokens, env.keys.privateKeyPem);
  let tamper: ((body: string) => string) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const app = url.host === "harness" ? harness : control;
    const body =
      tamper && url.pathname.endsWith("/live") && init?.body
        ? tamper(String(init.body))
        : init?.body;
    return app.request(`${url.pathname}${url.search}`, {
      ...(init as RequestInit),
      body,
    } as RequestInit);
  };
  const cfg = {
    rig: "rig-a",
    harnessUrl: "http://harness",
    harnessToken: "sup-token-abcdef",
    controlUrl: "http://control",
    controlToken: tokens.rigs["rig-a"],
    fetchImpl,
  };
  return { env, store, control, cfg, setTamper: (t: typeof tamper) => (tamper = t) };
}

describe("the live view", () => {
  test("the harness's lines reach control signed; the supervisor's are kept as unsigned; a tampered batch is refused", async () => {
    const s = setup();
    // The rig's key is pinned by its first report.
    await relayOnce(s.cfg, { cursor: 0 });
    s.env.service.live.append({ source: "planner", kind: "status", text: "planning epoch 1" });
    s.env.service.live.append({ source: "judge", kind: "log", text: "evaluate a-1: started" });
    supervisorLive.append({ source: "supervisor", kind: "status", text: "advisor round started" });
    const st = await relayLiveOnce(s.cfg, { cursor: 0, ownCursor: 0 });
    assert.equal(st.cursor, 2);
    const r = await s.control.request("/v1/rigs/rig-a/live", {
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    const body = (await r.json()) as {
      entries: { source: string; text: string; signed: boolean }[];
      sources: { source: string }[];
    };
    assert.deepEqual(
      body.entries.map((e) => [e.source, e.signed]),
      [
        ["planner", true],
        ["judge", true],
        ["supervisor", false],
      ],
    );
    assert.equal(body.sources.length, 3);
    // Nothing new: nothing sent. Then a line the supervisor alters in transit is refused.
    assert.deepEqual(await relayLiveOnce(s.cfg, st), st);
    s.env.service.live.append({ source: "planner", kind: "text", text: "lane-1: tiling" });
    s.setTamper((b) => b.replace("lane-1: tiling", "lane-1: something else"));
    await assert.rejects(relayLiveOnce(s.cfg, st), /403/);
    s.setTamper(undefined);
    await relayLiveOnce(s.cfg, st);
    assert.equal(s.store.liveTail("rig-a", 10).at(-1)?.text, "lane-1: tiling");
  });

  test("before the rig's key is accepted, live lines are refused", async () => {
    const s = setup();
    s.env.service.live.append({ source: "judge", kind: "log", text: "x" });
    await assert.rejects(relayLiveOnce(s.cfg, { cursor: 0, ownCursor: 0 }), /409/);
  });
});

describe("the owner's messages to agents", () => {
  test("a message to a lane reaches its trial once; the planner's waits for the next plan; agents cannot send one", async () => {
    const s = setup();
    const issue = (body: unknown, token = tokens.admin) =>
      s.control.request("/v1/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const assigned = await issue({
      rig: "rig-a",
      kind: "assign_campaign",
      payload: s.env.assignPayload(),
    });
    assert.equal(assigned.status, 201);
    await relayOnce(s.cfg, { cursor: 0 });
    const toLane = await issue({
      rig: "rig-a",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "lane-1", text: "try the tiled kernel first" },
    });
    const toPlanner = await issue({
      rig: "rig-a",
      kind: "message_agent",
      payload: { run: "smoke-1", to: "planner", text: "spread the lanes wider" },
    });
    assert.equal(toLane.status, 201);
    assert.equal(toPlanner.status, 201);
    await relayOnce(s.cfg, { cursor: 0 });
    const svc = s.env.service;
    assert.deepEqual(
      svc.takeMessages({ id: "t-0123456789abcdef", run: "smoke-1", lane: "lane-2" }),
      [],
    );
    assert.deepEqual(
      svc.takeMessages({ id: "t-0123456789abcdef", run: "smoke-1", lane: "lane-1" }),
      ["try the tiled kernel first"],
    );
    assert.deepEqual(
      svc.takeMessages({ id: "t-0123456789abcdef", run: "smoke-1", lane: "lane-1" }),
      [],
    );
    assert.deepEqual(svc.takePlannerMessages("smoke-1"), ["spread the lanes wider"]);
    assert.deepEqual(svc.takePlannerMessages("smoke-1"), []);
    // The owner's message shows in the live view.
    assert.ok(
      svc.live
        .since(0)
        .entries.some((e) => e.kind === "message" && e.text.includes("tiled kernel")),
    );
    // Owner only: the same command signed as an agent's is refused by the harness.
    const r = await svc.applyCommand(
      s.env.sign(
        "message_agent",
        { run: "smoke-1", to: "planner", text: "x" },
        { issuedBy: "agent:mcp" },
      ),
    );
    assert.ok(r.status === "applied" && !r.accepted, JSON.stringify(r));
  });
});
