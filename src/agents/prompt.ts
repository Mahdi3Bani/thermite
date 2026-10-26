/**
 * A prompt as its sections (goal 166): each part of what a role is sent, with where it comes
 * from, so the owner can see what a run added to the role's own text. promptText gives the exact
 * text sent; a section that is empty is left out.
 */

/** Where a section comes from. */
export type Source =
  | "role"
  | "assignment"
  | "contract"
  | "campaign brief"
  | "queue"
  | "planner"
  | "judge"
  | "ledger"
  | "field notes and past research"
  | "owner";

export interface Section {
  /** A short id, unique within the prompt. */
  id: string;
  source: Source;
  text: string;
  /** What comes before it in the text sent, after the section before it: a newline by default. */
  sep?: string | undefined;
}

export interface Prompt {
  role: string;
  sections: Section[];
}

/** A section made of lines: its non-empty lines, each on its own line. */
export function linesSection(
  id: string,
  source: Source,
  lines: readonly string[],
  sep?: string,
): Section {
  return { id, source, text: lines.filter((l) => l !== "").join("\n"), ...(sep ? { sep } : {}) };
}

/** A role's prompt from its sections; an empty section is left out. */
export function prompt(role: string, sections: readonly Section[]): Prompt {
  return { role, sections: sections.filter((s) => s.text !== "") };
}

/** The text sent: the sections in order, each after its separator. */
export function promptText(p: Prompt): string {
  return p.sections.map((s, i) => (i ? (s.sep ?? "\n") : "") + s.text).join("");
}
