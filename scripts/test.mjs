#!/usr/bin/env node
// Runs the unit tests (one file at a time: the judge tests time real processes) with a temporary
// directory of their own, removed when they finish, so test runs leave nothing behind. The
// directory is short (sockets in it must stay under the 104-byte path limit on macOS). A file ends
// when its tests end, even if a failed test left a server or a timer open, so it fails at once
// instead of hanging until CI's timeout.
// Usage: node scripts/test.mjs [files or globs]; with none, every src/**/*.test.ts.
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "tt-"));
const files = process.argv.slice(2);
const r = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "--test",
    "--test-concurrency=1",
    "--test-force-exit",
    ...(files.length ? files : ["src/**/*.test.ts"]),
  ],
  { stdio: "inherit", env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } },
);
// Some tests leave read-only folders on purpose (the judge's builds): open them, then remove all.
const open = (p) => {
  try {
    chmodSync(p, 0o700);
    for (const n of readdirSync(p)) {
      const q = join(p, n);
      if (lstatSync(q).isDirectory()) open(q);
    }
  } catch {}
};
open(root);
rmSync(root, { recursive: true, force: true });
process.exit(r.status ?? 1);
