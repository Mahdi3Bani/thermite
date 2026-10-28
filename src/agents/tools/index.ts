/**
 * The tools agents use in every program, shared by the harness and the supervisor: the names
 * agents and their instructions use for Thermite's tools (names.ts), field notes (notes.ts), a
 * research worker's tools (research.ts), and the harness's fetcher for research (fetcher.ts).
 */

export { Fetcher, FetchRefused, htmlToText, registrableDomain } from "./fetcher.ts";
export {
  NOTE_USAGE,
  PAST_SEARCH_DESCRIPTION,
  PAST_SEARCH_TOOL,
  RUN_RESEARCH_TOOLS,
} from "./names.ts";
export { JOURNAL_FIELD, NOTE_TOOL, NoteLimit, type NoteRequest } from "./notes.ts";
export {
  CLAIM_LIMITS,
  CLAIM_LIMITS_WORDS,
  CODE_RESEARCH_TOOLS,
  codeResearchNote,
  moreText,
  READ_MAX,
  RESEARCH_TOOLS,
  type ResearchFolderPaths,
  researchCommands,
  researchFolderNote,
  researchOutput,
  researchTool,
  SOURCE_PARAM,
} from "./research.ts";
