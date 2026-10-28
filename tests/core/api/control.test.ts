import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../../src/common/api/call.ts";
import { controlClient } from "../../../src/common/api/control.ts";
import { tunnelRouteAllowed } from "../../../src/control/tunnel.ts";
import * as owner from "../../../src/core/api/control/owner.ts";
import * as rigs from "../../../src/core/api/control/rigs.ts";
import { pathOf, type Route } from "../../../src/core/api/route.ts";
import { ADMIN, controlOnly, RIG_TOKEN } from "../../helpers/control-stack.ts";

/** The routes a contract module names: each export that is a route. */
function routesOf(module: Record<string, unknown>): [string, Route][] {
  return Object.entries(module).filter(
    (e): e is [string, Route] =>
      typeof e[1] === "object" && e[1] !== null && "method" in e[1] && "path" in e[1],
  );
}

const RIG_ROUTES = routesOf(rigs);
const OWNER_ROUTES = routesOf(owner);
/** Each parameter a path may have, filled as the tunnel's allow-list takes it. */
const PARAMS = {
  rig: "rig-a",
  id: "c-1",
  run: "r-1",
  seq: 3,
  name: "20261020T120000Z-0123abcd",
  campaign: "sort-speed",
};

describe("control's API has one contract (core/api/control/)", () => {
  test("each route is named once, and control serves every route a rig and the command line call", async () => {
    const seen = new Set<string>();
    for (const [name, r] of [...RIG_ROUTES, ...OWNER_ROUTES]) {
      const key = `${r.method} ${r.path}`;
      assert.ok(!seen.has(key), `${name}: ${key} is named twice`);
      seen.add(key);
    }
    const { control } = controlOnly({ tokens: { admin: ADMIN, rigs: { "rig-a": RIG_TOKEN } } });
    for (const [list, token] of [
      [RIG_ROUTES, RIG_TOKEN],
      [OWNER_ROUTES, ADMIN],
    ] as const)
      for (const [name, r] of list) {
        const path = pathOf(r, PARAMS);
        const res = await control.request(path, {
          method: r.method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(r.method === "GET" ? {} : { body: "{}" }),
        });
        // Hono's own answer to a path it has no route for; any other is the route's.
        assert.notEqual(await res.text(), "404 Not Found", `${name}: ${r.method} ${path}`);
      }
  });

  test("pull mode's tunnel lets every route of a rig's through, and no route of the owner's", () => {
    // The allow-list repeats the routes on purpose (what it does not list, it refuses): it agrees.
    for (const [name, r] of RIG_ROUTES)
      assert.ok(tunnelRouteAllowed("rig-a", r.method, pathOf(r, PARAMS)), name);
    assert.ok(
      tunnelRouteAllowed("rig-a", "GET", `${rigs.gitRepoPath("rig-a", "kits/lab-kit")}/info/refs`),
    );
    for (const [name, r] of OWNER_ROUTES)
      assert.ok(!tunnelRouteAllowed("rig-a", r.method, pathOf(r, PARAMS)), name);
  });

  test("a body past its route's limit is answered 413, the code its sender acts on", async () => {
    const { control } = controlOnly({ tokens: { admin: ADMIN, rigs: { "rig-a": RIG_TOKEN } } });
    const res = await control.request(pathOf(rigs.REPORTS, PARAMS), {
      method: "POST",
      headers: { authorization: `Bearer ${RIG_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "daily", body: "x".repeat(rigs.REPORTS.maxBytes) }),
    });
    assert.equal(res.status, 413);
  });

  test("a run control did not assign is answered with its code, not only its words", async () => {
    const { control } = controlOnly({ tokens: { admin: ADMIN, rigs: { "rig-a": RIG_TOKEN } } });
    const client = controlClient({
      url: "http://control",
      token: RIG_TOKEN,
      rig: "rig-a",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        return await control.request(`${url.pathname}${url.search}`, init);
      }) as typeof fetch,
    });
    const err = await client.call(rigs.KB, { query: { run: "nope", after: 0 } }).then(
      () => assert.fail("control gave past research for a run it did not assign"),
      (e: unknown) => e,
    );
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.code, rigs.KB_NOT_ASSIGNED);
    assert.equal(err.words, "control did not assign run nope to this rig");
  });

  test("its bodies take what a rig's supervisor sends today", () => {
    const at = new Date().toISOString();
    // A newer supervisor's figures (control's versions test): fields it does not know are dropped.
    const figures = {
      at,
      relay: { cursor: 3 },
      uptime_s: 4000,
      export: {
        remote: false,
        to: "control",
        exports: 1,
        pushed: [],
        last_push_at: null,
        uploaded: Array.from({ length: rigs.FIGURE_EXPORTS_MAX }, (_, i) => `e-${i}`),
        last_error: "x".repeat(rigs.FIGURE_TEXT_MAX),
      },
      models: [],
      advisors: null,
    };
    assert.ok(rigs.FIGURES.body.safeParse(figures).success);
    // One past the limits the supervisor cuts to is refused: so it cuts to them.
    const over = { ...figures, export: { ...figures.export, last_error: "x".repeat(1001) } };
    assert.ok(!rigs.FIGURES.body.safeParse(over).success);
    assert.ok(
      rigs.ACK.body.safeParse({ status: "failed", outcome: { error: "no content" } }).success,
    );
    assert.ok(
      rigs.REPORTS.body.safeParse({ kind: "daily", body: "x".repeat(rigs.REPORT_MAX_CHARS) })
        .success,
    );
    assert.ok(
      rigs.EXPORT_BEGIN.body.safeParse({
        manifest: {
          rig: "rig-a",
          created_at: at,
          from_event: 0,
          through_event: 4,
          files: { "events.jsonl": "a".repeat(64) },
        },
        files: { "events.jsonl": 120 },
      }).success,
    );
  });
});
