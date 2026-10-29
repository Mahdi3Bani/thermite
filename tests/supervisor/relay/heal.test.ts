import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInfo } from "../../../src/common/build-info.ts";
import { foldReport } from "../../../src/control/ingest.ts";
import { fingerprint } from "../../../src/control/store/index.ts";
import { REPORT_STREAM_CONFIG } from "../../../src/core/link/report.ts";
import { healCursor, type RelayState, relayOnce } from "../../../src/supervisor/relay/index.ts";
import { controlStack, RIG_TOKEN } from "../../helpers/control-stack.ts";
import { heldEvents } from "../../helpers/control-store.ts";
import { asMessage, FakeBus } from "../../helpers/fake-bus.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { appendOther } from "../../helpers/kinds.ts";

/**
 * Control and rig-a's harness, with the supervisor's reports on a bus: `fold()` hands control the
 * messages published since the last call, as its consumer does, and says what each came to.
 * `figures()` is the supervisor's regular call, and its answer.
 */
async function rig(o: { requireKeyAcceptance?: boolean; clock?: () => Date } = {}) {
  const requireKeyAcceptance = o.requireKeyAcceptance ?? false;
  const s = controlStack({
    env: makeHarnessEnv("rig-a", o.clock),
    options: { requireKeyAcceptance },
  });
  const bus = new FakeBus();
  await bus.makeStream(REPORT_STREAM_CONFIG);
  const intake = { store: s.store, control: buildInfo(), requireKeyAcceptance };
  let read = 0;
  const fold = async () => {
    const out = [];
    for (const m of bus.kept.slice(read)) {
      read++;
      out.push(await foldReport(intake, asMessage(m)));
    }
    return out;
  };
  const figures = async (cursor: number): Promise<unknown> => {
    const body = { at: new Date().toISOString(), relay: { cursor } };
    const r = await s.api("POST", "/v1/rigs/rig-a/supervisor", body, RIG_TOKEN);
    assert.equal(r.status, 200);
    return await r.json();
  };
  const events = (n: number, kind = "step") => {
    for (let i = 0; i < n; i++) appendOther(s.env.service.ledger, "t", kind, null, { i });
  };
  const taken = async () => (await heldEvents(s.store, "rig-a")).length;
  return { ...s, bus, fold, figures, events, taken, cfg: { ...s.cfg, bus, skipCommands: true } };
}

describe("a report page refused on the bus heals", () => {
  test("control's answer to the supervisor's figures names its place in the rig's events", async () => {
    const r = await rig();
    assert.deepEqual(await r.figures(0), { ok: true, reports: { ledger_id: null, cursor: 0 } });
    r.events(5);
    const state = await r.relay();
    const ledger = r.env.service.ledger.ledgerId();
    assert.deepEqual(await r.figures(state.cursor), {
      ok: true,
      reports: { ledger_id: ledger, cursor: state.cursor },
    });
    assert.ok(state.cursor >= 5);
  });

  test("after a key that waited for the owner, the supervisor sends again from control's place", async () => {
    const r = await rig({ requireKeyAcceptance: true });
    r.events(25);
    let state: RelayState = await relayOnce(r.cfg, { cursor: 0, pageLimit: 10 });
    const end = state.cursor;
    const pages = r.bus.kept.length;
    assert.ok(pages >= 3);
    for (const f of await r.fold())
      assert.deepEqual(f, { refused: "the rig's key waits for the owner's acceptance" });
    assert.equal(await r.taken(), 0);

    // Control has none of the rig's events, but it may still be reading what this round sent: the
    // supervisor waits a round. A round later control still has none: it goes back to the start.
    state = healCursor(state, await r.figures(state.cursor));
    assert.deepEqual([state.cursor, state.healing], [end, false]);
    state = await relayOnce(r.cfg, state);
    assert.deepEqual(await r.fold(), [
      { refused: "the rig's key waits for the owner's acceptance" },
    ]);
    state = healCursor(state, await r.figures(state.cursor));
    assert.deepEqual([state.cursor, state.healing], [0, true]);
    const pending = r.store.reportedRigs.key("rig-a").pending ?? "";
    const accepted = await r.api(
      "POST",
      `/v1/rigs/rig-a/key/accept?fingerprint=${fingerprint(pending)}`,
    );
    assert.equal(accepted.status, 200);

    // One page a round while it heals. The bus had this page within its duplicate window, so it
    // keeps it once and control gets nothing new: the next answer still says 0.
    const kept = r.bus.kept.length;
    state = await relayOnce(r.cfg, state);
    assert.equal(state.cursor, 10);
    assert.equal(r.bus.kept.length, kept, "a duplicate: not kept again");
    assert.deepEqual(await r.fold(), []);
    state = healCursor(state, await r.figures(state.cursor));
    assert.equal(state.cursor, 0);

    // Once the window has passed, the page is kept and control takes it; the healing ends.
    r.bus.forgetIds();
    state = await relayOnce(r.cfg, state);
    assert.deepEqual(await r.fold(), [{ folded: 10 }]);
    state = healCursor(state, await r.figures(state.cursor));
    assert.deepEqual([state.cursor, state.healing], [10, false]);

    // The rest goes in one round, as before the refusal.
    state = await relayOnce(r.cfg, state);
    assert.equal(state.cursor, end);
    for (const f of await r.fold()) assert.ok("folded" in f, JSON.stringify(f));
    assert.equal(await r.taken(), end);
    state = healCursor(state, await r.figures(state.cursor));
    assert.deepEqual([state.cursor, state.healing], [end, false]);
    assert.equal(healCursor(state, await r.figures(state.cursor)), state, "nothing to heal");
  });

  test("after a clock ahead, and the page refused after it, the rig catches up", async () => {
    let ahead = 10 * 60_000;
    const r = await rig({ clock: () => new Date(Date.now() + ahead) });
    r.events(5);
    let state: RelayState = await relayOnce(r.cfg, { cursor: 0, pageLimit: 10 });
    assert.deepEqual(await r.fold(), [{ refused: "report from the future" }]);
    state = healCursor(state, await r.figures(state.cursor));
    assert.equal(state.healing, false, "a round to read it first");
    // Its clock is set right; the next page is refused too: control has none of the ledger.
    ahead = 0;
    r.events(3, "late");
    state = await relayOnce(r.cfg, state);
    assert.deepEqual(await r.fold(), [{ refused: "a new ledger's events start at 0" }]);
    state = healCursor(state, await r.figures(state.cursor));
    assert.deepEqual([state.cursor, state.healing], [0, true]);
    // Sent again from 0: a page that reaches further than the refused one, so a message of its
    // own on the bus at once.
    state = await relayOnce(r.cfg, state);
    assert.deepEqual(await r.fold(), [{ folded: state.cursor }]);
    state = healCursor(state, await r.figures(state.cursor));
    assert.equal(state.healing, false);
    assert.equal(await r.taken(), state.cursor);
  });

  test("a control still reading this round's pages sends nobody back", async () => {
    const r = await rig();
    r.events(25);
    let state: RelayState = await relayOnce(r.cfg, { cursor: 0, pageLimit: 10 });
    // Control has read none of this round's pages when it answers: the supervisor stays.
    state = healCursor(state, await r.figures(state.cursor));
    assert.equal(state.healing, false);
    assert.equal((await r.fold()).length, 3);
    r.events(2, "more");
    state = await relayOnce(r.cfg, state);
    // It has all but this round's page: the supervisor's cursor stays again.
    const ahead = healCursor(state, await r.figures(state.cursor));
    assert.equal(ahead.cursor, state.cursor);
    assert.equal(ahead.healing, false);
    await r.fold();
    assert.equal(await r.taken(), state.cursor);
  });

  test("the supervisor goes back only when control is behind what it sent a round ago", () => {
    const place = (ledger_id: string | null, cursor: number) => ({
      ok: true,
      reports: { ledger_id, cursor },
    });
    const state: RelayState = {
      cursor: 40,
      ledgerId: "L",
      pageLimit: 1000,
      atLastCall: { ledgerId: "L", cursor: 40 },
    };
    // An older control names no place; a malformed one is passed over; no ledger yet, nothing.
    assert.equal(healCursor(state, { ok: true }), state);
    assert.equal(healCursor(state, undefined), state);
    assert.equal(healCursor(state, place("L", -1)), state);
    const fresh: RelayState = { cursor: 0 };
    assert.equal(healCursor(fresh, place(null, 0)), fresh);
    // Control has what the supervisor sent, or more: nothing to do.
    assert.equal(healCursor(state, place("L", 40)), state);
    assert.equal(healCursor(state, place("L", 55)), state);
    // Behind what was sent a round ago, in the same ledger or holding none of it: back to it.
    assert.deepEqual(healCursor(state, place("L", 30)), {
      ...state,
      cursor: 30,
      atLastCall: { ledgerId: "L", cursor: 30 },
      healing: true,
    });
    assert.equal(healCursor(state, place(null, 0)).cursor, 0);
    assert.equal(healCursor(state, place("K", 90)).cursor, 0);
    // Pages sent since the last call may still be on their way: their cursor is only noted.
    const sent = { ...state, cursor: 60 };
    assert.deepEqual(healCursor(sent, place("L", 40)), {
      ...sent,
      atLastCall: { ledgerId: "L", cursor: 60 },
      healing: false,
    });
    // A call in another ledger counts for nothing in this one.
    const moved = { ...state, atLastCall: { ledgerId: "K", cursor: 40 } };
    assert.equal(healCursor(moved, place("L", 0)).cursor, 40);
    // While it heals, the page sent since must be taken; once it is, the healing ends.
    const healing = { ...state, cursor: 50, healing: true };
    assert.equal(healCursor(healing, place("L", 40)).cursor, 40);
    assert.deepEqual(healCursor(healing, place("L", 50)), {
      ...healing,
      atLastCall: { ledgerId: "L", cursor: 50 },
      healing: false,
    });
  });
});
