import { z } from "zod";
import { canonicalSha } from "./canonical.ts";
import { DURATION_PATTERN, parseDuration } from "./duration.ts";

/**
 * Campaign contract, schema version 1.
 *
 * A contract is frozen data: changing anything makes a new version. The `mode` field selects
 * one of three shapes (hill climb, goal, research); the shared fields come first.
 */

export const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "lowercase id");
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");
/** A full commit id (SHA-1 or SHA-256). Abbreviations are refused: they can be ground. */
export const CommitSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "full git commit id (40 or 64 hex)");
export const DurationSchema = z.string().regex(DURATION_PATTERN, 'duration like "30m" or "8h"');
const MetricSchema = z.string().min(1);
const Direction = z.enum(["max", "min"]);
/** A regular expression that compiles; checked when the contract is validated, not at use. */
const RegexSchema = z
  .string()
  .min(1)
  .refine((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  }, "invalid regular expression");

const SearchPolicy = z.strictObject({
  /** What public search may be used for, stated for agents and auditors. */
  allowed_purposes: z.array(z.string().min(1)).default([]),
  /** Regular expressions; matching queries are refused and logged. */
  blocked_patterns: z.array(RegexSchema).default([]),
});

/**
 * The most lanes a rig can run: its harness image has a user for each of lanes 1 to 16
 * (containers/harness/Containerfile; IDS.maxLanes in src/harness/broker/runner.ts). A contract's
 * lanes.count, a rig's workers at a time and the campaign builder refuse more, with this reason.
 */
export const MAX_LANES = 16;
export const MAX_LANES_REASON = `at most ${MAX_LANES}: a rig has users for lanes 1 to ${MAX_LANES} only`;

/**
 * What a worker's lane may use. Optional and without schema defaults, so contracts written
 * before it keep their hash; laneLimits() fills the defaults.
 */
const LaneLimits = z.strictObject({
  /** One shell or lane-tool command (a build, a test). Unset: no limit (the trial's end). */
  run_timeout_s: z.number().int().min(10).max(7200).optional(),
  run_rss_mib: z.number().int().min(256).max(16_384).optional(),
  /** The trial's workspace, build trees included. */
  workspace_mib: z.number().int().min(256).max(65_536).optional(),
  /**
   * One development run on the measurement device. Unset: no limit on a dedicated development
   * card; on a card the judge shares, the rig's own (the judge needs the card back).
   */
  dev_run_timeout_s: z.number().int().min(10).max(3600).optional(),
  dev_run_rss_mib: z.number().int().min(256).max(16_384).optional(),
  /** A worker's whole trial. Unset: the rig's default (THERMITE_TRIAL_MINUTES). */
  trial_minutes: z.number().int().min(1).max(1440).optional(),
  /**
   * Processes and threads each of a lane's users may have at once (RLIMIT_NPROC): its commands
   * and OpenCode or Claude Code, its development runs, and its Pi worker. Unset: 256.
   */
  processes: z.number().int().min(64).max(65_536).optional(),
});

const Common = {
  schema_version: z.literal(1),
  campaign: IdSchema,
  version: z.number().int().positive(),
  title: z.string().min(1),
  project: z.strictObject({
    repo: z.string().min(1),
    commit: CommitSchema.optional(),
    kit: z.strictObject({ repo: z.string().min(1), commit: CommitSchema }).optional(),
  }),
  target: z.strictObject({ type: z.string().min(1), class: z.string().min(1) }).optional(),
  models: z.array(z.strictObject({ name: z.string().min(1), sha256: Sha256Schema })).default([]),
  lanes: z
    .strictObject({
      count: z.number().int().min(1).max(MAX_LANES, MAX_LANES_REASON),
      trials_per_epoch: z.number().int().min(1).default(3),
      /** Raised limits for heavy projects (see laneLimits for the defaults). */
      limits: LaneLimits.optional(),
    })
    .default({ count: 2, trials_per_epoch: 3 }),
  budget: z
    .strictObject({
      wall_hours: z.number().positive().optional(),
      device_hours: z.number().positive().optional(),
      llm_usd: z.number().nonnegative().optional(),
      max_open_attempts: z.number().int().positive().default(4),
    })
    .default({ max_open_attempts: 4 }),
  min_duration: DurationSchema.optional(),
  max_duration: DurationSchema.optional(),
  search_policy: SearchPolicy.optional(),
  notes: z.string().optional(),
};

const EditPolicy = {
  /** Globs of paths a candidate may change. Anything else is refused at V0. */
  editable_paths: z.array(z.string().min(1)).min(1),
  /** Regular expressions; an added line matching one is refused at V0. */
  forbidden_patterns: z.array(RegexSchema).default([]),
};

const Acceptance = z
  .strictObject({
    alpha_screen: z.number().gt(0).lt(1).default(0.1),
    alpha_confirm: z.number().gt(0).lt(1).default(0.05),
    equivalence_band: z.number().positive().default(0.005),
    looks: z.array(z.number().int().positive()).min(1).default([3, 6, 9]),
    confirm_blocks: z.number().int().positive().default(5),
    /**
     * Runs per arm and cell inside each block; the block uses their median. More than one makes
     * a single disturbed run (a noisy shared host) unable to swing a block.
     */
    runs_per_cell: z.number().int().min(1).max(9).default(1),
    audit: z
      .strictObject({
        ratio_to_median: z.number().positive().default(3),
        absolute: z.number().positive().default(0.15),
      })
      .default({ ratio_to_median: 3, absolute: 0.15 }),
  })
  .default({
    alpha_screen: 0.1,
    alpha_confirm: 0.05,
    equivalence_band: 0.005,
    looks: [3, 6, 9],
    confirm_blocks: 5,
    runs_per_cell: 1,
    audit: { ratio_to_median: 3, absolute: 0.15 },
  });

const Guard = z.strictObject({
  metric: MetricSchema,
  direction: Direction,
  /** Allowed regression per promotion step, as a fraction (0.01 = 1%). */
  max_step_regression: z.number().min(0),
  /** Allowed regression against the campaign baseline, as a fraction. */
  max_total_regression: z.number().min(0),
});

const HardConstraint = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("min"), metric: MetricSchema, value: z.number() }),
  z.strictObject({ kind: z.literal("max"), metric: MetricSchema, value: z.number() }),
  /** A named check in the project kit that must pass. */
  z.strictObject({ kind: z.literal("check"), check: z.string().min(1) }),
]);

export const HillClimbContract = z.strictObject({
  ...Common,
  ...EditPolicy,
  mode: z.literal("hill_climb"),
  objective: z.strictObject({
    policy: z.enum(["single", "lexicographic"]).default("single"),
    primary: z.strictObject({
      metric: MetricSchema,
      direction: Direction,
      min_effect: z.number().positive(),
    }),
    secondary: z.array(z.strictObject({ metric: MetricSchema, direction: Direction })).default([]),
  }),
  guards: z.array(Guard).default([]),
  hard_constraints: z.array(HardConstraint).default([]),
  monitor_only: z.array(MetricSchema).default([]),
  cells: z.array(z.string().min(1)).min(1),
  held_out_cells: z.array(z.string().min(1)).default([]),
  acceptance: Acceptance,
});

const Verify = z.discriminatedUnion("type", [
  /** A verifier script in the project kit; agents see pass/fail and bounded diagnostics. */
  z.strictObject({ type: z.literal("code"), verifier: z.string().min(1) }),
  z.strictObject({
    type: z.literal("metric_threshold"),
    metric: MetricSchema,
    op: z.enum([">=", "<=", ">", "<"]),
    value: z.number(),
    cells: z.array(z.string().min(1)).optional(),
  }),
  /** Subjective goals: a blind model panel reviews, the owner gives final acceptance. */
  z.strictObject({ type: z.literal("review"), criteria: z.array(z.string().min(1)).min(1) }),
]);

const GoalItem = z.strictObject({
  id: IdSchema,
  description: z.string().min(1),
  priority: z.number().int().min(1).default(1),
  required: z.boolean().default(true),
  parent: IdSchema.optional(),
  verify: Verify,
});

export const GoalContract = z
  .strictObject({
    ...Common,
    ...EditPolicy,
    mode: z.literal("goal"),
    goals: z.array(GoalItem).min(1),
    success: z
      .strictObject({
        policy: z.enum(["all_required", "k_of_n"]).default("all_required"),
        k: z.number().int().positive().optional(),
      })
      .default({ policy: "all_required" }),
    /** What a verified solution is (a commit, an artifact, a report). */
    deliverable: z.string().min(1),
    /** Outcomes that must never be reported as success (special cases, reductions, ...). */
    insufficient: z.array(z.string().min(1)).default([]),
    /** Failure modes every candidate is checked for by adversarial audit. */
    adversarial_checklist: z.array(z.string().min(1)).default([]),
    infeasibility: z
      .strictObject({
        allowed: z.boolean(),
        min_refuted_approaches: z.number().int().positive().optional(),
      })
      .default({ allowed: false }),
    /** Epochs during which lanes get no cross-lane evidence. */
    independence_epochs: z.number().int().min(0).default(2),
    /** Approach families that must stay alive at once. */
    min_live_families: z.number().int().min(1).default(2),
    /** Runs per cell when a metric threshold is checked; its interval needs several. */
    threshold_reps: z.number().int().min(2).max(20).default(5),
    held_out_cells: z.array(z.string().min(1)).default([]),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const g of c.goals) {
      if (ids.has(g.id)) ctx.addIssue({ code: "custom", message: `duplicate goal id ${g.id}` });
      ids.add(g.id);
    }
    for (const g of c.goals) {
      if (g.parent && !ids.has(g.parent)) {
        ctx.addIssue({ code: "custom", message: `goal ${g.id} has unknown parent ${g.parent}` });
      }
    }
    if (c.success.policy === "all_required" && !c.goals.some((g) => g.required)) {
      ctx.addIssue({ code: "custom", message: "all_required needs at least one required goal" });
    }
    if (c.success.policy === "k_of_n") {
      if (c.success.k === undefined || c.success.k > c.goals.length) {
        ctx.addIssue({ code: "custom", message: "k_of_n needs 1 <= k <= number of goals" });
      }
    }
    if (c.infeasibility.allowed && c.infeasibility.min_refuted_approaches === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "infeasibility.allowed requires min_refuted_approaches",
      });
    }
  });

export const ResearchContract = z.strictObject({
  ...Common,
  mode: z.literal("research"),
  topic: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
  /** Starting URLs (without a search provider, research follows links from these). */
  seeds: z.array(z.url()).default([]),
  scope: z
    .strictObject({
      include_domains: z.array(z.string()).default([]),
      exclude_domains: z.array(z.string()).default([]),
      source_types: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([]),
    })
    .default({ include_domains: [], exclude_domains: [], source_types: [], languages: [] }),
  report_cadence: z
    .strictObject({
      digest_minutes: z.number().int().positive().default(60),
      report_hours: z.number().positive().default(24),
    })
    .default({ digest_minutes: 60, report_hours: 24 }),
  quality: z
    .strictObject({
      /** Claims count only when every quote is found verbatim in the archived source. */
      verbatim_quotes: z.literal(true).default(true),
      min_independent_sources: z.number().int().min(1).default(2),
    })
    .default({ verbatim_quotes: true, min_independent_sources: 2 }),
  fetch_policy: z
    .strictObject({
      respect_robots: z.boolean().default(true),
      per_domain_per_minute: z.number().int().positive().default(6),
      max_bytes: z.number().int().positive().default(5_000_000),
      allow_logins: z.literal(false).default(false),
    })
    .default({
      respect_robots: true,
      per_domain_per_minute: 6,
      max_bytes: 5_000_000,
      allow_logins: false,
    }),
});

export const ContractSchema = z
  .discriminatedUnion("mode", [HillClimbContract, GoalContract, ResearchContract])
  .superRefine((c, ctx) => {
    if (c.min_duration && c.max_duration) {
      if (parseDuration(c.max_duration) < parseDuration(c.min_duration)) {
        ctx.addIssue({ code: "custom", message: "max_duration is shorter than min_duration" });
      }
    }
    if (c.mode === "research" && !c.min_duration) {
      ctx.addIssue({ code: "custom", message: "research campaigns need min_duration" });
    }
    if (c.mode === "hill_climb" && !c.target) {
      ctx.addIssue({ code: "custom", message: "hill_climb campaigns need a target" });
    }
  });

export type Contract = z.infer<typeof ContractSchema>;
export type HillClimbContract = z.infer<typeof HillClimbContract>;
export type GoalContract = z.infer<typeof GoalContract>;
export type ResearchContract = z.infer<typeof ResearchContract>;
export type Mode = Contract["mode"];

export type ContractParse =
  | { ok: true; contract: Contract; sha: string }
  | { ok: false; errors: string[] };

/** Validates a contract and returns it with defaults applied and its content hash. */
export function parseContract(input: unknown): ContractParse {
  const r = ContractSchema.safeParse(input);
  if (!r.success) {
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, contract: r.data, sha: contractSha(r.data) };
}

export interface LaneLimitValues {
  /** Unset: a lane command runs until it ends (no default time limit; owner, 2026-10-16). */
  runTimeoutS?: number | undefined;
  runRssMib: number;
  workspaceMib: number;
  /** Unset: see dev_run_timeout_s. */
  devRunTimeoutS?: number | undefined;
  devRunRssMib: number;
  trialMinutes?: number | undefined;
  /** RLIMIT_NPROC for each of the lane's users (lane, development and agent). */
  processes: number;
}

/** A dev run's limit on a device the judge shares, when the contract sets none. */
export const SHARED_DEV_RUN_S = 300;

/** A lane user's processes and threads when the contract sets none (the broker's own default). */
export const LANE_PROCESSES = 256;

/** A contract's lane limits, with the defaults for anything it leaves out. */
export function laneLimits(contract: Pick<Contract, "lanes">): LaneLimitValues {
  const l = contract.lanes.limits ?? {};
  return {
    runTimeoutS: l.run_timeout_s,
    runRssMib: l.run_rss_mib ?? 2048,
    workspaceMib: l.workspace_mib ?? 2048,
    devRunTimeoutS: l.dev_run_timeout_s,
    devRunRssMib: l.dev_run_rss_mib ?? 4096,
    trialMinutes: l.trial_minutes,
    processes: l.processes ?? LANE_PROCESSES,
  };
}

/** The content hash of a validated contract: sha256 of its canonical JSON. */
export function contractSha(contract: Contract): string {
  return canonicalSha(contract);
}
