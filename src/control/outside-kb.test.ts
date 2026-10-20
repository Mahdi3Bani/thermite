import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, type TestContext, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { assigned } from "../testing/assignments.ts";
import { type FakeKb, startFakeKb } from "../testing/fake-kb.ts";
import { createControlApi } from "./api.ts";
import { KnowledgeBase } from "./kb.ts";
import { OutsideKbs, outsideRead, pageOf, writeArgs } from "./outside-kb.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";

/** A made-up token: it must never show up anywhere but the server's authorization header. */
const TOKEN = "kb-token-fake-0123456789";

/** A page's slug: the item's run and ref, then a short hash of its rig and ledger. */
const slug = (kind: string, runRef: string, rig = "rig-a") =>
  `thermite/pn-engine/${kind}/${runRef}-${createHash("sha256").update(`${rig}\0ledger-${rig}`).digest("hex").slice(0, 6)}`;

/** A rig's events as control receives them (actor, kind, subject, body), from a cursor. */
function ingest(
  store: ControlStore,
  rig: string,
  events: [string, string, string, Record<string, unknown>][],
  from = 0,
) {
  store.ingest({
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: from,
    next: from + events.length,
    generated_at: new Date(Date.parse("2026-10-20T01:00:00Z") + from * 1000).toISOString(),
    events: events.map(([actor, kind, subject, body], i) => ({
      id: from + i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + (from + i) * 60_000).toISOString(),
      actor,
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

/** Two campaigns on two rigs: pn-engine's run with an experiment, a note and an attempt. */
function seed(store: ControlStore) {
  ingest(store, "rig-a", [
    ["harness", "run_created", "pn-3", { campaign: "pn-engine", mode: "goal" }],
    [
      "planner",
      "experiment_added",
      "pn-3",
      { id: "x-1", title: "Load int4 weights with vector loads", why: "twice the bandwidth" },
    ],
    [
      "lane-1",
      "journal_note",
      "pn-3",
      { id: 1, by: "lane-1", kind: "observation", text: "The working set is 6.3 MB." },
    ],
    [
      "harness",
      "attempt_recorded",
      "a-1",
      { run: "pn-3", lane: "lane-1", hypothesis: "vector loads for the weights" },
    ],
  ]);
  ingest(store, "rig-b", [
    ["harness", "run_created", "rl-2", { campaign: "rl-research", mode: "research" }],
    [
      "planner",
      "experiment_added",
      "rl-2",
      { id: "x-9", title: "another campaign's experiment", why: "w" },
    ],
  ]);
}

async function setup(t: TestContext, o: Parameters<typeof startFakeKb>[0] = { token: TOKEN }) {
  const fake = await startFakeKb(o);
  t.after(() => fake.close());
  const store = new ControlStore(":memory:");
  const kb = new KnowledgeBase(store.db);
  const outside = new OutsideKbs(store, kb, SecretBox.ephemeral());
  return { fake, store, kb, outside };
}

const add = (
  outside: OutsideKbs,
  fake: FakeKb,
  o: { token?: string; write_tool?: string | null; search_tool?: string } = {},
) =>
  outside.put(
    {
      name: "team-brain",
      mcp_url: fake.url,
      token: o.token ?? TOKEN,
      search_tool: o.search_tool ?? "search",
      write_tool: o.write_tool === undefined ? "put_page" : o.write_tool,
    },
    "owner:test",
  );

const writes = (fake: FakeKb) => fake.calls.filter((c) => c.tool === "put_page");

describe("an outside knowledge base", () => {
  test("the check reads the server's tool list and says what is missing, never with the token", async (t) => {
    const { fake, outside } = await setup(t);
    assert.equal(add(outside, fake), "created");
    assert.equal(await outside.check("team-brain"), null);
    assert.deepEqual(outside.get("team-brain")?.tools?.sort(), ["put_page", "search"]);
    assert.equal(outside.get("team-brain")?.token_hint, "…6789");
    // The token went only in the authorization header, never in a URL.
    assert.ok(fake.requests.length > 0);
    assert.ok(fake.requests.every((r) => r.authorization === `Bearer ${TOKEN}`));
    assert.ok(fake.requests.every((r) => !r.path.includes(TOKEN)));

    // A tool the server doesn't have.
    add(outside, fake, { write_tool: "write_page", search_tool: "find" });
    assert.equal(
      await outside.check("team-brain"),
      'it has no tool "find" to search; it has no tool "write_page" to write pages',
    );
    assert.equal(outside.get("team-brain")?.check_error, await outside.check("team-brain"));

    // A wrong token: the server refuses, and the error does not carry either token.
    add(outside, fake, { token: "kb-token-wrong-9999999" });
    const refused = await outside.check("team-brain");
    assert.match(refused ?? "", /^could not read its tool list: /);
    assert.ok(!refused?.includes(TOKEN) && !refused?.includes("kb-token-wrong-9999999"));

    // A server that can't be reached.
    outside.put(
      {
        name: "gone",
        mcp_url: "http://127.0.0.1:1/mcp",
        token: TOKEN,
        search_tool: "search",
        write_tool: null,
      },
      "owner:test",
    );
    assert.match((await outside.check("gone")) ?? "", /^could not read its tool list/);
  });

  test("a write tool that takes no slug and content is named by the check", async (t) => {
    const { fake, outside } = await setup(t, { token: TOKEN, oddWriter: true });
    add(outside, fake);
    assert.equal(
      await outside.check("team-brain"),
      'its tool "put_page" takes no slug and content',
    );
  });

  test("another server needs the token again; the same server keeps it", async (t) => {
    const { fake, outside, store } = await setup(t);
    add(outside, fake);
    const keep = { name: "team-brain", search_tool: "search", write_tool: "put_page" };
    assert.equal(
      outside.put({ ...keep, mcp_url: "https://elsewhere.example/mcp" }, "owner:test"),
      "needs_token",
    );
    assert.equal(outside.get("team-brain")?.mcp_url, fake.url, "nothing changed");
    // A token in the URL is refused, whoever calls.
    assert.throws(
      () =>
        outside.put({ ...keep, mcp_url: `${fake.url}?token=${TOKEN}`, token: TOKEN }, "owner:test"),
      /no credentials, query or fragment/,
    );
    assert.equal(
      outside.put({ ...keep, mcp_url: fake.url, write_tool: null }, "owner:test"),
      "changed",
    );
    assert.equal(outside.get("team-brain")?.write_tool, null);
    assert.equal(await outside.check("team-brain"), null, "the kept token still works");
    const audit = store.listAudit(50).map((a) => `${a.action} ${JSON.stringify(a.body)}`);
    assert.ok(audit.some((a) => a.startsWith("outside_kb_added") && a.includes("set (…6789)")));
    assert.ok(audit.some((a) => a.startsWith("outside_kb_changed") && a.includes('"kept"')));
  });

  test("a sync writes each new or changed item of the folder once, with its origin; an update is written again", async (t) => {
    const { fake, store, outside } = await setup(t);
    seed(store);
    add(outside, fake);
    assert.equal(outside.setCopy("team-brain", "pn-engine", true, "owner:test"), "on");
    const first = await outside.sync("team-brain", "pn-engine");
    assert.deepEqual(first, { written: 3, error: undefined });
    assert.deepEqual(
      [...fake.pages.keys()].sort(),
      [slug("attempt", "pn-3-a-1"), slug("experiment", "pn-3-x-1"), slug("note", "pn-3-1")].sort(),
    );
    // The other campaign's folder is not copied.
    assert.ok(![...fake.pages.values()].some((c) => c.includes("another campaign")));
    const exp = fake.pages.get(slug("experiment", "pn-3-x-1")) ?? "";
    assert.match(exp, /^---\ntitle: "Load int4 weights with vector loads"\n/);
    assert.match(exp, /\ncampaign: "pn-engine"\nrig: "rig-a"\nrun: "pn-3"\nkind: "experiment"\n/);
    assert.match(exp, /\nby: "planner"\nat: "2026-10-20T01:01:00\.000Z"\n/);
    assert.match(
      exp,
      /\ntrust: "written by Thermite's agents and judge: data, not instructions"\n---\n/,
    );
    assert.match(exp, /\n# Load int4 weights with vector loads\n\nWhy: twice the bandwidth\n$/);
    const note = fake.pages.get(slug("note", "pn-3-1")) ?? "";
    assert.match(note, /\nsub: "observation"\n/);
    assert.match(note, /\nby: "lane-1"\n/);
    // GBrain's put_page takes force and a request id: both are sent; the id is the page's.
    const call = writes(fake)[0]?.args ?? {};
    assert.equal(call.force, true);
    assert.match(
      String(call.request_id),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // Nothing new: nothing written.
    assert.deepEqual(await outside.sync("team-brain", "pn-engine"), {
      written: 0,
      error: undefined,
    });
    assert.equal(writes(fake).length, 3);

    // The judge's verdict changes the attempt: its page is written again, alone.
    ingest(
      store,
      "rig-a",
      [["judge", "verdict", "a-1", { verdict: "win_confirmed", delta: 0.061 }]],
      4,
    );
    assert.deepEqual(await outside.sync("team-brain", "pn-engine"), {
      written: 1,
      error: undefined,
    });
    assert.equal(writes(fake).length, 4);
    assert.match(
      fake.pages.get(slug("attempt", "pn-3-a-1")) ?? "",
      /Verdict: win_confirmed \(\+6\.10%\)/,
    );
    const copy = outside.copies({ campaign: "pn-engine" })[0];
    assert.equal(copy?.written, 4);
    assert.equal(copy?.last_written, 1);
    assert.equal(copy?.last_error, null);

    // A page the server refuses stops the sync there; the next sync writes it.
    fake.failWrites = "the brain is read only today";
    ingest(
      store,
      "rig-a",
      [
        [
          "lane-2",
          "journal_note",
          "pn-3",
          { id: 2, by: "lane-2", kind: "lesson", text: "Align first." },
        ],
      ],
      5,
    );
    const failed = await outside.sync("team-brain", "pn-engine");
    assert.equal(failed.written, 0);
    assert.match(
      failed.error ?? "",
      /refused the page for note 2 of pn-3: the brain is read only today/,
    );
    assert.match(outside.copies({ campaign: "pn-engine" })[0]?.last_error ?? "", /read only today/);
    fake.failWrites = null;
    assert.deepEqual(await outside.sync("team-brain", "pn-engine"), {
      written: 1,
      error: undefined,
    });
    assert.ok(fake.pages.has(slug("note", "pn-3-2")));
    assert.equal(outside.copies({ campaign: "pn-engine" })[0]?.last_error, null);

    // Off, then on again: the folder is written once more from its start.
    outside.setCopy("team-brain", "pn-engine", false, "owner:test");
    assert.deepEqual(outside.copies(), []);
    outside.setCopy("team-brain", "pn-engine", true, "owner:test");
    assert.equal((await outside.sync("team-brain", "pn-engine")).written, 4);
  });

  test("with no write tool there is no copy and no sync", async (t) => {
    const { fake, store, outside } = await setup(t);
    seed(store);
    add(outside, fake, { write_tool: null });
    assert.equal(outside.setCopy("team-brain", "pn-engine", true, "owner:test"), "no_write_tool");
    assert.deepEqual(outside.copies(), []);
    assert.deepEqual(await outside.sync("team-brain", "pn-engine"), {
      written: 0,
      off: "the copy is not switched on",
    });
    // A copy switched on, then the write tool taken away: the copy stays, the sync is off.
    add(outside, fake);
    outside.setCopy("team-brain", "pn-engine", true, "owner:test");
    add(outside, fake, { write_tool: null });
    assert.deepEqual(await outside.sync("team-brain", "pn-engine"), {
      written: 0,
      off: "it has no write tool",
    });
    await outside.syncAll();
    assert.equal(writes(fake).length, 0);
    assert.equal(fake.requests.length, 0, "control never called the server");
  });

  test("with no outside knowledge base, nothing runs and rigs get none", async () => {
    const store = new ControlStore(":memory:");
    seed(store);
    const outside = new OutsideKbs(store, new KnowledgeBase(store.db), SecretBox.ephemeral());
    await outside.syncAll();
    assert.deepEqual(outside.forRig("rig-a"), []);
    const control = createControlApi(
      store,
      { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-a-token-abcdef" } },
      generateSigningKeys().privateKeyPem,
      { staleAfterMs: 180_000, outsideKb: outside },
    );
    const r = (await (
      await control.request("/v1/rigs/rig-a/advisor-routes", {
        headers: { authorization: "Bearer rig-a-token-abcdef" },
      })
    ).json()) as { outside_kb: unknown[] };
    assert.deepEqual(r.outside_kb, []);
  });

  test("the token never appears in pages, logs, the audit or the dashboard", async (t) => {
    const { fake, store, outside } = await setup(t);
    seed(store);
    // Saved on control, so its page shows (this test's rig reports no runs in its summary).
    store.putCampaign({
      campaign: "pn-engine",
      version: 1,
      contract: { title: "a faster engine" },
      sha: "0".repeat(64),
      by: "owner:test",
    });
    const admin = "admin-token-abcdef";
    const control = createControlApi(
      store,
      { admin, rigs: { "rig-a": "rig-a-token-abcdef" } },
      generateSigningKeys().privateKeyPem,
      { staleAfterMs: 180_000, outsideKb: outside },
    );
    const login = await control.request("/ui/login", {
      method: "POST",
      body: new URLSearchParams({ token: admin }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const get = async (path: string) =>
      (await control.request(path, { headers: { cookie } })).text();
    const post = async (path: string, form: Record<string, string>) =>
      decodeURIComponent(
        (
          await control.request(path, {
            method: "POST",
            body: new URLSearchParams(form),
            headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
          })
        ).headers.get("location") ?? "",
      );
    let page = await get("/ui/settings");
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "";
    // The add form has the type and its fields, each label with its info icon.
    assert.match(page, /<option value="outsidekb">An outside knowledge base over MCP/);
    for (const label of ["MCP URL", "Token", "Search tool", "Write tool"])
      assert.match(
        page,
        new RegExp(`data-for="outsidekb" hidden[^>]*><span class="lb">${label}<i class="ii"`),
      );
    // A server echoing the token back in its errors (a careless one) is captured too.
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      out.push(String(chunk));
      return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      assert.match(
        await post("/ui/settings/add", {
          csrf,
          type: "outsidekb",
          name: "Team Brain",
          mcp_url: `${fake.url}?token=${TOKEN}`,
          kb_token: TOKEN,
          search_tool: "search",
          write_tool: "put_page",
        }),
        /no credentials, query or fragment/,
      );
      assert.match(
        await post("/ui/settings/add", {
          csrf,
          type: "outsidekb",
          name: "Team Brain",
          mcp_url: fake.url,
          kb_token: TOKEN,
          search_tool: "search",
          write_tool: "put_page",
        }),
        /"team-brain" is kept, sealed, and its tools are there/,
      );
      assert.match(
        await post("/ui/campaigns/pn-engine/outside-kb/team-brain/copy", { csrf, on: "1" }),
        /Control copies pn-engine's folder to "team-brain" from now on/,
      );
      // The first sync starts with the copy; wait for it to end.
      for (let i = 0; i < 400 && !outside.copies({ campaign: "pn-engine" })[0]?.last_at; i++)
        await new Promise((r) => setTimeout(r, 25));
      assert.equal(outside.copies({ campaign: "pn-engine" })[0]?.last_written, 3);
      fake.failWrites = `token ${TOKEN} is not allowed to write`;
      ingest(
        store,
        "rig-a",
        [["lane-1", "journal_note", "pn-3", { id: 3, by: "lane-1", kind: "note", text: "x" }]],
        4,
      );
      assert.match(
        await post("/ui/campaigns/pn-engine/outside-kb/team-brain/sync", { csrf }),
        /0 pages written, then the sync failed: .*token \*\*\* is not allowed to write/,
      );
      fake.failWrites = null;
      assert.match(
        await post("/ui/campaigns/pn-engine/outside-kb/team-brain/read", { csrf, on: "1" }),
        /pn-engine's advisors may search "team-brain" from their next round/,
      );
    } finally {
      process.stdout.write = write;
    }
    assert.match(
      outside.copies({ campaign: "pn-engine" })[0]?.last_error ?? "",
      /token \*\*\* is not allowed to write/,
    );
    assert.match(out.join(""), /outside knowledge base sync failed/, "the failure was logged");
    page = await get("/ui/settings");
    assert.match(page, /team-brain/);
    assert.match(page, /token …6789/);
    assert.match(page, /copies pn-engine · read by pn-engine/);
    const campaign = await get("/ui/campaigns/pn-engine");
    assert.match(campaign, /<h2>Outside knowledge bases<\/h2>/);
    assert.match(campaign, /on: its advisors may search it/);
    const seen = JSON.stringify([
      page,
      campaign,
      out.join(""),
      [...fake.pages.values()],
      fake.calls,
      store.db.prepare("select * from audit").all(),
      store.db.prepare("select * from outside_kb").all(),
      store.db.prepare("select * from outside_kb_copy").all(),
      store.db.prepare("select * from kb_item").all(),
    ]);
    assert.ok(!seen.includes(TOKEN), "the token is nowhere but the server's header");
    assert.ok(fake.requests.every((r) => !r.path.includes(TOKEN)));
  });

  test("a granted campaign's rig gets the search with its campaigns; an ungranted one's gets none", async (t) => {
    const { fake, store, outside } = await setup(t);
    seed(store);
    add(outside, fake, { write_tool: null });
    const control = createControlApi(
      store,
      {
        admin: "admin-token-abcdef",
        rigs: { "rig-a": "rig-a-token-abcdef", "rig-b": "rig-b-token-abcdef" },
      },
      generateSigningKeys().privateKeyPem,
      { staleAfterMs: 180_000, outsideKb: outside },
    );
    const routes = async (rig: string) =>
      (
        (await (
          await control.request(`/v1/rigs/${rig}/advisor-routes`, {
            headers: { authorization: `Bearer ${rig}-token-abcdef` },
          })
        ).json()) as { outside_kb: unknown[] }
      ).outside_kb;
    assert.deepEqual(await routes("rig-a"), [], "no campaign is granted yet");
    assert.ok(outside.setRead("team-brain", "pn-engine", true, "owner:test"));
    // A rig's own events naming the campaign are not enough: control must have assigned it.
    assert.deepEqual(await routes("rig-a"), [], "control did not assign pn-engine to rig-a yet");
    assigned(store, "rig-a", "pn-3", "pn-engine");
    assert.deepEqual(outside.readers("team-brain"), ["pn-engine"]);
    assert.deepEqual(await routes("rig-a"), [
      {
        name: "team-brain",
        mcp_url: fake.url,
        token: TOKEN,
        tool: "search",
        campaigns: ["pn-engine"],
      },
    ]);
    assert.deepEqual(await routes("rig-b"), [], "rig-b runs only rl-research");
    // Each change of what a rig gets is in the audit log (names only, never the token).
    await routes("rig-a");
    const handed = store.listAudit(100).filter((a) => a.action === "outside_kb_handed");
    assert.equal(handed.length, 1, "once per change");
    assert.ok(!JSON.stringify(handed).includes(TOKEN));
    // Another rig's token can't read rig-a's routes.
    const other = await control.request("/v1/rigs/rig-a/advisor-routes", {
      headers: { authorization: "Bearer rig-b-token-abcdef" },
    });
    assert.equal(other.status, 401);
    // Taken back, and deleted: no rig gets it.
    outside.setRead("team-brain", "pn-engine", false, "owner:test");
    assert.deepEqual(await routes("rig-a"), []);
    outside.setRead("team-brain", "rl-research", true, "owner:test");
    assert.ok(outside.delete("team-brain", "owner:test"));
    assert.deepEqual(await routes("rig-b"), []);
    assert.equal(
      store.db.prepare("select 1 from kb_read where reads = ?").get(outsideRead("team-brain")),
      undefined,
      "the grants went with it",
    );
  });

  test("a page's slug is stable and safe; the write tool gets only the arguments its schema names", () => {
    const item = {
      id: 1,
      campaign: "PN Engine",
      rig: "rig-a",
      run: "pn-3",
      seq: 7,
      ledger: "ledger-rig-a",
      meta: {},
      kind: "claim" as const,
      ref: "c/7",
      title: 'A title with "quotes"\nand a line',
      body: "---\nnot front matter\n---",
      by: "lane-1",
      url: "https://example.org/paper",
      sub: "draft",
      at: "2026-10-20T01:00:00.000Z",
      updated_at: "2026-10-20T01:00:00.000Z",
    };
    const p = pageOf(item);
    assert.match(p.slug, /^thermite\/pn-engine\/claim\/pn-3-c-7-[0-9a-f]{6}$/);
    // Another ledger of the same rig (after a reset) reusing the run's name: another page.
    assert.notEqual(pageOf({ ...item, ledger: "ledger-2" }).slug, p.slug);
    assert.equal(pageOf({ ...item, title: "changed" }).slug, p.slug, "a change keeps the slug");
    assert.match(p.content, /^---\ntitle: "A title with \\"quotes\\"\\nand a line"\n/);
    assert.match(p.content, /\nurl: "https:\/\/example\.org\/paper"\n/);
    assert.match(
      p.content,
      /\n# A title with "quotes" and a line\n\n---\nnot front matter\n---\n$/,
    );
    assert.deepEqual(Object.keys(writeArgs({ slug: {}, content: {} }, p)), ["slug", "content"]);
    assert.deepEqual(Object.keys(writeArgs(undefined, p)), ["slug", "content"]);
    const a = writeArgs({ slug: {}, content: {}, force: {}, request_id: {} }, p);
    assert.equal(
      a.request_id,
      writeArgs({ request_id: {} }, p).request_id,
      "the same page, the same id",
    );
  });
});
