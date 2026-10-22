import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  backupLedger,
  closedTo,
  LEDGER_FILE,
  layoutProblem,
  leftOut,
  liveHolds,
  MANIFEST,
  pickSnapshot,
  readManifest,
  restoreSnapshot,
  SNAPSHOT_DIRS,
  type SnapshotArea,
  type SnapshotJob,
  type SnapshotManifest,
  Snapshotter,
  snapshotAreas,
  takeSnapshot,
} from "./snapshot.ts";

/**
 * The rig's state over a stop that empties the container's disk (a RunPod pod): live on the
 * container's disk, a snapshot on the volume. These tests take snapshots of a live tree, restore
 * them onto an empty one, and check what a snapshot never copies or restores.
 */

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

/** A rig's live state under `root/live`, with every part, and its snapshot folder `root/volume`. */
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
  return { root, live, dir, areas, put };
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

describe("the rig's state snapshot (broker/snapshot.ts)", () => {
  test("a snapshot takes the live state, and a restore onto an empty disk puts it back", async () => {
    const f = fixture();
    typicalState(f);
    const r = await takeSnapshot({
      dir: f.dir,
      areas: f.areas,
      reason: "at the stop",
      backupLedger: stagedBackup(f.root),
    });
    assert.equal(r.ledger, true);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(readdirSync(f.dir), [SNAPSHOT_DIRS.current]);
    const manifest = readManifest(join(f.dir, SNAPSHOT_DIRS.current)) as SnapshotManifest;
    assert.equal(manifest.reason, "at the stop");
    const names = manifest.entries.map((e) => `${e.area}/${e.path}`);
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
      assert.ok(!names.includes(out), `${out} is not in the snapshot`);
    assert.ok(names.includes("supervisor/tunnel/keys.json"));
    assert.ok(names.includes("secrets/supervisor-token"));

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
      own: (path, u, g) => {
        assert.equal(u, uid);
        assert.equal(g, gid);
        owned.push(path);
      },
    });
    assert.ok(restored);
    assert.deepEqual(restored.refused, []);
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
    assert.deepEqual(readdirSync(f.dir), [SNAPSHOT_DIRS.current]);
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
        backupLedger: stagedBackup(f.root),
      });
      assert.equal(r.ledger, true);
      const copy = rowsIn(join(f.dir, SNAPSHOT_DIRS.current, "harness", LEDGER_FILE));
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

  test("a new snapshot is swapped in by rename; the one before stays until it is complete", async () => {
    const f = fixture();
    typicalState(f);
    const take = (reason: string, backup = stagedBackup(f.root)) =>
      takeSnapshot({ dir: f.dir, areas: f.areas, reason, backupLedger: backup });
    await take("first");
    const first = readManifest(join(f.dir, SNAPSHOT_DIRS.current));
    // A take that fails (here, the ledger's copy) leaves the snapshot before it as it was.
    f.put("harness/kits/abc/kit.json", '{"kit":2}');
    await assert.rejects(
      take("fails", async () => {
        throw new Error("no ledger copy");
      }),
      /no ledger copy/,
    );
    assert.deepEqual(readdirSync(f.dir), [SNAPSHOT_DIRS.current]);
    assert.deepEqual(readManifest(join(f.dir, SNAPSHOT_DIRS.current)), first);
    // A take stopped half way (the pod killed): an incomplete snapshot.new, which never counts.
    mkdirSync(join(f.dir, SNAPSHOT_DIRS.next, "harness"), { recursive: true });
    writeFileSync(join(f.dir, SNAPSHOT_DIRS.next, "harness", "half"), "x");
    assert.equal(pickSnapshot(f.dir)?.manifest.reason, "first");
    const second = await take("second");
    assert.deepEqual(readdirSync(f.dir), [SNAPSHOT_DIRS.current]);
    assert.equal(pickSnapshot(f.dir)?.manifest.reason, "second");
    // Unchanged files are hard links to the snapshot before; the changed kit is copied.
    assert.ok(second.linked >= 8, `linked ${second.linked}`);
    assert.equal(second.links, true);
    assert.equal(
      readFileSync(
        join(f.dir, SNAPSHOT_DIRS.current, "harness", "kits", "abc", "kit.json"),
        "utf8",
      ),
      '{"kit":2}',
    );
    // Stopped between the two renames: the old one aside, the new one complete but not in place.
    renameSync(join(f.dir, SNAPSHOT_DIRS.current), join(f.dir, SNAPSHOT_DIRS.old));
    await take("third").then(() =>
      renameSync(join(f.dir, SNAPSHOT_DIRS.current), join(f.dir, SNAPSHOT_DIRS.next)),
    );
    assert.equal(existsSync(join(f.dir, SNAPSHOT_DIRS.current)), false);
    assert.equal(pickSnapshot(f.dir)?.manifest.reason, "third", "the newest complete one counts");
    await take("fourth");
    assert.deepEqual(readdirSync(f.dir), [SNAPSHOT_DIRS.current]);
    assert.equal(pickSnapshot(f.dir)?.manifest.reason, "fourth");
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a snapshot copies no link, pipe or other user's file; a restore refuses them too", async () => {
    const f = fixture();
    typicalState(f);
    const secret = join(f.root, "root-only-secret");
    writeFileSync(secret, "root's secret");
    symlinkSync(secret, join(f.live, "supervisor", "keys-link"));
    spawnSync("mkfifo", [join(f.live, "inbox", "pipe")]);
    // A part whose files are another user's (the broker checks owners as root): none is copied.
    const areas = f.areas.map((a) => (a.name === "outbox" ? { ...a, uid: uid + 1 } : a));
    const r = await takeSnapshot({
      dir: f.dir,
      areas,
      reason: "with strangers",
      backupLedger: stagedBackup(f.root),
    });
    assert.ok(r.skipped.includes("supervisor/keys-link: a link"), r.skipped.join("; "));
    assert.ok(r.skipped.includes("inbox/pipe: not a plain file or folder"), r.skipped.join("; "));
    assert.ok(r.skipped.some((s) => s.startsWith("outbox/: owned by uid")));
    const snap = join(f.dir, SNAPSHOT_DIRS.current);
    assert.equal(existsSync(join(snap, "supervisor", "keys-link")), false);

    // A snapshot that holds a link, a pipe, a name outside its parts or one that climbs out:
    // each is refused at the restore, and the rest restored.
    rmSync(join(snap, "harness", "kits", "abc", "kit.json"));
    symlinkSync(secret, join(snap, "harness", "kits", "abc", "kit.json"));
    rmSync(join(snap, "inbox", "models", "m.bin"));
    spawnSync("mkfifo", [join(snap, "inbox", "models", "m.bin")]);
    const manifest = readManifest(snap) as SnapshotManifest;
    manifest.entries.push(
      { area: "harness", path: "../escaped", type: "file", mode: 0o644, size: 1 },
      { area: "secrets", path: "other", type: "file", mode: 0o644, size: 1 },
      { area: "harness", path: "nowhere/file", type: "file", mode: 0o644, size: 1 },
    );
    unlinkSync(join(snap, MANIFEST));
    writeFileSync(join(snap, MANIFEST), JSON.stringify(manifest));
    rmSync(f.live, { recursive: true, force: true });
    const restored = restoreSnapshot({ dir: f.dir, areas: f.areas, own: () => undefined });
    assert.ok(restored);
    assert.deepEqual(restored.refused.sort(), [
      "harness/../escaped: not a name a snapshot holds",
      "harness/kits/abc/kit.json: a link",
      "harness/nowhere/file: its folder was not restored",
      "inbox/models/m.bin: not a plain file: a device, a pipe or a socket",
      "secrets/other: not a name a snapshot holds",
    ]);
    assert.equal(existsSync(join(f.live, "harness", "kits", "abc", "kit.json")), false);
    assert.equal(existsSync(join(f.live, "escaped")), false);
    assert.equal(readFileSync(join(f.live, "secrets", "supervisor-token"), "utf8"), "the token");
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a restore is all or nothing, and never over live state", async () => {
    const f = fixture();
    typicalState(f);
    await takeSnapshot({
      dir: f.dir,
      areas: f.areas,
      reason: "kept",
      backupLedger: stagedBackup(f.root),
    });
    rmSync(f.live, { recursive: true, force: true });
    // The supervisor's part holds something already (a restart that kept the disk, say): nothing
    // is restored over it, and no other part is left half restored.
    mkdirSync(join(f.live, "supervisor"), { recursive: true });
    writeFileSync(join(f.live, "supervisor", "relay-state.json"), "newer");
    assert.deepEqual(liveHolds(f.areas), ["supervisor"]);
    assert.throws(
      () => restoreSnapshot({ dir: f.dir, areas: f.areas, own: () => undefined }),
      /is not empty/,
    );
    assert.deepEqual(readdirSync(f.live), ["supervisor"]);
    assert.equal(readFileSync(join(f.live, "supervisor", "relay-state.json"), "utf8"), "newer");
    // A part that holds only what a snapshot leaves out counts as empty, and is replaced.
    rmSync(join(f.live, "supervisor", "relay-state.json"));
    mkdirSync(join(f.live, "supervisor", "tmp"));
    assert.deepEqual(liveHolds(f.areas), []);
    const r = restoreSnapshot({ dir: f.dir, areas: f.areas, own: () => undefined });
    assert.deepEqual(r?.refused, []);
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

  test("a restored file keeps its time, so the next snapshot links it again", async () => {
    const f = fixture();
    typicalState(f);
    utimesSync(
      join(f.live, "harness", "kits", "abc", "kit.json"),
      1_700_000_000.123,
      1_700_000_000.123,
    );
    const take = (reason: string) =>
      takeSnapshot({ dir: f.dir, areas: f.areas, reason, backupLedger: stagedBackup(f.root) });
    await take("before the stop");
    rmSync(f.live, { recursive: true, force: true });
    restoreSnapshot({ dir: f.dir, areas: f.areas, own: () => undefined });
    const again = await take("after the start");
    assert.equal(again.copied, 1, "only the ledger is copied again");
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a hard link the volume refuses: every file is copied, and the snapshot is whole", async () => {
    const f = fixture();
    typicalState(f);
    await takeSnapshot({
      dir: f.dir,
      areas: f.areas,
      reason: "first",
      backupLedger: stagedBackup(f.root),
    });
    // A volume without hard links: the first link refused, the rest copied without trying.
    let tried = 0;
    const r = await takeSnapshot({
      dir: f.dir,
      areas: f.areas,
      reason: "second",
      backupLedger: stagedBackup(f.root),
      link: () => {
        tried++;
        throw Object.assign(new Error("not on this volume"), { code: "EPERM" });
      },
    });
    assert.equal(tried, 1);
    assert.equal(r.links, false);
    assert.equal(r.linked, 0);
    assert.equal(r.copied, r.files);
    rmSync(f.live, { recursive: true, force: true });
    const back = restoreSnapshot({ dir: f.dir, areas: f.areas, own: () => undefined });
    assert.deepEqual(back?.refused, []);
    assert.equal(
      readFileSync(join(f.live, "supervisor", "tunnel", "keys.json"), "utf8"),
      '{"sign":"private"}',
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
  test("takes a snapshot in its own process, the ledger copied as its owner", () => {
    const f = fixture();
    typicalState(f);
    const main = fileURLToPath(new URL("./snapshot-main.ts", import.meta.url));
    const job = {
      dir: f.dir,
      reason: "after an export",
      areas: f.areas,
      stage: join(f.root, "stage"),
      owner: { uid, gid },
    };
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        main,
        "take",
        JSON.stringify(job),
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const line = JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
    assert.equal(line.msg, "took a snapshot of the rig's state");
    assert.equal(line.reason, "after an export");
    assert.equal(line.ledger, true);
    assert.equal(existsSync(job.stage), false, "the ledger's copy is gone");
    assert.deepEqual(rowsIn(join(f.dir, SNAPSHOT_DIRS.current, "harness", LEDGER_FILE)), {
      ok: "ok",
      a: 3,
      b: 3,
    });
    // A job it cannot do: logged, exit 1, and the snapshot before stays.
    const bad = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        main,
        "take",
        JSON.stringify({ ...job, dir: join(f.root, "no-such-volume", "thermite") }),
      ],
      { encoding: "utf8" },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /could not take a snapshot of the rig's state: the last one stays/);
    assert.ok(statSync(join(f.dir, SNAPSHOT_DIRS.current)).isDirectory());
    rmSync(f.root, { recursive: true, force: true });
  });
});
