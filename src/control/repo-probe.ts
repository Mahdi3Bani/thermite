import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type GitAuth, withGitAuth } from "../common/git-auth.ts";

const run = promisify(execFile);

/**
 * What the new-campaign page shows about a project before it starts: the commit a branch or tag
 * names now, how many files it has, and folders to suggest for the files agents may change.
 * For a project in one folder of its repository, the files and suggestions are that folder's,
 * from its own top, and a commit without that folder is refused.
 * Control reads the repository's tree, never its file contents (a shallow fetch without blobs),
 * over https only, with no credentials and a time limit.
 */
export interface Probe {
  commit: string;
  files: number;
  suggest: string[];
}

const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "https",
  GIT_CONFIG_NOSYSTEM: "1",
};

export async function probeRepository(
  url: string,
  ref: string,
  access?: { auth: GitAuth; knownHostsFile: string },
  folder?: string,
): Promise<Probe> {
  const ssh = access?.auth.kind === "ssh";
  if (
    ssh
      ? !/^(?:ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/.test(url)
      : !/^https:\/\/[^\s@]+$/.test(url)
  )
    throw new Error(
      ssh
        ? "with an SSH deploy key, the repository is an ssh:// or git@host:path address"
        : "the repository must be an https:// URL, or choose Git access for a private one",
    );
  return withGitAuth(access?.auth, access?.knownHostsFile, (g) =>
    probeWith(url, ref, access ? { ...g.env, GIT_ALLOW_PROTOCOL: g.protocols } : {}, folder),
  );
}

async function probeWith(
  url: string,
  ref: string,
  extra: Record<string, string>,
  folder: string | undefined,
): Promise<Probe> {
  if (!/^[\w./-]{1,200}$/.test(ref) || ref.startsWith("-"))
    throw new Error("the branch, tag or commit has characters git does not allow");
  const git = (args: string[], cwd?: string) =>
    run("git", args, {
      cwd,
      env: { ...env, ...extra },
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  let commit: string | undefined;
  if (/^[0-9a-f]{40}$/.test(ref)) commit = ref;
  else {
    let out: string;
    try {
      out = (await git(["ls-remote", "--", url, ref, `${ref}^{}`])).stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        /could not read Username|Authentication|403|401/.test(msg)
          ? "control cannot read it without a key: is the repository private?"
          : `control could not read it: ${msg.split("\n").filter(Boolean).at(-1)?.slice(0, 200)}`,
      );
    }
    const refs = out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t") as [string, string]);
    const pick = (name: string) => refs.find(([, r]) => r === name)?.[0];
    commit =
      pick(`refs/tags/${ref}^{}`) ??
      pick(`refs/heads/${ref}`) ??
      pick(`refs/tags/${ref}`) ??
      pick(ref) ??
      (ref === "HEAD" ? pick("HEAD") : undefined);
    if (!commit) throw new Error(`the repository has no branch or tag named ${ref}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "thermite-probe-"));
  try {
    await git(["init", "--quiet", "--bare", dir]);
    await git(["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "--", url, commit], dir);
    const all = (await git(["ls-tree", "-r", "--name-only", commit], dir)).stdout
      .split("\n")
      .filter(Boolean);
    const paths = folder ? inFolder(all, folder) : all;
    if (!paths.length)
      throw new Error(`${ref} has no folder ${folder}, or the folder has no files`);
    return { commit, files: paths.length, suggest: suggestions(paths) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The paths inside a folder, from the folder's own top. */
export function inFolder(paths: string[], folder: string): string[] {
  const at = `${folder}/`;
  return paths.filter((p) => p.startsWith(at)).map((p) => p.slice(at.length));
}

/** Folders worth offering as editable paths: the busiest top folders and their source folders. */
export function suggestions(paths: string[]): string[] {
  const count = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length < 2) continue;
    const top = parts[0] as string;
    if (top.startsWith(".") || /^(docs?|tests?|examples?|third[_-]?party|vendor)$/i.test(top))
      continue;
    count.set(`${top}/**`, (count.get(`${top}/**`) ?? 0) + 1);
    if (parts.length > 2) {
      const two = `${top}/${parts[1]}/**`;
      count.set(two, (count.get(two) ?? 0) + 1);
    }
  }
  return [...count]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([p]) => p);
}
