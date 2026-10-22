// Test only (scripts/claude-real-acceptance.mjs): Thermite's own calls of Claude Code, run in the
// harness container with the image's real Claude Code and the stand-in for Anthropic's API
// (anthropic.mjs). It prints one JSON line: { checks: [{ name, ok, detail }] }.
//   node check.mjs harness   as the controller's user: the model check, a planner call and a
//                            trial, through the broker (each as its role's user)
//   node check.mjs advisor   as the supervisor's user, with its own TMPDIR: an advisor's call,
//                            and what /proc shows of its processes' environments
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startAnthropicStandIn } from "./anthropic.mjs";

/** A made-up sign-in token: letters only, never a real one. */
const TOKEN = "madeupsignintokenforthestandin";
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const here = "/opt/test-anthropic";
process.env.THERMITE_CLAUDE_BIN = `${here}/claude`;
const model = {
  api: "claude",
  harness: "claude-code",
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-5-5",
  apiKey: TOKEN,
  contextWindow: 1_000_000,
  maxTokens: 0,
};
const api = await startAnthropicStandIn({ token: TOKEN });

async function harness() {
  const { BrokerClient } = await import("/opt/thermite/dist/harness/broker/client.js");
  const { claudeModelCheck, claudeOnce, runClaudeTrial } = await import(
    "/opt/thermite/dist/harness/agents/claude-code.js"
  );
  const runner = new BrokerClient("/run/thermite/broker.sock");
  const scratchDir = "/scratch/thermite";
  const deps = { runner, apiUrl: "http://127.0.0.1:8700", scratchDir };

  // The model check, as the rig check runs it.
  const mc = await claudeModelCheck(model, deps);
  check(
    "the model check passes: Claude Code ran its Bash call as the model check's user",
    mc.ok && mc.detail.tool_called,
    mc.summary,
  );

  // A planner call with past research: Claude Code's Grep (its own ripgrep) reads a folder
  // outside its own, as the planner's user, which may read it.
  const kdir = join(scratchDir, "claude-real-knowledge");
  mkdirSync(kdir, { recursive: true });
  chmodSync(kdir, 0o755);
  writeFileSync(join(kdir, "notes.md"), "aligned loads made the kernel 12% faster\n", {
    mode: 0o644,
  });
  const grep = { pattern: "aligned", path: kdir, output_mode: "content" };
  const pl = await claudeOnce(
    model,
    `Plan the next round. First call the Grep tool with input ${JSON.stringify(grep)}END`,
    deps,
    { tools: "Read,Grep,Glob", timeoutMs: 120_000, role: "planner" },
  );
  const found = pl.tools.find((t) => t.tool === "Grep");
  check(
    "a planner call's Grep read past research outside its folder, as the planner's user",
    found?.ok && /aligned loads/.test(found.output),
    found ?? pl.errors.at(-1) ?? pl.notes,
  );

  // A trial: Claude Code edits the workspace with its Write tool, runs a command that looks for
  // the token, and submits with thermite-trial, as the lane's user. The harness API is a stand-in
  // here that takes the submission.
  const lane = "lane-1";
  const area = join(scratchDir, "lanes", lane, randomUUID());
  const repo = join(area, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "value.txt"), "1\n");
  const git = (...a) =>
    execFileSync(
      "git",
      ["-c", "user.name=thermite", "-c", "user.email=thermite@localhost", ...a],
      { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: area }, stdio: "ignore" },
    );
  git("init", "--quiet", "-b", "work");
  git("add", "-A");
  git("commit", "--quiet", "-m", "parent");
  await runner.handOver(area, lane, { harnessReads: true });
  let submission;
  const harnessApi = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/attempts") {
        const body = JSON.parse(raw);
        submission = {
          trialToken: req.headers.authorization === "Bearer trial.trial-check",
          patch: Buffer.from(body.patch_base64, "base64").toString("utf8"),
          hypothesis: body.hypothesis,
        };
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ attempt: "a-check", lifecycle: "queued" }));
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise((r) => harnessApi.listen(0, "127.0.0.1", r));
  const write = { file_path: join(repo, "src", "value.txt"), content: "2\n" };
  const half = Math.floor(TOKEN.length / 2);
  const bash = {
    command: `node ${here}/probe.mjs ${TOKEN.slice(0, half)} ${TOKEN.slice(half)} && thermite-trial submit --hypothesis "value two, from the real Claude Code"`,
  };
  const live = [];
  const trial = await runClaudeTrial(
    {
      trialId: "t-check",
      token: "trial-check",
      run: "claude-real-1",
      lane,
      workspace: repo,
      workspaceRoot: area,
      parentCommit: "0".repeat(40),
      editablePaths: ["src/**"],
      brief: `Set the value to 2. First call the Write tool with input ${JSON.stringify(write)}END Then call the Bash tool with input ${JSON.stringify(bash)}END`,
      wallMs: 180_000,
    },
    {
      runner,
      model,
      apiUrl: `http://127.0.0.1:${harnessApi.address().port}`,
      live: (entries) => live.push(...entries),
      progress: () => undefined,
      submitted: () => (submission ? { attempt: "a-check", lifecycle: "queued" } : undefined),
      pollMs: 300,
      afterSubmitMs: 1500,
    },
  );
  harnessApi.close();
  check(
    "a trial in Claude Code submitted with thermite-trial, with the trial's token",
    trial.stopped === "submitted" && submission?.trialToken,
    { stopped: trial.stopped, error: trial.error, turns: trial.turns },
  );
  check(
    "its Write tool changed the workspace: permissions bypassed, nothing waited for approval",
    /-1\n\+2/.test(submission?.patch ?? "") && /src\/value\.txt/.test(submission?.patch ?? ""),
    submission?.patch ?? live.slice(-4),
  );
  const said = live.find((e) => e.kind === "result" && /signin=/.test(e.text))?.text ?? "";
  check(
    "its command ran as the lane's user and found the token in no environment, Claude Code's included",
    /uid=10101 signin=absent/.test(said),
    said || live.slice(-4),
  );
  await runner.remove(area);

  // Goal 070: a trial that compacts. The stand-in says the conversation is large after its first
  // reply, so the real Claude Code compacts before its next request (its window 100,000 tokens,
  // compacted at 50%). Thermite's PreCompact hook, from Thermite's settings for the run, copies
  // the transcript as the lane's user and adds its line to the compaction's instructions; the
  // stand-in's summary names the file, and the harness reads the hook's copy.
  const area2 = join(scratchDir, "lanes", lane, randomUUID());
  const repo2 = join(area2, "repo");
  mkdirSync(join(repo2, "src"), { recursive: true });
  writeFileSync(join(repo2, "src", "value.txt"), "1\n");
  execFileSync("git", ["init", "--quiet", "-b", "work"], { cwd: repo2, stdio: "ignore" });
  await runner.handOver(area2, lane, { harnessReads: true });
  const compacted = [];
  const kept = { dir: join(scratchDir, "research", "claude-real-1", "compactions"), stem: "t-compact", readable: true };
  const ct = await runClaudeTrial(
    {
      trialId: "t-compact",
      token: "trial-compact",
      run: "claude-real-1",
      lane,
      workspace: repo2,
      workspaceRoot: area2,
      parentCommit: "0".repeat(40),
      editablePaths: ["src/**"],
      brief: "COMPACT-CHECK Look at the value.",
      wallMs: 150_000,
    },
    {
      runner,
      model: { ...model, contextWindow: 100_000, compactAt: 50 },
      apiUrl: "http://127.0.0.1:9",
      live: () => undefined,
      progress: () => undefined,
      submitted: () => undefined,
      pollMs: 300,
      keptAt: kept,
      compacted: (c) => compacted.push(c),
    },
  );
  const first = compacted[0];
  check(
    "the real Claude Code compacted a trial's conversation: its PreCompact hook copied the transcript, and the summary names the kept file",
    first?.number === 1 &&
      first.own === true &&
      /from Claude Code's own transcript of the session/.test(first.markdown) &&
      /COMPACT-CHECK/.test(first.markdown) &&
      (first.summary ?? "").includes(`${kept.dir}/t-compact-1.md`),
    {
      compactions: ct.compactions ?? 0,
      stopped: ct.stopped,
      error: ct.error,
      own: first?.own,
      summary: first?.summary,
      head: first?.markdown.slice(0, 300),
    },
  );
  await runner.remove(area2);
  runner.close();
}

/**
 * The processes of an advisor's call (their environment names its folder, thermite-advisor-…), as
 * /proc shows them to the supervisor's user while the call runs: whether the token or the scrub
 * is in each one's environment, and whether it names the token's file descriptor. Never the token.
 */
function watchAdvisor() {
  const seen = new Map();
  const look = () => {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      let env;
      try {
        env = readFileSync(`/proc/${pid}/environ`, "latin1");
      } catch {
        continue; // gone, or another user's
      }
      if (!env.includes("/thermite-advisor-")) continue;
      let exe = "";
      try {
        exe = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        // gone
      }
      const vars = env.split("\0");
      const was = seen.get(pid);
      const scrub = vars.some((v) => v.startsWith("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB="));
      seen.set(pid, {
        exe: exe || was?.exe || "",
        token: env.includes(TOKEN) || Boolean(was?.token),
        scrub: scrub || Boolean(was?.scrub),
        fd: vars.includes("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3") || Boolean(was?.fd),
      });
    }
  };
  const timer = setInterval(look, 20);
  return {
    stop: () => {
      clearInterval(timer);
      return [...seen.values()];
    },
  };
}

async function advisor() {
  const { runAdvisor } = await import("/opt/thermite/dist/supervisor/advisors.js");
  const watch = watchAdvisor();
  const r = await runAdvisor({
    runtime: { name: "check", runtime: "claude-code", model: model.model, token: TOKEN, timeout_s: 120 },
    system: "You audit a candidate change.",
    prompt: "ADVISOR-CHECK Is this change clear?",
    schema: {
      safeParse: (v) =>
        v && typeof v === "object" && typeof v.decision === "string"
          ? { success: true, data: v }
          : { success: false },
    },
    answerSchema: { type: "object", properties: { decision: { type: "string" } } },
  });
  const procs = watch.stop();
  check(
    "an advisor's call in Claude Code answered, as the supervisor's user with /tmp closed to it",
    r.output?.decision === "clear",
    r.error ?? r.output,
  );
  const claude = procs.filter((p) => p.exe === "/usr/local/bin/claude");
  check(
    "the advisor's Claude Code ran without the scrub, its sign-in on file descriptor 3, and no process of the call had the token in its environment",
    claude.length > 0 && claude.every((p) => p.fd) && procs.every((p) => !p.token && !p.scrub),
    procs,
  );
}

const mode = process.argv[2] === "advisor" ? "advisor" : "harness";
try {
  if (mode === "advisor") await advisor();
  else await harness();
} catch (err) {
  check(`the ${mode} checks ran`, false, err instanceof Error ? err.stack : String(err));
}
check(
  `every call to the stand-in for Anthropic's API was signed in with the token (${mode})`,
  api.seen.signedIn > 0 && api.seen.other === 0,
  api.seen,
);
await api.close();
console.log(JSON.stringify({ checks }));
