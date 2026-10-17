import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { log } from "../common/env.ts";
import { type GitAuth, withGitAuth } from "../common/git-auth.ts";
import type { SignedCommand } from "../core/commands.ts";
import { sshCommand } from "./git-export.ts";

/**
 * Staging for commands that bring content, before the supervisor relays them:
 * - a `propagate` command names another rig's published champion (a patch in the results
 *   repository) and the inbox path the harness will read it from;
 * - an `assign_campaign` command's imports may name a source: a git repository with the
 *   project's or kit's commit, or a URL for a model. The supervisor fetches it into the inbox
 *   (a repository as a bundle of that commit).
 * The supervisor cannot change what arrives: the harness checks the commit, the sha256 and the
 * tree the command signs. Fetches run in the background, and the command waits for them.
 * Deterministic code only: no model ever runs git here.
 */

const run = promisify(execFile);

export interface StagingConfig {
  rig: string;
  inboxDir: string;
  /** The supervisor's results repository (bare), the same one the exporter commits to. */
  resultsRepo: string;
  remote?: string | undefined;
  sshKeyFile?: string | undefined;
  knownHostsFile?: string | undefined;
  /** Where fetched git sources are kept between assignments (bare repositories). */
  sourcesDir?: string | undefined;
  /** Control's address and this rig's token: kits control keeps are fetched from there. */
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
}

/** What staging says about a command: relay it, wait, or report that its content failed. */
export type StageResult = "ready" | "wait" | { failed: string };

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
 * is not available yet (for example the source rig's export is not pushed), try again later.
 */
export async function stageCommand(cfg: StagingConfig, cmd: SignedCommand): Promise<StageResult> {
  if (cmd.envelope.kind === "assign_campaign") return stageSources(cfg, cmd);
  if (cmd.envelope.kind !== "propagate") return "ready";
  // Past its expiry the harness refuses it anyway: relay it so the refusal is acknowledged.
  if (Date.parse(cmd.envelope.expires_at) < Date.now()) return "ready";
  const p = cmd.envelope.payload as {
    source_rig?: string;
    source_run?: string;
    source_seq?: number;
    import?: { kind?: string; path?: string; sha256?: string };
  };
  const imp = p.import;
  if (imp?.kind !== "champion_patch" || !imp.path || !imp.sha256) return "ready";
  const root = resolve(cfg.inboxDir);
  const target = resolve(root, imp.path);
  if (!target.startsWith(root + sep)) return "ready"; // the harness refuses such a path
  if (existsSync(target) && sha256(readFileSync(target)) === imp.sha256) return "ready";
  const branch = `thermite/${p.source_rig}/attempts`;
  const file = `champions/${p.source_run}/${p.source_seq}.patch`;
  let rev = `refs/heads/${branch}`;
  try {
    if (cfg.remote && p.source_rig !== cfg.rig) {
      rev = `refs/remotes/results/${p.source_rig}/attempts`;
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

// ------------------------------------------------------------------ sources by reference

type Sourced =
  | {
      kind: "repo_bundle" | "kit_bundle";
      path: string;
      commit: string;
      source: { git: string; access?: string } | { control: string };
    }
  | { kind: "model"; path: string; sha256: string; source: { url: string } };

/** Stagings in progress, and finished ones not yet reported, by command id. */
const inFlight = new Map<string, Promise<StageResult>>();
const finished = new Map<string, StageResult>();
/** Models already checked in the inbox (path, size and time), so a big file is hashed once. */
const verified = new Set<string>();

async function stageSources(cfg: StagingConfig, cmd: SignedCommand): Promise<StageResult> {
  if (Date.parse(cmd.envelope.expires_at) < Date.now()) return "ready";
  const id = cmd.envelope.id;
  const done = finished.get(id);
  if (done) {
    finished.delete(id);
    return done;
  }
  if (inFlight.has(id)) return "wait";
  const imports = ((cmd.envelope.payload as { imports?: unknown[] }).imports ?? []) as Sourced[];
  const root = resolve(cfg.inboxDir);
  const todo: { imp: Sourced; target: string }[] = [];
  for (const imp of imports) {
    if (!imp?.source) continue;
    const target = resolve(root, imp.path);
    if (!target.startsWith(root + sep)) continue; // the harness refuses such a path
    if (!(await present(imp, target))) todo.push({ imp, target });
  }
  if (!todo.length) return "ready";
  const work = (async (): Promise<StageResult> => {
    try {
      for (const { imp, target } of todo) {
        if (imp.kind === "model") await fetchModel(imp, target);
        else await bundleFromGit(cfg, imp, target);
      }
      log("supervisor", "staged sources", { command: id, files: todo.map((t) => t.imp.path) });
      return "ready";
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : String(err);
      log("supervisor", "staging failed", { command: id, error });
      return { failed: `staging: ${error}` };
    }
  })();
  inFlight.set(id, work);
  void work.then((r) => {
    inFlight.delete(id);
    finished.set(id, r);
  });
  return "wait";
}

async function present(imp: Sourced, target: string): Promise<boolean> {
  if (!existsSync(target)) return false;
  // A bundle is checked by the harness (it must hold the commit); a model by its hash, here
  // once, so a wrong file is replaced rather than relayed.
  if (imp.kind !== "model") return true;
  const st = statSync(target);
  const key = `${target}\0${st.size}\0${st.mtimeMs}`;
  if (verified.has(key)) return true;
  const h = createHash("sha256");
  await pipeline(createReadStream(target), h);
  if (h.digest("hex") !== imp.sha256) return false;
  verified.add(key);
  return true;
}

/** A model from its URL, hashed as it streams; only a file with the signed hash lands. */
async function fetchModel(imp: Extract<Sourced, { kind: "model" }>, target: string): Promise<void> {
  const res = await fetch(imp.source.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${imp.source.url}: HTTP ${res.status}`);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const h = createHash("sha256");
  const tee = new Transform({
    transform(chunk, _enc, cb) {
      h.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), tee, createWriteStream(tmp));
    const got = h.digest("hex");
    if (got !== imp.sha256) throw new Error(`${imp.source.url}: sha256 ${got}, not ${imp.sha256}`);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * A repository's commit as a bundle: fetched into a bare cache kept per source, then bundled
 * from a ref at that commit (with its history, so the harness can import it alone).
 */
async function bundleFromGit(
  cfg: StagingConfig,
  imp: Extract<Sourced, { kind: "repo_bundle" | "kit_bundle" }>,
  target: string,
): Promise<void> {
  // A kit control keeps comes from control, as this rig, over plain HTTP(S); the token goes in
  // a header and only to control's own address.
  const fromControl = "control" in imp.source;
  if (fromControl && (!cfg.controlUrl || !cfg.controlToken))
    throw new Error(`${imp.path}: a kit from control, but this supervisor has no control to ask`);
  const url =
    "control" in imp.source
      ? `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/git/${imp.source.control}.git`
      : imp.source.git;
  const dir = cfg.sourcesDir ?? join(dirname(cfg.resultsRepo), "sources");
  const cache = join(dir, `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.git`);
  if (!existsSync(join(cache, "HEAD"))) {
    mkdirSync(cache, { recursive: true });
    await git(cache, ["init", "--quiet", "--bare"]);
  }
  // Never git's ext:: or other command transports: a URL in a command only names a repository.
  const env: Record<string, string> = fromControl
    ? {
        GIT_ALLOW_PROTOCOL: "http:https",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${cfg.controlToken}`,
      }
    : { ...sshEnv(cfg), GIT_ALLOW_PROTOCOL: "https:ssh:git:file" };
  const has = () =>
    git(cache, ["cat-file", "-e", `${imp.commit}^{commit}`]).then(
      () => true,
      () => false,
    );
  const fetchWith = async (e: Record<string, string>) => {
    if (await has()) return;
    // The commit by its id first (most servers allow a reachable one), then all branches and tags.
    await git(cache, ["fetch", "--quiet", "--no-tags", url, imp.commit], e).catch(() =>
      git(cache, ["fetch", "--quiet", "--tags", url, "+refs/heads/*:refs/sources/heads/*"], e),
    );
  };
  // A private repository: the Git access its campaign names, handed by control for this fetch.
  const access = "git" in imp.source ? imp.source.access : undefined;
  if (access) {
    const auth = await gitAccessFromControl(cfg, access);
    await withGitAuth(auth, join(dirname(dir), "known_hosts", access), (g) =>
      fetchWith({ ...g.env, GIT_ALLOW_PROTOCOL: g.protocols }),
    );
  } else await fetchWith(env);
  if (!(await has())) throw new Error(`${url} has no commit ${imp.commit}`);
  const ref = `refs/thermite/stage/${imp.commit}`;
  await git(cache, ["update-ref", ref, imp.commit]);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await git(cache, ["bundle", "create", tmp, ref]);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Git access by name, from control: only for a campaign assigned to this rig that names it. */
async function gitAccessFromControl(cfg: StagingConfig, name: string): Promise<GitAuth> {
  if (!cfg.controlUrl || !cfg.controlToken)
    throw new Error(`Git access ${name}: this supervisor has no control to ask`);
  const res = await fetch(
    `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/git-access/${encodeURIComponent(name)}`,
    { headers: { authorization: `Bearer ${cfg.controlToken}` } },
  );
  if (!res.ok) throw new Error(`Git access ${name}: control answered ${res.status}`);
  const g = (await res.json()) as {
    kind?: string;
    private_key?: string;
    token?: string;
    username?: string;
  };
  if (g.kind === "ssh" && g.private_key) return { kind: "ssh", privateKey: g.private_key };
  if (g.kind === "token" && g.token) return { kind: "token", token: g.token, username: g.username };
  throw new Error(`Git access ${name}: control's answer has no key`);
}
