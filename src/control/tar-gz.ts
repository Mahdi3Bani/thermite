import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/**
 * A small writer of gzip-compressed tar archives (POSIX ustar, with pax records for a path or a
 * size ustar can't hold), for the export downloads (goal 103). Files are read from disk as the
 * archive streams, so an export of any size needs no copy and little memory.
 */

/** One file in the archive: its path there and its bytes, in memory or in a file on disk. */
export interface TarEntry {
  path: string;
  data: Buffer | { file: string; size: number };
  mtime?: Date | undefined;
}

const BLOCK = 512;
/** The largest size a ustar header holds: 11 octal digits. */
const USTAR_MAX_SIZE = 0o77777777777;

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;

function header(name: string, prefix: string, size: number, mtime: number, type: "0" | "x") {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(Math.min(size, USTAR_MAX_SIZE), 12), 124, "ascii");
  h.write(octal(mtime, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

/** A pax record, "<length> <key>=<value>\n", whose length counts its own digits. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  if (String(len).length > String(n).length) len = n + String(len).length;
  return `${len}${body}`;
}

/** A path as ustar holds it, split into a prefix and a name at a "/", or null if it can't. */
function ustarPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name)
      return { name, prefix };
  }
  return null;
}

/** The headers of one file: a pax header first when ustar can't hold its path or size. */
function headers(path: string, size: number, mtime: number): Buffer[] {
  const fits = ustarPath(path);
  const pax = [
    ...(fits ? [] : [paxRecord("path", path)]),
    ...(size > USTAR_MAX_SIZE ? [paxRecord("size", String(size))] : []),
  ].join("");
  const short = fits ?? { name: path.slice(-100).replace(/^[^/]*\//, ""), prefix: "" };
  if (!pax) return [header(short.name, short.prefix, size, mtime, "0")];
  const body = Buffer.from(pax);
  return [
    header(`PaxHeader/${short.name}`.slice(0, 100), "", body.length, mtime, "x"),
    body,
    Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK),
    header(short.name, short.prefix, size, mtime, "0"),
  ];
}

async function* tarChunks(entries: TarEntry[]): AsyncGenerator<Buffer> {
  for (const e of entries) {
    const size = Buffer.isBuffer(e.data) ? e.data.length : e.data.size;
    const mtime = Math.floor((e.mtime?.getTime() ?? Date.now()) / 1000);
    yield* headers(e.path, size, mtime);
    if (Buffer.isBuffer(e.data)) yield e.data;
    else {
      // The size went into the header: a file that changed since would break the archive.
      let n = 0;
      for await (const chunk of createReadStream(e.data.file)) {
        n += (chunk as Buffer).length;
        if (n > size) throw new Error(`${e.path} grew while it was archived`);
        yield chunk as Buffer;
      }
      if (n !== size) throw new Error(`${e.path} has ${n} bytes, not ${size}`);
    }
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  // The end of the archive: two empty blocks.
  yield Buffer.alloc(BLOCK * 2);
}

/**
 * The entries as a .tar.gz stream. A file that can't be read ends the stream with its error
 * (pipeline destroys the gzip stream with it), so a download stops rather than end short.
 */
export function tarGz(entries: TarEntry[]): Readable {
  const gz = createGzip();
  pipeline(Readable.from(tarChunks(entries)), gz).catch((err: unknown) => {
    if (!gz.destroyed) gz.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  return gz;
}
