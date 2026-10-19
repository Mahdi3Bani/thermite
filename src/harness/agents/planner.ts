import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { canonicalJson } from "../../core/canonical.ts";
import type { StructuredDirective } from "../../core/commands.ts";
import { buildModel, type ModelConfig } from "./model.ts";
import type { Assignment, Evidence, FamilyView } from "./registry.ts";

/**
 * The planner: one stateless model call per epoch. Its context is built deterministically from
 * the ledger; its output is a plan through a single tool call, checked against the directives
 * (AVOID families are never assigned, MANDATE families always are). Invalid output gets one
 * retry with the errors, then the deterministic fallback: planner trouble never pauses research.
 */

export interface PlannerInput {
  run: string;
  epoch: number;
  laneCount: number;
  objective: string;
  editablePaths: string[];
  champion: { seq: number; gain: number };
  families: FamilyView[];
  evidence: Evidence[];
  directives: { id: number; body: StructuredDirective }[];
  laneBests: Record<string, string | null>;
  /** The contract's notes (written by the campaign's author, approved with the contract). */
  campaignNotes?: string | undefined;
  /** The owner's messages to the planner since the last plan (message_agent). */
  ownerMessages?: string[] | undefined;
  /** Goal mode: the judge's latest report on the champion. */
  goalReport?: GoalReport | undefined;
}

/** The judge's validation of a goal campaign's champion: what it meets and what it does not. */
export interface GoalReport {
  champion_seq: number;
  goals: { goal: string; status: string; reasons: string }[];
}

export interface NewFamily {
  id: string;
  description: string;
}

export interface PlanResult {
  source: "planner" | "fallback";
  tries: number;
  /** True when the model's plan was valid (on any try). */
  valid: boolean;
  /** What was wrong with the model's raw output, per try (the directive-compliance record). */
  rawViolations: string[];
  assignments: Assignment[];
  newFamilies: NewFamily[];
  notes?: string | undefined;
}

const FamilyId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
const PlanSchema = z.object({
  new_families: z
    .array(z.object({ id: FamilyId, description: z.string().min(3).max(300) }))
    .max(8)
    .default([]),
  assignments: z.array(
    z.object({
      lane: z.string(),
      family: FamilyId,
      focus: z.string().min(3).max(600),
      parent: z.enum(["champion", "lane_best"]),
    }),
  ),
  notes: z.string().max(2000).optional(),
});

export function lanesOf(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `lane-${i + 1}`);
}

function directiveSets(input: PlannerInput) {
  const of = (k: string) =>
    new Set(
      input.directives
        .filter((d) => d.body.kind === k && d.body.family)
        .map((d) => String(d.body.family)),
    );
  return { avoid: of("avoid"), mandate: of("mandate"), tryFam: of("try") };
}

/** Checks a raw plan; returns the errors (empty when valid) and the parsed plan. */
export function validatePlan(
  raw: unknown,
  input: PlannerInput,
): { errors: string[]; plan?: z.infer<typeof PlanSchema> } {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success)
    return { errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const plan = parsed.data;
  const errors: string[] = [];
  const lanes = lanesOf(input.laneCount);
  const assigned = plan.assignments.map((a) => a.lane).sort();
  if (canonicalJson(assigned) !== canonicalJson([...lanes].sort())) {
    errors.push(
      `assign each of ${lanes.join(", ")} exactly once (got ${assigned.join(", ") || "none"})`,
    );
  }
  const known = new Set([
    ...input.families.filter((f) => f.status === "live").map((f) => f.id),
    ...plan.new_families.map((f) => f.id),
  ]);
  const { avoid, mandate } = directiveSets(input);
  for (const a of plan.assignments) {
    if (!known.has(a.family))
      errors.push(`${a.lane}: family ${a.family} is not live and not proposed as new`);
    if (avoid.has(a.family))
      errors.push(`${a.lane}: family ${a.family} is under an AVOID directive`);
    if (a.parent === "lane_best" && !input.laneBests[a.lane]) {
      errors.push(`${a.lane}: has no lane best yet; use parent "champion"`);
    }
  }
  for (const m of mandate) {
    if (!plan.assignments.some((a) => a.family === m))
      errors.push(`MANDATE directive: assign family ${m} to a lane`);
  }
  return { errors, plan };
}

/**
 * Attribution: each assignment whose family a MANDATE (first) or TRY directive names records that
 * directive, so a directive's effect on an epoch can be traced to the lanes it steered.
 */
export function attribute(
  assignments: Assignment[],
  directives: { id: number; body: StructuredDirective }[],
): Assignment[] {
  const find = (kind: string, family: string) =>
    directives.filter((d) => d.body.kind === kind && d.body.family === family).at(-1)?.id;
  return assignments.map((a) => {
    const directive = find("mandate", a.family) ?? find("try", a.family);
    return directive === undefined ? a : { ...a, directive };
  });
}

/** The deterministic plan: mandated families first, then tried, then the least explored. */
export function fallbackPlan(input: PlannerInput): {
  assignments: Assignment[];
  newFamilies: NewFamily[];
} {
  const { avoid, mandate, tryFam } = directiveSets(input);
  const newFamilies: NewFamily[] = [];
  const live = input.families.filter((f) => f.status === "live" && !avoid.has(f.id));
  for (const m of mandate) {
    if (!live.some((f) => f.id === m)) {
      const d = input.directives.find((x) => x.body.kind === "mandate" && x.body.family === m);
      // A fixed description: a directive's rationale is for the planner, never for workers.
      newFamilies.push({
        id: m,
        description: `the "${m}" direction${d ? ` (named by directive ${d.id})` : ""}`,
      });
    }
  }
  const pool = [
    ...live.map((f) => ({ id: f.id, description: f.description, attempts: f.attempts })),
    ...newFamilies.map((f) => ({ ...f, attempts: 0 })),
  ];
  if (!pool.length) {
    const general = {
      id: "general",
      description: "Any correct change that improves the primary metric",
    };
    newFamilies.push(general);
    pool.push({ ...general, attempts: 0 });
  }
  const rank = (id: string) => (mandate.has(id) ? 0 : tryFam.has(id) ? 1 : 2);
  pool.sort(
    (a, b) => rank(a.id) - rank(b.id) || a.attempts - b.attempts || a.id.localeCompare(b.id),
  );
  const assignments = lanesOf(input.laneCount).map((lane, i) => {
    const f = pool[i % pool.length] as { id: string; description: string };
    return {
      lane,
      family: f.id,
      focus: `Work on the "${f.id}" direction: ${f.description}`,
      parent: input.laneBests[lane] ? ("lane_best" as const) : ("champion" as const),
    };
  });
  return { assignments, newFamilies };
}

/** The planner's task, the same through every harness; only how it answers differs. */
const TASK = `You plan the next epoch of an automated research campaign. Each lane runs one
worker; give each lane one direction (an approach family) and a concrete focus. Spread lanes over
different directions so they do not duplicate each other; reuse directions with promising evidence
and propose a new family when a genuinely different approach is worth trying. Obey the directives:
never assign an AVOID family, always assign every MANDATE family, prefer TRY families. Messages in
owner_messages come from the campaign's owner: take them into account. In a goal campaign,
goal_report is the judge's check of the champion: aim lanes at goals it does not meet yet (a goal
"not run" waits on a goal it requires), never at work the champion already does.`;

/** In Pi, the planner answers with its one tool. */
const SYSTEM = `${TASK} Answer only by calling submit_plan once.`;

/** Through another harness (OpenCode), it answers with the plan as JSON text and no tools. */
const ASK_SYSTEM = `${TASK} Answer with only the plan, as one JSON object: {"new_families": [{"id": "...", "description": "..."}], "assignments": [{"lane": "lane-1", "family": "...", "focus": "...", "parent": "champion" or "lane_best"}], "notes": "..."}. Use no tools.`;

/** A planner call through another harness (OpenCode): the prompt in, the model's answer out. */
export type Ask = (prompt: string, signal?: AbortSignal) => Promise<string>;

export async function plan(
  input: PlannerInput,
  model?: ModelConfig,
  signal?: AbortSignal,
  ask?: Ask,
): Promise<PlanResult> {
  const rawViolations: string[] = [];
  if (model) {
    const context = canonicalJson({
      epoch: input.epoch,
      lanes: lanesOf(input.laneCount),
      objective: input.objective,
      editable_paths: input.editablePaths,
      champion: input.champion,
      families: input.families,
      evidence: input.evidence,
      directives: input.directives.map((d) => ({ id: d.id, ...d.body })),
      lane_bests: input.laneBests,
      ...(input.campaignNotes ? { campaign_notes: input.campaignNotes } : {}),
      ...(input.ownerMessages?.length ? { owner_messages: input.ownerMessages } : {}),
      ...(input.goalReport ? { goal_report: input.goalReport } : {}),
    });
    let feedback = "";
    for (let tries = 1; tries <= 2; tries++) {
      if (signal?.aborted) break;
      let raw: unknown;
      try {
        raw = ask
          ? await askPlanner(ask, `${context}${feedback}`, signal)
          : await callPlanner(model, `${context}${feedback}`, signal);
      } catch (err) {
        rawViolations.push(`try ${tries}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const { errors, plan: p } = validatePlan(raw, input);
      if (!errors.length && p) {
        return {
          source: "planner",
          tries,
          valid: true,
          rawViolations,
          assignments: p.assignments,
          newFamilies: p.new_families,
          notes: p.notes,
        };
      }
      rawViolations.push(...errors.map((e) => `try ${tries}: ${e}`));
      feedback = `\n\nYour previous plan was refused:\n- ${errors.join("\n- ")}\n${ask ? "Answer again with a corrected plan." : "Call submit_plan again with a corrected plan."}`;
    }
  }
  const f = fallbackPlan(input);
  return {
    source: "fallback",
    tries: model ? 2 : 0,
    valid: false,
    rawViolations,
    assignments: f.assignments,
    newFamilies: f.newFamilies,
  };
}

/** The planner through another harness: the same instructions, with the plan as JSON text. */
async function askPlanner(ask: Ask, context: string, signal?: AbortSignal): Promise<unknown> {
  const text = await ask(`${ASK_SYSTEM}\n\nThe campaign, as JSON:\n${context}`, signal);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`the planner's answer was not a JSON plan: ${text.slice(0, 200)}`);
  }
}

async function callPlanner(
  cfg: ModelConfig,
  context: string,
  signal?: AbortSignal,
): Promise<unknown> {
  // Only Claude Code may use a Claude subscription: the planner never calls it itself.
  if (cfg.api === "claude")
    throw new Error(
      "a Claude subscription runs only in Claude Code, and none is set up for the planner",
    );
  const { models, model, thinkingLevel } = buildModel(cfg);
  let captured: unknown;
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM,
      model,
      thinkingLevel,
      tools: [
        {
          name: "submit_plan",
          label: "submit_plan",
          description: "Submit the plan for the next epoch.",
          parameters: Type.Object({
            new_families: Type.Optional(
              Type.Array(Type.Object({ id: Type.String(), description: Type.String() })),
            ),
            assignments: Type.Array(
              Type.Object({
                lane: Type.String(),
                family: Type.String(),
                focus: Type.String(),
                parent: Type.Union([Type.Literal("champion"), Type.Literal("lane_best")]),
              }),
            ),
            notes: Type.Optional(Type.String()),
          }),
          execute: async (_id, params) => {
            captured = params;
            return {
              content: [{ type: "text", text: "plan received" }],
              details: {},
              terminate: true,
            };
          },
        },
      ],
    },
    streamFn: models.streamSimple.bind(models),
  });
  const timer = setTimeout(() => agent.abort(), 180_000);
  const cancel = () => agent.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (!signal?.aborted) await agent.prompt(context);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
  if (captured === undefined) throw new Error("the planner did not call submit_plan");
  return captured;
}
