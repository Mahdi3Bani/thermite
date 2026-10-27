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
