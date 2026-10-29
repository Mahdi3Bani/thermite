// Test only (check.mjs, in the harness image): one short trial through the trial loop's terminal
// mode (src/harness/agents/cli/terminal.ts), under the real broker as lane-1, for each program the
// image has: the fake TUI (tests/helpers/fake-tui.ts) in Claude Code's place, writing a transcript
// as Claude Code does; the real Codex CLI; and the real OpenCode, its server and its terminal.
// Codex and OpenCode reach the stand-in model (model.mjs), which answers each call with text, so
// each trial is its first message, the loop's nudge typed into the terminal, and its end: no
// submission, with each turn's end read from the session log, its usage counted, its screen kept,
// the program ended its own way, and nothing of the lane's left running.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startModel } from "./model.mjs";

const AT = "2026-10-29T05:52:16.107Z";

/** The fake's script: one turn with a tool call, then turns that do nothing. */
function fakeScript() {
  const s = "{session}";
  const said = (text) => ({
    type: "user",
    sessionId: s,
    origin: { kind: "human" },
    message: { content: text },
  });
  const ended = { type: "system", sessionId: s, subtype: "turn_duration" };
  const assistant = (id, content, usage) => ({
    type: "assistant",
    sessionId: s,
    timestamp: AT,
    message: { id, model: "claude-test", content, usage },
  });
  return {
    log: ".claude/projects/check/{session}.jsonl",
    turns: [
      [
        {
          lines: [
            said("go"),
            assistant(
              "msg_1",
              [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "make" } }],
              { input_tokens: 10, output_tokens: 2 },
            ),
            {
              type: "user",
              sessionId: s,
              message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
            },
            assistant("msg_2", [{ type: "text", text: "Tried it." }], {
              input_tokens: 20,
              output_tokens: 5,
            }),
            ended,
          ],
        },
      ],
    ],
    rest: [{ lines: [said("x"), ended] }],
  };
}

/** Runs the loop's trials; `c` is check.mjs's: its loader, runner, checks and lane helpers. */
export async function loopTrials(c) {
  const { runCliTrial, claudeProgram, codexProgram, opencodeProgram } = await c.load(
    "harness/agents/cli/index",
  );
  const before = {
    claude: process.env.THERMITE_CLAUDE_BIN,
    codex: process.env.THERMITE_CODEX_BIN,
    opencode: process.env.THERMITE_OPENCODE_BIN,
  };
  const api = await startModel();
  const restore = (k, v) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  try {
    /** One code trial of lane-1 in its terminal; what it gave, and what it kept and showed. */
    const trial = async (name, p, model, files) => {
      const a = await c.area(`loop-${name}`, files);
      const sent = [];
      const live = [];
      const started = Date.now();
      const r = await runCliTrial(
        p,
        {
          mode: "code",
          spec: {
            trialId: `check-loop-${name}`,
            token: "check",
            run: "check-run",
            lane: c.LANE,
            workspace: a.repo,
            workspaceRoot: a.dir,
            parentCommit: "c".repeat(40),
            editablePaths: ["notes.txt"],
            brief: "TERMINAL-CHECK-1: reply.",
          },
        },
        {
          runner: c.runner,
          model,
          // Codex's and OpenCode's model proxy is the stand-in model: its paths end as the APIs'.
          apiUrl: `http://127.0.0.1:${api.port}`,
          live: (entries) => live.push(...entries.map((e) => e.text)),
          progress: () => undefined,
          sent: (q) => sent.push(q),
          env: a.env ?? {},
          pollMs: 200,
          terminal: true,
        },
      );
      await c.runner.killRole(c.LANE).catch(() => 0);
      await c.sleep(500);
      const screen = join(a.dir, `${p.prefix}-screen.ansi`);
      return {
        a,
        r,
        sent,
        live,
        seconds: Math.round((Date.now() - started) / 1000),
        screen: existsSync(screen) ? readFileSync(screen, "utf8") : "",
        left: c.laneProcesses(),
      };
    };
    const ended = (name, t, more) =>
      c.check(
        `${name}: a trial through the loop's terminal mode: its first message, a nudge typed, its turns' ends from its session log, its screen kept, and nothing of the lane's left`,
        t.r.stopped === "no_submission" &&
          t.sent.length === 2 &&
          t.r.turns >= 1 &&
          t.r.tokensIn > 0 &&
          t.screen.length > 0 &&
          t.left.length === 0 &&
          more(t),
        {
          stopped: t.r.stopped,
          error: t.r.error,
          turns: t.r.turns,
          toolCalls: t.r.toolCalls,
          tokens: [t.r.tokensIn, t.r.tokensOut],
          prompts: t.sent.length,
          seconds: t.seconds,
          screen: t.screen.length,
          left: t.left,
          live: t.live.slice(-6),
        },
      );

    // The fake in Claude Code's place: Claude Code's own command line, as lane-1 runs it.
    const fake = await trial(
      "fake",
      claudeProgram,
      {
        api: "claude",
        harness: "claude-code",
        baseUrl: "https://api.anthropic.com",
        model: "claude-test",
        apiKey: c.TOKEN,
        contextWindow: 1_000_000,
        maxTokens: 0,
      },
      (dir) => {
        // Before the area is handed to lane-1: the fake's command and its script, in the area.
        const bin = join(dir, "claude");
        writeFileSync(
          bin,
          `#!/bin/sh\nexec "${process.execPath}" /opt/fake-tui/fake-tui.ts "$@"\n`,
        );
        chmodSync(bin, 0o755);
        process.env.THERMITE_CLAUDE_BIN = bin;
        const script = join(dir, "script.json");
        writeFileSync(script, JSON.stringify(fakeScript()));
        return { FAKE_TUI_SCRIPT: script };
      },
    );
    ended("the fake TUI as Claude Code", fake, (t) => t.r.toolCalls === 1 && t.r.turns === 2);

    if (existsSync("/opt/codex/bin/codex")) {
      process.env.THERMITE_CODEX_BIN = "/opt/codex/bin/codex";
      const codex = await trial("codex", codexProgram, {
        api: "openai",
        harness: "codex",
        baseUrl: "",
        model: "scripted",
        apiKey: "",
        contextWindow: 0,
        maxTokens: 0,
      });
      ended("Codex", codex, (t) => t.live.some((l) => /done\./.test(l)));
    } else c.check("the image has no Codex CLI: its loop trial was not run", true, "");

    if (existsSync("/usr/local/bin/opencode")) {
      process.env.THERMITE_OPENCODE_BIN = "/usr/local/bin/opencode";
      const opencode = await trial("opencode", opencodeProgram, {
        api: "openai",
        harness: "opencode",
        baseUrl: "",
        model: "scripted",
        apiKey: "",
        contextWindow: 0,
        maxTokens: 0,
      });
      ended("OpenCode", opencode, (t) => t.live.some((l) => /done\./.test(l)));
    } else c.check("the image has no OpenCode: its loop trial was not run", true, "");
  } finally {
    api.close();
    restore("THERMITE_CLAUDE_BIN", before.claude);
    restore("THERMITE_CODEX_BIN", before.codex);
    restore("THERMITE_OPENCODE_BIN", before.opencode);
  }
}
