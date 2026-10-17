#!/usr/bin/env node
// M4 agents acceptance under compose, with a scripted OpenAI-compatible model on the host (the
// real model route is not needed to check the machinery). One epoch on the smoke campaign:
//   - the planner plans through the model and the plan is valid;
//   - each lane's worker runs in its own process, edits its workspace as the lane's user through
//     the broker, builds with the shell tool, uses dev_run, and submits once;
//   - the judge decides both submissions; control reports the agents' figures;
//   - a lane's background work runs on across its commands and a dev run, as in a shell;
//   - no lane process outlives its trial;
//   - control's model check reaches the model through the rig's route with a correct tool call.
// Usage: COMPOSE="podman compose" node scripts/agents-acceptance.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  api,
  assign,
  command,
  control,
  dc,
  events,
  latestVerdicts,
  lifecycles,
  prepare,
  rigCheck,
  secret,
  sleep,
  until,
} from "./lib/smoke-env.mjs";

const GOOD = readFileSync("kits/smoke-cpu/candidates/good/src/kernel/matmul.c", "utf8");
const NOOP = readFileSync("kits/smoke-cpu/candidates/noop/src/kernel/matmul.c", "utf8");
let requests = 0;
const setid = {};
const background = {};

/** A dashboard session: sign in with the admin token, keep the cookie, post forms. */
async function dashboard() {
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const page = async (path) => (await fetch(`${control}${path}`, { headers: { cookie } })).text();
  const post = async (path, form) =>
    (
      await fetch(`${control}${path}`, {
        method: "POST",
        body: new URLSearchParams(form),
        headers: { cookie },
        redirect: "manual",
      })
    ).status;
  return { page, post };
}

/** The scripted model: plans with submit_plan; lane-1 improves the kernel, lane-2 restates it. */
function script(messages, tools) {
  const names = tools.map((t) => t.function.name);
  // OpenCode (its own tools, shell among them): its model check, then a trial that edits the
  // kernel and submits with thermite-trial. A request without tools names the session.
  if (names.includes("shell") && names.includes("execute")) {
    if (messages.some((m) => m.role === "tool")) return { text: "done" };
    const asked = JSON.stringify(messages);
    const word = /run exactly this command: echo (thermite-[a-z0-9]+)/.exec(asked)?.[1];
    if (word) return { toolCalls: [{ name: "shell", args: { command: `echo ${word}` } }] };
    return {
      toolCalls: [
        {
          name: "shell",
          args: {
            command:
              "printf '\\n/* tidied */\\n' >> src/kernel/matmul.c && thermite-trial submit --hypothesis 'opencode harness: a tidied kernel'",
            timeout: 0,
          },
        },
      ],
    };
  }
  if (!tools.length) return { text: "A Thermite trial" };
  // The rig's model check: echo back the word it was given.
  if (tools.some((t) => t.function.name === "echo")) {
    if (messages.some((m) => m.role === "tool")) return { text: "done" };
    const word = /the word (\S+)\./.exec(JSON.stringify(messages))?.[1] ?? "";
    return { toolCalls: [{ name: "echo", args: { word } }] };
  }
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
        // Background work outlives the command that started it (and the dev run below); the
        // trial's end takes it.
        {
          name: "run",
          args: { command: 'sleep 900 > /dev/null 2>&1 & echo $! > bg.pid; echo "BG-STARTED yes"' },
        },
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
          name: "run",
          args: {
            command:
              'if kill -0 "$(cat bg.pid)" 2>/dev/null; then echo "BG-ALIVE yes"; else echo "BG-ALIVE no"; fi',
          },
        },
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

/** The keys the model was asked with (a route set on control's settings page brings its own). */
const keysSeen = new Set();
const model = createServer((req, res) => {
  keysSeen.add(String(req.headers.authorization ?? ""));
  let body = "";
  req.on("data", (d) => {
    body += d;
  });
  req.on("end", () => {
    // The provider's model list, as control reads it.
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "scripted", context_length: 32768 }] }));
      return;
    }
    requests++;
    const p = JSON.parse(body);
    for (const m of p.messages ?? []) {
      for (const hit of JSON.stringify(m.content ?? "").matchAll(/SETID-(BEFORE|AFTER) (\S+)/g))
        setid[hit[1]] = hit[2];
      for (const hit of JSON.stringify(m.content ?? "").matchAll(/BG-(STARTED|ALIVE) (yes|no)/g))
        background[hit[1]] = hit[2];
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
  THERMITE_MODEL_BASE_URL: `http://${hostName}:${port}/v1`,
  THERMITE_MODEL: "scripted",
  THERMITE_MAX_TRIALS: "2",
  THERMITE_MODEL_ROUTE_POLL_SECONDS: "2",
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
  const modelCheck = await rigCheck("model");
  check(
    "control's model check: a correct tool call through the rig's route",
    modelCheck.ok === true,
    {
      summary: modelCheck.summary,
      detail: modelCheck.detail,
    },
  );
  // A provider entered on control's settings page: control lists its models, the rig takes one,
  // and its model check goes through it with the provider's own key. The key shows nowhere.
  const providerKey = "provider-key-acceptance-0001";
  const ui = await dashboard();
  const settings = await ui.page("/ui/settings");
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(settings)?.[1] ?? "";
  await ui.post("/ui/settings/providers", {
    csrf,
    name: "scripted-provider",
    type: "openai",
    base_url: `http://${hostName}:${port}/v1`,
    api_key: providerKey,
  });
  const listed = await ui.page("/ui/settings");
  await ui.post("/ui/settings/rigs", {
    csrf,
    rig: "local-1",
    choice: "scripted-provider|scripted",
  });
  const taken = await until("the rig takes the provider's model", async () => {
    const m = (await api("/v1/rigs/local-1/view")).body.model;
    return m?.source === "control" && m.name === "scripted-provider" ? m : undefined;
  });
  keysSeen.clear();
  const routeCheck = await rigCheck("model");
  const pages = [await ui.page("/ui/settings"), await ui.page("/ui/rigs/local-1")].join("");
  check(
    "a provider from the settings page lists its models, reaches the rig and its model, and its key shows nowhere",
    /1 model/.test(listed) &&
      routeCheck.ok === true &&
      keysSeen.has(`Bearer ${providerKey}`) &&
      !pages.includes(providerKey) &&
      !JSON.stringify(await events()).includes(providerKey),
    { taken, summary: routeCheck.summary, keys: keysSeen.size },
  );
  // The OpenCode harness with the same provider: OpenCode runs as the lane, submits with
  // thermite-trial, and reaches the provider only through the harness's proxy, which adds the key.
  await ui.post("/ui/settings/rigs", {
    csrf,
    rig: "local-1",
    choice: "scripted-provider|scripted",
    harness: "opencode",
  });
  await until("the rig runs the model under OpenCode", async () => {
    const m = (await api("/v1/rigs/local-1/view")).body.model;
    return m?.source === "control" && m.harness === "opencode" ? m : undefined;
  });
  keysSeen.clear();
  const ocCheck = await until(
    "OpenCode's model check (run when the rig took the route)",
    async () =>
      (await events()).find(
        (e) => e.kind === "rig_check_finished" && e.body.detail?.harness === "opencode",
      ),
    300_000,
    2000,
  );
  const ocAttempt = await until(
    "a trial under OpenCode submitted",
    async () =>
      (await events()).find(
        (e) =>
          e.kind === "attempt_recorded" && /opencode harness/.test(String(e.body.hypothesis ?? "")),
      ),
    600_000,
    3000,
  );
  check(
    "OpenCode runs the check and a trial as the lane, submits with thermite-trial, and reaches the provider only through the proxy",
    ocCheck.body.ok === true &&
      ocAttempt !== undefined &&
      keysSeen.has(`Bearer ${providerKey}`) &&
      ![...keysSeen].some((k) => /Bearer (trial|proxy)\./.test(k)),
    {
      check: ocCheck.body.summary,
      attempt: ocAttempt?.subject,
      lane: ocAttempt?.body.lane,
      keys: [...keysSeen].map((k) => k.slice(0, 16)),
    },
  );
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
    "a lane's background process ran on across its commands and a dev run",
    background.STARTED === "yes" && background.ALIVE === "yes",
    background,
  );
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
