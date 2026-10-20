#!/usr/bin/env node
// The quick start, followed on this machine as a tester follows it: from the release bundle to
// the sample campaign's first verdict. The steps come from the pages themselves
// (src/testing/quick-start.ts reads them): each shell block runs as the page writes it, in a new
// folder, and the values typed, the buttons pressed and the words checked are the pages' own. So
// a change to a page that breaks the quick start fails this test.
//
// First it does what a release does, from this checkout: it builds the control, harness and
// supervisor images and writes the bundle with scripts/release-bundle.ts, pinned to those images
// by digest. With Podman the images stay in local storage, which knows their digests. With Docker
// they go to a registry container on 127.0.0.1, so that each one has a digest to pin.
//
// Where a tester's step cannot run before a release is published, the test changes it, and only
// these:
//   - the release's files come from a server on this machine, not from GitHub's releases;
//   - the source (`git clone`, and the campaign's repository) is this checkout's tracked files,
//     committed and tagged as the release, and served by git daemon;
//   - the bundle's CUDA harness names the CPU harness: no step here uses a GPU; and its rig image
//     for RunPod is pinned by the CPU harness's digest, which names no image: no step launches a
//     pod;
//   - the agents' model is the scripted model of the agents acceptance, added as an
//     OpenAI-compatible provider in place of OpenCode's free models, so no key and no network
//     model are needed; the worker harness is OpenCode v2, as the page says;
//   - Look it up reads only https:// addresses, so the test looks the tag up itself, and checks
//     the number of files the page says it finds;
//   - the doctor checks the scripted model's address in place of OpenCode's.
// Then: Your first run (the bundle, init, up, sign in, the rig checks); the command line and
// `thermite doctor` from Troubleshoot; Hand the work to agents, to the first verdict and a pause;
// and the first page's `down`. It removes its stack and volumes, its images, dangling images and
// its folder afterwards. KEEP=1 leaves the stack and the folder.
//
// Usage: COMPOSE="podman compose" node scripts/quick-start-acceptance.mjs
//        (or COMPOSE="docker compose", or COMPOSE="podman-compose")
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cardValue,
  commandsFor,
  engineOf,
  formWith,
  pageText,
  quickStartPlan,
  rewrite,
} from "../src/testing/quick-start.ts";
import { hostName, scriptedModel } from "./lib/scripted-model.mjs";
import { latestVerdicts, lifecycles, until } from "./lib/smoke-env.mjs";

const repo = join(import.meta.dirname, "..");
const COMPOSE = (process.env.COMPOSE ?? "podman compose").trim();
const engine = engineOf(COMPOSE);
const KEEP = process.env.KEEP === "1";
const docs = join(repo, "docs", "_site", "src", "content", "docs");
const plan = quickStartPlan((p) => readFileSync(join(docs, p), "utf8"));
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const tag = `v${version}`;
const rig = plan.firstRun.rig;
const control = plan.firstRun.dashboard;
// The provider the test adds in place of OpenCode, and its one model.
const PROVIDER = "scripted";
const MODEL = "scripted";

// ---------------------------------------------------------------- reporting

const report = { started_at: new Date().toISOString(), compose: COMPOSE, steps: [], checks: [] };
const t0 = Date.now();
const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;
let stepAt = t0;
function section(name) {
  const now = Date.now();
  if (report.steps.length)
    report.steps.at(-1).minutes = Number(((now - stepAt) / 60_000).toFixed(2));
  stepAt = now;
  report.steps.push({ name });
  console.log(`\n== ${name} (at ${minutes(now - t0)})`);
}
/** A check: it is recorded, and a failure stops the test, since each step needs the last. */
function check(name, ok, detail) {
  report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 400)}`}`,
  );
  if (!ok) throw new Error(`failed: ${name}`);
}

// ---------------------------------------------------------------- processes

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
const quiet = (cmd, args, opts = {}) =>
  sh(cmd, args, { stdio: ["ignore", "pipe", "ignore"], ...opts });
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const portInUse = (port) =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(true));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(false)));
  });

// The tester's shell: this one's, without Thermite's or compose's own variables.
const testerEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(THERMITE_|COMPOSE)/.test(k)),
);
const work = mkdtempSync(join(tmpdir(), "thermite-quick-start-"));
const home = join(work, "home");
mkdirSync(home);
let cwd = home;
const rewrites = [];
const hits = new Map();

/**
 * Runs a page's commands as the tester types them, in the tester's folder, and follows its `cd`.
 * Returns what they print. Output that holds a token is not shown.
 */
async function typed(lines, what, { secret = false } = {}) {
  const cmds = commandsFor(lines, COMPOSE).map((l) => rewrite(l, rewrites, hits));
  for (const c of cmds) console.log(`  $ ${c}`);
  const cwdFile = join(work, "cwd");
  // Not a synchronous child: the release's server and the scripted model answer from this process.
  const child = spawn(
    "sh",
    ["-c", `set -e\ncd ${sq(cwd)}\n${cmds.join("\n")}\npwd > ${sq(cwdFile)}\n`],
    { env: testerEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d) => {
    out += d;
    if (!secret) process.stdout.write(d.replace(/^(?=.)/gm, "    "));
  });
  child.stderr
    .setEncoding("utf8")
    .on("data", (d) => process.stderr.write(d.replace(/^(?=.)/gm, "    ")));
  const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
  const [code, signal] = await new Promise((resolve) =>
    child.on("close", (c, s) => resolve([c, s])),
  );
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${what}: the commands ended with exit ${code ?? signal}`);
  cwd = readFileSync(cwdFile, "utf8").trim();
  return out;
}

// ---------------------------------------------------------------- the dashboard and the API

let cookie = "";
let token = "";
async function page(path) {
  const r = await fetch(`${control}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text() };
}
async function send(path, body) {
  const r = await fetch(`${control}${path}`, {
    method: "POST",
    body,
    headers: { cookie },
    redirect: "manual",
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, location: r.headers.get("location") ?? "", text: await r.text() };
}
/** Presses the button of a form on a page, with the form's own fields and what was typed in. */
const press = (html, button, holding, typedIn = {}) => {
  const f = formWith(html, button, holding);
  return send(f.action, new URLSearchParams({ ...f.fields, ...typedIn }));
};
/** The green (ok) or red (error) line a redirect carries. */
const said = (location, kind = "ok") => new URL(location, control).searchParams.get(kind) ?? "";
const words = async (path) => pageText((await page(path)).html);
async function api(path) {
  const r = await fetch(`${control}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
async function events() {
  const all = [];
  for (let after = 0; ; ) {
    const p = await api(`/v1/rigs/${rig}/events?after=${after}&limit=5000`);
    all.push(...p.events);
    if (p.events.length < 5000) return all;
    after = p.events.at(-1).seq;
  }
}
const view = () => api(`/v1/rigs/${rig}/view`);
/** A rig check's result once it has finished. */
const checkDone = (name, timeoutMs) =>
  until(
    `the ${name} check`,
    async () => {
      const c = (await view()).checks?.[name];
      return c?.finished_at ? c : undefined;
    },
    timeoutMs,
    5000,
  );

// ---------------------------------------------------------------- the scripted model

const GOOD = readFileSync(join(repo, "kits/smoke-cpu/candidates/good/src/kernel/matmul.c"));
const HYPOTHESIS = "i-k-j loop order makes the inner loop contiguous";
/**
 * The agents acceptance's script, cut to the quick start: OpenCode's model check, the planner's
 * one-lane plan, and one OpenCode trial that writes the smoke kit's known-good kernel and submits
 * it with thermite-trial.
 */
function script(messages, tools) {
  const names = tools.map((t) => t.function.name);
  const asked = JSON.stringify(messages);
  const results = messages.filter((m) => m.role === "tool").length;
  if (names.includes("shell") && names.includes("execute")) {
    const word = /run exactly this command: echo (thermite-[a-z0-9]+)/.exec(asked)?.[1];
    if (results) return { text: "done" };
    if (word) return { toolCalls: [{ name: "shell", args: { command: `echo ${word}` } }] };
    return {
      toolCalls: [
        {
          name: "shell",
          args: {
            command: `printf '%s' '${GOOD.toString("base64")}' | base64 -d > src/kernel/matmul.c && thermite-trial submit --hypothesis '${HYPOTHESIS}'`,
            timeout: 0,
          },
        },
      ],
    };
  }
  // A request without tools names OpenCode's session.
  if (!tools.length) return { text: "A Thermite trial" };
  if (names.includes("echo")) {
    if (results) return { text: "done" };
    return {
      toolCalls: [{ name: "echo", args: { word: /the word (\S+)\./.exec(asked)?.[1] ?? "" } }],
    };
  }
  if (names.includes("submit_plan"))
    return {
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            new_families: [{ id: "loop-order", description: "change the loop order for locality" }],
            assignments: [
              {
                lane: "lane-1",
                family: "loop-order",
                focus: "make the inner loop contiguous",
                parent: "champion",
              },
            ],
          },
        },
      ],
    };
  return { text: "done" };
}

// ---------------------------------------------------------------- the release, from this checkout

const IMAGES = ["control", "harness", "supervisor"];
let registry = "";
let registryBox = "";
let registryImageWasHere = true;
const builtTags = [];
const REGISTRY_IMAGE =
  "docker.io/library/registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e";

/** Builds the images from this checkout, and finds the digest each one is pinned by. */
async function buildImages(commit) {
  if (engine === "podman") registry = "localhost/thermite-quick-start";
  else {
    // Docker takes a registry on 127.0.0.1 without TLS.
    const port = await freePort();
    registryBox = `thermite-quick-start-registry-${port}`;
    try {
      quiet("docker", ["image", "inspect", REGISTRY_IMAGE]);
    } catch {
      registryImageWasHere = false;
    }
    sh("docker", [
      "run",
      "-d",
      "--name",
      registryBox,
      "-p",
      `127.0.0.1:${port}:5000`,
      REGISTRY_IMAGE,
    ]);
    registry = `127.0.0.1:${port}/thermite-quick-start`;
  }
  const digests = {};
  for (const key of IMAGES) {
    const name = `${registry}/thermite-${key}`;
    const ref = `${name}:quick-start`;
    console.log(`build ${ref}`);
    const args = ["--build-arg", `THERMITE_COMMIT=${commit}`];
    if (key === "harness")
      args.push("--build-arg", `THERMITE_IMAGE_ID=${version}+${commit.slice(0, 12)}`);
    sh(engine, ["build", "-f", `containers/${key}/Containerfile`, ...args, "-t", ref, "."], {
      cwd: repo,
      stdio: "inherit",
    });
    builtTags.push(ref);
    if (engine === "podman")
      digests[key] = sh("podman", ["image", "inspect", "--format", "{{.Digest}}", ref]).trim();
    else {
      sh("docker", ["push", "--quiet", ref]);
      const pinned = JSON.parse(
        sh("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", ref]),
      );
      digests[key] = pinned.find((d) => d.startsWith(`${name}@`))?.split("@")[1];
    }
    check(
      `the ${key} image has a digest to pin`,
      /^sha256:[0-9a-f]{64}$/.test(digests[key] ?? ""),
      digests[key],
    );
  }
  // The bundle names a CUDA harness for rigs on GPU machines, and a rig image for RunPod. This
  // test starts neither: control passes the rig image's name to RunPod only at a launch.
  digests["harness-cuda"] = digests.harness;
  digests["rig-cuda"] = digests.harness;
  return digests;
}

/** The release bundle, written by the release's own script. */
function writeBundle(digests) {
  const dir = join(work, "digests");
  mkdirSync(dir);
  for (const [key, digest] of Object.entries(digests)) writeFileSync(join(dir, key), `${digest}\n`);
  const out = join(work, "release");
  sh(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "scripts/release-bundle.ts",
      "--version",
      version,
      "--registry",
      registry,
      "--repo-url",
      plan.repo,
      "--digests",
      dir,
      "--out",
      out,
    ],
    { cwd: repo, stdio: "inherit" },
  );
  return out;
}

/** This checkout's tracked files, committed and tagged as the release, as a bare repository. */
function sourceRepository() {
  const src = join(work, "source");
  for (const f of sh("git", ["ls-files", "-z"], { cwd: repo }).split("\0").filter(Boolean)) {
    const from = join(repo, f);
    const to = join(src, f);
    let link = false;
    try {
      link = lstatSync(from).isSymbolicLink();
    } catch {
      continue; // deleted in the working tree
    }
    mkdirSync(dirname(to), { recursive: true });
    // A link stays a link, as git keeps it; a file keeps its mode.
    if (link) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
  const git = (...args) =>
    quiet(
      "git",
      [
        "-c",
        "user.name=Thermite",
        "-c",
        "user.email=release@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      { cwd: src },
    ).trim();
  git("init", "--quiet", "-b", "main");
  git("add", "-A", "-f");
  git("commit", "--quiet", "-m", `Thermite ${version}`);
  git("tag", tag);
  const dir = join(work, "git");
  mkdirSync(dir);
  quiet("git", ["clone", "--quiet", "--bare", src, join(dir, "thermite.git")]);
  writeFileSync(join(dir, "thermite.git", "git-daemon-export-ok"), "");
  return dir;
}

/** The address the stack's containers reach a server on this machine at. */
function containersHost() {
  if (engine === "podman" || process.platform === "darwin") return hostName(COMPOSE);
  // Docker on Linux names this machine only where compose.yaml maps the name, and the supervisor
  // has no such mapping: the gateway of the stack's egress network is this machine.
  return sh("docker", [
    "network",
    "inspect",
    "thermite_egress",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]).trim();
}

// ---------------------------------------------------------------- the test

let thermiteDir = "";
let daemon;
let releaseServer;
let model;
let failed = false;
try {
  section("before the tester: the images and the release bundle, from this checkout");
  const busy = await portInUse(Number(new URL(control).port));
  check(`port ${new URL(control).port} is free for this test's control`, !busy);
  const volumes = quiet(engine, ["volume", "ls", "--format", "{{.Name}}"])
    .split("\n")
    .filter((v) => v.startsWith("thermite_"));
  check(
    "no compose stack named thermite has volumes here (this test would use them)",
    !volumes.length,
    volumes,
  );
  const commit = quiet("git", ["rev-parse", "HEAD"], { cwd: repo }).trim();
  const digests = await buildImages(commit);
  const releaseDir = writeBundle(digests);

  // The release's files, as GitHub serves them.
  releaseServer = createServer((req, res) => {
    const m = /^\/releases\/(?:latest\/download|download\/v[^/]+)\/([A-Za-z0-9._-]+)$/.exec(
      req.url ?? "",
    );
    const file = m ? join(releaseDir, m[1]) : "";
    if (req.method !== "GET" || !file || !existsSync(file)) {
      res.writeHead(404).end("Not Found\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((r) => releaseServer.listen(0, "127.0.0.1", r));
  const httpPort = releaseServer.address().port;
  // The source, as the release's tag.
  const gitDir = sourceRepository();
  const gitPort = await freePort();
  daemon = spawn(
    "git",
    [
      "daemon",
      "--reuseaddr",
      `--base-path=${gitDir}`,
      `--port=${gitPort}`,
      "--listen=0.0.0.0",
      gitDir,
    ],
    { stdio: "ignore" },
  );
  const served = `git://127.0.0.1:${gitPort}/thermite.git`;
  await until("git daemon answers", () => quiet("git", ["ls-remote", served]), 30_000, 500);
  model = await scriptedModel(script);
  const modelUrl = `http://${hostName(COMPOSE)}:${model.port}/v1`;
  rewrites.push(
    {
      from: `${plan.repo}/releases/latest/download/`,
      to: `http://127.0.0.1:${httpPort}/releases/latest/download/`,
      why: "no release is published before the first tag: the bundle comes from this machine",
    },
    {
      from: `${plan.repo}.git`,
      to: served,
      why: "the source is this checkout, tagged as the release and served on this machine",
    },
  );
  // The page says to use the release that compose.yaml names, when it is not the page's.
  if (plan.agents.tag !== tag)
    rewrites.push({
      from: `--branch ${plan.agents.tag} `,
      to: `--branch ${tag} `,
      why: "the release",
    });

  // ------------------------------------------------ Your first run
  section("Your first run, 1: get Thermite");
  await typed(plan.firstRun.get, "step 1");
  thermiteDir = cwd;
  const firstLine = readFileSync(join(thermiteDir, "compose.yaml"), "utf8").split("\n")[0];
  // The page's example names its own release; this bundle's is this checkout's version.
  const names = plan.firstRun.firstLine.replace(/\d+\.\d+\.\d+\S*$/, version);
  check(
    "the compose file's first line names the release, as the page shows it",
    firstLine.startsWith(names) && !/[\w.-]/.test(firstLine.charAt(names.length)),
    { firstLine, page: plan.firstRun.firstLine },
  );

  section("Your first run, 2: make your local tokens");
  const init = await typed(plan.firstRun.init, "step 2");
  const initDone = init
    .split("\n")
    .filter((l) => l.startsWith("local init:"))
    .at(-1);
  check("init's last line is the page's", initDone === plan.firstRun.initDone, {
    printed: initDone,
    page: plan.firstRun.initDone,
  });

  section("Your first run, 3: start Thermite");
  let listed = "";
  for (const [i, block] of plan.firstRun.start.entries())
    listed = await typed(block, `step 3, block ${i + 1}`);
  const lines = listed.split("\n");
  const notUp = plan.firstRun.services.filter(
    (s) => !lines.some((l) => l.includes(s) && /\bUp\b/.test(l)),
  );
  check("ps lists control, harness and supervisor as Up", !notUp.length, { notUp });

  section("Your first run, 4: sign in");
  token = (await typed(plan.firstRun.token, "step 4", { secret: true })).trim();
  check("the owner's token is in .dev/secrets", token.length >= 32);
  await until(
    "control answers",
    async () => (await fetch(`${control}/v1/health`)).ok,
    120_000,
    2000,
  );
  const login = await page("/ui/login");
  check(
    "the sign-in page has the Admin token field",
    pageText(login.html).includes(plan.firstRun.tokenLabel),
  );
  const signed = await press(login.html, plan.firstRun.signIn, undefined, { token });
  check(
    "Sign in takes the token",
    signed.status === 303 && signed.location === "/ui" && cookie !== "",
    { status: signed.status, location: signed.location },
  );
  const overview = await until(
    "Overview's first line",
    async () => ((await words("/ui")).includes(plan.firstRun.overview) ? true : undefined),
    300_000,
    5000,
  ).catch(() => false);
  check("Overview says what the page says", overview === true, {
    page: plan.firstRun.overview,
    seen: (await words("/ui")).slice(0, 300),
  });

  section("Your first run, 5: meet your rig");
  const live = await until(
    "the rig is live",
    async () => ((await words(`/ui/rigs/${rig}`)).includes(plan.firstRun.live) ? true : undefined),
    180_000,
    5000,
  ).catch(() => false);
  check(`the rig's page says "${plan.firstRun.live}"`, live === true);
  const isolation = await checkDone("isolation", 600_000);
  check("Isolation passed by itself at the rig's start", isolation.ok === true, isolation.summary);

  section("Your first run, 6: run the judge's smoke check");
  const rigPage = await page(`/ui/rigs/${rig}`);
  check(
    "the rig's page has the Judge smoke check",
    pageText(rigPage.html).includes(plan.firstRun.smokeCheck),
  );
  const ran = await press(rigPage.html, plan.firstRun.runIt, 'name="check" value="smoke"');
  check("Run it sends the command", ran.status === 303, {
    status: ran.status,
    text: ran.text.slice(0, 200),
  });
  const smoke = await checkDone("smoke", 1_200_000);
  check(
    "Judge smoke passed, in the page's words",
    smoke.ok === true && String(smoke.summary).startsWith(plan.firstRun.smokePassed),
    smoke.summary,
  );
  const smokeRun = (await events()).find(
    (e) => e.kind === "run_created" && String(e.subject).startsWith("check-smoke-"),
  );
  check(
    "the check's campaign is the one the page names",
    smokeRun?.body?.campaign === plan.firstRun.smokeCampaign,
    { campaign: smokeRun?.body?.campaign, page: plan.firstRun.smokeCampaign },
  );

  section("Your first run, 7: see what the judge decided");
  const evs = await events();
  const verdicts = latestVerdicts(evs);
  const life = lifecycles(evs);
  const counted = {};
  for (const e of evs.filter(
    (x) => x.kind === "attempt_recorded" && x.body.run === smokeRun.subject,
  )) {
    const word =
      life[e.subject] === "rejected_v0"
        ? "rejected v0"
        : String(verdicts[e.subject] ?? life[e.subject]).replace(/_/g, " ");
    counted[word] = (counted[word] ?? 0) + 1;
  }
  const same = (x, y) =>
    JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());
  check(
    "How the judge decided counts what the page counts",
    same(counted, plan.firstRun.verdicts),
    { counted, page: plan.firstRun.verdicts },
  );

  // ------------------------------------------------ Hand the work to agents
  section("Hand the work to agents, 1: add a model provider (the scripted model)");
  const settings = await page("/ui/settings");
  const add = formWith(settings.html, plan.agents.addProvider);
  check(
    "the provider form offers an OpenAI-compatible provider",
    Object.values(add.options.type ?? {}).includes("openai"),
    add.options.type,
  );
  const added = await send(
    add.action,
    new URLSearchParams({
      ...add.fields,
      type: "openai",
      name: PROVIDER,
      base_url: modelUrl,
      api_key: "quick-start",
    }),
  );
  const savedWords = plan.agents.providerSaved.replace(
    `"${plan.agents.providerName}"`,
    `"${PROVIDER}"`,
  );
  check(
    "the provider is saved and lists its model",
    said(added.location).startsWith(`${savedWords} 1 model`),
    { said: said(added.location) || said(added.location, "error") },
  );

  section("Hand the work to agents, 2: give the rig the model");
  const rows = await page("/ui/settings");
  check(
    `the rig's row says "${plan.agents.noModel}"`,
    pageText(rows.html).includes(plan.agents.noModel),
  );
  const use = formWith(rows.html, plan.agents.use, `name="rig" value="${rig}"`);
  const harness = use.options.harness?.[plan.agents.harness];
  const choice = `${PROVIDER}|${MODEL}`;
  check(
    `the row offers ${plan.agents.harness} and the scripted model`,
    Boolean(harness) && Object.values(use.options.choice ?? {}).includes(choice),
    use.options,
  );
  const given = await send(use.action, new URLSearchParams({ ...use.fields, harness, choice }));
  check(
    `Use gives the rig the model under ${plan.agents.harness}`,
    said(given.location).includes(`under ${plan.agents.harness} within a minute`),
    { said: said(given.location) || said(given.location, "error") },
  );

  section("Hand the work to agents, 3: check that the model works");
  const modelCheck = await checkDone("model", 600_000);
  check(
    "the rig's model check passed, in the page's words",
    modelCheck.ok === true &&
      plan.agents.modelPassed.every((w) => String(modelCheck.summary).includes(w)),
    modelCheck.summary,
  );

  section("Hand the work to agents, 4: get the sample and pack its kit");
  await typed(plan.agents.source, "step 4");
  const sourceDir = cwd;
  check(
    "the kit's archive is in thermite-source",
    existsSync(join(sourceDir, plan.agents.kitArchive)),
  );

  section("Troubleshoot: build the command line and check the machine");
  await typed(plan.commandLine, "the command line");
  const doctorLines = plan.doctor.map((l) =>
    l.replace(/--model-url\s+\S+/, `--model-url ${modelUrl}`),
  );
  const doctor = await typed(doctorLines, "thermite doctor");
  check("thermite doctor finds no failure", doctor.includes(plan.doctorOk));

  section(
    "Hand the work to agents, 5 to 8: name the campaign, point it at the sample, upload the kit, start it",
  );
  const form = await page("/ui/campaigns/new");
  const formWords = pageText(form.html);
  const missing = [
    ...plan.agents.formLabels,
    plan.agents.kitField,
    plan.agents.lookUp,
    plan.agents.startButton,
    plan.agents.access,
  ].filter((l) => !formWords.includes(l));
  check("New campaign shows every field and button the steps name", !missing.length, { missing });
  const mode = cardValue(form.html, "mode", plan.agents.mode);
  const kitSource = cardValue(form.html, "kit", plan.agents.kitCard);
  // Look it up, done here: control reads only https:// addresses, and the source is served here.
  check(
    "the campaign starts from the release the source was cloned at",
    plan.agents.startFrom === plan.agents.tag,
  );
  const ref = tag;
  const sourceCommit = quiet("git", ["ls-remote", served, `refs/tags/${ref}`]).split(/\s/)[0];
  const folderFiles = quiet(
    "git",
    ["ls-tree", "-r", "--name-only", sourceCommit, "--", `${plan.agents.folder}/`],
    { cwd: join(gitDir, "thermite.git") },
  )
    .split("\n")
    .filter(Boolean).length;
  check(
    "the folder holds as many files as Look it up says",
    folderFiles === plan.agents.folderFiles,
    { files: folderFiles, page: plan.agents.folderFiles },
  );
  // The kit, uploaded as the page's Kit archive field sends it.
  const campaignForm = formWith(form.html, plan.agents.startButton);
  const upload = new FormData();
  upload.append("csrf", campaignForm.fields.csrf ?? "");
  upload.append(
    "archive",
    new File([readFileSync(join(sourceDir, plan.agents.kitArchive))], plan.agents.kitArchive),
  );
  const up = await fetch(`${control}/ui/campaigns/new/kit`, {
    method: "POST",
    body: upload,
    headers: { cookie },
  });
  const kit = await up.json();
  const n = kit.cells?.length ?? 0;
  const summary = `${kit.name}: measures on ${kit.target}, ${n} case${n === 1 ? "" : "s"}, scores ${Object.keys(kit.metrics ?? {}).join(", ")}.`;
  check(
    "control checks the kit, and sums it up as the page does",
    up.ok && summary === plan.agents.kitSummary,
    { summary, page: plan.agents.kitSummary, error: kit.error },
  );
  const used = [...plan.agents.measured, ...plan.agents.hidden];
  check(
    "the kit has every case the page uses",
    used.every((c) => kit.cells.includes(c)),
    { kit: kit.cells, page: used },
  );
  const [metric, about] = plan.agents.score.split(": ");
  check("the score is the one the page shows", kit.metrics?.[metric]?.about === about, kit.metrics);
  const direction = { higher: "max", lower: "min" }[plan.agents.better];
  check("Better is higher or lower", Boolean(direction), plan.agents.better);
  const project = plan.agents.repository.replace(plan.repo, "").replace(/^\//, "");
  const draft = {
    mode,
    campaign: plan.agents.campaign,
    title: plan.agents.title,
    lanes: plan.agents.lanes,
    limits: {},
    project: {
      url: `git://${containersHost()}:${gitPort}/thermite.git`,
      ref,
      commit: sourceCommit,
      repo: (
        project
          .replace(/\.git$/, "")
          .split(/[/:]/)
          .pop() || "project"
      ).toLowerCase(),
      folder: plan.agents.folder,
      editable_paths: [plan.agents.editable],
      forbidden_patterns: plan.agents.forbidden,
    },
    kit: {
      source: kitSource,
      upload: kit.id,
      cells: kit.cells.filter((c) => used.includes(c)),
      held_out: plan.agents.hidden,
    },
    score: { name: metric, direction, min_effect: plan.agents.minEffectPercent / 100 },
  };
  console.log(`  draft: ${JSON.stringify(draft)}`);
  const started = await send(
    "/ui/campaigns/new",
    new URLSearchParams({
      ...campaignForm.fields,
      draft: JSON.stringify(draft),
      rig,
      start_value: "start",
    }),
  );
  check(
    "Start the campaign takes it and starts its first run",
    started.status === 303 && started.location.includes("?run="),
    {
      status: started.status,
      location: started.location,
      page: started.status === 303 ? undefined : pageText(started.text).slice(0, 400),
    },
  );
  check(
    "the campaign's page says what the page quotes",
    (await words(started.location.replace(control, ""))).includes(plan.agents.starting),
    plan.agents.starting,
  );
  const run = /Starting [^/]+\/(\S+)\.$/.exec(plan.agents.starting)?.[1];
  const created = await until(
    "the run starts on the rig",
    async () => (await events()).find((e) => e.kind === "run_created" && e.subject === run),
    900_000,
    5000,
  );
  check(
    "the rig fetched the repository and started from the folder",
    created.body?.seed?.folder === plan.agents.folder &&
      created.body?.seed?.source_commit === sourceCommit,
    created.body?.seed,
  );

  section("Hand the work to agents, 9 and 10: watch the agent work and the judge decide");
  const first = await until(
    "the judge's first verdict on an agent's change",
    async () => {
      const all = await events();
      const v = latestVerdicts(all);
      const l = lifecycles(all);
      const attempts = all.filter((e) => e.kind === "attempt_recorded" && e.body.run === run);
      const refused = attempts.find((a) => l[a.subject] === "rejected_v0");
      if (refused) return { attempt: refused, verdict: "rejected v0" };
      const judged = attempts.find((a) => v[a.subject] && v[a.subject] !== "win_screened");
      return judged && { attempt: judged, verdict: v[judged.subject] };
    },
    2_400_000,
    10_000,
  );
  check(
    "lane-1's agent submitted the change",
    first.attempt.body.lane === "lane-1" && first.attempt.body.hypothesis === HYPOTHESIS,
    first.attempt.body,
  );
  check("the judge confirmed it faster", first.verdict === "win_confirmed", {
    verdict: first.verdict,
  });

  section("Hand the work to agents, 11: pause the campaign");
  const runPath = `/ui/campaigns/${encodeURIComponent(plan.agents.campaign)}?run=${encodeURIComponent(`${rig}/${run}`)}`;
  const runPage = await page(runPath);
  const paused = await press(runPage.html, plan.agents.pause, `value="${run}"`, {
    reason: plan.agents.pauseReason,
  });
  check("Pause the run sends the command", paused.status === 303, { status: paused.status });
  const stopped = await until(
    "the run's page says it is paused",
    async () => ((await words(runPath)).includes(plan.agents.paused) ? true : undefined),
    300_000,
    5000,
  ).catch(() => false);
  const shown = await words(runPath);
  const status = (await view()).runs?.find((r) => r.id === run);
  check("the run's page says what the page quotes", stopped === true, {
    page: plan.agents.paused,
    status: status?.status,
    reason: status?.pause_reason,
    seen: shown.slice(
      Math.max(0, shown.indexOf("This run is")),
      shown.indexOf("This run is") + 200,
    ),
  });

  section("Your first run, 8: stop Thermite");
  cwd = thermiteDir;
  await typed(plan.firstRun.down, "step 8");
  for (const r of rewrites)
    check(`the pages still need the test's change: ${r.why}`, (hits.get(r.from) ?? 0) > 0, r.from);
} catch (err) {
  failed = true;
  console.log(`FAIL ${String(err?.stack ?? err)}`);
  report.error = String(err?.message ?? err);
} finally {
  section("clean up");
  report.minutes = Number(((Date.now() - t0) / 60_000).toFixed(1));
  report.ok = !failed && report.checks.every((c) => c.ok);
  daemon?.kill();
  releaseServer?.close();
  model?.close();
  if (KEEP) console.log(`KEEP=1: the stack runs on, and the tester's folders are in ${home}`);
  else {
    if (thermiteDir)
      spawnSync("sh", ["-c", `${COMPOSE} down -v`], {
        cwd: thermiteDir,
        env: testerEnv,
        stdio: "inherit",
      });
    if (builtTags.length) spawnSync(engine, ["rmi", "-f", ...builtTags], { stdio: "inherit" });
    if (registryBox) {
      spawnSync("docker", ["rm", "-f", registryBox], { stdio: "ignore" });
      if (!registryImageWasHere) spawnSync("docker", ["rmi", REGISTRY_IMAGE], { stdio: "ignore" });
    }
    // Dangling images only: tagged images may be other projects'.
    spawnSync(engine, ["image", "prune", "-f"], { stdio: "inherit" });
    if (engine === "podman" && process.platform === "darwin")
      spawnSync("podman", ["machine", "ssh", "sudo", "fstrim", "-a"], { stdio: "inherit" });
    try {
      rmSync(work, { recursive: true, force: true });
    } catch (err) {
      console.log(`could not remove all of ${work}: ${err?.message ?? err}`);
    }
  }
  mkdirSync(join(repo, ".dev", "acceptance"), { recursive: true });
  const file = join(
    repo,
    ".dev",
    "acceptance",
    `quick-start-${report.started_at.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  console.log(`quick start acceptance: ${report.ok ? "OK" : "FAILED"} in ${report.minutes} min`);
  process.exitCode = report.ok ? 0 : 1;
}
