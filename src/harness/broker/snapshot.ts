import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lchownSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  utimesSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { oneContainer, supervisorPaths } from "./one-container.ts";
import { IDS } from "./runner.ts";

/**
 * The rig's state over a stop of a host that empties the container's own disk, such as a RunPod
 * pod (THERMITE_STATE_SNAPSHOT_DIR; the one-container rig image sets it). The live state stays
 * on the container's disk, where each part and each role keeps the owners it has everywhere else.
 * Root copies it into a snapshot on the host's volume every few minutes, after each export and at
 * a stop, and copies the newest complete snapshot back at a start on an empty disk.
 *
 * - The snapshot folder is root's, mode 0700: no part and no role may read or write it. Nothing
 *   under it is ever given another owner (RunPod's volume refuses even root that), so the owners
 *   and modes the live folders need are in the snapshot's manifest, and a restore sets them on
 *   the container's disk.
 * - A take writes a new folder (`snapshot.new`), its manifest last, then swaps it in by rename;
 *   the snapshot before it stays whole until the new one is complete. A file that has not changed
 *   since the last snapshot is a hard link to that snapshot's copy, where the volume allows it.
 * - The ledger is copied with SQLite's backup, as the controller's user, never as a raw file, and
 *   first: an export the ledger records is then in the outbox's copy too.
 * - Only plain files and folders of the expected owner are copied, and only plain files and
 *   folders under the expected names are restored: never a link, a device, a pipe or a socket.
 */

type Env = Record<string, string | undefined>;

/** The parts of the rig's state a snapshot holds, by their names in it. */
export const AREA_NAMES = ["harness", "outbox", "inbox", "supervisor", "secrets"] as const;
export type AreaName = (typeof AREA_NAMES)[number];

/** One part of the live state: where it is, and the owner everything in it has. */
export interface SnapshotArea {
  name: AreaName;
  /** Its live folder, on the container's own disk. */
  live: string;
  uid: number;
  gid: number;
  /** Only this file at its top (the secrets folder: root's copy of the supervisor's token). */
  only?: string | undefined;
}

/** The folders in the snapshot folder: the snapshot, the one being written, the one it replaces. */
export const SNAPSHOT_DIRS = {
  current: "snapshot",
  next: "snapshot.new",
  old: "snapshot.old",
} as const;
/** In each snapshot, written last: what it holds, with each entry's mode. */
export const MANIFEST = "SNAPSHOT.json";
/** The ledger, in the harness's state folder. */
export const LEDGER_FILE = "ledger/ledger.db";
/** The broker's record of the snapshot folder, next to its socket, for the isolation selftest. */
export const SNAPSHOT_RECORD = "snapshot.json";
/** The most a manifest may hold. */
const MANIFEST_MAX_BYTES = 512 * 1024 * 1024;

/** THERMITE_STATE_SNAPSHOT_DIR, or none: no snapshot (compose and Kubernetes rigs). */
export function snapshotDir(env: Env): string | undefined {
  return env.THERMITE_STATE_SNAPSHOT_DIR || undefined;
}

function positive(env: Env, name: string, fallback: number, unit: string): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a number of ${unit} above 0`);
  return n;
}

/** How often a snapshot is taken (THERMITE_STATE_SNAPSHOT_MINUTES, 5 by default). */
export function snapshotEveryMs(env: Env): number {
  return positive(env, "THERMITE_STATE_SNAPSHOT_MINUTES", 5, "minutes") * 60_000;
}

/** How long a stop waits for its snapshot (THERMITE_STATE_SNAPSHOT_STOP_SECONDS, 8). */
export function stopBudgetMs(env: Env): number {
  return positive(env, "THERMITE_STATE_SNAPSHOT_STOP_SECONDS", 8, "seconds") * 1000;
}

/**
 * The parts a snapshot holds: the harness's state and the outbox; in the one-container rig image
 * also the inbox, the supervisor's state (its pull mode keys and enrollment among it) and root's
 * copy of the supervisor's token. Each with the owner the broker gives it at a start.
 */
export function snapshotAreas(env: Env): SnapshotArea[] {
  const t = IDS.thermite;
  const areas: SnapshotArea[] = [
    {
      name: "harness",
      live: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
      uid: t.uid,
      gid: t.gid,
    },
    {
      name: "outbox",
      live: env.THERMITE_OUTBOX_DIR ?? "/outbox",
      uid: t.uid,
      gid: Number(env.THERMITE_OUTBOX_GID ?? "10001"),
    },
  ];
  if (oneContainer(env)) {
    const p = supervisorPaths(env);
    const s = IDS.supervisor;
    areas.push(
      { name: "inbox", live: p.inbox, uid: s.uid, gid: t.gid },
      { name: "supervisor", live: p.home, uid: s.uid, gid: s.gid },
    );
    const token = env.THERMITE_SUPERVISOR_TOKEN_FILE;
    if (token)
      areas.push({ name: "secrets", live: dirname(token), uid: 0, gid: 0, only: basename(token) });
  }
  return areas;
}

const within = (path: string, folder: string): boolean => {
  const r = relative(folder, path);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/**
 * What makes this layout unusable, or nothing: the live folders must stay out of the snapshot
 * folder (so nothing the broker gives an owner is ever on the volume), and apart from each other.
 */
export function layoutProblem(dir: string, areas: readonly SnapshotArea[]): string | undefined {
  if (!isAbsolute(dir)) return `THERMITE_STATE_SNAPSHOT_DIR must be an absolute path, not ${dir}`;
  for (const a of areas) {
    if (!isAbsolute(a.live)) return `the ${a.name} folder ${a.live} is not an absolute path`;
    if (within(a.live, dir))
      return `the ${a.name} folder ${a.live} is in the snapshot folder ${dir}: the live state must stay on the container's own disk`;
    if (within(dir, a.live))
      return `the snapshot folder ${dir} is in the ${a.name} folder ${a.live}`;
    for (const b of areas)
      if (a !== b && within(a.live, b.live))
        return `the ${a.name} folder ${a.live} is in the ${b.name} folder ${b.live}`;
  }
  return undefined;
}

/**
 * What a snapshot never holds: the ledger's write-ahead files (the ledger itself is copied with
 * SQLite's backup), exports still being written (dot names in the outbox), the supervisor's
 * temporary folder and its copy of the token (root writes it again at every start), and anything
 * in the secrets folder but the token.
 */
export function leftOut(area: SnapshotArea, rel: string): boolean {
  if (rel === "") return false;
  const top = rel.split("/")[0] as string;
  switch (area.name) {
    case "harness":
      return [`${LEDGER_FILE}-wal`, `${LEDGER_FILE}-shm`, `${LEDGER_FILE}-journal`].includes(rel);
    case "outbox":
      return top.startsWith(".");
    case "supervisor":
      return top === "tmp" || rel === "harness-token";
    case "secrets":
      return rel !== area.only;
    default:
      return false;
  }
}

/** A path in a snapshot: names joined by "/", never empty, "." or "..". "" is the area's folder. */
export function safeRel(rel: string): boolean {
  if (rel === "") return true;
  if (rel.includes("\0") || rel.length > 4096) return false;
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const Entry = z.object({
  area: z.enum(AREA_NAMES),
  path: z.string(),
  type: z.enum(["dir", "file"]),
  mode: z.number().int().min(0).max(0o7777),
  size: z.number().int().min(0).optional(),
  mtime_ms: z.number().optional(),
  ledger: z.literal(true).optional(),
});
export type SnapshotEntry = z.infer<typeof Entry>;
const Manifest = z.object({
  version: z.literal(1),
  taken_at: z.string(),
  reason: z.string(),
  entries: z.array(Entry),
});
export type SnapshotManifest = z.infer<typeof Manifest>;

const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code;

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A snapshot's manifest, or nothing when it has none (it is not complete) or it is not valid. */
export function readManifest(snapshot: string): SnapshotManifest | undefined {
  let fd: number;
  try {
    fd = openSync(join(snapshot, MANIFEST), READ);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MANIFEST_MAX_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    const parsed = Manifest.safeParse(JSON.parse(buf.subarray(0, n).toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The newest complete snapshot in the snapshot folder, if any. */
export function pickSnapshot(
  dir: string,
): { name: string; path: string; manifest: SnapshotManifest } | undefined {
  let best: { name: string; path: string; manifest: SnapshotManifest } | undefined;
  for (const name of [SNAPSHOT_DIRS.current, SNAPSHOT_DIRS.next, SNAPSHOT_DIRS.old]) {
    const path = join(dir, name);
    if (!isDir(path)) continue;
    const manifest = readManifest(path);
    if (manifest && (!best || manifest.taken_at > best.manifest.taken_at))
      best = { name, path, manifest };
  }
  return best;
}

function fsyncDir(path: string): void {
  try {
    const fd = openSync(path, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // a file system that cannot sync a folder: the rename still happened
  }
}

/** Makes `snapshot.new` the snapshot; the one before it goes only once that is done. */
function swapIn(dir: string): void {
  const cur = join(dir, SNAPSHOT_DIRS.current);
  const old = join(dir, SNAPSHOT_DIRS.old);
  rmSync(old, { recursive: true, force: true });
  if (isDir(cur)) renameSync(cur, old);
  renameSync(join(dir, SNAPSHOT_DIRS.next), cur);
  fsyncDir(dir);
  rmSync(old, { recursive: true, force: true });
}

/**
 * Finishes what a take that was stopped left: a complete `snapshot.new` is swapped in, an
 * incomplete one goes, and `snapshot.old` goes once `snapshot` is there (or becomes it again).
 */
export function settle(dir: string): void {
  const next = join(dir, SNAPSHOT_DIRS.next);
  if (isDir(next)) {
    if (readManifest(next)) swapIn(dir);
    else rmSync(next, { recursive: true, force: true });
  }
  const old = join(dir, SNAPSHOT_DIRS.old);
  if (isDir(old)) {
    if (isDir(join(dir, SNAPSHOT_DIRS.current))) rmSync(old, { recursive: true, force: true });
    else renameSync(old, join(dir, SNAPSHOT_DIRS.current));
  }
}

/**
 * Copies a plain file, opened without following a link, to a new file (never one that is
 * there). Undefined when it is gone, or is not a plain file of `owner`'s when one is given.
 */
function copyPlain(
  src: string,
  dest: string,
  owner?: number,
): { bytes: number; st: Stats } | { refused: string } | undefined {
  let fd: number;
  try {
    fd = openSync(src, READ);
  } catch (err) {
    if (errCode(err) === "ENOENT") return undefined;
    if (errCode(err) === "ELOOP") return { refused: "a link" };
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { refused: "not a plain file" };
    if (owner !== undefined && st.uid !== owner)
      return { refused: `owned by uid ${st.uid}, not ${owner}` };
    const out = openSync(dest, CREATE, 0o600);
    let bytes = 0;
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const got = readSync(fd, buf, 0, buf.length, null);
        if (got === 0) break;
        let off = 0;
        while (off < got) off += writeSync(out, buf, off, got - off);
        bytes += got;
      }
    } finally {
      closeSync(out);
    }
    return { bytes, st };
  } finally {
    closeSync(fd);
  }
}

/** A copy of the ledger made with SQLite's backup: consistent while the ledger is written. */
export async function backupLedger(source: string, dest: string): Promise<void> {
  const db = new DatabaseSync(source);
  try {
    db.exec("pragma busy_timeout = 10000");
    // Every page in one step, in one read transaction: a write meanwhile cannot restart it. (The
    // most pages one step takes: Node.js 24 refuses SQLite's -1 for "all".)
    await backup(db, dest, { rate: 2_147_483_647 });
  } finally {
    db.close();
  }
}

export interface TakeResult {
  taken_at: string;
  reason: string;
  files: number;
  dirs: number;
  bytes: number;
  /** Files unchanged since the last snapshot, linked to its copy. */
  linked: number;
  copied: number;
  /** Whether the volume took hard links (false: every file was copied). */
  links: boolean;
  ledger: boolean;
  /** What was not copied, and why: links, devices, pipes, sockets, another owner's files. */
  skipped: string[];
  ms: number;
}

const LINKS_REFUSED = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EACCES"]);

/**
 * Takes a snapshot of `areas` into `dir` (root's folder on the volume). `backupLedger` makes a
 * consistent copy of the live ledger and gives its path (the broker makes it as the controller's
 * user). Throws when the snapshot can't be written; the snapshot before it then stays.
 */
export async function takeSnapshot(o: {
  dir: string;
  areas: readonly SnapshotArea[];
  reason: string;
  backupLedger: (source: string) => Promise<string>;
  now?: () => Date;
  /** Makes a hard link (linkSync; tests give a volume that refuses them). */
  link?: (existing: string, created: string) => void;
}): Promise<TakeResult> {
  const link = o.link ?? linkSync;
  const started = Date.now();
  const takenAt = (o.now?.() ?? new Date()).toISOString();
  settle(o.dir);
  const base = join(o.dir, SNAPSHOT_DIRS.current);
  const before = new Map<string, SnapshotEntry>();
  for (const e of readManifest(base)?.entries ?? [])
    if (e.type === "file" && !e.ledger) before.set(`${e.area}\0${e.path}`, e);
  const next = join(o.dir, SNAPSHOT_DIRS.next);
  mkdirSync(next, { mode: 0o700 });
  const entries: SnapshotEntry[] = [];
  const r: TakeResult = {
    taken_at: takenAt,
    reason: o.reason,
    files: 0,
    dirs: 0,
    bytes: 0,
    linked: 0,
    copied: 0,
    links: true,
    ledger: false,
    skipped: [],
    ms: 0,
  };
  const harness = o.areas.find((a) => a.name === "harness");
  const ledgerLive = harness ? join(harness.live, LEDGER_FILE) : undefined;
  let staged: string | undefined;
  const skip = (area: SnapshotArea, rel: string, why: string): void => {
    r.skipped.push(`${area.name}/${rel}: ${why}`);
  };
  const walk = (area: SnapshotArea, rel: string): void => {
    if (leftOut(area, rel)) return;
    const live = rel ? join(area.live, rel) : area.live;
    const dest = rel ? join(next, area.name, rel) : join(next, area.name);
    let st: Stats;
    try {
      st = lstatSync(live);
    } catch (err) {
      if (errCode(err) === "ENOENT") return;
      throw err;
    }
    const why = st.isSymbolicLink()
      ? "a link"
      : !st.isDirectory() && !st.isFile()
        ? "not a plain file or folder"
        : st.uid !== area.uid
          ? `owned by uid ${st.uid}, not ${area.uid}`
          : undefined;
    if (why) {
      skip(area, rel, why);
      return;
    }
    if (st.isDirectory()) {
      mkdirSync(dest, { mode: 0o700 });
      entries.push({ area: area.name, path: rel, type: "dir", mode: st.mode & 0o7777 });
      r.dirs++;
      let names: string[];
      try {
        names = readdirSync(live).sort();
      } catch (err) {
        if (errCode(err) === "ENOENT") return;
        throw err;
      }
      for (const n of names) walk(area, rel ? `${rel}/${n}` : n);
      return;
    }
    if (area.name === "harness" && rel === LEDGER_FILE) {
      if (!staged) return;
      const c = copyPlain(staged, dest);
      if (!c || "refused" in c) throw new Error("the ledger's copy is gone or not a plain file");
      entries.push({
        area: area.name,
        path: rel,
        type: "file",
        mode: st.mode & 0o777,
        size: c.bytes,
        ledger: true,
      });
      r.files++;
      r.copied++;
      r.bytes += c.bytes;
      r.ledger = true;
      return;
    }
    const was = before.get(`${area.name}\0${rel}`);
    if (
      r.links &&
      was?.mtime_ms !== undefined &&
      was.size === st.size &&
      Math.abs(was.mtime_ms - st.mtimeMs) < 0.001
    ) {
      try {
        link(join(base, area.name, rel), dest);
        entries.push({
          area: area.name,
          path: rel,
          type: "file",
          mode: st.mode & 0o777,
          size: st.size,
          mtime_ms: st.mtimeMs,
        });
        r.files++;
        r.linked++;
        r.bytes += st.size;
        return;
      } catch (err) {
        const code = errCode(err) ?? "";
        if (LINKS_REFUSED.has(code)) r.links = false;
        else if (code !== "ENOENT" && code !== "EMLINK") throw err;
      }
    }
    const c = copyPlain(live, dest, area.uid);
    if (!c) return;
    if ("refused" in c) {
      skip(area, rel, c.refused);
      return;
    }
    entries.push({
      area: area.name,
      path: rel,
      type: "file",
      mode: c.st.mode & 0o777,
      size: c.bytes,
      mtime_ms: c.st.mtimeMs,
    });
    r.files++;
    r.copied++;
    r.bytes += c.bytes;
  };
  try {
    // The ledger first, before any other part is copied: an export the ledger records as made is
    // then in the outbox's copy too (one made after it is exported again, never lost).
    let ledgerThere = false;
    try {
      ledgerThere = ledgerLive !== undefined && lstatSync(ledgerLive).isFile();
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
    if (ledgerLive && ledgerThere) staged = await o.backupLedger(ledgerLive);
    for (const area of o.areas) walk(area, "");
    const manifest: SnapshotManifest = { version: 1, taken_at: takenAt, reason: o.reason, entries };
    const fd = openSync(join(next, MANIFEST), CREATE, 0o600);
    try {
      const buf = Buffer.from(JSON.stringify(manifest));
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(next);
    swapIn(o.dir);
  } catch (err) {
    rmSync(next, { recursive: true, force: true });
    throw err;
  }
  r.ms = Date.now() - started;
  return r;
}

/** The parts of the live state that hold anything: none on a container's fresh disk. */
export function liveHolds(areas: readonly SnapshotArea[]): string[] {
  const holds: string[] = [];
  for (const a of areas) {
    try {
      const names = readdirSync(a.live).filter((n) => !leftOut(a, n));
      if (names.length) holds.push(a.name);
    } catch (err) {
      if (errCode(err) !== "ENOENT") holds.push(a.name);
    }
  }
  return holds;
}

export interface RestoreResult {
  from: string;
  taken_at: string;
  reason: string;
  /** What was restored into each part. */
  areas: Record<string, { files: number; dirs: number; bytes: number }>;
  /** What was not, and why. */
  refused: string[];
}

/** Where a part is restored before it takes its live folder's place. */
export const RESTORING = ".restoring";

/**
 * Copies the newest complete snapshot back into the live folders, which must hold nothing but
 * what a snapshot leaves out (liveHolds): plain files and folders only, under the parts this rig
 * has and the names a snapshot holds, each given its part's owner and the mode it had. Each part
 * is written beside its live folder first (`<live>.restoring`) and renamed into place once every
 * part is written: a restore that fails leaves the live folders as they were, to try again at the
 * next start. Nothing in the snapshot folder changes. `own` gives a restored path its owner
 * (root's lchown by default; tests give their own). Undefined when there is no complete snapshot.
 */
export function restoreSnapshot(o: {
  dir: string;
  areas: readonly SnapshotArea[];
  own?: (path: string, uid: number, gid: number) => void;
}): RestoreResult | undefined {
  const found = pickSnapshot(o.dir);
  if (!found) return undefined;
  const own = o.own ?? ((p: string, uid: number, gid: number) => lchownSync(p, uid, gid));
  const byName = new Map(o.areas.map((a) => [a.name, a]));
  const staging = (a: SnapshotArea) => `${a.live}${RESTORING}`;
  for (const a of o.areas) rmSync(staging(a), { recursive: true, force: true });
  const result: RestoreResult = {
    from: found.name,
    taken_at: found.manifest.taken_at,
    reason: found.manifest.reason,
    areas: {},
    refused: [],
  };
  const restored = new Set<string>();
  const dirModes: [string, number][] = [];
  const renamed: SnapshotArea[] = [];
  const countsOf = (area: AreaName) => {
    const counts = result.areas[area] ?? { files: 0, dirs: 0, bytes: 0 };
    result.areas[area] = counts;
    return counts;
  };
  try {
    for (const e of found.manifest.entries) {
      const label = `${e.area}/${e.path}`;
      const refuse = (why: string) => result.refused.push(`${label}: ${why}`);
      const area = byName.get(e.area);
      if (!area) {
        refuse("not a part of this rig");
        continue;
      }
      if (!safeRel(e.path) || leftOut(area, e.path)) {
        refuse("not a name a snapshot holds");
        continue;
      }
      if (e.path === "" && e.type !== "dir") {
        refuse("a part's top must be a folder");
        continue;
      }
      const cut = e.path.lastIndexOf("/");
      const parent = e.path === "" ? undefined : cut < 0 ? "" : e.path.slice(0, cut);
      if (parent !== undefined && !restored.has(`${e.area}\0${parent}`)) {
        refuse("its folder was not restored");
        continue;
      }
      const src = e.path ? join(found.path, e.area, e.path) : join(found.path, e.area);
      const dest = e.path ? join(staging(area), e.path) : staging(area);
      let st: Stats;
      try {
        st = lstatSync(src);
      } catch {
        refuse("missing from the snapshot");
        continue;
      }
      if (st.isSymbolicLink()) {
        refuse("a link");
        continue;
      }
      if (e.type === "dir") {
        if (!st.isDirectory()) {
          refuse("not a folder");
          continue;
        }
        if (e.path === "") mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
        mkdirSync(dest, { mode: 0o700 });
        own(dest, area.uid, area.gid);
        // Its own mode once everything in it is there: no set-user-id bit on a folder.
        dirModes.push([dest, e.mode & 0o3777]);
        restored.add(`${e.area}\0${e.path}`);
        countsOf(e.area).dirs++;
        continue;
      }
      if (!st.isFile()) {
        refuse("not a plain file: a device, a pipe or a socket");
        continue;
      }
      const c = copyPlain(src, dest);
      if (!c || "refused" in c) {
        refuse(c ? c.refused : "missing from the snapshot");
        continue;
      }
      if (e.size !== undefined && c.bytes !== e.size) {
        rmSync(dest, { force: true });
        refuse(`${c.bytes} bytes, not the ${e.size} the snapshot recorded`);
        continue;
      }
      own(dest, area.uid, area.gid);
      // No set-id bit on a file: the rig image has none anywhere.
      chmodSync(dest, e.mode & 0o777);
      if (e.mtime_ms !== undefined) utimesSync(dest, e.mtime_ms / 1000, e.mtime_ms / 1000);
      const counts = countsOf(e.area);
      counts.files++;
      counts.bytes += c.bytes;
    }
    for (const [path, mode] of dirModes.reverse()) chmodSync(path, mode);
    // Every part is written: each takes its live folder's place, which holds at most what a
    // snapshot leaves out (a temporary folder, an export not finished, a stale write-ahead file).
    for (const a of o.areas)
      if (restored.has(`${a.name}\0`) && liveHolds([a]).length)
        throw new Error(`${a.live} is not empty: nothing is restored over it`);
    for (const a of o.areas) {
      if (!restored.has(`${a.name}\0`)) continue;
      rmSync(a.live, { recursive: true, force: true });
      renameSync(staging(a), a.live);
      renamed.push(a);
    }
  } catch (err) {
    // All or nothing: a part already in place goes again, so the next start restores them all.
    for (const a of renamed) rmSync(a.live, { recursive: true, force: true });
    for (const a of o.areas) rmSync(staging(a), { recursive: true, force: true });
    throw err;
  }
  return result;
}

/**
 * Makes the snapshot folder, root's with mode 0700, and says what owner and mode the volume
 * shows for it. Never changes its owner: the volume may refuse it. A link there is refused.
 */
export function prepareSnapshotDir(dir: string): { uid: number; gid: number; mode: number } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  chmodSync(dir, 0o700);
  const st = lstatSync(dir);
  return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
}

/** Run as another user: whether it can list the snapshot folder and write in it, as JSON. */
export const CLOSED_PROBE_JS = `const fs=require("node:fs");const d=process.argv[1];const out={};try{fs.readdirSync(d);out.list="ALLOWED"}catch(e){out.list=e.code||String(e)}const p=d+"/probe-"+process.getuid();try{fs.writeFileSync(p,"x",{flag:"wx"});out.create="ALLOWED";try{fs.rmSync(p)}catch{}}catch(e){out.create=e.code||String(e)}process.stdout.write(JSON.stringify(out))`;

/**
 * What each user met trying to list the snapshot folder and write in it (`run` runs the probe's
 * command as that user): "refused (EACCES)", or a failure: "OPENED: …" or "failed: …".
 */
export function closedTo(
  users: readonly string[],
  run: (user: string) => { status: number | null; stdout: string; stderr: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const user of users) {
    const r = run(user);
    let got: { list?: unknown; create?: unknown };
    try {
      got = JSON.parse(r.stdout) as typeof got;
    } catch {
      out[user] = `failed: exit ${r.status} ${r.stderr.trim().slice(-200)}`;
      continue;
    }
    const opened = [
      ...(got.list === "ALLOWED" ? ["lists it"] : []),
      ...(got.create === "ALLOWED" ? ["writes in it"] : []),
    ];
    const code = (v: unknown) => typeof v === "string" && /^E[A-Z]+$/.test(v);
    out[user] = opened.length
      ? `OPENED: ${opened.join(" and ")}`
      : code(got.list) && code(got.create)
        ? `refused (${got.list})`
        : `failed: ${r.stdout.slice(0, 200)}`;
  }
  return out;
}

/** The broker's record of the snapshot folder (SNAPSHOT_RECORD), for the isolation selftest. */
export interface SnapshotRecord {
  dir: string;
  /** The owner and mode the volume shows for it, as "uid:gid" and octal. */
  owner: string;
  mode: string;
  /** What each user met trying to list it and write in it (closedTo). */
  users: Record<string, string>;
  /** Every user was refused: snapshots are taken and restored. */
  closed: boolean;
  at: string;
}

/** What the broker gives its helper (snapshot-main.ts) to take a snapshot, as JSON. */
export const TakeJob = z.object({
  dir: z.string(),
  reason: z.string(),
  areas: z.array(
    z.object({
      name: z.enum(AREA_NAMES),
      live: z.string(),
      uid: z.number().int(),
      gid: z.number().int(),
      only: z.string().optional(),
    }),
  ),
  /** A folder root makes for the ledger's copy, which the controller's user writes. */
  stage: z.string(),
  /** The ledger's owner: the controller's user. */
  owner: z.object({ uid: z.number().int(), gid: z.number().int() }),
});
export type TakeJob = z.infer<typeof TakeJob>;

/** A snapshot being taken: whether it worked, and how to end it at once. */
export interface SnapshotJob {
  done: Promise<boolean>;
  abort: () => void;
}

export interface SnapshotterOptions {
  /** Starts taking a snapshot, for this reason. */
  take: (reason: string) => SnapshotJob;
  everyMs: number;
  /** After a snapshot that failed: 60 s by default. */
  retryMs?: number;
  /** A timed run is at work. */
  busy?: () => boolean;
  /** The longest a snapshot waits while busy: 5 minutes by default. */
  deferMs?: number;
  /** How often a waiting snapshot looks again: 2 s by default. */
  pollMs?: number;
}

/**
 * When snapshots are taken: every `everyMs`, and soon after each `request` (an export, an
 * enrollment), one at a time. A snapshot that falls due while `busy` (a timed run at work) waits
 * for it to end, up to `deferMs`, so its copying does not disturb the judge's timing. One that
 * fails is tried again after `retryMs`. `stop` takes the last one, within the time a stop allows.
 */
export class Snapshotter {
  private job: SnapshotJob | undefined;
  private wanted: string | undefined;
  private stopping = false;
  private waiting = false;
  private deferredSince: number | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private readonly o: SnapshotterOptions;

  constructor(o: SnapshotterOptions) {
    this.o = o;
  }

  start(): void {
    const every =
      this.o.everyMs >= 60_000
        ? `every ${Math.round((this.o.everyMs / 60_000) * 100) / 100} minutes`
        : `every ${this.o.everyMs / 1000} seconds`;
    this.interval = setInterval(() => this.request(every), this.o.everyMs);
    this.interval.unref?.();
  }

  /** A snapshot soon: now, or after the one being taken. */
  request(reason: string): void {
    if (this.stopping) return;
    this.wanted ??= reason;
    this.kick();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  private kick(): void {
    if (this.job || this.wanted === undefined || this.stopping) return;
    if (this.o.busy?.()) {
      const now = Date.now();
      this.deferredSince ??= now;
      if (now - this.deferredSince < (this.o.deferMs ?? 300_000)) {
        if (!this.waiting) {
          this.waiting = true;
          this.later(this.o.pollMs ?? 2000, () => {
            this.waiting = false;
            this.kick();
          });
        }
        return;
      }
    }
    this.deferredSince = undefined;
    const reason = this.wanted;
    this.wanted = undefined;
    const job = this.o.take(reason);
    this.job = job;
    void job.done
      .then(
        (ok) => ok,
        () => false,
      )
      .then((ok) => {
        if (this.job === job) this.job = undefined;
        if (this.stopping) return;
        if (!ok) this.later(this.o.retryMs ?? 60_000, () => this.request("again, after a failure"));
        this.kick();
      });
  }

  /**
   * At a stop: no more snapshots but this last one, taken once the one under way (if any) ends.
   * Gives up after `budgetMs`, ending the one under way; the last complete snapshot then stays.
   */
  async stop(budgetMs: number): Promise<"taken" | "failed" | "out of time"> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const deadline = Date.now() + budgetMs;
    const wait = (job: SnapshotJob) =>
      new Promise<boolean | "time">((resolve) => {
        const t = setTimeout(() => resolve("time"), Math.max(0, deadline - Date.now()));
        job.done.then(
          (ok) => {
            clearTimeout(t);
            resolve(ok);
          },
          () => {
            clearTimeout(t);
            resolve(false);
          },
        );
      });
    if (this.job) {
      const before = this.job;
      if ((await wait(before)) === "time") {
        before.abort();
        return "out of time";
      }
    }
    const job = this.o.take("at the stop");
    this.job = job;
    const r = await wait(job);
    this.job = undefined;
    if (r === "time") {
      job.abort();
      return "out of time";
    }
    return r ? "taken" : "failed";
  }

  /** Ends the snapshot under way now (a second stop signal). */
  abort(): void {
    this.job?.abort();
  }
}
