/**
 * A run's target queue depth, the sameness of two ideas, and the rules that may never be set
 * (goal 081).
 *
 * The target is how many queued experiments a run keeps ready for its lanes' next trials. It
 * drives ideas: when the queue is below it, the planner's round is asked to top it up with
 * distinct ideas, and when the planner can't, the teachers are asked at once. It is never a cap:
 * nothing stops adding experiments above it, and nothing ends research because of it. A
 * campaign sets it in its contract (`lanes.queue_target`); without one, it is two for each lane.
 */

/** The target's default: experiments kept ready for each lane. */
export const QUEUE_TARGET_PER_LANE = 2;

/** A run's target: the contract's own, or two for each of its lanes (`lanes`: the lanes now). */
export function queueTarget(
  contract: { lanes: { count: number; queue_target?: number | undefined } },
  lanes?: number | undefined,
): number {
  return contract.lanes.queue_target ?? QUEUE_TARGET_PER_LANE * (lanes ?? contract.lanes.count);
}

/** Where the target comes from, in words: "2 for each of 2 lanes", or the campaign's own. */
export function queueTargetNote(
  contract: { lanes: { count: number; queue_target?: number | undefined } },
  lanes?: number | undefined,
): string {
  const l = lanes ?? contract.lanes.count;
  if (contract.lanes.queue_target === 0) return "no ideas are asked for";
  if (contract.lanes.queue_target !== undefined) return "the campaign's own number";
  return `${QUEUE_TARGET_PER_LANE} for each of ${l} lane${l === 1 ? "" : "s"}`;
}

/** The target in words: "4 (2 for each of 2 lanes)", or "7 (the campaign's own number)". */
export function queueTargetWords(
  contract: { lanes: { count: number; queue_target?: number | undefined } },
  lanes?: number | undefined,
): string {
  return `${queueTarget(contract, lanes)} (${queueTargetNote(contract, lanes)})`;
}

/**
 * An idea's words for comparing it with another: its title in lowercase, letters and digits
 * only, one space between words. Two ideas with the same words are one idea.
 */
export function ideaWords(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A rule as an advisor gives it, for the refusals below. */
export interface RuleText {
  kind: string;
  family?: string | undefined;
  value?: string | number | undefined;
  rationale: string;
}

/** Why code refuses a rule: it freezes the queue's size, or pins an experiment. */
export interface RuleRefusal {
  reason: "freezes_queue" | "pins_experiment";
  why: string;
}

/** Words that freeze the queue's size, or stop ideas reaching it. */
const FREEZES: RegExp[] = [
  /\b(?:do not|don't|dont|never|no longer|stop|avoid|refrain from|cease)\s+(?:add|adding|queue|queueing|queuing|propose|proposing|insert|inserting|creat(?:e|ing)|push|pushing)\b[^.;]*\b(?:queue|experiments?|entr(?:y|ies)|ideas?|items?|proposals?)\b/i,
  /\b(?:keep|leave|hold|maintain)\s+(?:the\s+)?(?:run'?s\s+)?(?:experiment\s+)?queue\s+(?:unchanged|as\s+(?:it\s+)?is|frozen|fixed|static|the\s+same|steady|stable|small|short|empty|at\s+(?:its\s+)?(?:current\s+)?(?:size|length|\d+))\b/i,
  /\b(?:freeze|lock|cap|limit|restrict|shrink)\s+(?:the\s+)?(?:run'?s\s+)?(?:experiment\s+)?queue\b/i,
  /\bqueue\s+(?:is\s+|stays\s+|remains\s+)?(?:frozen|locked|closed|full)\b/i,
  /\bno\s+(?:new|more|further|additional)\s+(?:queue\s+|queued\s+)?(?:entr(?:y|ies)|experiments?|ideas?|items?|proposals?)\b/i,
  /\b(?:at\s+most|no\s+more\s+than|only|max(?:imum)?(?:\s+of)?)\s+\d+\s+(?:queued\s+)?(?:experiments?|entr(?:y|ies)|items?|ideas?)\s+(?:queued|in\s+the\s+queue|up\s+next|ready)\b/i,
];

/** An experiment's id, as a rule might name one. */
const EXPERIMENT_ID = /\bx-[0-9a-f]{12}\b/;

/** Words that pin an experiment: keep it first, run it again, hold it in place. */
const PINS =
  /\b(?:pin(?:s|ned)?|keep\b[^.;]*\b(?:top|first|front|next|in\s+place)|always\s+(?:first|next|on\s+top)|first\s+in\s+(?:the\s+)?queue|at\s+the\s+top|re-?(?:try|run|queue|measure)|retr(?:y|ied|ies)|tried\s+again|try\s+again|until\b|before\s+any(?:thing)?\s+else|do\s+not\s+(?:move|drop|reorder))/i;

/**
 * Why a rule from the advisors is refused (goal 081), or undefined when it may stand. A rule may
 * never freeze the queue's size ("do not add queue entries", "keep the queue unchanged"): the
 * queue keeps a target of ideas ready. Nor may it pin an experiment (name one with words that
 * keep it first or run it again): a rule names directions, and an experiment's place is the
 * queue's, which moves change.
 */
export function ruleRefusal(r: RuleText): RuleRefusal | undefined {
  const text = [r.family ?? "", typeof r.value === "string" ? r.value : "", r.rationale].join(
    " \n ",
  );
  const frozen = FREEZES.map((p) => p.exec(text)?.[0]).find(Boolean);
  if (frozen)
    return {
      reason: "freezes_queue",
      why: `a rule may not freeze the queue's size ("${frozen.trim().slice(0, 120)}"): the run keeps a target of experiments ready, and the planner and the teachers add ideas to it. Leave the queue's size alone; avoid a direction, or drop nothing, instead`,
    };
  const id = EXPERIMENT_ID.exec(text)?.[0];
  if (id && (PINS.test(text) || r.kind === "priority" || r.kind === "mandate"))
    return {
      reason: "pins_experiment",
      why: `a rule may not pin an experiment (${id}): a rule names directions. To put an experiment first, move it in the queue (moves); the planner decides when it runs`,
    };
  return undefined;
}
