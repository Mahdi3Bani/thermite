import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateSigningKeys } from "../core/commands.ts";
import { parseContract } from "../core/contract.ts";
import { createControlApi } from "./api.ts";
import type { CampaignDraft } from "./campaign-builder.ts";
import { issueCommand } from "./issue.ts";
import { KitRepos } from "./kit-repos.ts";
import { startCampaign } from "./new-campaign.ts";
import { ControlStore } from "./store.ts";

/**
 * Copy a campaign (goal 069): REST's POST /v1/campaigns/<name>/copy, MCP's copy_campaign. The copy
 * has the source's contract and kit under its own name, its own empty folder and no grants, and
 * Start a run starts it like any campaign.
 */

type Ev = [string, string, string, Record<string, unknown>];

const TOKENS = {
  admin: "admin-token-abcdef",
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const draft: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: { type: "x", class: "x" },
  project: {
    url: "https://git.example.com/team/fastmat.git",
    commit: C,
    repo: "fastmat",
    editable_paths: ["src/kernels/**"],
  },
  kit: {
    source: "here",
    build: "make bench",
    outputs: ["bench"],
    cases: [{ name: "small", params: { n: 64 }, work: 524288 }],
    run: "{build}/bench --n {n} --out {out}/result.txt",
    check: "test -s {out}/result.txt",
  },
  score: { name: "throughput", unit: "FLOP/s" },
};

const CPU = { type: "cpu", class: "generic-cpu" };

/**
 * Control with kits. matmul-speed is saved twice on the New campaign page; its first version ran
 * as matmul-speed-1 on rig-a, which recorded an experiment, and it reads survey-study's folder.
 * gemv-speed is known only by an assignment over the API (gs-3 on rig-a). rig-b ran a rig check.
 */
async function stack() {
  const keys = generateSigningKeys();
  const store = new ControlStore(":memory:");
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const api = createControlApi(store, TOKENS, keys.privateKeyPem, { staleAfterMs: 600_000, kits });
  const next = new Map<string, number>();
  /** A rig's report of these events, after the ones it reported before. */
  const ingest = (rig: string, events: Ev[]) => {
    const from = next.get(rig) ?? 0;
    next.set(rig, from + events.length);
    store.ingest({
      rig,
      ledger_id: `ledger-${rig}`,
      cursor: from,
      next: from + events.length,
      generated_at: new Date().toISOString(),
      events: events.map(([actor, kind, subject, body], i) => ({
        id: from + i + 1,
        at: new Date(Date.parse("2026-10-21T01:00:00Z") + (from + i) * 60_000).toISOString(),
        actor,
        kind,
        subject,
        body,
      })),
      summary: {
        hardware: {
          collected_at: "2026-10-21T01:00:00Z",
          target: { ...CPU, id: "cpu-1" },
          device_mode: "none",
          devices: [],
          cpu: { model: "Example CPU", host: 8, usable: 8, quota: null },
          memory: { host_mib: 16_000, limit_mib: null },
          disks: [],
          os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
          toolchain: { cc: "cc 12", nvcc: null },
          errors: [],
        },
      },
    });
  };
  const deps = { store, kits, privateKeyPem: keys.privateKeyPem };
  ingest("rig-a", []);
  const first = await startCampaign(deps, {
    draft,
    rig: "rig-a",
    target: CPU,
    start: true,
    by: "owner:ui",
  });
  assert.ok(first.ok && first.run === "matmul-speed-1");
  ingest("rig-a", [
    ["harness", "run_created", "matmul-speed-1", { campaign: "matmul-speed", mode: "hill_climb" }],
    [
      "planner",
      "experiment_added",
      "matmul-speed-1",
      { id: "x-1", title: "Tile the loops by 32", by: "planner" },
    ],
  ]);
  const second = await startCampaign(deps, {
    draft,
    rig: "rig-a",
    target: CPU,
    start: false,
    by: "owner:ui",
  });
  assert.ok(second.ok && second.version === 2);
  ingest("rig-b", [
    ["harness", "run_created", "sv-2", { campaign: "survey-study", mode: "research" }],
    [
      "harness",
      "run_created",
      "rc-1",
      { campaign: "rig-check-smoke-cpu-1a2b3c4d", mode: "hill_climb", agents: false },
    ],
  ]);
  store.kb().grant("matmul-speed", "survey-study", "owner:ui");
  // gemv-speed: assigned over the API with a real contract, its project and kit from git.
  const goal = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../examples/contracts/goal-example.json"), "utf8"),
  ) as Record<string, unknown>;
  const gemv = parseContract({ ...goal, campaign: "gemv-speed", version: 3 });
  assert.ok(gemv.ok);
  const gemvImports = [
    {
      kind: "repo_bundle",
      path: "repos/my-project.bundle",
      repo: "my-project",
      commit: C,
      source: { git: "https://git.example.com/team/my-project.git" },
    },
  ];
  issueCommand(store, keys.privateKeyPem, {
    rig: "rig-a",
    kind: "assign_campaign",
    payload: {
      run: "gs-3",
      contract: gemv.contract,
      contract_sha: gemv.sha,
      seed: { repo: "my-project", commit: C },
      imports: gemvImports,
      promotion: "owner_approval",
      queue: [
        { title: "Vector loads", by: "planner", state: "queued", from: { run: "gs-2", id: "x-9" } },
      ],
    },
    issuedBy: "owner:api",
  });

  const rest = (from: string, body: unknown, token = TOKENS.admin) =>
    api.request(`/v1/campaigns/${from}/copy`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const startRun = (campaign: string, body: unknown) =>
    api.request(`/v1/campaigns/${campaign}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.admin}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  /** Every assign_campaign control signed, oldest first. */
  const assigned = () =>
    (
      store.db
        .prepare("select signed from command where kind = 'assign_campaign' order by rowid")
        .all() as { signed: string }[]
    ).map(
      (x) =>
        (
          JSON.parse(x.signed) as {
            envelope: { id: string; issued_by: string; payload: Record<string, unknown> };
          }
        ).envelope,
    );
  const page = async (path: string) => {
    const login = await api.request("/ui/login", {
      method: "POST",
      body: new URLSearchParams({ token: TOKENS.admin }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return (await api.request(path, { headers: { cookie } })).text();
  };
  return { store, api, rest, startRun, assigned, ingest, page, gemv, gemvImports };
}

/** An MCP client talking to control in-process, with a token. */
async function mcp(api: ReturnType<typeof createControlApi>, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return api.request(`${url.pathname}${url.search}`, { ...init, headers } as RequestInit);
  };
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: fetchImpl }),
  );
  return client;
}

const text = (r: unknown) =>
  ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

const json = async <T>(r: Response) => (await r.json()) as T;

describe("Copy a campaign over REST (goal 069)", () => {
  test("a saved campaign: its newest version under the new name, an empty folder, no grants, and a run reads only the copy's folder", async () => {
    const s = await stack();
    const [source] = s.store.campaignVersions("matmul-speed");
    assert.ok(source && source.version === 2);
    const r = await s.rest("matmul-speed", { name: "matmul-speed-b" });
    assert.equal(r.status, 201);
    const [copy] = s.store.campaignVersions("matmul-speed-b");
    assert.ok(copy);
    assert.deepEqual(await json(r), {
      campaign: "matmul-speed-b",
      version: 1,
      contract_sha: copy.sha,
      from: { campaign: "matmul-speed", version: 2 },
    });
    // The same contract but for its name and version, with a hash of its own; the same sources.
    const { campaign, version, ...rest } = copy.contract as Record<string, unknown>;
    const { campaign: _c, version: _v, ...sourceRest } = source.contract as Record<string, unknown>;
    assert.deepEqual([campaign, version], ["matmul-speed-b", 1]);
    assert.deepEqual(rest, sourceRest);
    const reparsed = parseContract(copy.contract);
    assert.ok(reparsed.ok);
    assert.equal(copy.sha, reparsed.sha);
    assert.notEqual(copy.sha, source.sha);
    assert.deepEqual(copy.sources, source.sources);
    assert.deepEqual(copy.copied_from, { campaign: "matmul-speed", version: 2 });
    assert.equal(copy.created_by, "owner:api");
    // Its own folder, empty, reading nothing else; the source still reads survey-study.
    const kb = s.store.kb();
    const folder = kb.folder("matmul-speed-b");
    assert.deepEqual([folder.items, folder.runs, folder.reads, folder.read_by], [0, 0, [], []]);
    assert.deepEqual(kb.readable("matmul-speed-b"), ["matmul-speed-b"]);
    assert.deepEqual(kb.reads("matmul-speed"), ["survey-study"]);
    // Who copied it, from what: the audit log, and the copy's page.
    const audit = s.store.listAudit(50).find((a) => a.action === "campaign_copied");
    assert.equal(audit?.actor, "owner:api");
    assert.deepEqual(audit?.body, {
      campaign: "matmul-speed-b",
      from: { campaign: "matmul-speed", version: 2 },
      sha: copy.sha,
    });
    const html = await s.page("/ui/campaigns/matmul-speed-b");
    assert.match(
      html,
      /Copied from<\/span> <a href="[^"]*matmul-speed">matmul-speed version 2<\/a>/,
    );
    assert.match(html, /by owner:api, .* ago\. Its folder in the knowledge base started empty\./);
    assert.match(html, /Saved on control, with no run yet\./);

    // Start a run of the copy: its own contract, the source's project and kit imports.
    const before = s.assigned().find((a) => a.payload.run === "matmul-speed-1");
    assert.ok(before);
    const started = await s.startRun("matmul-speed-b", { rig: "rig-a" });
    assert.equal(started.status, 201);
    const out = await json<{ run: string; command: string }>(started);
    assert.equal(out.run, "matmul-speed-b-1");
    const sent = s.assigned().at(-1);
    assert.ok(sent && sent.id === out.command);
    assert.equal((sent.payload.contract as { campaign: string }).campaign, "matmul-speed-b");
    assert.equal(sent.payload.contract_sha, copy.sha);
    assert.deepEqual(sent.payload.imports, before.payload.imports);
    assert.deepEqual(sent.payload.seed, before.payload.seed);
    // The rig reports the run: control files it in the copy's folder, and syncs it nothing else.
    s.ingest("rig-a", [
      ["harness", "run_created", "matmul-speed-b-1", { campaign: "matmul-speed-b" }],
    ]);
    const sync = s.store.kb().sync("rig-a", "matmul-speed-b-1", 0);
    assert.deepEqual(
      [sync?.campaign, sync?.folders, sync?.items],
      ["matmul-speed-b", ["matmul-speed-b"], []],
    );
    // The source's run still reads its own folder and survey-study's.
    assert.deepEqual(s.store.kb().sync("rig-a", "matmul-speed-1", 0)?.folders, [
      "matmul-speed",
      "survey-study",
    ]);
  });

  test("refusals in words; nothing is saved", async () => {
    const s = await stack();
    s.store.kb().grant("old-name", "matmul-speed", "owner:ui");
    const before = s.store.campaignVersions().length;
    const refused = async (from: string, body: unknown, status: number, error: string) => {
      const r = await s.rest(from, body);
      assert.deepEqual([r.status, await json(r)], [status, { error }], JSON.stringify(body));
    };
    for (const taken of ["matmul-speed", "gemv-speed", "survey-study", "old-name"])
      await refused(
        "matmul-speed",
        { name: taken },
        409,
        `There is a campaign named ${taken} already. Choose another name.`,
      );
    for (const bad of ["Matmul", "-b", "", "a b", "x".repeat(65)])
      await refused(
        "matmul-speed",
        { name: bad },
        400,
        "A campaign's name is lowercase letters, digits, dots, dashes and underscores, at most 64. It starts with a letter or a digit.",
      );
    await refused(
      "matmul-speed",
      { name: "rig-check-mine" },
      400,
      "A name that starts with rig-check- is for rig checks. Choose another name.",
    );
    await refused(
      "nope",
      { name: "nope-b" },
      404,
      "Control has no saved version or earlier assignment of nope. There is nothing to copy.",
    );
    await refused(
      "rig-check-smoke-cpu-1a2b3c4d",
      { name: "smoke-b" },
      400,
      "rig-check-smoke-cpu-1a2b3c4d is a rig check's campaign. A rig check cannot be copied.",
    );
    await refused(
      "matmul-speed",
      {},
      400,
      "bad request: name: Invalid input: expected string, received undefined",
    );
    const extra = await s.rest("matmul-speed", { name: "matmul-b", lanes: 3 });
    assert.equal(extra.status, 400);
    assert.match((await json<{ error: string }>(extra)).error, /^bad request: .*lanes/);
    // The owner's alone over REST: other tokens get 401.
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read])
      assert.equal((await s.rest("matmul-speed", { name: "matmul-b" }, token)).status, 401);
    assert.equal(s.store.campaignVersions().length, before, "nothing was saved");
    const audit = s.store.listAudit(100);
    assert.ok(!audit.some((a) => a.action === "campaign_copied"));
    assert.ok(
      audit.some(
        (a) =>
          a.action === "refused" &&
          a.actor === "owner:api" &&
          (a.body as { path?: string }).path === "/v1/campaigns/matmul-speed/copy" &&
          /already/.test(String((a.body as { why?: string }).why)),
      ),
    );
  });
});

describe("Copy a campaign over MCP (goal 069)", () => {
  test("copy_campaign for the owner and an operator; a campaign known only by an assignment; start_run on the copy", async () => {
    const s = await stack();
    const tools = async (token: string) =>
      (await (await mcp(s.api, token)).listTools()).tools.map((t) => t.name);
    assert.ok((await tools(TOKENS.admin)).includes("copy_campaign"));
    assert.ok((await tools(TOKENS.operator)).includes("copy_campaign"));
    assert.ok(!(await tools(TOKENS.agent)).includes("copy_campaign"));
    assert.ok(!(await tools(TOKENS.read)).includes("copy_campaign"));
    const operator = await mcp(s.api, TOKENS.operator);
    const out = JSON.parse(
      text(
        await operator.callTool({
          name: "copy_campaign",
          arguments: { from: "gemv-speed", name: "gemv-speed-b" },
        }),
      ),
    );
    const [copy] = s.store.campaignVersions("gemv-speed-b");
    assert.ok(copy);
    assert.deepEqual(out, {
      campaign: "gemv-speed-b",
      version: 1,
      contract_sha: copy.sha,
      from: { campaign: "gemv-speed", rig: "rig-a", run: "gs-3" },
    });
    // The assignment's contract under the new name; its starting point and imports, not its run's.
    const { campaign, version, ...rest } = copy.contract as Record<string, unknown>;
    const { campaign: _c, version: _v, ...sourceRest } = s.gemv.contract as Record<string, unknown>;
    assert.deepEqual([campaign, version], ["gemv-speed-b", 1]);
    assert.deepEqual(rest, sourceRest);
    assert.notEqual(copy.sha, s.gemv.sha);
    assert.deepEqual(copy.sources, {
      assignment: { seed: { repo: "my-project", commit: C }, imports: s.gemvImports },
    });
    assert.equal(copy.created_by, "owner:operator");
    assert.deepEqual(s.store.kb().readable("gemv-speed-b"), ["gemv-speed-b"]);
    const audit = s.store.listAudit(100);
    assert.ok(audit.some((a) => a.action === "mcp:copy_campaign" && a.actor === "owner:operator"));
    assert.ok(audit.some((a) => a.action === "campaign_copied" && a.actor === "owner:operator"));
    const html = await s.page("/ui/campaigns/gemv-speed-b");
    assert.match(html, /gemv-speed as assigned for gs-3 on rig-a<\/a>/);

    // start_run on the copy: the assignment's imports, the copy's contract, nothing of gs-3's run.
    const started = JSON.parse(
      text(
        await operator.callTool({
          name: "start_run",
          arguments: { campaign: "gemv-speed-b", rig: "rig-a" },
        }),
      ),
    ) as { started: boolean; run: string; command: string };
    assert.deepEqual([started.started, started.run], [true, "gemv-speed-b-1"]);
    const sent = s.assigned().at(-1);
    assert.ok(sent && sent.id === started.command);
    assert.deepEqual(sent.payload, {
      run: "gemv-speed-b-1",
      contract: copy.contract,
      contract_sha: copy.sha,
      seed: { repo: "my-project", commit: C },
      imports: s.gemvImports,
    });

    // Refused in words, and in the audit log.
    const owner = await mcp(s.api, TOKENS.admin);
    const refused = await owner.callTool({
      name: "copy_campaign",
      arguments: { from: "gemv-speed", name: "gemv-speed-b" },
    });
    assert.equal(refused.isError, true);
    assert.deepEqual(JSON.parse(text(refused)), {
      error: "There is a campaign named gemv-speed-b already. Choose another name.",
    });
    assert.ok(
      s.store
        .listAudit(100)
        .some(
          (a) =>
            a.action === "refused" &&
            a.actor === "owner:mcp" &&
            (a.body as { tool?: string }).tool === "mcp:copy_campaign",
        ),
    );
  });
});
