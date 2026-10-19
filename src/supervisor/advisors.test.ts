import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { signEnvelope } from "../core/commands.ts";
import { createHarnessApi } from "../harness/api.ts";
import { startFakeModel } from "../testing/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../testing/judge-env.ts";
import { adviseOnce, emptyAdviseState } from "./advise.ts";
import { AdvisorsConfig, lastJsonObject, runAdvisor } from "./advisors.ts";
import { stageCommand } from "./staging.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };

function harnessFetch(env: ReturnType<typeof makeJudgeEnv>): typeof fetch {
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

const systemOf = (messages: { role: string; content?: unknown }[]) =>
  JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");

describe("advisors", () => {
  test("two teacher reviews become one cited directive set in the harness; uncited ones are dropped", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const fake = await startFakeModel(({ messages }) => {
      const system = systemOf(messages);
      const tools = messages.filter((m) => m.role === "tool").length;
      if (system.includes("neutral combiner")) {
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                directives: [
                  {
                    kind: "mandate",
                    family: "tiling",
                    rationale: "both reviews",
                    citations: ["arxiv:1"],
                  },
                  { kind: "try", family: "guesswork", rationale: "no source", citations: [] },
                ],
              },
            },
          ],
        };
      }
      // A teacher: read the brief first, then answer.
      if (tools === 0) return { toolCalls: [{ name: "brief", args: {} }] };
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              summary: "tiling looks promising",
              recommendations: [
                { kind: "try", family: "tiling", rationale: "paper", citations: ["arxiv:1"] },
              ],
            },
          },
        ],
      };
    });
    const runtime = (name: string) => ({
      name,
      runtime: "openai",
      base_url: fake.url,
      model: name,
      api_key_file: keyFile(),
    });
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime("teacher-a"), runtime("teacher-b")],
      combiner: runtime("combiner"),
    });
    const home = mkdtempSync(join(tmpdir(), "thermite-sup-"));
    const state = await adviseOnce(
      {
        harnessUrl: "http://harness",
        harnessToken: tokens.supervisor,
        home,
        advisors,
        fetchImpl: harnessFetch(env),
      },
      emptyAdviseState(),
    );
    await fake.close();
    assert.equal(state.stats.teacher_runs, 1, JSON.stringify(state.stats));
    assert.equal(state.stats.directive_sets, 1);
    const active = env.ledger
      .activeDirectives("js-1")
      .map((d) => d.body as { kind: string; family: string });
    assert.deepEqual(active, [
      { kind: "mandate", family: "tiling", rationale: "both reviews", citations: ["arxiv:1"] },
    ]);
    const record = readdirSync(join(home, "advisors")).find((f) => f.includes("teachers"));
    assert.match(readFileSync(join(home, "advisors", String(record)), "utf8"), /no citation/);
    // Not due again within the cadence.
    const again = await adviseOnce(
      {
        harnessUrl: "http://harness",
        harnessToken: tokens.supervisor,
        home,
        advisors,
        fetchImpl: harnessFetch(env),
      },
      state,
    );
    assert.equal(again.stats.teacher_runs, 1);
  });

  test("a command-line auditor can block a large win; the harness holds it", async () => {
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
        {
          run: "js-1",
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "h",
          known_flaws: [],
        },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "awaiting_audit");
    // A stand-in for a CLI agent: reads the prompt, prints logs, then its JSON answer.
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    const script = join(dir, "auditor.mjs");
    writeFileSync(
      script,
      `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log("thinking...");console.log(JSON.stringify({decision:s.includes("work.mjs")?"block":"clear",reasons:"the inner loop was removed; check the work is still done",citations:["diff"]}));});`,
    );
    const advisors = AdvisorsConfig.parse({
      auditor: {
        name: "cli-auditor",
        runtime: "cli",
        argv: [process.execPath, script],
        restricted: true,
      },
    });
    const state = await adviseOnce(
      {
        harnessUrl: "http://harness",
        harnessToken: tokens.supervisor,
        home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
        advisors,
        fetchImpl: harnessFetch(env),
      },
      emptyAdviseState(),
    );
    assert.equal(state.stats.audits, 1, JSON.stringify(state.stats));
    assert.equal(String(env.ledger.getAttempt(id)?.lifecycle), "audit_blocked");
  });

  test("the review panel passes a subjective goal, which still waits for the owner", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain();
    const fake = await startFakeModel(() => ({
      toolCalls: [{ name: "answer", args: { pass: true, reasons: "clear and small" } }],
    }));
    const runtime = (name: string) => ({
      name,
      runtime: "openai",
      base_url: fake.url,
      model: name,
      api_key_file: keyFile(),
    });
    const advisors = AdvisorsConfig.parse({
      panel: [runtime("reviewer-1"), runtime("reviewer-2")],
    });
    const state = await adviseOnce(
      {
        harnessUrl: "http://harness",
        harnessToken: tokens.supervisor,
        home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
        advisors,
        fetchImpl: harnessFetch(env),
      },
      emptyAdviseState(),
    );
    await fake.close();
    assert.equal(state.stats.reviews, 1, JSON.stringify(state.stats));
    const r = env.ledger.db.prepare("select panel_result, owner_decision from review").get();
    assert.deepEqual({ ...r }, { panel_result: "review_passed", owner_decision: null });
  });

  test("an advisor on an API key thinks at the effort chosen for it, and only then", async () => {
    const sent: (string | undefined)[] = [];
    const fake = await startFakeModel((req) => {
      sent.push(req.reasoning_effort);
      return { toolCalls: [{ name: "answer", args: { pass: true, reasons: "ok" } }] };
    });
    try {
      for (const reasoning of [undefined, "low", "high"] as const) {
        const r = await runAdvisor({
          runtime: {
            name: "panel-1",
            runtime: "openai",
            base_url: fake.url,
            model: "m",
            api_key: "k",
            ...(reasoning ? { reasoning } : {}),
            context_window: 200_000,
            max_tokens: 8192,
            max_turns: 24,
            timeout_s: 60,
            usd_per_mtok_in: 0,
            usd_per_mtok_out: 0,
          },
          system: "Grade it.",
          prompt: "The change.",
          schema: z.strictObject({ pass: z.boolean(), reasons: z.string() }),
          answerSchema: Type.Object({ pass: Type.Boolean(), reasons: Type.String() }),
        });
        assert.ok(r.output, r.error);
      }
    } finally {
      await fake.close();
    }
    assert.deepEqual(sent, [undefined, "low", "high"]);
  });

  test("a CLI agent's answer is found after its logs", () => {
    assert.deepEqual(lastJsonObject('log {"x": 1}\nmore\n{"a": {"b": 2}}\n'), { a: { b: 2 } });
    assert.equal(lastJsonObject("no json here"), undefined);
  });
});

describe("staging a propagation", () => {
  test("the published patch is fetched from the results repository into the inbox, checked by sha256", async () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-stage-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      }).trim();
    // The results repository as rig-a's supervisor pushed it.
    const remote = join(root, "results-remote.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "--quiet");
    const work = join(root, "work");
    mkdirSync(join(work, "champions", "js-1"), { recursive: true });
    const patch = "diff --git a/x b/x\n";
    writeFileSync(join(work, "champions", "js-1", "2.patch"), patch);
    git(work, "init", "--quiet", "-b", "thermite/rig-a/attempts");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "export");
    git(work, "push", "--quiet", remote, "thermite/rig-a/attempts");
    // rig-b's supervisor.
    const resultsRepo = join(root, "rig-b-results.git");
    mkdirSync(resultsRepo);
    git(resultsRepo, "init", "--bare", "--quiet");
    const inboxDir = join(root, "inbox");
    mkdirSync(inboxDir);
    const keys = (await import("../core/commands.ts")).generateSigningKeys();
    const cmd = (sha: string) =>
      signEnvelope(
        {
          v: 1,
          id: randomUUID(),
          rig: "rig-b",
          kind: "propagate",
          issued_by: "owner",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          payload: {
            run: "js-1",
            source_rig: "rig-a",
            source_run: "js-1",
            source_seq: 2,
            import: {
              kind: "champion_patch",
              path: "propagate/rig-a/js-1/2.patch",
              repo: "proj",
              base_commit: "a".repeat(40),
              tree: "b".repeat(40),
              sha256: sha,
            },
          },
        },
        keys.privateKeyPem,
      );
    const cfg = { rig: "rig-b", inboxDir, resultsRepo, remote: `file://${remote}` };
    assert.equal(await stageCommand(cfg, cmd("0".repeat(64))), "wait");
    const sha = createHash("sha256").update(patch).digest("hex");
    assert.equal(await stageCommand(cfg, cmd(sha)), "ready");
    assert.equal(
      readFileSync(join(inboxDir, "propagate", "rig-a", "js-1", "2.patch"), "utf8"),
      patch,
    );
  });
});
