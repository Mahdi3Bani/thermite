import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { ControlStore } from "../control/store.ts";
import { rigView } from "../control/views.ts";
import type { CommandKind } from "../core/commands.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { Registry } from "./agents/registry.ts";
import { createHarnessApi } from "./api.ts";
import type { LedgerEvent } from "./ledger.ts";

const RUN = "smoke-1";
const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

async function setup(over: Record<string, unknown> = {}) {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload(over)));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  /** A command as control signs it; the owner's by default. */
  const command = async (kind: CommandKind, payload: unknown, issuedBy = "owner:ui") => {
    const r = await env.service.applyCommand(env.sign(kind, payload, { issuedBy }));
    assert.equal(r.status, "applied", JSON.stringify(r));
    return r as { accepted: boolean; result: Record<string, unknown> };
  };
  const events = (kind?: string): LedgerEvent[] =>
    env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => !kind || e.kind === kind);
  return { env, q: env.service.queue, command, events };
}

/** The run's queue as control builds it from the rig's events (src/control/views.ts). */
function controlQueue(events: LedgerEvent[]) {
  const store = new ControlStore(":memory:");
  store.ingest({
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: events.at(-1)?.id ?? 0,
    generated_at: new Date().toISOString(),
    events,
    summary: {},
  });
  const u = rigView(store, "rig-a", { staleAfterMs: 600_000 });
  const r = u?.runs.find((x) => x.id === RUN);
  assert.ok(r, "control sees the run");
  return r;
}

/** Up next as the harness orders it, and as control does, by id. */
function bothOrders(s: Awaited<ReturnType<typeof setup>>) {
  const harness = s.q.queued(RUN).map((x) => x.id);
  const control = controlQueue(s.events())
    .queue.filter((x) => x.state === "queued")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((x) => x.id);
  return { harness, control };
}

describe("the experiment queue", () => {
  test("every change is its row and one event, and control's view of the events is the table", async () => {
    const s = await setup();
    const { q } = s;
    const a = q.add(
      RUN,
      { title: "fuse the loads", family: "Memory layout", by: "owner", why: "it won on big" },
      "control:owner:ui",
    );
    const b = q.add(
      RUN,
      { title: "unroll by 4", family: "unroll", by: "planner", position: "top" },
      "planner",
    );
    const c = q.add(
      RUN,
      { title: "warp shuffle", by: "teacher", position: 1 },
      "supervisor:teacher",
    );
    const idea = q.add(
      RUN,
      { title: "test at 3 sizes", by: "lane-2", state: "proposed", trial: "t-1" },
      "lane-2",
    );
    assert.deepEqual(
      q.queued(RUN).map((x) => [x.title, x.place]),
      [
        ["unroll by 4", 0],
        ["warp shuffle", 1],
        ["fuse the loads", 2],
      ],
    );
    assert.equal(idea.place, null, "a proposed idea has no place yet");
    q.accept(RUN, idea.id, { by: "owner", position: "top" }, "control:owner:ui");
    q.move(RUN, a.id, { by: "planner", position: 0, why: "it builds on the champion" }, "planner");
    q.edit(
      RUN,
      c.id,
      { title: "warp shuffle reduce", why: "fewer syncs" },
      { by: "owner" },
      "control:owner:ui",
    );
    q.drop(RUN, b.id, { by: "planner", why: "an AVOID rule names unroll" }, "planner");
    q.assign(RUN, idea.id, { lane: "lane-1", trial: "t-9", by: "planner", why: "next" }, "planner");
    q.finish("t-9", { result: "no_attempt" }, "scheduler");
    assert.deepEqual(
      q.queued(RUN).map((x) => [x.title, x.place]),
      [
        ["fuse the loads", 0],
        ["warp shuffle reduce", 1],
      ],
    );
    // The events, as the interface control reads them.
    const ev = s.events().filter((e) => e.kind.startsWith("experiment_"));
    assert.deepEqual(
      ev.map((e) => [e.kind, e.actor, e.subject]),
      [
        ["experiment_added", "control:owner:ui", RUN],
        ["experiment_added", "planner", RUN],
        ["experiment_added", "supervisor:teacher", RUN],
        ["experiment_added", "lane-2", RUN],
        ["experiment_accepted", "control:owner:ui", RUN],
        ["experiment_moved", "planner", RUN],
        ["experiment_edited", "control:owner:ui", RUN],
        ["experiment_dropped", "planner", RUN],
        ["experiment_assigned", "planner", RUN],
        ["experiment_finished", "scheduler", RUN],
      ],
    );
    assert.deepEqual(ev[0]?.body, {
      id: a.id,
      title: "fuse the loads",
      family: "Memory layout",
      why: "it won on big",
      by: "owner",
      state: "queued",
    });
    assert.deepEqual(ev[3]?.body, {
      id: idea.id,
      title: "test at 3 sizes",
      by: "lane-2",
      state: "proposed",
      trial: "t-1",
    });
    assert.deepEqual(ev[4]?.body, { id: idea.id, by: "owner", position: "top" });
    assert.deepEqual(ev[5]?.body, {
      id: a.id,
      by: "planner",
      position: 0,
      why: "it builds on the champion",
    });
    assert.deepEqual(ev[6]?.body, {
      id: c.id,
      by: "owner",
      title: "warp shuffle reduce",
      why: "fewer syncs",
    });
    assert.deepEqual(ev[7]?.body, { id: b.id, by: "planner", why: "an AVOID rule names unroll" });
    assert.deepEqual(ev[8]?.body, {
      id: idea.id,
      lane: "lane-1",
      trial: "t-9",
      by: "planner",
      why: "next",
    });
    assert.deepEqual(ev[9]?.body, {
      id: idea.id,
      lane: "lane-1",
      trial: "t-9",
      result: "no_attempt",
    });
    assert.match(String(a.id), /^x-[0-9a-f]{12}$/);
    // Control builds the same queue from these events alone.
    const view = controlQueue(s.events()).queue;
    for (const x of q.all(RUN)) {
      const v = view.find((y) => y.id === x.id);
      assert.ok(v, `control knows ${x.id}`);
      assert.equal(v.state, x.state);
      assert.equal(v.position, x.place, `${x.title}: the same place`);
      assert.equal(v.title, x.title);
      assert.equal(v.by, x.added_by);
    }
    assert.equal(view.find((y) => y.id === b.id)?.dropped_why, "an AVOID rule names unroll");
    assert.equal(view.find((y) => y.id === idea.id)?.result, "no_attempt");
  });

  test("random adds, moves, accepts, drops and assignments keep the harness's order and control's the same", async () => {
    const s = await setup();
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const pos = (): "top" | "end" | number => {
      const k = rnd(3);
      return k === 0 ? "top" : k === 1 ? "end" : rnd(6);
    };
    for (let i = 0; i < 160; i++) {
      const queued = s.q.queued(RUN);
      const proposed = s.q.proposed(RUN);
      const any = <T>(xs: T[]) => xs[rnd(xs.length)];
      const op = rnd(6);
      if (op === 0 || queued.length < 2)
        s.q.add(RUN, { title: `t${i}`, by: "owner", position: pos() }, "control:owner:ui");
      else if (op === 1)
        s.q.add(RUN, { title: `idea ${i}`, by: "lane-1", state: "proposed" }, "lane-1");
      else if (op === 2 && proposed.length)
        s.q.accept(RUN, String(any(proposed)?.id), { by: "planner", position: pos() }, "planner");
      else if (op === 3)
        s.q.move(RUN, String(any(queued)?.id), { by: "owner", position: pos() }, "x");
      else if (op === 4) s.q.drop(RUN, String(any(queued)?.id), { by: "owner", why: "no" }, "x");
      else
        s.q.assign(
          RUN,
          String(any(queued)?.id),
          { lane: "lane-1", trial: `t-${i}`, by: "planner" },
          "planner",
        );
      const o = bothOrders(s);
      assert.deepEqual(o.control, o.harness, `after step ${i}`);
      assert.deepEqual(
        s.q.queued(RUN).map((x) => x.place),
        s.q.queued(RUN).map((_, k) => k),
        "places are 0, 1, 2, …",
      );
    }
  });

  test("an experiment goes to one trial: assigned, done or dropped ones are refused", async () => {
    const { q } = await setup();
    const x = q.add(RUN, { title: "one", by: "owner" }, "o");
    q.assign(RUN, x.id, { lane: "lane-1", trial: "t-1", by: "planner" }, "planner");
    assert.throws(
      () => q.assign(RUN, x.id, { lane: "lane-2", trial: "t-2", by: "planner" }, "planner"),
      /is assigned: it can't be given out/,
    );
    q.finish("t-1", { result: "submitted", attempt: "a-1" }, "s");
    assert.throws(
      () => q.assign(RUN, x.id, { lane: "lane-2", trial: "t-2", by: "planner" }, "planner"),
      /is done/,
    );
    assert.throws(() => q.drop(RUN, x.id, { by: "owner", why: "late" }, "o"), /is done/);
    assert.throws(() => q.move(RUN, x.id, { by: "owner", position: "top" }, "o"), /is done/);
    assert.throws(() => q.require(RUN, "x-000000000000"), /no experiment/);
  });
});

describe("the owner's queue commands", () => {
  test("add, move, edit, drop and accept; each refused in words for an unknown id or the wrong state", async () => {
    const s = await setup();
    const added = await s.command("queue_add", {
      run: RUN,
      title: "vector loads",
      family: "memory",
      why: "reads dominate",
      position: "top",
    });
    assert.ok(added.accepted, JSON.stringify(added));
    const id = String(added.result.experiment);
    assert.equal(added.result.position, 0);
    const second = await s.command("queue_add", { run: RUN, title: "second" });
    assert.equal(second.result.position, 1, "the end by default");
    const moved = await s.command("queue_move", { run: RUN, id, position: "end" });
    assert.equal(moved.result.position, 1);
    const edited = await s.command("queue_edit", { run: RUN, id, details: "use 128-bit loads" });
    assert.ok(edited.accepted);
    assert.equal(s.q.get(id)?.details, "use 128-bit loads");
    const accept = await s.command("queue_accept", { run: RUN, id });
    assert.equal(accept.accepted, false);
    assert.match(String(accept.result.error), /is queued, not a proposed idea/);
    const unknown = await s.command("queue_move", {
      run: RUN,
      id: "x-0123456789ab",
      position: "top",
    });
    assert.equal(unknown.accepted, false);
    assert.match(String(unknown.result.error), /no experiment x-0123456789ab in run smoke-1/);
    const dropped = await s.command("queue_drop", { run: RUN, id, why: "measured flat elsewhere" });
    assert.ok(dropped.accepted);
    const again = await s.command("queue_drop", { run: RUN, id, why: "twice" });
    assert.match(String(again.result.error), /is dropped: only proposed or queued/);
    const idea = s.q.add(RUN, { title: "lane idea", by: "lane-1", state: "proposed" }, "lane-1");
    const ok = await s.command("queue_accept", { run: RUN, id: idea.id, position: "top" });
    assert.equal(ok.result.state, "queued");
    assert.equal(ok.result.position, 0);
    // Every change is the owner's, by the issuer control signed.
    const bodies = s
      .events()
      .filter((e) => e.kind.startsWith("experiment_") && e.actor.startsWith("control:"));
    assert.ok(bodies.every((e) => (e.body as { by: string }).by === "owner"));
    assert.ok(bodies.every((e) => e.actor === "control:owner:ui"));
  });

  test("an operator may change the queue for the owner; an agent's token may not", async () => {
    const s = await setup();
    const op = await s.command(
      "queue_add",
      { run: RUN, title: "from the operator" },
      "owner:operator",
    );
    assert.ok(op.accepted, JSON.stringify(op));
    const agent = await s.command("queue_add", { run: RUN, title: "from an agent" }, "agent");
    assert.equal(agent.accepted, false);
    assert.match(String(agent.result.error), /queue_add is the owner's to issue/);
    const drop = await s.command("drop_directive", { run: RUN, id: 1 }, "agent");
    assert.match(String(drop.result.error), /drop_directive is the owner's to issue/);
    assert.deepEqual(
      s.q.queued(RUN).map((x) => x.title),
      ["from the operator"],
    );
  });

  test("a closed run's queue and rules do not change", async () => {
    const s = await setup();
    s.env.service.ledger.setRunStatus(RUN, "closed", "done", "test");
    const r = await s.command("queue_add", { run: RUN, title: "late" });
    assert.match(String(r.result.error), /run smoke-1 is closed/);
    const d = await s.command("drop_directive", { run: RUN, id: 1 });
    assert.match(String(d.result.error), /run smoke-1 is closed/);
    const redirect = await s.command("redirect", {
      run: RUN,
      directives: [{ kind: "try", family: "unroll", rationale: "late", citations: [] }],
    });
    assert.match(String(redirect.result.error), /run smoke-1 is closed: its queue and rules/);
  });

  test("drop_directive removes a rule in force, whoever set it; a rule names a family or match words", async () => {
    const s = await setup();
    const set = await s.command("redirect", {
      run: RUN,
      directives: [
        {
          kind: "avoid",
          match: "anything that touches the timer",
          rationale: "it is the judge's",
          citations: [],
        },
        { kind: "try", family: "tiling", rationale: "won elsewhere", citations: [] },
      ],
    });
    assert.ok(set.accepted, JSON.stringify(set));
    const supervisorIds = s.env.service.addDirectives(
      RUN,
      [{ kind: "try", family: "unroll", rationale: "r", citations: ["a-1"] }],
      "supervisor",
    );
    const active = () => s.env.service.ledger.activeDirectives(RUN).map((d) => d.id);
    assert.equal(active().length, 3);
    const dropped = await s.command("drop_directive", { run: RUN, id: supervisorIds[0] });
    assert.ok(dropped.accepted, JSON.stringify(dropped));
    assert.equal(active().length, 2);
    const e = s.events("directive_dropped").at(-1);
    assert.deepEqual(e?.body, { id: supervisorIds[0] });
    assert.equal(e?.actor, "control:owner:ui");
    const gone = await s.command("drop_directive", { run: RUN, id: supervisorIds[0] });
    assert.match(String(gone.result.error), /no rule \d+ in force in run smoke-1/);
    // The advisors' next set cannot bring back a rule the owner removed; the owner can.
    const again = s.env.service.addDirectives(
      RUN,
      [
        { kind: "try", family: "unroll", rationale: "r", citations: ["a-2"] },
        { kind: "avoid", family: "gather", rationale: "r", citations: ["a-2"] },
      ],
      "supervisor",
    );
    assert.equal(again.length, 1, "only the new rule");
    assert.deepEqual(s.events("directives_left_out").at(-1)?.body, {
      rules: [{ kind: "try", family: "unroll", rationale: "r", citations: ["a-2"] }],
      why: "the owner removed these rules",
    });
    const owner = await s.command("redirect", {
      run: RUN,
      directives: [{ kind: "try", family: "unroll", rationale: "back", citations: [] }],
      replace: false,
    });
    assert.ok(owner.accepted, JSON.stringify(owner));
    // A rule's direction is a family or match words, never both, and match is for avoid, try or
    // mandate only: control's own check refuses the rest before signing.
    for (const bad of [
      { kind: "avoid", family: "tiling", match: "tiles", rationale: "x" },
      { kind: "priority", match: "tiles", rationale: "x" },
      { kind: "avoid", rationale: "names nothing" },
    ]) {
      const r = await s.env.service.applyCommand(
        s.env.sign("redirect", { run: RUN, directives: [bad] }),
      );
      assert.equal(r.status, "rejected", JSON.stringify(bad));
    }
    // The owner's set both avoiding and asking for the same words is refused.
    const both = await s.command("redirect", {
      run: RUN,
      directives: [
        { kind: "avoid", match: "Vector loads", rationale: "x", citations: [] },
        { kind: "try", match: "vector loads", rationale: "y", citations: [] },
      ],
    });
    assert.match(String(both.result.error), /both avoids and asks for/);
  });

  test("assign_campaign's queue seeds the new run's queue in order, keeping who added each, why, state and where it came from", async () => {
    const seeds = [
      {
        title: "fuse",
        family: "fusion",
        why: "won on long",
        by: "planner",
        state: "queued",
        from: { run: "old-1", id: "x-aaaaaaaaaaaa" },
      },
      {
        title: "lane idea",
        by: "lane-2",
        state: "proposed",
        from: { run: "old-1", id: "x-bbbbbbbbbbbb" },
      },
      {
        title: "owner's",
        details: "d",
        by: "owner",
        state: "queued",
        from: { run: "old-1", id: "x-cccccccccccc" },
      },
    ];
    const s = await setup({ queue: seeds });
    assert.deepEqual(
      s.q.queued(RUN).map((x) => [x.title, x.added_by, x.place, x.from_run, x.from_id]),
      [
        ["fuse", "planner", 0, "old-1", "x-aaaaaaaaaaaa"],
        ["owner's", "owner", 1, "old-1", "x-cccccccccccc"],
      ],
    );
    assert.deepEqual(
      s.q.proposed(RUN).map((x) => [x.title, x.added_by]),
      [["lane idea", "lane-2"]],
    );
    const added = s.events("experiment_added");
    assert.deepEqual(added[0]?.body, {
      id: s.q.queued(RUN)[0]?.id,
      title: "fuse",
      family: "fusion",
      why: "won on long",
      by: "planner",
      state: "queued",
      from_run: "old-1",
      from_id: "x-aaaaaaaaaaaa",
    });
    assert.equal(added[0]?.actor, "control:owner");
    // The run is created before its queue, in one step.
    const kinds = s.events().map((e) => e.kind);
    assert.ok(kinds.indexOf("run_created") < kinds.indexOf("experiment_added"));
    const view = controlQueue(s.events()).queue;
    assert.equal(view.find((x) => x.title === "fuse")?.from_run, "old-1");
  });
});

describe("the advisors' and workers' writes", () => {
  test("the supervisor's route adds and moves with the advisor's role as author; other tokens are refused", async () => {
    const s = await setup();
    const api = createHarnessApi(s.env.service, tokens);
    const first = s.q.add(RUN, { title: "first", by: "owner" }, "o");
    const post = (body: unknown, token = tokens.supervisor) =>
      api.request("/v1/queue", {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify(body),
      });
    const r = await post({
      run: RUN,
      role: "teacher",
      add: [
        {
          title: "vector loads",
          family: "memory",
          why: "the profile says reads dominate",
          position: "top",
        },
      ],
      move: [
        { id: first.id, position: "top", why: "it is cheapest" },
        { id: "x-0123456789ab", position: "top", why: "no such" },
      ],
    });
    assert.equal(r.status, 200, await r.clone().text());
    const out = (await r.json()) as { added: string[]; moved: string[]; refused: string[] };
    assert.equal(out.added.length, 1);
    assert.deepEqual(out.moved, [first.id]);
    assert.match(String(out.refused[0]), /move x-0123456789ab: no experiment/);
    assert.deepEqual(
      s.q.queued(RUN).map((x) => [x.title, x.added_by]),
      [
        ["first", "owner"],
        ["vector loads", "teacher"],
      ],
    );
    const added = s.events("experiment_added").at(-1);
    assert.equal(added?.actor, "supervisor:teacher");
    assert.equal((added?.body as { by: string } | undefined)?.by, "teacher");
    const moved = s.events("experiment_moved").at(-1);
    assert.deepEqual(moved?.body, {
      id: first.id,
      by: "teacher",
      position: "top",
      why: "it is cheapest",
    });
    // An auditor's check; a why is required; advisors can't drop; other tokens are refused.
    assert.equal(
      (
        await post({
          run: RUN,
          role: "auditor",
          add: [{ title: "re-measure a-1", family: "check", why: "a doubt" }],
        })
      ).status,
      200,
    );
    assert.equal(
      (await post({ run: RUN, role: "teacher", add: [{ title: "no why" }] })).status,
      400,
    );
    assert.equal((await post({ run: RUN, role: "teacher", drop: [{ id: first.id }] })).status, 400);
    assert.equal((await post({ run: RUN, role: "owner", add: [] })).status, 400);
    assert.equal((await post({ run: RUN, role: "teacher" }, tokens.proposer)).status, 401);
    assert.equal((await post({ run: RUN, role: "teacher" }, "trial.nope")).status, 401);
  });

  test("a worker's idea is proposed by its lane, and only while its trial is open", async () => {
    const s = await setup();
    const api = createHarnessApi(s.env.service, tokens);
    const token = randomBytes(16).toString("hex");
    const registry = new Registry(s.env.service.ledger);
    registry.startTrial({
      id: "t-0123456789abcdef",
      run: RUN,
      lane: "lane-2",
      epoch: 1,
      family: "f",
      parent: s.env.seedCommit,
      token,
    });
    const idea = (body: unknown, t = token) =>
      api.request("/v1/trial/idea", {
        method: "POST",
        headers: auth(`trial.${t}`),
        body: JSON.stringify(body),
      });
    const r = await idea({
      title: "unroll the tail loop",
      why: "the profile shows it",
      family: "unroll",
      run: "other",
    });
    assert.equal(
      r.status,
      400,
      "a worker names nothing but its idea: its trial decides run and lane",
    );
    const ok = await idea({
      title: "unroll the tail loop",
      why: "the profile shows it",
      family: "unroll",
    });
    assert.equal(ok.status, 201, await ok.clone().text());
    const { experiment } = (await ok.json()) as { experiment: string };
    const x = s.q.get(experiment);
    assert.equal(x?.state, "proposed");
    assert.equal(x?.added_by, "lane-2");
    assert.equal(x?.run, RUN);
    const e = s.events("experiment_added").at(-1);
    assert.equal(e?.actor, "lane-2");
    assert.deepEqual(e?.body, {
      id: experiment,
      title: "unroll the tail loop",
      family: "unroll",
      why: "the profile shows it",
      by: "lane-2",
      state: "proposed",
      trial: "t-0123456789abcdef",
    });
    assert.equal((await idea({ title: "a second idea" })).status, 201);
    assert.equal((await idea({ title: "" })).status, 400, "an idea needs a title");
    registry.finishTrial(
      "t-0123456789abcdef",
      { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "s",
    );
    assert.equal(
      (await idea({ title: "after the end" })).status,
      409,
      "a trial that ended proposes nothing",
    );
    assert.equal((await idea({ title: "x" }, "unknown")).status, 401);
    assert.deepEqual(
      s.q.proposed(RUN).map((p) => p.title),
      ["unroll the tail loop", "a second idea"],
    );
  });
});
