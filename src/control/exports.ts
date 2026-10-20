import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { canonicalJson } from "../core/canonical.ts";
import type { ControlStore, RigExport } from "./store.ts";

/**
 * Exports kept on control, for rigs with no results repository (src/supervisor/export-upload.ts
 * sends them). A rig starts an export with its manifest and the files it sends, then sends each
 * file in pieces, each at the place control says it has. Control checks every file against the
 * manifest's SHA-256 when its last byte arrives, keeps it only then, and counts the export as
 * complete once every file it promised is kept. Only the owner reads them back.
 *
 * On disk: `<dir>/<rig>/<export>/manifest.json` and `<dir>/<rig>/<export>/files/<path>`, a file
 * still arriving as `<path>.part`.
 */

/** An export's name, as the harness makes them: a time and 8 hexadecimal characters. */
export const EXPORT_NAME = /^[0-9TZ]{8,20}-[0-9a-f]{8}$/;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A file's place in an export: plain names, no "." or ".." parts (as the exporter checks). */
const RelPath = z
  .string()
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._()-]+)*$/)
  .refine((p) => p.split("/").every((s) => s !== "." && s !== ".."), "a plain path");

const Manifest = z.looseObject({
  rig: z.string().max(200).optional(),
  full: z.boolean().optional(),
  from_event: z.number().int().min(0),
  through_event: z.number().int().min(0),
  files: z.record(RelPath, Sha256),
});

const Begin = z.strictObject({
  manifest: Manifest,
  /** The files the rig sends, each with its size in bytes. */
  files: z.record(RelPath, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
});

/** The pieces a rig sends: at most this many bytes each. */
export const EXPORT_PIECE_LIMIT = 16 * 1024 * 1024;

export class ExportFiles {
  readonly dir: string;
  /** Files being checked now: a second piece for one of them waits for the check. */
  private readonly busy = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private root(rig: string, name: string): string {
    // The rig's name comes from a route its token matched; refuse anything that is not a name.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(rig) || !EXPORT_NAME.test(name))
      throw new Error("not a rig's or an export's name");
    return join(this.dir, rig, name);
  }

  /** Where a kept file is. */
  file(rig: string, name: string, path: string): string {
    return join(this.root(rig, name), "files", path);
  }

  /** Bytes control has of a file: all of them once it is kept. */
  received(e: RigExport, path: string): number {
    if (e.done.includes(path)) return e.files[path]?.size ?? 0;
    const part = `${this.file(e.rig, e.name, path)}.part`;
    return existsSync(part) ? statSync(part).size : 0;
  }

  writeManifest(rig: string, name: string, manifest: unknown): void {
    const root = this.root(rig, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), `${canonicalJson(manifest)}\n`);
  }

  /**
   * One piece of a file, at `offset`. The file is checked when its last byte arrives: kept with
   * the manifest's SHA-256, or deleted.
   */
  async append(
    store: ControlStore,
    e: RigExport,
    path: string,
    offset: number,
    piece: Buffer,
  ): Promise<
    | { ok: true; received: number; done: boolean; complete: boolean }
    | { ok: false; status: 400 | 409 | 422; error: string; received: number }
  > {
    const want = e.files[path] as { size: number; sha256: string };
    const key = `${e.rig}\0${e.name}\0${path}`;
    const have = this.received(e, path);
    if (e.done.includes(path))
      return { ok: true, received: have, done: true, complete: e.complete_at !== null };
    if (this.busy.has(key))
      return { ok: false, status: 409, error: `${path} is being checked`, received: have };
    if (offset !== have)
      return {
        ok: false,
        status: 409,
        error: `control has ${have} bytes of ${path}, not ${offset}`,
        received: have,
      };
    if (have + piece.length > want.size)
      return {
        ok: false,
        status: 400,
        error: `${path} has ${want.size} bytes; this piece would go past its end`,
        received: have,
      };
    const target = this.file(e.rig, e.name, path);
    const part = `${target}.part`;
    mkdirSync(dirname(part), { recursive: true });
    appendFileSync(part, piece);
    const now = have + piece.length;
    if (now < want.size) return { ok: true, received: now, done: false, complete: false };
    this.busy.add(key);
    try {
      const h = createHash("sha256");
      await pipeline(createReadStream(part), h);
      const got = h.digest("hex");
      if (got !== want.sha256) {
        rmSync(part, { force: true });
        return {
          ok: false,
          status: 422,
          error: `the SHA-256 of ${path} is ${got}, not the manifest's ${want.sha256}: send it again`,
          received: 0,
        };
      }
      renameSync(part, target);
      const { complete } = store.rigExportFileDone(e.rig, e.name, path);
      return { ok: true, received: want.size, done: true, complete };
    } finally {
      this.busy.delete(key);
    }
  }
}

/** An export as the owner's list shows it. */
function summary(files: ExportFiles | undefined, e: RigExport) {
  return {
    name: e.name,
    full: e.full,
    from_event: e.from_event,
    through_event: e.through_event,
    files: Object.keys(e.files).length,
    files_kept: e.done.length,
    bytes: e.bytes,
    bytes_received: files
      ? Object.keys(e.files).reduce((n, p) => n + files.received(e, p), 0)
      : null,
    created_at: e.created_at,
    complete_at: e.complete_at,
  };
}

/**
 * The routes: a rig sends its exports with its own token; the owner lists and reads them. Without
 * a folder for exports (`files` undefined), a rig's export is refused and says why.
 */
export function mountExports(
  app: Hono,
  o: {
    store: ControlStore;
    files: ExportFiles | undefined;
    rigAuth: MiddlewareHandler;
    admin: MiddlewareHandler;
  },
): void {
  const { store, files } = o;
  const noFolder = "control keeps no exports: it has no folder for them";

  app.post(
    "/v1/rigs/:rig/exports/:name",
    o.rigAuth,
    bodyLimit({ maxSize: 8 * 1024 * 1024 }),
    async (c) => {
      const rig = c.req.param("rig");
      const name = c.req.param("name");
      if (!EXPORT_NAME.test(name)) return c.json({ error: "not an export's name" }, 400);
      if (!files) return c.json({ error: noFolder }, 503);
      const body = Begin.parse(await c.req.json());
      const m = body.manifest;
      if (m.rig !== undefined && m.rig !== rig)
        return c.json({ error: "the manifest names another rig" }, 400);
      // Everything but the ledger snapshot goes every time; a full export's snapshot goes too.
      const missing = Object.keys(m.files).filter(
        (p) => !(p in body.files) && (p !== "ledger.sqlite" || m.full === true),
      );
      if (missing.length)
        return c.json({ error: `the export leaves out ${missing.slice(0, 5).join(", ")}` }, 400);
      const extra = Object.keys(body.files).filter((p) => !(p in m.files));
      if (extra.length)
        return c.json({ error: `the manifest does not list ${extra.slice(0, 5).join(", ")}` }, 400);
      const promised = Object.fromEntries(
        Object.entries(body.files).map(([p, size]) => [p, { size, sha256: m.files[p] as string }]),
      );
      const r = store.beginRigExport(rig, name, {
        manifest: m,
        files: promised,
        full: m.full === true,
        fromEvent: m.from_event,
        throughEvent: m.through_event,
      });
      if (r === "different")
        return c.json({ error: `control has another export named ${name} from this rig` }, 409);
      if (r === "created") files.writeManifest(rig, name, m);
      const e = store.rigExport(rig, name) as RigExport;
      return c.json({
        received: Object.fromEntries(Object.keys(e.files).map((p) => [p, files.received(e, p)])),
        done: e.done,
        complete: e.complete_at !== null,
      });
    },
  );

  app.post(
    "/v1/rigs/:rig/exports/:name/file",
    o.rigAuth,
    bodyLimit({ maxSize: EXPORT_PIECE_LIMIT }),
    async (c) => {
      const rig = c.req.param("rig");
      const name = c.req.param("name");
      if (!files) return c.json({ error: noFolder }, 503);
      const e = EXPORT_NAME.test(name) ? store.rigExport(rig, name) : undefined;
      if (!e) return c.json({ error: `no export ${name}: start it first` }, 404);
      const path = c.req.query("path") ?? "";
      if (!(path in e.files))
        return c.json({ error: `${path} is not a file this export sends` }, 400);
      const offset = Number(c.req.query("offset"));
      if (!Number.isSafeInteger(offset) || offset < 0)
        return c.json({ error: "offset is a whole number from 0" }, 400);
      const piece = Buffer.from(await c.req.arrayBuffer());
      const r = await files.append(store, e, path, offset, piece);
      if (!r.ok) return c.json({ error: r.error, received: r.received }, r.status);
      return c.json({ received: r.received, done: r.done, complete: r.complete });
    },
  );

  app.get("/v1/rigs/:rig/exports", o.admin, (c) =>
    c.json({
      exports: store.rigExports(c.req.param("rig"), 1000).map((e) => summary(files, e)),
    }),
  );

  app.get("/v1/rigs/:rig/exports/:name", o.admin, (c) => {
    const e = store.rigExport(c.req.param("rig"), c.req.param("name"));
    if (!e) return c.json({ error: "no such export" }, 404);
    return c.json({
      ...summary(files, e),
      manifest: e.manifest,
      files: Object.entries(e.files).map(([path, f]) => ({
        path,
        size: f.size,
        sha256: f.sha256,
        kept: e.done.includes(path),
      })),
    });
  });

  app.get("/v1/rigs/:rig/exports/:name/file", o.admin, (c) => {
    const e = store.rigExport(c.req.param("rig"), c.req.param("name"));
    const path = c.req.query("path") ?? "";
    if (!e || !files || !e.done.includes(path) || !e.files[path])
      return c.json({ error: "no such file in that export" }, 404);
    const on = files.file(e.rig, e.name, path);
    if (!existsSync(on)) return c.json({ error: "the file is gone from control's folder" }, 404);
    return c.body(Readable.toWeb(createReadStream(on)) as ReadableStream, 200, {
      "content-type": "application/octet-stream",
      "content-length": String(statSync(on).size),
      "x-thermite-sha256": e.files[path].sha256,
    });
  });
}
