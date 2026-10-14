#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * The lane's file tool. The broker runs it as the lane's own user with the workspace as the
 * current directory; a worker's read, write, edit, list and search calls become one run each.
 * It only touches paths inside the workspace and never follows a link out of it.
 *
 * usage: lanetool <op> <json-args>   (write and edit read their payload from stdin)
 * prints one JSON object: {"ok": true, ...} or {"ok": false, "error": "..."}
 */

const root = realpathSync(process.cwd());
const MAX_READ_LINES = 2000;
const MAX_LIST = 500;
const MAX_MATCHES = 200;

function inside(path: string): string {
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep))
    throw new Error(`outside the workspace: ${path}`);
  // The nearest existing ancestor must also resolve inside (no symlinked directories out).
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(root + sep))
    throw new Error(`outside the workspace: ${path}`);
  if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new Error(`a symlink: ${path}`);
  return full;
}

function stdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function walk(dir: string, depth: number, out: string[]): void {
  if (out.length >= MAX_LIST || depth < 0) return;
  for (const e of readdirSync(dir).sort()) {
    if (e === ".git") continue;
    const p = join(dir, e);
    const st = lstatSync(p);
    out.push(`${relative(root, p)}${st.isDirectory() ? "/" : ""}`);
    if (out.length >= MAX_LIST) return;
    if (st.isDirectory()) walk(p, depth - 1, out);
  }
}

function run(op: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (op) {
    case "read": {
      const lines = readFileSync(inside(String(args.path)), "utf8").split("\n");
      const offset = Math.max(0, Number(args.offset ?? 0));
      const limit = Math.min(MAX_READ_LINES, Number(args.limit ?? MAX_READ_LINES));
      return {
        total_lines: lines.length,
        content: lines
          .slice(offset, offset + limit)
          .map((l, i) => `${offset + i + 1}\t${l}`)
          .join("\n"),
      };
    }
    case "write": {
      const full = inside(String(args.path));
      mkdirSync(dirname(full), { recursive: true });
      const content = stdin();
      writeFileSync(full, content);
      return { bytes: Buffer.byteLength(content) };
    }
    case "edit": {
      const full = inside(String(args.path));
      const {
        old,
        new: replacement,
        all,
      } = JSON.parse(stdin()) as {
        old: string;
        new: string;
        all?: boolean;
      };
      const text = readFileSync(full, "utf8");
      const count = old ? text.split(old).length - 1 : 0;
      if (count === 0) throw new Error("old text not found");
      if (count > 1 && !all) throw new Error(`old text found ${count} times; make it unique`);
      writeFileSync(
        full,
        all ? text.split(old).join(replacement) : text.replace(old, () => replacement),
      );
      return { replaced: all ? count : 1 };
    }
    case "list": {
      const out: string[] = [];
      walk(inside(String(args.path ?? ".")), Number(args.depth ?? 3), out);
      return { entries: out, truncated: out.length >= MAX_LIST };
    }
    case "search": {
      const re = new RegExp(String(args.pattern));
      const matches: string[] = [];
      const files: string[] = [];
      walk(inside(String(args.path ?? ".")), 12, files);
      for (const f of files) {
        if (f.endsWith("/")) continue;
        let text: string;
        try {
          text = readFileSync(join(root, f), "utf8");
        } catch {
          continue;
        }
        if (text.includes("\0")) continue;
        text.split("\n").forEach((line, i) => {
          if (matches.length < MAX_MATCHES && re.test(line))
            matches.push(`${f}:${i + 1}: ${line.slice(0, 300)}`);
        });
        if (matches.length >= MAX_MATCHES) break;
      }
      return { matches, truncated: matches.length >= MAX_MATCHES };
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

try {
  const [op, json] = process.argv.slice(2);
  const result = run(String(op), JSON.parse(json ?? "{}") as Record<string, unknown>);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (err) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`,
  );
}
