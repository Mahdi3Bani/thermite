import { BARS } from "./style/bars.ts";
import { BASE } from "./style/base.ts";
import { DECISIONS } from "./style/decisions.ts";
import { FORMS } from "./style/forms.ts";
import { KNOWLEDGE } from "./style/knowledge.ts";
import { LAYOUT } from "./style/layout.ts";
import { LISTS } from "./style/lists.ts";
import { LIVE } from "./style/live.ts";
import { PANELS } from "./style/panels.ts";
import { PLANNER } from "./style/planner.ts";
import { RIG } from "./style/rig.ts";
import { RUNPOD } from "./style/runpod.ts";
import { RUNS } from "./style/runs.ts";
import { SESSION } from "./style/session.ts";
import { SHELL } from "./style/shell.ts";
import { SURFACES } from "./style/surfaces.ts";
import { TABLES } from "./style/tables.ts";
import { TIMELINE } from "./style/timeline.ts";
import { USAGE } from "./style/usage.ts";

/**
 * The dashboard's stylesheet. It follows Magnesium's design (the owner's agent UI, built on
 * T3 Code's tokens): a quiet zinc palette, an indigo primary, system fonts, 10 px card radius,
 * dense 11-12 px metadata, emerald / amber / red status colours, and a near-black dark theme
 * with hairline borders.
 *
 * Each part of the sheet is a module in style/. They join here in the cascade's order, so a later
 * rule wins over an earlier one of the same weight: keep a rule in its part, and a part in its
 * place.
 */
export const STYLE = `
${BASE}

${SHELL}

${LAYOUT}

${SURFACES}

${BARS}

${TABLES}

${DECISIONS}

${RUNS}

${RIG}

${TIMELINE}

${SESSION}
${FORMS}
${LISTS}
${PANELS}
${LIVE}
${PLANNER}
${KNOWLEDGE}
${RUNPOD}
${USAGE}
`;
