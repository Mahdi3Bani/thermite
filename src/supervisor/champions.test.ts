import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createControlApi } from "../control/api.ts";
import { ControlStore } from "../control/store.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { championsIn, uploadChampions } from "./champions.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

describe("champion patches reach control", () => {
  test("a published champion's patch is uploaded, checked against the rig's hash, and downloadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-champ-"));
    const patch = Buffer.from("diff --git a/k.c b/k.c\n+faster\n");
    const sha256 = createHash("sha256").update(patch).digest("hex");
    // The supervisor's results repository, as the exporter leaves it.
    const work = join(root, "work");
    mkdirSync(join(work, "champions", "r-1"), { recursive: true });
    writeFileSync(join(work, "champions", "r-1", "2.patch"), patch);
    git(work, "init", "--quiet", "-b", "thermite/rig-a/attempts");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "export");
    const resultsRepo = join(root, "results.git");
    git(root, "clone", "--quiet", "--bare", work, resultsRepo);
    // An export's manifest names the champion.
    mkdirSync(join(root, "outbox", "e-1"), { recursive: true });
    writeFileSync(
      join(root, "outbox", "e-1", "manifest.json"),
      JSON.stringify({ files: { "champions/r-1/2.patch": sha256, "attempts/a-1.patch": "x" } }),
    );
    const queue = championsIn(join(root, "outbox"), ["e-1", "missing"]);
    assert.deepEqual(queue, [{ run: "r-1", seq: 2, path: "champions/r-1/2.patch" }]);

    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } },
      makeJudgeEnv().keys.privateKeyPem,
    );
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      return control.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    const cfg = {
      rig: "rig-a",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      resultsRepo,
      fetchImpl,
    };
    // Before control has the rig's signed event, the upload waits.
    assert.deepEqual(await uploadChampions(cfg, queue), queue);
    store.ingest({
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: 0,
      next: 2,
      generated_at: new Date().toISOString(),
      summary: {},
      events: [
        {
          id: 1,
          at: new Date().toISOString(),
          actor: "harness",
          kind: "run_created",
          subject: "r-1",
          body: {
            campaign: "c",
            version: 1,
            mode: "hill_climb",
            seed: { repo: "proj", commit: "b".repeat(40) },
          },
        },
        {
          id: 2,
          at: new Date().toISOString(),
          actor: "harness",
          kind: "champion_published",
          subject: "r-1",
          body: { seq: 2, repo: "proj", base_commit: "b".repeat(40), tree: "t", sha256 },
        },
      ],
    } as never);
    assert.deepEqual(await uploadChampions(cfg, queue), []);
    // Bytes that are not the published patch are refused.
    const wrong = await control.request("/v1/rigs/rig-a/champions/r-1/2/patch", {
      method: "POST",
      headers: { authorization: "Bearer rig-token-abcdef" },
      body: new Uint8Array(Buffer.from("something else")),
    });
    assert.equal(wrong.status, 422);
    const got = await control.request("/v1/rigs/rig-a/champions/r-1/2/patch", {
      headers: { authorization: "Bearer admin-token-abcdef" },
    });
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), patch);
    assert.equal(got.headers.get("x-thermite-base-commit"), "b".repeat(40));
    // And from the dashboard, as a file to save.
    const login = await control.request("/ui/login", {
      method: "POST",
      body: new URLSearchParams({ token: "admin-token-abcdef" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const file = await control.request("/ui/rigs/rig-a/runs/r-1/champions/2.patch", {
      headers: { cookie },
    });
    assert.equal(file.status, 200);
    assert.match(
      file.headers.get("content-disposition") ?? "",
      /r-1-champion-2-on-bbbbbbbb\.patch/,
    );
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), patch);
    // The run's "at work" panel links it.
    const home = await (await control.request("/ui", { headers: { cookie } })).text();
    assert.match(
      home,
      /href="\/ui\/rigs\/rig-a\/runs\/r-1\/champions\/2\.patch">download champion #2 as a patch<\/a> <span class="muted">\(applies to bbbbbbbb\)/,
    );
  });
});
