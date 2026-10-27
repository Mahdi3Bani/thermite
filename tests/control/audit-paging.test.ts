import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createControlApi } from "../../src/control/api.ts";
import { ControlStore } from "../../src/control/store.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";
import { ADMIN, signIn } from "../helpers/control-stack.ts";

/** Every entry, one page at a time, following one cursor until it ends. */
function walk(
  store: ControlStore,
  way: "older" | "newer",
  start: { before?: number; after?: number },
  filter: { action?: string; mcp?: boolean } = {},
): string[] {
  const seen: string[] = [];
  let cursor: { before?: number; after?: number } = start;
  for (let pages = 0; pages < 100; pages++) {
    const p = store.auditPage(3, filter, cursor);
    seen.push(...p.entries.map((e) => e.action));
    const next = p[way];
    if (next === null) return seen;
    cursor = way === "older" ? { before: next } : { after: next };
  }
  throw new Error("the cursor never ended");
}

describe("paging through control's audit log (goal 015)", () => {
  test("pages go older and newer through every entry once, newest first, with the filters kept", () => {
    const store = new ControlStore(":memory:");
    assert.deepEqual(store.auditPage(3), { entries: [], older: null, newer: null });
    for (let i = 1; i <= 10; i++) {
      store.audit("owner:ui", `step_${i}`, { i });
      if (i % 4 === 0) store.audit("owner:mcp", "mcp:control_log", {});
    }
    const steps = Array.from({ length: 10 }, (_, i) => `step_${10 - i}`);
    const newest = store.auditPage(3, { mcp: false });
    assert.deepEqual(
      newest.entries.map((e) => e.action),
      ["step_10", "step_9", "step_8"],
    );
    assert.equal(newest.newer, null, "nothing is newer than the newest page");
    assert.equal(newest.older, newest.entries.at(-1)?.id);
    // Older, page by page, to the first entry; then newer, back up to the newest.
    assert.deepEqual(walk(store, "older", {}, { mcp: false }), steps);
    const oldest = store.auditPage(3, { mcp: false }, { after: 0 });
    assert.deepEqual(
      oldest.entries.map((e) => e.action),
      ["step_3", "step_2", "step_1"],
      "the page just after the cursor, newest first",
    );
    assert.equal(oldest.older, null);
    assert.deepEqual(walk(store, "newer", { after: 0 }, { mcp: false }), [
      "step_3",
      "step_2",
      "step_1",
      "step_6",
      "step_5",
      "step_4",
      "step_9",
      "step_8",
      "step_7",
      "step_10",
    ]);
    // MCP calls are entries too, unless left out; an action filter pages through its own matches.
    assert.equal(walk(store, "older", {}).length, 12);
    assert.deepEqual(walk(store, "older", {}, { action: "step_1" }), ["step_10", "step_1"]);
    // An empty page past either end still points back at the entries.
    const top = newest.entries[0]?.id ?? 0;
    const past = store.auditPage(3, {}, { after: top + 50 });
    assert.deepEqual(past, { entries: [], older: top + 51, newer: null });
    assert.deepEqual(
      store.auditPage(3, {}, { before: past.older ?? 0 }).entries.map((e) => e.action),
      ["step_10", "step_9", "mcp:control_log"],
    );
    const below = store.auditPage(3, {}, { before: 1 });
    assert.deepEqual(below, { entries: [], older: null, newer: 0 });
    assert.deepEqual(store.auditPage(3, {}, { before: 0 }), below, "never a cursor below 0");
    assert.equal(
      store.auditPage(3, {}, { after: below.newer ?? 0 }).entries.at(-1)?.action,
      "step_1",
    );
  });

  test("REST pages with before and after, and refuses a cursor that is not a number", async () => {
    const store = new ControlStore(":memory:");
    const api = createControlApi(
      store,
      { admin: ADMIN, rigs: {} },
      generateSigningKeys().privateKeyPem,
    );
    for (let i = 1; i <= 5; i++) store.audit("owner:api", `step_${i}`, { i });
    const get = async (query: string) => {
      const r = await api.request(`/v1/audit?${query}`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    type Page = { audit: { action: string }[]; older: number | null; newer: number | null };
    const first = (await get("limit=2")).body as Page;
    assert.deepEqual(
      first.audit.map((e) => e.action),
      ["step_5", "step_4"],
    );
    assert.equal(first.newer, null);
    const second = (await get(`limit=2&before=${first.older}`)).body as Page;
    assert.deepEqual(
      second.audit.map((e) => e.action),
      ["step_3", "step_2"],
    );
    const third = (await get(`limit=2&before=${second.older}`)).body as Page;
    assert.deepEqual([third.audit.map((e) => e.action), third.older], [["step_1"], null]);
    const up = (await get(`limit=2&after=${third.newer}`)).body as Page;
    assert.deepEqual(up.audit, second.audit);
    assert.deepEqual(await get("before=null"), {
      status: 400,
      body: { error: "before and after are whole numbers" },
    });
    assert.deepEqual(await get("before=3&after=1"), {
      status: 400,
      body: { error: "give before or after, not both" },
    });
  });

  test("the Audit log page shows 300 entries at a time, with Older and Newer links", async () => {
    const store = new ControlStore(":memory:");
    const api = createControlApi(
      store,
      { admin: ADMIN, rigs: {} },
      generateSigningKeys().privateKeyPem,
    );
    for (let i = 1; i <= 650; i++) store.audit("owner:api", `step_${i}`, { i });
    const { page } = await signIn(api);
    const shown = (html: string) =>
      [...html.matchAll(/<span class="muted xs">(step_\d+)<\/span>/g)].map((m) => m[1]);
    const link = (html: string, word: string) =>
      new RegExp(`<a href="(/ui/audit\\?(?:before|after)=\\d+)">${word}</a>`).exec(html)?.[1];
    // The newest page: the login entry, then the newest 299 steps; nothing newer.
    const newest = await page("/ui/audit");
    assert.deepEqual(shown(newest).slice(0, 2), ["step_650", "step_649"]);
    assert.equal(shown(newest).length, 299);
    assert.equal(link(newest, "Newer"), undefined);
    const olderHref = link(newest, "Older");
    assert.ok(olderHref);
    const middle = await page(olderHref);
    assert.deepEqual(shown(middle).slice(0, 1), ["step_351"]);
    assert.equal(shown(middle).length, 300);
    const lastHref = link(middle, "Older");
    assert.ok(lastHref);
    const last = await page(lastHref);
    assert.deepEqual(
      shown(last),
      Array.from({ length: 51 }, (_, i) => `step_${51 - i}`),
    );
    assert.equal(link(last, "Older"), undefined, "the first entry is on the last page");
    const newerHref = link(last, "Newer");
    assert.ok(newerHref);
    assert.deepEqual(shown(await page(newerHref)), shown(middle));
    // Past the newest entry, the page says so and links back.
    const empty = await page("/ui/audit?after=100000");
    assert.match(empty, /No entry here\./);
    assert.ok(link(empty, "Older"));
  });
});
