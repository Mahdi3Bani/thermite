/**
 * The judge's reasons for a failure: a crashed run's exit and its standard error, a check's
 * words, a build's error. Each reason is bounded. When one is cut, its start and its end are
 * kept: the start says what failed, and the end of a command's output is where its error
 * usually is.
 */

/** The most one failure keeps: one run, one check, one build, one cell of a goal. */
export const REASON_CHARS = 2000;

/** The most a verdict's or a goal check's reasons keep: several failures together. */
export const REASONS_CHARS = 4000;

const CUT = " … ";

/** `text` cut to `max` characters, keeping a quarter of them from its start and the rest from its end. */
export function clipReason(text: string, max: number = REASON_CHARS): string {
  if (text.length <= max) return text;
  const room = max - CUT.length;
  const head = Math.floor(room / 4);
  return `${text.slice(0, head)}${CUT}${text.slice(text.length - (room - head))}`;
}
