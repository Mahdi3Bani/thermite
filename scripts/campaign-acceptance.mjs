#!/usr/bin/env node
// New-campaign acceptance: a campaign from nothing through control's dashboard form, end to end.
// A tiny C project is served from this machine by git daemon. The form's draft describes the kit
// on the page; control writes the kit, keeps it, stores the contract and signs the assignment.
// The rig's supervisor fetches the project from the git server and the kit from control (with
// the rig's token), the harness checks both by commit, and the run starts.
// Usage: COMPOSE="podman compose" node scripts/campaign-acceptance.mjs (or "docker compose").
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, compose, control, dc, events, prepare, secret, until } from "./lib/smoke-env.mjs";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
  );
};

// The project: one C file whose benchmark prints the n it was given.
const root = mkdtempSync(join(tmpdir(), "thermite-newcamp-"));
const work = join(root, "work");
mkdirSync(work);
writeFileSync(
  join(work, "bench.c"),
  `#include <stdio.h>\n#include <stdlib.h>\nint main(int c, char **v) { long n = atol(v[1]); volatile double s = 0; for (long i = 0; i < n * 20000; i++) s += i; printf("%ld\\n", n); return 0; }\n`,
);
const git = (...a) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd: work,
    encoding: "utf8",
  }).trim();
git("init", "--quiet", "-b", "main");
git("add", "-A");
git("commit", "--quiet", "-m", "a tiny benchmark");
const commit = git("rev-parse", "HEAD");
execFileSync("git", ["clone", "--quiet", "--bare", work, join(root, "tiny.git")]);
writeFileSync(join(root, "tiny.git", "git-daemon-export-ok"), "");
const port = 19418;
const daemon = spawn(
  "git",
  ["daemon", "--reuseaddr", `--base-path=${root}`, `--port=${port}`, "--listen=0.0.0.0", root],
  { stdio: "ignore" },
);
const hostName = compose[0] === "docker" ? "host.docker.internal" : "host.containers.internal";
const projectUrl = `git://${hostName}:${port}/tiny.git`;

prepare();
const composeEnv = { THERMITE_POLL_SECONDS: "2", THERMITE_CALIBRATION_BLOCKS: "0" };
console.log("compose: build and start");
dc(composeEnv, "up", "-d", "--build");
try {
  // The rig must have reported its hardware: the campaign's target comes from it.
  await until(
    "the rig reports its hardware",
    async () => (await api("/v1/rigs/local-1/view")).body?.hardware?.target,
    240_000,
    2000,
  );
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const pageHtml = await (
    await fetch(`${control}/ui/campaigns/new`, { headers: { cookie } })
  ).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(pageHtml)?.[1] ?? "";
  check(
    "the new-campaign page offers the rig",
    /data-value="local-1"/.test(pageHtml) && csrf.length > 0,
  );
  // The draft the page's script sends: a hill climb with its kit described on the page.
  const draft = {
    mode: "hill_climb",
    campaign: "acc-tiny",
    title: "Acceptance: a campaign from nothing",
    project: { url: projectUrl, ref: "main", commit, repo: "tiny", editable_paths: ["bench.c"] },
    kit: {
      source: "here",
      build: "cc -O2 -o bench bench.c",
      outputs: ["bench"],
      cases: [
        { name: "small", params: { n: 50 }, work: 1000000 },
        { name: "large", params: { n: 200 }, work: 4000000 },
      ],
      run: "{build}/bench {n} > {out}/result.txt",
      check: 'test "$(cat {out}/result.txt)" = "{n}"',
    },
    score: { name: "loops", unit: "loops/s", direction: "max", min_effect: 0.1 },
    lanes: 1,
  };
  const res = await fetch(`${control}/ui/campaigns/new`, {
    method: "POST",
    body: new URLSearchParams({
      csrf,
      draft: JSON.stringify(draft),
      rig: "local-1",
      start_value: "start",
    }),
    headers: { cookie },
    redirect: "manual",
  });
  check("control took the campaign and assigned its first run", res.status === 303, {
    status: res.status,
    location: res.headers.get("location"),
    page: res.status === 303 ? undefined : (await res.text()).match(/<li>[^<]*<\/li>/g),
  });
  const created = await until(
    "the run starts on the rig",
    async () =>
      (await events()).find((e) => e.kind === "run_created" && e.subject === "acc-tiny-1"),
    300_000,
    3000,
  );
  const evs = await events();
  const imports = evs
    .filter((e) => e.kind === "import_verified")
    .map((e) => ({ kind: e.subject, commit: e.body.commit, name: e.body.name }));
  check(
    "the supervisor fetched the project from its git server and the kit from control; the harness verified both",
    Boolean(created) &&
      imports.some((i) => i.kind === "repo_bundle" && i.commit === commit) &&
      imports.some((i) => i.kind === "kit_bundle"),
    imports,
  );
  const cmd = (await api("/v1/commands")).body.commands.find((c) => c.kind === "assign_campaign");
  check(
    "the assignment was signed by control for the owner and delivered",
    cmd?.status === "delivered" && cmd?.issued_by === "owner:ui",
    cmd && { status: cmd.status, issued_by: cmd.issued_by },
  );
} catch (err) {
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  daemon.kill();
  dc(composeEnv, "down", "-v");
}
const ok = results.every((r) => r.ok);
console.log(`campaign acceptance: ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
