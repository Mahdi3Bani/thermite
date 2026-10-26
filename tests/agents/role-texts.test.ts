import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { AUDITOR_SYSTEM } from "../../src/agents/roles/auditor.ts";
import { COMPACTION_SYSTEM } from "../../src/agents/roles/compaction.ts";
import { FINAL_WRITER_SYSTEM, STE_SHORT_RULES } from "../../src/agents/roles/final-writer.ts";
import { MERGED_BY_SYSTEM, RESEARCH_MERGED_BY_SYSTEM } from "../../src/agents/roles/merged-by.ts";
import {
  PLAN_LIMITS_TEXT,
  PLANNER_ASK_SYSTEM,
  PLANNER_PI_SYSTEM as PLANNER_SYSTEM,
  PLANNER_TASK,
} from "../../src/agents/roles/planner.ts";
import {
  RESEARCH_PLAN_LIMITS_TEXT,
  RESEARCH_PLANNER_ASK_SYSTEM,
  RESEARCH_PLANNER_PI_SYSTEM as RESEARCH_PLANNER_SYSTEM,
  RESEARCH_PLANNER_TASK,
} from "../../src/agents/roles/research-planner.ts";
import {
  RESEARCH_WORKER_NOTES,
  RESEARCH_WORKER_SYSTEM,
} from "../../src/agents/roles/research-worker.ts";
import { RESEARCH_REVIEWER_SYSTEM, REVIEWER_SYSTEM } from "../../src/agents/roles/reviewer.ts";
import {
  ADVISOR_NOTES,
  AT_WORK_GUIDE,
  BRIEF_GUIDE,
  PAST_GUIDE,
  RESEARCH_GUIDE,
} from "../../src/agents/roles/shared.ts";
import { SYNTHESIZER_SYSTEM } from "../../src/agents/roles/synthesizer.ts";
import { RESEARCH_TEACHER_SYSTEM, TEACHER_SYSTEM } from "../../src/agents/roles/teacher.ts";
import {
  WORKER_CLAUDE_CODE_SYSTEM,
  WORKER_CODEX_SYSTEM,
  WORKER_OPENCODE_SYSTEM,
  WORKER_PI_NOTES,
  WORKER_PI_SYSTEM,
} from "../../src/agents/roles/worker.ts";

/**
 * The fixed text of every agent role (goal 166), held byte for byte against the files in
 * golden/. A change to a role's text changes its file in the same commit, on purpose: run
 * `UPDATE_GOLDEN=1 node scripts/test.mjs tests/agents/role-texts.test.ts`, then read the diff.
 */
const TEXTS: Record<string, string> = {
  "worker.pi.system": WORKER_PI_SYSTEM,
  "worker.pi.notes-and-sources": WORKER_PI_NOTES,
  "worker.opencode.system": WORKER_OPENCODE_SYSTEM,
  "worker.claude-code.system": WORKER_CLAUDE_CODE_SYSTEM,
  "worker.codex.system": WORKER_CODEX_SYSTEM,
  "research-worker.system": RESEARCH_WORKER_SYSTEM,
  "research-worker.notes": RESEARCH_WORKER_NOTES,
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
  "teacher.system": TEACHER_SYSTEM,
  "merged-by.system": MERGED_BY_SYSTEM,
  "research-teacher.system": RESEARCH_TEACHER_SYSTEM,
  "research-merged-by.system": RESEARCH_MERGED_BY_SYSTEM,
  "auditor.system": AUDITOR_SYSTEM,
  "reviewer.system": REVIEWER_SYSTEM,
  "research-reviewer.system": RESEARCH_REVIEWER_SYSTEM,
  "final-writer.system": FINAL_WRITER_SYSTEM,
  "final-writer.ste-short-rules": STE_SHORT_RULES,
  "synthesizer.system": SYNTHESIZER_SYSTEM,
  "compaction.system": COMPACTION_SYSTEM,
};

const golden = (name: string) => new URL(`golden/${name}.txt`, import.meta.url);

for (const [name, text] of Object.entries(TEXTS)) {
  test(`the ${name} text is unchanged`, () => {
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden(name), text);
    assert.equal(text, readFileSync(golden(name), "utf8"));
  });
}
