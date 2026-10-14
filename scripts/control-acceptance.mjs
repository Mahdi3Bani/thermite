#!/usr/bin/env node
// M3 control acceptance under compose, with two local units (the "two-units" profile). It checks
// the plan's M3 verify list:
//   - assign a campaign to each unit; pause, resume, reset workers and redirect from the dashboard
//     and from MCP, each taking effect in the harness and logged in control's audit;
//   - with control stopped, units keep researching, and their reports catch up when it returns;
//   - with a supervisor stopped, its harness keeps running, the unit shows stale, then recovers;
//   - control's view of a unit is the same before and after a control restart.
// Usage: COMPOSE="podman compose" node scripts/control-acceptance.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  api,
  assign,
  candidatePatch,
  control,
  dc,
  prepare,
  secret,
  sleep,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_CONTROL_STALE_SECONDS: "10",
  THERMITE_CALIBRATION_BLOCKS: "0",
};
const profile = ["--profile", "two-units"];
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
const dcp = (...args) => dc(composeEnv, ...profile, ...args);
const view = async (unit) => (await api(`/v1/units/${unit}/view`)).body;
const instanceStatus = async (unit, id) =>
  (await view(unit)).instances?.find((i) => i.id === id)?.status;
const harnessEvents = (service, kind) =>
  JSON.parse(
    dc(
      composeEnv,
      ...profile,
      "exec",
      "-T",
      service,
      "node",
      "-e",
      `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/var/lib/thermite/ledger/ledger.db",{readOnly:true});process.stdout.write(JSON.stringify(db.prepare("select id, kind, subject from event where kind = ?").all(${JSON.stringify(kind)})))`,
    ),
  );

/** A dashboard session: log in with the admin token, keep the cookie, post forms with CSRF. */
async function dashboard() {
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const page = async (path) => (await fetch(`${control}${path}`, { headers: { cookie } })).text();
  const post = async (form) => {
    const html = await page(`/ui/units/${form.unit}`);
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
    const r = await fetch(`${control}/ui/commands`, {
      method: "POST",
      body: new URLSearchParams({ ...form, csrf }),
      headers: { cookie },
      redirect: "manual",
    });
    return r.status;
  };
  return { page, post };
}

async function mcp() {
  const client = new Client({ name: "acceptance-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${control}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${secret("control-admin-token")}` } },
    }),
  );
  const call = async (name, args) =>
    JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { client, call };
}

const env = prepare();
console.log("compose: build and start two units");
dcp("up", "-d", "--build");
let failed = false;
try {
  await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);
  await assign(env, "smoke-1", "local-1");
  await assign(env, "smoke-2", "local-2");
  await until(
    "both units reporting",
    async () =>
      (await view("local-1")).instances?.length && (await view("local-2")).instances?.length,
  );
  check("a campaign assigned to each of two units", true);

  // Dashboard commands on unit 1.
  const ui = await dashboard();
  check(
    "dashboard pause accepted",
    (await ui.post({
      unit: "local-1",
      kind: "pause_instance",
      instance: "smoke-1",
      reason: "acceptance",
    })) === 303,
  );
  await until(
    "pause took effect",
    async () => (await instanceStatus("local-1", "smoke-1")) === "paused",
    60_000,
  );
  check("pause from the dashboard took effect in the harness", true);
  await ui.post({ unit: "local-1", kind: "resume_instance", instance: "smoke-1" });
  await until(
    "resume took effect",
    async () => (await instanceStatus("local-1", "smoke-1")) === "running",
    60_000,
  );
  check("resume from the dashboard took effect", true);
  await ui.post({ unit: "local-1", kind: "reset_workers", instance: "smoke-1" });
  await ui.post({
    unit: "local-1",
    kind: "redirect",
    instance: "smoke-1",
    directive: "avoid",
    family: "loop-unrolling",
    rationale: "acceptance test",
  });
  await until(
    "reset and redirect reached the harness",
    async () => {
      const kinds = (await api("/v1/units/local-1/events?after=0&limit=5000")).body.events.map(
        (e) => e.kind,
      );
      return kinds.includes("workers_reset") && kinds.includes("directive");
    },
    60_000,
  );
  check("reset workers and redirect from the dashboard took effect", true);

  // MCP commands on unit 2.
  const agent = await mcp();
  const units = await agent.call("list_units", {});
  check(
    "MCP lists both units",
    units
      .map((u) => u.unit)
      .sort()
      .join() === "local-1,local-2",
    units.map((u) => u.unit),
  );
  await agent.call("issue_command", {
    unit: "local-2",
    kind: "pause_instance",
    payload: { instance: "smoke-2", reason: "an agent paused it" },
  });
  await until(
    "MCP pause took effect",
    async () => (await instanceStatus("local-2", "smoke-2")) === "paused",
    60_000,
  );
  await agent.call("issue_command", {
    unit: "local-2",
    kind: "resume_instance",
    payload: { instance: "smoke-2" },
  });
  await until(
    "MCP resume took effect",
    async () => (await instanceStatus("local-2", "smoke-2")) === "running",
    60_000,
  );
  await agent.call("issue_command", {
    unit: "local-2",
    kind: "redirect",
    payload: {
      instance: "smoke-2",
      directives: [{ kind: "try", family: "tiling", rationale: "acceptance", citations: [] }],
    },
  });
  await agent.call("issue_command", {
    unit: "local-2",
    kind: "reset_workers",
    payload: { instance: "smoke-2" },
  });
  await until(
    "MCP reset and redirect reached the harness",
    async () => {
      const kinds = (await api("/v1/units/local-2/events?after=0&limit=5000")).body.events.map(
        (e) => e.kind,
      );
      return kinds.includes("workers_reset") && kinds.includes("directive");
    },
    60_000,
  );
  check("pause, resume, redirect and reset from MCP took effect", true);
  await agent.client.close();

  const audit = (await api("/v1/audit?limit=500")).body.audit.map((a) => `${a.actor} ${a.action}`);
  check(
    "dashboard and MCP actions are in the audit log",
    audit.some((a) => a.startsWith("owner:ui command_issued") || a.includes("owner:ui")) &&
      audit.some((a) => a.includes("mcp:issue_command")),
    audit.slice(0, 8),
  );
  const commands = (await api("/v1/commands?limit=100")).body.commands;
  check(
    "every command was delivered",
    commands.every((c) => c.status === "delivered"),
    commands.map((c) => `${c.kind}:${c.status}`),
  );

  // Control down: units keep researching; reports catch up afterwards.
  const before = await view("local-1");
  dcp("stop", "control");
  const attempt = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/broken"),
    "judged while control is down",
  ).attempt;
  await until(
    "judged in the harness without control",
    async () => harnessEvents("harness", "verdict").some((e) => e.subject === attempt),
    600_000,
    3000,
  );
  check("with control stopped, the unit kept researching", true);
  dcp("start", "control");
  await until("control back", async () => (await fetch(`${control}/v1/health`)).ok);
  await until(
    "reports caught up",
    async () =>
      (await view("local-1")).instances?.[0]?.attempts?.some((a) => a.id === attempt && a.verdict),
    120_000,
  );
  check("after control returned, the reports caught up", true);
  const after = await view("local-1");
  const strip = (v) =>
    JSON.stringify({
      ...v,
      last_seen: null,
      stale: null,
      recent: null,
      summary: null,
      jobs: null,
      // The supervisor's live figures (timestamps, counters) are not part of the event view.
      supervisor: null,
      instances: v.instances.map((i) => ({
        ...i,
        // The attempt judged while control was down is new; everything else must match.
        attempts: i.attempts.filter((a) => a.id !== attempt),
        agents: {
          ...i.agents,
          attempts: i.agents.attempts - i.attempts.filter((a) => a.id === attempt).length,
        },
        verdicts: Object.fromEntries(
          Object.entries(i.verdicts)
            .map(([k, n]) => [
              k,
              n -
                i.attempts.filter((a) => a.id === attempt && (a.verdict ?? a.lifecycle) === k)
                  .length,
            ])
            .filter(([, n]) => n > 0),
        ),
      })),
    });
  /** Paths where two JSON values differ (for the report when they do). */
  const diff = (a, b, path = "") => {
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    if (a && b && typeof a === "object" && typeof b === "object") {
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
        diff(a[k], b[k], `${path}.${k}`),
      );
    }
    return [`${path}: ${JSON.stringify(a)?.slice(0, 120)} -> ${JSON.stringify(b)?.slice(0, 120)}`];
  };
  check(
    "control's view is the same after its restart (apart from the new attempt)",
    strip(before) === strip(after),
    diff(JSON.parse(strip(before)), JSON.parse(strip(after))).slice(0, 10),
  );

  // Supervisor down: the harness keeps running; the unit goes stale, then recovers.
  dcp("stop", "supervisor-2");
  await until("unit 2 stale", async () => (await view("local-2")).stale === true, 60_000);
  const health = dc(
    composeEnv,
    ...profile,
    "exec",
    "-T",
    "harness-2",
    "node",
    "-e",
    "fetch('http://127.0.0.1:8700/v1/health').then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify(j)))",
  );
  check(
    "with its supervisor stopped, the harness keeps running and the unit shows stale",
    JSON.parse(health).ok === true,
    JSON.parse(health),
  );
  dcp("start", "supervisor-2");
  await until("unit 2 fresh again", async () => (await view("local-2")).stale === false, 60_000);
  check("the unit recovers when its supervisor returns", true);
} catch (err) {
  failed = true;
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  report.finished_at = new Date().toISOString();
  report.ok = !failed && report.checks.every((c) => c.ok);
  mkdirSync(join(".dev", "acceptance"), { recursive: true });
  const file = join(".dev", "acceptance", `m3-${report.started_at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  if (process.env.KEEP !== "1") dcp("down", "-v");
  console.log(report.ok ? "control acceptance: OK" : "control acceptance: FAILED");
  if (!report.ok) process.exitCode = 1;
}
await sleep(0);
