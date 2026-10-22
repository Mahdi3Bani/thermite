import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { claudeCompactions, readOwn } from "./cli-conversation.ts";

/**
 * Claude Code's PreCompact hook (goal 070): Claude Code 2.1.305 runs it before each compaction,
 * with the session's transcript path on stdin, and appends what it prints to the compaction's
 * own instructions. Thermite's settings for the run (`--settings`) name it, with two arguments:
 * the folder for its copies, in the agent's own area, and the line to print, with `{n}` for the
 * compaction's number.
 *
 * It runs as the agent's own user, under the same limits, and reaches nothing but its own files:
 * it copies the transcript as it is now, the whole conversation before this compaction, to
 * `<folder>/<n>.jsonl`, and prints the line, which tells the summary where Thermite keeps the
 * conversation. Thermite's own code reads the copy once Claude Code reports the compaction, makes
 * it Markdown and keeps it where the agents read it (cli-conversation.ts, compactions.ts). It
 * never stands in the compaction's way: whatever fails, it exits 0.
 *
 * `n` counts the compactions the transcript already shows, plus one, so it matches the count
 * Thermite keeps from Claude Code's output: a compaction that fails leaves no boundary, and the
 * next one copies under the same number.
 */

/** The placeholder for the compaction's number in the line the hook prints. */
export const NUMBER = "{n}";

/** The largest transcript the hook copies, in bytes (a longer one is cut at a whole line). */
const HOOK_MAX = 256 * 1024 * 1024;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Writes a file whole or not at all, readable by Thermite's own user. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

/**
 * Claude Code's PreCompact hook: copies the transcript to `drops`, and returns the line to print.
 * `input`: the hook's input (`session_id`, `transcript_path`, `trigger`).
 */
export function claudePreCompact(input: unknown, drops: string, line: string): string {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const path = str(i.transcript_path);
  const text = path && isAbsolute(path) ? readOwn(path, HOOK_MAX) : undefined;
  let n: number;
  if (text !== undefined) n = claudeCompactions(text) + 1;
  else {
    // No transcript to count from: after the copies already made.
    let made = 0;
    try {
      made = readdirSync(drops).filter((f) => /^\d+\.jsonl$/.test(f)).length;
    } catch {
      made = 0;
    }
    n = made + 1;
  }
  try {
    mkdirSync(drops, { recursive: true, mode: 0o755 });
    chmodSync(drops, 0o755);
    if (text !== undefined) writeAtomic(join(drops, `${n}.jsonl`), text);
    writeAtomic(
      join(drops, `${n}.meta.json`),
      JSON.stringify({
        session_id: str(i.session_id),
        transcript_path: path,
        trigger: str(i.trigger),
        at: new Date().toISOString(),
        copied: text !== undefined,
      }),
    );
  } catch {
    // The conversation as Thermite saw it is kept instead (cli-compaction.ts).
  }
  return line.split(NUMBER).join(String(n));
}

/** Run as a program: `node compaction-hook.js claude <folder> <line>`, the hook's input on stdin. */
function main(argv: string[]): void {
  const [kind, drops, line] = argv;
  if (kind !== "claude" || !drops) return;
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = {};
  }
  const said = claudePreCompact(input, drops, line ?? "");
  // Plain text, never JSON: Claude Code takes a hook's plain output as instructions.
  if (said.trim()) process.stdout.write(`${said.replace(/^\s*\{/, "(")}\n`);
}

const invoked = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href
    );
  } catch {
    return false;
  }
})();
if (invoked) {
  try {
    main(process.argv.slice(2));
  } catch {
    // Never in the compaction's way.
  }
  process.exitCode = 0;
}
