import type { RigView, StoredEvent } from "../../views/index.ts";
import { type Sentence, sentenceContext } from "./context.ts";
import { judgeSentence } from "./judge.ts";
import { planSentence } from "./plan.ts";
import { reviewSentence } from "./reviews.ts";
import { rigSentence } from "./rig.ts";
import { runSentence } from "./runs.ts";

export { listText } from "../../../core/words.ts";
export { jobText } from "../judge-words.ts";
export { attemptState, signed, verdictText } from "../verdict-words.ts";
export type { Sentence } from "./context.ts";
export { auditReason } from "./judge.ts";
export { decisionTone, decisionWords, itemName } from "./reviews.ts";
export { checkName, commandText } from "./rig.ts";
export { clip, findAttempt, runStatusText, span } from "./shared.ts";

/**
 * Plain words for what the ledger records: verdicts, attempt states, judge jobs and events, so a
 * person reads "confirmed faster: +14.2%" rather than "win_confirmed 0.142". Everything returned
 * here is plain text: callers escape it.
 */

/**
 * One event as a sentence, or null for bookkeeping a person does not need (leases, builds,
 * imports, lifecycle steps that a verdict or a decision already says).
 *
 * Each group of events has its sentences in a module of words/. An event's kind is in one group
 * only: the other groups give null for it, so the first sentence found is its sentence.
 */
export function sentence(u: RigView, e: StoredEvent): Sentence | null {
  const w = sentenceContext(u, e);
  return (
    runSentence(w, e) ??
    judgeSentence(w, e) ??
    planSentence(w, e) ??
    reviewSentence(w, e) ??
    rigSentence(w, e)
  );
}
