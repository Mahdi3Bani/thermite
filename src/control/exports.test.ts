import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { uploadExportsOnce } from "../supervisor/export-upload.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";
import { tunnelRouteAllowed } from "./tunnel.ts";

const OWNER = "owner-token-abcdef";
const RIG_A = "rig-a-token-abcdef";
const RIG_B = "rig-b-token-abcdef";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** An export as the harness writes one into the outbox. */
function writeExport(outbox: string, name: string, files: Record<string, Buffer>, full = false) {
  const dir = join(outbox, name);
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify({
      rig: "rig-a",
      ...(full ? { full: true } : {}),
      from_event: 0,
      through_event: 7,
      created_at: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(files).map(([rel, b]) => [rel, sha(b)])),
    })}\n`,
  );
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "thermite-exports-"));
  const outbox = join(root, "outbox");
  mkdirSync(outbox);
  const store = new ControlStore(":memory:");
  const control = createControlApi(
    store,
    { admin: OWNER, rigs: { "rig-a": RIG_A, "rig-b": RIG_B } },
    generateSigningKeys().privateKeyPem,
    { staleAfterMs: 180_000, exportsDir: join(root, "control-exports") },
  );
  let pieces = 0;
  let pieceBytes = 0;
  let breakAfter = Number.POSITIVE_INFINITY;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/file")) {
      if (pieces >= breakAfter) throw new Error("connection reset");
      pieces++;
      pieceBytes += (init?.body as Uint8Array | undefined)?.length ?? 0;
    }
    return control.request(`${url.pathname}${url.search}`, init as RequestInit);
  };
  const cfg = {
    rig: "rig-a",
    outboxDir: outbox,
    controlUrl: "http://control",
    controlToken: RIG_A,
    fetchImpl,
    chunkBytes: 64,
  };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    root,
    outbox,
    store,
    control,
    cfg,
    as,
    sent: () => ({ pieces, bytes: pieceBytes }),
    breakAfter: (n: number) => {
      breakAfter = n;
      pieces = 0;
      pieceBytes = 0;
    },
  };
}

const NAME = "20261020T120000Z-0123abcd";
const files = () => ({
  "events.jsonl": Buffer.from(`${JSON.stringify({ id: 1, kind: "run_created" })}\n`.repeat(20)),
  "journal.jsonl": Buffer.alloc(0),
  "attempts/a-1.patch": Buffer.from("diff --git a/k.c b/k.c\n+faster\n".repeat(10)),
  "champions/r-1/2.patch": Buffer.from("diff --git a/k.c b/k.c\n+champion\n".repeat(5)),
  "ledger.sqlite": Buffer.from("SQLite format 3\0".repeat(30)),
});

describe("exports sent to control", () => {
  test("an export reaches control in pieces, every file checked, and the owner reads it back", async () => {
    const s = setup();
    const f = files();
    writeExport(s.outbox, NAME, f);
    const after = await uploadExportsOnce(s.cfg, { queue: [NAME], uploaded: [] });
    assert.deepEqual(after.queue, []);
    assert.deepEqual(after.uploaded, [NAME]);
    assert.equal(after.lastError, undefined);
    assert.ok(after.lastLedgerAt, "the first export takes the ledger snapshot along");
    assert.ok(s.sent().pieces > 10, "in many pieces");

    const list = (await (
      await s.control.request("/v1/rigs/rig-a/exports", { headers: s.as(OWNER) })
    ).json()) as { exports: Record<string, unknown>[] };
    assert.equal(list.exports.length, 1);
    assert.equal(list.exports[0]?.name, NAME);
    assert.equal(list.exports[0]?.files, 5);
    assert.equal(list.exports[0]?.files_kept, 5);
    assert.ok(list.exports[0]?.complete_at);
    for (const [rel, bytes] of Object.entries(f)) {
      const got = await s.control.request(
        `/v1/rigs/rig-a/exports/${NAME}/file?path=${encodeURIComponent(rel)}`,
        { headers: s.as(OWNER) },
      );
      assert.equal(got.status, 200, rel);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes, rel);
      assert.equal(got.headers.get("x-thermite-sha256"), sha(bytes));
    }
    // On disk in control's folder, with the manifest as the harness wrote it.
    const kept = JSON.parse(
      readFileSync(join(s.root, "control-exports", "rig-a", NAME, "manifest.json"), "utf8"),
    ) as { rig: string; created_at: string };
    assert.equal(kept.rig, "rig-a");
    assert.ok(kept.created_at);

    // The next export within the day leaves its ledger snapshot out; control takes it so.
    const next = "20261020T130000Z-89abcdef";
    writeExport(s.outbox, next, files());
    const again = await uploadExportsOnce(s.cfg, { ...after, queue: [next] });
    assert.deepEqual(again.uploaded, [NAME, next]);
    assert.equal(again.lastLedgerAt, after.lastLedgerAt);
    const one = (await (
      await s.control.request(`/v1/rigs/rig-a/exports/${next}`, { headers: s.as(OWNER) })
    ).json()) as { files: { path: string }[]; complete_at: string | null };
    assert.ok(one.complete_at);
    assert.deepEqual(one.files.map((x) => x.path).sort(), [
      "attempts/a-1.patch",
      "champions/r-1/2.patch",
      "events.jsonl",
      "journal.jsonl",
    ]);
    // A full export always takes it.
    const full = "20261020T140000Z-feedface";
    writeExport(s.outbox, full, files(), true);
    const third = await uploadExportsOnce(s.cfg, { ...again, queue: [full] });
    assert.deepEqual(third.uploaded.at(-1), full);
    assert.ok(s.store.rigExport("rig-a", full)?.files["ledger.sqlite"]);
  });

  test("a broken upload goes on next round where control stopped", async () => {
    const s = setup();
    const f = files();
    const total = Object.values(f).reduce((n, b) => n + b.length, 0);
    writeExport(s.outbox, NAME, f);
    s.breakAfter(6);
    const first = await uploadExportsOnce(s.cfg, { queue: [NAME], uploaded: [] });
    assert.deepEqual(first.queue, [NAME], "it waits for the next round");
    assert.deepEqual(first.uploaded, []);
    assert.match(String(first.lastError), /^upload failed: connection reset/);
    assert.equal(s.store.rigExport("rig-a", NAME)?.complete_at, null);
    s.breakAfter(Number.POSITIVE_INFINITY);
    const second = await uploadExportsOnce(s.cfg, first);
    assert.deepEqual(second.uploaded, [NAME]);
    assert.equal(second.lastError, undefined);
    assert.equal(s.sent().bytes, total - 6 * 64, "only what control did not have yet");
    assert.ok(s.store.rigExport("rig-a", NAME)?.complete_at);
  });

  test("only the rig's own token sends its exports, and only the owner's reads them", async () => {
    const s = setup();
    writeExport(s.outbox, NAME, files());
    const manifest = JSON.parse(readFileSync(join(s.outbox, NAME, "manifest.json"), "utf8"));
    const plan = Object.fromEntries(Object.entries(files()).map(([rel, b]) => [rel, b.length]));
    const begin = (token: string | undefined, rig = "rig-a") =>
      s.control.request(`/v1/rigs/${rig}/exports/${NAME}`, {
        method: "POST",
        headers: { ...(token ? s.as(token) : {}), "content-type": "application/json" },
        body: JSON.stringify({ manifest, files: plan }),
      });
    assert.equal((await begin(undefined)).status, 401, "no token");
    assert.equal((await begin(RIG_B)).status, 401, "another rig's token");
    assert.equal((await begin(OWNER)).status, 401, "the owner's token is not a rig's");
    assert.equal(s.store.rigExport("rig-a", NAME), undefined, "nothing was started");
    const piece = (token: string) =>
      s.control.request(`/v1/rigs/rig-a/exports/${NAME}/file?path=events.jsonl&offset=0`, {
        method: "POST",
        headers: { ...s.as(token), "content-type": "application/octet-stream" },
        body: new Uint8Array(files()["events.jsonl"]),
      });
    assert.equal((await begin(RIG_A)).status, 200);
    assert.equal((await piece(RIG_B)).status, 401);
    assert.equal((await piece(OWNER)).status, 401);
    // Reading back is the owner's alone.
    for (const path of [
      "/v1/rigs/rig-a/exports",
      `/v1/rigs/rig-a/exports/${NAME}`,
      `/v1/rigs/rig-a/exports/${NAME}/file?path=events.jsonl`,
      "/v1/rigs/rig-a/results-left",
    ]) {
      assert.equal((await s.control.request(path, { headers: s.as(RIG_A) })).status, 401, path);
      assert.equal((await s.control.request(path)).status, 401, path);
    }
    // A retired rig sends nothing more.
    s.store.retireAnyRig("rig-a", "owner:test");
    assert.equal((await begin(RIG_A)).status, 403);
    assert.equal((await piece(RIG_A)).status, 403);
    // Through the tunnel to a rig behind a proxy: its sends only, never the owner's reads.
    assert.ok(tunnelRouteAllowed("rp-1", "POST", `/v1/rigs/rp-1/exports/${NAME}`));
    assert.ok(
      tunnelRouteAllowed("rp-1", "POST", `/v1/rigs/rp-1/exports/${NAME}/file?path=a&offset=0`),
    );
    assert.ok(tunnelRouteAllowed("rp-1", "POST", "/v1/rigs/rp-1/champions/r-1/2/patch"));
    assert.ok(!tunnelRouteAllowed("rp-1", "GET", `/v1/rigs/rp-1/exports/${NAME}`));
    assert.ok(!tunnelRouteAllowed("rp-1", "GET", "/v1/rigs/rp-1/exports"));
    assert.ok(!tunnelRouteAllowed("rp-1", "POST", `/v1/rigs/rp-2/exports/${NAME}`));
  });

  test("control keeps only what matches the manifest", async () => {
    const s = setup();
    const f = files();
    writeExport(s.outbox, NAME, f);
    const manifest = JSON.parse(readFileSync(join(s.outbox, NAME, "manifest.json"), "utf8"));
    const plan = Object.fromEntries(Object.entries(f).map(([rel, b]) => [rel, b.length]));
    const begin = (body: unknown, name = NAME) =>
      s.control.request(`/v1/rigs/rig-a/exports/${name}`, {
        method: "POST",
        headers: { ...s.as(RIG_A), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const { "attempts/a-1.patch": _left, ...short } = plan;
    const r1 = await begin({ manifest, files: short });
    assert.equal(r1.status, 400);
    assert.match(String(((await r1.json()) as { error: string }).error), /leaves out attempts/);
    const r2 = await begin({ manifest, files: { ...plan, "extra.bin": 3 } });
    assert.equal(r2.status, 400);
    assert.match(
      String(((await r2.json()) as { error: string }).error),
      /does not list extra\.bin/,
    );
    const bad = { ...manifest, files: { ...manifest.files, "../escape": "a".repeat(64) } };
    assert.equal((await begin({ manifest: bad, files: { ...plan, "../escape": 1 } })).status, 400);
    assert.equal(
      (await begin({ manifest: { ...manifest, rig: "rig-b" }, files: plan })).status,
      400,
    );
    assert.equal((await begin({ manifest, files: plan }, "not-a-name")).status, 400);
    assert.equal((await begin({ manifest, files: plan })).status, 200);
    // The same name with another manifest is refused.
    const other = await begin({ manifest: { ...manifest, through_event: 9 }, files: plan });
    assert.equal(other.status, 409);

    const send = (path: string, offset: number, bytes: Buffer) =>
      s.control.request(
        `/v1/rigs/rig-a/exports/${NAME}/file?path=${encodeURIComponent(path)}&offset=${offset}`,
        {
          method: "POST",
          headers: { ...s.as(RIG_A), "content-type": "application/octet-stream" },
          body: new Uint8Array(bytes),
        },
      );
    const patch = f["attempts/a-1.patch"];
    // A piece at another place than the one control has: it says where it is.
    const off = await send("attempts/a-1.patch", 5, patch.subarray(5));
    assert.equal(off.status, 409);
    assert.equal(((await off.json()) as { received: number }).received, 0);
    // Bytes that are not the manifest's: refused when the last one arrives, and not kept.
    const wrong = Buffer.from(patch);
    wrong[0] = 0x21;
    const r3 = await send("attempts/a-1.patch", 0, wrong);
    assert.equal(r3.status, 422);
    const why = (await r3.json()) as { error: string; received: number };
    assert.match(
      why.error,
      /the SHA-256 of attempts\/a-1\.patch is [0-9a-f]{64}, not the manifest's/,
    );
    assert.equal(why.received, 0, "it starts again from the first byte");
    assert.equal(s.store.rigExport("rig-a", NAME)?.done.length, 0);
    const missing = await s.control.request(
      `/v1/rigs/rig-a/exports/${NAME}/file?path=attempts%2Fa-1.patch`,
      { headers: s.as(OWNER) },
    );
    assert.equal(missing.status, 404, "a file not kept is not served");
    // Past the file's end.
    const long = await send("attempts/a-1.patch", 0, Buffer.concat([patch, Buffer.from("x")]));
    assert.equal(long.status, 400);
    // The right bytes are kept.
    const ok = await send("attempts/a-1.patch", 0, patch);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { received: patch.length, done: true, complete: false });
    assert.deepEqual(s.store.rigExport("rig-a", NAME)?.done, ["attempts/a-1.patch"]);
  });
});
