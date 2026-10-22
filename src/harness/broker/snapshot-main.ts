import { spawnSync } from "node:child_process";
import { chownSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../../common/env.ts";
import { backupLedger, TakeJob, takeSnapshot } from "./snapshot.ts";

/**
 * The broker's helper for the rig's state snapshot (snapshot.ts), started as its own process so
 * the copying never holds up the broker, which times the judge's runs:
 *
 *   take <job>                as root: takes a snapshot (the job as JSON: SnapshotJob below);
 *   ledger <source> <copy>    as the controller's user: copies the ledger with SQLite's backup.
 *
 * Its output is the broker's log: what it took, or why it could not.
 */

const self = fileURLToPath(import.meta.url);

/**
 * The ledger's copy, made as its owner (never as root: SQLite may make the write-ahead files of a
 * ledger no controller has open, and they must stay the controller's), into a folder root made.
 * It must be a plain file of the owner's own with one link.
 */
function stageLedger(source: string, job: TakeJob): string {
  rmSync(job.stage, { recursive: true, force: true });
  mkdirSync(job.stage, { mode: 0o700 });
  chownSync(job.stage, job.owner.uid, job.owner.gid);
  const copy = join(job.stage, "ledger.db");
  const r = spawnSync(process.execPath, [...process.execArgv, self, "ledger", source, copy], {
    uid: job.owner.uid,
    gid: job.owner.gid,
    cwd: job.stage,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    },
    encoding: "utf8",
    timeout: 600_000,
  });
  if (r.status !== 0)
    throw new Error(
      `the ledger's backup failed (exit ${r.status ?? r.signal}): ${String(r.error ?? "")} ${(r.stderr ?? "").trim().slice(-300)}`,
    );
  const st = lstatSync(copy);
  if (!st.isFile() || st.uid !== job.owner.uid || st.nlink !== 1)
    throw new Error("the ledger's copy is not a plain file of the controller's own");
  return copy;
}

async function main(): Promise<number> {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "ledger" && a && b) {
    await backupLedger(a, b);
    return 0;
  }
  if (cmd !== "take" || !a) {
    process.stderr.write("usage: snapshot-main take <job> | ledger <source> <copy>\n");
    return 2;
  }
  const job = TakeJob.parse(JSON.parse(a));
  try {
    const r = await takeSnapshot({
      dir: job.dir,
      areas: job.areas,
      reason: job.reason,
      backupLedger: async (source) => stageLedger(source, job),
    });
    log("broker", "took a snapshot of the rig's state", {
      dir: job.dir,
      reason: r.reason,
      files: r.files,
      folders: r.dirs,
      bytes: r.bytes,
      linked: r.linked,
      copied: r.copied,
      ledger: r.ledger,
      ...(r.links ? {} : { links: "the volume refuses hard links: every file was copied" }),
      ...(r.skipped.length
        ? { skipped: r.skipped.length, skipped_first: r.skipped.slice(0, 5) }
        : {}),
      ms: r.ms,
    });
    return 0;
  } catch (err) {
    log("broker", "could not take a snapshot of the rig's state: the last one stays", {
      dir: job.dir,
      reason: job.reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return 1;
  } finally {
    rmSync(job.stage, { recursive: true, force: true });
  }
}

process.exitCode = await main();
