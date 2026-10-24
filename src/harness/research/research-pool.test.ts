import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseContract, type ResearchContract } from "../../core/contract.ts";
import { indexEvent, type KbFields } from "../../core/kb-index.ts";
import { researchFixture } from "../../testing/fixtures.ts";
import { makeHarnessEnv } from "../../testing/harness-env.ts";
import { Registry } from "../agents/registry.ts";
import { LocalRunner } from "../broker/runner.ts";
import { ResearchFolder, SAVED_LANES_DIR } from "./folder.ts";
import { NOTE_REPEATS, Research } from "./research.ts";
import { researchPackage } from "./review.ts";

/**
 * Goal 117's bounds on what research workers write: a note that repeats one of the run's newest
 * notes is refused, and hypotheses are a pool with a question, without twins.
 */

async function researchEnv(over: Record<string, unknown> = {}) {
  const env = makeHarnessEnv("rig-r");
  const parsed = parseContract({ ...researchFixture, ...over });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", {
      run: "r-1",
      contract: parsed.contract,
      contract_sha: parsed.sha,
      imports: [],
    }),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const research = new Research(env.service.ledger, env.service.paths.stateDir, {
    allowPrivate: true,
  });
  return { env, research };
}

/** An open trial of a lane in run r-1, with its token. */
function openTrial(env: ReturnType<typeof makeHarnessEnv>, lane: string, id: string): string {
  const token = randomBytes(16).toString("hex");
  new Registry(env.service.ledger).startTrial({
    id,
    run: "r-1",
    lane,
    epoch: 1,
    family: "explore",
    parent: "research",
    token,
  });
  return token;
}

describe("a note that repeats one already written is refused (goal 117)", () => {
  test("a research note: the same words once folded are refused, with the note they repeat", async () => {
    const { env, research } = await researchEnv();
    const first = research.addNote("r-1", "lane-2", "Closed.");
    for (const again of ["Closed.", "closed", "  CLOSED!  ", "“Closed”"])
      assert.throws(
        () => research.addNote("r-1", "lane-2", again),
        new RegExp(
          `this note repeats note ${first.note} \\(by lane-2, [^)]+\\) word for word: it is not recorded again`,
        ),
      );
    // Other words are another note.
    research.addNote("r-1", "lane-2", "Closed the second question's gap on sources.");
    const n = Number(
      (
        env.service.ledger.db.prepare("select count(*) as n from note where run = 'r-1'").get() as {
          n: number;
        }
      ).n,
    );
    assert.equal(n, 2, "a refused note leaves no record");
  });

  test("only the run's newest notes count: a note older than the last NOTE_REPEATS may be written again", async () => {
    const { research } = await researchEnv();
    research.addNote("r-1", "lane-1", "Kernel launch overhead dominates small batches.");
    for (let i = 0; i < NOTE_REPEATS; i++)
      research.addNote("r-1", "lane-1", `Read source number ${i} for the second question.`);
    assert.doesNotThrow(() =>
      research.addNote("r-1", "lane-1", "Kernel launch overhead dominates small batches."),
    );
  });

  test("a research worker's field note: a repeat of the run's newest field notes is refused in words; other runs keep theirs", async () => {
    const { env } = await researchEnv();
    const token = openTrial(env, "lane-1", "t-1");
    const first = env.service.writeTrialNote(token, { kind: "note", text: "Closed." });
    assert.throws(
      () => env.service.writeTrialNote(token, { kind: "observation", text: "closed" }),
      new RegExp(
        `this note repeats field note #${first.note} \\(by lane-1, [^)]+\\) word for word`,
      ),
    );
    // Another lane's repeat is a repeat too: the run's notes, not the lane's.
    const other = openTrial(env, "lane-2", "t-2");
    assert.throws(() => env.service.writeTrialNote(other, { kind: "note", text: "Closed!" }));
    assert.ok(env.service.writeTrialNote(other, { kind: "note", text: "Closed question 2." }).note);
    // A hill-climb run's workers are not held to it.
    const hc = makeHarnessEnv();
    await hc.service.applyCommand(hc.sign("assign_campaign", hc.assignPayload({})));
    const runOf = hc.service.ledger.db.prepare("select id from run").get() as { id: string };
    const t = randomBytes(16).toString("hex");
    new Registry(hc.service.ledger).startTrial({
      id: "t-h",
      run: runOf.id,
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: hc.seedCommit,
      token: t,
    });
    hc.service.writeTrialNote(t, { kind: "note", text: "Baseline confirmed." });
    assert.doesNotThrow(() =>
      hc.service.writeTrialNote(t, { kind: "note", text: "Baseline confirmed." }),
    );
  });
});

const QUESTIONS = [
  "Which harness designs keep agents productive for days?",
  "What do they cost?",
  "What fails first?",
];
const AUTHORS = "Fresh workers lose nothing that matters.";

/** A run with three questions, the author's hypothesis, and two verified claims to cite. */
async function poolEnv() {
  const { env, research } = await researchEnv({ questions: QUESTIONS, hypotheses: [AUTHORS] });
  const dir = join(env.service.paths.stateDir, "test-archive");
  mkdirSync(dir, { recursive: true });
  const quote = "Workers that start fresh from the ledger keep every result they recorded.";
  const claims: string[] = [];
  for (const [i, host] of ["docs.example.org", "www.example.net"].entries()) {
    const id = `s-00000000000${i}`;
    const path = join(dir, `${id}.txt`);
    writeFileSync(path, `A page: ${quote}`);
    env.service.ledger.db
      .prepare(
        `insert into source (id, run, url, final_url, domain, fetched_at, http_status, content_type, bytes, sha256,
           title, raw_path, text_path, fetched_by) values (?, 'r-1', ?, ?, ?, ?, 200, 'text/plain', 1, ?, null, ?, ?, 'lane-1')`,
      )
      .run(
        id,
        `https://${host}/a`,
        `https://${host}/a`,
        host,
        new Date().toISOString(),
        id,
        path,
        path,
      );
    const c = research.addClaim("r-1", "lane-1", {
      text: i ? "Fresh workers keep every result they recorded." : "Workers keep every result.",
      quotes: [{ source: id, quote }],
      question: 0,
    });
    assert.equal(c.verified, true, JSON.stringify(c.problems));
    claims.push(c.claim);
  }
  const row = (id: string) =>
    env.service.ledger.db.prepare("select * from hypothesis where id = ?").get(id) as Record<
      string,
      unknown
    >;
  const author = String(
    (
      env.service.ledger.db
        .prepare("select id from hypothesis where run = 'r-1' and status = 'author'")
        .get() as { id: string }
    ).id,
  );
  const events = (kind: string) =>
    (
      env.service.ledger.db
        .prepare("select body from event where kind = ? order by id")
        .all(kind) as { body: string }[]
    ).map((e) => JSON.parse(e.body) as Record<string, unknown>);
  return { env, research, claims, row, author, events };
}

describe("the hypothesis pool (goal 117)", () => {
  test("propose_hypothesis: a question the run has, words that are new, verified claims only; each refusal in words", async () => {
    const { research, claims, row, author, events } = await poolEnv();
    const h = research.proposeHypothesis("r-1", "lane-1", {
      text: "  Stateless planners scale to many lanes.  ",
      question: 1,
      supporting: [claims[0], "c-none", claims[0]],
    });
    assert.equal(h.status, "pool");
    assert.equal(h.question, 1);
    assert.deepEqual(h.supporting, [claims[0]]);
    assert.deepEqual(h.ignored, ["c-none"]);
    assert.match(h.note, /only the author's hypotheses and promoted ones need a verdict/);
    const r = row(h.hypothesis);
    assert.deepEqual(
      [r.status, r.question, r.text, r.lane],
      ["pool", 1, "Stateless planners scale to many lanes.", "lane-1"],
    );
    assert.deepEqual(events("hypothesis_added").at(-1), {
      hypothesis: h.hypothesis,
      lane: "lane-1",
      text: "Stateless planners scale to many lanes.",
      supporting: [claims[0]],
      question: 1,
      status: "pool",
    });
    // The brief's own: the author's, about the whole run.
    assert.deepEqual(events("hypothesis_added")[0], {
      hypothesis: author,
      lane: null,
      text: AUTHORS,
      supporting: [],
      from: "brief",
      question: null,
      status: "author",
    });
    // Repeats, once folded, are refused with the one they repeat.
    assert.throws(
      () =>
        research.proposeHypothesis("r-1", "lane-2", {
          text: "stateless planners scale to MANY lanes!",
        }),
      new RegExp(
        `this hypothesis repeats ${h.hypothesis} \\(proposed by lane-1\\): change that one with revise_hypothesis \\(id ${h.hypothesis}\\)`,
      ),
    );
    assert.throws(
      () =>
        research.proposeHypothesis("r-1", "lane-2", {
          text: "Fresh workers lose nothing that matters",
        }),
      new RegExp(
        `this hypothesis repeats ${author}, one of the author's: the review panel gives it a verdict already`,
      ),
    );
    assert.throws(
      () => research.proposeHypothesis("r-1", "lane-2", { text: "   " }),
      /a hypothesis needs its text/,
    );
    assert.throws(
      () => research.proposeHypothesis("r-1", "lane-2", { text: "Another idea.", question: 3 }),
      /no question 3: "question" is the index of one of the campaign's 3 questions, from 0 to 2/,
    );
    assert.throws(
      () => research.proposeHypothesis("r-1", "lane-2", { text: "Another idea.", question: 1.5 }),
      /a hypothesis is \{"text", "question"\?: the index of a campaign question, from 0/,
    );
    assert.equal(events("hypothesis_added").length, 2, "nothing refused was recorded");
  });

  test("revise_hypothesis: a pool hypothesis's words, question and claims change; the author's, merged and retired ones are refused", async () => {
    const { env, research, claims, row, author, events } = await poolEnv();
    const a = research.proposeHypothesis("r-1", "lane-1", { text: "Caches help.", question: 0 });
    const b = research.proposeHypothesis("r-1", "lane-2", { text: "Long contexts hurt." });
    const before = String(row(a.hypothesis).updated_at);
    const revised = research.reviseHypothesis("r-1", "lane-2", {
      id: a.hypothesis,
      text: "Caches help long runs most.",
      question: 2,
      supporting: [claims[1], "c-none"],
    });
    assert.deepEqual(
      [revised.status, revised.text, revised.question, revised.supporting, revised.ignored],
      ["pool", "Caches help long runs most.", 2, [claims[1]], ["c-none"]],
    );
    const r = row(a.hypothesis);
    assert.deepEqual(
      [r.text, r.question, r.supporting, r.lane],
      ["Caches help long runs most.", 2, JSON.stringify([claims[1]]), "lane-1"],
      "who proposed it stays",
    );
    assert.ok(String(r.updated_at) >= before);
    assert.deepEqual(events("hypothesis_revised").at(-1), {
      hypothesis: a.hypothesis,
      lane: "lane-2",
      text: "Caches help long runs most.",
      question: 2,
      supporting: [claims[1]],
      status: "pool",
    });
    // The question alone, back to the whole run; then nothing to change.
    assert.equal(
      research.reviseHypothesis("r-1", "lane-1", { id: a.hypothesis, question: null }).question,
      null,
    );
    assert.equal(
      research.reviseHypothesis("r-1", "lane-1", { id: a.hypothesis, question: null }).note,
      "nothing changed",
    );
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-1", { id: a.hypothesis }),
      /a revision needs what changes: text, question or supporting/,
    );
    assert.throws(
      () =>
        research.reviseHypothesis("r-1", "lane-1", { id: a.hypothesis, supporting: ["c-none"] }),
      /none of c-none is a verified claim of this run: the supporting claims stay as they were/,
    );
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-1", { id: author, text: "Something else." }),
      new RegExp(
        `hypothesis ${author} is one of the author's: only the campaign's brief changes it`,
      ),
    );
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-1", { id: "h-nope", text: "x" }),
      /no hypothesis h-nope in this run/,
    );
    // New words that repeat another live hypothesis merge this one into it.
    const merged = research.reviseHypothesis("r-1", "lane-1", {
      id: b.hypothesis,
      text: "caches help long runs most",
    });
    assert.deepEqual([merged.status, merged.merged_into], ["merged", a.hypothesis]);
    assert.match(String(merged.note), new RegExp(`work on ${a.hypothesis} from now on`));
    assert.deepEqual(
      [row(b.hypothesis).status, row(b.hypothesis).merged_into],
      ["merged", a.hypothesis],
    );
    assert.deepEqual(events("hypothesis_merged").at(-1), {
      hypothesis: b.hypothesis,
      into: a.hypothesis,
      lane: "lane-1",
      text: "caches help long runs most",
      question: null,
      supporting: [],
    });
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-2", { id: b.hypothesis, text: "Back again." }),
      new RegExp(
        `hypothesis ${b.hypothesis} was merged into ${a.hypothesis}: revise ${a.hypothesis} instead`,
      ),
    );
    // A merged hypothesis is not live: its first words may be proposed again.
    assert.ok(
      research.proposeHypothesis("r-1", "lane-2", { text: "Long contexts hurt." }).hypothesis,
    );
    env.service.ledger.db
      .prepare("update hypothesis set status = 'retired' where id = ?")
      .run(a.hypothesis);
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-2", { id: a.hypothesis, text: "x y z" }),
      new RegExp(`hypothesis ${a.hypothesis} is retired`),
    );
  });

  test("at the scale of a long run: hundreds proposed, every repeat refused, the review package holds only those that need a verdict", async () => {
    const { env, research, author } = await poolEnv();
    const ids: string[] = [];
    for (let i = 0; i < 300; i++)
      ids.push(
        research.proposeHypothesis("r-1", `lane-${(i % 4) + 1}`, {
          text: `Hypothesis number ${i}: tiling ${i} helps.`,
          question: i % 3,
        }).hypothesis,
      );
    let refused = 0;
    for (let i = 0; i < 300; i++) {
      try {
        research.proposeHypothesis("r-1", "lane-1", {
          text: `hypothesis number ${i} tiling ${i} helps`,
        });
      } catch (err) {
        assert.match(String(err), new RegExp(`repeats ${ids[i]}`));
        refused++;
      }
    }
    assert.equal(refused, 300, "every twin is refused");
    const n = (sql: string) =>
      Number((env.service.ledger.db.prepare(sql).get() as { n: number }).n);
    assert.equal(n("select count(*) as n from hypothesis where run = 'r-1'"), 301);
    // A promoted one needs a verdict too; the pool does not.
    env.service.ledger.db
      .prepare("update hypothesis set status = 'promoted' where id = ?")
      .run(ids[7] as string);
    const contract = env.service.contractFor("r-1") as ResearchContract;
    const pkg = researchPackage(env.service.ledger, "r-1", contract);
    assert.deepEqual(
      pkg.hypotheses.map((h) => h.id),
      [author, ids[7]],
    );
  });

  test("the folder, the brief and the knowledge base show each hypothesis's status and question, the author's first", async () => {
    const { env, research, claims, author, events } = await poolEnv();
    const folder = new ResearchFolder({
      ledger: env.service.ledger,
      scratchRoot: join(env.service.paths.scratchDir, "research"),
      stateRoot: join(env.service.paths.stateDir, SAVED_LANES_DIR),
      runner: new LocalRunner(env.service.paths.scratchDir),
    });
    const p = research.proposeHypothesis("r-1", "lane-1", {
      text: "Caches help.",
      question: 1,
      supporting: [claims[0]],
    });
    const root = folder.sync("r-1");
    const file = () => readFileSync(join(root, "hypotheses", `${p.hypothesis}.md`), "utf8");
    assert.match(
      file(),
      new RegExp(
        `^# Hypothesis ${p.hypothesis}: in the pool\\n\\nCaches help\\.\\n\\nAbout: Question 2 \\(index 1\\): What do they cost\\?`,
      ),
    );
    assert.match(
      file(),
      /Only the author's hypotheses and promoted ones need a verdict from the review panel/,
    );
    assert.match(
      readFileSync(join(root, "hypotheses", `${author}.md`), "utf8"),
      /: the author's, which needs a verdict\n[\s\S]*About: the whole run[\s\S]*by the campaign's author/,
    );
    const index = readFileSync(join(root, "INDEX.md"), "utf8");
    assert.match(index, /- hypotheses\/: 2 \(1 that need a verdict, 1 in the pool\)/);
    const listed = index.split("## Hypotheses\n\n")[1] ?? "";
    assert.match(listed, /^Only the author's hypotheses and promoted ones need a verdict/);
    assert.ok(listed.indexOf(author) < listed.indexOf(p.hypothesis), "the author's first");
    assert.match(
      listed,
      new RegExp(`- ${p.hypothesis} \\(in the pool; Question 2 \\(index 1\\)\\): Caches help\\.`),
    );
    // A revision changes its file.
    research.reviseHypothesis("r-1", "lane-2", { id: p.hypothesis, text: "Caches help most." });
    folder.sync("r-1");
    assert.match(file(), /Caches help most\.[\s\S]*Changed: /);
    // The brief: the rule, those that need a verdict, the pool.
    const brief = research.hypothesesBrief("r-1");
    assert.match(
      brief,
      /^# Hypotheses\nOnly the author's hypotheses and promoted ones need a verdict/,
    );
    assert.match(
      brief,
      new RegExp(
        `They need a verdict:\\n- ${author} \\(the author's, which needs a verdict; the whole run\\): Fresh workers`,
      ),
    );
    assert.match(
      brief,
      new RegExp(
        `The pool has 1:\\n- ${p.hypothesis} \\(in the pool; Question 2 \\(index 1\\)\\): Caches help most\\.`,
      ),
    );
    // The knowledge base: each event changes the hypothesis's item.
    const items = new Map<string, KbFields>();
    const target = {
      runCreated: () => {},
      body: (_r: string, _k: string, ref: string) => items.get(ref)?.body,
      attempt: () => undefined,
      put: (_r: string, _k: string, ref: string, f: KbFields) => {
        items.set(ref, { ...items.get(ref), ...f });
      },
    };
    const kinds = ["hypothesis_added", "hypothesis_revised", "hypothesis_merged"];
    for (const kind of kinds)
      for (const body of events(kind))
        indexEvent(target, {
          at: "t",
          actor: String(body.lane ?? "x"),
          kind,
          subject: "r-1",
          body,
        });
    assert.equal(
      items.get(p.hypothesis)?.body,
      [
        "Caches help most.",
        "Question 2 (index 1)",
        "Status: in the pool",
        `Supporting claims: ${claims[0]}`,
        "Changed by lane-2.",
      ].join("\n"),
    );
    assert.equal(items.get(p.hypothesis)?.by, "lane-1", "who proposed it");
    assert.match(String(items.get(author)?.body), /Status: the author's, which needs a verdict/);
  });
});
