// Shared setup for the compose smoke and the judge acceptance test: the smoke project and kit
// as git bundles in the inbox, the stack, signed commands through control, submissions from
// inside the harness, and verdicts read back from control's event stream.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const compose = (process.env.COMPOSE ?? "podman compose").split(" ");
export const control = "http://127.0.0.1:8800";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

export function dc(env, ...args) {
  return sh(compose[0], [...compose.slice(1), ...args], { env: { ...process.env, ...env } });
}

export const secret = (n) => readFileSync(join(".dev", "secrets", n), "utf8").trim();

export async function until(what, fn, timeoutMs = 180_000, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(everyMs);
  }
}

export async function api(path, init = {}) {
  const res = await fetch(`${control}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret("control-admin-token")}`,
      "content-type": "application/json",
    },
  });
  return { status: res.status, body: await res.json() };
}

function git(cwd, ...args) {
  return sh(
    "git",
    [
      "-c",
      "user.name=demo",
      "-c",
      "user.email=demo@localhost",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  ).trim();
}

/** Copies a directory into a fresh git repository and bundles it into the inbox. */
function bundle(from, name, exclude = []) {
  const repo = mkdtempSync(join(tmpdir(), `thermite-${name}-`));
  cpSync(from, repo, { recursive: true, filter: (src) => !exclude.some((e) => src.includes(e)) });
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", `${name} seed`);
  const commit = git(repo, "rev-parse", "HEAD");
  const out = join(process.cwd(), ".dev", "inbox", "repos", `${name}.bundle`);
  git(repo, "bundle", "create", "--quiet", out, "--all");
  const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
  return { repo, commit, path: `repos/${name}.bundle`, sha256 };
}

export function prepare() {
  sh("node", ["scripts/dev-init.mjs"]);
  execSync("npm run -s build", { stdio: "inherit" });
  const project = bundle("examples/smoke-project", "smoke-project");
  const kit = bundle("kits/smoke-cpu", "smoke-cpu-kit", ["/candidates"]);
  const contract = JSON.parse(readFileSync("examples/contracts/smoke-cpu.json", "utf8"));
  contract.project = {
    repo: "smoke-project",
    commit: project.commit,
    kit: { repo: "smoke-cpu-kit", commit: kit.commit },
  };
  const contractFile = join(mkdtempSync(join(tmpdir(), "thermite-contract-")), "smoke.json");
  writeFileSync(contractFile, JSON.stringify(contract));
  return { project, kit, contractFile };
}

/** Issues a signed command through control and waits until the supervisor delivered it. */
export async function command(kind, payload, unit = "local-1") {
  const issued = await api("/v1/commands", {
    method: "POST",
    body: JSON.stringify({ unit, kind, payload }),
  });
  if (issued.status !== 201) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
  const done = await until(`${kind} delivered`, async () => {
    const c = await api(`/v1/commands/${issued.body.id}`);
    return c.body.status !== "pending" ? c.body : undefined;
  });
  if (done.status !== "delivered" || done.outcome?.accepted === false) {
    throw new Error(`${kind} not accepted: ${JSON.stringify(done)}`);
  }
  return done;
}

export async function assign(env, instance, unit = "local-1") {
  const payload = sh("node", [
    "dist/cli/thermite.js",
    "assign-payload",
    "--contract",
    env.contractFile,
    "--instance",
    instance,
    "--seed-repo",
    "smoke-project",
    "--seed-commit",
    env.project.commit,
    "--bundle",
    env.project.path,
    "--bundle-sha256",
    env.project.sha256,
    "--kit-bundle-sha256",
    env.kit.sha256,
    "--kit-repo",
    "smoke-cpu-kit",
    "--kit-commit",
    env.kit.commit,
    "--kit-bundle",
    env.kit.path,
  ]).trim();
  return command("assign_campaign", JSON.parse(payload), unit);
}

/**
 * A patch that replaces files in the seed project with a candidate's files. With `base`, the
 * patch applies on top of the seed plus the base candidate's files (for example a champion).
 */
export function candidatePatch(env, dir, base) {
  const wt = mkdtempSync(join(tmpdir(), "thermite-cand-"));
  sh("git", ["clone", "--quiet", env.project.repo, wt]);
  if (base) {
    cpSync(base, wt, { recursive: true });
    git(wt, "add", "-A");
    git(wt, "commit", "--quiet", "-m", "base");
  }
  cpSync(dir, wt, { recursive: true });
  sh("git", ["add", "-A"], { cwd: wt });
  const patch = sh("git", ["diff", "--cached", "--binary"], { cwd: wt });
  rmSync(wt, { recursive: true, force: true });
  return patch;
}

/** Submits a patch as a proposer from inside the harness container (as workers will). */
export function submit(composeEnv, instance, patch, hypothesis) {
  const b64 = Buffer.from(patch).toString("base64");
  const out = dc(
    composeEnv,
    "exec",
    "-T",
    "harness",
    "sh",
    "-c",
    `echo ${b64} | base64 -d > /tmp/p.patch && thermite submit --harness http://127.0.0.1:8700 --token-file /run/secrets/harness-proposer-token --instance ${instance} --patch-file /tmp/p.patch --hypothesis "${hypothesis.replace(/"/g, "'")}"`,
  );
  return JSON.parse(out.trim().split("\n").pop());
}

/** Every event control has for the unit, in arrival order. */
export async function events() {
  const all = [];
  let after = 0;
  for (;;) {
    const page = await api(`/v1/units/local-1/events?after=${after}&limit=5000`);
    all.push(...page.body.events);
    if (page.body.events.length < 5000) return all;
    after = page.body.events.at(-1).seq;
  }
}

export function latestVerdicts(evs) {
  const v = {};
  for (const e of evs) if (e.kind === "verdict") v[e.subject] = e.body.verdict;
  return v;
}

export function lifecycles(evs) {
  const l = {};
  for (const e of evs) {
    if (e.kind === "attempt_recorded") l[e.subject] = e.body.lifecycle;
    if (e.kind === "attempt_lifecycle") l[e.subject] = e.body.lifecycle;
  }
  return l;
}
