import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deriveKeys, SnapshotRefused, seal, unseal } from "../../../src/harness/broker/seal.ts";
import {
  backupLedger,
  closedTo,
  inSnapshotFolder,
  inspectSnapshotFolder,
  LEDGER_FILE,
  layoutProblem,
  leftOut,
  liveHolds,
  lookWords,
  removeUnsealed,
  restoreSnapshot,
  SEALED,
  type SnapshotArea,
  type SnapshotJob,
  type SnapshotManifest,
  Snapshotter,
  snapshotAreas,
  takeSnapshot,
} from "../../../src/harness/broker/snapshot.ts";

/**
 * The rig's state over a stop that empties the container's disk (a RunPod pod): live on the
 * container's disk, a sealed snapshot on the volume. These tests take snapshots of a live tree,
 * restore them onto an empty one, tamper with them, and check what a snapshot never takes or
 * restores.
 */

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const RIG = "rp-test0001";

/** A rig's live state under `root/live`, with every part, its snapshot folder and its key. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "thermite-snapshot-"));
  const live = join(root, "live");
  const dir = join(root, "volume", "thermite");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const areas: SnapshotArea[] = [
    { name: "harness", live: join(live, "harness"), uid, gid },
    { name: "outbox", live: join(live, "outbox"), uid, gid },
    { name: "inbox", live: join(live, "inbox"), uid, gid },
    { name: "supervisor", live: join(live, "supervisor"), uid, gid },
    { name: "secrets", live: join(live, "secrets"), uid, gid, only: "supervisor-token" },
  ];
  const put = (path: string, text: string, mode = 0o644) => {
    mkdirSync(dirname(join(live, path)), { recursive: true });
    writeFileSync(join(live, path), text);
    chmodSync(join(live, path), mode);
  };
  const key = randomBytes(32);
  const keys = deriveKeys(key);
  const take = (reason: string, o: { backup?: (s: string) => Promise<string> } = {}) =>
    takeSnapshot({
      dir,
      areas,
      reason,
      keys,
      rig: RIG,
      backupLedger: o.backup ?? stagedBackup(root),
    });
  const restore = (o: { keys?: typeof keys; rig?: string; areas?: SnapshotArea[] } = {}) =>
    restoreSnapshot({
      dir,
      areas: o.areas ?? areas,
      keys: o.keys ?? keys,
      rig: o.rig ?? RIG,
      own: () => undefined,
    });
  return { root, live, dir, areas, put, key, keys, take, restore };
}

/** A ledger in WAL mode, as the harness keeps it, with `rows` rows in each of two tables. */
function makeLedger(path: string, rows = 3): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; create table a (n integer); create table b (n integer);");
  for (let i = 0; i < rows; i++) {
    db.prepare("insert into a values (?)").run(i);
    db.prepare("insert into b values (?)").run(i);
  }
  db.close();
}

const rowsIn = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    return {
      ok: (db.prepare("pragma integrity_check").get() as Record<string, string>).integrity_check,
      a: one("select count(*) as n from a"),
      b: one("select count(*) as n from b"),
    };
  } finally {
    db.close();
  }
};

/** The ledger's copy for a take, made in-process as the broker's helper makes it. */
const stagedBackup = (root: string) => async (source: string) => {
  const copy = join(root, `staged-${Math.random().toString(36).slice(2)}.db`);
  await backupLedger(source, copy);
  return copy;
};

/** A typical live state: the ledger, a kit, a build, an export, the supervisor's keys, a token. */
function typicalState(f: ReturnType<typeof fixture>): void {
  makeLedger(join(f.live, "harness", LEDGER_FILE));
  chmodSync(join(f.live, "harness", "ledger"), 0o700);
  f.put("harness/ledger/rig-signing.key", "rig key", 0o600);
  f.put("harness/kits/abc/kit.json", '{"kit":1}');
  f.put("harness/builds/k1/bin/run", "#!/bin/sh\n", 0o755);
  chmodSync(join(f.live, "harness", "builds"), 0o711);
  f.put("harness/rig-settings.json", "{}", 0o600);
  f.put("outbox/20261022-aaaa/manifest.json", "{}", 0o640);
  f.put("outbox/.tmp-20261022-bbbb/manifest.json", "half written");
  f.put("inbox/models/m.bin", "weights", 0o640);
  f.put("supervisor/tunnel/keys.json", '{"sign":"private"}', 0o600);
  chmodSync(join(f.live, "supervisor", "tunnel"), 0o700);
  f.put("supervisor/enrolled/control.pub", "control key");
  f.put("supervisor/enrolled/rig.env", "THERMITE_RIG_ID=rig-1\n");
  f.put("supervisor/relay-state.json", '{"cursor":7}', 0o600);
  f.put("supervisor/tmp/scratch", "temporary");
  f.put("supervisor/harness-token", "copy of the token", 0o600);
  f.put("secrets/supervisor-token", "the token", 0o600);
  f.put("secrets/other", "not ours");
}

/** Every file under `path` with its contents and mode, as a sorted list. */
function tree(path: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const name of readdirSync(p).sort()) {
      const q = join(p, name);
      const st = lstatSync(q);
      const rel = relative(path, q);
      if (st.isDirectory()) {
        out.push(`${rel}/ ${(st.mode & 0o7777).toString(8)}`);
        walk(q);
      } else out.push(`${rel} ${(st.mode & 0o7777).toString(8)} ${readFileSync(q, "utf8")}`);
    }
  };
  walk(path);
  return out;
}

/** The snapshot's manifest, opened with the pod's keys. */
const manifestOf = (f: ReturnType<typeof fixture>, name: string = SEALED.manifest) =>
  JSON.parse(
    unseal(f.keys.manifest, "manifest", readFileSync(join(f.dir, name))).toString("utf8"),
  ) as SnapshotManifest;

/** Writes `m` as the snapshot's manifest, sealed with `keys` (a manifest under the right key). */
const writeManifest = (f: ReturnType<typeof fixture>, m: SnapshotManifest) =>
  writeFileSync(
    join(f.dir, SEALED.manifest),
    seal(f.keys.manifest, "manifest", Buffer.from(JSON.stringify(m))),
  );

/** The sealed file a path of a part is in. */
const sealedOf = (f: ReturnType<typeof fixture>, label: string) => {
  const e = manifestOf(f).entries.find((x) => `${x.area}/${x.path}` === label);
  assert.ok(e?.sealed, `${label} is in the snapshot`);
  return join(f.dir, e.sealed);
};

/** A restore that must be refused whole: nothing restored, no staging folder left. */
function refusedWhole(f: ReturnType<typeof fixture>, why: RegExp, o = {}): void {
  rmSync(f.live, { recursive: true, force: true });
  assert.throws(
    () => f.restore(o),
    (err: Error) => err instanceof SnapshotRefused && why.test(err.message),
  );
  assert.deepEqual(
    existsSync(f.live) ? readdirSync(f.live) : [],
    [],
    "nothing is restored, and no staging folder is left",
  );
}

/** A restore of the snapshot into a fresh folder of its own, as onto a fresh disk. */
let asides = 0;
const restoreAside = (f: ReturnType<typeof fixture>) =>
  f.restore({
    areas: f.areas.map((a) => ({ ...a, live: join(f.root, `aside-${++asides}`, a.name) })),
  });

describe("the rig's sealed state snapshot (broker/snapshot.ts)", () => {
  test("a snapshot seals the live state, and a restore onto an empty disk puts it back with owners and modes", async () => {
    const f = fixture();
    typicalState(f);
    const r = await f.take("at the stop");
    assert.equal(r.ledger, true);
    assert.equal(r.seq, 1);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.reused + r.sealed, r.files);
    // The folder holds the manifest and sealed files named by a keyed hash, nothing else; no
    // byte of what the live state holds shows in any of them.
    const names = readdirSync(f.dir).sort();
    assert.ok(names.includes(SEALED.manifest));
    assert.ok(names.filter((n) => n !== SEALED.manifest).every((n) => /^[0-9a-f]{64}$/.test(n)));
    for (const n of names) {
      const bytes = readFileSync(join(f.dir, n));
      assert.equal(bytes.subarray(0, 8).toString("latin1"), "THMSEAL1", n);
      for (const secret of [
        "rig key",
        "private",
        "the token",
        "weights",
        '{"kit":1}',
        "cursor",
        "SQLite format",
      ])
        assert.ok(!bytes.includes(Buffer.from(secret)), `${secret} shows in ${n}`);
    }
    assert.deepEqual(inspectSnapshotFolder(f.dir), {
      manifest: true,
      files: names.length - 1,
    });
    const manifest = manifestOf(f);
    assert.equal(manifest.rig, RIG);
    assert.equal(manifest.reason, "at the stop");
    const labels = manifest.entries.map((e) => `${e.area}/${e.path}`);
    // What a snapshot never holds: the write-ahead files, an export still being written, the
    // supervisor's temporary folder and its copy of the token, other files beside the token.
    for (const out of [
      "harness/ledger/ledger.db-wal",
      "harness/ledger/ledger.db-shm",
      "outbox/.tmp-20261022-bbbb",
      "supervisor/tmp",
      "supervisor/harness-token",
      "secrets/other",
    ])
      assert.ok(!labels.includes(out), `${out} is not in the snapshot`);
    assert.ok(labels.includes("supervisor/tunnel/keys.json"));
    assert.ok(labels.includes("secrets/supervisor-token"));
    // The manifest binds every file: its sealed name, its SHA-256, its size, owner and mode.
    const keysEntry = manifest.entries.find((e) => e.path === "tunnel/keys.json");
    assert.equal(keysEntry?.size, '{"sign":"private"}'.length);
    assert.match(keysEntry?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(keysEntry?.mode, 0o600);
    assert.equal(keysEntry?.uid, uid);

    // The pod stops: its disk is emptied, the volume stays.
    const before = tree(f.live).filter(
      (l) =>
        !/^(outbox\/\.tmp|supervisor\/tmp|supervisor\/harness-token|secrets\/other|harness\/ledger\/ledger\.db)/.test(
          l,
        ),
    );
    rmSync(f.live, { recursive: true, force: true });
    assert.deepEqual(liveHolds(f.areas), []);
    const owned: string[] = [];
    const restored = restoreSnapshot({
      dir: f.dir,
      areas: f.areas,
      keys: f.keys,
      rig: RIG,
      own: (path, u, g) => {
        assert.equal(u, uid);
        assert.equal(g, gid);
        owned.push(path);
      },
    });
    assert.ok(restored);
    assert.deepEqual(restored.refused, []);
    assert.equal(restored.from, SEALED.manifest);
    assert.equal(restored.seq, 1);
    assert.equal(restored.taken_at, manifest.taken_at);
    assert.equal(restored.areas.supervisor?.files, 4);
    assert.equal(restored.areas.secrets?.files, 1);
    const after = tree(f.live).filter((l) => !/^harness\/ledger\/ledger\.db/.test(l));
    assert.deepEqual(after, before, "every file and folder is back, with its mode");
    assert.deepEqual(rowsIn(join(f.live, "harness", LEDGER_FILE)), { ok: "ok", a: 3, b: 3 });
    // Every owner it set is on the live side: nothing under the snapshot folder.
    assert.ok(owned.length > 10);
    for (const p of owned)
      assert.ok(!relative(f.dir, p).match(/^[^.]/), `${p} is not on the volume`);
    // Nothing in the snapshot folder changed.
    assert.deepEqual(readdirSync(f.dir).sort(), names);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("the ledger's copy is consistent while the ledger is written", async () => {
    const f = fixture();
    const ledger = join(f.live, "harness", LEDGER_FILE);
    makeLedger(ledger, 0);
    // Another process writes the ledger all the time: one row in each table per transaction.
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("pragma busy_timeout=5000");const end=Date.now()+2500;let i=0;while(Date.now()<end){db.exec("begin");db.prepare("insert into a values (?)").run(i);db.prepare("insert into b values (?)").run(i);db.exec("commit");i++}db.close()`,
        ledger,
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise((r) => writer.on("exit", r));
    await new Promise((r) => setTimeout(r, 300));
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await takeSnapshot({
        dir: f.dir,
        areas: f.areas.slice(0, 1),
        reason: `while written ${i}`,
        keys: f.keys,
        rig: RIG,
        backupLedger: stagedBackup(f.root),
      });
      assert.equal(r.ledger, true);
      // Restored elsewhere, as onto a fresh disk.
      const back: SnapshotArea = { name: "harness", live: join(f.root, `back-${i}`), uid, gid };
      f.restore({ areas: [back] });
      const copy = rowsIn(join(back.live, LEDGER_FILE));
      assert.equal(copy.ok, "ok");
      assert.equal(copy.a, copy.b, "no transaction is half in the copy");
      seen.push(copy.a);
      await new Promise((r) => setTimeout(r, 200));
    }
    await exited;
    assert.ok(seen[0] !== undefined && seen[0] > 0, "the copy holds what was written");
    assert.ok((seen.at(-1) ?? 0) > (seen[0] ?? 0), `later copies hold more: ${seen.join(", ")}`);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a new manifest is swapped in by rename; the snapshot before stays until it is complete", async () => {
    const f = fixture();
    typicalState(f);
    await f.take("first");
    const first = readFileSync(join(f.dir, SEALED.manifest));
    const firstNames = readdirSync(f.dir).sort();
    // A take that fails (here, the ledger's copy) leaves the snapshot before it as it was.
    f.put("harness/kits/abc/kit.json", '{"kit":2}');
    await assert.rejects(
      f.take("fails", {
        backup: async () => {
          throw new Error("no ledger copy");
        },
      }),
      /no ledger copy/,
    );
    assert.deepEqual(readdirSync(f.dir).sort(), firstNames);
    assert.deepEqual(readFileSync(join(f.dir, SEALED.manifest)), first);
    // A take stopped half way (the pod killed): a manifest.new cut short and a file half sealed.
    writeFileSync(join(f.dir, SEALED.next), first.subarray(0, 40));
    writeFileSync(join(f.dir, `.new-${"0".repeat(32)}`), first.subarray(0, 20));
    assert.equal(
      restoreAside(f)?.reason,
      "first",
      "a manifest.new that does not verify never counts",
    );
    const second = await f.take("second");
    assert.equal(second.seq, 2);
    assert.ok(!readdirSync(f.dir).includes(SEALED.next));
    assert.ok(!readdirSync(f.dir).some((n) => n.startsWith(".new-")), "what it left is gone");
    assert.equal(manifestOf(f).reason, "second");
    // Stopped between writing manifest.new and its rename: complete, and it counts.
    await f.take("third");
    renameSync(join(f.dir, SEALED.manifest), join(f.dir, SEALED.next));
    const r = restoreAside(f);
    assert.equal(r?.from, SEALED.next);
    assert.equal(r?.reason, "third");
    // The next take puts it in place first, and counts on from it.
    const fourth = await f.take("fourth");
    assert.equal(fourth.seq, 4);
    assert.deepEqual(
      readdirSync(f.dir).filter((n) => !/^[0-9a-f]{64}$/.test(n)),
      [SEALED.manifest],
    );
    rmSync(f.root, { recursive: true, force: true });
  });

  test("incremental: an unchanged file is not read again, the same content is sealed once, and what no manifest names goes", async () => {
    const f = fixture();
    typicalState(f);
    f.put("harness/a-copy.json", '{"kit":1}');
    const first = await f.take("first");
    // The same content in two files: one sealed file.
    const m1 = manifestOf(f);
    const kit = m1.entries.find((e) => e.path === "kits/abc/kit.json");
    const copy = m1.entries.find((e) => e.path === "a-copy.json");
    assert.ok(kit?.sealed && kit.sealed === copy?.sealed);
    // a-copy.json is kit.json's content; rig-settings.json and the export's manifest are both {}.
    assert.equal(first.reused, 2);
    // A file no one may read now, unchanged: the next take does not open it.
    chmodSync(join(f.live, "inbox", "models", "m.bin"), 0);
    f.put("harness/kits/abc/kit.json", '{"kit":2}');
    const second = await f.take("second");
    chmodSync(join(f.live, "inbox", "models", "m.bin"), 0o640);
    assert.deepEqual(second.skipped, []);
    assert.ok(
      second.sealed <= 2,
      `sealed ${second.sealed}: the changed kit, and the ledger's copy`,
    );
    assert.ok(second.reused >= second.files - 2, `reused ${second.reused} of ${second.files}`);
    // The old kit's sealed file is still named (a-copy.json); one named by none goes.
    const m2 = manifestOf(f);
    const named = new Set(m2.entries.flatMap((e) => (e.sealed ? [e.sealed] : [])));
    assert.deepEqual(
      readdirSync(f.dir)
        .filter((n) => n !== SEALED.manifest)
        .sort(),
      [...named].sort(),
      "the folder holds exactly the sealed files the manifest names",
    );
    rmSync(join(f.live, "harness", "a-copy.json"));
    const third = await f.take("third");
    assert.ok(third.removed >= 1, "the first kit's sealed file is named by none now");
    assert.ok(!existsSync(join(f.dir, kit.sealed)));
    // A sealed file someone removed is sealed again, though its file did not change.
    const keysFile = sealedOf(f, "supervisor/tunnel/keys.json");
    rmSync(keysFile);
    const fourth = await f.take("fourth");
    assert.ok(fourth.sealed >= 1);
    assert.ok(existsSync(keysFile));
    rmSync(f.live, { recursive: true, force: true });
    assert.deepEqual(f.restore()?.refused, []);
    assert.equal(
      readFileSync(join(f.live, "harness", "kits", "abc", "kit.json"), "utf8"),
      '{"kit":2}',
    );
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a changed sealed file, manifest or name, a missing file and another pod's snapshot are each refused whole", async () => {
    const f = fixture();
    typicalState(f);
    f.put("harness/a.txt", "aaaa");
    f.put("harness/b.txt", "bbbb");
    await f.take("kept");
    const saved = join(f.root, "saved");
    const save = () => {
      rmSync(saved, { recursive: true, force: true });
      mkdirSync(saved);
      for (const n of readdirSync(f.dir))
        writeFileSync(join(saved, n), readFileSync(join(f.dir, n)));
    };
    const back = () => {
      rmSync(f.dir, { recursive: true, force: true });
      mkdirSync(f.dir);
      for (const n of readdirSync(saved))
        writeFileSync(join(f.dir, n), readFileSync(join(saved, n)));
    };
    save();
    // One byte of a sealed file.
    const keysFile = sealedOf(f, "supervisor/tunnel/keys.json");
    const bytes = readFileSync(keysFile);
    bytes[30] = (bytes[30] as number) ^ 1;
    writeFileSync(keysFile, bytes);
    refusedWhole(f, /^supervisor\/tunnel\/keys\.json: it did not verify/);
    back();
    // One byte of the manifest.
    const m = readFileSync(join(f.dir, SEALED.manifest));
    m[40] = (m[40] as number) ^ 1;
    writeFileSync(join(f.dir, SEALED.manifest), m);
    refusedWhole(f, /^its manifest: it did not verify/);
    back();
    // Two sealed files of the same size, each under the other's name.
    const a = sealedOf(f, "harness/a.txt");
    const b = sealedOf(f, "harness/b.txt");
    renameSync(a, join(f.root, "swap"));
    renameSync(b, a);
    renameSync(join(f.root, "swap"), b);
    refusedWhole(f, /^harness\/a\.txt: its content is not the one the manifest names/);
    back();
    // A sealed file cut short, and one gone.
    writeFileSync(a, readFileSync(a).subarray(0, 30));
    refusedWhole(f, /^harness\/a\.txt: its sealed file is 30 bytes/);
    back();
    rmSync(b);
    refusedWhole(f, /^harness\/b\.txt: its sealed file is missing/);
    back();
    // A link in a sealed file's place.
    rmSync(b);
    symlinkSync(join(f.live, "harness", "b.txt"), b);
    refusedWhole(f, /^harness\/b\.txt: its sealed file is a link/);
    back();
    // Another pod's snapshot (its own key), swapped in whole: its manifest does not open.
    const other = fixture();
    typicalState(other);
    await other.take("another pod's");
    rmSync(f.dir, { recursive: true, force: true });
    renameSync(other.dir, f.dir);
    refusedWhole(f, /^its manifest: it did not verify/);
    // Only its manifest, beside this pod's files: refused too.
    back();
    mkdirSync(other.dir, { recursive: true });
    await other.take("another pod's, again");
    writeFileSync(join(f.dir, SEALED.manifest), readFileSync(join(other.dir, SEALED.manifest)));
    refusedWhole(f, /^its manifest: it did not verify/);
    back();
    // This pod's key but another rig's snapshot.
    refusedWhole(f, /^it is rig rp-test0001's, not rig rp-other's/, { rig: "rp-other" });
    // With nothing changed, it restores.
    rmSync(f.live, { recursive: true, force: true });
    assert.deepEqual(f.restore()?.refused, []);
    assert.equal(readFileSync(join(f.live, "harness", "a.txt"), "utf8"), "aaaa");
    rmSync(other.root, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a snapshot takes no link, pipe or other user's file; a manifest's names are checked even when it verifies", async () => {
    const f = fixture();
    typicalState(f);
    const secret = join(f.root, "root-only-secret");
    writeFileSync(secret, "root's secret");
    symlinkSync(secret, join(f.live, "supervisor", "keys-link"));
    spawnSync("mkfifo", [join(f.live, "inbox", "pipe")]);
    // A part whose files are another user's (the broker checks owners as root): none is taken.
    const areas = f.areas.map((a) => (a.name === "outbox" ? { ...a, uid: uid + 1 } : a));
    const r = await takeSnapshot({
      dir: f.dir,
      areas,
      reason: "with strangers",
      keys: f.keys,
      rig: RIG,
      backupLedger: stagedBackup(f.root),
    });
    assert.ok(r.skipped.includes("supervisor/keys-link: a link"), r.skipped.join("; "));
    assert.ok(r.skipped.includes("inbox/pipe: not a plain file or folder"), r.skipped.join("; "));
    assert.ok(r.skipped.some((s) => s.startsWith("outbox/: owned by uid")));
    const labels = manifestOf(f).entries.map((e) => `${e.area}/${e.path}`);
    assert.ok(!labels.includes("supervisor/keys-link"));
    assert.ok(!labels.some((l) => l.startsWith("outbox/")));

    // A manifest sealed under this pod's key that names a path climbing out of its part, a name
    // a snapshot never holds, or a file whose folder it lacks: each is refused, the rest restored.
    const m = manifestOf(f);
    const any = m.entries.find((e) => e.type === "file") as SnapshotManifest["entries"][number];
    m.entries.push(
      { ...any, area: "harness", path: "../escaped" },
      { ...any, area: "secrets", path: "other" },
      { ...any, area: "harness", path: "nowhere/file" },
    );
    writeManifest(f, m);
    rmSync(f.live, { recursive: true, force: true });
    const restored = f.restore();
    assert.ok(restored);
    assert.deepEqual(restored.refused.sort(), [
      "harness/../escaped: not a name a snapshot holds",
      "harness/nowhere/file: its folder was not restored",
      "secrets/other: not a name a snapshot holds",
    ]);
    assert.equal(existsSync(join(f.live, "escaped")), false);
    assert.equal(readFileSync(join(f.live, "secrets", "supervisor-token"), "utf8"), "the token");
    // A rig without one of the parts restores the others (an image with another layout).
    rmSync(f.live, { recursive: true, force: true });
    const fewer = f.restore({ areas: f.areas.filter((a) => a.name !== "secrets") });
    assert.ok(fewer?.refused.includes("secrets/: not a part of this rig"));
    assert.equal(existsSync(join(f.live, "secrets")), false);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a restore is all or nothing, and never over live state", async () => {
    const f = fixture();
    typicalState(f);
    await f.take("kept");
    rmSync(f.live, { recursive: true, force: true });
    // The supervisor's part holds something already (a restart that kept the disk, say): nothing
    // is restored over it, and no other part is left half restored.
    mkdirSync(join(f.live, "supervisor"), { recursive: true });
    writeFileSync(join(f.live, "supervisor", "relay-state.json"), "newer");
    assert.deepEqual(liveHolds(f.areas), ["supervisor"]);
    assert.throws(() => f.restore(), /is not empty/);
    assert.deepEqual(readdirSync(f.live), ["supervisor"]);
    assert.equal(readFileSync(join(f.live, "supervisor", "relay-state.json"), "utf8"), "newer");
    // A part that holds only what a snapshot leaves out counts as empty, and is replaced.
    rmSync(join(f.live, "supervisor", "relay-state.json"));
    mkdirSync(join(f.live, "supervisor", "tmp"));
    assert.deepEqual(liveHolds(f.areas), []);
    assert.deepEqual(f.restore()?.refused, []);
    assert.equal(
      readFileSync(join(f.live, "supervisor", "relay-state.json"), "utf8"),
      '{"cursor":7}',
    );
    assert.equal(existsSync(join(f.live, "supervisor", "tmp")), false);
    // No staging folder is left behind.
    assert.deepEqual(
      readdirSync(f.live).filter((n) => n.endsWith(".restoring")),
      [],
    );
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a restored file keeps its time, so the next snapshot does not seal it again", async () => {
    const f = fixture();
    typicalState(f);
    utimesSync(
      join(f.live, "harness", "kits", "abc", "kit.json"),
      1_700_000_000.123,
      1_700_000_000.123,
    );
    await f.take("before the stop");
    rmSync(f.live, { recursive: true, force: true });
    f.restore();
    const again = await f.take("after the start");
    assert.ok(again.sealed <= 1, `sealed ${again.sealed}: at most the ledger's copy`);
    assert.equal(again.seq, 2);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("no snapshot yet; an unsealed one an older image left is never restored", async () => {
    const f = fixture();
    assert.equal(f.restore(), undefined);
    // An image before sealing: snapshot/ with a plaintext SNAPSHOT.json and copies.
    mkdirSync(join(f.dir, "snapshot", "harness"), { recursive: true });
    writeFileSync(join(f.dir, "snapshot", "SNAPSHOT.json"), '{"version":1,"entries":[]}');
    writeFileSync(join(f.dir, "snapshot", "harness", "rig-settings.json"), "{}");
    assert.equal(f.restore(), undefined, "only a sealed manifest counts");
    assert.match(
      inspectSnapshotFolder(f.dir).problem ?? "",
      /^an unsealed snapshot an older image left: snapshot$/,
    );
    // Where other users may write in the folder, it stays (a recursive removal could be sent
    // elsewhere); where none may, it goes.
    assert.deepEqual(removeUnsealed(f.dir, false), { removed: [], left: ["snapshot"] });
    assert.ok(existsSync(join(f.dir, "snapshot")));
    assert.deepEqual(removeUnsealed(f.dir, true), { removed: ["snapshot"], left: [] });
    assert.deepEqual(readdirSync(f.dir), []);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("root works inside the folder: a folder swapped for a link is refused", () => {
    const f = fixture();
    const elsewhere = join(f.root, "elsewhere");
    mkdirSync(elsewhere);
    const link = join(f.root, "volume", "linked");
    symlinkSync(elsewhere, link);
    assert.throws(() => inSnapshotFolder(link, () => "in"), /is not a folder/);
    const cwd = process.cwd();
    assert.equal(
      inSnapshotFolder(f.dir, () => readdirSync(".").length),
      0,
    );
    assert.equal(process.cwd(), cwd, "the working folder comes back");
    rmSync(f.root, { recursive: true, force: true });
  });
});

describe("what the snapshot folder may hold (inspectSnapshotFolder)", () => {
  test("only the sealed manifest, sealed files and empty probe files", async () => {
    const f = fixture();
    typicalState(f);
    assert.equal(lookWords(inspectSnapshotFolder(f.dir)), "no snapshot yet");
    await f.take("kept");
    const look = inspectSnapshotFolder(f.dir);
    assert.equal(look.problem, undefined);
    assert.equal(lookWords(look), `the manifest and ${look.files} sealed files`);
    // A user's empty probe file, and a file being sealed (empty, or begun), pass.
    writeFileSync(join(f.dir, "probe-10013"), "");
    writeFileSync(join(f.dir, `.new-${"a".repeat(32)}`), "");
    writeFileSync(
      join(f.dir, `.new-${"b".repeat(32)}`),
      readFileSync(sealedOf(f, "harness/kits/abc/kit.json")).subarray(0, 12),
    );
    assert.equal(inspectSnapshotFolder(f.dir).problem, undefined);
    const fails: [string, string | Buffer, RegExp][] = [
      ["probe-10014", "x", /^a file that is not sealed: probe-10014$/],
      ["a".repeat(64), "the pod's keys in plain text", /^a file that is not sealed: a{64}$/],
      [SEALED.next, '{"entries":[]}', /^a file that is not sealed: manifest\.new$/],
      // A sealed file's bytes under the manifest's name: the kind must match.
      [
        SEALED.next,
        readFileSync(sealedOf(f, "harness/kits/abc/kit.json")),
        /^a file that is not sealed: manifest\.new$/,
      ],
      ["notes.txt", "", /^a name a sealed snapshot never uses: notes\.txt$/],
    ];
    for (const [name, content, why] of fails) {
      writeFileSync(join(f.dir, name), content);
      assert.match(inspectSnapshotFolder(f.dir).problem ?? "", why, name);
      rmSync(join(f.dir, name));
    }
    mkdirSync(join(f.dir, "extra"));
    assert.match(
      inspectSnapshotFolder(f.dir).problem ?? "",
      /^a folder a sealed snapshot never holds: extra$/,
    );
    rmSync(join(f.dir, "extra"), { recursive: true });
    symlinkSync("/etc/hostname", join(f.dir, "b".repeat(64)));
    assert.match(
      inspectSnapshotFolder(f.dir).problem ?? "",
      /^a link or special file a sealed snapshot never holds/,
    );
    rmSync(join(f.dir, "b".repeat(64)));
    // The next take sweeps what it may: the probes' files and files half sealed.
    writeFileSync(join(f.dir, "probe-10015"), "");
    await f.take("again");
    assert.deepEqual(
      readdirSync(f.dir).filter((n) => n.startsWith("probe-") || n.startsWith(".new-")),
      [],
    );
    rmSync(f.root, { recursive: true, force: true });
  });
});

describe("where the snapshot and the live state are", () => {
  test("the live folders stay off the snapshot folder, and apart", () => {
    const a = (name: SnapshotArea["name"], live: string): SnapshotArea => ({
      name,
      live,
      uid: 1,
      gid: 1,
    });
    assert.equal(
      layoutProblem("/workspace/thermite", [a("harness", "/var/lib/rig/harness")]),
      undefined,
    );
    assert.match(
      layoutProblem("/workspace/thermite", [a("harness", "/workspace/thermite/harness")]) ?? "",
      /is in the snapshot folder/,
    );
    assert.match(
      layoutProblem("/var/lib/rig", [a("harness", "/var/lib")]) ?? "",
      /snapshot folder \/var\/lib\/rig is in the harness folder/,
    );
    assert.match(
      layoutProblem("/w", [a("harness", "/s"), a("outbox", "/s/outbox")]) ?? "",
      /outbox folder \/s\/outbox is in the harness folder/,
    );
    assert.equal(layoutProblem("/w", [a("harness", "/s/h"), a("outbox", "/s/hx")]), undefined);
    assert.match(layoutProblem("relative", []) ?? "", /absolute/);
  });

  test("the rig image keeps its live state on the container's disk and its snapshot on the volume", () => {
    const text = readFileSync(repo("containers/rig/Containerfile"), "utf8");
    const env: Record<string, string> = {};
    for (const m of text.matchAll(/^\s*(?:ENV\s+)?(THERMITE_[A-Z_]+)=(\S+?)\s*\\?$/gm))
      env[m[1] as string] = m[2] as string;
    const dir = env.THERMITE_STATE_SNAPSHOT_DIR;
    assert.ok(dir, "the image sets THERMITE_STATE_SNAPSHOT_DIR");
    // RunPod's volume: where the launch mounts it (src/control/runpod-rigs.ts).
    const runpod = readFileSync(repo("src/control/runpod-rigs.ts"), "utf8");
    const volume = /const VOLUME_PATH = "([^"]+)"/.exec(runpod)?.[1];
    assert.ok(volume && dir.startsWith(`${volume}/`), `${dir} is on the pod's volume ${volume}`);
    const areas = snapshotAreas(env);
    assert.deepEqual(
      areas.map((x) => `${x.name} ${x.uid}:${x.gid}${x.only ? ` ${x.only}` : ""}`),
      [
        "harness 10010:10010",
        "outbox 10010:10001",
        "inbox 10001:10010",
        "supervisor 10001:10001",
        "secrets 0:0 supervisor-token",
      ],
    );
    assert.equal(layoutProblem(dir, areas), undefined);
    for (const x of areas)
      assert.ok(!x.live.startsWith(`${volume}/`), `${x.live} is off the volume`);
    // The pod's keys and enrollment are in the supervisor's part, so the snapshot keeps them.
    const home = areas.find((x) => x.name === "supervisor")?.live as string;
    for (const k of ["THERMITE_TUNNEL_DIR", "THERMITE_TUNNEL_ENROLLED_DIR"])
      assert.ok(env[k]?.startsWith(`${home}/`), `${k} is in the supervisor's state`);
  });

  test("compose and Kubernetes rigs keep no snapshot: nothing else sets the setting", () => {
    for (const path of [
      "compose.yaml",
      "containers/release/compose.template.yaml",
      "containers/harness/Containerfile",
      "src/control/clusters/manifests.ts",
      "src/control/machines/deploy.ts",
    ])
      assert.ok(!readFileSync(repo(path), "utf8").includes("THERMITE_STATE_SNAPSHOT_DIR"), path);
    assert.deepEqual(
      snapshotAreas({ THERMITE_STATE_DIR: "/var/lib/thermite" }).map((x) => x.name),
      ["harness", "outbox"],
    );
  });

  test("what a snapshot leaves out", () => {
    const [harness, outbox, , supervisor, secrets] = snapshotAreas({
      THERMITE_ONE_CONTAINER: "1",
      THERMITE_SUPERVISOR_TOKEN_FILE: "/s/secrets/supervisor-token",
    }) as SnapshotArea[];
    assert.equal(leftOut(harness as SnapshotArea, "ledger/ledger.db-wal"), true);
    assert.equal(leftOut(harness as SnapshotArea, "ledger/ledger.db"), false);
    assert.equal(leftOut(outbox as SnapshotArea, ".tmp-1/manifest.json"), true);
    assert.equal(leftOut(outbox as SnapshotArea, "20261022-1/manifest.json"), false);
    assert.equal(leftOut(supervisor as SnapshotArea, "tmp/x"), true);
    assert.equal(leftOut(supervisor as SnapshotArea, "tunnel/keys.json"), false);
    assert.equal(leftOut(secrets as SnapshotArea, "supervisor-token"), false);
    assert.equal(leftOut(secrets as SnapshotArea, "model-key"), true);
  });

  test("the folder must be closed to every user the broker tries", () => {
    const answers: Record<string, string> = {
      thermite: '{"list":"EACCES","create":"EACCES"}',
      supervisor: '{"list":"ALLOWED","create":"EACCES"}',
      "agent-1": "node: not found",
    };
    const seen = closedTo(Object.keys(answers), (u) => ({
      status: u === "agent-1" ? 127 : 0,
      stdout: answers[u]?.startsWith("{") ? (answers[u] as string) : "",
      stderr: answers[u]?.startsWith("{") ? "" : (answers[u] as string),
    }));
    assert.deepEqual(seen, {
      thermite: "refused (EACCES)",
      supervisor: "OPENED: lists it",
      "agent-1": "failed: exit 127 node: not found",
    });
  });
});

describe("when snapshots are taken (Snapshotter)", () => {
  /** A take that ends when told, and records its reasons. */
  function takes() {
    const reasons: string[] = [];
    const ends: ((ok: boolean) => void)[] = [];
    let aborted = 0;
    const take = (reason: string): SnapshotJob => {
      reasons.push(reason);
      let end: (ok: boolean) => void = () => undefined;
      const done = new Promise<boolean>((r) => {
        end = r;
      });
      ends.push(end);
      return {
        done,
        abort: () => {
          aborted++;
          end(false);
        },
      };
    };
    return { reasons, ends, take, aborted: () => aborted };
  }
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  test("one at a time; a request meanwhile is taken after it", async () => {
    const t = takes();
    const s = new Snapshotter({ take: t.take, everyMs: 3_600_000 });
    s.request("after enrollment");
    s.request("after an export");
    s.request("after an export");
    assert.deepEqual(t.reasons, ["after enrollment"]);
    t.ends[0]?.(true);
    await tick();
    assert.deepEqual(t.reasons, ["after enrollment", "after an export"]);
    t.ends[1]?.(true);
    await tick();
    assert.equal(t.reasons.length, 2);
  });

  test("a failed snapshot is tried again", async () => {
    const t = takes();
    const s = new Snapshotter({ take: t.take, everyMs: 3_600_000, retryMs: 30 });
    s.request("after an export");
    t.ends[0]?.(false);
    await tick(80);
    assert.deepEqual(t.reasons, ["after an export", "again, after a failure"]);
    t.ends[1]?.(true);
    await tick(80);
    assert.equal(t.reasons.length, 2, "not again once it worked");
  });

  test("every few minutes", async () => {
    const t = takes();
    const s = new Snapshotter({ take: t.take, everyMs: 40 });
    s.start();
    await tick(60);
    assert.deepEqual(t.reasons, ["every 0.04 seconds"]);
    t.ends[0]?.(true);
    await tick(60);
    assert.ok(t.reasons.length >= 2);
    await s.stop(10);
  });

  test("it waits while a timed run is at work, up to a limit", async () => {
    const t = takes();
    let busy = true;
    const s = new Snapshotter({
      take: t.take,
      everyMs: 3_600_000,
      busy: () => busy,
      pollMs: 10,
      deferMs: 10_000,
    });
    s.request("after an export");
    await tick(50);
    assert.deepEqual(t.reasons, [], "not while the judge times");
    busy = false;
    await tick(50);
    assert.deepEqual(t.reasons, ["after an export"]);
    t.ends[0]?.(true);
    // Busy for longer than it may wait: taken all the same.
    busy = true;
    const s2 = new Snapshotter({
      take: t.take,
      everyMs: 3_600_000,
      busy: () => busy,
      pollMs: 10,
      deferMs: 40,
    });
    s2.request("every 5 minutes");
    await tick(120);
    assert.deepEqual(t.reasons, ["after an export", "every 5 minutes"]);
  });

  test("at a stop: the one under way ends, then the last one; out of time, it is ended", async () => {
    const t = takes();
    const s = new Snapshotter({ take: t.take, everyMs: 3_600_000 });
    s.request("after an export");
    const stopped = s.stop(1000);
    s.request("after an export");
    await tick();
    assert.deepEqual(t.reasons, ["after an export"], "no new one but the stop's");
    t.ends[0]?.(true);
    await tick();
    assert.deepEqual(t.reasons, ["after an export", "at the stop"]);
    t.ends[1]?.(true);
    assert.equal(await stopped, "taken");

    const slow = takes();
    const s2 = new Snapshotter({ take: slow.take, everyMs: 3_600_000 });
    assert.equal(await s2.stop(30), "out of time");
    assert.equal(slow.aborted(), 1);
  });
});

describe("the broker's helper (snapshot-main.ts)", () => {
  const main = fileURLToPath(
    new URL("../../../src/harness/broker/snapshot-main.ts", import.meta.url),
  );
  const runHelper = (input: string) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", main, "take"],
      { encoding: "utf8", input },
    );

  test("takes a sealed snapshot in its own process, its job and key on its standard input", () => {
    const f = fixture();
    typicalState(f);
    const job = {
      dir: f.dir,
      reason: "after an export",
      areas: f.areas,
      stage: join(f.root, "stage"),
      owner: { uid, gid },
      rig: RIG,
      key: f.key.toString("base64url"),
    };
    const r = runHelper(JSON.stringify(job));
    assert.equal(r.status, 0, r.stderr);
    const line = JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
    assert.equal(line.msg, "took a snapshot of the rig's state");
    assert.equal(line.reason, "after an export");
    assert.equal(line.ledger, true);
    assert.equal(line.seq, 1);
    assert.ok(line.sealed > 0);
    assert.ok(!r.stdout.includes(job.key), "the key is never logged");
    assert.equal(existsSync(job.stage), false, "the ledger's copy is gone");
    rmSync(f.live, { recursive: true, force: true });
    assert.ok(f.restore());
    assert.deepEqual(rowsIn(join(f.live, "harness", LEDGER_FILE)), { ok: "ok", a: 3, b: 3 });
    // A job it cannot do: logged, exit 1, and the snapshot before stays.
    const before = readFileSync(join(f.dir, SEALED.manifest));
    const bad = runHelper(
      JSON.stringify({ ...job, dir: join(f.root, "no-such-volume", "thermite") }),
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /could not take a snapshot of the rig's state: the last one stays/);
    assert.deepEqual(readFileSync(join(f.dir, SEALED.manifest)), before);
    // No key, or a job that is not one: nothing is taken.
    const nokey = runHelper(JSON.stringify({ ...job, key: "" }));
    assert.equal(nokey.status, 1);
    assert.match(nokey.stdout, /the launch gave no THERMITE_STATE_SNAPSHOT_KEY/);
    const notJob = runHelper("not json");
    assert.equal(notJob.status, 1);
    assert.match(notJob.stdout, /the job is not valid/);
    assert.deepEqual(readFileSync(join(f.dir, SEALED.manifest)), before);
    rmSync(f.root, { recursive: true, force: true });
  });
});
