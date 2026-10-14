#!/usr/bin/env node
// Local compose smoke test: build and start control + one unit, assign a campaign through
// control, submit a patch as a proposer, and check the events reach control.
// Usage: COMPOSE="podman compose" node scripts/compose-smoke.mjs   (or "docker compose")
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const compose = (process.env.COMPOSE ?? "podman compose").split(" ");
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
const dc = (...args) =>
  sh(compose[0], [...compose.slice(1), ...args], {
    env: { ...process.env, THERMITE_POLL_SECONDS: "3" },
  });
const control = "http://127.0.0.1:8800";
const secret = (n) => readFileSync(join(".dev", "secrets", n), "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(1000);
  }
}
const api = async (path, token, init = {}) => {
  const res = await fetch(`${control}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  return { status: res.status, body: await res.json() };
};

sh("node", ["scripts/dev-init.mjs"]);
execSync("npm run -s build", { stdio: "inherit" });

// A demo project repository, bundled into the inbox (the supervisor's job on a real rig).
const repo = mkdtempSync(join(tmpdir(), "thermite-demo-"));
const g = (...a) =>
  sh(
    "git",
    ["-c", "user.name=demo", "-c", "user.email=demo@localhost", "-c", "commit.gpgsign=false", ...a],
    { cwd: repo },
  );
g("init", "--quiet", "-b", "main");
execSync("mkdir -p src/kernel", { cwd: repo });
writeFileSync(join(repo, "src/kernel/k.c"), "int k(int x) { return x * 2; }\n");
g("add", "-A");
g("commit", "--quiet", "-m", "seed");
const seed = g("rev-parse", "HEAD").trim();
g(
  "bundle",
  "create",
  "--quiet",
  join(process.cwd(), ".dev/inbox/repos/demo-kernels.bundle"),
  "--all",
);

console.log("compose: build and start");
dc("up", "-d", "--build");
await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);

const payload = sh("node", [
  "dist/cli/thermite.js",
  "assign-payload",
  "--contract",
  "examples/contracts/smoke-cpu.json",
  "--instance",
  "smoke-1",
  "--seed-repo",
  "demo-kernels",
  "--seed-commit",
  seed,
  "--bundle",
  "repos/demo-kernels.bundle",
]).trim();
const issued = await api("/v1/commands", secret("control-admin-token"), {
  method: "POST",
  body: JSON.stringify({ unit: "local-1", kind: "assign_campaign", payload: JSON.parse(payload) }),
});
if (issued.status !== 201) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
const delivered = await until("command delivered", async () => {
  const c = await api(`/v1/commands/${issued.body.id}`, secret("control-admin-token"));
  return c.body.status !== "pending" ? c.body : undefined;
});
if (delivered.status !== "delivered")
  throw new Error(`assign not delivered: ${JSON.stringify(delivered)}`);
console.log("assign_campaign delivered and accepted");

// A proposer submits a patch from inside the harness container (as workers will).
const wt = mkdtempSync(join(tmpdir(), "thermite-wt-"));
sh("git", ["clone", "--quiet", repo, wt]);
writeFileSync(join(wt, "src/kernel/k.c"), "int k(int x) { return x << 1; }\n");
sh("git", ["add", "-A"], { cwd: wt });
const patch = sh("git", ["diff", "--cached", "--binary"], { cwd: wt });
const patchB64 = Buffer.from(patch).toString("base64");
const submitted = dc(
  "exec",
  "-T",
  "harness",
  "sh",
  "-c",
  `echo ${patchB64} | base64 -d > /scratch/p.patch && thermite submit --harness http://127.0.0.1:8700 --token-file /run/secrets/harness-proposer-token --instance smoke-1 --patch-file /scratch/p.patch --hypothesis "shift instead of multiply"`,
);
const attempt = JSON.parse(submitted.trim().split("\n").pop());
console.log("submitted", attempt.attempt, attempt.lifecycle);

const kinds = await until("events at control", async () => {
  const ev = await api(
    "/v1/units/local-1/events?after=0&limit=5000",
    secret("control-admin-token"),
  );
  const k = new Set(ev.body.events.map((e) => e.kind));
  return k.has("attempt_recorded") && k.has("job_finished") ? [...k] : undefined;
});
console.log("events at control:", kinds.join(", "));
console.log("compose smoke: OK");
if (process.env.KEEP !== "1") dc("down", "-v");
