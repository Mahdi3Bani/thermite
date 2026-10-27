import { z } from "zod";

/**
 * Names and IDs every part checks the same way (goal 125, T1).
 */

/**
 * A rig's name: what every place a rig runs takes, in a Kubernetes namespace (`thermite-<rig>`),
 * a compose service or a machine's units.
 */
export const RIG_ID = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** What a rig's name takes, in words. */
export const RIG_ID_WORDS =
  "a rig's name is 2 to 40 characters of a-z, 0-9 and -, starting and ending with a letter or digit";

/** The same, as a sentence on a page. */
export const RIG_ID_SENTENCE = `A${RIG_ID_WORDS.slice(1)}.`;

/**
 * A campaign's or a run's name (goal 170): up to 64 lowercase letters, digits, - and _, starting
 * with a letter or digit. No dot: a message bus's subject splits on one. A repository's, a kit's
 * and a case's names keep theirs (core/contract.ts's IdSchema).
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NAME_WORDS =
  "lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or a digit";
export const CampaignId = z.string().regex(NAME_PATTERN, `a campaign's name is ${NAME_WORDS}`);
export const RunId = z.string().regex(NAME_PATTERN, `a run's name is ${NAME_WORDS}`);
