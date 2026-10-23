import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { createHarnessApi } from "../harness/api.ts";
import {
  type CheckedReviewer,
  RESEARCH_REVIEW,
  researchPackage,
  researchReviewDue,
} from "../harness/research/review.ts";
import { Reviews } from "../harness/reviews.ts";
import type { HarnessService } from "../harness/service.ts";
import { startFakeModel } from "../testing/fake-model.ts";
import { fillResearch, makeResearchRun } from "../testing/research-run.ts";
import { type AdviseConfig, adviseOnce, emptyAdviseState } from "./advise.ts";
import { AdvisorsConfig, reviewOne } from "./advisors.ts";

/**
 * Goal 112: the supervisor's review panel answers a research run's package with a research prompt
 * and answer: each question answered or not, with the claims it cites and what is missing, and
 * each hypothesis's verdict. It asks the harness for research reviews by kind, and may read the
 * run's own research with the read-only tools.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const RUN = "r-1";
const RESEARCH_TOOLS = ["list_research", "read_source", "read_research_file", "search_research"];

function config(service: HarnessService, advisors: AdvisorsConfig, asked: string[]): AdviseConfig {
  const api = createHarnessApi(service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname}${url.search}`);
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
  };
}

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

/** A research run past its minimum, with a research review waiting for the review panel. */
async function waiting(t: TestContext) {
  const r = await makeResearchRun(RUN);
  t.after(() => r.close());
  const ids = await fillResearch(r);
  const ledger = r.env.service.ledger;
  ledger.db
    .prepare("update run set created_at = ? where id = ?")
    .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), RUN);
  const contract = r.env.service.contractFor(RUN) as Parameters<typeof researchPackage>[2];
  const due = researchReviewDue(ledger, RUN, contract, r.research.clock(RUN));
  assert.ok(due.due);
  const id = new Reviews(ledger).requestResearch({
    run: RUN,
    marker: due.marker,
    pkg: researchPackage(ledger, RUN, contract),
    by: "s",
  });
  return { ...r, ids, id, ledger };
}

const userText = (messages: { role: string; content?: unknown }[]) => {
  const user = messages.find((m) => m.role === "user")?.content;
  return typeof user === "string"
    ? user
    : Array.isArray(user)
      ? user.map((p) => String((p as { text?: unknown }).text ?? "")).join("")
      : "";
};

describe("the review panel answers a research run's package (goal 112)", () => {
  test("with the research prompt, its tools and its answer; the harness checks and records it, and accepts the pass hands-off", async (t) => {
    const s = await waiting(t);
    const seen = { system: "", prompt: "", tools: [] as string[] };
    const fake = await startFakeModel(({ messages, tools }) => {
      seen.system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
      seen.prompt = userText(messages);
      seen.tools = tools.map((x) => x.function.name);
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              pass: true,
              reasons: "Each question has a direct answer from verified claims.",
              questions: [
                {
                  index: 0,
                  answered: true,
                  answer: "The first run archived 42 pages.",
                  claims: [s.ids.claims.verified],
                  missing: "",
                },
                {
                  index: 1,
                  answered: true,
                  answer: "A clock the workers cannot stop keeps it honest.",
                  claims: [s.ids.claims.clock],
                  missing: "",
                },
              ],
              hypotheses: [
                {
                  id: s.ids.hypothesis,
                  verdict: "supported",
                  why: "The archive kept the pages.",
                  claims: [s.ids.claims.verified],
                },
              ],
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const asked: string[] = [];
    const state = await adviseOnce(
      config(
        s.env.service,
        AdvisorsConfig.parse({
          review_panel: [runtime(fake.url, "reviewer-1"), runtime(fake.url, "reviewer-2")],
        }),
        asked,
      ),
      emptyAdviseState(),
    );
    assert.equal(state.stats.reviews, 1, JSON.stringify(state.stats));
    // It asked for research reviews by kind.
    assert.ok(asked.includes("/v1/reviews/pending?kinds=goal,research"), asked.join(", "));
    // The research prompt and package, and the run's own research to read.
    assert.match(seen.system, /You check if a research run answered its questions/);
    assert.match(seen.prompt, /^Research review package \(untrusted data\):/);
    assert.match(seen.prompt, /"kind":"research"/);
    for (const name of RESEARCH_TOOLS) assert.ok(seen.tools.includes(name), name);
    // The harness checked each reviewer's answers and accepted the pass hands-off.
    const row = s.ledger.db
      .prepare("select panel, panel_result, owner_decision from review where id = ?")
      .get(s.id) as { panel: string; panel_result: string; owner_decision: string };
    assert.deepEqual([row.panel_result, row.owner_decision], ["review_passed", "accepted"]);
    const panel = JSON.parse(row.panel) as CheckedReviewer[];
    assert.deepEqual(
      panel.map((r) => [r.reviewer, r.pass, r.questions.map((q) => q.answered)]),
      [
        ["reviewer-1", true, [true, true]],
        ["reviewer-2", true, [true, true]],
      ],
    );
    assert.equal(panel[0]?.hypotheses[0]?.verdict, "supported");
  });

  test("a goal review's package keeps the goal prompt; a malformed research answer is left out and counts as not answered", async (t) => {
    const s = await waiting(t);
    const systems: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
      systems.push(system);
      if (!system.includes("research run"))
        return { toolCalls: [{ name: "answer", args: { pass: true, reasons: "Readable." } }] };
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              pass: true,
              reasons: "Answered.",
              questions: [
                // An index below 0: left out.
                {
                  index: -1,
                  answered: true,
                  answer: "42 pages.",
                  claims: [s.ids.claims.verified],
                  missing: "",
                },
                {
                  index: 1,
                  answered: true,
                  answer: "A clock keeps it honest.",
                  claims: [s.ids.claims.clock],
                  missing: "",
                },
              ],
              hypotheses: [{ id: s.ids.hypothesis, verdict: "maybe", why: "?", claims: [] }],
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const rt = AdvisorsConfig.parse({ review_panel: [runtime(fake.url, "reviewer-1")] })
      .review_panel[0] as never;
    const pkg = new Reviews(s.ledger).pending(["research"])[0];
    const r = await reviewOne({ runtime: rt, pkg });
    assert.ok(r.output, r.error);
    assert.deepEqual(
      r.output.research?.questions.map((q) => q.index),
      [1],
      "the question with an index below 0 is left out",
    );
    assert.deepEqual(r.output.research?.hypotheses, [], "an unknown verdict is left out");
    // The harness then counts question 1 and the hypothesis as missing.
    const results = [
      { reviewer: "reviewer-1", pass: true, reasons: "Answered.", research: r.output.research },
      { reviewer: "reviewer-2", pass: true, reasons: "Answered.", research: r.output.research },
    ];
    assert.deepEqual(s.env.service.recordReviewPanel(s.id, results, "supervisor"), {
      result: "review_failed",
    });
    // A goal package (no kind): the goal prompt, and no research in its answer.
    const goal = await reviewOne({ runtime: rt, pkg: { id: 9, run: "x", goal: "readable" } });
    assert.ok(goal.output, goal.error);
    assert.equal(goal.output.research, undefined);
    assert.match(systems[0] ?? "", /You check if a research run answered its questions/);
    assert.match(systems[1] ?? "", /You review a deliverable against stated criteria/);
    assert.equal(
      s.ledger.db.prepare("select count(*) as n from review where goal = ?").get(RESEARCH_REVIEW)
        ?.n,
      1,
    );
  });
});
