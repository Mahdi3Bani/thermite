import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { syncModelRoute, syncModelRouteRound } from "./model-route.ts";

/** A fake control and harness: control's reply is given; the harness records what it is handed. */
function fakes(
  control: () => Response,
  harness: { source: string; revision?: string; planner_revision?: string },
) {
  const handed: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "control") return control();
    if (init?.method === "PUT") {
      handed.push(JSON.parse(String(init.body)));
      return Response.json({});
    }
    return Response.json(harness);
  };
  const cfg = {
    rig: "rig-a",
    controlUrl: "http://control",
    controlToken: "c",
    harnessUrl: "http://harness",
    harnessToken: "h",
    fetchImpl,
  };
  return { cfg, handed };
}

describe("the supervisor's model route", () => {
  test("a route control no longer reaches stays as it is", async () => {
    const f = fakes(() => new Response("down", { status: 502 }), {
      source: "control",
      revision: "aaaaaaaa",
    });
    await assert.rejects(syncModelRoute(f.cfg), /HTTP 502/);
    assert.deepEqual(f.handed, []);
  });

  test("a changed route is handed over; control's explicit none hands the rig back", async () => {
    const route = { name: "r", version: 2, revision: "bbbbbbbb" };
    const changed = fakes(() => Response.json({ route }), {
      source: "control",
      revision: "aaaaaaaa",
    });
    assert.equal(await syncModelRoute(changed.cfg), "set");
    assert.deepEqual(changed.handed, [{ route, planner: null }]);
    const none = fakes(() => Response.json({ route: null }), {
      source: "control",
      revision: "aaaaaaaa",
    });
    assert.equal(await syncModelRoute(none.cfg), "cleared");
    assert.deepEqual(none.handed, [{ route: null, planner: null }]);
    const own = fakes(() => Response.json({ route: null }), { source: "environment" });
    assert.equal(await syncModelRoute(own.cfg), "unchanged");
  });

  test("the planner's own route is handed over when only it changed, and cleared when control drops it", async () => {
    const route = { name: "r", version: 2, revision: "bbbbbbbb" };
    const planner = { name: "claude-max", version: 1, revision: "cccccccc" };
    const given = fakes(() => Response.json({ route, planner }), {
      source: "control",
      revision: "bbbbbbbb",
    });
    assert.equal(await syncModelRoute(given.cfg), "set");
    assert.deepEqual(given.handed, [{ route, planner }]);
    const same = fakes(() => Response.json({ route, planner }), {
      source: "control",
      revision: "bbbbbbbb",
      planner_revision: "cccccccc",
    });
    assert.equal(await syncModelRoute(same.cfg), "unchanged");
    const dropped = fakes(() => Response.json({ route, planner: null }), {
      source: "control",
      revision: "bbbbbbbb",
      planner_revision: "cccccccc",
    });
    assert.equal(await syncModelRoute(dropped.cfg), "set");
    assert.deepEqual(dropped.handed, [{ route, planner: null }]);
  });

  test("a round that fails is tried once more after a wait; only a second failure reaches the log", async () => {
    const route = { name: "r", version: 2, revision: "bbbbbbbb" };
    // Control not up yet at the first call, as at start: fetch itself fails.
    let calls = 0;
    const starting = fakes(
      () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return Response.json({ route });
      },
      { source: "environment" },
    );
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    assert.equal(await syncModelRouteRound(starting.cfg, 5000, wait), "set");
    assert.deepEqual(waits, [5000]);
    assert.deepEqual(starting.handed, [{ route, planner: null }]);
    // Up at once: no wait.
    const up = fakes(() => Response.json({ route }), { source: "environment" });
    waits.length = 0;
    assert.equal(await syncModelRouteRound(up.cfg, 5000, wait), "set");
    assert.deepEqual(waits, []);
    // Still down after the wait: the second failure is the round's.
    const down = fakes(
      () => {
        throw new TypeError("fetch failed");
      },
      { source: "control", revision: "aaaaaaaa" },
    );
    await assert.rejects(syncModelRouteRound(down.cfg, 5000, wait), /fetch failed/);
    assert.deepEqual(waits, [5000]);
    assert.deepEqual(down.handed, []);
  });
});
