import { z } from "zod";
import { CommitSchema, DurationSchema, IdSchema, parseContract } from "../core/contract.ts";
import { KitSchema, kitProblems } from "../harness/kit.ts";

/**
 * The new-campaign page's answers, turned into a contract and, for a kit described on the
 * page, the kit itself. Everything here is checked as the harness would check it, so a
 * campaign the page accepts is one a rig accepts.
 *
 * A kit described on the page is a few shell commands. Control writes two small wrappers around
 * them, so the person writing them never meets the kit's own placeholders:
 *   run/run.sh      runs the run command with {build}, {out}, {kit} and each case's parameters
 *   check/check.sh  runs the check command and turns its exit status into the judge's verdict
 */

const ParamName = z.string().regex(/^[a-z_][a-z0-9_]{0,31}$/, "a parameter name: a-z, 0-9, _");
const FileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "a file name: letters, digits, . _ -");
const GitUrl = z
  .string()
  .max(2000)
  .regex(/^(?:https:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/, "an https, ssh or git URL");
const Glob = z.string().min(1).max(500);

/** One test case: a name and what makes its run different, all optional. */
const Case = z.strictObject({
  name: IdSchema,
  /** Added to the run command as {args}. */
  args: z.string().max(2000).optional(),
  /** One of the kit's input files, given to the run as {input}. */
  input: FileName.optional(),
  /** Named values, as {name} in the commands. */
  params: z.record(ParamName, z.union([z.string().max(500), z.number()])).default({}),
  /** How much one run does (requests, frames, bytes): then the score is a rate, not time. */
  work: z.number().positive().optional(),
  /** A hidden test: used only to double-check a change that already looks better. */
  hidden: z.boolean().default(false),
});

const KitHere = z.strictObject({
  source: z.literal("here"),
  build: z.string().min(1).max(4000),
  outputs: z.array(z.string().min(1).max(500)).min(1),
  cases: z.array(Case).min(1).max(64),
  run: z.string().min(1).max(4000),
  check: z.string().min(1).max(4000),
  /** Files the kit carries: references and inputs. `run` files are also visible to the run. */
  files: z
    .array(
      z.strictObject({
        name: FileName,
        content_base64: z.string().max(14_000_000),
        run: z.boolean().default(false),
      }),
    )
    .max(32)
    .default([]),
  /** Input files the cases run on ({input}): both the run and the check can read them. */
  inputs: z
    .array(z.strictObject({ name: FileName, content_base64: z.string().max(14_000_000) }))
    .max(32)
    .default([]),
  build_timeout_s: z.number().int().positive().max(86_400).optional(),
  run_timeout_s: z.number().int().positive().max(86_400).optional(),
  held_out: z.array(IdSchema).default([]),
  /** Runs per case in each measurement; their median counts. */
  runs_per_case: z.number().int().min(1).max(9).optional(),
});
/** Git access control keeps, by name (Settings), for a private repository. */
const AccessName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "a Git access name");

const KitRepo = z.strictObject({
  source: z.literal("repo"),
  url: GitUrl,
  access: AccessName.optional(),
  commit: CommitSchema,
  repo: IdSchema,
  /** The kit's cases this campaign measures, and those held back for confirmation. */
  cells: z.array(IdSchema).min(1),
  held_out: z.array(IdSchema).default([]),
});

const Goal = z.strictObject({
  id: IdSchema,
  description: z.string().min(1).max(2000),
  required: z.boolean().default(true),
  verify: z.discriminatedUnion("type", [
    /** The check passes on every one of these cases. */
    z.strictObject({ type: z.literal("check"), cells: z.array(IdSchema).min(1) }),
    /** The score clears a bound on these cases. */
    z.strictObject({
      type: z.literal("metric"),
      op: z.enum([">=", "<=", ">", "<"]),
      value: z.number(),
      cells: z.array(IdSchema).min(1),
    }),
    /** People review it. */
    z.strictObject({
      type: z.literal("review"),
      criteria: z.array(z.string().min(1).max(500)).min(1),
    }),
  ]),
});

export const CampaignDraft = z.strictObject({
  mode: z.enum(["hill_climb", "goal", "research"]),
  campaign: IdSchema,
  title: z.string().min(1).max(300),
  notes: z.string().max(8000).optional(),
  /** The rig's measurement target, from the rig the campaign starts on. */
  target: z.strictObject({ type: z.string().min(1), class: z.string().min(1) }),
  project: z
    .strictObject({
      url: GitUrl,
      access: AccessName.optional(),
      ref: z.string().max(300).optional(),
      commit: CommitSchema,
      repo: IdSchema,
      editable_paths: z.array(Glob).min(1),
      forbidden_patterns: z.array(z.string().min(1).max(500)).default([]),
    })
    .optional(),
  kit: z.discriminatedUnion("source", [KitHere, KitRepo]).optional(),
  /**
   * The score. "time": how long a run takes, from the judge's clock (a rate instead when every
   * measured case says how much work it does). "check": a number the check works out from the
   * run's output and prints in its JSON line, under `field`.
   */
  score: z
    .strictObject({
      kind: z.enum(["time", "check"]).default("time"),
      name: IdSchema.optional(),
      field: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
        .optional(),
      unit: z.string().max(40).optional(),
      direction: z.enum(["max", "min"]).default("max"),
      min_effect: z.number().positive().max(10).default(0.05),
    })
    .optional(),
  goals: z.array(Goal).max(64).optional(),
  research: z
    .strictObject({
      topic: z.string().min(1).max(2000),
      questions: z.array(z.string().min(1).max(1000)).min(1).max(50),
      seeds: z.array(z.string().url()).max(100).default([]),
      min_duration: DurationSchema,
    })
    .optional(),
  lanes: z.number().int().min(1).max(16).default(2),
  limits: z
    .strictObject({
      trial_minutes: z.number().int().min(1).max(1440).optional(),
      run_rss_mib: z.number().int().min(256).max(16384).optional(),
      workspace_mib: z.number().int().min(256).max(65536).optional(),
    })
    .default({}),
  wall_hours: z.number().positive().optional(),
});
export type CampaignDraft = z.input<typeof CampaignDraft>;

export interface BuiltKit {
  /** The kit's repository name (and kit.json name). */
  name: string;
  /** Path in the kit → content. */
  files: Record<string, Buffer>;
}

export type Built =
  | { ok: true; contract: Record<string, unknown>; kit?: BuiltKit | undefined }
  | { ok: false; errors: string[] };

/** The kit's name for a campaign: its own repository beside the project. */
export const kitName = (campaign: string) => `${campaign.slice(0, 59)}-kit`;

/** A shell word: single-quoted, with any single quote closed, escaped and reopened. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A command as written on the page, with its placeholders as shell variables: {build}, {out}
 * and {kit} for the directories, and {name} for each case parameter. Unknown placeholders are
 * an error, so a typo does not reach a rig.
 */
export function shellCommand(
  cmd: string,
  params: Set<string>,
): { text: string; unknown: string[] } {
  const fixed: Record<string, string> = {
    build: `"$BUILD"`,
    out: `"$OUT"`,
    kit: `"$KIT"`,
    // The case's arguments, split into words as written.
    args: "$P_args",
    // The case's input file, from the kit's inputs.
    input: '"$KIT/inputs/$P_input"',
  };
  const unknown: string[] = [];
  const text = cmd.replace(/\{([a-z_][a-z0-9_]*)\}/g, (m, name: string) => {
    if (fixed[name]) return fixed[name] as string;
    if (params.has(name)) return `"$P_${name}"`;
    unknown.push(m);
    return m;
  });
  return { text, unknown };
}

const wrapper = (kind: "run" | "check", command: string) => `#!/bin/sh
# Written by Thermite control from the new-campaign page: the ${kind} command as entered there.
# Arguments: the build, the output directory, the case's parameters (key=value lines), the kit.
set -u
BUILD="$1"; OUT="$2"; PARAMS="$3"; KIT="$4"
export BUILD OUT KIT
# A case's arguments and input file, empty unless it has them.
P_args=; P_input=
while IFS='=' read -r k v; do
  [ -n "$k" ] && eval "P_$k=\\$v" && export "P_$k"
done < "$PARAMS"
${
  kind === "run"
    ? `exec sh -c ${sq(command)}`
    : `# The judge reads one JSON line: pass when the command exits 0.
tail_file="$(mktemp)"
sh -c ${sq(command)} > "$tail_file" 2>&1
status=$?
last="$(tail -n 1 "$tail_file")"
if [ "$status" -eq 0 ]; then
  # A check that prints its own JSON line (a score such as {"pass": true, "accuracy": 0.93})
  # is passed on as it is.
  case "$last" in
    "{"*'"pass"'*"}") printf '%s\n' "$last" ;;
    *) echo '{"pass": true, "reasons": []}' ;;
  esac
else
  reason="$(tail -c 400 "$tail_file" | tr '\\n"\\\\' '   ' )"
  printf '{"pass": false, "reasons": ["the check exited %s: %s"]}\\n' "$status" "$reason"
fi
rm -f "$tail_file"`
}
`;

/** Builds the contract (and kit) from the page's answers, or says what is wrong in words. */
export function buildCampaign(input: unknown): Built {
  const parsed = CampaignDraft.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "the form"}: ${i.message}`),
    };
  const d = parsed.data;
  const errors: string[] = [];
  const contract: Record<string, unknown> = {
    schema_version: 1,
    campaign: d.campaign,
    version: 1,
    title: d.title,
    mode: d.mode,
    lanes: {
      count: d.lanes,
      ...(Object.keys(d.limits).length ? { limits: d.limits } : {}),
    },
    ...(d.notes ? { notes: d.notes } : {}),
    ...(d.wall_hours ? { budget: { wall_hours: d.wall_hours } } : {}),
  };

  if (d.mode === "research") {
    if (!d.research)
      return { ok: false, errors: ["a research campaign needs its topic and questions"] };
    Object.assign(contract, {
      project: { repo: d.project?.repo ?? `${d.campaign.slice(0, 50)}-notes` },
      topic: d.research.topic,
      questions: d.research.questions,
      seeds: d.research.seeds,
      min_duration: d.research.min_duration,
    });
    const r = parseContract(contract);
    return r.ok ? { ok: true, contract } : { ok: false, errors: r.errors };
  }

  if (!d.project)
    errors.push("the campaign needs its project: a repository and the files agents may change");
  if (!d.kit)
    errors.push("the campaign needs a way to measure: describe the kit, or name a kit repository");
  if (errors.length || !d.project || !d.kit) return { ok: false, errors };

  let kit: BuiltKit | undefined;
  let kitRef: { repo: string; commit?: string };
  let cells: string[] = [];
  let heldOut: string[] = [];
  // The score: what the judge compares, and which way is better.
  let metric = d.score?.name ?? (d.score?.kind === "check" ? (d.score.field ?? "score") : "rate");
  let direction: "max" | "min" = d.score?.direction ?? "max";
  if (d.kit.source === "here") {
    const k = d.kit;
    const params = new Set(k.cases.flatMap((c) => Object.keys(c.params)));
    const run = shellCommand(k.run, params);
    const check = shellCommand(k.check, params);
    for (const u of [...run.unknown, ...check.unknown])
      errors.push(
        `${u} is not a placeholder here: use {args}, {input}, {build}, {out} or {kit}${params.size ? `, or a value: ${[...params].map((p) => `{${p}}`).join(", ")}` : ""}`,
      );
    const names = new Set<string>();
    const inputs = new Set(k.inputs.map((f) => f.name));
    for (const c of k.cases) {
      if (names.has(c.name)) errors.push(`two test cases are named ${c.name}`);
      names.add(c.name);
      if (c.input && !inputs.has(c.input))
        errors.push(`test case ${c.name} runs on ${c.input}, which is not among the input files`);
    }
    for (const h of k.held_out)
      if (!names.has(h)) errors.push(`hidden test ${h} is not one of the test cases`);
    heldOut = [...new Set([...k.held_out, ...k.cases.filter((c) => c.hidden).map((c) => c.name)])];
    cells = k.cases.map((c) => c.name).filter((n) => !heldOut.includes(n));
    if (!cells.length)
      errors.push("at least one test case must be measured every time, not only as a hidden test");
    const files: Record<string, Buffer> = {
      "run/run.sh": Buffer.from(wrapper("run", run.text)),
      "check/check.sh": Buffer.from(wrapper("check", check.text)),
    };
    const seen = new Set<string>();
    for (const f of k.files) {
      if (seen.has(f.name) || f.name === "run.sh" || f.name === "check.sh" || f.name === "inputs")
        errors.push(`the file ${f.name} is given twice, or has a name the kit uses itself`);
      seen.add(f.name);
      const body = Buffer.from(f.content_base64, "base64");
      files[`check/${f.name}`] = body;
      if (f.run) files[`run/${f.name}`] = body;
    }
    // Input files: the run reads them as {input}, and so may the check.
    for (const f of k.inputs) {
      const body = Buffer.from(f.content_base64, "base64");
      files[`run/inputs/${f.name}`] = body;
      files[`check/inputs/${f.name}`] = body;
    }
    // Time, or a rate when every measured case says how much work it does, or the check's number.
    const kind = d.score?.kind ?? "time";
    const measured = k.cases.filter((c) => !heldOut.includes(c.name));
    let metricDef: Record<string, unknown>;
    if (kind === "check") {
      const field = d.score?.field;
      if (!field) errors.push("name the number your check reports (for example accuracy)");
      metricDef = { unit: d.score?.unit ?? "", from: "check", field: field ?? "score" };
    } else if (measured.length && measured.every((c) => c.work)) {
      metricDef = { unit: d.score?.unit ?? "per s", work: "work" };
      direction = "max";
    } else {
      metric = d.score?.name ?? "seconds";
      metricDef = { unit: "s", from: "time" };
      direction = "min";
    }
    const manifest = {
      schema_version: 1,
      name: kitName(d.campaign),
      target: d.target.type,
      build: {
        command: ["sh", "-c", k.build],
        outputs: k.outputs,
        ...(k.build_timeout_s ? { timeout_s: k.build_timeout_s } : {}),
      },
      cells: Object.fromEntries(
        k.cases.map((c) => [
          c.name,
          {
            ...c.params,
            ...(c.args ? { args: c.args } : {}),
            ...(c.input ? { input: c.input } : {}),
            ...(c.work ? { work: c.work } : {}),
          },
        ]),
      ),
      run: {
        copy: ["run"],
        command: ["sh", "{kit:run/run.sh}", "{build}", "{out}", "{params}", "{kit:run}"],
        ...(k.run_timeout_s ? { timeout_s: k.run_timeout_s } : {}),
      },
      metrics: { [metric]: metricDef },
      check: {
        command: ["sh", "{kit:check/check.sh}", "{build}", "{out}", "{params}", "{kit:check}"],
      },
      verifiers: Object.fromEntries(
        (d.goals ?? [])
          .filter((g) => g.verify.type === "check")
          .map((g) => [g.id, { cells: (g.verify as { cells: string[] }).cells }]),
      ),
    };
    files["kit.json"] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const kitCheck = KitSchema.safeParse(manifest);
    if (!kitCheck.success)
      errors.push(
        ...kitCheck.error.issues.map((i) => `the kit: ${i.path.join(".")}: ${i.message}`),
      );
    kit = { name: kitName(d.campaign), files };
    kitRef = { repo: kit.name };
  } else {
    kitRef = { repo: d.kit.repo, commit: d.kit.commit };
    cells = d.kit.cells.filter((c) => !d.kit?.held_out.includes(c));
    heldOut = d.kit.held_out;
  }

  Object.assign(contract, {
    // The kit's commit is filled in when control stores a kit it wrote.
    project: {
      repo: d.project.repo,
      kit: { repo: kitRef.repo, commit: kitRef.commit ?? "0".repeat(40) },
    },
    target: d.target,
    editable_paths: d.project.editable_paths,
    forbidden_patterns: d.project.forbidden_patterns,
  });
  if (d.mode === "hill_climb") {
    Object.assign(contract, {
      objective: {
        primary: {
          metric,
          direction,
          min_effect: d.score?.min_effect ?? 0.05,
        },
      },
      cells,
      ...(heldOut.length ? { held_out_cells: heldOut } : {}),
      ...(d.kit.source === "here" && d.kit.runs_per_case
        ? { acceptance: { runs_per_cell: d.kit.runs_per_case } }
        : {}),
    });
  } else {
    if (!d.goals?.length) errors.push("a goal campaign needs at least one goal");
    Object.assign(contract, {
      goals: (d.goals ?? []).map((g, i) => ({
        id: g.id,
        description: g.description,
        priority: i + 1,
        required: g.required,
        verify:
          g.verify.type === "check"
            ? { type: "code", verifier: g.id }
            : g.verify.type === "metric"
              ? {
                  type: "metric_threshold",
                  metric,
                  op: g.verify.op,
                  value: g.verify.value,
                  cells: g.verify.cells,
                }
              : { type: "review", criteria: g.verify.criteria },
      })),
      deliverable: "a commit that meets every required goal",
      ...(heldOut.length ? { held_out_cells: heldOut } : {}),
    });
  }
  if (errors.length) return { ok: false, errors };
  const r = parseContract(contract);
  if (!r.ok) return { ok: false, errors: r.errors };
  // The contract against the kit, as the harness checks it at assignment.
  if (kit) {
    const parsedKit = KitSchema.parse(JSON.parse(String(kit.files["kit.json"])));
    const problems = kitProblems(r.contract, parsedKit, d.target.type);
    if (problems.length) return { ok: false, errors: problems };
  }
  return { ok: true, contract, kit };
}
