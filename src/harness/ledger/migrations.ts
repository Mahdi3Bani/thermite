import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../schema.ts";

/**
 * Every ledger migration, in order: schema.ts's, then the ones since, here, so schema.ts no longer
 * grows (goal 125). A change to the schema is a new entry at the end, never an edit of one that
 * has run.
 */
export const LEDGER_MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
  ...MIGRATIONS,
  // 22: the agents' public names (goal 125, T1): the owner's messages to the review panel, and
  // its reads of them, named it `panel`. Events keep their words; core/names.ts reads them under
  // the new ones.
  `
  update agent_message set target = 'review_panel' where target = 'panel';
  update agent_message_read set reader = 'review_panel' where reader = 'panel';
  `,
];
