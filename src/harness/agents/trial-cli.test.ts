import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseArgs, trialCli } from "./trial-cli.ts";

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
});
