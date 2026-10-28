import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { foldLive, LiveTaken } from "../../../src/control/live/index.ts";
import { CLIENT_JS } from "../../../src/control/ui/client.ts";
import { LIVE_STREAM_CONFIG } from "../../../src/core/link/live.ts";
import { LiveLog } from "../../../src/core/live.ts";
import {
  LiveCounts,
  type LiveRelayState,
  publishLiveOnce,
  relayLiveOnce,
} from "../../../src/supervisor/live/index.ts";
import { signIn } from "../../helpers/control-stack.ts";
import { asMessage, FakeBus } from "../../helpers/fake-bus.ts";
import { type PushedEvent, pushedOf, readPushed } from "../../helpers/sse.ts";
import { stack } from "./stack.ts";

/**
 * Live's push (goal 168, step 2): a run's Live page and a rig's get their new lines as server-sent
 * events from control, under the page's own address, whether control got the lines over HTTP or
 * from the message bus. A reader that connects again goes on after the last line it had.
 */

type Lines = { entries: { id: number; html: string }[] };

/** A rig with run js-1 at work, the owner signed in, and the newest line control has. */
async function setup() {
  const s = await stack();
  await s.env.service.applyCommand(s.env.assign);
  await s.relay();
  const { cookie } = await signIn(s.control);
  const open = (path: string, headers: Record<string, string> = {}) =>
    s.control.request(path, { headers: { cookie, ...headers } });
  const newest = () => s.store.liveLines.tail("rig-a", 1).at(-1)?.id ?? 0;
  const texts = (events: PushedEvent[]) =>
    pushedOf<Lines>(events, "lines").flatMap((l) => l.entries.map((e) => e.html));
  return { ...s, open, newest, texts };
}

const RUN = "/ui/campaigns/js-sum/runs/js-1/live";

describe("Live's push", () => {
  test("a run's page gets its new lines as control gets them, over HTTP or from the bus alike", async () => {
    const s = await setup();
    const reading = readPushed(await s.open(`${RUN}/stream?after=${s.newest()}`), (e) => {
      const said = s.texts(e).join("\n");
      return said.includes("from the bus") && said.includes("over HTTP");
    });
    // Over HTTP, as a rig without the bus sends them.
    const http = {
      rig: "rig-a",
      harnessUrl: s.cfg.harnessUrl,
      harnessToken: s.cfg.harnessToken,
      controlUrl: s.cfg.controlUrl,
      controlToken: s.cfg.controlToken,
      fetchImpl: s.cfg.fetchImpl,
    };
    s.env.service.live.append({
      source: "planner",
      kind: "status",
      text: "over HTTP",
      run: "js-1",
    });
    const at: LiveRelayState = await relayLiveOnce(http, { cursor: 0, ownCursor: 0 });
    // From the bus, as control's consumer folds a rig's messages.
    const bus = new FakeBus();
    await bus.makeStream(LIVE_STREAM_CONFIG);
    s.env.service.live.append({ source: "judge", kind: "log", text: "from the bus", run: "js-1" });
    const own = new LiveLog();
    await publishLiveOnce({ ...http, bus, counts: new LiveCounts(), own }, at);
    const taken = new LiveTaken();
    for (const m of bus.kept) foldLive({ store: s.store, taken }, asMessage(m));
    assert.equal(taken.lines, 1);
    const events = await reading;
    const said = s.texts(events);
    assert.ok(said.some((h) => h.includes("over HTTP")));
    assert.ok(said.some((h) => h.includes("from the bus")));
    assert.ok(
      said.every((h) => h.includes("data-who=")),
      "each line as the run's page draws it",
    );
    assert.equal(events[0]?.event, "retry", "the browser is told how soon to connect again");
  });

  test("a reader that connects again goes on after the last line it had, and gets none twice", async () => {
    const s = await setup();
    const add = (text: string) =>
      s.store.liveLines.add(
        "rig-a",
        "log-push",
        [
          {
            seq: s.newest() + 1,
            at: new Date().toISOString(),
            source: "judge",
            kind: "log",
            text,
            run: "js-1",
          },
        ],
        true,
      );
    add("first");
    const before = s.newest() - 1;
    const first = await readPushed(await s.open(`${RUN}/stream?after=${before}`), (e) =>
      e.some((x) => x.event === "lines"),
    );
    const last = first.filter((x) => x.event === "lines").at(-1)?.id;
    assert.equal(last, String(s.newest()));
    // Away: two lines come. Its browser connects again with its last event's id, and the page's
    // first address, whose `after` is older.
    add("second");
    add("third");
    const again = await readPushed(
      await s.open(`${RUN}/stream?after=${before}`, { "last-event-id": last ?? "" }),
      (e) => e.some((x) => x.event === "lines"),
    );
    const said = s.texts(again);
    assert.equal(said.length, 2);
    assert.match(said[0] ?? "", /second/);
    assert.match(said[1] ?? "", /third/);
  });

  test("a rig's page gets its lines, of one source when it shows one", async () => {
    const s = await setup();
    const after = s.newest();
    s.env.service.live.append({
      source: "planner",
      kind: "status",
      text: "the planner's",
      run: "js-1",
    });
    s.env.service.live.append({ source: "judge", kind: "log", text: "the judge's" });
    const http = {
      rig: "rig-a",
      harnessUrl: s.cfg.harnessUrl,
      harnessToken: s.cfg.harnessToken,
      controlUrl: s.cfg.controlUrl,
      controlToken: s.cfg.controlToken,
      fetchImpl: s.cfg.fetchImpl,
    };
    await relayLiveOnce(http, { cursor: 0, ownCursor: 0 });
    const read = async (q: string) =>
      s.texts(
        await readPushed(await s.open(`/ui/rigs/rig-a/live/stream?after=${after}${q}`), (e) =>
          e.some((x) => x.event === "lines"),
        ),
      );
    const all = await read("");
    assert.equal(all.length, 2);
    const judge = await read("&source=judge");
    assert.equal(judge.length, 1);
    assert.match(judge[0] ?? "", /the judge's/);
  });

  test("the push is under the page's address, the page allows it, and the poll it replaced is gone", async () => {
    const s = await setup();
    const page = await s.open(RUN);
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.match(
      await page.text(),
      /data-stream="\/ui\/campaigns\/js-sum\/runs\/js-1\/live\/stream"/,
    );
    const rig = await (await s.open("/ui/rigs/rig-a/live")).text();
    assert.match(rig, /data-stream="\/ui\/rigs\/rig-a\/live\/stream"/);
    for (const gone of [`${RUN}.json`, "/ui/rigs/rig-a/live.json"])
      assert.equal((await s.open(gone)).status, 404, gone);
    assert.equal((await s.open("/ui/campaigns/js-sum/runs/nope/live/stream")).status, 404);
    assert.equal((await s.open("/ui/rigs/rig-z/live/stream")).status, 404);
    const res = await s.open(`${RUN}/stream`);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    await res.body?.cancel();
    // Signed out, nothing is pushed.
    const out = await s.control.request(`${RUN}/stream`);
    assert.notEqual(out.status, 200);
    // The page's script listens to the push, and polls no more.
    assert.doesNotThrow(() => new Function(CLIENT_JS));
    assert.match(CLIENT_JS, /new EventSource\(lines \+ "\?" \+ q\)/);
    for (const kind of ["lines", "redrawn", "missed", "beat"])
      assert.match(CLIENT_JS, new RegExp(`addEventListener\\("${kind}"`));
    assert.doesNotMatch(CLIENT_JS, /setInterval\(poll/);
  });
});
