import { z } from "zod";

/**
 * What a rig's report says still runs (`summary.work`): its open trials, the judge's jobs and a
 * drain. Each open trial comes with its task and counters (goal 136) and, from a harness with goal
 * 143, what it is doing: when it last sent a line, its open model call (Pi) and a streak of the
 * same calls. The report is the harness's; these schemas read it leniently, field by field.
 */

const Reply = z.object({
  since: z.string().max(40),
  text: z.number(),
  thinking: z.number(),
  tool_args: z.number(),
  reported_at: z.string().max(40),
});

const Repeating = z.object({
  count: z.number(),
  since: z.string().max(40),
  different: z.number(),
  calls: z.array(z.object({ call: z.string().max(400), times: z.number() })).max(20),
});

export const OpenTrial = z.object({
  trial: z.string().max(64),
  run: z.string().max(80),
  lane: z.string().max(32),
  started_at: z.string().max(40),
  task: z.string().max(4000).nullable(),
  question: z.number().int().nullable(),
  turns: z.number(),
  tool_calls: z.number(),
  tokens_in: z.number(),
  claims: z.number().nullable(),
  refused_again: z
    .object({
      url: z.string().max(1000),
      reason: z.string().max(1000),
      asked: z.number(),
      at: z.string().max(40),
      times: z.number(),
    })
    .nullable(),
  // From a harness with goal 143; absent from an older one.
  last_line_at: z.string().max(40).nullable().optional(),
  reply: Reply.nullable().optional(),
  repeating: Repeating.nullable().optional(),
});
export type OpenTrial = z.infer<typeof OpenTrial>;

export const Work = z.object({
  trials: z.number(),
  judge_jobs: z.number(),
  draining: z
    .object({
      since: z.string().max(40),
      reason: z.string().max(1000),
      by: z.string().max(200).optional(),
    })
    .nullable(),
  open: z.array(OpenTrial).max(64).optional(),
});
export type Work = z.infer<typeof Work>;

/** The report's `work`, when it reads; undefined from a harness too old to send it. */
export function workOf(summary: unknown): Work | undefined {
  const w = Work.safeParse((summary as { work?: unknown } | null | undefined)?.work);
  return w.success ? w.data : undefined;
}

/** What a lane's trial is doing, as at_work gives it (goal 143); null where it doesn't say. */
export interface TrialDoing {
  last_line_at: string | null;
  reply: z.infer<typeof Reply> | null;
  repeating: z.infer<typeof Repeating> | null;
}

/** Each open trial's doings, by trial; none from a harness older than goal 143. */
export function doingsOf(summary: unknown): Map<string, TrialDoing> {
  const out = new Map<string, TrialDoing>();
  for (const t of workOf(summary)?.open ?? []) {
    if (t.last_line_at === undefined) continue;
    out.set(t.trial, {
      last_line_at: t.last_line_at,
      reply: t.reply ?? null,
      repeating: t.repeating ?? null,
    });
  }
  return out;
}
