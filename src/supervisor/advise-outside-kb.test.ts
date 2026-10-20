import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { createHarnessApi } from "../harness/api.ts";
import { startFakeKb } from "../testing/fake-kb.ts";
import { startFakeModel } from "../testing/fake-model.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { type AdviseConfig, adviseOnce, emptyAdviseState, kbSearchFor } from "./advise.ts";
import { fetchControlAdvisors, mergeAdvisors } from "./advisor-routes.ts";
import { AdvisorsConfig, type OutsideKbGrant } from "./advisors.ts";

/** A made-up token for the outside knowledge base. */
const TOKEN = "kb-token-fake-0123456789";
const tokens = { supervisor: "sup-token", proposer: "prop-token" };
type Env = ReturnType<typeof makeJudgeEnv>;

function config(env: Env, advisors: AdvisorsConfig): AdviseConfig {
  const api = createHarnessApi(env.service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
  };
}

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

const grant = (url: string, campaigns: string[]): OutsideKbGrant => ({
  name: "team-brain",
  mcp_url: url,
  token: TOKEN,
  tool: "search",
  campaigns,
});

describe("outside knowledge bases for the advisors", () => {
  test("a granted campaign's teachers search it; an ungranted campaign's and an open fetch's get no search", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const campaign = env.ledger.listRuns().find((r) => r.id === "js-1")?.campaign ?? "";
    assert.ok(campaign);
    const kb = await startFakeKb({ token: TOKEN, writeTool: null });
    t.after(() => kb.close());
    const offered: string[][] = [];
    const seen: string[] = [];
    const model = await startFakeModel(({ messages, tools }) => {
      const names = tools.map((x) => x.function.name);
      offered.push(names);
      seen.push(JSON.stringify(messages));
      // Search once when the search is offered, then answer.
      if (names.includes("kb_search") && messages.at(-1)?.role !== "tool")
        return { toolCalls: [{ name: "kb_search", args: { query: "vector loads" } }] };
      return { toolCalls: [{ name: "answer", args: { summary: "fine", recommendations: [] } }] };
    });
    t.after(() => model.close());
    const round = async (outside: OutsideKbGrant[], fetch_domains: string[] = []) => {
      offered.length = 0;
      const advisors = AdvisorsConfig.parse({
        teachers: [runtime(model.url, "teacher-a")],
        fetch_domains,
        outside_kb: outside,
      });
      const s = await adviseOnce(config(env, advisors), emptyAdviseState());
      assert.equal(s.stats.teacher_runs, 1);
      return offered.flat();
    };

    // Granted: the teacher has kb_search, and its search reaches the server with the token.
    assert.ok((await round([grant(kb.url, [campaign])])).includes("kb_search"));
    assert.deepEqual(
      kb.calls.map((c) => [c.tool, c.args]),
      [["search", { query: "vector loads" }]],
    );
    assert.ok(kb.requests.every((r) => r.authorization === `Bearer ${TOKEN}`));
    assert.ok(kb.requests.every((r) => !r.path.includes(TOKEN)));
    assert.ok(
      seen.some((m) => m.includes("notes/outside-fact")),
      "what it found reached the teacher",
    );

    // Granted to another campaign only: no search for this run's advisors.
    const before = kb.requests.length;
    assert.ok(!(await round([grant(kb.url, ["another-campaign"])])).includes("kb_search"));
    // Granted, but the advisors may fetch any web page: no knowledge-base search at all.
    const open = await round([grant(kb.url, [campaign])], ["*"]);
    assert.ok(open.includes("fetch_url") && !open.includes("kb_search"));
    assert.equal(kb.requests.length, before, "the server was not called again");
  });

  test("the rig's own knowledge base and a granted outside one are searched together, each under its name", async (t: TestContext) => {
    const kb = await startFakeKb({ token: TOKEN, writeTool: null });
    t.after(() => kb.close());
    const dir = mkdtempSync(join(tmpdir(), "thermite-kb-"));
    writeFileSync(join(dir, "token"), `${TOKEN}\n`);
    const own = { mcp_url: kb.url, token_file: join(dir, "token"), tool: "search" };
    const both = kbSearchFor({ kb: own, outside_kb: [grant(kb.url, ["pn-engine"])] }, "pn-engine");
    const found = (await both?.("loads")) as { knowledge_base: string; results: unknown }[];
    assert.deepEqual(
      found.map((f) => f.knowledge_base),
      ["kb", "team-brain"],
    );
    assert.match(JSON.stringify(found[1]?.results), /outside-fact/);
    // Another campaign: only the rig's own; nothing at all: no search.
    const ownOnly = kbSearchFor({ kb: own, outside_kb: [grant(kb.url, ["pn-engine"])] }, "rl");
    assert.match(JSON.stringify(await ownOnly?.("loads")), /outside-fact/);
    assert.equal(kbSearchFor({ outside_kb: [grant(kb.url, ["pn-engine"])] }, "rl"), undefined);
    assert.equal(kbSearchFor({}, "pn-engine"), undefined);
  });

  test("control's grants reach the advisors' configuration; a list the supervisor can't read gives none", async () => {
    const answer = (outside_kb: unknown) =>
      (async () =>
        Response.json({
          teachers: null,
          combiner: null,
          auditor: null,
          panel: null,
          ...(outside_kb === undefined ? {} : { outside_kb }),
        })) as typeof fetch;
    const o = { rig: "rig-a", controlUrl: "http://control", controlToken: "t" };
    const g = grant("https://brain.example/mcp", ["pn-engine"]);
    const control = await fetchControlAdvisors({ ...o, fetchImpl: answer([g]) });
    assert.deepEqual(control.outside_kb, [g]);
    const file = AdvisorsConfig.parse({
      auditor: { name: "a", runtime: "cli", argv: ["x"], restricted: true },
    });
    assert.deepEqual(mergeAdvisors(file, control)?.outside_kb, [g]);
    // An older control (none) and a garbled list: none, so no grant stays from before.
    assert.deepEqual(
      (await fetchControlAdvisors({ ...o, fetchImpl: answer(undefined) })).outside_kb,
      [],
    );
    assert.deepEqual(
      (await fetchControlAdvisors({ ...o, fetchImpl: answer([{ ...g, mcp_url: "not a url" }]) }))
        .outside_kb,
      [],
    );
  });
});
