import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { parseContract } from "../../core/contract.ts";
import { startFakeModel } from "../../testing/fake-model.ts";
import { researchFixture } from "../../testing/fixtures.ts";
import { makeHarnessEnv } from "../../testing/harness-env.ts";
import { runResearchTrial } from "../agents/research-worker.ts";
import { Scheduler } from "../agents/scheduler.ts";
import { LocalRunner } from "../broker/runner.ts";
import { Research } from "./research.ts";

/** A tiny "web" for tests: two linked pages, a robots.txt and a disallowed path. */
async function web() {
  const pages: Record<string, string> = {
    "/robots.txt": "User-agent: *\nDisallow: /private\n",
    "/a.html": `<html><head><title>Harness notes</title></head><body><p>The harness archived 42 pages in its first run.</p>
      <p>Stateless workers lose nothing when they crash.</p><a href="/b.html">more</a><script>ignore()</script></body></html>`,
    "/b.html": "<html><body><p>A second page about long research campaigns.</p></body></html>",
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
  const env = makeHarnessEnv("unit-r");
  const parsed = parseContract({ ...researchFixture, ...over });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", {
      instance: "r-1",
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
      quotes: [{ source: "s-nope", quote: "anything at all" }],
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
      const { instance, lane, ...rest } = args as { instance: string; lane: string } & Record<
        string,
        unknown
      >;
      switch (op) {
        case "fetch":
          return research.fetch(instance, lane, String(rest.url));
        case "claim":
          return research.addClaim(instance, lane, rest);
        case "section":
          return research.updateSection(
            instance,
            lane,
            String((rest as { name: string }).name),
            String((rest as { body: string }).body),
          );
        default:
          return research.stats(instance);
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
    while (env.service.ledger.getInstance("r-1")?.status === "running" && Date.now() < deadline) {
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
    assert.equal(env.service.ledger.getInstance("r-1")?.status, "closed");
    const final = env.service.ledger.db
      .prepare("select body from report_version where kind = 'final'")
      .get();
    assert.match(String(final?.body), /Workers are stateless\./);
    assert.ok(research.stats("r-1").verified >= 1);
  });
});
