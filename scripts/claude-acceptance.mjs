#!/usr/bin/env node
// Claude Code acceptance under compose, with a stand-in for Claude Code mounted in the harness
// (containers/test-claude; no subscription and no download needed). Through the dashboard: a
// Claude subscription added in Providers, its model given to the rig (in Claude Code), then:
//   - the rig takes the route; its model check runs one Bash call through Claude Code;
//   - the planner plans through Claude Code, with no tools;
//   - a worker trial runs Claude Code as the lane's user, with the token in Claude Code's
//     environment and the safety flags, edits the code and submits with thermite-trial;
//   - the subscription's usage windows reach the Providers page;
//   - the token shows in no page, event or record.
// Usage: COMPOSE="podman compose" node scripts/claude-acceptance.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { api, assign, control, dc, events, prepare, secret, until } from "./lib/smoke-env.mjs";

const TOKEN = "sk-ant-oat01-acceptance-stand-in-token-0000"; // public-check: allow (a made-up token for the stand-in)
const files = ["-f", "compose.yaml", "-f", "containers/test-claude/compose.yaml"];
const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_PROMOTION: "auto",
  THERMITE_CALIBRATION_BLOCKS: "0",
  THERMITE_MAX_TRIALS: "1",
  THERMITE_MODEL_ROUTE_POLL_SECONDS: "2",
};
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 400)}`}`,
  );
};

const env = prepare();
const contract = JSON.parse(readFileSync(env.contractFile, "utf8"));
contract.lanes = { count: 1, trials_per_epoch: 1 };
writeFileSync(env.contractFile, JSON.stringify(contract));
dc(composeEnv, ...files, "up", "-d", "--build");
try {
  await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);
  await until("the rig reports", async () => (await api("/v1/rigs/local-1/view")).body?.hardware);
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const page = async (path) => (await fetch(`${control}${path}`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/settings"))?.[1] ?? "";
  const post = async (path, form) =>
    decodeURIComponent(
      String(
        (
          await fetch(`${control}${path}`, {
            method: "POST",
            body: new URLSearchParams({ csrf, ...form }),
            headers: { cookie },
            redirect: "manual",
          })
        ).headers.get("location"),
      ),
    );
  const added = await post("/ui/settings/add", {
    type: "claude",
    name: "claude-test",
    claude_token: TOKEN,
  });
  check("a Claude subscription is added in Providers", /"claude-test" is saved/.test(added), added);
  await post("/ui/settings/rigs", {
    rig: "local-1",
    harness: "pi",
    choice: `claude-test|${encodeURIComponent("opus-5.5[1m]")}`,
  });
  const model = await until("the rig runs its agents in Claude Code", async () => {
    const m = (await api("/v1/rigs/local-1/view")).body.model;
    return m?.source === "control" && m.harness === "claude-code" ? m : undefined;
  });
  check(
    "the rig took the subscription's model in Claude Code",
    model.model === "claude-opus-5-5",
    model,
  );
  const modelCheck = await until(
    "the model check through Claude Code",
    async () =>
      (await events()).find(
        (e) => e.kind === "rig_check_finished" && e.body.detail?.harness === "claude-code",
      ),
    300_000,
    2000,
  );
  check(
    "the model check ran one Bash call through Claude Code",
    modelCheck.body.ok === true,
    modelCheck.body.summary,
  );
  await assign(env, "smoke-1");
  const epoch = await until(
    "the first epoch, planned",
    async () => (await events()).find((e) => e.kind === "epoch_started" && e.subject === "smoke-1"),
    300_000,
    2000,
  );
  check(
    "the planner planned through Claude Code, with no tools",
    epoch.body.source === "planner" &&
      epoch.body.planner_valid === true &&
      epoch.body.assignments?.[0]?.family === "cc-tidy",
    {
      source: epoch.body.source,
      valid: epoch.body.planner_valid,
      assignments: epoch.body.assignments,
    },
  );
  const attempt = await until(
    "a trial in Claude Code submitted",
    async () =>
      (await events()).find(
        (e) =>
          e.kind === "attempt_recorded" &&
          /claude code harness/.test(String(e.body.hypothesis ?? "")),
      ),
    600_000,
    3000,
  );
  const said = String(attempt.body.hypothesis);
  check(
    "Claude Code ran as the lane's user with the token in its environment and no settings or MCP, and submitted with thermite-trial",
    /uid=10101 /.test(said) &&
      /token=set /.test(said) &&
      /scrub=1 /.test(said) &&
      /strict_mcp=true /.test(said) &&
      /no_settings=true /.test(said) &&
      /model=claude-opus-5-5\)/.test(said),
    said,
  );
  const trial = await until(
    "the Claude Code trial's end, with its turns",
    async () =>
      (await events()).find(
        (e) => e.kind === "trial_finished" && e.body.attempt === attempt.subject,
      ),
    120_000,
    2000,
  );
  check(
    "the controller followed Claude Code's output (turns counted)",
    Number(trial.body.turns) >= 1,
    trial.body,
  );
  const providers = await until(
    "the subscription's usage on the Providers page",
    async () => {
      const p = await page("/ui/settings");
      return /42% used/.test(p) ? p : undefined;
    },
    120_000,
    2000,
  );
  check(
    "the subscription's 5-hour and weekly windows reach the Providers page",
    /<b>5-hour window<\/b> · 42% used/.test(providers) &&
      /<b>Weekly window<\/b> · 17% used/.test(providers),
  );
  const everything = JSON.stringify([
    providers,
    await page("/ui/rigs/local-1"),
    await events(),
    (await api("/v1/rigs/local-1/view")).body,
  ]);
  check("the token shows in no page, event or rig record", !everything.includes(TOKEN));
} catch (err) {
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  if (process.env.KEEP !== "1") dc(composeEnv, ...files, "down", "-v");
}
const ok = results.every((r) => r.ok);
console.log(`claude acceptance: ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
