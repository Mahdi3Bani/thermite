import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createControlApi } from "../control/api.ts";
import { ControlStore } from "../control/store.ts";
import type { SignedCommand } from "../core/commands.ts";
import { createHarnessApi } from "../harness/api.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { relayOnce } from "./relay.ts";
import { type StageResult, stageCommand } from "./staging.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** An assign command as the relay sees it (staging reads the envelope, not the signature). */
const assign = (id: string, imports: unknown[]): SignedCommand =>
  ({
    envelope: {
      v: 1,
      id,
      rig: "rig-a",
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run: "r-1", imports },
    },
    signature: "",
  }) as unknown as SignedCommand;

/** Asks again, as the relay does on each poll, until staging stops waiting. */
async function staged(cfg: Parameters<typeof stageCommand>[0], cmd: SignedCommand) {
  for (let i = 0; i < 200; i++) {
    const r: StageResult = await stageCommand(cfg, cmd);
    if (r !== "wait") return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("staging never finished");
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "thermite-stage-"));
  const inboxDir = join(root, "inbox");
  mkdirSync(inboxDir);
  const cfg = {
    rig: "rig-a",
    inboxDir,
    resultsRepo: join(root, "home", "results.git"),
    sourcesDir: join(root, "home", "sources"),
  };
  return { root, inboxDir, cfg };
}

describe("staging sources by reference", () => {
  test("a project's commit is fetched from its repository and lands in the inbox as a bundle", async () => {
    const { root, inboxDir, cfg } = setup();
    const repo = join(root, "project");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "one");
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, "commit", "--quiet", "-am", "two");
    const imports = [
      {
        kind: "repo_bundle",
        path: "repos/project-first.bundle",
        repo: "project",
        commit: first,
        source: { git: `file://${repo}` },
      },
    ];
    assert.equal(await stageCommand(cfg, assign("c-1", imports)), "wait");
    assert.equal(await staged(cfg, assign("c-1", imports)), "ready");
    const bundle = join(inboxDir, "repos", "project-first.bundle");
    // The bundle holds the named commit (not just the branch tip), with its history.
    const heads = git(root, "bundle", "list-heads", bundle);
    assert.match(heads, new RegExp(`^${first} refs/thermite/stage/${first}$`));
    // Already there: the next command naming it relays at once, without fetching.
    assert.equal(await stageCommand(cfg, assign("c-2", imports)), "ready");
  });

  test("a model is downloaded and kept only with the signed hash; a missing commit fails", async () => {
    const { root, inboxDir, cfg } = setup();
    const bytes = Buffer.from("weights ".repeat(1000));
    const server = createServer((req, res) => {
      if (req.url === "/model.bin") res.end(bytes);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sha = createHash("sha256").update(bytes).digest("hex");
    try {
      const model = (sha256: string, path: string) => ({
        kind: "model",
        path,
        name: "m",
        sha256,
        source: { url: `${base}/model.bin` },
      });
      assert.equal(await staged(cfg, assign("m-1", [model(sha, "models/m.bin")])), "ready");
      assert.deepEqual(readFileSync(join(inboxDir, "models", "m.bin")), bytes);
      const wrong = await staged(cfg, assign("m-2", [model("0".repeat(64), "models/w.bin")]));
      assert.match(JSON.stringify(wrong), /staging: .*sha256/);
      assert.ok(!existsSync(join(inboxDir, "models", "w.bin")), "a wrong file never lands");
      const repo = join(root, "empty");
      mkdirSync(repo);
      git(repo, "init", "--quiet", "--bare");
      const missing = await staged(
        cfg,
        assign("g-1", [
          {
            kind: "kit_bundle",
            path: "repos/kit.bundle",
            repo: "kit",
            commit: "b".repeat(40),
            source: { git: `file://${repo}` },
          },
        ]),
      );
      assert.match(JSON.stringify(missing), /has no commit b{40}/);
    } finally {
      server.close();
    }
  });

  test("a command transport is never run, whatever the URL says", async () => {
    const { root, cfg } = setup();
    const marker = join(root, "ran");
    const r = await staged(
      cfg,
      assign("x-1", [
        {
          kind: "repo_bundle",
          path: "repos/x.bundle",
          repo: "x",
          commit: "c".repeat(40),
          source: { git: `ext::sh -c touch% ${marker}` },
        },
      ]),
    );
    assert.notEqual(r, "ready");
    assert.ok(!existsSync(marker));
  });

  test("an assignment that names its project and kit by URL starts a run, with nothing put in the inbox by hand", async () => {
    const env = makeJudgeEnv();
    const store = new ControlStore(":memory:");
    const control = createControlApi(
      store,
      { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } },
      env.keys.privateKeyPem,
    );
    const harness = createHarnessApi(env.service, { supervisor: "s-token-abcdef" });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      return (url.host === "harness" ? harness : control).request(
        `${url.pathname}${url.search}`,
        init as RequestInit,
      );
    };
    const payload = (env.assign as unknown as SignedCommand).envelope.payload as Record<
      string,
      unknown
    >;
    const issue = async (body: Record<string, unknown>) => {
      const r = await control.request("/v1/commands", {
        method: "POST",
        headers: { authorization: "Bearer admin-token-abcdef", "content-type": "application/json" },
        body: JSON.stringify({ rig: "rig-a", kind: "assign_campaign", payload: body }),
      });
      assert.equal(r.status, 201, await r.clone().text());
      return ((await r.json()) as { id: string }).id;
    };
    const sources = {
      ...payload,
      imports: [
        {
          kind: "repo_bundle",
          path: "repos/fetched-project.bundle",
          repo: "proj",
          commit: env.seed,
          source: { git: `file://${join(env.root, "project")}` },
        },
        {
          kind: "kit_bundle",
          path: "repos/fetched-kit.bundle",
          repo: "js-kit",
          commit: env.kitCommit,
          source: { git: `file://${join(env.root, "kit")}` },
        },
      ],
    };
    const id = await issue(sources);
    const stagingCfg = {
      rig: "rig-a",
      inboxDir: env.paths.inboxDir,
      resultsRepo: join(env.root, "supervisor", "results.git"),
      sourcesDir: join(env.root, "supervisor", "sources"),
    };
    const cfg = {
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: "s-token-abcdef",
      controlUrl: "http://control",
      controlToken: "rig-token-abcdef",
      fetchImpl,
      stage: (cmd: SignedCommand) => stageCommand(stagingCfg, cmd),
    };
    let state = { cursor: 0 };
    for (let i = 0; i < 200 && store.command(id)?.status === "pending"; i++) {
      state = await relayOnce(cfg, state);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(store.command(id)?.status, "delivered", JSON.stringify(store.command(id)));
    assert.equal(env.ledger.getRun("js-1")?.status, "running");
    assert.ok(existsSync(join(env.paths.inboxDir, "repos", "fetched-project.bundle")));
    assert.ok(existsSync(join(env.paths.inboxDir, "repos", "fetched-kit.bundle")));
  });
});
