import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { syncModelRoute } from "./model-route.ts";

/** A fake control and harness: control's reply is given; the harness records what it is handed. */
function fakes(control: () => Response, harness: { source: string; revision?: string }) {
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
    assert.deepEqual(changed.handed, [{ route }]);
    const none = fakes(() => Response.json({ route: null }), {
      source: "control",
      revision: "aaaaaaaa",
    });
    assert.equal(await syncModelRoute(none.cfg), "cleared");
    assert.deepEqual(none.handed, [{ route: null }]);
    const own = fakes(() => Response.json({ route: null }), { source: "environment" });
    assert.equal(await syncModelRoute(own.cfg), "unchanged");
  });
});
