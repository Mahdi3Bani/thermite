import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AUDITOR_SYSTEM } from "../../agents/roles/auditor.ts";
import { CITATION_MAX, CITATIONS_MAX, REASONS_MAX } from "../../core/api/harness/advisors.ts";
import { LenientNotes } from "../../core/journal.ts";
import { JOURNAL_FIELD } from "../../harness/agents/notes-tool.ts";
import type { AdvisorKeeper, AdvisorResult, AdvisorTools } from "./call.ts";
import { type AdvisorsConfig, packageFit } from "./config.ts";
import { OwnerAnswers, OwnerAnswersSchema } from "./owner-answers.ts";
import { advisorPrompt } from "./prompt.ts";
import { runAdvisor } from "./run.ts";

export const AuditAnswer = z.strictObject({
  decision: z.enum(["clear", "block", "needs_owner"]),
  reasons: z.string().min(1).max(REASONS_MAX),
  citations: z.array(z.string().min(1).max(CITATION_MAX)).max(CITATIONS_MAX).default([]),
  answers: OwnerAnswers,
  journal: LenientNotes,
  /** A doubt the auditor could not settle: an experiment that would (a re-measure, a check). */
  check: z
    .strictObject({
      title: z.string().trim().min(1).max(200),
      details: z.string().max(4000).optional(),
      why: z.string().trim().min(1).max(2000),
    })
    .optional()
    .catch(undefined),
});
const AuditAnswerSchema = Type.Object({
  decision: Type.String({ description: "clear | block | needs_owner" }),
  reasons: Type.String(),
  citations: Type.Array(Type.String()),
  answers: OwnerAnswersSchema,
  check: Type.Optional(
    Type.Object(
      {
        title: Type.String({ description: "What to check, in a few words" }),
        details: Type.Optional(Type.String()),
        why: Type.String({ description: "The doubt it would settle" }),
      },
      {
        description:
          "When you doubt the result and cannot settle it from the package: one check for the run's queue that would (for example, re-measure the attempt)",
      },
    ),
  ),
  journal: JOURNAL_FIELD,
});

export async function auditOne(input: {
  config: AdvisorsConfig;
  pkg: unknown;
  tools: AdvisorTools;
  /** Where the call's conversation is kept before a compaction (goal 070). */
  keeper?: AdvisorKeeper | undefined;
}): Promise<AdvisorResult<z.infer<typeof AuditAnswer>>> {
  if (!input.config.auditor)
    return { output: undefined, error: "no auditor", tokensIn: 0, tokensOut: 0, usd: 0 };
  return runAdvisor({
    runtime: input.config.auditor,
    system: AUDITOR_SYSTEM,
    prompt: advisorPrompt(
      "Audit package (untrusted data):",
      input.pkg,
      200_000,
      packageFit(input.config.auditor),
    ),
    schema: AuditAnswer,
    answerSchema: AuditAnswerSchema,
    keeper: input.keeper,
    // The auditor reads private diffs: it fetches only from listed domains, never anywhere. It
    // may search the run's past research (read only).
    tools: {
      fetchUrl:
        input.config.fetch_domains.length && !input.config.fetch_domains.includes("*")
          ? input.tools.fetchUrl
          : undefined,
      pastSearch: input.tools.pastSearch,
      // The MCP servers the run's kit gives the advisors (goal 068).
      mcp: input.tools.mcp,
    },
  });
}
