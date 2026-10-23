import assert from "node:assert/strict";
import { researchPackage, researchReviewDue } from "../harness/research/review.ts";
import { Reviews } from "../harness/reviews.ts";
import { fillResearch, makeResearchRun } from "./research-run.ts";

/**
 * Goal 112's tests of the final paper: a research run (research-run.ts) whose review the review
 * panel passed and the harness accepted hands-off, two reviewers who answer it, and a paper that
 * holds against the harness's checks.
 */

export type ResearchIds = Awaited<ReturnType<typeof fillResearch>>;

/** A reviewer who answers both questions from the fixture's verified claims, and the hypothesis. */
export function goodReviewer(name: string, ids: ResearchIds) {
  return {
    reviewer: name,
    pass: true,
    reasons: "Both questions are answered by verified claims.",
    research: {
      questions: [
        {
          index: 0,
          answered: true,
          answer: "The first run archived 42 pages.",
          claims: [ids.claims.verified],
          missing: "",
        },
        {
          index: 1,
          answered: true,
          answer: "A clock the workers cannot stop keeps a long campaign honest.",
          claims: [ids.claims.clock],
          missing: "",
        },
      ],
      hypotheses: [
        {
          id: ids.hypothesis,
          verdict: "supported" as const,
          why: "The archive kept every page the workers read.",
          claims: [ids.claims.verified],
        },
      ],
    },
  };
}

/**
 * A research run past its minimum whose review the review panel passed, accepted hands-off: it
 * now waits for its paper once its supervisor says it has a final writer. Close it when done.
 */
export async function answeredResearchRun(run = "r-1") {
  const r = await makeResearchRun(run);
  const ids = await fillResearch(r);
  const ledger = r.env.service.ledger;
  ledger.db
    .prepare("update run set created_at = ? where id = ?")
    .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), run);
  const contract = r.env.service.contractFor(run) as Parameters<typeof researchPackage>[2];
  const due = researchReviewDue(ledger, run, contract, r.research.clock(run));
  assert.ok(due.due);
  const review = new Reviews(ledger).requestResearch({
    run,
    marker: due.marker,
    pkg: researchPackage(ledger, run, contract),
    by: "s",
  });
  assert.deepEqual(
    r.env.service.recordReviewPanel(
      review,
      [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
      "supervisor",
    ),
    { result: "review_passed", accepted: true },
  );
  return { ...r, ids, ledger, review };
}

/**
 * A paper that holds against the harness's checks: every part in order, a section for each
 * question citing its claim, the review panel's verdict, and only numbers the claims or the
 * figures give. `over` replaces a part by its key.
 */
export function goodPaper(ids: ResearchIds, over: Partial<Record<string, string>> = {}): string {
  const v = ids.claims.verified;
  const c = ids.claims.clock;
  const parts = {
    title: "# What the first runs of the harness show",
    summary: `## Summary\n\nThe first run archived 42 pages [${v}]. A clock that the workers cannot stop keeps a long campaign honest [${c}].`,
    questions:
      "## Questions\n\n1. How much did the first run archive?\n2. What keeps a long campaign honest?",
    method:
      "## Method\n\nThe workers found 2 sources on 1 site. The harness archived each source, and it verified 2 claims against the archived text.",
    results: `## Results\n\n### Question 1: How much did the first run archive?\n\nThe first run archived 42 pages [${v}].\n\n### Question 2: What keeps a long campaign honest?\n\nA long campaign needs a clock that the workers cannot stop [${c}].`,
    hypotheses: `## Hypotheses\n\n### Hypothesis ${ids.hypothesis}: stateless workers make long runs safe\n\nVerdict: supported\n\nThe archive kept every page that the workers read [${v}].`,
    limits:
      "## Limits of the evidence\n\nAll the claims come from 1 site. 1 claim stays a draft, and 1 finding stays a draft.",
    next: `## Next experiments\n\nFind a second site that gives the number of pages [${v}].`,
    ...over,
  };
  return `${Object.values(parts).join("\n\n")}\n`;
}

/** The STE result of a rig with no checker. */
export const NO_STE = { checked: false, why: "the rig has no STE checker" } as const;
