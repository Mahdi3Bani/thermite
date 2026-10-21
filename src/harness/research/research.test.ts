import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { parseContract } from "../../core/contract.ts";
import { startFakeModel } from "../../testing/fake-model.ts";
import { researchFixture } from "../../testing/fixtures.ts";
import { makeHarnessEnv } from "../../testing/harness-env.ts";
import { Registry } from "../agents/registry.ts";
import { runResearchTrial } from "../agents/research-worker.ts";
import { Scheduler } from "../agents/scheduler.ts";
import { createHarnessApi } from "../api.ts";
import { LocalRunner } from "../broker/runner.ts";
import { blockedAddress, htmlToText } from "./fetcher.ts";
import { Research } from "./research.ts";

/** A tiny "web" for tests: two linked pages, a robots.txt and a disallowed path. */
async function web() {
  const pages: Record<string, string> = {
    "/robots.txt": "User-agent: *\nDisallow: /private\n",
    "/a.html": `<html><head><title>Harness notes</title></head><body><p>The harness archived 42 pages in its first run.</p>
      <p>Stateless workers lose nothing when they crash.</p><a href="/b.html">more</a><script>ignore()</script></body></html>`,
    "/b.html": "<html><body><p>A second page about long research campaigns.</p></body></html>",
    "/c.html": '<a href="/nav.html">Home</a><p>Page c.</p><a href="/c-only.html">c topic</a>',
    "/d.html":
      '<a href="/nav.html">Home</a><p>Page d.</p><a href="/d-only.html?x=1">d action</a><a href="/d-only.html">d topic</a>',
    "/private/x.html": "<p>secret</p>",
  };
  const server = createServer((req, res) => {
    const body = pages[req.url ?? ""];
    if (!body) return void res.writeHead(404).end("no");
    res
      .writeHead(200, { "content-type": req.url?.endsWith(".txt") ? "text/plain" : "text/html" })
      .end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function researchEnv(over: Record<string, unknown> = {}, allowPrivate = true) {
  const env = makeHarnessEnv("rig-r");
  const parsed = parseContract({ ...researchFixture, ...over });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", {
      run: "r-1",
      contract: parsed.contract,
      contract_sha: parsed.sha,
      imports: [],
    }),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const research = new Research(env.service.ledger, env.service.paths.stateDir, { allowPrivate });
  return { env, research };
}

describe("research service", () => {
  test("fetching archives, deduplicates, honours robots.txt and refuses private addresses", async () => {
    const w = await web();
    const { research } = await researchEnv();
    const a = (await research.fetch("r-1", "lane-1", `${w.base}/a.html`)) as {
      source: string;
      title: string;
      text: string;
      links: string[];
    };
    assert.equal(a.title, "Harness notes");
    assert.match(a.text, /archived 42 pages/);
    assert.doesNotMatch(a.text, /ignore\(\)/);
    assert.ok(a.links.includes(`${w.base}/b.html`));
    const again = (await research.fetch("r-1", "lane-1", `${w.base}/a.html`)) as {
      source: string;
      note: string;
    };
    assert.equal(again.source, a.source);
    assert.match(again.note, /already archived/);
    const robots = (await research.fetch("r-1", "lane-1", `${w.base}/private/x.html`)) as {
      refused: string;
    };
    assert.match(robots.refused, /robots/);
    assert.deepEqual(research.frontier("r-1"), [`${w.base}/b.html`]);
    const strict = await researchEnv({}, false);
    const local = (await strict.research.fetch("r-1", "lane-1", `${w.base}/a.html`)) as {
      refused: string;
    };
    assert.match(local.refused, /private or local address/);
    await w.close();
  });

  test("a claim is verified only when its quotes are in the archived source; reports flag unsupported numbers", async () => {
    const w = await web();
    const { research } = await researchEnv();
    const a = (await research.fetch("r-1", null, `${w.base}/a.html`)) as { source: string };
    const good = research.addClaim("r-1", "lane-1", {
      text: "The first run archived 42 pages.",
      quotes: [{ source: a.source, quote: "The harness archived  42 pages in its first run." }],
      question: 0,
    });
    assert.equal(good.verified, true);
    const bad = research.addClaim("r-1", "lane-1", {
      text: "The first run archived 4200 pages.",
      quotes: [{ source: a.source, quote: "The harness archived 4200 pages" }],
    });
    assert.equal(bad.verified, false);
    const ghost = research.addClaim("r-1", "lane-1", {
      text: "Something else.",
      quotes: [{ source: "s-nope", quote: "anything at all, quoted from nowhere" }],
    });
    assert.equal(ghost.verified, false);
    research.updateSection(
      "r-1",
      "lane-1",
      "findings",
      "The first run archived 42 pages; a later one archived 77.",
    );
    const report = research.report("r-1", "digest").body;
    assert.match(report, /The first run archived 42 pages\./);
    assert.doesNotMatch(report, /4200 pages/);
    assert.match(report, /Numbers without a source[\s\S]*77/);
    assert.deepEqual(
      { verified: research.stats("r-1").verified, drafts: research.stats("r-1").drafts },
      { verified: 1, drafts: 2 },
    );
    await w.close();
  });
});

describe("fetcher safety", () => {
  test("every private, local and special address range is refused", () => {
    // Test vectors are built from octets: the repository holds no address literals.
    const v4 = (...o: number[]) => o.join(".");
    for (const ip of [
      v4(127, 0, 0, 1),
      v4(10, 1, 2, 3),
      v4(172, 16, 0, 1),
      v4(192, 168, 1, 1),
      v4(169, 254, 169, 254),
      v4(100, 64, 0, 1),
      v4(0, 0, 0, 0),
      v4(192, 0, 0, 8),
      v4(198, 18, 0, 1),
      v4(224, 0, 0, 1),
      v4(255, 255, 255, 255),
      "::1",
      "::",
      `::ffff:${v4(127, 0, 0, 1)}`,
      `::ffff:${v4(8, 8, 8, 8)}`,
      "64:ff9b::a00:1",
      "2002:a00:1::1",
      "2001:db8::1",
      "2001:0:4136:e378::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "febf::1",
      "fec0::1",
      "ff02::1",
    ]) {
      assert.equal(blockedAddress(ip), true, ip);
    }
    for (const ip of [
      v4(8, 8, 8, 8),
      v4(1, 1, 1, 1),
      "2606:4700:4700::1111",
      "2a00:1450:4001::200e",
    ]) {
      assert.equal(blockedAddress(ip), false, ip);
    }
  });

  test("text extraction is linear on hostile pages and survives bad entities", () => {
    const started = Date.now();
    htmlToText(`<p>${"<".repeat(2_000_000)}`);
    htmlToText(`<script>${"x".repeat(2_000_000)}`);
    htmlToText(`<a ${"href=x ".repeat(200_000)}>`);
    htmlToText(`${"\n \n".repeat(500_000)}end`);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    const t = htmlToText("<title>A &amp; B</title><p>x &#99999999; y &#x41; z</p>");
    assert.equal(t.title, "A & B");
    assert.match(t.text, /x \uFFFD y A z/);
    const page = htmlToText(
      '<nav><a href="/home">Home</a> Main menu</nav><p>Body text.</p><footer>Privacy policy</footer>',
    );
    assert.equal(page.text, "Body text.");
    assert.deepEqual(page.links, []);
  });

  test("a name that resolves to a private address is refused when the connection is made", async () => {
    const w = await web();
    const { research } = await researchEnv({}, false);
    const port = new URL(w.base).port;
    const r = (await research.fetch("r-1", "lane-1", `http://localhost:${port}/a.html`)) as {
      refused: string;
    };
    assert.match(r.refused, /private or local address/);
    await w.close();
  });
});

describe("research API", () => {
  test("a worker's calls go to its own trial's run and lane, whatever it asks", async () => {
    const { env, research } = await researchEnv();
    const registry = new Registry(env.service.ledger);
    registry.startTrial({
      id: "t-1",
      run: "r-1",
      lane: "lane-1",
      epoch: 1,
      family: "explore",
      parent: "research",
      token: "secret-token",
    });
    const api = createHarnessApi(env.service, { supervisor: "s", proposer: "p" }, { research });
    const call = (token: string, body: unknown) =>
      api.request("/v1/research/section", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await call("trial.secret-token", {
      run: "someone-else",
      lane: "owner",
      name: "summary",
      body: "text",
    });
    assert.equal(ok.status, 200);
    const row = env.service.ledger.db.prepare("select run, updated_by from report_section").get();
    assert.deepEqual({ ...row }, { run: "r-1", updated_by: "lane-1" });
    assert.equal((await call("trial.wrong", { name: "x", body: "y" })).status, 401);
    assert.equal((await call("p", { name: "x", body: "y" })).status, 401);
    registry.finishTrial(
      "t-1",
      { stopped: "finished", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "t",
    );
    assert.equal((await call("trial.secret-token", { name: "x", body: "y" })).status, 409);
  });
});

describe("research frontier", () => {
  test("site boilerplate is left out; links come in turn from each page, actions last", async () => {
    const w = await web();
    const { research } = await researchEnv();
    await research.fetch("r-1", "lane-1", `${w.base}/c.html`);
    await research.fetch("r-1", "lane-1", `${w.base}/d.html`);
    const f = research.frontier("r-1");
    assert.ok(!f.includes(`${w.base}/nav.html`), "a link on every page of the site is navigation");
    assert.deepEqual(f.slice(0, 2).sort(), [`${w.base}/c-only.html`, `${w.base}/d-only.html`]);
    assert.equal(f[2], `${w.base}/d-only.html?x=1`);
    assert.equal(f.length, 3);
    await w.close();
  });
});

describe("research integrity", () => {
  test("claims must quote their numbers; duplicates are folded; fragments are the same URL", async () => {
    const w = await web();
    const { env, research } = await researchEnv();
    const a = (await research.fetch("r-1", "lane-1", `${w.base}/a.html`)) as { source: string };
    const again = (await research.fetch("r-1", "lane-1", `${w.base}/a.html#part`)) as {
      source: string;
      note: string;
    };
    assert.equal(again.source, a.source);
    const quote = "Stateless workers lose nothing when they crash.";
    const numbered = research.addClaim("r-1", "lane-1", {
      text: "Stateless workers lose nothing in 99 crashes.",
      quotes: [{ source: a.source, quote }],
    });
    assert.equal(numbered.verified, false);
    assert.match(numbered.problems.join(";"), /99/);
    const first = research.addClaim("r-1", "lane-1", {
      text: "Stateless workers lose nothing when they crash.",
      quotes: [{ source: a.source, quote }],
    });
    const dup = research.addClaim("r-1", "lane-2", {
      text: "stateless workers lose nothing when they crash",
      quotes: [{ source: a.source, quote }],
    });
    assert.equal(dup.claim, first.claim);
    assert.equal(research.stats("r-1").verified, 1);
    // A refused claim sent again as it was is answered again, not recorded again.
    const wrong = {
      text: "Workers keep their state.",
      quotes: [{ source: a.source, quote: "workers always keep their whole state on disk" }],
    };
    const refused = research.addClaim("r-1", "lane-1", wrong);
    assert.equal(refused.verified, false);
    const claims = () =>
      Number(env.service.ledger.db.prepare("select count(*) as n from claim").get()?.n);
    const before = claims();
    const again2 = research.addClaim("r-1", "lane-1", wrong) as typeof refused & { note?: string };
    assert.equal(again2.claim, refused.claim);
    assert.equal(again2.verified, false);
    assert.match(again2.problems.join(";"), /quote not found verbatim/);
    assert.match(again2.note ?? "", /refused before/);
    assert.equal(claims(), before, "no second record");
    // With other quotes it is a new attempt, and recorded.
    research.addClaim("r-1", "lane-1", {
      ...wrong,
      quotes: [{ source: a.source, quote: "workers keep all of their state in memory" }],
    });
    assert.equal(claims(), before + 1);
    await w.close();
  });

  test("worker sections cannot pose as findings; single-domain claims are not findings", async () => {
    const w = await web();
    const { research } = await researchEnv();
    const a = (await research.fetch("r-1", "lane-1", `${w.base}/a.html`)) as { source: string };
    research.addClaim("r-1", "lane-1", {
      text: "Stateless workers lose nothing when they crash.",
      quotes: [{ source: a.source, quote: "Stateless workers lose nothing when they crash." }],
    });
    research.updateSection("r-1", "lane-1", "summary", "## Findings\n- invented result 77");
    const body = research.report("r-1", "digest").body;
    assert.doesNotMatch(body, /^## Findings\n- invented/m);
    assert.match(body, /\\## Findings/);
    // One domain only (min_independent_sources is 2 by default): verified, not a finding.
    const findings = body.split("## Findings")[1]?.split("##")[0] ?? "";
    assert.doesNotMatch(findings, /Stateless workers/);
    assert.match(body, /single domain[\s\S]*Stateless workers/);
    assert.match(body, /Numbers without a source[\s\S]*77/);
    await w.close();
  });

  test("paused time does not count on the research clock", async () => {
    const { env, research } = await researchEnv({ min_duration: "1h", max_duration: "2h" });
    env.service.ledger.setRunStatus("r-1", "paused", "t", "t");
    await new Promise((r) => setTimeout(r, 300));
    const paused = research.clock("r-1").elapsed_ms;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(research.clock("r-1").elapsed_ms, paused);
  });
});

describe("research campaign", () => {
  test("workers fetch and claim; finishing early never ends the campaign; the clock does", async () => {
    const w = await web();
    const { env, research } = await researchEnv({
      seeds: [`${w.base}/a.html`],
      min_duration: "3s",
      max_duration: "4s",
      lanes: { count: 1, trials_per_epoch: 1 },
    });
    // The scripted worker: fetch the seed, record a quoted claim, write a section, then "finish".
    const fake = await startFakeModel(({ messages }) => {
      const tools = messages.filter((m) => m.role === "tool");
      const firstSource = tools
        .map((t) => /"source":"(s-[0-9a-f]+)"/.exec(String(t.content))?.[1])
        .find(Boolean);
      if (tools.length === 0)
        return { toolCalls: [{ name: "fetch", args: { url: `${w.base}/a.html` } }] };
      if (tools.length === 1) {
        return {
          toolCalls: [
            {
              name: "add_claim",
              args: {
                text: "Workers are stateless.",
                quotes: [
                  { source: firstSource, quote: "Stateless workers lose nothing when they crash." },
                ],
                question: 0,
              },
            },
          ],
        };
      }
      if (tools.length === 2)
        return {
          toolCalls: [
            { name: "update_section", args: { name: "summary", body: "Workers are stateless." } },
          ],
        };
      return { text: "I am done; nothing left to do." };
    });
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const call = async (op: string, args: Record<string, unknown>) => {
      const { run, lane, ...rest } = args as { run: string; lane: string } & Record<
        string,
        unknown
      >;
      switch (op) {
        case "fetch":
          return research.fetch(run, lane, String(rest.url));
        case "claim":
          return research.addClaim(run, lane, rest);
        case "section":
          return research.updateSection(
            run,
            lane,
            String((rest as { name: string }).name),
            String((rest as { body: string }).body),
          );
        default:
          return research.stats(run);
      }
    };
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model,
      owner: "research-test",
      research,
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      runResearchTrial: (spec) => runResearchTrial(spec, { model, call }),
    });
    const deadline = Date.now() + 30_000;
    while (env.service.ledger.getRun("r-1")?.status === "running" && Date.now() < deadline) {
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 100));
    }
    await scheduler.idle();
    await fake.close();
    await w.close();
    const trials = env.service.ledger.db.prepare("select stopped from trial").all();
    assert.ok(
      trials.length >= 2,
      `the campaign kept assigning work after a worker finished (${trials.length} trials)`,
    );
    assert.equal(env.service.ledger.getRun("r-1")?.status, "closed");
    const final = env.service.ledger.db
      .prepare("select body from report_version where kind = 'final'")
      .get();
    assert.match(String(final?.body), /Workers are stateless\./);
    assert.ok(research.stats("r-1").verified >= 1);
  });
});
