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
