import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { FAST_KERNEL, makeJudgeEnv, WRONG_KERNEL } from "../testing/judge-env.ts";
import { Scheduler } from "./agents/scheduler.ts";
import { createHarnessApi } from "./api.ts";
import { LocalRunner } from "./broker/runner.ts";
import { Conclusions } from "./conclusions.ts";
import { Reviews } from "./reviews.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

async function submit(env: ReturnType<typeof makeJudgeEnv>, kernel: string, flaws: string[] = []) {
  return (
    await env.service.submitAttempt(
      {
        instance: "js-1",
        patch_base64: env.patch(kernel),
        hypothesis: "h",
        known_flaws: flaws,
      },
      "test",
    )
  ).attempt;
}

const lowAudit = {
  acceptance: { looks: [3, 6], confirm_blocks: 4, audit: { ratio_to_median: 3, absolute: 0.15 } },
};

describe("directives", () => {
  test("the supervisor's set needs citations and replaces its last set; epochs record what steered them", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    await env.service.applyCommand(env.assign);
    assert.throws(
      () =>
        env.service.addDirectives(
          "js-1",
          [{ kind: "mandate", family: "tiling", rationale: "no source" }],
          "supervisor",
        ),
      /citation/,
    );
    assert.throws(() =>
      env.service.addDirectives(
        "js-1",
        [{ kind: "try", family: "x1", rationale: "r", citations: ["c"], verdict: "win_confirmed" }],
        "supervisor",
      ),
    );
    const first = env.service.addDirectives(
      "js-1",
      [{ kind: "avoid", family: "unrolling", rationale: "measured null", citations: ["a-1"] }],
      "supervisor",
    );
    const second = env.service.addDirectives(
      "js-1",
      [{ kind: "mandate", family: "tiling", rationale: "paper X", citations: ["arxiv:1"] }],
      "supervisor",
    );
    const active = env.ledger.activeDirectives("js-1").map((d) => d.id);
    assert.deepEqual(active, second);
    assert.ok(!active.includes(first[0] as number));
    // The fallback planner (no model reachable) must assign the mandated family, attributed.
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      runTrial: async () => ({
        stopped: "no_submission",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    });
    await scheduler.tick();
    await scheduler.idle();
    const epoch = scheduler.registry.currentEpoch("js-1");
    assert.deepEqual(epoch?.directives, second);
    const tiling = epoch?.assignments.find((a) => a.family === "tiling");
    assert.equal(tiling?.directive, second[0]);
    const ev = env.ledger.eventsAfter(0, 10_000).events.find((e) => e.kind === "epoch_started");
    assert.ok(ev);
    assert.deepEqual((ev.body as { directives: number[] }).directives, second);
  });
});

describe("audits", () => {
  test("a gain above the trigger waits for the audit; a block holds it, and only the owner can override", async () => {
    const env = makeJudgeEnv({ contract: lowAudit });
    await env.service.applyCommand(env.assign);
    const id = await submit(env, FAST_KERNEL);
    await env.drain();
    assert.equal(env.ledger.currentVerdict(id)?.verdict, "win_confirmed");
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "awaiting_audit");
    assert.equal(env.ledger.currentChampion("js-1").seq, 1);
    const api = createHarnessApi(env.service, tokens);
    const pending = (await (
      await api.request("/v1/audits/pending", { headers: auth(tokens.supervisor) })
    ).json()) as { audits: { attempt: string; reason: string; diff: string }[] };
    assert.equal(pending.audits[0]?.attempt, id);
    assert.match(pending.audits[0]?.reason ?? "", /gain/);
    assert.match(pending.audits[0]?.diff ?? "", /work\.mjs/);
    // The proposer token cannot decide audits.
    const forbidden = await api.request("/v1/audits", {
      method: "POST",
      headers: auth(tokens.proposer),
      body: JSON.stringify({ attempt: id, decision: "clear", reasons: "r", auditor: "x" }),
    });
    assert.equal(forbidden.status, 401);
    const blocked = await api.request("/v1/audits", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({
        attempt: id,
        decision: "block",
        reasons: "timer looks touched",
        auditor: "opus",
      }),
    });
    assert.equal(blocked.status, 200);
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "audit_blocked");
    // A second decision is refused: decisions are written once.
    const again = await api.request("/v1/audits", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({ attempt: id, decision: "clear", reasons: "r", auditor: "opus" }),
    });
    assert.equal(again.status, 409);
    assert.equal(env.ledger.currentChampion("js-1").seq, 1);
    const approved = await env.service.applyCommand(
      env.sign("approve_promotion", { instance: "js-1", attempt: id }),
    );
    assert.ok(approved.status === "applied" && approved.accepted, JSON.stringify(approved));
    assert.equal(env.ledger.currentChampion("js-1").attempt, id);
  });

  test("a cleared audit follows the promotion policy, but declared flaws always go to the owner", async () => {
    const env = makeJudgeEnv({ contract: lowAudit });
    await env.service.applyCommand(env.assign);
    const clean = await submit(env, FAST_KERNEL);
    await env.drain();
    await env.service.decideAudit({
      attempt: clean,
      decision: "clear",
      reasons: "ok",
      citations: [],
      auditor: "a",
    });
    assert.equal(String(env.ledger.getAttempt(clean)?.lifecycle), "promoted");

    const env2 = makeJudgeEnv({ contract: lowAudit });
    await env2.service.applyCommand(env2.assign);
    const flawed = await submit(env2, FAST_KERNEL, ["only tested on small inputs"]);
    await env2.drain();
    assert.equal(String(env2.ledger.getAttempt(flawed)?.lifecycle), "awaiting_audit");
    await env2.service.decideAudit({
      attempt: flawed,
      decision: "clear",
      reasons: "ok",
      citations: [],
      auditor: "a",
    });
    assert.equal(String(env2.ledger.getAttempt(flawed)?.lifecycle), "awaiting_approval");
    assert.equal(env2.ledger.currentChampion("js-1").seq, 1);
    const r = await env2.service.applyCommand(
      env2.sign("approve_promotion", { instance: "js-1", attempt: flawed }),
    );
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    assert.equal(env2.ledger.currentChampion("js-1").attempt, flawed);
  });
});

describe("propagation", () => {
  test("another unit's champion is judged by the receiving unit and accepted there", async () => {
    const a = makeJudgeEnv();
    await a.service.applyCommand(a.assign);
    const win = await submit(a, FAST_KERNEL);
    await a.drain();
    assert.equal(a.ledger.currentChampion("js-1").attempt, win);
    const exp = await a.service.export("test");
    const published = a.ledger
      .eventsAfter(0, 10_000)
      .events.find((e) => e.kind === "champion_published")?.body as {
      seq: number;
      repo: string;
      base_commit: string;
      tree: string;
      sha256: string;
      path: string;
    };
    assert.equal(published.seq, 2);

    const b = makeJudgeEnv({
      unit: "unit-b",
      share: { root: a.root, seed: a.seed, kitCommit: a.kitCommit },
    });
    await b.service.applyCommand(b.assign);
    // What B's supervisor does: fetch the patch from the results repository into B's inbox.
    const staged = join(b.paths.inboxDir, "propagate", "unit-a", "js-1", "2.patch");
    mkdirSync(dirname(staged), { recursive: true });
    copyFileSync(join(exp.dir, published.path), staged);
    const command = (over: Record<string, unknown> = {}) =>
      b.sign("propagate", {
        instance: "js-1",
        source_unit: "unit-a",
        source_instance: "js-1",
        source_seq: 2,
        import: {
          kind: "champion_patch",
          path: "propagate/unit-a/js-1/2.patch",
          repo: published.repo,
          base_commit: published.base_commit,
          tree: published.tree,
          sha256: published.sha256,
          ...over,
        },
      });
    // A tree or a file that does not match the signed values is refused.
    const badTree = await b.service.applyCommand(command({ tree: "0".repeat(40) }));
    assert.ok(badTree.status === "applied" && !badTree.accepted);
    assert.match(JSON.stringify(badTree.result), /tree mismatch/);
    const badSha = await b.service.applyCommand(command({ sha256: "f".repeat(64) }));
    assert.ok(badSha.status === "applied" && !badSha.accepted);
    const ok = await b.service.applyCommand(command());
    assert.ok(ok.status === "applied" && ok.accepted, JSON.stringify(ok));
    const attempt = (ok.result as { attempt: string }).attempt;
    await b.drain();
    assert.equal(b.ledger.currentVerdict(attempt)?.verdict, "win_confirmed");
    assert.equal(b.ledger.currentChampion("js-1").attempt, attempt);
    const { settlePropagations } = await import("./propagation.ts");
    settlePropagations(b.ledger, "t");
    const accepted = b.ledger
      .eventsAfter(0, 10_000)
      .events.find((e) => e.kind === "propagation_accepted")?.body as Record<string, unknown>;
    assert.deepEqual(
      { unit: accepted.source_unit, instance: accepted.source_instance, seq: accepted.source_seq },
      { unit: "unit-a", instance: "js-1", seq: 2 },
    );
    // The same tree as B's champion now: a second propagation is recognised as identical.
    const again = await b.service.applyCommand(command());
    assert.ok(again.status === "applied" && again.accepted);
    assert.equal((again.result as { identical?: boolean }).identical, true);
    assert.ok(readFileSync(staged).length > 0);
  });
});

describe("goal reviews and conclusions", () => {
  test("a subjective goal passes the panel, and is met only when the owner accepts it", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain(); // validates the seed and requests the review
    const reviews = new Reviews(env.ledger);
    const pending = reviews.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.goal, "readable");
    assert.ok(!JSON.stringify(pending[0]).includes("lane"));
    const id = pending[0]?.id as number;
    assert.throws(
      () => reviews.recordPanel(id, [{ reviewer: "one", pass: true, reasons: "fine" }], "s"),
      /at least 2/,
    );
    assert.equal(
      reviews.recordPanel(
        id,
        [
          { reviewer: "opus", pass: true, reasons: "clear" },
          { reviewer: "sol", pass: true, reasons: "clear" },
        ],
        "s",
      ),
      "review_passed",
    );
    const goalStatus = () =>
      String(
        env.ledger.db
          .prepare("select status from goal where instance = 'js-1' and id = 'readable'")
          .get()?.status,
      );
    await env.drain();
    assert.equal(goalStatus(), "not_runnable", "panel pass alone is not enough");
    const r = await env.service.applyCommand(
      env.sign("accept_review", { instance: "js-1", review: id, accept: true }),
    );
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    await env.drain();
    assert.equal(goalStatus(), "verified");
  });

  test("'not possible' is proposed from refuted approaches and needs the owner to end the campaign", async () => {
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 1e12 },
      contract: { infeasibility: { allowed: true, min_refuted_approaches: 1 } },
    });
    await env.service.applyCommand(env.assign);
    await env.drain();
    for (const k of [WRONG_KERNEL, `${WRONG_KERNEL}// b\n`, `${WRONG_KERNEL}// c\n`]) {
      const id = await submit(env, k);
      env.ledger.db.prepare("update attempt set family = 'closed-form' where id = ?").run(id);
      env.ledger.db
        .prepare(
          "insert or ignore into family (instance, id, description, created_by, created_at) values ('js-1', 'closed-form', 'd', 't', ?)",
        )
        .run(new Date().toISOString());
    }
    await env.drain();
    const c = new Conclusions(env.ledger);
    const open = c.open("js-1");
    assert.ok(open, "a proposal exists");
    assert.equal(env.ledger.getInstance("js-1")?.status, "running");
    const r = await env.service.applyCommand(
      env.sign("conclude", { instance: "js-1", proposal: Number(open?.id), accept: true }),
    );
    assert.ok(r.status === "applied" && r.accepted, JSON.stringify(r));
    assert.equal(env.ledger.getInstance("js-1")?.status, "closed");
  });
});

describe("supervisor limits", () => {
  test("the supervisor's token reads briefs and posts directives, but cannot submit or judge", async () => {
    const env = makeJudgeEnv({ heldOut: true });
    await env.service.applyCommand(env.assign);
    const api = createHarnessApi(env.service, tokens);
    const brief = await api.request("/v1/brief?instance=js-1", {
      headers: auth(tokens.supervisor),
    });
    assert.equal(brief.status, 200);
    const text = await brief.text();
    assert.ok(!text.includes("held"), "no held-out cells in a brief");
    const attempt = await api.request("/v1/attempts", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({
        instance: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "h",
      }),
    });
    assert.equal(attempt.status, 401);
    const noBrief = await api.request("/v1/brief?instance=js-1", {
      headers: auth(tokens.proposer),
    });
    assert.equal(noBrief.status, 401);
  });
});
