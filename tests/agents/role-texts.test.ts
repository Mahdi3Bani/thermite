import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { CLAUDE_SYSTEM } from "../../src/harness/agents/claude-code.ts";
import { CODEX_SYSTEM } from "../../src/harness/agents/codex.ts";
import { SUMMARY_SYSTEM } from "../../src/harness/agents/compaction.ts";
import { SYSTEM as OPENCODE_SYSTEM } from "../../src/harness/agents/opencode.ts";
import {
  PLAN_LIMITS_TEXT,
  ASK_SYSTEM as PLANNER_ASK_SYSTEM,
  SYSTEM as PLANNER_SYSTEM,
  TASK as PLANNER_TASK,
} from "../../src/harness/agents/planner.ts";
import {
  LIMITS_TEXT as RESEARCH_PLAN_LIMITS_TEXT,
  RESEARCH_ASK_SYSTEM as RESEARCH_PLANNER_ASK_SYSTEM,
  RESEARCH_SYSTEM as RESEARCH_PLANNER_SYSTEM,
  RESEARCH_TASK as RESEARCH_PLANNER_TASK,
} from "../../src/harness/agents/research-planner.ts";
import { RESEARCH_SYSTEM as RESEARCH_WORKER_SYSTEM } from "../../src/harness/agents/research-tools.ts";
import { RESEARCH_NOTES } from "../../src/harness/agents/research-worker.ts";
import { NOTES_AND_SOURCES, SYSTEM as WORKER_SYSTEM } from "../../src/harness/agents/worker.ts";
import {
  ADVISOR_NOTES,
  AT_WORK_GUIDE,
  AUDITOR,
  BRIEF_GUIDE,
  MERGED_BY,
  PANEL,
  PAST_GUIDE,
  RESEARCH_GUIDE,
  RESEARCH_MERGED_BY,
  RESEARCH_PANEL,
  RESEARCH_TEACHER,
  STE_SHORT_RULES,
  SYNTHESIZER,
  TEACHER,
  WRITER,
} from "../../src/supervisor/advisors.ts";

/**
 * The fixed text of every agent role (goal 166), held byte for byte against the files in
 * golden/. A change to a role's text changes its file in the same commit, on purpose: run
 * `UPDATE_GOLDEN=1 node scripts/test.mjs tests/agents/role-texts.test.ts`, then read the diff.
 */
const TEXTS: Record<string, string> = {
  "worker.pi.system": WORKER_SYSTEM,
  "worker.pi.notes-and-sources": NOTES_AND_SOURCES,
  "worker.opencode.system": OPENCODE_SYSTEM,
  "worker.claude-code.system": CLAUDE_SYSTEM,
  "worker.codex.system": CODEX_SYSTEM,
  "research-worker.system": RESEARCH_WORKER_SYSTEM,
  "research-worker.notes": RESEARCH_NOTES,
  "planner.task": PLANNER_TASK,
  "planner.limits": PLAN_LIMITS_TEXT,
  "planner.pi.system": PLANNER_SYSTEM,
  "planner.ask.system": PLANNER_ASK_SYSTEM,
  "research-planner.task": RESEARCH_PLANNER_TASK,
  "research-planner.limits": RESEARCH_PLAN_LIMITS_TEXT,
  "research-planner.pi.system": RESEARCH_PLANNER_SYSTEM,
  "research-planner.ask.system": RESEARCH_PLANNER_ASK_SYSTEM,
  "advisors.notes": ADVISOR_NOTES,
  "advisors.brief-guide": BRIEF_GUIDE,
  "advisors.at-work-guide": AT_WORK_GUIDE,
  "advisors.past-guide": PAST_GUIDE,
  "advisors.research-guide": RESEARCH_GUIDE,
  "teacher.system": TEACHER,
  "merged-by.system": MERGED_BY,
  "research-teacher.system": RESEARCH_TEACHER,
  "research-merged-by.system": RESEARCH_MERGED_BY,
  "auditor.system": AUDITOR,
  "reviewer.system": PANEL,
  "research-reviewer.system": RESEARCH_PANEL,
  "final-writer.system": WRITER,
  "final-writer.ste-short-rules": STE_SHORT_RULES,
  "synthesizer.system": SYNTHESIZER,
  "compaction.system": SUMMARY_SYSTEM,
};

const golden = (name: string) => new URL(`golden/${name}.txt`, import.meta.url);

for (const [name, text] of Object.entries(TEXTS)) {
  test(`the ${name} text is unchanged`, () => {
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden(name), text);
    assert.equal(text, readFileSync(golden(name), "utf8"));
  });
}
