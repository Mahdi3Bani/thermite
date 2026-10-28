import type { Prompt } from "../prompt.ts";
import { AUDITOR_SYSTEM, renderAuditor } from "./auditor.ts";
import { COMPACTION_SYSTEM, renderCompaction } from "./compaction.ts";
import { FINAL_WRITER_SYSTEM, renderFinalWriter, STE_SHORT_RULES } from "./final-writer.ts";
import { MERGED_BY_SYSTEM, RESEARCH_MERGED_BY_SYSTEM, renderMergedBy } from "./merged-by.ts";
import {
  MODEL_CHECK_PI_SYSTEM,
  modelCheckPiPrompt,
  modelCheckProgramPrompt,
  renderModelCheck,
} from "./model-check.ts";
import {
  PLAN_LIMITS_TEXT,
  PLANNER_ASK_SYSTEM,
  PLANNER_PI_SYSTEM,
  renderPlanner,
} from "./planner.ts";
import {
  RESEARCH_PLAN_LIMITS_TEXT,
  RESEARCH_PLANNER_ASK_SYSTEM,
  RESEARCH_PLANNER_PI_SYSTEM,
  renderResearchPlanner,
} from "./research-planner.ts";
import {
  RESEARCH_WORKER_NOTES,
  RESEARCH_WORKER_SYSTEM,
  renderResearchWorker,
} from "./research-worker.ts";
import {
  RESEARCH_REVIEWER_SYSTEM,
  REVIEWER_SYSTEM,
  renderResearchReviewer,
  renderReviewer,
} from "./reviewer.ts";
import { renderSynthesizer, SYNTHESIZER_SYSTEM } from "./synthesizer.ts";
import { RESEARCH_TEACHER_SYSTEM, renderTeacher, TEACHER_SYSTEM } from "./teacher.ts";
import {
  renderWorker,
  TRIAL_CUT_WHERE,
  WORKER_CLAUDE_CODE_SYSTEM,
  WORKER_CODEX_SYSTEM,
  WORKER_HOW_TO_WORK,
  WORKER_OPENCODE_SYSTEM,
  WORKER_PI_NOTES,
  WORKER_PI_SYSTEM,
} from "./worker.ts";

export { AUDITOR_SYSTEM, renderAuditor } from "./auditor.ts";
export {
  COMPACTION_SYSTEM,
  type KeptAt,
  renderCompaction,
} from "./compaction.ts";
export { FINAL_WRITER_SYSTEM, renderFinalWriter, STE_SHORT_RULES } from "./final-writer.ts";
export { MERGED_BY_SYSTEM, RESEARCH_MERGED_BY_SYSTEM, renderMergedBy } from "./merged-by.ts";
export {
  MODEL_CHECK_PI_SYSTEM,
  modelCheckPiPrompt,
  modelCheckProgramPrompt,
  renderModelCheck,
} from "./model-check.ts";
export {
  PLAN_LIMITS,
  PLANNER_ASK_SYSTEM,
  PLANNER_PI_SYSTEM,
  type PlannerInput,
  renderPlanner,
} from "./planner.ts";
export {
  PROMOTE_PER_ROUND,
  RESEARCH_PLAN_LIMITS,
  RESEARCH_PLANNER_ASK_SYSTEM,
  RESEARCH_PLANNER_PI_SYSTEM,
  renderResearchPlanner,
} from "./research-planner.ts";
export {
  RESEARCH_WORKER_NOTES,
  RESEARCH_WORKER_SYSTEM,
  type ResearchWorkerInput,
  renderResearchWorker,
} from "./research-worker.ts";
export {
  type LeftOut,
  RESEARCH_REVIEWER_SYSTEM,
  REVIEWER_SYSTEM,
  renderResearchReviewer,
  renderReviewer,
} from "./reviewer.ts";
export {
  type AdvisorFrame,
  advisorPackage,
  limitsNote,
  orderedPackage,
  renderOwnerMessages,
  windowFit,
} from "./shared.ts";
export { renderSynthesizer, SYNTHESIZER_SYSTEM } from "./synthesizer.ts";
export { RESEARCH_TEACHER_SYSTEM, renderTeacher, TEACHER_SYSTEM } from "./teacher.ts";
export {
  renderWorker,
  renderWorkerBrief,
  type TrialBudget,
  type TrialProgram,
  trialBudget,
  WORKER_CLAUDE_CODE_SYSTEM,
  WORKER_CODEX_SYSTEM,
  WORKER_OPENCODE_SYSTEM,
  WORKER_PI_NOTES,
  WORKER_PI_SYSTEM,
  type WorkerBriefInput,
  type WorkerInput,
} from "./worker.ts";

/**
 * Every agent role Thermite runs (goal 166), in one table: what each does, where it runs, which
 * model and agent programs it uses, whether the owner's messages reach it, its fixed texts, and
 * the one function that puts its prompt together for a run. A role's texts and that function live
 * in its own module in this folder: the harness and the supervisor gather what a run adds (the
 * brief, the rules, the queue, the owner's messages) and send what the function renders.
 */

/** One fixed text of a role, by its place in the role's instructions. */
export interface RoleText {
  /** A short id, unique within the role. */
  id: string;
  /** Where the text goes, in a few words. */
  what: string;
  text: string;
}

export interface RoleDefinition {
  id: string;
  /** Its name in the docs and on the dashboard. */
  name: string;
  /** What it does, in one sentence. */
  what: string;
  /** The container it runs in. */
  runsIn: "harness" | "supervisor" | "where its agent runs";
  /** The model it uses, as the owner sets it. */
  model: string;
  /** The agent programs it can run in. */
  programs: readonly string[];
  /** Whether the owner's messages (message_agent) reach it. */
  messages: boolean;
  texts: readonly RoleText[];
  /** The one function that puts its prompt together for a run (goal 166). */
  render: (...input: never[]) => Prompt;
}

const WORKER_PROGRAMS = ["Pi", "OpenCode", "Claude Code", "Codex"] as const;
const ADVISOR_PROGRAMS = ["Pi", "Claude Code", "OpenCode", "Codex", "a command (cli)"] as const;

export const ROLES: readonly RoleDefinition[] = [
  {
    id: "worker",
    name: "Worker",
    what: "Works one trial on one experiment of a hill-climb or goal run: changes the code, builds and tests it, and submits one attempt for the judge.",
    runsIn: "harness",
    model: "the workers' model",
    programs: WORKER_PROGRAMS,
    messages: true,
    render: renderWorker,
    texts: [
      { id: "pi", what: "its instructions in Pi", text: WORKER_PI_SYSTEM },
      { id: "pi-notes", what: "field notes and sources, after them in Pi", text: WORKER_PI_NOTES },
      { id: "opencode", what: "its instructions in OpenCode", text: WORKER_OPENCODE_SYSTEM },
      {
        id: "claude-code",
        what: "its instructions in Claude Code",
        text: WORKER_CLAUDE_CODE_SYSTEM,
      },
      { id: "codex", what: "its instructions in Codex", text: WORKER_CODEX_SYSTEM },
      {
        id: "how-to-work",
        what: "how it works, at the end of its brief",
        text: WORKER_HOW_TO_WORK.join("\n"),
      },
      {
        id: "cut",
        what: "where the rest is, when its first message is cut to fit the model's window (a research worker's too)",
        text: TRIAL_CUT_WHERE,
      },
    ],
  },
  {
    id: "research-worker",
    name: "Research worker",
    what: "Works one trial on one research task: fetches and reads sources, and records claims with exact quotes, notes, hypotheses and findings.",
    runsIn: "harness",
    model: "the workers' model",
    programs: ["Pi", "OpenCode"],
    messages: true,
    render: renderResearchWorker,
    texts: [
      { id: "system", what: "its instructions", text: RESEARCH_WORKER_SYSTEM },
      { id: "notes", what: "field notes, after its brief", text: RESEARCH_WORKER_NOTES },
    ],
  },
  {
    id: "planner",
    name: "Planner",
    what: "Coordinates a hill-climb or goal run's lanes each round: gives each lane its experiment, and changes the queue, the rules and the directions.",
    runsIn: "harness",
    model: "the planner's model, else the workers'",
    programs: WORKER_PROGRAMS,
    messages: true,
    render: renderPlanner,
    texts: [
      {
        id: "pi",
        what: "its instructions in Pi, with the submit_plan tool",
        text: PLANNER_PI_SYSTEM,
      },
      {
        id: "ask",
        what: "its instructions in another program, answering with JSON",
        text: PLANNER_ASK_SYSTEM,
      },
      { id: "limits", what: "the limits of its answer", text: PLAN_LIMITS_TEXT },
    ],
  },
  {
    id: "research-planner",
    name: "Research planner",
    what: "Plans a research run's next round: gives each lane a research task, and changes the queue and the pool of hypotheses.",
    runsIn: "harness",
    model: "the planner's model, else the workers'",
    programs: WORKER_PROGRAMS,
    messages: true,
    render: renderResearchPlanner,
    texts: [
      {
        id: "pi",
        what: "its instructions in Pi, with the submit_plan tool",
        text: RESEARCH_PLANNER_PI_SYSTEM,
      },
      {
        id: "ask",
        what: "its instructions in another program, answering with JSON",
        text: RESEARCH_PLANNER_ASK_SYSTEM,
      },
      { id: "limits", what: "the limits of its answer", text: RESEARCH_PLAN_LIMITS_TEXT },
    ],
  },
  {
    id: "teacher",
    name: "Teacher",
    what: "Reviews a hill-climb or goal run each round and brings new opportunities for its queue, advice for the planner and rules; it advises and never judges.",
    runsIn: "supervisor",
    model: "each teacher's model",
    programs: ADVISOR_PROGRAMS,
    messages: true,
    render: renderTeacher,
    texts: [{ id: "system", what: "its instructions", text: TEACHER_SYSTEM }],
  },
  {
    id: "research-teacher",
    name: "Research teacher",
    what: "Reviews a research run each round and brings new research tasks, advice for the planner and rules.",
    runsIn: "supervisor",
    model: "each teacher's model",
    programs: ADVISOR_PROGRAMS,
    messages: true,
    render: renderTeacher,
    texts: [{ id: "system", what: "its instructions", text: RESEARCH_TEACHER_SYSTEM }],
  },
  {
    id: "merged-by",
    name: "Merged by",
    what: "With two teachers, merges their advice into one set, neutral between them.",
    runsIn: "supervisor",
    model: "the merged-by model",
    programs: ADVISOR_PROGRAMS,
    messages: false,
    render: renderMergedBy,
    texts: [{ id: "system", what: "its instructions", text: MERGED_BY_SYSTEM }],
  },
  {
    id: "research-merged-by",
    name: "Research merged by",
    what: "With two teachers of a research run, merges their advice into one set.",
    runsIn: "supervisor",
    model: "the merged-by model",
    programs: ADVISOR_PROGRAMS,
    messages: false,
    render: renderMergedBy,
    texts: [{ id: "system", what: "its instructions", text: RESEARCH_MERGED_BY_SYSTEM }],
  },
  {
    id: "auditor",
    name: "Auditor",
    what: "Looks hard at a large confirmed win before it is promoted, and clears it, blocks it or asks the owner; it never judges.",
    runsIn: "supervisor",
    model: "the auditor's model",
    programs: ADVISOR_PROGRAMS,
    messages: true,
    render: renderAuditor,
    texts: [{ id: "system", what: "its instructions", text: AUDITOR_SYSTEM }],
  },
  {
    id: "reviewer",
    name: "Reviewer (review panel)",
    what: "Blind to who made it, decides a deliverable against its stated criteria; code checks the answers' form and counts the majority.",
    runsIn: "supervisor",
    model: "the review panel's model, run as three reviewers",
    programs: ADVISOR_PROGRAMS,
    messages: true,
    render: renderReviewer,
    texts: [{ id: "system", what: "its instructions", text: REVIEWER_SYSTEM }],
  },
  {
    id: "research-reviewer",
    name: "Research reviewer (review panel)",
    what: "Decides where each of a research run's questions and hypotheses stands, from the verified claims.",
    runsIn: "supervisor",
    model: "the review panel's model, run as three reviewers",
    programs: ADVISOR_PROGRAMS,
    messages: true,
    render: renderResearchReviewer,
    texts: [{ id: "system", what: "its instructions", text: RESEARCH_REVIEWER_SYSTEM }],
  },
  {
    id: "synthesizer",
    name: "Synthesizer",
    what: "Keeps one answer card for each of a research run's questions, from its verified claims; the harness checks each card.",
    runsIn: "supervisor",
    model: "the first teacher's model",
    programs: ADVISOR_PROGRAMS,
    messages: false,
    render: renderSynthesizer,
    texts: [{ id: "system", what: "its instructions", text: SYNTHESIZER_SYSTEM }],
  },
  {
    id: "final-writer",
    name: "Final writer",
    what: "When a research run ends, writes its research paper in Simplified Technical English; the harness accepts or refuses it.",
    runsIn: "supervisor",
    model: "the first teacher's model",
    programs: ADVISOR_PROGRAMS,
    messages: false,
    render: renderFinalWriter,
    texts: [
      { id: "system", what: "its instructions", text: FINAL_WRITER_SYSTEM },
      { id: "ste", what: "the short STE rules, with no STE checker", text: STE_SHORT_RULES },
    ],
  },
  {
    id: "model-check",
    name: "Model check",
    what: "One short call that shows the agents can reach their model and call a tool, before they start and when their route changes.",
    runsIn: "harness",
    model: "the workers' model and program",
    programs: WORKER_PROGRAMS,
    messages: false,
    render: renderModelCheck,
    texts: [
      { id: "pi", what: "its instructions in Pi", text: MODEL_CHECK_PI_SYSTEM },
      { id: "pi-prompt", what: "what it asks in Pi", text: modelCheckPiPrompt("<word>") },
      {
        id: "program-prompt",
        what: "what it asks another program",
        text: modelCheckProgramPrompt("<word>"),
      },
    ],
  },
  {
    id: "compaction",
    name: "Compaction",
    what: "When an agent's conversation nears its model's window, the agent's own model summarizes the work so far, and the conversation goes on from it.",
    runsIn: "where its agent runs",
    model: "the agent's own model",
    programs: ["Pi", "Codex"],
    messages: false,
    render: renderCompaction,
    texts: [
      {
        id: "system",
        what: "its instructions (Codex's compact prompt starts with them)",
        text: COMPACTION_SYSTEM,
      },
    ],
  },
];

/** A role by its id. */
export function roleOf(id: string): RoleDefinition | undefined {
  return ROLES.find((r) => r.id === id);
}
