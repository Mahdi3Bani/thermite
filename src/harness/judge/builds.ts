import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256Hex } from "../../core/canonical.ts";
import type { Runner } from "../broker/runner.ts";
import { exportTree } from "../git.ts";
import type { Kit } from "../kit.ts";
import type { Ledger } from "../ledger.ts";

/**
 * The build store. The builder user builds each (commit, kit) pair once in a fresh scratch
 * directory; the judge hashes the outputs and moves them into the store, where they are
 * read-only to everyone else. Every timed run re-checks the hashes before launch, so a
 * candidate that overwrote a binary is caught (it cannot: the store is not writable by it).
 */

export interface BuildManifest {
  key: string;
  commit: string;
  kit_commit: string;
  files: Record<string, string>;
  build_ms: number;
}

export type BuildResult =
  | { ok: true; dir: string; manifest: BuildManifest; cached: boolean }
  | { ok: false; key: string; reason: string; log: string; transient: boolean };

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export class BuildStore {
  readonly storeDir: string;
  private readonly workDir: string;
  private readonly runner: Runner;
  private readonly ledger: Ledger;
  private toolchain: string | undefined;

  constructor(stateDir: string, scratchDir: string, runner: Runner, ledger: Ledger) {
    this.runner = runner;
    this.ledger = ledger;
    this.storeDir = join(stateDir, "builds");
    this.workDir = join(scratchDir, "builds");
    mkdirSync(this.storeDir, { recursive: true });
    mkdirSync(this.workDir, { recursive: true });
    // Others may reach a build by its exact path, but not list the store or the work area.
    chmodSync(this.storeDir, 0o711);
    chmodSync(this.workDir, 0o711);
  }

  /** The build key: the sources, the kit's recipe and the toolchain that compiles them. */
  static keyFor(commit: string, kitCommit: string, kit: Kit, toolchain = ""): string {
    return sha256Hex(canonicalJson({ commit, kit_commit: kitCommit, build: kit.build, toolchain }));
  }

  /** Image and compiler identity: a new image or compiler never reuses old builds. */
  private toolchainId(): string {
    if (this.toolchain === undefined) {
      const version = (cmd: string, args: string[]) => {
        try {
          return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
            .trim()
            .split("\n")
            .filter(Boolean)
            .at(-1);
        } catch {
          return undefined;
        }
      };
      this.toolchain = canonicalJson({
        image: process.env.THERMITE_IMAGE_ID ?? null,
        cc: version("cc", ["--version"]) ?? null,
        nvcc: version("nvcc", ["--version"]) ?? null,
      });
    }
    return this.toolchain;
  }

  /** Verifies a stored build's files against its manifest. Returns the mismatches. */
  verify(dir: string, manifest: BuildManifest): string[] {
    const bad: string[] = [];
    for (const [rel, sha] of Object.entries(manifest.files)) {
      const p = join(dir, rel);
      if (!existsSync(p) || sha256File(p) !== sha) bad.push(rel);
    }
    return bad;
  }

  async ensure(input: {
    repo: string;
    mirror: string;
    commit: string;
    kit: Kit;
    kitDir: string;
    kitCommit: string;
    actor: string;
  }): Promise<BuildResult> {
    const key = BuildStore.keyFor(input.commit, input.kitCommit, input.kit, this.toolchainId());
    const dir = join(this.storeDir, key);
    const known = this.ledger.getBuild(key);
    if (known?.ok && existsSync(dir)) {
      const manifest = known.manifest as BuildManifest;
      const bad = this.verify(dir, manifest);
      if (bad.length) throw new Error(`build store tampered: ${key} ${bad.join(", ")}`);
      return { ok: true, dir, manifest, cached: true };
    }
    if (known && !known.ok) {
      const m = known.manifest as { reason: string; log: string };
      return { ok: false, key, reason: m.reason, log: m.log, transient: false };
    }

    const work = join(this.workDir, `${key.slice(0, 16)}-${randomUUID().slice(0, 8)}`);
    const src = join(work, "src");
    // Private from the start: the tree and the kit's files are copied in before the hand-over.
    mkdirSync(work, { mode: 0o700 });
    try {
      await exportTree(input.mirror, input.commit, src);
      for (const rel of input.kit.build.copy) {
        cpSync(join(input.kitDir, rel), join(src, ".kit", rel), { recursive: true });
      }
      await this.runner.handOver(work, "builder");
      const started = Date.now();
      const r = await this.runner.run({
        role: "builder",
        argv: input.kit.build.command,
        cwd: src,
        env: {},
        timeoutMs: input.kit.build.timeout_s * 1000,
        rssLimitBytes: input.kit.build.rss_mib * 1024 * 1024,
        disk: { path: work, limitBytes: input.kit.build.disk_mib * 1024 * 1024 },
      });
      await this.runner.reclaim(work);
      const log = `${r.stdout}\n${r.stderr}`.slice(-8000);
      const missing = input.kit.build.outputs.filter((o) => !existsSync(join(src, o)));
      if (r.killedFor) {
        // Killed for time, memory or disk: possibly transient (a loaded host), never cached.
        return { ok: false, key, reason: `build killed (${r.killedFor})`, log, transient: true };
      }
      if (r.exitCode !== 0 || missing.length) {
        const reason = r.killedFor
          ? `build killed (${r.killedFor})`
          : r.exitCode !== 0
            ? `build failed (exit ${r.exitCode ?? r.signal})`
            : `build outputs missing: ${missing.join(", ")}`;
        this.ledger.recordBuild({
          key,
          repo: input.repo,
          commit: input.commit,
          kitCommit: input.kitCommit,
          ok: false,
          manifest: { reason, log },
          actor: input.actor,
        });
        return { ok: false, key, reason, log, transient: false };
      }

      const staging = join(this.storeDir, `.tmp-${randomUUID()}`);
      const files: Record<string, string> = {};
      const refused: string[] = [];
      const budget = { entries: 0 };
      for (const rel of input.kit.build.outputs) {
        refused.push(...copyOutput(join(src, rel), join(staging, rel), rel, files, budget, 0));
      }
      if (refused.length) {
        rmSync(staging, { recursive: true, force: true });
        const reason = `build outputs refused: ${refused.slice(0, 5).join("; ")}`;
        this.ledger.recordBuild({
          key,
          repo: input.repo,
          commit: input.commit,
          kitCommit: input.kitCommit,
          ok: false,
          manifest: { reason, log },
          actor: input.actor,
        });
        return { ok: false, key, reason, log, transient: false };
      }
      const manifest: BuildManifest = {
        key,
        commit: input.commit,
        kit_commit: input.kitCommit,
        files,
        build_ms: Date.now() - started,
      };
      writeFileSync(join(staging, "manifest.json"), `${canonicalJson(manifest)}\n`, {
        mode: 0o444,
      });
      if (existsSync(dir)) {
        unlock(dir);
        rmSync(dir, { recursive: true, force: true });
      }
      renameSync(staging, dir);
      lockDown(dir);
      this.ledger.recordBuild({
        key,
        repo: input.repo,
        commit: input.commit,
        kitCommit: input.kitCommit,
        ok: true,
        manifest,
        actor: input.actor,
      });
      return { ok: true, dir, manifest, cached: false };
    } finally {
      await this.runner.remove(work).catch(() => rmSync(work, { recursive: true, force: true }));
    }
  }
}

/**
 * Copies one build output into the store: regular files and directories only. A symlink, hard
 * link or special file is refused, never followed, so a build cannot point the store (or its
 * chmods) at private files. Every file is hashed and made read-only.
 */
function copyOutput(
  from: string,
  to: string,
  rel: string,
  files: Record<string, string>,
  budget: { entries: number },
  depth: number,
): string[] {
  if (++budget.entries > 20_000) return ["more than 20000 output entries"];
  if (depth > 32) return [`${rel}: deeper than 32 levels`];
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(from);
  } catch {
    return [`${rel}: missing`];
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    const problems: string[] = [];
    for (const e of readdirSync(from)) {
      problems.push(
        ...copyOutput(join(from, e), join(to, e), `${rel}/${e}`, files, budget, depth + 1),
      );
    }
    return problems;
  }
  if (!st.isFile()) return [`${rel}: not a regular file`];
  if (st.nlink > 1) return [`${rel}: hard link`];
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  files[rel] = sha256File(to);
  chmodSync(to, st.mode & 0o111 ? 0o555 : 0o444);
  return [];
}

function dirsOf(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop() as string;
    out.push(d);
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (lstatSync(p).isDirectory()) stack.push(p);
    }
  }
  return out;
}

/** Directories become 0555, so nothing inside a build can be added, removed or renamed. */
function lockDown(dir: string): void {
  for (const d of dirsOf(dir).reverse()) chmodSync(d, 0o555);
}

function unlock(dir: string): void {
  chmodSync(dir, 0o755);
  for (const d of dirsOf(dir)) chmodSync(d, 0o755);
}
