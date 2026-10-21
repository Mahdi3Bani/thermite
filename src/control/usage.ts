import { z } from "zod";
import {
  UsagePeriod,
  type UsageReport,
  type UsageScope,
  usageReport,
  usageSince,
} from "../core/usage.ts";
import type { ControlStore } from "./store.ts";

/**
 * The agents' model usage as control sums it (goal 075): for one run, for a campaign (all its runs
 * on every rig) or for the whole system, over a period. REST (`GET /v1/usage`) and MCP
 * (`model_usage`) give the same report.
 */

/** What a reader asks for: a run (on one rig, or on any), a campaign, or neither (the system). */
export const UsageQuery = z
  .strictObject({
    run: z.string().trim().min(1).max(100).optional(),
    rig: z.string().trim().min(1).max(100).optional(),
    campaign: z.string().trim().min(1).max(200).optional(),
    period: UsagePeriod.default("all"),
  })
  .refine((q) => !(q.run && q.campaign), { message: "Give a run or a campaign, not both." })
  .refine((q) => !q.rig || q.run, { message: "A rig goes with a run: give the run too." });
export type UsageQuery = z.input<typeof UsageQuery>;

/** A query's problem in words, or undefined when it reads. */
export function usageQueryRefusal(raw: unknown): string | undefined {
  const q = UsageQuery.safeParse(raw);
  if (q.success) return undefined;
  const issue = q.error.issues[0];
  if (issue?.code === "unrecognized_keys")
    return `It takes run, rig, campaign and period, not ${issue.keys.join(", ")}.`;
  if (issue?.code === "custom") return issue.message;
  const field = String(issue?.path[0] ?? "");
  if (field === "period") return "The period is today, 7d or all.";
  return `A ${field} is 1 to ${field === "campaign" ? 200 : 100} characters.`;
}

/** The report for a query; a query that does not read throws its problem in words. */
export function modelUsage(store: ControlStore, raw: unknown, now = new Date()): UsageReport {
  const refused = usageQueryRefusal(raw);
  if (refused) throw new Error(refused);
  const q = UsageQuery.parse(raw);
  const scope: UsageScope = q.run
    ? { kind: "run", run: q.run, rig: q.rig ?? null }
    : q.campaign
      ? { kind: "campaign", campaign: q.campaign }
      : { kind: "system" };
  const since = usageSince(q.period, now);
  return usageReport(store.usageRows(scope, since), scope, q.period, since);
}
