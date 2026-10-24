/**
 * The names the harness and control share for the check that ends a research run (goal 112):
 * after its minimum running time, the review panel checks whether every question is answered, and
 * a final writer writes the run's research paper.
 */

/**
 * What a research run can and cannot do, for each agent that works on one or reviews it: its
 * evidence is what archived sources say, and nothing it runs is measured. A fact only a
 * measurement can settle is one of its paper's next experiments, for a goal or hill-climb run.
 */
export const MEASURES_NOTHING =
  "A research run reads, archives and cites sources, and its evidence is what those sources say. It has no target to measure, and nothing its workers run counts as evidence: no benchmark, no test on the hardware its questions are about, no change to a deployed system. A fact that only such a measurement could settle is not a gap that research can close: it is a next experiment, for a goal or hill-climb run to take after this one.";

/** The reserved goal name of a research run's review (a research contract has no goals). */
export const RESEARCH_REVIEW = "research";

/** A research run's close reason when the review panel found every question answered. */
export const ANSWERED = "every question is answered";

/** The harness asks the supervisor's final writer for a run's research paper. */
export const PAPER_REQUESTED = "research_paper_requested";
/** Code refused a paper the final writer wrote, with its problems. */
export const PAPER_REFUSED = "research_paper_refused";
/** Code accepted a run's research paper: it leads the run's final report. */
export const PAPER_ACCEPTED = "research_paper_accepted";

/** Why an answered research run closes without a paper, when its rig has no final writer. */
export const NO_WRITER = "no final writer on this rig";

/**
 * A research question's names (goal 117). Code, storage, file names and every field an agent
 * writes (a claim's, a hypothesis's or a task's `question`) number questions from 0. What people
 * read numbers them from 1: `questionName` ("Question 1"), for text only people read (the
 * dashboard, the paper, the journal's gap notes). A line an agent reads, or that agents and people
 * both read (a worker's brief, INDEX.md, REPORT.md, a task's title, the folder's files), names
 * both: `questionLabel` ("Question 1 (index 0)").
 */
export const questionName = (index: number): string => `Question ${index + 1}`;
export const questionLabel = (index: number): string => `Question ${index + 1} (index ${index})`;

/** The index a "Question N (index K)" label names, in a title or a line; undefined without one. */
export function labelledQuestion(text: string): number | undefined {
  const m = /\bquestion\s+\d+\s*\(\s*index\s+(\d+)\s*\)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}
