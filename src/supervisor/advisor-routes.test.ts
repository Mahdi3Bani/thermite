import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fetchControlAdvisors, mergeAdvisors, runtimeOf } from "./advisor-routes.ts";
import { AdvisorsConfig } from "./advisors.ts";

const route = (o: Partial<Record<string, unknown>> = {}) => ({
  name: "p",
  type: "anthropic",
  base_url: "https://api.anthropic.com",
  model: "claude-test",
  context_window: 0,
  reasoning: "medium",
  api_key: "key-in-memory",
  ...o,
});

describe("advisors from control", () => {
  test("a Claude subscription's role runs in Claude Code; an API key's or a ChatGPT sign-in's runs here; OpenCode's own is skipped", () => {
    assert.deepEqual(
      runtimeOf(
        route({ type: "claude", model: "claude-opus-5-5", effort: "max", api_key: "tok" }),
        "auditor",
      ),
      {
        name: "auditor",
        runtime: "claude-code",
        model: "claude-opus-5-5",
        token: "tok",
        effort: "max",
        timeout_s: 1800,
      },
    );
    const keyed = runtimeOf(route(), "teacher-1");
    assert.equal(keyed?.runtime, "openai");
    assert.equal(keyed?.runtime === "openai" && keyed.api, "anthropic");
    assert.equal(keyed?.runtime === "openai" && keyed.api_key, "key-in-memory");
    assert.equal(keyed?.runtime === "openai" && keyed.reasoning, "medium");
    assert.equal(runtimeOf(route({ type: "opencode" }), "x"), undefined);
    // A ChatGPT sign-in runs here too, on OpenAI's Responses API with its access token.
    const signedIn = runtimeOf(
      route({ type: "chatgpt", base_url: "https://api.openai.com/v1", api_key: "access" }),
      "reviewer-1",
    );
    assert.equal(signedIn?.runtime === "openai" && signedIn.api, "chatgpt");
    assert.equal(signedIn?.runtime === "openai" && signedIn.api_key, "access");
  });

  test("each role runs in the harness its route names: OpenCode (its own models too) or Codex", () => {
    // OpenCode's own models: no key, no base address.
    assert.deepEqual(
      runtimeOf(
        route({ type: "opencode", harness: "opencode", model: "big-pickle", api_key: "" }),
        "auditor",
      ),
      {
        name: "auditor",
        runtime: "opencode",
        api: "opencode",
        model: "big-pickle",
        context_window: 0,
        timeout_s: 1800,
      },
    );
    // A provider's model in OpenCode: its key stays in memory, for the call's proxy.
    assert.deepEqual(
      runtimeOf(route({ harness: "opencode", context_window: 200_000 }), "teacher-1"),
      {
        name: "teacher-1",
        runtime: "opencode",
        api: "anthropic",
        base_url: "https://api.anthropic.com",
        model: "claude-test",
        api_key: "key-in-memory",
        context_window: 200_000,
        timeout_s: 1800,
      },
    );
    // A ChatGPT sign-in in Codex, with its effort.
    assert.deepEqual(
      runtimeOf(
        route({
          type: "chatgpt",
          harness: "codex",
          base_url: "https://chatgpt.example.com/backend-api/codex",
          model: "gpt-sol",
          api_key: "access",
          reasoning: "high",
        }),
        "reviewer-1",
      ),
      {
        name: "reviewer-1",
        runtime: "codex",
        api: "chatgpt",
        base_url: "https://chatgpt.example.com/backend-api/codex",
        model: "gpt-sol",
        api_key: "access",
        reasoning: "high",
        context_window: 0,
        timeout_s: 1800,
      },
    );
    // Codex speaks only the Responses API: an Anthropic route in Codex is not run.
    assert.equal(runtimeOf(route({ harness: "codex" }), "x"), undefined);
    // Pi, named or not, runs here.
    assert.equal(runtimeOf(route({ harness: "pi" }), "x")?.runtime, "openai");
    // Each parses as the advisors file's runtimes do.
    for (const r of [
      runtimeOf(route({ harness: "opencode" }), "a"),
      runtimeOf(route({ type: "openai", harness: "codex" }), "b"),
    ])
      assert.deepEqual(AdvisorsConfig.parse({ auditor: r }).auditor, r);
  });

  test("control's roles replace the file's: one or two teachers, the merged by model, the review panel", async () => {
    const file = AdvisorsConfig.parse({
      teachers: [{ name: "t", runtime: "cli", argv: ["x"], restricted: true }],
      merged_by: { name: "m", runtime: "cli", argv: ["z"], restricted: true },
      teacher_minutes: 15,
    });
    const answering = (body: Record<string, unknown>) => async (): Promise<Response> =>
      Response.json(body);
    const from = (body: Record<string, unknown>) =>
      fetchControlAdvisors({
        rig: "rig-a",
        controlUrl: "http://control",
        controlToken: "t",
        fetchImpl: answering(body) as typeof fetch,
      });
    // Two teachers on two models, merged by a third: each teacher once, by its own model.
    const two = await from({
      teacher_models: [route({ model: "model-a" }), route({ type: "openai", model: "model-b" })],
      merged_by: route({ model: "model-c" }),
      auditor: null,
      review_panel: route({ model: "model-d" }),
      // What a supervisor of an earlier version reads: never used when the new names are there.
      teachers: route({ model: "model-a" }),
      combiner: route({ model: "model-old" }),
      panel: null,
    });
    assert.deepEqual(
      two.teachers?.map((t) => [t.name, t.runtime === "openai" ? t.model : ""]),
      [
        ["teacher-1", "model-a"],
        ["teacher-2", "model-b"],
      ],
    );
    assert.equal(two.merged_by?.name, "merged-by");
    assert.equal(two.merged_by?.runtime === "openai" && two.merged_by.model, "model-c");
    assert.equal(two.review_panel?.length, 3);
    // One teacher: one runtime. No teacher models from control: the file's teachers stay, and
    // control's merged by model (none here) leaves the file's.
    const one = await from({ teacher_models: [route()], merged_by: null, review_panel: null });
    assert.deepEqual(
      one.teachers?.map((t) => t.name),
      ["teacher-1"],
    );
    const none = await from({ teacher_models: [], merged_by: null, review_panel: null });
    assert.equal(none.teachers, undefined);
    const merged = mergeAdvisors(file, none);
    assert.equal(merged?.teachers[0]?.name, "t");
    assert.equal(merged?.merged_by?.name, "m");
  });

  test("the advisors file takes merged_by and review_panel, and still the old names combiner and panel", () => {
    const cli = (name: string) => ({ name, runtime: "cli", argv: ["x"], restricted: true });
    const old = AdvisorsConfig.parse({
      teachers: [cli("a"), cli("b")],
      combiner: cli("c"),
      panel: [cli("p1"), cli("p2")],
    });
    assert.equal(old.merged_by?.name, "c");
    assert.deepEqual(
      old.review_panel.map((p) => p.name),
      ["p1", "p2"],
    );
    assert.equal(Object.hasOwn(old, "combiner"), false, "the supervisor runs the new names only");
    const now = AdvisorsConfig.parse({ merged_by: cli("m"), review_panel: [cli("r1")] });
    assert.deepEqual([now.merged_by?.name, now.review_panel.length], ["m", 1]);
    assert.deepEqual(AdvisorsConfig.parse({}).review_panel, []);
    // Both names of one advisor: refused, in words.
    const both = AdvisorsConfig.safeParse({ merged_by: cli("m"), combiner: cli("c") });
    assert.equal(both.success, false);
    assert.match(
      String(both.error?.issues[0]?.message),
      /combiner is the old name of merged_by: give merged_by only/,
    );
    const panels = AdvisorsConfig.safeParse({ review_panel: [cli("r")], panel: [cli("p")] });
    assert.equal(panels.success, false);
    assert.equal(AdvisorsConfig.safeParse({ teachers: [], mergedby: cli("m") }).success, false);
  });

  test("a control of an earlier version: its one teachers' model runs as two teachers; its combiner and panel are the merged by model and the review panel", async () => {
    const file = AdvisorsConfig.parse({
      teachers: [{ name: "t", runtime: "cli", argv: ["x"], restricted: true }],
      auditor: { name: "a", runtime: "cli", argv: ["y"], restricted: true },
      teacher_minutes: 15,
    });
    const fake = (async (input: string | URL | Request) => {
      assert.match(String(input), /\/v1\/rigs\/rig-a\/advisor-routes$/);
      return Response.json({
        teachers: route({ type: "claude", model: "claude-sonnet-5-5", api_key: "tok" }),
        combiner: null,
        auditor: null,
        panel: route(),
      });
    }) as typeof fetch;
    const control = await fetchControlAdvisors({
      rig: "rig-a",
      controlUrl: "http://control",
      controlToken: "t",
      fetchImpl: fake,
    });
    assert.deepEqual(
      control.teachers?.map((t) => t.name),
      ["teacher-1", "teacher-2"],
    );
    assert.equal(control.review_panel?.length, 3);
    assert.equal(control.merged_by, undefined);
    const combined = await fetchControlAdvisors({
      rig: "rig-a",
      controlUrl: "http://control",
      controlToken: "t",
      fetchImpl: (async () =>
        Response.json({
          teachers: null,
          combiner: route(),
          auditor: null,
          panel: null,
        })) as typeof fetch,
    });
    assert.equal(combined.merged_by?.name, "merged-by");
    const merged = mergeAdvisors(file, control);
    assert.equal(merged?.teachers[0]?.runtime, "claude-code");
    assert.equal(merged?.auditor?.name, "a", "the file's auditor stays");
    assert.equal(merged?.teacher_minutes, 15);
    // No file and nothing from control: no advisors at all. An older control: its 404 changes nothing.
    assert.equal(mergeAdvisors(undefined, {}), undefined);
    const old = await fetchControlAdvisors({
      rig: "rig-a",
      controlUrl: "http://control",
      controlToken: "t",
      fetchImpl: (async () => new Response("no", { status: 404 })) as typeof fetch,
    });
    assert.deepEqual(old, {});
  });

  test("a Claude Code advisor gets the token on file descriptor 3 and in no environment, no tools, settings or scrub, and its answer is read", async () => {
    // A stand-in for Claude Code: it answers the audit with what it was given (never the token).
    // It reads the token where Claude Code does, from the descriptor its variable names.
    const dir = mkdtempSync(join(tmpdir(), "thermite-cc-adv-"));
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const a = process.argv.slice(2);
  const v = (f) => a[a.indexOf(f) + 1];
  const fd = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  const onFd = fd ? require("node:fs").readFileSync(Number(fd), "utf8") : "";
  const inEnv = Object.values(process.env).some((x) => x.includes("tok-advisor"));
  const said = ["token=" + (onFd === "tok-advisor" ? "fd" + fd : "missing"), "env=" + (inEnv ? "has-token" : "clean"), "tools=" + JSON.stringify(v("--tools")), "settings=" + JSON.stringify(v("--setting-sources")), "strict=" + a.includes("--strict-mcp-config"), "model=" + v("--model"), "effort=" + v("--effort"), "scrub=" + process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "prompt=" + (s.includes("look at this change") && s.length > 200000)].join(" ");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ decision: "clear", reasons: said, citations: [] }) }));
});
`,
    );
    chmodSync(bin, 0o755);
    process.env.THERMITE_CLAUDE_BIN = bin;
    const { runAdvisor, AuditAnswer } = await import("./advisors.ts");
    const { Type } = await import("@earendil-works/pi-ai");
    // The binary's path is read when the module loads: this test file loads it here first.
    const r = await runAdvisor({
      runtime: {
        name: "auditor",
        runtime: "claude-code",
        model: "claude-opus-5-5",
        token: "tok-advisor",
        effort: "high",
        timeout_s: 30,
      },
      system: "You audit changes.",
      // As large as an audit's package may be: more than one command-line argument may hold.
      prompt: `Please look at this change.\n${"x".repeat(200_000)}`,
      schema: AuditAnswer,
      answerSchema: Type.Object({}),
    });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.output?.decision, "clear");
    assert.equal(
      r.output?.reasons,
      'token=fd3 env=clean tools="" settings="" strict=true model=claude-opus-5-5 effort=high scrub=undefined prompt=true',
    );
  });
});
