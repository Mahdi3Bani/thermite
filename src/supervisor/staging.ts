import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { log } from "../common/env.ts";
import type { SignedCommand } from "../core/commands.ts";
import { sshCommand } from "./git-export.ts";

/**
 * Staging for commands that bring content. A `propagate` command names another unit's published
 * champion (a patch in the results repository) and the inbox path the harness will read it from.
 * Before relaying the command, the supervisor fetches that file from the results repository into
 * the inbox. It cannot change it: the harness checks the sha256 and the tree the command signs.
 * Deterministic code only: no model ever runs git here.
 */

const run = promisify(execFile);

export interface StagingConfig {
  unit: string;
  inboxDir: string;
  /** The supervisor's results repository (bare), the same one the exporter commits to. */
  resultsRepo: string;
  remote?: string | undefined;
  sshKeyFile?: string | undefined;
  knownHostsFile?: string | undefined;
}

function sshEnv(cfg: StagingConfig): Record<string, string> {
  return sshCommand(cfg.sshKeyFile, cfg.knownHostsFile);
}

async function git(
  repo: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<Buffer> {
  const { stdout } = await run("git", ["-C", repo, ...args], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return stdout;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Makes a command's content available in the inbox. "ready": relay it now. "wait": the content
 * is not available yet (for example the source unit's export is not pushed), try again later.
 */
export async function stageCommand(
  cfg: StagingConfig,
  cmd: SignedCommand,
): Promise<"ready" | "wait"> {
  if (cmd.envelope.kind !== "propagate") return "ready";
  // Past its expiry the harness refuses it anyway: relay it so the refusal is acknowledged.
  if (Date.parse(cmd.envelope.expires_at) < Date.now()) return "ready";
  const p = cmd.envelope.payload as {
    source_unit?: string;
    source_instance?: string;
    source_seq?: number;
    import?: { kind?: string; path?: string; sha256?: string };
  };
  const imp = p.import;
  if (imp?.kind !== "champion_patch" || !imp.path || !imp.sha256) return "ready";
  const root = resolve(cfg.inboxDir);
  const target = resolve(root, imp.path);
  if (!target.startsWith(root + sep)) return "ready"; // the harness refuses such a path
  if (existsSync(target) && sha256(readFileSync(target)) === imp.sha256) return "ready";
  const branch = `thermite/${p.source_unit}/attempts`;
  const file = `champions/${p.source_instance}/${p.source_seq}.patch`;
  let rev = `refs/heads/${branch}`;
  try {
    if (cfg.remote && p.source_unit !== cfg.unit) {
      rev = `refs/remotes/results/${p.source_unit}/attempts`;
      await git(
        cfg.resultsRepo,
        ["fetch", "--quiet", cfg.remote, `+refs/heads/${branch}:${rev}`],
        sshEnv(cfg),
      );
    }
    const data = await git(cfg.resultsRepo, ["show", `${rev}:${file}`]);
    if (sha256(data) !== imp.sha256) {
      log("supervisor", "staged champion does not match the command; waiting", {
        command: cmd.envelope.id,
        file,
      });
      return "wait";
    }
    mkdirSync(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.tmp-${process.pid}-${Date.now()}`);
    writeFileSync(tmp, data, { mode: 0o644 });
    renameSync(tmp, target);
    log("supervisor", "staged a champion for propagation", { command: cmd.envelope.id, file });
    return "ready";
  } catch (err) {
    log("supervisor", "champion not available yet; waiting", {
      command: cmd.envelope.id,
      file,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
    return "wait";
  }
}
