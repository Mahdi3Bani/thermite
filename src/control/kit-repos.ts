import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Kits control writes itself (described on the new-campaign page, or uploaded) are kept as bare
 * git repositories in control's state directory, one per kit, and served to rigs over git's
 * plain ("dumb") HTTP protocol behind the rig's token. A rig's supervisor fetches a kit like any
 * git source, by commit, and the harness checks that commit as it does any import.
 */

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The files a dumb-HTTP client asks for; anything else in a repository is never served. */
const SERVED =
  /^(?:HEAD|info\/refs|objects\/info\/packs|objects\/[0-9a-f]{2}\/[0-9a-f]{38,62}|objects\/pack\/pack-[0-9a-f]{40,64}\.(?:pack|idx))$/;

const git = (gitDir: string, args: string[], input?: Buffer | string) =>
  execFileSync("git", ["--git-dir", gitDir, ...args], {
    input,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: gitDir,
      GIT_AUTHOR_NAME: "Thermite control",
      GIT_AUTHOR_EMAIL: "control@thermite.invalid",
      GIT_COMMITTER_NAME: "Thermite control",
      GIT_COMMITTER_EMAIL: "control@thermite.invalid",
    },
    maxBuffer: 64 * 1024 * 1024,
  });

export class KitRepos {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  path(name: string): string {
    if (!NAME.test(name)) throw new Error(`not a kit name: ${name}`);
    return join(this.dir, `${name}.git`);
  }

  /**
   * Commits a kit's files as the new head of its repository and returns the commit. Files are
   * path → content; folders come from the paths. The same files on the same parent give the
   * same tree, and a commit is made only when the tree changes.
   */
  commit(name: string, files: Record<string, Buffer>, message: string): string {
    const gitDir = this.path(name);
    if (!existsSync(join(gitDir, "HEAD"))) {
      mkdirSync(gitDir, { recursive: true });
      execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", gitDir]);
    }
    // A tree per folder, from its files' blobs and its subfolders' trees.
    interface Dir {
      files: Map<string, string>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, body] of Object.entries(files)) {
      const parts = path.split("/");
      if (parts.some((p) => !p || p === "." || p === ".." || p === ".git"))
        throw new Error(`not a path inside a kit: ${path}`);
      let d = root;
      for (const p of parts.slice(0, -1)) {
        const next = d.dirs.get(p) ?? { files: new Map(), dirs: new Map() };
        d.dirs.set(p, next);
        d = next;
      }
      const blob = git(gitDir, ["hash-object", "-w", "--stdin"], body).toString().trim();
      d.files.set(parts.at(-1) as string, blob);
    }
    const tree = (d: Dir): string => {
      const lines = [
        ...[...d.files].map(([n, sha]) => `100644 blob ${sha}\t${n}`),
        ...[...d.dirs].map(([n, sub]) => `040000 tree ${tree(sub)}\t${n}`),
      ];
      return git(gitDir, ["mktree"], `${lines.join("\n")}\n`)
        .toString()
        .trim();
    };
    const top = tree(root);
    let parent: string | undefined;
    try {
      parent = git(gitDir, ["rev-parse", "--verify", "--quiet", "refs/heads/main"])
        .toString()
        .trim();
    } catch {
      parent = undefined;
    }
    if (
      parent &&
      git(gitDir, ["rev-parse", `${parent}^{tree}`])
        .toString()
        .trim() === top
    )
      return parent;
    const commit = git(
      gitDir,
      ["commit-tree", top, ...(parent ? ["-p", parent] : []), "-F", "-"],
      `${message}\n`,
    )
      .toString()
      .trim();
    git(gitDir, ["update-ref", "refs/heads/main", commit]);
    git(gitDir, ["update-server-info"]);
    return commit;
  }

  /** The head commit of a kit's repository, if it has one. */
  head(name: string): string | undefined {
    try {
      return git(this.path(name), ["rev-parse", "--verify", "--quiet", "refs/heads/main"])
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  }

  /**
   * A kept kit's kit.json at one of its commits, parsed, for the pages that show how a goal is
   * checked (goal 082). Undefined when control does not keep that kit or that commit, or the
   * file is not JSON.
   */
  manifest(name: string, commit: string): unknown {
    if (!NAME.test(name) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return undefined;
    if (!existsSync(join(this.path(name), "HEAD"))) return undefined;
    try {
      const text = execFileSync(
        "git",
        ["--git-dir", this.path(name), "show", `${commit}:kit.json`],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      return JSON.parse(text.toString());
    } catch {
      // not a commit of this kit, or not JSON: control cannot read it
      return undefined;
    }
  }

  /** One file a dumb-HTTP fetch asks for, or undefined when it is not one to serve. */
  file(name: string, rel: string): Buffer | undefined {
    if (!NAME.test(name) || !SERVED.test(rel)) return undefined;
    const p = join(this.path(name), rel);
    if (!existsSync(p) || !statSync(p).isFile()) return undefined;
    return readFileSync(p);
  }
}
