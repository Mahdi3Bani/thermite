import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseContract } from "../core/contract.ts";
import { LocalRunner } from "../harness/broker/runner.ts";
import { ResearchFolder, SAVED_LANES_DIR } from "../harness/research/folder.ts";
import { Research } from "../harness/research/research.ts";
import { researchFixture } from "./fixtures.ts";
import { makeHarnessEnv } from "./harness-env.ts";

/**
 * A research run with some of everything its workers record (goal 098's tests): two sources from a
 * tiny local "web", claims verified and draft for two questions, a hypothesis, a supported and a
 * draft finding, a research note, a report section, a digest, and a lane's files saved as the
 * research folder saves them when a trial ends.
 */

const PAGES: Record<string, string> = {
  "/robots.txt": "User-agent: *\nAllow: /\n",
  "/a.html":
    "<html><head><title>Harness notes</title></head><body><p>The harness archived 42 pages in its first run.</p><p>Stateless workers lose nothing when they crash.</p></body></html>",
  "/b.html":
    "<html><head><title>Long campaigns</title></head><body><p>Long research campaigns need a clock the workers cannot stop.</p></body></html>",
};

export const RESEARCH_QUESTIONS = [
  "How much did the first run archive?",
  "What keeps a long campaign honest?",
];

/** The two pages on localhost: /a.html and /b.html. Close it when the test ends. */
export async function servePages(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const body = PAGES[req.url ?? ""];
    if (!body) return void res.writeHead(404).end("no");
    res
      .writeHead(200, { "content-type": req.url?.endsWith(".txt") ? "text/plain" : "text/html" })
      .end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * A research run on a fresh harness, with the tiny local web served. `contract` adds to (or
 * replaces) the fixture's contract fields; `assign` to the assignment's (ask_owner, say).
 */
export async function makeResearchRun(
  run = "r-1",
  o: { contract?: Record<string, unknown>; assign?: Record<string, unknown> } = {},
) {
  const env = makeHarnessEnv("rig-r");
  const parsed = parseContract({
    ...researchFixture,
    questions: RESEARCH_QUESTIONS,
    ...(o.contract ?? {}),
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", {
      run,
      contract: parsed.contract,
      contract_sha: parsed.sha,
      imports: [],
      ...(o.assign ?? {}),
    }),
  );
  if (!(out.status === "applied" && out.accepted)) throw new Error(JSON.stringify(out));
  const { base, close } = await servePages();
  const { stateDir, scratchDir } = env.service.paths;
  const folder = new ResearchFolder({
    ledger: env.service.ledger,
    scratchRoot: join(scratchDir, "research"),
    stateRoot: join(stateDir, SAVED_LANES_DIR),
    runner: new LocalRunner(scratchDir),
  });
  const research = new Research(env.service.ledger, stateDir, {
    allowPrivate: true,
    onChange: (r) => void folder.sync(r),
  });
  // As main.ts sets it: an accepted research paper is the folder's paper.md at once (goal 112).
  env.service.researchChanged = (r) => void folder.sync(r);
  return { env, research, folder, base, run, close };
}

/** Fills a run with one of each record; returns their ids. */
export async function fillResearch(r: Awaited<ReturnType<typeof makeResearchRun>>) {
  const { research, folder, base, run } = r;
  const a = (await research.fetch(run, "lane-1", `${base}/a.html`)) as { source: string };
  const b = (await research.fetch(run, "lane-2", `${base}/b.html`)) as { source: string };
  const verified = research.addClaim(run, "lane-1", {
    text: "The first run archived 42 pages.",
    quotes: [{ source: a.source, quote: "The harness archived 42 pages in its first run." }],
    question: 0,
  });
  const draft = research.addClaim(run, "lane-2", {
    text: "The first run archived 4200 pages.",
    quotes: [{ source: a.source, quote: "The harness archived 4200 pages in its first run." }],
    question: 1,
  });
  const clock = research.addClaim(run, "lane-2", {
    text: "Long campaigns need a clock the workers cannot stop.",
    quotes: [
      { source: b.source, quote: "Long research campaigns need a clock the workers cannot stop." },
    ],
    question: 1,
  });
  const hypothesis = research.proposeHypothesis(
    run,
    "lane-1",
    "Stateless workers make long runs safe.",
    [verified.claim],
  );
  const supported = research.addFinding(run, "lane-1", {
    text: "The harness kept its first run's pages.",
    summary: "It archived 42 pages in its first run, and kept them.",
    why_it_matters: "Nothing a worker read is lost.",
    supporting: [verified.claim],
  });
  const unsupported = research.addFinding(run, "lane-2", {
    text: "The first run was very large.",
    summary: "It archived 4200 pages.",
    why_it_matters: "Size matters for the archive.",
    supporting: [draft.claim],
  });
  const note = research.addNote(run, "lane-1", "Look for a second site that says the same.", [
    a.source,
  ]);
  research.updateSection(run, "lane-1", "synthesis", "Two sites so far.\nBoth agree.");
  const work = await folder.prepareLane(run, "lane-1", "agent-1");
  writeFileSync(
    join(work.work, "q0-synthesis.md"),
    "# Question 0\n\nWhat we know: the harness archived 42 pages.\nNext: a second site.\n",
  );
  writeFileSync(join(work.work, "weights.bin"), Buffer.from([0, 1, 2, 3]));
  await folder.captureLane(run, "lane-1", "t-1");
  research.report(run, "digest");
  return {
    sources: [a.source, b.source],
    claims: { verified: verified.claim, draft: draft.claim, clock: clock.claim },
    hypothesis: hypothesis.hypothesis,
    findings: { supported: supported.finding, draft: unsupported.finding },
    note: note.note,
  };
}
