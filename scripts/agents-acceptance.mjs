#!/usr/bin/env node
// M4 agents acceptance under compose, with a scripted OpenAI-compatible model on the host (the
// real model route is not needed to check the machinery). One epoch on the smoke campaign:
//   - the planner plans through the model and the plan is valid;
//   - each lane's worker runs in its own process, edits its workspace as the lane's user through
//     the broker, builds with the shell tool, uses dev_run, and submits once;
//   - the judge decides both submissions; control reports the agents' figures;
//   - no lane process outlives its trial.
// Usage: COMPOSE="podman compose" node scripts/agents-acceptance.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  api,
  assign,
  command,
  dc,
  events,
  latestVerdicts,
  lifecycles,
  prepare,
  sleep,
  until,
} from "./lib/smoke-env.mjs";

const GOOD = readFileSync("kits/smoke-cpu/candidates/good/src/kernel/matmul.c", "utf8");
const NOOP = readFileSync("kits/smoke-cpu/candidates/noop/src/kernel/matmul.c", "utf8");
let requests = 0;
const setid = {};

/** The scripted model: plans with submit_plan; lane-1 improves the kernel, lane-2 restates it. */
function script(messages, tools) {
  if (tools.some((t) => t.function.name === "submit_plan")) {
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
              {
                lane: "lane-2",
                family: "loop-order",
                focus: "tidy the kernel",
                parent: "champion",
              },
            ],
          },
        },
      ],
    };
  }
  const brief = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
  const lane1 = brief.includes("lane-1");
  const done = messages.filter((m) => m.role === "tool").length;
  const steps = lane1
    ? [
        { name: "list_files", args: {} },
        { name: "read_file", args: { path: "src/kernel/matmul.c" } },
        { name: "write_file", args: { path: "src/kernel/matmul.c", content: GOOD } },
        {
          name: "run",
          args: {
            command:
              "cc -O2 -std=c11 -Iinclude -c src/kernel/matmul.c -o /tmp/k.o || cc -O2 -std=c11 -Iinclude -c src/kernel/matmul.c -o k.o",
          },
        },
        // A setgid file left in the workspace must lose its bit once the run ends (the broker
        // clears set-id bits after every lane run).
        {
          name: "run",
          args: {
            command: 'cp /bin/true sg && chmod g+s sg && echo "SETID-BEFORE $(stat -c %A sg)"',
          },
        },
        { name: "run", args: { command: 'echo "SETID-AFTER $(stat -c %A sg)"; rm -f sg' } },
        { name: "dev_run", args: { command: "cc --version | head -1" } },
        {
          name: "submit",
          args: { hypothesis: "i-k-j loop order makes the inner loop contiguous" },
        },
      ]
    : [
        { name: "write_file", args: { path: "src/kernel/matmul.c", content: NOOP } },
        { name: "submit", args: { hypothesis: "restate the kernel" } },
      ];
  return steps[done] ? { toolCalls: [steps[done]] } : { text: "done" };
}

const model = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => {
    body += d;
  });
  req.on("end", () => {
    requests++;
    const p = JSON.parse(body);
    for (const m of p.messages ?? []) {
      for (const hit of JSON.stringify(m.content ?? "").matchAll(/SETID-(BEFORE|AFTER) (\S+)/g))
        setid[hit[1]] = hit[2];
    }
    const turn = script(p.messages ?? [], p.tools ?? []);
    const id = `c${requests}`;
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: p.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ role: "assistant", content: turn.text ?? "" }, null));
    for (const [i, t] of (turn.toolCalls ?? []).entries()) {
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: i,
                id: `${id}_${i}`,
                type: "function",
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              },
            ],
          },
          null,
        ),
      );
    }
    res.write(chunk({}, turn.toolCalls?.length ? "tool_calls" : "stop"));
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: p.model, choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => model.listen(0, "0.0.0.0", r));
const port = model.address().port;
const hostName = (process.env.COMPOSE ?? "podman compose").startsWith("docker")
  ? "host.docker.internal"
  : "host.containers.internal";

const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_PROMOTION: "auto",
  THERMITE_CALIBRATION_BLOCKS: "0",
  QWEN_BASE_URL: `http://${hostName}:${port}/v1`,
  QWEN_MODEL: "scripted",
  THERMITE_MAX_TRIALS: "2",
};
const report = {
  started_at: new Date().toISOString(),
  compose: process.env.COMPOSE ?? "podman compose",
  checks: [],
};
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`}`,
  );
};

const env = prepare();
// One epoch of one trial per lane, two lanes.
const contract = JSON.parse(readFileSync(env.contractFile, "utf8"));
contract.lanes = { count: 2, trials_per_epoch: 1 };
writeFileSync(env.contractFile, JSON.stringify(contract));
dc(composeEnv, "up", "-d", "--build");
let failed = false;
try {
  await until("control health", async () => (await fetch("http://127.0.0.1:8800/v1/health")).ok);
  await assign(env, "smoke-1");
  const evs = await until(
    "both lanes judged",
    async () => {
      const all = await events();
      const trials = all.filter(
        (e) => e.kind === "trial_finished" && e.body.attempt && e.body.epoch === 1,
      );
      // Settled: judged to the end (a screened win also has to finish its confirmation).
      const life = lifecycles(all);
      const settled = [
        "judged",
        "promoted",
        "rejected_v0",
        "duplicate",
        "errored",
        "awaiting_approval",
      ];
      return trials.length >= 2 && trials.every((t) => settled.includes(life[t.body.attempt]))
        ? all
        : undefined;
    },
    1_200_000,
    3000,
  );
  const epoch = evs.find((e) => e.kind === "epoch_started");
  check(
    "the planner planned the epoch through the model, validly",
    epoch?.body.source === "planner" && epoch?.body.planner_valid === true,
    epoch?.body,
  );
  const trials = evs.filter((e) => e.kind === "trial_finished" && e.body.epoch === 1);
  check(
    "each lane's worker submitted once",
    trials.filter((t) => t.body.stopped === "submitted").length === 2,
    trials.map((t) => [t.body.lane, t.body.stopped]),
  );
  const verdicts = latestVerdicts(evs);
  const byLane = Object.fromEntries(trials.map((t) => [t.body.lane, verdicts[t.body.attempt]]));
  check("lane-1's better kernel was confirmed", byLane["lane-1"] === "win_confirmed", byLane);
  check(
    "lane-2's restated kernel was not a win",
    ["neutral", "inconclusive", "regress"].includes(byLane["lane-2"]),
    byLane,
  );
  check(
    "dev_run ran on the device",
    evs.some((e) => e.kind === "dev_run"),
    evs.filter((e) => e.kind === "dev_run").map((e) => e.body),
  );
  const view = (await api("/v1/rigs/local-1/view")).body;
  const agents = view.runs[0].agents;
  check(
    "control reports the agents' figures",
    agents.epochs >= 1 && agents.planner_valid >= 1 && agents.trials >= 2 && agents.tokens_in > 0,
    agents,
  );
  // Later epochs keep starting trials: pause, then every lane and agent process must end with
  // its trial.
  await command("pause_run", { run: "smoke-1", reason: "acceptance: drain" });
  const roleProcesses = () =>
    JSON.parse(
      dc(
        composeEnv,
        "exec",
        "-T",
        "harness",
        "node",
        "-e",
        `const fs=require("fs");const n=[];for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const u=Number(/^Uid:\\s+(\\d+)/m.exec(fs.readFileSync("/proc/"+p+"/status","utf8"))[1]);if(u>10100&&u<10317)n.push(p)}catch{}}process.stdout.write(JSON.stringify(n))`,
      ),
    );
  const lanes = await until(
    "lane and agent processes ended",
    async () => {
      const n = roleProcesses();
      return n.length === 0 ? n : undefined;
    },
    300_000,
    3000,
  ).catch(() => roleProcesses());
  check("no lane or agent process outlives its trial", lanes.length === 0, lanes);
  check(
    "a setgid file a lane made lost its bit after the run",
    /^-.....s/.test(setid.BEFORE ?? "") && /^-.....x/.test(setid.AFTER ?? ""),
    setid,
  );
  check("the model was asked (planner and workers)", requests >= 11, requests);
} catch (err) {
  failed = true;
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  report.finished_at = new Date().toISOString();
  report.ok = !failed && report.checks.every((c) => c.ok);
  mkdirSync(join(".dev", "acceptance"), { recursive: true });
  const file = join(".dev", "acceptance", `m4-${report.started_at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  if (process.env.KEEP !== "1") dc(composeEnv, "down", "-v");
  model.close();
  console.log(report.ok ? "agents acceptance: OK" : "agents acceptance: FAILED");
  if (!report.ok) process.exitCode = 1;
}
await sleep(0);
