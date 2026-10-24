import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { parseContract } from "../../core/contract.ts";
import { researchFixture } from "../../testing/fixtures.ts";
import { makeHarnessEnv } from "../../testing/harness-env.ts";
import { Registry } from "../agents/registry.ts";
import { NOTE_REPEATS, Research } from "./research.ts";

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
