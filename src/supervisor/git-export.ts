import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * The supervisor's git exporter. The harness writes exports into the outbox (read-only here):
 * patches and manifests of new attempts, the events since the last export, and a ledger
 * snapshot. This turns each verified export into packed commits on a few branches of the
 * results repository, without a checkout:
 *
 *   thermite/<unit>/attempts  attempts/<id>.patch, attempts/<id>.json, events/<export>.jsonl,
 *                            champions/<instance>/<seq>.patch and .json
 *   thermite/<unit>/ledger    ledger.sqlite and its manifest (at most once per ledgerEveryMs)
 *
 * and pushes them with the unit's deploy key. Git work is deterministic code only; no model
 * ever runs git here.
 */

const run = promisify(execFile);

export interface ExportConfig {
  unit: string;
  outboxDir: string;
  workDir: string;
  /** The results repository (an SSH URL in production, a file URL in tests). Unset: commit only. */
  remote?: string | undefined;
  /** Deploy key for the remote (write access to the results repository only). */
  sshKeyFile?: string | undefined;
  ledgerEveryMs?: number | undefined;
}

export interface ExportState {
  done: string[];
  /** Exports committed here but not yet pushed to the remote. */
  unpushed?: string[] | undefined;
  /** The newest exports known to be on the remote (a full reset waits for its export here). */
  pushed?: string[] | undefined;
  lastLedgerAt?: string | undefined;
  lastPushAt?: string | undefined;
  lastError?: string | undefined;
}

async function git(
  repo: string,
  args: string[],
  opts: { env?: Record<string, string>; input?: string } = {},
): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "thermite",
      GIT_AUTHOR_EMAIL: "thermite@localhost",
      GIT_COMMITTER_NAME: "thermite",
      GIT_COMMITTER_EMAIL: "thermite@localhost",
      ...opts.env,
    },
  });
  return stdout.trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Checks every file of an export against its manifest. Returns the problems. */
export function verifyExport(dir: string): string[] {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return ["no manifest"];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    files: Record<string, string>;
  };
  const bad: string[] = [];
  for (const [rel, sum] of Object.entries(manifest.files)) {
    if (rel.includes("..") || rel.startsWith("/")) bad.push(`unsafe path ${rel}`);
    else if (!existsSync(join(dir, rel))) bad.push(`missing ${rel}`);
    else if (sha256(join(dir, rel)) !== sum) bad.push(`hash mismatch ${rel}`);
  }
  return bad;
}

/** Adds files (path in tree -> file on disk) on top of a branch and commits. */
async function commitFiles(
  repo: string,
  branch: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  const ref = `refs/heads/${branch}`;
  const tip = await git(repo, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  const index = join(repo, `index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (tip) await git(repo, ["read-tree", tip], { env });
    else await git(repo, ["read-tree", "--empty"], { env });
    for (const [path, file] of Object.entries(files)) {
      const blob = await git(repo, ["hash-object", "-w", "--", file]);
      await git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    const tree = await git(repo, ["write-tree"], { env });
    const commit = await git(repo, [
      "commit-tree",
      tree,
      ...(tip ? ["-p", tip] : []),
      "-m",
      message,
    ]);
    await git(repo, ["update-ref", ref, commit, ...(tip ? [tip] : [])]);
    return commit;
  } finally {
    rmSync(index, { force: true });
  }
}

export async function exportOnce(cfg: ExportConfig, state: ExportState): Promise<ExportState> {
  const repo = join(cfg.workDir, "results.git");
  if (!existsSync(join(repo, "HEAD"))) {
    mkdirSync(repo, { recursive: true });
    await git(repo, ["init", "--bare", "--quiet"]);
  }
  const done = new Set(state.done);
  const pending = existsSync(cfg.outboxDir)
    ? readdirSync(cfg.outboxDir)
        .filter((n) => !n.startsWith(".") && !done.has(n))
        .sort()
    : [];
  const next: ExportState = { ...state, done: [...state.done] };
  const attemptsBranch = `thermite/${cfg.unit}/attempts`;
  const ledgerBranch = `thermite/${cfg.unit}/ledger`;
  // A new or wiped supervisor home continues the results repository's history, so its pushes
  // stay fast-forwards.
  if (cfg.remote && pending.length) {
    for (const b of [attemptsBranch, ledgerBranch]) {
      const have = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).catch(
        () => "",
      );
      if (have) continue;
      await git(repo, ["fetch", "--quiet", cfg.remote, `+refs/heads/${b}:refs/heads/${b}`], {
        env: cfg.sshKeyFile
          ? {
              GIT_SSH_COMMAND: `ssh -i ${cfg.sshKeyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
            }
          : {},
      }).catch(() => undefined);
    }
  }
  let committed = false;
  for (const name of pending) {
    const dir = join(cfg.outboxDir, name);
    const bad = verifyExport(dir);
    if (bad.length) {
      next.lastError = `export ${name} refused: ${bad.join("; ")}`;
      next.done.push(name); // never retried: a corrupt export is reported, not pushed
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
      from_event: number;
      through_event: number;
    };
    const files: Record<string, string> = {
      [`events/${name}.jsonl`]: join(dir, "events.jsonl"),
      [`exports/${name}.json`]: join(dir, "manifest.json"),
    };
    for (const rel of Object.keys(manifest.files)) {
      // Attempts, and published champions (what other units fetch to judge them themselves).
      if (rel.startsWith("attempts/") || rel.startsWith("champions/")) files[rel] = join(dir, rel);
    }
    const attempts = Object.keys(files).filter((f) => f.endsWith(".patch")).length;
    await commitFiles(
      repo,
      attemptsBranch,
      files,
      `${cfg.unit}: export ${name}, ${attempts} attempts, events ${manifest.from_event + 1}-${manifest.through_event}`,
    );
    const due =
      !next.lastLedgerAt ||
      Date.now() - Date.parse(next.lastLedgerAt) >= (cfg.ledgerEveryMs ?? 24 * 3_600_000);
    if (due && existsSync(join(dir, "ledger.sqlite"))) {
      await commitFiles(
        repo,
        ledgerBranch,
        {
          "ledger.sqlite": join(dir, "ledger.sqlite"),
          "manifest.json": join(dir, "manifest.json"),
        },
        `${cfg.unit}: ledger snapshot through event ${manifest.through_event}`,
      );
      next.lastLedgerAt = new Date().toISOString();
    }
    next.done.push(name);
    next.unpushed = [...(next.unpushed ?? []), name];
    committed = true;
  }
  next.done = next.done.slice(-5000);

  // A local results repository (compose): created on first use.
  if (cfg.remote?.startsWith("file://")) {
    const path = new URL(cfg.remote).pathname;
    if (!existsSync(join(path, "HEAD"))) {
      mkdirSync(path, { recursive: true });
      await git(path, ["init", "--bare", "--quiet"]);
    }
  }
  if (cfg.remote && (committed || next.lastError?.startsWith("push"))) {
    const branches = [attemptsBranch, ledgerBranch];
    const have: string[] = [];
    for (const b of branches) {
      if (
        await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).catch(() => "")
      ) {
        have.push(`refs/heads/${b}:refs/heads/${b}`);
      }
    }
    const sshEnv: Record<string, string> = cfg.sshKeyFile
      ? {
          GIT_SSH_COMMAND: `ssh -i ${cfg.sshKeyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
        }
      : {};
    try {
      if (have.length) await git(repo, ["push", "--quiet", cfg.remote, ...have], { env: sshEnv });
      next.lastPushAt = new Date().toISOString();
      next.pushed = [...(next.pushed ?? []), ...(next.unpushed ?? [])].slice(-50);
      next.unpushed = [];
      if (next.lastError?.startsWith("push")) next.lastError = undefined;
    } catch (err) {
      next.lastError = `push failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`;
    }
  }
  return next;
}
