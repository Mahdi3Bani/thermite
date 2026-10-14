import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "../core/canonical.ts";

const run = promisify(execFile);

/**
 * The harness's git mirror: a bare repository per project holding imported history, attempt refs
 * and champion refs. Only the controller writes to it.
 */

const IDENTITY = [
  "-c",
  "user.name=thermite",
  "-c",
  "user.email=thermite@localhost",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

export class GitError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", [...IDENTITY, ...args], {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      encoding: "buffer",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    });
    return stdout.toString("utf8");
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new GitError(`git ${args[0]} failed: ${e.stderr?.toString("utf8").trim() || e.message}`);
  }
}

export async function initMirror(path: string): Promise<void> {
  if (existsSync(join(path, "HEAD"))) return;
  mkdirSync(path, { recursive: true });
  await git(path, ["init", "--bare", "--quiet"]);
}

export async function hasCommit(mirror: string, sha: string): Promise<boolean> {
  try {
    await git(mirror, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommit(mirror: string, rev: string): Promise<string> {
  return (await git(mirror, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
}

/**
 * Fetches a bundle into refs/thermite/imports/<importId>/* and checks that it contains the
 * expected commit. On mismatch the fetched refs are removed and an error is thrown.
 */
export async function fetchBundle(
  mirror: string,
  bundlePath: string,
  importId: string,
  expectedCommit: string,
): Promise<string> {
  await git(mirror, ["bundle", "verify", "--quiet", bundlePath]);
  const prefix = `refs/thermite/imports/${importId}`;
  await git(mirror, ["fetch", "--quiet", "--no-tags", bundlePath, `+refs/*:${prefix}/*`]);
  const found = (await hasCommit(mirror, expectedCommit))
    ? await resolveCommit(mirror, expectedCommit)
    : undefined;
  // The full id must match exactly: an abbreviated or ground prefix never resolves to a pass.
  if (found !== expectedCommit) {
    const refs = await git(mirror, ["for-each-ref", "--format=%(refname)", prefix]);
    for (const ref of refs.split("\n").filter(Boolean))
      await git(mirror, ["update-ref", "-d", ref]);
    throw new GitError(`bundle does not contain commit ${expectedCommit}`);
  }
  return found;
}

export interface AttemptCommit {
  commit: string;
  ref: string;
  changedFiles: string[];
  addedLines: string[];
  binaryFiles: string[];
  specialFiles: string[];
  diffSha: string;
  normalizedDiffSha: string;
}

/**
 * Turns a submitted patch into a commit on its parent and preserves it as
 * refs/thermite/attempts/<id> before anything else happens to it.
 */
export async function createAttemptCommit(input: {
  mirror: string;
  scratchDir: string;
  parent: string;
  patch: Buffer;
  id: string;
  message: string;
  /** Where the commit is preserved; attempts by default. */
  refPrefix?: string | undefined;
}): Promise<AttemptCommit> {
  if (input.patch.length === 0) throw new GitError("empty change");
  mkdirSync(input.scratchDir, { recursive: true });
  const worktree = join(input.scratchDir, `wt-${input.id}`);
  const patchFile = join(input.scratchDir, `${input.id}.patch`);
  writeFileSync(patchFile, input.patch);
  await git(input.mirror, ["worktree", "add", "--detach", "--quiet", worktree, input.parent]);
  try {
    await git(worktree, ["apply", "--index", "--binary", "--whitespace=nowarn", patchFile]);
    await git(worktree, ["commit", "--quiet", "--no-verify", "-m", input.message]);
    const commit = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    const ref = `${input.refPrefix ?? "refs/thermite/attempts"}/${input.id}`;
    await git(input.mirror, ["update-ref", ref, commit]);
    const info = await diffInfo(input.mirror, input.parent, commit);
    return { commit, ref, ...info, diffSha: sha256Hex(input.patch) };
  } finally {
    await git(input.mirror, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    await git(input.mirror, ["worktree", "prune"]).catch(() => undefined);
    rmSync(patchFile, { force: true });
  }
}

export async function diffInfo(
  mirror: string,
  parent: string,
  commit: string,
): Promise<{
  changedFiles: string[];
  addedLines: string[];
  binaryFiles: string[];
  specialFiles: string[];
  normalizedDiffSha: string;
}> {
  const names = await git(mirror, ["diff", "--name-only", "-z", "--no-renames", parent, commit]);
  const normalized = await git(mirror, [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    parent,
    commit,
  ]);
  // --text so that a NUL byte cannot hide added lines behind "Binary files differ".
  const unified = await git(mirror, [
    "diff",
    "-U0",
    "--text",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    parent,
    commit,
  ]);
  const numstat = await git(mirror, ["diff", "--numstat", "-z", "--no-renames", parent, commit]);
  const raw = await git(mirror, ["diff", "--raw", "-z", "--no-renames", parent, commit]);
  return {
    changedFiles: names.split("\0").filter(Boolean),
    addedLines: addedLinesOf(unified),
    binaryFiles: binaryFilesOf(numstat),
    specialFiles: specialFilesOf(raw),
    normalizedDiffSha: sha256Hex(normalized),
  };
}

/**
 * Added lines of a unified diff. Header lines (`--- `, `+++ `) are recognised only before the
 * first hunk of each file, so an added line whose content starts with "++" is still an added
 * line.
 */
export function addedLinesOf(unified: string): string[] {
  const added: string[] = [];
  let inHunk = false;
  for (const line of unified.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added;
}

/** Paths whose new mode is a symlink (120000) or a submodule (160000), from `diff --raw -z`. */
export function specialFilesOf(rawZ: string): string[] {
  const out: string[] = [];
  const f = rawZ.split("\0");
  for (let i = 0; i + 1 < f.length; i += 2) {
    const meta = f[i] ?? "";
    const newMode = meta.split(" ")[1];
    if (newMode === "120000" || newMode === "160000") out.push(f[i + 1] as string);
  }
  return out;
}

/** Files git counts as binary (numstat shows "-" for their line counts). */
function binaryFilesOf(numstatZ: string): string[] {
  return numstatZ
    .split("\0")
    .filter((r) => r.startsWith("-\t-\t"))
    .map((r) => r.slice(4));
}

/** The patch from parent to commit, for export. */
export async function patchBetween(
  mirror: string,
  parent: string,
  commit: string,
): Promise<string> {
  return git(mirror, [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    parent,
    commit,
  ]);
}

export async function updateRef(mirror: string, ref: string, commit: string): Promise<void> {
  await git(mirror, ["update-ref", ref, commit]);
}

export async function deleteRef(mirror: string, ref: string): Promise<void> {
  await git(mirror, ["update-ref", "-d", ref]);
}

/** The id of a commit's tree: the same content gives the same tree in any repository. */
export async function treeOf(mirror: string, commit: string): Promise<string> {
  return (await git(mirror, ["rev-parse", "--verify", `${commit}^{tree}`])).trim();
}

/** Writes the tree of `commit` into `dest` (which must not exist yet), without .git. */
export async function exportTree(mirror: string, commit: string, dest: string): Promise<void> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
    throw new GitError(`not a commit id: ${commit}`);
  mkdirSync(dest, { recursive: true });
  const tar = join(dest, ".tree.tar");
  await git(mirror, ["archive", "--format=tar", `--output=${tar}`, commit]);
  try {
    await run("tar", ["-xf", tar, "-C", dest]);
  } finally {
    rmSync(tar, { force: true });
  }
}
