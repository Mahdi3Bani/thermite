import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ResearchFolderPaths } from "./research-tools.ts";

/**
 * A Pi research worker's file tools over its research folder (OpenCode's agent uses its own shell
 * and file tools there). Paths are relative to the folder; nothing outside it is reachable, and
 * only the lane's working area takes writes. The folder's owners and modes say the same thing to
 * the operating system: these checks are the tools' own, not the boundary.
 */

/** A path inside the folder, symlinks resolved; an error in words when it is not. */
function inside(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const full = resolve(realRoot, path.replace(/^\/+/, ""));
  const real = existsSync(full) ? realpathSync(full) : full;
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new Error(`${path} is outside the research folder`);
  return real;
}

/** A path the lane may write: inside its working area, not a symlink, parents resolved. */
function writable(f: ResearchFolderPaths, path: string, allowLink = false): string {
  const realRoot = realpathSync(f.root);
  const realWork = realpathSync(f.work);
  const full = resolve(realRoot, path.replace(/^\/+/, ""));
  if (!full.startsWith(realWork + sep))
    throw new Error(
      `${path}: you can write only in your working area, ${relative(realRoot, realWork)}/`,
    );
  // No parent may lead out through a symlink.
  let parent = dirname(full);
  while (!existsSync(parent)) parent = dirname(parent);
  const realParent = realpathSync(parent);
  if (realParent !== realWork && !realParent.startsWith(realWork + sep))
    throw new Error(`${path} leads outside your working area`);
  if (!allowLink && existsSync(full) && lstatSync(full).isSymbolicLink())
    throw new Error(`${path} is a symlink: not written`);
  return full;
}

/** One directory's entries, directories marked with a slash, files with their size. */
export function listFiles(f: ResearchFolderPaths, path = ".", limit = 500) {
  const dir = inside(f.root, path);
  const names = readdirSync(dir).sort();
  const entries = names.slice(0, limit).map((name) => {
    const st = lstatSync(join(dir, name));
    return st.isDirectory() ? `${name}/` : `${name} (${st.size} bytes)`;
  });
  return {
    path: relative(realpathSync(f.root), dir) || ".",
    entries,
    ...(names.length > limit ? { more: names.length - limit } : {}),
  };
}

/** Part of a file's text, from an offset in characters. */
export function readFile(f: ResearchFolderPaths, path: string, offset = 0, length = 20_000) {
  const file = inside(f.root, path);
  const text = readFileSync(file, "utf8");
  return {
    path,
    chars: text.length,
    offset,
    text: text.slice(offset, offset + Math.min(Math.max(length, 1), 50_000)),
  };
}

/**
 * Lines that contain the text (case-insensitive), or match it as a regular expression, in every
 * file under a path: file, line number and the line.
 */
export function searchFiles(
  f: ResearchFolderPaths,
  text: string,
  opts: { path?: string | undefined; regex?: boolean | undefined; limit?: number } = {},
) {
  const start = inside(f.root, opts.path ?? ".");
  const realRoot = realpathSync(f.root);
  const limit = opts.limit ?? 200;
  const match = opts.regex
    ? (() => {
        const re = new RegExp(text, "i");
        return (line: string) => re.test(line);
      })()
    : (() => {
        const needle = text.toLowerCase();
        return (line: string) => line.toLowerCase().includes(needle);
      })();
  const matches: string[] = [];
  let files = 0;
  const visit = (p: string): void => {
    if (matches.length >= limit) return;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(p).sort();
      } catch {
        return; // another lane's working area, say
      }
      for (const n of names) visit(join(p, n));
      return;
    }
    if (!st.isFile()) return;
    let body: string;
    try {
      body = readFileSync(p, "utf8");
    } catch {
      return;
    }
    files++;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      const line = lines[i] as string;
      if (match(line)) matches.push(`${relative(realRoot, p)}:${i + 1}: ${line.slice(0, 400)}`);
    }
  };
  visit(start);
  return { matches, files_searched: files, ...(matches.length >= limit ? { cut_at: limit } : {}) };
}

/** Writes (or appends to) a file in the lane's working area. */
export function writeFile(f: ResearchFolderPaths, path: string, content: string, append = false) {
  const file = writable(f, path);
  mkdirSync(dirname(file), { recursive: true });
  const before = append && existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, before + content);
  return { path: relative(realpathSync(f.root), file), bytes: Buffer.byteLength(before + content) };
}

/** Removes a file or directory in the lane's working area. */
export function removeFile(f: ResearchFolderPaths, path: string) {
  if (
    resolve(realpathSync(f.root), path.replace(/^\/+/, "")).replace(/\/+$/, "") ===
    realpathSync(f.work)
  )
    throw new Error("the working area itself stays");
  // A symlink itself may go: removing it never touches what it points to.
  const file = writable(f, path, true);
  rmSync(file, { recursive: true, force: true });
  return { removed: relative(realpathSync(f.root), file) };
}
