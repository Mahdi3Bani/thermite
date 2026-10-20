import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { RESEARCH_TOOLS } from "./research-tools.ts";
import { parseArgs, researchRequest, trialCli } from "./trial-cli.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "k.c"), "int k = 1;\n");
  writeFileSync(join(dir, "notes.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

describe("thermite-trial, Thermite's tools in an agent's own shell", () => {
  test("flags repeat and -- ends them", () => {
    assert.deepEqual(
      parseArgs(["--flaw", "a", "--flaw=b", "--hypothesis", "h", "--", "make", "-j"]),
      {
        flags: { flaw: ["a", "b"], hypothesis: ["h"] },
        rest: ["make", "-j"],
      },
    );
  });

  test("submit sends the change inside the editable paths, with its hypothesis and flaws", async () => {
    const dir = repo();
    writeFileSync(join(dir, "src", "k.c"), "int k = 2;\n");
    writeFileSync(join(dir, "notes.txt"), "outside the editable paths\n");
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const out = await trialCli(
      ["submit", "--hypothesis", "k is 2", "--flaw", "untested on big inputs"],
      { harnessUrl: "http://h", auth: "trial.t", workspace: dir, editablePaths: ["src/**"] },
      async (method, path, body) => {
        calls.push({ method, path, body });
        return { attempt: "a-1", lifecycle: "queued" };
      },
    );
    assert.match(out, /^submitted a-1: queued/);
    const body = calls[0]?.body as {
      patch_base64: string;
      hypothesis: string;
      known_flaws: string[];
    };
    assert.equal(calls[0]?.path, "/v1/attempts");
    const patch = Buffer.from(body.patch_base64, "base64").toString();
    assert.match(patch, /src\/k\.c/);
    assert.doesNotMatch(patch, /notes\.txt/);
    assert.equal(body.hypothesis, "k is 2");
    assert.deepEqual(body.known_flaws, ["untested on big inputs"]);
  });

  test("submit without a change or a hypothesis says so and sends nothing", async () => {
    const dir = repo();
    const env = {
      harnessUrl: "http://h",
      auth: "trial.t",
      workspace: dir,
      editablePaths: ["src/**"],
    };
    const never = async () => {
      throw new Error("called");
    };
    assert.match(await trialCli(["submit", "--hypothesis", "h"], env, never), /no changes inside/);
    assert.match(await trialCli(["submit"], env, never), /needs --hypothesis/);
  });

  test("dev-run and status reach their endpoints", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const env = { harnessUrl: "http://h", auth: "trial.t", workspace: "/w", editablePaths: [] };
    const call = async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return { ok: true };
    };
    await trialCli(["dev-run", "--timeout", "30", "--", "nvidia-smi", "-L"], env, call);
    await trialCli(["status", "a-9"], env, call);
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/v1/dev-runs",
        body: { command: "nvidia-smi -L", cwd: "/w", timeout_s: 30 },
      },
      { method: "GET", path: "/v1/attempts/a-9", body: undefined },
    ]);
  });

  test("idea proposes an experiment for the run's queue: its words are the title, flags the rest", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const env = { harnessUrl: "http://h", auth: "trial.t", workspace: "/w", editablePaths: [] };
    const call = async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return { experiment: "x-0123456789ab", state: "proposed" };
    };
    const out = await trialCli(
      [
        "idea",
        "unroll",
        "the",
        "tail",
        "loop",
        "--why",
        "the profile shows it",
        "--family",
        "unroll",
      ],
      env,
      call,
    );
    assert.match(
      out,
      /^proposed x-0123456789ab: it waits until the planner or the campaign.s owner queues it/,
    );
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/v1/trial/idea",
        body: { title: "unroll the tail loop", why: "the profile shows it", family: "unroll" },
      },
    ]);
    assert.match(await trialCli(["idea", "--why", "w"], env, call), /^error: idea needs a title/);
    assert.match(
      await trialCli(["idea", "t", "--run", "other"], env, call),
      /^error: idea has no --run/,
    );
    assert.equal(calls.length, 1, "nothing sent for a mistake");
  });

  test("research: each of the research worker's tools is a command, and reaches its operation", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const env = { harnessUrl: "http://h", auth: "trial.t", workspace: "/w", editablePaths: [] };
    const call = async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return path.endsWith("/stats") ? { sources: 2 } : "fetched text";
    };
    // The same ten tools as Pi's research worker, each with its use for the prompt.
    assert.deepEqual(
      RESEARCH_TOOLS.map((t) => t.name),
      [
        "fetch",
        "read_source",
        "search",
        "search_corpus",
        "add_claim",
        "add_note",
        "propose_hypothesis",
        "add_finding",
        "update_section",
        "progress",
      ],
    );
    const help = await trialCli(["research", "help"], env, call);
    for (const t of RESEARCH_TOOLS) assert.ok(help.includes(`thermite-trial research ${t.name}`));
    assert.equal(
      await trialCli(["research", "fetch", "https://example.com/a"], env, call),
      "fetched text",
    );
    await trialCli(["research", "read_source", "s-1", "--offset", "6000"], env, call);
    await trialCli(["research", "search", "2-bit", "decoding"], env, call);
    await trialCli(["research", "search_corpus", "dequantize"], env, call);
    await trialCli(
      ["research", "add_note", "kernels", "differ", "--source", "s-1", "--source", "s-2"],
      env,
      call,
    );
    await trialCli(["research", "propose_hypothesis", "faster", "--supporting", "c-1"], env, call);
    assert.equal(await trialCli(["research", "progress"], env, call), '{"sources":2}');
    assert.deepEqual(calls, [
      { method: "POST", path: "/v1/research/fetch", body: { url: "https://example.com/a" } },
      { method: "POST", path: "/v1/research/read", body: { source: "s-1", offset: 6000 } },
      { method: "POST", path: "/v1/research/search", body: { query: "2-bit decoding" } },
      { method: "POST", path: "/v1/research/search-corpus", body: { text: "dequantize" } },
      {
        method: "POST",
        path: "/v1/research/note",
        body: { text: "kernels differ", sources: ["s-1", "s-2"] },
      },
      {
        method: "POST",
        path: "/v1/research/hypothesis",
        body: { text: "faster", supporting: ["c-1"] },
      },
      { method: "POST", path: "/v1/research/stats", body: {} },
    ]);
  });

  test("research: a claim's exact quotes come as JSON on stdin, untouched; mistakes say what to do", async () => {
    const quote = `It's "2x" faster — $HOME \\n stays as written`;
    const stdin = JSON.stringify({
      text: "the kernel is faster",
      quotes: [{ source: "s-1", quote }],
      question: 0,
    });
    const calls: unknown[] = [];
    const env = { harnessUrl: "http://h", auth: "trial.t", workspace: "/w", editablePaths: [] };
    await trialCli(
      ["research", "add_claim", "-", "--confidence", "0.8"],
      env,
      async (_m, _p, body) => {
        calls.push(body);
        return { claim: "c-1", status: "verified" };
      },
      async () => stdin,
    );
    assert.deepEqual(calls, [
      {
        text: "the kernel is faster",
        quotes: [{ source: "s-1", quote }],
        question: 0,
        confidence: 0.8,
      },
    ]);
    // stdin is read only for "-".
    let read = false;
    await trialCli(
      ["research", "progress"],
      env,
      async () => ({}),
      async () => {
        read = true;
        return "";
      },
    );
    assert.equal(read, false);
    // A finding comes the same way.
    const finding = {
      text: "the kernel is faster",
      summary: "two sources agree",
      why_it_matters: "it decides the next experiments",
      supporting: ["c-1", "c-2"],
    };
    assert.deepEqual(researchRequest("add_finding", ["-"], JSON.stringify(finding)), {
      op: "finding",
      body: finding,
    });
    assert.match(
      String(researchRequest("add_claim", ["-"], "not json")),
      /^error: "-" reads a JSON object/,
    );
    assert.match(String(researchRequest("add_claim", ["words"], undefined)), /takes no words/);
    assert.match(String(researchRequest("fetch", ["--depth", "2"], undefined)), /has no --depth/);
    assert.match(
      String(researchRequest("read_source", ["s", "--offset", "x"], undefined)),
      /needs a number/,
    );
    assert.match(
      String(researchRequest("browse", [], undefined)),
      /^error: no research tool "browse"/,
    );
  });
});
