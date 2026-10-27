import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";

test("an approval that fails after the champion moves leaves the record whole (goal 163)", async () => {
  const env = makeJudgeEnv({ realRuns: true, promotion: "owner_approval" });
  await env.start();
  const { attempt } = await env.service.submitAttempt(
    {
      run: "js-1",
      patch_base64: env.patch(FAST_KERNEL),
      hypothesis: "drop the wasted inner loop",
      known_flaws: ["it was only timed on the small case"],
    },
    "proposer",
  );
  await env.drain();
  // Declared flaws send it to an audit, which the owner's approval overrides.
  assert.equal(env.ledger.getAttempt(attempt)?.lifecycle, "awaiting_audit", env.explain(attempt));
  // The champion moves, then the git ref can't be written: the step after the ledger fails.
  env.service.syncChampionRef = async () => {
    throw new Error("git: no space left on device");
  };
  const out = await env.service.applyCommand(
    env.sign("approve_promotion", { run: "js-1", attempt }),
  );
  assert.equal(out.status, "applied");
  assert.equal(env.ledger.currentChampion("js-1").attempt, attempt);
  // The champion, its flaws' acceptance, the override and the lifecycle were written together.
  const a = env.ledger.getAttempt(attempt);
  assert.equal(a?.lifecycle, "promoted", env.explain(attempt));
  assert.equal(a?.flaws_cleared_by, "control:owner");
  const kinds = env.ledger
    .eventsAfter(0, 10_000)
    .events.filter((e) => e.subject === attempt || e.subject === "js-1")
    .map((e) => e.kind);
  assert.ok(kinds.includes("champion_promoted"));
  assert.ok(kinds.includes("flaws_accepted"));
  assert.ok(kinds.includes("audit_overridden"));
});
