import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "../../testing/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../testing/judge-env.ts";
import { LocalRunner } from "../broker/runner.ts";
import { runTrial } from "./worker.ts";
import { prepareWorkspace } from "./workspace.ts";

const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("./lanetool.ts", import.meta.url)),
];

describe("worker trial", () => {
  test("a scripted agent reads, edits, tests and submits once; the judge takes it from there", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.currentChampion("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    // The model: list, read, rewrite the kernel, run a quick check, submit.
    const fake = await startFakeModel(({ messages }) => {
      const done = messages.filter((m) => m.role === "tool").length;
      const steps = [
        { name: "list_files", args: {} },
        { name: "read_file", args: { path: "src/kernel/work.mjs" } },
        { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
        {
          name: "run",
          args: {
            command:
              "node -e \"import('./src/kernel/work.mjs').then(m => console.log(m.work(14)))\"",
          },
        },
        { name: "submit", args: { hypothesis: "remove the wasted inner loop", known_flaws: [] } },
      ];
      const next = steps[done];
      return next ? { toolCalls: [next] } : { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t1",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.equal(r.toolCalls, 5);
    assert.ok(r.tokensIn > 0);
    const a = env.ledger.getAttempt(r.submitted?.attempt ?? "");
    assert.equal(String(a?.lane), "lane-1");
    assert.equal(String(a?.lifecycle), "queued");
    await env.drain();
    assert.equal(env.ledger.currentVerdict(String(a?.id))?.verdict, "win_confirmed");
  });

  test("a model that stops early is told to go on, twice at most; why it stopped is recorded", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.currentChampion("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    const trial = (url: string) =>
      runTrial(
        {
          trialId: "t-nudge",
          run: "js-1",
          lane: "lane-1",
          workspace: ws.repo,
          parentCommit: champion.commit_sha,
          editablePaths: ["src/kernel/**"],
          brief: "Make work() faster without changing its result.",
          wallMs: 60_000,
          maxTurns: 20,
        },
        {
          runner,
          laneTool,
          model: {
            baseUrl: url,
            model: "test",
            apiKey: "k",
            contextWindow: 32000,
            maxTokens: 2000,
          },
          submit: (req) =>
            env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
          status: async (id) => env.service.attemptStatus(id),
        },
      );
    // Thinks aloud first; after the nudge it writes the change and submits.
    const late = await startFakeModel(({ messages }) => {
      const nudged = messages.some(
        (m) => m.role === "user" && String(JSON.stringify(m.content)).includes("not called submit"),
      );
      if (!nudged) return { text: "I would start by reading the kernel." };
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (done === 1)
        return {
          toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
        };
      return { text: "done" };
    });
    const r = await trial(late.url);
    await late.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    // Never uses a tool: two nudges, then no submission, with the reason.
    let requests = 0;
    const idle = await startFakeModel(() => {
      requests++;
      return { text: "Nothing to do." };
    });
    const r2 = await trial(idle.url);
    await idle.close();
    assert.equal(r2.stopped, "no_submission");
    assert.equal(requests, 3);
    assert.match(String(r2.error), /the model stopped \(stop\)/);
  });

  test("a configured turn cap is stated, warned of once, and reported as a limit, not a model error", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.currentChampion("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    const seen: string[] = [];
    // Reads a file every turn and never submits.
    const busy = await startFakeModel(({ messages }) => {
      seen.push(JSON.stringify(messages.filter((m) => m.role === "user").map((m) => m.content)));
      return { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] };
    });
    const r = await runTrial(
      {
        trialId: "t-budget",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 600_000,
        maxTurns: 14,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: busy.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: async () => {
          throw new Error("not expected");
        },
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await busy.close();
    assert.equal(r.stopped, "turns");
    // The call the limit aborted ends as one more turn.
    assert.ok(r.turns >= 14 && r.turns <= 15, String(r.turns));
    assert.equal(r.error, "the trial reached its limit of 14 turns before a submission");
    assert.match(seen[0] ?? "", /lasts 10 minutes and at most 14 turns/);
    const warnedAt = seen.findIndex((u) => u.includes("turns are left in this trial"));
    assert.equal(warnedAt, 4, "warned once, after turn 4 (10 turns before the limit)");
    assert.equal(seen.at(-1)?.split("turns are left").length, 2, "only once");
  });

  test("without a configured cap a trial is not cut off by its number of turns", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.currentChampion("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    let first = "";
    // 70 turns of reading (past the old default of 60), then the change and a submission.
    const long = await startFakeModel(({ messages }) => {
      first ||= JSON.stringify(messages.find((m) => m.role === "user")?.content ?? "");
      const done = messages.filter((m) => m.role === "tool").length;
      if (done < 70) return { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] };
      if (done === 70)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (done === 71)
        return {
          toolCalls: [{ name: "submit", args: { hypothesis: "less work", known_flaws: [] } }],
        };
      return { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t-long",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 600_000,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: long.url,
          model: "test",
          apiKey: "k",
          contextWindow: 200000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await long.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    assert.ok(r.turns > 70, String(r.turns));
    assert.match(first, /This trial lasts 10 minutes\. Submit before it ends/);
    assert.doesNotMatch(first, /turns/);
  });

  test("the live view: a worker's turns stream out, and the owner's message arrives as a user turn", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.currentChampion("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    let sawOwner = false;
    const fake = await startFakeModel(({ messages }) => {
      sawOwner ||= messages.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("use the fast kernel"),
      );
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0)
        return {
          text: "Reading first.",
          toolCalls: [{ name: "read_file", args: { path: "src/kernel/work.mjs" } }],
        };
      if (!sawOwner) return { text: "Still thinking." };
      if (done === 1)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      return {
        toolCalls: [{ name: "submit", args: { hypothesis: "as the owner said", known_flaws: [] } }],
      };
    });
    const lines: { kind: string; text: string }[] = [];
    let pending = ["use the fast kernel"];
    const r = await runTrial(
      {
        trialId: "t-live",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "Make work() faster without changing its result.",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "test",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        link: {
          live: async (entries) => {
            lines.push(...entries);
          },
          messages: async () => {
            const m = pending;
            pending = [];
            return m;
          },
        },
      },
    );
    await fake.close();
    assert.ok(sawOwner, "the model saw the owner's message");
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    const kinds = new Set(lines.map((l) => l.kind));
    for (const k of ["text", "tool", "result", "message"]) assert.ok(kinds.has(k), `a ${k} line`);
    assert.ok(lines.some((l) => l.kind === "tool" && l.text.startsWith("read_file")));
  });

  test("tool calls run one at a time, and nothing runs after a submission in the same turn", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.currentChampion("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    // Turn 1 writes and checks in one batch; turn 2 submits and then tries to write again.
    const fake = await startFakeModel(({ messages }) => {
      const done = messages.filter((m) => m.role === "tool").length;
      if (done === 0) {
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
            { name: "run", args: { command: "grep -c . src/kernel/work.mjs" } },
          ],
        };
      }
      if (done === 2) {
        return {
          toolCalls: [
            { name: "submit", args: { hypothesis: "faster" } },
            { name: "submit", args: { hypothesis: "again" } },
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: "late" } },
          ],
        };
      }
      return { text: "done" };
    });
    const r = await runTrial(
      {
        trialId: "t2",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "b",
        wallMs: 60_000,
        maxTurns: 20,
      },
      {
        runner,
        laneTool,
        model: {
          baseUrl: fake.url,
          model: "t",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", JSON.stringify(r));
    const n = env.ledger.db.prepare("select count(*) as n from attempt").get();
    assert.equal(Number(n?.n), 1, "one submission");
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(`${ws.repo}/src/kernel/work.mjs`, "utf8"), FAST_KERNEL);
  });

  test("a worker's lane work goes through the API: its own lane, its own workspace, tool or shell only", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: env.seed,
      lane: "lane-1",
    });
    const { Registry } = await import("./registry.ts");
    const { createHarnessApi } = await import("../api.ts");
    new Registry(env.ledger).startTrial({
      id: "t-lane",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "lane-token",
    });
    env.service.trialWorkspaces.set("t-lane", { lane: "lane-1", repo: ws.repo, root: ws.dir });
    const api = createHarnessApi(env.service, { supervisor: "s" }, { lanes: { runner, laneTool } });
    const run = (body: Record<string, unknown>) =>
      api.request("/v1/lane/run", {
        method: "POST",
        headers: { authorization: "Bearer trial.lane-token", "content-type": "application/json" },
        body: JSON.stringify({ role: "lane-1", cwd: ws.repo, timeoutMs: 20_000, ...body }),
      });
    const ok = await run({
      argv: ["lanetool", "read", JSON.stringify({ path: "src/kernel/work.mjs" })],
    });
    assert.equal(ok.status, 200);
    assert.match(((await ok.json()) as { stdout: string }).stdout, /"ok":true/);
    const shell = await run({ argv: ["sh", "-c", "echo hi"] });
    assert.match(((await shell.json()) as { stdout: string }).stdout, /hi/);
    assert.equal((await run({ argv: ["node", "-e", "1"] })).status, 401, "only tool or shell");
    assert.equal((await run({ role: "lane-2", argv: ["sh", "-c", "id"] })).status, 401, "own lane");
    assert.equal(
      (await run({ cwd: `${ws.dir}/../..`, argv: ["sh", "-c", "ls"] })).status,
      401,
      "own workspace",
    );
    env.service.trialWorkspaces.delete("t-lane");
    assert.equal((await run({ argv: ["sh", "-c", "echo"] })).status, 404);
  });

  test("lane commands and dev runs are held to the contract's lane limits", async () => {
    const env = makeJudgeEnv({
      contract: {
        lanes: {
          count: 2,
          trials_per_epoch: 1,
          limits: {
            run_timeout_s: 30,
            run_rss_mib: 512,
            workspace_mib: 1024,
            dev_run_timeout_s: 45,
          },
        },
      },
    });
    await env.service.applyCommand(env.assign);
    const inner = new LocalRunner(env.paths.scratchDir);
    const seen: {
      timeoutMs: number;
      rssLimitBytes?: number;
      disk?: { limitBytes: number };
      env?: Record<string, string>;
    }[] = [];
    const runner = Object.assign(Object.create(inner), {
      run: (req: Parameters<LocalRunner["run"]>[0]) => {
        seen.push(req);
        return inner.run(req);
      },
    }) as LocalRunner;
    const ws = await prepareWorkspace({
      runner: inner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: env.seed,
      lane: "lane-1",
    });
    const { Registry } = await import("./registry.ts");
    const { createHarnessApi } = await import("../api.ts");
    new Registry(env.ledger).startTrial({
      id: "t-lim",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "lim-token",
    });
    env.service.trialWorkspaces.set("t-lim", { lane: "lane-1", repo: ws.repo, root: ws.dir });
    const devRequests: { input: { timeout_s: number }; limits: unknown }[] = [];
    const devRuns = {
      run: async (input: unknown, _trial: string, limits?: unknown) => {
        devRequests.push({ input: input as { timeout_s: number }, limits });
        return { ran: true };
      },
    };
    const api = createHarnessApi(
      env.service,
      { supervisor: "s" },
      { lanes: { runner, laneTool }, devRuns },
    );
    const headers = { authorization: "Bearer trial.lim-token", "content-type": "application/json" };
    const r = await api.request("/v1/lane/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        role: "lane-1",
        cwd: ws.repo,
        argv: ["sh", "-c", "true"],
        timeoutMs: 3_600_000,
        rssLimitBytes: 64 * 1024 ** 3,
        disk: { path: ws.dir, limitBytes: 64 * 1024 ** 3 },
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(seen.at(-1)?.timeoutMs, 30_000);
    assert.equal(seen.at(-1)?.rssLimitBytes, 512 * 1024 ** 2);
    assert.equal(seen.at(-1)?.disk?.limitBytes, 1024 * 1024 ** 2);
    // The lane's cache: created with its first workspace, kept across trials, named to its commands.
    const cache = `${env.paths.scratchDir}/lanes/lane-1/cache`;
    assert.ok(existsSync(cache));
    assert.equal(seen.at(-1)?.env?.CCACHE_DIR, cache);
    assert.equal(seen.at(-1)?.env?.THERMITE_LANE_CACHE, cache);
    const d = await api.request("/v1/dev-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "true", cwd: ws.repo, timeout_s: 3600 }),
    });
    assert.equal(d.status, 200);
    assert.equal(devRequests.at(-1)?.input.timeout_s, 45);
    assert.deepEqual(devRequests.at(-1)?.limits, { rssMib: 4096, diskMib: 1024 });
  });

  test("the isolation selftest refuses a rig with open trials or judge jobs", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const { busyReason } = await import("../selftest.ts");
    const { Registry } = await import("./registry.ts");
    const jobs = Number(
      (
        env.ledger.db
          .prepare("select count(*) as n from job where state in ('queued','leased')")
          .get() as { n: number }
      ).n,
    );
    if (!jobs) assert.equal(busyReason(env.paths.stateDir), undefined);
    new Registry(env.ledger).startTrial({
      id: "t-busy",
      run: "js-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token: "busy-token",
    });
    assert.match(String(busyReason(env.paths.stateDir)), /1 open trial/);
  });

  test("the lane tool never leaves the workspace", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: env.seed,
      lane: "lane-1",
    });
    const tool = async (op: string, args: unknown, stdin?: string) =>
      JSON.parse(
        (
          await runner.run({
            role: "lane-1",
            argv: [...laneTool, op, JSON.stringify(args)],
            cwd: ws.repo,
            timeoutMs: 20_000,
            ...(stdin ? { stdin } : {}),
          })
        ).stdout,
      );
    assert.equal((await tool("read", { path: "../../../../etc/hosts" })).ok, false);
    assert.equal((await tool("write", { path: "/tmp/escape" }, "x")).ok, false);
    assert.equal((await tool("read", { path: "src/kernel/work.mjs" })).ok, true);
  });
});
