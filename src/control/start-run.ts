import { z } from "zod";
import { AskOwner } from "../core/commands.ts";
import type { ContextApplies } from "./campaign-context.ts";

/**
 * Start a run of a campaign control keeps, from outside the dashboard (goal 029): REST's
 * `POST /v1/campaigns/<name>/runs`, MCP's `start_run` and `thermite run start`. They take what
 * the campaign page's Start a run panel takes, and call the dashboard's own code for it
 * (ControlActions.startRun, filled in by dashboard.ts), so the panel and its twins check and
 * refuse alike. This module holds what the twins share: the request's fields, and the answer.
 */

/** What Start a run takes: the panel's fields, in the dashboard's terms. */
export interface StartRunRequest {
  campaign: string;
  rig: string;
  /** False: a try, with no agents (the judge measures the starting code on every case once). */
  agents: boolean;
  /** A model to give the rig's agents first, as the panel's "The agents' model". */
  model?: { provider: string; model: string } | undefined;
  promotion?: "auto" | "owner_approval" | undefined;
  /** What else the run asks the owner about (goal 079); unset: nothing. */
  askOwner?: AskOwner | undefined;
  /** How many of the rig's GPUs the judge measures on; empty: the rig's current split. */
  judgeGpus?: string | number | undefined;
  /** A run of the campaign whose untried experiments start the new run's queue. */
  queueFrom?: { rig: string; run: string } | undefined;
  /** Items of Thermite's knowledge base, by id: experiments join the queue, the rest the briefing. */
  past?: number[] | undefined;
}

/** What came of it: a run started, a model given first (start again later), or a refusal. */
export type StartRunOutcome =
  | {
      state: "started";
      campaign: string;
      rig: string;
      run: string;
      command: string;
      /** What control did to start the rig's stopped RunPod pod first, in words; null: nothing. */
      woke: string | null;
      /** The run at work on the rig, which pauses when this one starts (one run at a time). */
      pauses?: string | undefined;
      /** What else to know, in words: for example, a run to copy from had nothing untried. */
      notes: string[];
      /**
       * The campaign's own context settings and what each agent works with on the rig (goal 070),
       * when the campaign sets any; its words are one of the notes.
       */
      context?: ContextApplies | undefined;
    }
  | { state: "model_given"; said: string }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** The request's fields over REST and MCP: the panel's, in snake case. */
export const startRunFields = {
  rig: z.string().min(1).describe("The rig the run starts on"),
  agents: z
    .boolean()
    .optional()
    .describe(
      "false: a try, with no agents; the judge measures the starting code on every case once. Default: true",
    ),
  agents_model: z
    .strictObject({ provider: z.string().min(1), model: z.string().min(1) })
    .optional()
    .describe(
      "For a rig with no model for its agents: a model from a provider in Providers, given to the rig first. The run does not start yet: start it again once the rig has the model",
    ),
  promotion: z
    .enum(["auto", "owner_approval"])
    .optional()
    .describe(
      "When a change is confirmed better: keep it at once (auto: after an auditor's clear when the rig has an auditor and an audit is called for) or ask the owner every time (owner_approval). Default: the rig's, which is auto unless set",
    ),
  ask_owner: AskOwner.optional().describe(
    "What else the run asks the owner about; by default nothing (hands-off). above_gain: a confirmed gain above this fraction (0.15 is 15%) waits for the owner; declared_flaws: a win whose worker declared flaws waits; reviews: a review panel's pass of a subjective goal waits for the owner's acceptance; not_possible: a proposal to end a goal campaign as not possible waits",
  ),
  judge_gpus: z
    .number()
    .int()
    .optional()
    .describe(
      "For a rig with several GPUs: how many the judge measures on; the rest are the agents'. It changes the rig's split for every run on it, and the rig's harness restarts to apply it",
    ),
  queue_from: z
    .strictObject({ rig: z.string().min(1), run: z.string().min(1) })
    .optional()
    .describe(
      "Another run of the campaign: its untried experiments (up next in order, then its lanes' ideas, at most 500) start the new run's queue",
    ),
  past: z
    .array(z.number().int())
    .optional()
    .describe(
      "Items of Thermite's knowledge base by id (kb_search gives them), from folders the campaign may read: experiments join the queue after the copied ones; findings, claims, notes and reports go to every agent's brief as background",
    ),
};

/** The REST body: the fields above, and nothing else. */
export const StartRunBody = z.strictObject(startRunFields);
export type StartRunBody = z.infer<typeof StartRunBody>;

/** The request from a REST body or an MCP call's arguments. */
export function startRunRequest(campaign: string, b: StartRunBody): StartRunRequest {
  return {
    campaign,
    rig: b.rig,
    agents: b.agents ?? true,
    model: b.agents_model,
    promotion: b.promotion,
    askOwner: b.ask_owner,
    judgeGpus: b.judge_gpus,
    queueFrom: b.queue_from,
    past: b.past,
  };
}

/** A body that does not fit the fields, in words: each field and what is wrong with it. */
export function bodyRefusal(err: z.ZodError): string {
  return `bad request: ${err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
}

/**
 * The answer REST and MCP give: the new run and its command, with what else to know in words, or
 * `started: false` and what control said when it gave the rig a model first.
 */
export function startRunAnswer(
  out: Exclude<StartRunOutcome, { state: "refused" }>,
): Record<string, unknown> {
  if (out.state === "model_given") return { started: false, said: out.said };
  const notes = [
    ...(out.pauses
      ? [
          `${out.pauses} is at work on ${out.rig}, and pauses when this run starts (a rig runs one run at a time).`,
        ]
      : []),
    ...out.notes,
  ];
  return {
    started: true,
    campaign: out.campaign,
    rig: out.rig,
    run: out.run,
    command: out.command,
    status: "pending",
    ...(out.woke ? { woke: out.woke } : {}),
    ...(notes.length ? { notes } : {}),
    // What applies to the run's agents, when the campaign sets its own context (goal 070).
    ...(out.context ? { agents_context: out.context } : {}),
  };
}
