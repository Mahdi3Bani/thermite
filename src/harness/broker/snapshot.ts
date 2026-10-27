import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { minutesSetting, numberSetting, secondsSetting } from "../../common/settings.ts";
import { oneContainer, supervisorPaths } from "./one-container.ts";
import { IDS } from "./runner.ts";
import {
  type FileDigest,
  FileOpener,
  FileSealer,
  SEAL_HEADER_BYTES,
  SEAL_MAGIC,
  SEAL_OVERHEAD,
  type SnapshotKeys,
  SnapshotRefused,
  sameDigest,
  seal,
  unseal,
} from "./seal.ts";

/**
 * The rig's state over a stop of a host that empties the container's own disk, such as a RunPod
 * pod (THERMITE_STATE_SNAPSHOT_DIR; the one-container rig image sets it). The live state stays
 * on the container's disk, where each part and each role keeps the owners it has everywhere else.
 * Root copies it into a snapshot on the host's volume every few minutes, after each export and at
 * a stop, and puts the newest snapshot back at a start on an empty disk.
 *
 * - The snapshot is sealed (seal.ts): RunPod's volume ignores file permissions, so any user may
 *   read the folder or write in it. Each file is encrypted and authenticated under the pod's
 *   snapshot key, and named by a keyed hash of its content; the manifest (each file's part, path,
 *   owner, mode, time, size, sealed name and SHA-256) is sealed too. A restore takes a snapshot
 *   only when its manifest and every file in it verify, and refuses it whole otherwise.
 * - The folder holds the manifest, `manifest.new` while one is written, and the sealed files, all
 *   side by side. A file whose content is sealed there already is not sealed again; one that has
 *   not changed since the last snapshot (the same size and time) is not even read. A take writes
 *   `manifest.new` last and renames it onto `manifest`; then the sealed files no manifest names go.
 * - Root works in the folder from inside it (its working folder), by bare names: another user
 *   who renames the folder or swaps it for a link can never send root's writes, reads or removals
 *   elsewhere. Nothing under it is ever given another owner (RunPod's volume refuses even root
 *   that), so the owners and modes the live folders need are in the manifest, and a restore sets
 *   them on the container's disk.
 * - The ledger is copied with SQLite's backup, as the controller's user, never as a raw file, and
 *   first: an export the ledger records is then in the outbox's copy too.
 * - Only plain files and folders of the expected owner are taken, and only plain files and
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

/** The names in the snapshot folder: the manifest, and the one being written. */
export const SEALED = { manifest: "manifest", next: "manifest.new" } as const;
/** A sealed file: the keyed hash of its content, in hexadecimal. */
export const SEALED_FILE = /^[0-9a-f]{64}$/;
/** A sealed file being written. */
export const SEALING_FILE = /^\.new-[0-9a-f]{32}$/;
/** What a user's probe of the folder makes, empty, and removes again. */
export const PROBE_FILE = /^probe-\d+$/;
/** The folders an image before sealing kept its snapshot in, unsealed. */
export const UNSEALED_DIRS: readonly string[] = ["snapshot", "snapshot.new", "snapshot.old"];
/** The ledger, in the harness's state folder. */
export const LEDGER_FILE = "ledger/ledger.db";
/** The broker's record of the snapshot folder, next to its socket, for the isolation selftest. */
export const SNAPSHOT_RECORD = "snapshot.json";
/** The most a manifest may hold. */
const MANIFEST_MAX_BYTES = 512 * 1024 * 1024;
const CHUNK = 1024 * 1024;

/** THERMITE_STATE_SNAPSHOT_DIR, or none: no snapshot (compose and Kubernetes rigs). */
export function snapshotDir(env: Env): string | undefined {
  return env.THERMITE_STATE_SNAPSHOT_DIR || undefined;
}

/** How often a snapshot is taken (THERMITE_STATE_SNAPSHOT_MINUTES, 5 by default). */
export function snapshotEveryMs(env: Env): number {
  return minutesSetting(env, "THERMITE_STATE_SNAPSHOT_MINUTES", 5);
}

/** How long a stop waits for its snapshot (THERMITE_STATE_SNAPSHOT_STOP_SECONDS, 8). */
export function stopBudgetMs(env: Env): number {
  return secondsSetting(env, "THERMITE_STATE_SNAPSHOT_STOP_SECONDS", 8);
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
      gid: numberSetting(env, "THERMITE_OUTBOX_GID", 10001, { integer: true }),
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

const HEX64 = /^[0-9a-f]{64}$/;
const Entry = z
  .object({
    area: z.enum(AREA_NAMES),
    path: z.string(),
    type: z.enum(["dir", "file"]),
    mode: z.number().int().min(0).max(0o7777),
    /** The owner it had when it was taken: each part's own (only its files are taken). */
    uid: z.number().int().min(0),
    gid: z.number().int().min(0),
    mtime_ms: z.number().optional(),
    /** A file's size, its sealed file's name and its content's SHA-256. */
    size: z.number().int().min(0).optional(),
    sealed: z.string().regex(HEX64).optional(),
    sha256: z.string().regex(HEX64).optional(),
    ledger: z.literal(true).optional(),
  })
  .refine(
    (e) =>
      e.type === "dir"
        ? e.sealed === undefined
        : e.size !== undefined && e.sealed !== undefined && e.sha256 !== undefined,
    "a file names its size, its sealed file and its SHA-256; a folder none of them",
  );
export type SnapshotEntry = z.infer<typeof Entry>;
const Manifest = z.object({
  format: z.literal("thermite-state-snapshot"),
  version: z.literal(2),
  /** The rig it is of (THERMITE_RIG_ID), or null. A restore checks it. */
  rig: z.string().nullable(),
  /** One more than the snapshot before it: 1 for the first. */
  seq: z.number().int().min(1),
  taken_at: z.string(),
  reason: z.string(),
  entries: z.array(Entry),
});
export type SnapshotManifest = z.infer<typeof Manifest>;

const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let n = 0;
  while (n < length) {
    const got = readSync(fd, buf, n, length - n, position + n);
    if (got === 0) break;
    n += got;
  }
  return buf.subarray(0, n);
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

/**
 * Runs `fn` inside the snapshot folder: its working folder is the folder, and every name `fn`
 * uses is a bare name in it. Another user who renames the folder or puts a link in its place
 * (a volume that ignores permissions lets any user) can then never send root's writes, reads or
 * removals elsewhere. The folder must be a folder, not a link, and still the one entered.
 */
export function inSnapshotFolder<T>(dir: string, fn: () => T): T {
  let back = "/";
  try {
    back = process.cwd();
  } catch {
    // the working folder is gone: come back to /
  }
  const before = lstatSync(dir);
  if (!before.isDirectory()) throw new Error(`${dir} is not a folder`);
  process.chdir(dir);
  try {
    const here = statSync(".");
    const after = lstatSync(dir);
    if (
      !after.isDirectory() ||
      here.ino !== before.ino ||
      here.dev !== before.dev ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    )
      throw new Error(`${dir} changed as it was opened: nothing is read or written there`);
    return fn();
  } finally {
    process.chdir(back);
  }
}

/** A plain file in the working folder, whole, or nothing when it is not there. */
function readWhole(name: string, max: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(name, READ);
  } catch (err) {
    if (errCode(err) === "ENOENT") return undefined;
    throw new Error(
      errCode(err) === "ELOOP" ? "it is a link" : `it can't be opened (${message(err)})`,
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("it is not a plain file");
    if (st.size > max) throw new Error(`it is larger than ${max} bytes`);
    return readAt(fd, st.size, 0);
  } finally {
    closeSync(fd);
  }
}

type ManifestRead = { manifest: SnapshotManifest } | { why: string } | undefined;

/** A manifest in the working folder, opened and checked; nothing when it is not there. */
function readManifest(name: string, keys: SnapshotKeys): ManifestRead {
  let sealed: Buffer | undefined;
  try {
    sealed = readWhole(name, MANIFEST_MAX_BYTES);
  } catch (err) {
    return { why: `its ${name}: ${message(err)}` };
  }
  if (!sealed) return undefined;
  let plain: Buffer;
  try {
    plain = unseal(keys.manifest, "manifest", sealed);
  } catch (err) {
    return { why: `its ${name}: ${message(err)}` };
  }
  try {
    const parsed = Manifest.safeParse(JSON.parse(plain.toString("utf8")));
    if (parsed.success) return { manifest: parsed.data };
  } catch {
    // not JSON
  }
  return { why: `its ${name} is not a snapshot's manifest` };
}

/**
 * The newest snapshot in the working folder whose manifest verifies: `manifest`, or a complete
 * `manifest.new` a take left before its rename. Nothing when neither is there; why, when one is
 * there and none verifies.
 */
function pickManifest(
  keys: SnapshotKeys,
): { name: string; manifest: SnapshotManifest } | { why: string } | undefined {
  const reads = [SEALED.manifest, SEALED.next].map((name) => ({
    name,
    read: readManifest(name, keys),
  }));
  let best: { name: string; manifest: SnapshotManifest } | undefined;
  for (const { name, read } of reads)
    if (read && "manifest" in read && (!best || read.manifest.seq > best.manifest.seq))
      best = { name, manifest: read.manifest };
  if (best) return best;
  const failed = reads.find((r) => r.read && "why" in r.read)?.read;
  return failed && "why" in failed ? { why: failed.why } : undefined;
}

/**
 * Finishes what a take that was stopped left, in the working folder: a `manifest.new` that
 * verifies and is newer takes the place of `manifest`; one that does not goes. Gives the newest
 * manifest that verifies, or why the one there does not.
 */
function settle(keys: SnapshotKeys): { manifest?: SnapshotManifest; why?: string } {
  const cur = readManifest(SEALED.manifest, keys);
  let best = cur && "manifest" in cur ? cur.manifest : undefined;
  const next = readManifest(SEALED.next, keys);
  if (next) {
    if ("manifest" in next && (!best || next.manifest.seq > best.seq)) {
      renameSync(SEALED.next, SEALED.manifest);
      fsyncDir(".");
      best = next.manifest;
    } else unlinkSync(SEALED.next);
  }
  if (best) return { manifest: best };
  return cur && "why" in cur ? { why: cur.why } : {};
}

/** Whether a sealed file is in the working folder, with the size sealing gives `size` bytes. */
function sealedThere(name: string, size: number): boolean {
  try {
    const st = lstatSync(name);
    return st.isFile() && st.size === size + SEAL_OVERHEAD;
  } catch {
    return false;
  }
}

/**
 * Seals what `fd` holds into the working folder: into a new file of its own first, then renamed
 * to its sealed name, unless a sealed file of that name is there already (the same content).
 */
function sealInto(fd: number, keys: SnapshotKeys): FileDigest & { reused: boolean } {
  const temp = `.new-${randomBytes(16).toString("hex")}`;
  const out = openSync(temp, CREATE, 0o600);
  let digest: FileDigest;
  try {
    const sealer = new FileSealer(keys);
    writeAll(out, sealer.header);
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const got = readSync(fd, buf, 0, buf.length, null);
      if (got === 0) break;
      writeAll(out, sealer.update(buf.subarray(0, got)));
    }
    const end = sealer.final();
    writeAll(out, end.tail);
    fsyncSync(out);
    digest = end.digest;
  } catch (err) {
    closeSync(out);
    rmSync(temp, { force: true });
    throw err;
  }
  closeSync(out);
  if (sealedThere(digest.name, digest.size)) {
    unlinkSync(temp);
    return { ...digest, reused: true };
  }
  renameSync(temp, digest.name);
  return { ...digest, reused: false };
}

/**
 * Removes from the working folder what no manifest names: sealed files, files being sealed that
 * a stopped take left, and the users' empty probe files. Never a folder, and nothing else: a name
 * a sealed snapshot never uses stays, for the isolation check to find.
 */
function sweep(keep: ReadonlySet<string>): number {
  let removed = 0;
  for (const name of readdirSync(".")) {
    if (name === SEALED.manifest || keep.has(name)) continue;
    if (!SEALED_FILE.test(name) && !SEALING_FILE.test(name) && !PROBE_FILE.test(name)) continue;
    try {
      if (lstatSync(name).isDirectory()) continue;
      unlinkSync(name);
      removed++;
    } catch {
      // gone meanwhile
    }
  }
  return removed;
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
  /** Its number: one more than the snapshot before it. */
  seq: number;
  files: number;
  dirs: number;
  bytes: number;
  /** Files whose sealed file was there already: unchanged, or the same content as another. */
  reused: number;
  /** Files sealed now. */
  sealed: number;
  /** Sealed files no manifest names any more, removed after the swap. */
  removed: number;
  ledger: boolean;
  /** Why the manifest before it did not verify, when it did not: every file was sealed again. */
  before_refused?: string;
  /** What was not taken, and why: links, devices, pipes, sockets, another owner's files. */
  skipped: string[];
  ms: number;
}

/**
 * Takes a sealed snapshot of `areas` into `dir` (root's folder on the volume). `backupLedger`
 * makes a consistent copy of the live ledger and gives its path (the broker makes it as the
 * controller's user). Throws when the snapshot can't be written; the snapshot before it then stays.
 */
export async function takeSnapshot(o: {
  dir: string;
  areas: readonly SnapshotArea[];
  reason: string;
  keys: SnapshotKeys;
  /** The rig's ID (THERMITE_RIG_ID), recorded in the manifest. */
  rig?: string | null | undefined;
  backupLedger: (source: string) => Promise<string>;
  now?: () => Date;
}): Promise<TakeResult> {
  const started = Date.now();
  const takenAt = (o.now?.() ?? new Date()).toISOString();
  const harness = o.areas.find((a) => a.name === "harness");
  const ledgerLive = harness ? join(harness.live, LEDGER_FILE) : undefined;
  // The ledger first, before any other part is read: an export the ledger records as made is
  // then in the outbox's copy too (one made after it is exported again, never lost).
  let ledgerThere = false;
  try {
    ledgerThere = ledgerLive !== undefined && lstatSync(ledgerLive).isFile();
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  const staged = ledgerLive && ledgerThere ? await o.backupLedger(ledgerLive) : undefined;
  return inSnapshotFolder(o.dir, () => {
    const settled = settle(o.keys);
    const before = new Map<string, SnapshotEntry>();
    for (const e of settled.manifest?.entries ?? [])
      if (e.type === "file" && !e.ledger) before.set(`${e.area}\0${e.path}`, e);
    const entries: SnapshotEntry[] = [];
    const r: TakeResult = {
      taken_at: takenAt,
      reason: o.reason,
      seq: (settled.manifest?.seq ?? 0) + 1,
      files: 0,
      dirs: 0,
      bytes: 0,
      reused: 0,
      sealed: 0,
      removed: 0,
      ledger: false,
      ...(settled.why ? { before_refused: settled.why } : {}),
      skipped: [],
      ms: 0,
    };
    const skip = (area: SnapshotArea, rel: string, why: string): void => {
      r.skipped.push(`${area.name}/${rel}: ${why}`);
    };
    const addFile = (
      area: SnapshotArea,
      rel: string,
      st: Stats,
      d: FileDigest,
      reused: boolean,
      ledger = false,
    ) => {
      entries.push({
        area: area.name,
        path: rel,
        type: "file",
        mode: st.mode & 0o777,
        uid: st.uid,
        gid: st.gid,
        mtime_ms: st.mtimeMs,
        size: d.size,
        sealed: d.name,
        sha256: d.sha256,
        ...(ledger ? { ledger: true as const } : {}),
      });
      r.files++;
      r.bytes += d.size;
      if (reused) r.reused++;
      else r.sealed++;
    };
    /** Seals a plain file opened without following a link; why not, or undefined when gone. */
    const sealPlain = (
      path: string,
      owner: number | undefined,
    ): (FileDigest & { reused: boolean }) | { refused: string } | undefined => {
      let fd: number;
      try {
        fd = openSync(path, READ);
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
        return sealInto(fd, o.keys);
      } finally {
        closeSync(fd);
      }
    };
    const walk = (area: SnapshotArea, rel: string): void => {
      if (leftOut(area, rel)) return;
      const live = rel ? join(area.live, rel) : area.live;
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
        entries.push({
          area: area.name,
          path: rel,
          type: "dir",
          mode: st.mode & 0o7777,
          uid: st.uid,
          gid: st.gid,
        });
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
        const c = sealPlain(staged, undefined);
        if (!c || "refused" in c) throw new Error("the ledger's copy is gone or not a plain file");
        addFile(area, rel, st, c, c.reused, true);
        r.ledger = true;
        return;
      }
      // Unchanged since the last snapshot, and its sealed file still there: not read again.
      const was = before.get(`${area.name}\0${rel}`);
      if (
        was?.sealed !== undefined &&
        was.sha256 !== undefined &&
        was.mtime_ms !== undefined &&
        was.size === st.size &&
        Math.abs(was.mtime_ms - st.mtimeMs) < 0.001 &&
        sealedThere(was.sealed, was.size)
      ) {
        addFile(area, rel, st, { name: was.sealed, sha256: was.sha256, size: was.size }, true);
        return;
      }
      const c = sealPlain(live, area.uid);
      if (!c) return;
      if ("refused" in c) {
        skip(area, rel, c.refused);
        return;
      }
      addFile(area, rel, st, c, c.reused);
    };
    let wroteNext = false;
    try {
      for (const area of o.areas) walk(area, "");
      const manifest: SnapshotManifest = {
        format: "thermite-state-snapshot",
        version: 2,
        rig: o.rig ?? null,
        seq: r.seq,
        taken_at: takenAt,
        reason: o.reason,
        entries,
      };
      const sealed = seal(o.keys.manifest, "manifest", Buffer.from(JSON.stringify(manifest)));
      rmSync(SEALED.next, { force: true });
      wroteNext = true;
      const fd = openSync(SEALED.next, CREATE, 0o600);
      try {
        writeAll(fd, sealed);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDir(".");
      renameSync(SEALED.next, SEALED.manifest);
      wroteNext = false;
      fsyncDir(".");
    } catch (err) {
      if (wroteNext) rmSync(SEALED.next, { force: true });
      throw err;
    }
    r.removed = sweep(new Set(entries.flatMap((e) => (e.sealed ? [e.sealed] : []))));
    r.ms = Date.now() - started;
    return r;
  });
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
  /** The manifest it came from: `manifest`, or a complete `manifest.new`. */
  from: string;
  seq: number;
  taken_at: string;
  reason: string;
  /** What was restored into each part. */
  areas: Record<string, { files: number; dirs: number; bytes: number }>;
  /** What the manifest names that this rig does not restore, and why. */
  refused: string[];
}

/** Where a part is restored before it takes its live folder's place. */
export const RESTORING = ".restoring";

/**
 * Opens a sealed file of the working folder into `dest`, a new file: its size, its tag, and the
 * content's SHA-256, size and keyed hash must all be the ones the manifest names, or it throws
 * SnapshotRefused. Gives the bytes written.
 */
function openInto(
  e: { sealed: string; sha256: string; size: number },
  dest: string,
  keys: SnapshotKeys,
): number {
  let fd: number;
  try {
    fd = openSync(e.sealed, READ);
  } catch (err) {
    if (errCode(err) === "ENOENT") throw new SnapshotRefused("its sealed file is missing");
    if (errCode(err) === "ELOOP") throw new SnapshotRefused("its sealed file is a link");
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SnapshotRefused("its sealed file is not a plain file");
    if (st.size !== e.size + SEAL_OVERHEAD)
      throw new SnapshotRefused(
        `its sealed file is ${st.size} bytes, not the ${e.size + SEAL_OVERHEAD} the manifest gives`,
      );
    const tagAt = st.size - (SEAL_OVERHEAD - SEAL_HEADER_BYTES);
    const opener = new FileOpener(keys, readAt(fd, SEAL_HEADER_BYTES, 0), readAt(fd, 16, tagAt));
    const out = openSync(dest, CREATE, 0o600);
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (let pos = SEAL_HEADER_BYTES; pos < tagAt; ) {
        const got = readSync(fd, buf, 0, Math.min(buf.length, tagAt - pos), pos);
        if (got === 0) throw new SnapshotRefused("its sealed file is cut short");
        writeAll(out, opener.update(buf.subarray(0, got)));
        pos += got;
      }
      const end = opener.final();
      writeAll(out, end.tail);
      if (
        end.digest.size !== e.size ||
        !sameDigest(end.digest.sha256, e.sha256) ||
        !sameDigest(end.digest.name, e.sealed)
      )
        throw new SnapshotRefused("its content is not the one the manifest names");
      return end.digest.size;
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Puts the newest snapshot back into the live folders, which must hold nothing but what a
 * snapshot leaves out (liveHolds). The manifest must verify, be this rig's (`rig`), and every
 * file it names must verify against it: otherwise the whole snapshot is refused (SnapshotRefused)
 * and nothing is restored. Plain files and folders only, under the parts this rig has and the
 * names a snapshot holds, each given its part's owner and the mode it had. Each part is written
 * beside its live folder first (`<live>.restoring`) and renamed into place once every part is
 * written and verified: a restore that fails leaves the live folders as they were. Nothing in the
 * snapshot folder changes. `own` gives a restored path its owner (root's lchown by default; tests
 * give their own). Undefined when there is no snapshot.
 */
export function restoreSnapshot(o: {
  dir: string;
  areas: readonly SnapshotArea[];
  keys: SnapshotKeys;
  rig?: string | null | undefined;
  own?: (path: string, uid: number, gid: number) => void;
}): RestoreResult | undefined {
  return inSnapshotFolder(o.dir, () => {
    const found = pickManifest(o.keys);
    if (!found) return undefined;
    if ("why" in found) throw new SnapshotRefused(found.why);
    const m = found.manifest;
    if ((m.rig ?? null) !== (o.rig ?? null))
      throw new SnapshotRefused(
        `it is ${m.rig ? `rig ${m.rig}'s` : "no rig's"}, not ${o.rig ? `rig ${o.rig}'s` : "this rig's"}`,
      );
    const own = o.own ?? ((p: string, uid: number, gid: number) => lchownSync(p, uid, gid));
    const byName = new Map(o.areas.map((a) => [a.name, a]));
    const staging = (a: SnapshotArea) => `${a.live}${RESTORING}`;
    for (const a of o.areas) rmSync(staging(a), { recursive: true, force: true });
    const result: RestoreResult = {
      from: found.name,
      seq: m.seq,
      taken_at: m.taken_at,
      reason: m.reason,
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
      for (const e of m.entries) {
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
        const dest = e.path ? join(staging(area), e.path) : staging(area);
        if (e.type === "dir") {
          if (e.path === "") mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
          mkdirSync(dest, { mode: 0o700 });
          own(dest, area.uid, area.gid);
          // Its own mode once everything in it is there: no set-user-id bit on a folder.
          dirModes.push([dest, e.mode & 0o3777]);
          restored.add(`${e.area}\0${e.path}`);
          countsOf(e.area).dirs++;
          continue;
        }
        let bytes: number;
        try {
          bytes = openInto(
            { sealed: e.sealed as string, sha256: e.sha256 as string, size: e.size as number },
            dest,
            o.keys,
          );
        } catch (err) {
          if (err instanceof SnapshotRefused) throw new SnapshotRefused(`${label}: ${err.message}`);
          throw err;
        }
        own(dest, area.uid, area.gid);
        // No set-id bit on a file: the rig image has none anywhere.
        chmodSync(dest, e.mode & 0o777);
        if (e.mtime_ms !== undefined) utimesSync(dest, e.mtime_ms / 1000, e.mtime_ms / 1000);
        const counts = countsOf(e.area);
        counts.files++;
        counts.bytes += bytes;
      }
      for (const [path, mode] of dirModes.reverse()) chmodSync(path, mode);
      // Every part is written and verified: each takes its live folder's place, which holds at
      // most what a snapshot leaves out (a temporary folder, an export not finished, a stale
      // write-ahead file).
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
      // All or nothing: a part already in place goes again, so nothing half restored is left.
      for (const a of renamed) rmSync(a.live, { recursive: true, force: true });
      for (const a of o.areas) rmSync(staging(a), { recursive: true, force: true });
      throw err;
    }
    return result;
  });
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

/**
 * The folders an image before sealing left in the snapshot folder: an unsealed snapshot, which
 * is never restored. Removed only where no other user may write in the folder (`closed`); where
 * one may, a recursive removal could be sent elsewhere, so they stay, and the isolation check
 * names them. Gives what was removed, and what was left.
 */
export function removeUnsealed(
  dir: string,
  closed: boolean,
): { removed: string[]; left: string[] } {
  const out = { removed: [] as string[], left: [] as string[] };
  for (const name of UNSEALED_DIRS) {
    const path = join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (closed && st.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
      out.removed.push(name);
    } else out.left.push(name);
  }
  return out;
}

/** What a look into the snapshot folder found (inspectSnapshotFolder). */
export interface FolderLook {
  /** A manifest is there. */
  manifest: boolean;
  /** Sealed files, not counting those being written. */
  files: number;
  /** The first thing a sealed snapshot never holds: a file that is not sealed, or another name. */
  problem?: string;
}

/**
 * What the snapshot folder holds, looked at from outside it (the isolation check): only the
 * manifest, sealed files and empty probe files may be there, each sealed file starting as sealing
 * starts one. An empty file holds nothing and passes. Throws when the folder can't be listed. The
 * role probe (selftest.ts, PROBE) looks the same way.
 */
export function inspectSnapshotFolder(dir: string): FolderLook {
  const look: FolderLook = { manifest: false, files: 0 };
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory())
      return {
        ...look,
        problem: UNSEALED_DIRS.includes(name)
          ? `an unsealed snapshot an older image left: ${name}`
          : `a folder a sealed snapshot never holds: ${name}`,
      };
    if (!st.isFile())
      return { ...look, problem: `a link or special file a sealed snapshot never holds: ${name}` };
    const kind =
      name === SEALED.manifest || name === SEALED.next
        ? "M"
        : SEALED_FILE.test(name) || SEALING_FILE.test(name)
          ? "B"
          : PROBE_FILE.test(name)
            ? "P"
            : undefined;
    if (!kind) return { ...look, problem: `a name a sealed snapshot never uses: ${name}` };
    if (st.size === 0) continue;
    if (kind === "P") return { ...look, problem: `a file that is not sealed: ${name}` };
    let head: Buffer;
    try {
      const fd = openSync(path, READ);
      try {
        head = readAt(fd, SEAL_MAGIC.length + 1, 0);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (head.toString("latin1") !== `${SEAL_MAGIC.toString("latin1")}${kind}`)
      return { ...look, problem: `a file that is not sealed: ${name}` };
    if (name === SEALED.manifest) look.manifest = true;
    else if (SEALED_FILE.test(name)) look.files++;
  }
  return look;
}

/** A look in words: "the manifest and 12 sealed files", or "no snapshot yet". */
export function lookWords(look: FolderLook): string {
  if (!look.manifest && !look.files) return "no snapshot yet";
  const files = `${look.files} sealed file${look.files === 1 ? "" : "s"}`;
  return look.manifest ? `the manifest and ${files}` : `${files} and no manifest`;
}

/**
 * Run as another user: whether it can list the snapshot folder and write in it, as JSON. Its
 * file is empty, and removed again.
 */
export const CLOSED_PROBE_JS = `const fs=require("node:fs");const d=process.argv[1];const out={};try{fs.readdirSync(d);out.list="ALLOWED"}catch(e){out.list=e.code||String(e)}const p=d+"/probe-"+process.getuid();try{fs.writeFileSync(p,"",{flag:"wx"});out.create="ALLOWED";try{fs.rmSync(p)}catch{}}catch(e){out.create=e.code||String(e)}process.stdout.write(JSON.stringify(out))`;

/**
 * What each user met trying to list the snapshot folder and write in it (`run` runs the probe's
 * command as that user): "refused (EACCES)", "OPENED: …" or "failed: …".
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
  /** Every user was refused. */
  closed: boolean;
  /** The launch gave the snapshot key: sealed snapshots are taken and restored. */
  sealed: boolean;
  /** Why no snapshot is taken or restored, when none is. */
  off?: string | undefined;
  at: string;
}

/** What the broker gives its helper (snapshot-main.ts) on its standard input, as JSON. */
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
  /** The rig's ID, for the manifest. */
  rig: z.string().nullable(),
  /** The snapshot key, in base64url: on the helper's standard input only, never its arguments. */
  key: z.string(),
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
