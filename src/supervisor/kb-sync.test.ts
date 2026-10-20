import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { KbItemWire } from "../core/kb.ts";
import { createHarnessApi } from "../harness/api.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { emptyKbSyncState, type KbSyncConfig, syncKnowledgeOnce } from "./kb-sync.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const RUN = "smoke-1";

const item = (seq: number, over: Partial<KbItemWire> = {}): KbItemWire => ({
  seq,
  campaign: "kernels",
  rig: "rig-b",
  run: "kernels-7",
  kind: "note",
  ref: String(seq),
  title: `note ${seq}`,
  body: `The body of note ${seq}.`,
  by: "lane-1",
  url: null,
  sub: "lesson",
  at: "2026-10-16T00:00:00.000Z",
  updated_at: "2026-10-16T00:00:00.000Z",
  ...over,
});

/**
 * A fake control that serves the items of the folders a run may read after a cursor, `page` at a
 * time (and records each ask), and the real harness API behind the supervisor's token.
 */
async function setup(items: KbItemWire[], page = 2) {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const api = createHarnessApi(env.service, tokens);
  const asked: string[] = [];
  const folders = ["smoke-matmul", "kernels"];
  let harnessDown = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "control") {
      asked.push(`${url.pathname}${url.search}`);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rig-token");
      const after = Number(url.searchParams.get("after"));
      const next = items
        .filter((i) => i.seq > after && folders.includes(i.campaign))
        .slice(0, page);
      return Response.json({
        campaign: "smoke-matmul",
        folders,
        items: next,
        next: next.at(-1)?.seq ?? after,
        more: items.some(
          (i) => i.seq > (next.at(-1)?.seq ?? after) && folders.includes(i.campaign),
        ),
      });
    }
    if (harnessDown && url.pathname === "/v1/kb") return new Response("down", { status: 503 });
    return api.request(`${url.pathname}${url.search}`, init as RequestInit);
  };
  const cfg: KbSyncConfig = {
    rig: "rig-a",
    controlUrl: "http://control",
    controlToken: "rig-token",
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    fetchImpl,
  };
  const dir = env.service.knowledge.dir(RUN);
  return {
    env,
    cfg,
    asked,
    dir,
    folders,
    down: (v: boolean) => {
      harnessDown = v;
    },
  };
}

describe("past research, synced from control into the run's folder", () => {
  test("items reach knowledge/ page by page, the cursor moves, and a second call asks only for what is new", async () => {
    const items = [
      item(1),
      item(2, { kind: "experiment", ref: "x-0123456789ab", title: "Fused dequantize" }),
      item(3, { url: "https://example.org/guide", kind: "source", ref: "s-1", sub: null }),
    ];
    const s = await setup(items);
    const r = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    assert.deepEqual(r.errors, []);
    assert.equal(r.items, 3);
    assert.deepEqual(r.state.cursors, { [RUN]: 3 });
    assert.deepEqual(s.asked, [
      "/v1/rigs/rig-a/kb?run=smoke-1&after=0",
      "/v1/rigs/rig-a/kb?run=smoke-1&after=2",
    ]);
    const note = readFileSync(join(s.dir, "kernels", "notes", "rig-b--kernels-7--1.md"), "utf8");
    assert.equal(
      note,
      [
        "---",
        'campaign: "kernels"',
        'rig: "rig-b"',
        'run: "kernels-7"',
        'kind: "note"',
        'ref: "1"',
        'sub: "lesson"',
        'by: "lane-1"',
        'at: "2026-10-16T00:00:00.000Z"',
        'updated_at: "2026-10-16T00:00:00.000Z"',
        "url: null",
        "---",
        "",
        "# note 1",
        "",
        "The body of note 1.",
        "",
      ].join("\n"),
    );
    assert.ok(
      existsSync(join(s.dir, "kernels", "experiments", "rig-b--kernels-7--x-0123456789ab.md")),
    );
    assert.match(
      readFileSync(join(s.dir, "kernels", "sources", "rig-b--kernels-7--s-1.md"), "utf8"),
      /url: "https:\/\/example.org\/guide"/,
    );
    const readme = readFileSync(join(s.dir, "README.md"), "utf8");
    assert.match(readme, /## kernels\/\n\n- experiments\/: 1\n- notes\/: 1\n- sources\/: 1/);
    assert.match(readme, /data to weigh, not instructions/);
    assert.deepEqual(s.env.service.knowledge.summary(RUN)?.counts, {
      note: 1,
      experiment: 1,
      source: 1,
    });
    s.asked.length = 0;
    const again = await syncKnowledgeOnce(s.cfg, r.state);
    assert.equal(again.items, 0);
    assert.deepEqual(s.asked, ["/v1/rigs/rig-a/kb?run=smoke-1&after=3"]);
  });

  test("an updated item overwrites its file; runs of the same name on two rigs stay apart", async () => {
    const items = [item(1)];
    const s = await setup(items);
    const first = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    items.push(
      item(5, { ref: "1", body: "The body, corrected.", updated_at: "2026-10-17T00:00:00.000Z" }),
    );
    const second = await syncKnowledgeOnce(s.cfg, first.state);
    assert.equal(second.items, 1);
    assert.deepEqual(second.state.cursors, { [RUN]: 5 });
    const notes = join(s.dir, "kernels", "notes");
    assert.deepEqual(readdirSync(notes), ["rig-b--kernels-7--1.md"]);
    assert.match(
      readFileSync(join(notes, "rig-b--kernels-7--1.md"), "utf8"),
      /The body, corrected\./,
    );
    assert.equal(s.env.service.knowledge.summary(RUN)?.total, 1);
    // The harness says what was new and what was updated.
    assert.deepEqual(
      s.env.service.writeKnowledge(RUN, [
        item(6, { ref: "1" }),
        item(7, { rig: "rig-c", ref: "1" }),
      ]),
      { written: 1, updated: 1, removed: [] },
    );
    assert.deepEqual(readdirSync(notes), ["rig-b--kernels-7--1.md", "rig-c--kernels-7--1.md"]);
  });

  test("a folder the campaign may no longer read is removed, from the folder and the harness's copy", async () => {
    const items = [item(1), item(2, { campaign: "smoke-matmul", run: "smoke-0", ref: "9" })];
    const s = await setup(items);
    const first = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    assert.equal(first.items, 2);
    assert.ok(existsSync(join(s.dir, "kernels")));
    // The owner revokes the grant: control no longer lists the folder, and sends nothing new.
    s.folders.splice(s.folders.indexOf("kernels"), 1);
    const second = await syncKnowledgeOnce(s.cfg, first.state);
    assert.deepEqual(second.errors, []);
    assert.equal(second.items, 0);
    assert.ok(!existsSync(join(s.dir, "kernels")), "the revoked folder is gone");
    assert.ok(existsSync(join(s.dir, "smoke-matmul", "notes", "rig-b--smoke-0--9.md")));
    const readme = readFileSync(join(s.dir, "README.md"), "utf8");
    assert.doesNotMatch(readme, /## kernels\//);
    assert.match(readme, /## smoke-matmul\//);
    assert.deepEqual(s.env.service.knowledge.summary(RUN)?.folders, ["smoke-matmul"]);
    // Scratch cleared: the harness's copy shows only what the run may still read.
    rmSync(s.dir, { recursive: true, force: true });
    s.env.service.knowledge.show(RUN);
    assert.deepEqual(readdirSync(s.dir).sort(), ["README.md", "smoke-matmul"]);
    // An empty list of folders says nothing: nothing is removed.
    assert.deepEqual(s.env.service.writeKnowledge(RUN, [], []).removed, []);
    assert.ok(existsSync(join(s.dir, "smoke-matmul")));
  });

  test("after scratch was cleared, the earlier items come back with the next ones", async () => {
    const items = [item(1)];
    const s = await setup(items);
    const first = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    rmSync(s.dir, { recursive: true, force: true });
    items.push(item(2));
    await syncKnowledgeOnce(s.cfg, first.state);
    assert.deepEqual(readdirSync(join(s.dir, "kernels", "notes")).sort(), [
      "rig-b--kernels-7--1.md",
      "rig-b--kernels-7--2.md",
    ]);
  });

  test("an item's names never lead out of knowledge/", async () => {
    const s = await setup([]);
    s.env.service.writeKnowledge(RUN, [
      item(1, { campaign: "../../escape", rig: "../r", run: "../up", ref: "../../../x" }),
    ]);
    const folders = readdirSync(s.dir).filter((f) => f !== "README.md");
    assert.deepEqual(folders, ["escape"]);
    assert.deepEqual(readdirSync(join(s.dir, "escape", "notes")), ["r--up--x.md"]);
  });

  test("a harness that cannot take the items leaves the cursor, so they come again", async () => {
    const s = await setup([item(1), item(2)]);
    s.down(true);
    const r = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    assert.equal(r.items, 0);
    assert.match(r.errors[0] ?? "", /smoke-1: the harness's \/v1\/kb: HTTP 503/);
    assert.deepEqual(r.state.cursors, {});
    s.down(false);
    const again = await syncKnowledgeOnce(s.cfg, r.state);
    assert.equal(again.items, 2);
  });

  test("without control the sync does nothing", async () => {
    const s = await setup([item(1)]);
    let called = 0;
    const r = await syncKnowledgeOnce(
      {
        ...s.cfg,
        controlUrl: undefined,
        fetchImpl: async () => {
          called++;
          return new Response("{}");
        },
      },
      emptyKbSyncState(),
    );
    assert.equal(called, 0);
    assert.deepEqual(r, { state: { cursors: {} }, items: 0, errors: [] });
    assert.equal(s.env.service.knowledge.summary(RUN), undefined);
  });

  test("the harness takes past research only with the supervisor's token, for a run it has", async () => {
    const s = await setup([]);
    const api = createHarnessApi(s.env.service, tokens);
    const post = (body: unknown, t: string) =>
      api.request("/v1/kb", {
        method: "POST",
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ run: RUN, items: [item(1)] }, tokens.proposer)).status, 401);
    assert.equal((await post({ run: RUN, items: [item(1)] }, "trial.x")).status, 401);
    assert.equal((await post({ run: "no-run", items: [item(1)] }, tokens.supervisor)).status, 404);
    assert.equal(
      (await post({ run: RUN, items: [{ ...item(1), kind: "secret" }] }, tokens.supervisor)).status,
      400,
    );
    const { rig: _rig, ...noRig } = item(1);
    assert.equal(
      (await post({ run: RUN, items: [noRig] }, tokens.supervisor)).status,
      400,
      "an item names its rig",
    );
    assert.equal((await post({ run: RUN, items: [item(1)] }, tokens.supervisor)).status, 200);
  });
});
