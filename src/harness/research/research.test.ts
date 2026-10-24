import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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
import { blockedAddress, htmlToText, registrableDomain } from "./fetcher.ts";
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
  let count = 0;
  const server = createServer((req, res) => {
    // A page that moved, and one whose text changes on every fetch.
    if (req.url === "/old-b.html") return void res.writeHead(301, { location: "/b.html" }).end();
    if (req.url === "/old-n.html") return void res.writeHead(302, { location: "/n.html" }).end();
    if (req.url === "/n.html")
      return void res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<p>Fetch number ${++count} of a page that changes.</p>`);
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
    // Findings: a supported one is kept once; a draft refused for the same reasons is answered
    // again, not recorded again; a draft with other problems is a new attempt.
    const findings = () =>
      Number(env.service.ledger.db.prepare("select count(*) as n from finding").get()?.n);
    const kept = research.addFinding("r-1", "lane-1", {
      text: "Stateless workers lose nothing when they crash.",
      summary: "The page says workers keep no state.",
      why_it_matters: "A crash costs no work.",
      supporting: [first.claim],
    });
    assert.equal(kept.supported, true, JSON.stringify(kept));
    const keptAgain = research.addFinding("r-1", "lane-2", {
      text: "stateless workers lose nothing when they crash",
      summary: "Another summary of the same conclusion.",
      why_it_matters: "Same.",
      supporting: [first.claim],
    }) as typeof kept & { note?: string };
    assert.equal(keptAgain.finding, kept.finding);
    assert.match(keptAgain.note ?? "", /already recorded/);
    const draft = {
      text: "Workers keep their state in 3 places.",
      summary: "One summary.",
      why_it_matters: "It matters.",
      supporting: [refused.claim],
    };
    const d1 = research.addFinding("r-1", "lane-1", draft);
    assert.equal(d1.supported, false);
    const count = findings();
    const d2 = research.addFinding("r-1", "lane-1", {
      ...draft,
      summary: "A reworded summary.",
    }) as typeof d1 & { note?: string };
    assert.equal(d2.finding, d1.finding);
    assert.deepEqual(d2.problems, d1.problems);
    assert.match(d2.note ?? "", /refused before/);
    assert.equal(findings(), count, "no second draft");
    research.addFinding("r-1", "lane-1", { ...draft, supporting: [refused.claim, "c-none"] });
    assert.equal(findings(), count + 1);
    await w.close();
  });

  test("a quote's source may be its archived URL or file name; the check stays word for word", async () => {
    const w = await web();
    const { env, research } = await researchEnv({
      fetch_policy: { respect_robots: true, per_domain_per_minute: 120, max_bytes: 5_000_000 },
    });
    const a = (await research.fetch("r-1", "lane-1", `${w.base}/a.html`)) as { source: string };
    const b = (await research.fetch("r-1", "lane-1", `${w.base}/old-b.html`)) as {
      source: string;
    };
    const quote = "Stateless workers lose nothing when they crash.";
    const stored = (claim: string) =>
      JSON.parse(
        String(
          env.service.ledger.db.prepare("select quotes from claim where id = ?").get(claim)?.quotes,
        ),
      ) as { source: string; quote: string; resolved_from?: string }[];
    const event = () =>
      env.service.ledger
        .eventsAfter(0, 10_000)
        .events.filter((e) => e.kind === "claim_added")
        .map((e) => e.body as Record<string, unknown>)
        .at(-1);

    // The URL as fetched, with a fragment the archive drops: that source, and recorded so.
    const byUrl = research.addClaim("r-1", "lane-1", {
      text: "Workers that keep no state lose nothing in a crash.",
      quotes: [{ source: `${w.base}/a.html#intro`, quote }],
    }) as { claim: string; verified: boolean; problems: string[]; resolved?: unknown };
    assert.equal(byUrl.verified, true, JSON.stringify(byUrl));
    assert.deepEqual(byUrl.resolved, [{ cited: `${w.base}/a.html#intro`, source: a.source }]);
    assert.deepEqual(stored(byUrl.claim), [
      { source: a.source, quote, resolved_from: `${w.base}/a.html#intro` },
    ]);
    assert.deepEqual(event()?.sources, [a.source]);
    assert.deepEqual(event()?.problems, [], "a verified claim's event has no problems");

    // The URL its redirect ended at; the folder's file name, alone or in a path, .txt or .md.
    const second = "A second page about long research campaigns.";
    for (const [text, cited] of [
      ["A second page covers long research campaigns.", `${w.base}/b.html`],
      ["Long research campaigns get a second page.", `sources/${b.source}.txt`],
      ["The second page is about long campaigns.", `/scratch/research/r-1/sources/${b.source}.md`],
    ]) {
      const r = research.addClaim("r-1", "lane-1", {
        text,
        quotes: [{ source: cited, quote: second }],
      }) as { verified: boolean; problems: string[]; resolved?: unknown };
      assert.equal(r.verified, true, JSON.stringify(r));
      assert.deepEqual(r.resolved, [{ cited, source: b.source }]);
    }

    // The same check as by id: a quote not in the source it names is refused, whatever names it.
    const wrong = research.addClaim("r-1", "lane-1", {
      text: "The second page says workers lose nothing.",
      quotes: [{ source: `${w.base}/b.html`, quote }],
    });
    assert.equal(wrong.verified, false);
    assert.deepEqual(wrong.problems, [`quote not found verbatim in ${b.source}: "${quote}"`]);
    assert.deepEqual(event()?.sources, [b.source]);
    assert.deepEqual(event()?.problems, wrong.problems);

    // A URL never archived; one archived in another form (named, not taken); a URL that two
    // sources answer to; an id that is not one; a file name of no source.
    await research.fetch("r-1", "lane-1", `${w.base}/old-n.html`);
    await research.fetch("r-1", "lane-1", `${w.base}/n.html`);
    const ids = (
      env.service.ledger.db
        .prepare(
          "select id from source where run = 'r-1' and final_url like '%/n.html' order by fetched_at",
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
    assert.equal(ids.length, 2);
    const host = w.base.replace(/^http:\/\//, "");
    const refused = research.addClaim("r-1", "lane-2", {
      text: "Nothing here is verified.",
      quotes: [
        { source: `${w.base}/never.html`, quote },
        { source: `${host}/a.html/`, quote },
        { source: `${w.base}/n.html`, quote: "Fetch number 1 of a page that changes." },
        { source: "s-nope", quote },
        { source: "sources/s-000000000000.txt", quote },
        { source: `HTTPS://${host}/B.html`, quote },
      ],
    });
    assert.equal(refused.verified, false);
    assert.deepEqual(refused.problems, [
      `no archived source ${w.base}/never.html: no source was archived from that URL; fetch it first, then cite the s-… id that fetch returns`,
      `no archived source ${host}/a.html/: that URL is not archived as written, but ${a.source} is archived from ${w.base}/a.html; cite that id if it is the same page`,
      `no archived source ${w.base}/n.html: that URL is archived as 2 sources (${ids.join(", ")}); cite the id of the one the quote is from`,
      "no archived source s-nope: a quote's source is the s-… id that fetch returned",
      "no archived source sources/s-000000000000.txt: the research folder has no sources/s-000000000000.txt; cite the s-… id that fetch returned",
      // Named by where its redirect ended: that address, not the one fetched.
      `no archived source HTTPS://${host}/B.html: that URL is not archived as written, but ${b.source} is archived from ${w.base}/b.html; cite that id if it is the same page`,
    ]);
    assert.deepEqual(event()?.sources, [
      `${w.base}/never.html`,
      `${host}/a.html/`,
      `${w.base}/n.html`,
      "s-nope",
      "sources/s-000000000000.txt",
      `HTTPS://${host}/B.html`,
    ]);
    assert.deepEqual(event()?.problems, refused.problems);
    assert.equal(research.stats("r-1").verified, 4);
    await w.close();
  });

  test("a number from a heading or a label is still refused, and the problem says where it is", async () => {
    const w = await web();
    const { env, research } = await researchEnv();
    const a = (await research.fetch("r-1", "lane-1", `${w.base}/a.html`)) as { source: string };
    const quote = "Stateless workers lose nothing when they crash.";
    const said = (text: string) =>
      research.addClaim("r-1", "lane-1", { text, quotes: [{ source: a.source, quote }] });
    const q = said(`Question 0: ${quote}`);
    assert.equal(q.verified, false);
    assert.deepEqual(q.problems, [
      `the number 0 is not in the claim's quotes: it comes from the heading "Question 0:". Give a question's number in "question", not in the claim's text, and leave headings and labels out of the text`,
    ]);
    const h = said(`# Claim c-verify-005\n\n${quote}`);
    assert.equal(h.verified, false);
    assert.match(h.problems.join("\n"), /the number 005 .*heading "# Claim c-verify-005"/);
    // A number in the claim's own words gets the plain problem.
    const plain = said("Stateless workers lose nothing in 3 crashes.");
    assert.deepEqual(plain.problems, ["the number 3 is not in the claim's quotes"]);
    // A name's digits state no number; a number is matched whole, so 4 is not in the quote's 42.
    const named = said("Stateless workers on sm_50 or a V100 lose nothing when they crash.");
    assert.deepEqual(named.problems, []);
    const part = research.addClaim("r-1", "lane-1", {
      text: "The harness archived 4 pages in its first run.",
      quotes: [{ source: a.source, quote: "The harness archived 42 pages in its first run." }],
    });
    assert.deepEqual(part.problems, ["the number 4 is not in the claim's quotes"]);
    // Without the heading, and the question given in its field, the same claim is verified.
    const ok = research.addClaim("r-1", "lane-1", {
      text: quote,
      quotes: [{ source: a.source, quote }],
      question: 0,
    });
    assert.equal(ok.verified, true);
    const events = env.service.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "claim_added")
      .map((e) => e.body as Record<string, unknown>);
    assert.deepEqual(events.at(0)?.problems, q.problems);
    assert.deepEqual(events.at(-1)?.problems, []);
    await w.close();
  });

  test("a claim_added event carries at most 20 problems, and counts the rest", async () => {
    const w = await web();
    const { env, research } = await researchEnv();
    const a = (await research.fetch("r-1", "lane-1", `${w.base}/a.html`)) as { source: string };
    const numbers = Array.from({ length: 25 }, (_, i) => String(100 + i)).join(", ");
    const r = research.addClaim("r-1", "lane-1", {
      text: `Workers crashed ${numbers} times.`,
      quotes: [{ source: a.source, quote: "Stateless workers lose nothing when they crash." }],
    });
    assert.equal(r.problems.length, 25);
    const body = env.service.ledger
      .eventsAfter(0, 10_000)
      .events.filter((e) => e.kind === "claim_added")
      .at(-1)?.body as { problems: string[]; more_problems?: number };
    assert.deepEqual(body.problems, r.problems.slice(0, 20));
    assert.equal(body.more_problems, 5);
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

  test("a registrable domain is what one owner registers: public suffixes of more than one label are kept in code", () => {
    const cases: [string, string][] = [
      ["docs.example.com", "example.com"],
      ["blog.example.com", "example.com"],
      ["Example.COM.", "example.com"],
      ["example.com", "example.com"],
      ["www.bbc.co.uk", "bbc.co.uk"],
      ["research.ox.ac.uk", "ox.ac.uk"],
      ["www.gov.uk", "www.gov.uk"],
      ["gov.uk", "gov.uk"],
      ["news.abc.net.au", "abc.net.au"],
      ["www.example.co.jp", "example.co.jp"],
      ["alice.github.io", "alice.github.io"],
      ["bob.github.io", "bob.github.io"],
      ["github.io", "github.io"],
      ["docs.nvidia.com", "nvidia.com"],
      ["my-bucket.s3.amazonaws.com", "my-bucket.s3.amazonaws.com"],
      ["127.0.0.1", "127.0.0.1"],
      ["[::1]", "::1"],
      ["localhost", "localhost"],
    ];
    for (const [host, want] of cases) assert.equal(registrableDomain(host), want, host);
  });

  test("corroboration counts registrable domains: two hosts of one site are one domain", async () => {
    const { env, research } = await researchEnv();
    const dir = mkdtempSync(join(env.service.paths.stateDir, "sites-"));
    const quote = "Fresh workers that start from the ledger lose nothing that matters.";
    const archive = (id: string, url: string) => {
      const text = join(dir, `${id}.txt`);
      writeFileSync(text, `A page that says: ${quote}`);
      env.service.ledger.db
        .prepare(
          `insert into source (id, run, url, final_url, domain, fetched_at, http_status, content_type, bytes, sha256,
             title, raw_path, text_path, fetched_by) values (?, 'r-1', ?, ?, ?, ?, 200, 'text/plain', 1, ?, null, ?, ?, 'lane-1')`,
        )
        .run(id, url, url, new URL(url).hostname, new Date().toISOString(), id, text, text);
    };
    archive("s-000000000001", "https://docs.example.com/a");
    archive("s-000000000002", "https://blog.example.com/b");
    archive("s-000000000003", "https://www.example.org/c");
    const same = research.addClaim("r-1", "lane-1", {
      text: "Fresh workers lose nothing that matters.",
      quotes: [
        { source: "s-000000000001", quote },
        { source: "s-000000000002", quote },
      ],
      question: 0,
    });
    assert.equal(same.verified, true);
    let stats = research.stats("r-1");
    assert.equal(
      stats.domains,
      2,
      "docs.example.com and blog.example.com are one, example.org another",
    );
    assert.equal(stats.corroborated, 0, "two hosts of one site are one independent source");
    const two = research.addClaim("r-1", "lane-1", {
      text: "Workers that start fresh from the ledger lose nothing that matters.",
      quotes: [
        { source: "s-000000000001", quote },
        { source: "s-000000000003", quote },
      ],
      question: 0,
    });
    assert.equal(two.verified, true);
    stats = research.stats("r-1");
    assert.equal(stats.corroborated, 1);
  });

  test("paused time does not count on the research clock", async () => {
    const { env, research } = await researchEnv({ min_duration: "1h", max_duration: "2h" });
    env.service.ledger.setRunStatus("r-1", "paused", "t", "t");
    await new Promise((r) => setTimeout(r, 300));
    const paused = research.clock("r-1").elapsed_ms;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(research.clock("r-1").elapsed_ms, paused);
  });

  test("time the agents could not run does not count, and the minimum is never a stop (goal 079)", async () => {
    // No maximum: the minimum is a floor; the run never ends by its clock.
    const { env, research } = await researchEnv({ min_duration: "1s", max_duration: undefined });
    const ledger = env.service.ledger;
    await new Promise((r) => setTimeout(r, 1100));
    const c0 = research.clock("r-1");
    assert.ok(c0.elapsed_ms >= 1000);
    assert.equal(c0.max_ms, null);
    assert.equal(c0.done, false, "past its minimum, a run with no maximum goes on");
    // The agents stop (no credits): the clock stops with them, until they go on.
    ledger.appendEvent("scheduler", "agents_stopped", "r-1", { kind: "credits", words: "402" });
    await new Promise((r) => setTimeout(r, 300));
    const stopped = research.clock("r-1");
    assert.ok(stopped.elapsed_ms - c0.elapsed_ms < 150, "the clock stopped");
    assert.ok(stopped.waited_ms >= 250);
    ledger.appendEvent("scheduler", "agents_resumed", "r-1", { why: "a model check passed" });
    await new Promise((r) => setTimeout(r, 200));
    const going = research.clock("r-1");
    assert.ok(going.elapsed_ms - stopped.elapsed_ms >= 150, "it runs again");
    // A wait for the provider's rate limit does not count either, until the time it named.
    ledger.appendEvent("scheduler", "agents_wait_for_limit", "r-1", {
      until: new Date(Date.now() + 60_000).toISOString(),
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(research.clock("r-1").elapsed_ms - going.elapsed_ms < 150, "waiting: stopped");
    // A wait for the run's MCP servers before its first trial (goal 068) does not count either.
    const { env: e3, research: r3 } = await researchEnv({
      min_duration: "1s",
      max_duration: undefined,
    });
    await new Promise((r) => setTimeout(r, 400));
    const before = r3.clock("r-1");
    e3.service.ledger.appendEvent("scheduler", "mcp_servers_wait", "r-1", {
      since: new Date(Date.now() - 300).toISOString(),
      waited_s: 0,
      missing: [],
    });
    const after = r3.clock("r-1");
    assert.ok(before.elapsed_ms - after.elapsed_ms >= 200, "the wait is taken off the clock");
    assert.ok(after.waited_ms >= 250, String(after.waited_ms));
    // With a maximum, the clock (not the minimum) ends it.
    const { research: r2 } = await researchEnv({ min_duration: "1s", max_duration: "2s" });
    assert.equal(r2.clock("r-1").done, false);
    assert.equal(r2.clock("r-1").max_ms, 2000);
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
