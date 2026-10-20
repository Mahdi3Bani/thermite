import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { exportOnce } from "../supervisor/git-export.ts";
import { makeHarnessEnv } from "../testing/harness-env.ts";
import { LocalRunner } from "./broker/runner.ts";
import { ResearchFolder } from "./research/folder.ts";
import { Research } from "./research/research.ts";

const RUN = "smoke-1";
const BRIEFING = [
  {
    text: "Vector loads need 16-byte aligned pointers.",
    from: { campaign: "kernels", run: "kernels-7", kind: "note", ref: "12" },
  },
];
const lane = {
  by: "lane-1",
  actor: "trial:t-1",
  source: "trial:t-1",
  lane: "lane-1",
  trial: "t-1",
};

/** A hill climb with its research folder and research service wired as the controller does. */
async function setup() {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", env.assignPayload({ briefing: BRIEFING })),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const { stateDir, scratchDir } = env.service.paths;
  const folder = new ResearchFolder({
    ledger: env.service.ledger,
    scratchRoot: join(scratchDir, "research"),
    stateRoot: join(stateDir, "research-work"),
    runner: new LocalRunner(scratchDir),
    knowledge: env.service.knowledge,
  });
  const research = new Research(env.service.ledger, stateDir, {
    onChange: (run) => void folder.sync(run),
  });
  env.service.researchFolder = (run) => folder.exportFiles(run);
  return { env, s: env.service, research };
}

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    files: Record<string, string>;
  };

describe("a run's export holds its journal, its research notes and its briefing", () => {
  test("each export holds what was recorded since the last one", async () => {
    const { s, research } = await setup();
    const first = s.journal.write(RUN, { kind: "lesson", text: "Profile first." }, lane);
    research.addNote(RUN, "lane-1", "The guide says loads should be aligned.", [], "t-1");
    const one = await s.export("test");
    assert.deepEqual(lines(join(one.dir, "journal.jsonl")), [
      {
        id: first.id,
        run: RUN,
        by: "lane-1",
        kind: "lesson",
        text: "Profile first.",
        about: { type: "run", id: RUN },
        lane: "lane-1",
        trial: "t-1",
        at: first.at,
      },
    ]);
    assert.deepEqual(
      lines(join(one.dir, "research-notes.jsonl")).map((n) => [n.run, n.lane, n.text, n.sources]),
      [[RUN, "lane-1", "The guide says loads should be aligned.", []]],
    );
    assert.deepEqual(lines(join(one.dir, "briefing.jsonl")), [
      { run: RUN, seq: 1, ...BRIEFING[0] },
    ]);
    const files = manifestOf(one.dir).files;
    for (const f of ["journal.jsonl", "research-notes.jsonl", "briefing.jsonl"])
      assert.match(String(files[f]), /^[0-9a-f]{64}$/, f);
    // The next export: only the new note; the run's briefing went with its creation.
    const second = s.journal.write(RUN, { kind: "question", text: "Is it L2-bound?" }, lane);
    const two = await s.export("test");
    assert.deepEqual(
      lines(join(two.dir, "journal.jsonl")).map((n) => n.id),
      [second.id],
    );
    assert.ok(!existsSync(join(two.dir, "briefing.jsonl")));
    assert.ok(!existsSync(join(two.dir, "research-notes.jsonl")));
    // An export with no new note still holds an (empty) journal.
    const three = await s.export("test");
    assert.equal(readFileSync(join(three.dir, "journal.jsonl"), "utf8"), "");
  });

  test("a closed hill climb that recorded research exports its folder, without past research, and the supervisor pushes it", async () => {
    const { env, s, research } = await setup();
    s.journal.write(RUN, { kind: "observation", text: "The loop is memory bound." }, lane);
    research.addNote(RUN, "lane-1", "Aligned loads matter.", [], "t-1");
    s.writeKnowledge(RUN, [
      {
        seq: 1,
        campaign: "kernels",
        rig: "rig-b",
        run: "kernels-7",
        kind: "note",
        ref: "12",
        title: "aligned loads",
        body: "Vector loads need 16-byte aligned pointers.",
        by: "lane-2",
        url: null,
        sub: "lesson",
        at: "2026-10-16T00:00:00.000Z",
        updated_at: "2026-10-16T00:00:00.000Z",
      },
    ]);
    s.ledger.setRunStatus(RUN, "closed", "done", "test");
    const exp = await s.export("test");
    const files = Object.keys(manifestOf(exp.dir).files);
    assert.ok(files.includes(`research/${RUN}/folder/INDEX.md`), files.join(", "));
    assert.ok(files.includes(`research/${RUN}/folder/notes/note-00001.md`));
    assert.ok(!files.some((f) => f.includes("/knowledge/")), "past research is other runs'");

    const root = mkdtempSync(join(tmpdir(), "thermite-results-"));
    const remote = join(root, "remote.git");
    mkdirSync(remote);
    execFileSync("git", ["-C", remote, "init", "--bare", "--quiet"]);
    const state = await exportOnce(
      {
        rig: "rig-a",
        outboxDir: env.service.paths.outboxDir,
        workDir: join(root, "work"),
        remote: `file://${remote}`,
      },
      { done: [] },
    );
    assert.equal(state.lastError, undefined);
    const pushed = execFileSync(
      "git",
      ["-C", remote, "ls-tree", "-r", "--name-only", "thermite/rig-a/attempts"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    const name = exp.dir.split("/").pop();
    for (const f of [
      `journal/${name}.jsonl`,
      `research-notes/${name}.jsonl`,
      `briefing/${name}.jsonl`,
      `research/${RUN}/folder/INDEX.md`,
    ])
      assert.ok(pushed.includes(f), `${f} in ${pushed.join(", ")}`);
  });
});
