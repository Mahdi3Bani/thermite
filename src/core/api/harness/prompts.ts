import { z } from "zod";
import { PROMPT_RECORD_MAX_CHARS, PromptRecord, PromptSection } from "../../prompts.ts";
import type { Route } from "../route.ts";

/**
 * The harness's API for the prompts its run's agents were sent (goal 166; src/harness/api/
 * prompts.ts answers it): the supervisor keeps its advisors' prompts there, and reads a run's
 * prompts, one prompt whole, and a preview of the next one, on the rig. Every route takes the
 * supervisor's token.
 */

/** The roles whose prompts the supervisor sends: its advisors. The harness keeps the rest. */
export const ADVISOR_PROMPT_ROLES = [
  "teacher",
  "research-teacher",
  "merged-by",
  "research-merged-by",
  "auditor",
  "reviewer",
  "research-reviewer",
  "synthesizer",
  "final-writer",
] as const;

/** An advisor's prompt, as the supervisor sent it, for the harness to keep with its run. */
export const KEEP_PROMPT = {
  method: "POST",
  path: "/v1/prompts",
  body: PromptRecord.extend({
    run: z.string().min(1).max(100),
    role: z.enum(ADVISOR_PROMPT_ROLES),
    sections: z
      .array(PromptSection)
      .min(1)
      .max(200)
      .refine(
        (ss) => ss.reduce((n, s) => n + s.text.length, 0) <= PROMPT_RECORD_MAX_CHARS,
        `a prompt kept has at most ${PROMPT_RECORD_MAX_CHARS.toLocaleString("en-US")} characters`,
      ),
  }),
  answer: z.looseObject({ id: z.number() }),
  maxBytes: 16 * 1024 * 1024,
} as const satisfies Route;

/** A prompt kept, without its text. */
export const PromptInfo = z.looseObject({
  id: z.number(),
  run: z.string(),
  role: z.string(),
  program: z.string(),
  lane: z.string().nullable(),
  trial: z.string().nullable(),
  call: z.string().nullable(),
  version: z.string(),
  at: z.string(),
  chars: z.number(),
  bytes: z.number(),
});

/** A run's prompts, oldest first, without their text. */
export const RUN_PROMPTS = {
  method: "GET",
  path: "/v1/runs/:run/prompts",
  answer: z.looseObject({ prompts: z.array(PromptInfo) }),
} as const satisfies Route;

/** One prompt of a run, whole: its sections, each with its source and its text. */
export const RUN_PROMPT = {
  method: "GET",
  path: "/v1/runs/:run/prompts/:id",
  answer: PromptInfo.extend({ sections: z.array(PromptSection) }),
} as const satisfies Route;

/**
 * The prompt a role would be sent next in a run, rendered now on the rig with no side effect:
 * nothing is kept, no message is marked as given and no file is written (`?role=worker&lane=`
 * or `?role=planner`).
 */
export const PROMPT_PREVIEW = {
  method: "GET",
  path: "/v1/runs/:run/prompt-preview",
  answer: z.looseObject({
    role: z.string(),
    program: z.string(),
    sections: z.array(PromptSection),
  }),
} as const satisfies Route;
