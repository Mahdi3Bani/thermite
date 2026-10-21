import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeCompactionEnv, newClaudeTally, readClaudeEvents } from "./claude-code.ts";
import { type CliCompacted, CliCompactions, compactionTokens } from "./cli-compaction.ts";
import { codexConfig, newCodexTally, readCodexEvents } from "./codex.ts";
import { opencodeConfig } from "./opencode.ts";

/**
 * Compaction in OpenCode v2, the Codex CLI and Claude Code (goal 070): each one's own settings
 * from the route's window (the owner's cap) and compaction point, and each compaction a harness
 * reports, with the conversation as Thermite saw it.
 */

const capped = {
  baseUrl: "https://p.example/v1",
  model: "m-1",
  apiKey: "k",
  contextWindow: 131_072,
  maxTokens: 0,
};

describe("compaction settings in each harness's own terms", () => {
  test("the compaction point: a share of the route's window, 80% unless set", () => {
    assert.equal(compactionTokens(capped), 104_857);
    assert.equal(compactionTokens({ ...capped, compactAt: 60 }), 78_643);
    assert.equal(
      compactionTokens({ ...capped, contextWindow: 0 }),
      undefined,
      "no window, no point",
    );
  });

  test("OpenCode: the model's window is the route's, and its buffer puts the point at the share", () => {
    const c = opencodeConfig({ ...capped, compactAt: 70 }, "http://h/v1/model-proxy") as {
      compaction: { auto: boolean; buffer?: number };
      providers: { thermite: { models: Record<string, { limit?: { context: number } }> } };
    };
    assert.deepEqual(c.providers.thermite.models["m-1"]?.limit, { context: 131_072 });
    // OpenCode compacts at its window less the buffer: 131,072 - 39,322 = 91,750 (70%).
    assert.deepEqual(c.compaction, { auto: true, buffer: 39_322 });
    assert.equal(
      131_072 - (c.compaction.buffer as number),
      compactionTokens({ ...capped, compactAt: 70 }),
    );
    // No window known: no limit, and OpenCode's own buffer.
    const open = opencodeConfig({ ...capped, contextWindow: 0 }, "http://h") as typeof c;
    assert.deepEqual(open.compaction, { auto: true });
    assert.equal(open.providers.thermite.models["m-1"]?.limit, undefined);
    // OpenCode's own models keep what OpenCode knows of them.
    const own = opencodeConfig({ ...capped, api: "opencode" }, "http://h") as typeof c;
    assert.deepEqual(own.compaction, { auto: true });
    assert.equal(own.providers, undefined);
  });

  test("Codex: the window and the token limit at which it compacts, before its tables", () => {
    const c = codexConfig({ ...capped, compactAt: 85 }, "http://h/v1/model-proxy");
    assert.match(c, /^model_context_window = 131072$/m);
    assert.match(c, /^model_auto_compact_token_limit = 111411$/m);
    assert.ok(
      c.indexOf("model_auto_compact_token_limit") < c.indexOf("[model_providers.thermite]"),
    );
    assert.match(codexConfig(capped, "http://h"), /^model_auto_compact_token_limit = 104857$/m);
    const open = codexConfig({ ...capped, contextWindow: 0 }, "http://h");
    assert.doesNotMatch(open, /model_context_window|model_auto_compact_token_limit/);
  });

  test("Claude Code: its compaction window and its percent, from the route", () => {
    assert.deepEqual(claudeCompactionEnv({ contextWindow: 200_000, compactAt: 75 }), {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75",
    });
    assert.deepEqual(claudeCompactionEnv({ contextWindow: 0 }), {
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
    });
  });
});

describe("compactions a harness reports", () => {
  test("Claude Code's compact boundary is a compaction, with its tokens before and after", () => {
    const t = newClaudeTally();
    const live = readClaudeEvents(
      [
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", content: [{ type: "text", text: "Reading the kernel." }] },
        }),
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 160_512, post_tokens: 18_204 },
        }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m2", content: [{ type: "text", text: "Going on after it." }] },
        }),
        JSON.stringify({ type: "system", subtype: "init" }),
      ],
      t,
    );
    assert.deepEqual(t.compactions, [{ at: 1, tokensBefore: 160_512, tokensAfter: 18_204 }]);
    assert.deepEqual(
      live.map((l) => l.text),
      ["Reading the kernel.", "Going on after it."],
    );
  });

  test("Codex's warning after its own compaction is a compaction, said in words instead", () => {
    const t = newCodexTally();
    const live = readCodexEvents(
      [
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_1", type: "agent_message", text: "Building it." },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_2",
            type: "error",
            message:
              "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_3", type: "error", message: "something else went wrong" },
        }),
      ],
      t,
    );
    assert.deepEqual(t.compactions, [{ at: 1, tokensBefore: null, tokensAfter: null }]);
    assert.deepEqual(
      live.map((l) => l.text),
      ["Building it.", "(Codex: something else went wrong)"],
    );
  });

  test("each compaction keeps the conversation as Thermite saw it until then", () => {
    const got: CliCompacted[] = [];
    const c = new CliCompactions({
      title: "Trial t-1 (lane-1)",
      harness: "Claude Code",
      on: (x) => got.push(x),
    });
    c.take(
      [
        { kind: "text", text: "first" },
        { kind: "tool", text: "Bash make" },
        { kind: "text", text: "after the compaction" },
      ],
      [{ at: 2, tokensBefore: 150_000, tokensAfter: 20_000 }],
    );
    c.take([{ kind: "text", text: "later" }], [{ at: 1, tokensBefore: null, tokensAfter: null }]);
    assert.equal(c.count, 2);
    assert.deepEqual(
      got.map((g) => [g.number, g.tokensBefore, g.tokensAfter]),
      [
        [1, 150_000, 20_000],
        [2, null, null],
      ],
    );
    const first = got[0]?.markdown ?? "";
    assert.match(
      first,
      /^# Trial t-1 \(lane-1\): the conversation before compaction 1, as Thermite saw it/,
    );
    assert.match(first, /## 1\. text\n\n```text\nfirst\n```/);
    assert.match(first, /## 2\. tool\n\n```text\nBash make\n```/);
    assert.doesNotMatch(first, /after the compaction/, "only what came before it");
    assert.match(
      got[1]?.markdown ?? "",
      /## 3\. text\n\n```text\nafter the compaction\n```[\s\S]*## 4\. text\n\n```text\nlater/,
    );
  });
});
