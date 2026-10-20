import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { signEnvelope } from "../core/commands.ts";
import { createHarnessApi } from "../harness/api.ts";
import { startFakeModel } from "../testing/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../testing/judge-env.ts";
import { type AdviseConfig, adviseOnce, emptyAdviseState, teachersCalled } from "./advise.ts";
import { AdvisorsConfig, AuditAnswer, PanelAnswer, TeacherReview } from "./advisors.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
type Env = ReturnType<typeof makeJudgeEnv>;

function harnessFetch(env: Env): typeof fetch {
  const api = createHarnessApi(env.service, tokens);
  return async (input, init) => {
    const url = new URL(String(input));
    return api.request(`${url.pathname}${url.search}`, init as RequestInit);
  };
}

function keyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return join(dir, "key");
}

/** The owner's message, as control signs it. */
async function ownerSays(env: Env, to: string, text: string) {
  const out = await env.service.applyCommand(
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind: "message_agent",
        issued_by: "owner",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload: { run: "js-1", to, text },
      },
      env.keys.privateKeyPem,
    ),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
}

const bodies = (env: Env, kind: string) =>
  env.ledger
    .eventsAfter(0, 5000)
    .events.filter((e) => e.kind === kind)
    .map((e) => e.body as Record<string, unknown>);

function config(env: Env, advisors: AdvisorsConfig, lines: string[]): AdviseConfig {
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: harnessFetch(env),
    live: (l) => lines.push(`${l.run ?? "-"} ${l.kind}: ${l.text}`),
  };
}

const runtime = (url: string, name: string) => ({
  name,
  runtime: "openai",
  base_url: url,
  model: name,
  api_key_file: keyFile(),
});

describe("the owner's messages to the advisors", () => {
  test("an advisor's answers are optional and lenient: a long one is shortened, never a reason to lose its audit", () => {
    const long = "x".repeat(5000);
    const audit = AuditAnswer.parse({
      decision: "clear",
      reasons: "fine",
      answers: [{ message: "3", text: `  ${long}  ` }],
    });
    assert.deepEqual(
      audit.answers.map((a) => [a.message, a.text.length]),
      [[3, 1000]],
    );
    assert.deepEqual(PanelAnswer.parse({ pass: true, reasons: "ok" }).answers, []);
    assert.deepEqual(TeacherReview.parse({ summary: "s", recommendations: [] }).answers, []);
    // Answers that cannot be read are left out; the audit stands.
    const garbled = AuditAnswer.safeParse({
      decision: "block",
      reasons: "r",
      answers: [{ text: "no id" }],
    });
    assert.ok(garbled.success);
    assert.deepEqual(garbled.data?.answers, []);
    assert.equal(garbled.data?.decision, "block");
  });

  test("a new message to the teacher pair starts its round at once; each teacher answers it, the harness records the reads and answers, and every step is a live line", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const fake = await startFakeModel(({ messages }) => {
      const all = JSON.stringify(messages);
      if (all.includes("neutral combiner"))
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                directives: [
                  {
                    kind: "mandate",
                    family: "tiling",
                    rationale: "both reviews cite the paper",
                    citations: ["arxiv:1"],
                  },
                ],
              },
            },
          ],
        };
      // A teacher: it answers the owner's message when its brief has one to answer.
      const asked = all.includes('\\"answered\\":false');
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              summary: "tiling looks promising",
              recommendations: [
                { kind: "try", family: "tiling", rationale: "paper", citations: ["arxiv:1"] },
              ],
              ...(asked ? { answers: [{ message: 1, text: "We will weigh the paper." }] } : {}),
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime(fake.url, "teacher-a"), runtime(fake.url, "teacher-b")],
      combiner: runtime(fake.url, "combiner"),
    });
    const lines: string[] = [];
    const cfg = config(env, advisors, lines);
    let state = await adviseOnce(cfg, emptyAdviseState());
    assert.equal(state.stats.teacher_runs, 1);
    assert.equal(await teachersCalled(cfg, state), false);
    // Within the hour, nothing; a message from the owner calls the teachers at once.
    state = await adviseOnce(cfg, state);
    assert.equal(state.stats.teacher_runs, 1);
    await ownerSays(env, "teachers", "read the tiling paper first");
    assert.equal(await teachersCalled(cfg, state), true);
    state = await adviseOnce(cfg, state);
    assert.equal(state.stats.teacher_runs, 2);
    assert.equal(await teachersCalled(cfg, state), false, "one round per message");
    state = await adviseOnce(cfg, state);
    assert.equal(state.stats.teacher_runs, 2);
    assert.deepEqual(
      bodies(env, "agent_message_read").map((b) => [b.message, b.by]),
      [[1, "teachers"]],
    );
    assert.deepEqual(bodies(env, "advisor_answer"), [
      { message: 1, role: "teachers", text: "We will weigh the paper.", advisor: "teacher-a" },
      { message: 1, role: "teachers", text: "We will weigh the paper.", advisor: "teacher-b" },
    ]);
    const text = lines.join("\n");
    assert.match(text, /js-1 status: the teacher pair reviews js-1 now: the owner wrote to it/);
    assert.match(
      text,
      /js-1 text: teacher teacher-a: tiling looks promising Suggests: try tiling\./,
    );
    assert.match(
      text,
      /js-1 text: directives for the planner: mandate tiling \(why: both reviews cite the paper\)/,
    );
    assert.ok(
      env.service.live
        .since(0, 5000)
        .entries.some(
          (e) =>
            e.text ===
            "the teacher pair (teacher-b) answered the owner's message #1: We will weigh the paper.",
        ),
    );
  });

  test("the auditor finds the owner's message in its package and answers it; its audit is posted as before", async () => {
    const env = makeJudgeEnv({
      contract: {
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 0.15 },
        },
      },
    });
    await env.service.applyCommand(env.assign);
    const id = (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "awaiting_audit");
    await ownerSays(env, "auditor", "be strict about timing changes");
    // A command-line auditor: it is told the answer's shape and finds the message in its input.
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    const script = join(dir, "auditor.mjs");
    writeFileSync(
      script,
      `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const told=s.includes("be strict about timing changes")&&s.includes('"answers"');console.log(JSON.stringify({decision:"block",reasons:"the inner loop was removed",citations:["diff"],answers:told?[{message:1,text:"Noted: I checked the timing code."}]:[]}));});`,
    );
    const advisors = AdvisorsConfig.parse({
      auditor: {
        name: "cli-auditor",
        runtime: "cli",
        argv: [process.execPath, script],
        restricted: true,
      },
    });
    const lines: string[] = [];
    const state = await adviseOnce(config(env, advisors, lines), emptyAdviseState());
    assert.equal(state.stats.audits, 1, JSON.stringify(state.stats));
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "audit_blocked");
    assert.deepEqual(bodies(env, "advisor_answer"), [
      {
        message: 1,
        role: "auditor",
        text: "Noted: I checked the timing code.",
        advisor: "cli-auditor",
      },
    ]);
    assert.match(
      lines.join("\n"),
      new RegExp(
        `js-1 text: audit of ${id} \\(try 1\\): block, blocked\\. the inner loop was removed`,
      ),
    );
    // Read once: the next package carries it no more.
    const pending = (await env.service.auditPackages())[0];
    assert.deepEqual(pending?.owner_messages ?? [], []);
  });

  test("each panelist answers the owner's message; the panel's results are posted without the answers", async (t: TestContext) => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain();
    await ownerSays(env, "panel", "judge readability strictly");
    const fake = await startFakeModel(({ messages }) => ({
      toolCalls: [
        {
          name: "answer",
          args: {
            pass: true,
            reasons: "clear and small",
            ...(JSON.stringify(messages).includes("judge readability strictly")
              ? { answers: [{ message: 1, text: "Strictly judged." }] }
              : {}),
          },
        },
      ],
    }));
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      panel: [runtime(fake.url, "reviewer-1"), runtime(fake.url, "reviewer-2")],
    });
    const lines: string[] = [];
    const state = await adviseOnce(config(env, advisors, lines), emptyAdviseState());
    assert.equal(state.stats.reviews, 1, JSON.stringify(state.stats));
    const r = env.ledger.db.prepare("select panel_result from review").get();
    assert.equal(r?.panel_result, "review_passed");
    assert.deepEqual(
      bodies(env, "advisor_answer").map((b) => [b.role, b.advisor, b.text]),
      [
        ["panel", "reviewer-1", "Strictly judged."],
        ["panel", "reviewer-2", "Strictly judged."],
      ],
    );
    assert.match(lines.join("\n"), /review 1 of goal readable, reviewer-1: pass\. clear and small/);
    assert.match(
      lines.join("\n"),
      /review 1: the panel passed it; it waits for the owner's acceptance/,
    );
  });
});
