import assert from "node:assert/strict";
import { test } from "node:test";
import { promptRecord } from "../../src/agents/prompt.ts";
import { renderWorker, WORKER_PI_SYSTEM } from "../../src/agents/roles/index.ts";
import { laneLimits } from "../../src/core/contract.ts";
import { ADMIN, controlStack, mcpClient, signIn } from "../helpers/control-stack.ts";

const AGENT_TOKEN = "agent-token-abcdef";

test("a prompt kept on a rig reaches control, and REST and MCP show it with its sources (goal 166)", async () => {
  const stack = controlStack({ tokens: { agent: AGENT_TOKEN } });
  const { env, api } = stack;
  await env.start();
  const run = (env.assign.envelope.payload as { run: string }).run;
  const sent = renderWorker({
    program: { id: "pi", name: "Pi", turnWords: "each model reply is one" },
    brief: "# Assignment (epoch 1, trial 1 of 1, lane-1)\nFocus: unroll the loop",
    mcpServers: [],
    limits: laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }),
    editablePaths: ["src/**"],
  });
  const id = env.service.ledger.prompts.record(
    "harness",
    run,
    promptRecord(sent, { lane: "lane-1", trial: "t-1" }),
  );
  await stack.relay(2);

  const list = (await (await api("GET", `/v1/runs/${run}/prompts`)).json()) as {
    rig: string;
    prompts: {
      id: number;
      role: string;
      lane: string;
      sections: { id: string; source: string }[];
    }[];
  };
  assert.equal(list.rig, "rig-a");
  assert.deepEqual(
    list.prompts.map((p) => [p.id, p.role, p.lane]),
    [[id, "worker", "lane-1"]],
  );
  assert.deepEqual(
    list.prompts[0]?.sections.map((s) => `${s.id}:${s.source}`),
    ["instructions:role", "notes-and-sources:role", "brief:assignment", "budget:rig"],
  );
  const one = (await (await api("GET", `/v1/runs/${run}/prompts/${id}`)).json()) as {
    sections: { id: string; text: string | null; from_definition: boolean }[];
  };
  // The role's fixed text from control's own definitions; what the run added, as the rig sent it.
  const instructions = one.sections.find((s) => s.id === "instructions");
  assert.deepEqual([instructions?.text, instructions?.from_definition], [WORKER_PI_SYSTEM, true]);
  assert.match(String(one.sections.find((s) => s.id === "brief")?.text), /unroll the loop/);
  assert.equal((await api("GET", `/v1/runs/${run}/prompts/999`)).status, 404);
  assert.equal((await api("GET", "/v1/runs/no-run/prompts")).status, 404);

  const roles = (await (await api("GET", "/v1/agents")).json()) as { roles: { id: string }[] };
  assert.equal(roles.roles.length, 15);
  const worker = (await (await api("GET", "/v1/agents/worker")).json()) as {
    render: string;
    texts: { id: string; text: string }[];
  };
  assert.equal(worker.render, "renderWorker");
  assert.equal(worker.texts.find((t) => t.id === "pi")?.text, WORKER_PI_SYSTEM);
  assert.equal((await api("GET", "/v1/agents/no-role")).status, 404);
  // A campaign's agents read neither the roles nor the prompts.
  assert.equal((await api("GET", "/v1/agents", undefined, AGENT_TOKEN)).status, 401);

  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const client = await mcpClient(stack.control, token);
    try {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { error: r.isError === true, text: r.content[0]?.text ?? "" };
    } finally {
      await client.close();
    }
  };
  const viaMcp = await call(ADMIN, "agent_prompts", { run, prompt: id });
  assert.equal(viaMcp.error, false);
  assert.match(viaMcp.text, /unroll the loop/);
  assert.match(
    (await call(ADMIN, "agent_roles", { role: "auditor" })).text,
    /"render": "renderAuditor"/,
  );
  const agent = await mcpClient(stack.control, AGENT_TOKEN);
  const names = (await agent.listTools()).tools.map((t) => t.name);
  await agent.close();
  assert.ok(!names.includes("agent_prompts") && !names.includes("agent_roles"), names.join(", "));

  // The dashboard: the Agents page, a role's page, the run's Prompts tab and the prompt itself.
  const { page, get } = await signIn(stack.control);
  assert.match(await page("/ui/agents"), /<a href="\/ui\/agents\/worker"><b>Worker<\/b><\/a>/);
  const rolePage = await page("/ui/agents/final-writer");
  assert.match(rolePage, /renderFinalWriter/);
  assert.match(rolePage, /You are the final writer of a research run/);
  assert.equal((await get("/ui/agents/no-role")).status, 404);
  const campaign = String(
    (env.assign.envelope.payload as { contract: { campaign: string } }).contract.campaign,
  );
  const tab = await page(`/ui/campaigns/${campaign}/runs/${run}/prompts`);
  assert.match(
    tab,
    new RegExp(`href="/ui/campaigns/${campaign}/runs/${run}/prompts/${id}">${id}</a>`),
  );
  assert.match(tab, /assignment, rig|role, assignment, rig/);
  const promptPage = await page(`/ui/campaigns/${campaign}/runs/${run}/prompts/${id}`);
  assert.match(promptPage, /<b>brief<\/b> <span class="muted small">message · from assignment/);
  assert.match(promptPage, /unroll the loop/);
  assert.match(promptPage, /the role&#39;s definition|the role's definition/);
  assert.equal((await get(`/ui/campaigns/${campaign}/runs/${run}/prompts/999`)).status, 404);
});
