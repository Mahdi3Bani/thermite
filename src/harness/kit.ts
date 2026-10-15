import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";

/**
 * A project kit: the judge-side recipe for building and measuring one project on one target
 * type. It is pinned by commit in the contract, imported through a signed command, and never
 * readable by agents. Kit scripts may be in whatever language the project's tooling needs.
 *
 * Commands are argv arrays with placeholders:
 *   {kit}    the kit checkout in the check; in a run, the run's read-only copy of `run.copy`
 *   {build}  the verified build directory of the arm being run (read-only)
 *   {params} a file with the cell's parameters as key=value lines ({params_json}: as JSON)
 *   {out}    the run's output directory
 *   {models} the imported models, one read-only file per sha256: `{models:<sha256>}` (run and
 *            check only; the contract's `models` list names them)
 */

const Argv = z.array(z.string().min(1)).min(1);
const Mib = z.number().int().positive();
/** A path inside the kit, never the whole kit. */
const KitPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      p !== "." &&
      !p.startsWith("/") &&
      !p.endsWith("/") &&
      !p.split("/").includes("..") &&
      posix.normalize(p) === p,
    "a kit path is relative, normalized and inside the kit",
  );

const KitFields = z.strictObject({
  schema_version: z.literal(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  /** The target driver type this kit measures on (cpu, cuda-gpu, ...). */
  target: z.string().min(1),
  build: z.strictObject({
    /** Kit paths copied into the build tree under .kit/ (build-time inputs, not secrets). */
    copy: z.array(KitPath).default([]),
    /** Run in the source tree as the builder user. */
    command: Argv,
    /** Paths, relative to the source tree, that make up the build. */
    outputs: z.array(z.string().min(1)).min(1),
    timeout_s: z.number().int().positive().default(600),
    rss_mib: Mib.default(4096),
    disk_mib: Mib.default(4096),
  }),
  /** Every measurable cell and its parameters. The contract chooses which cells count. */
  cells: z.record(
    z.string().min(1),
    z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  ),
  /** One timed run of one arm on one cell, as the run user. */
  run: z.strictObject({
    /**
     * Kit paths copied fresh into every run, read-only and owned by the judge, and reached as
     * `{kit:<path>}`: run drivers and their inputs, which the candidate's build cannot rewrite.
     * The run can read them, so never references or held-out inputs.
     */
    copy: z.array(KitPath).default([]),
    command: Argv,
    timeout_s: z.number().int().positive().default(300),
    rss_mib: Mib.default(1024),
    disk_mib: Mib.default(256),
  }),
  /**
   * Metrics derived from the executor's own wall clock: value = cell[work] / seconds.
   * Nothing the candidate prints is a score.
   */
  metrics: z.record(
    z.string().min(1),
    z.strictObject({ unit: z.string().min(1), work: z.string().min(1) }),
  ),
  /**
   * The correctness and dispatch check for one run's outputs, run by the judge (not the run
   * user). It prints one JSON object: {"pass": boolean, "reasons": [...], ...details}.
   */
  check: z.strictObject({
    command: Argv,
    timeout_s: z.number().int().positive().default(120),
  }),
  /**
   * Named verifiers for goal-mode contracts (`verify: {type: "code", verifier: name}`): a goal
   * is met when every listed cell's run passes the check.
   */
  verifiers: z
    .record(z.string().min(1), z.strictObject({ cells: z.array(z.string().min(1)).min(1) }))
    .default({}),
});

export const KitSchema = KitFields.superRefine((kit, ctx) => {
  // A run reaches only the kit paths it copies.
  for (const arg of kit.run.command) {
    for (const m of arg.matchAll(/\{kit(?::([^}]+))?\}/g)) {
      const sub = m[1] === undefined ? undefined : posix.normalize(m[1]);
      const covered =
        sub === undefined
          ? kit.run.copy.length > 0
          : kit.run.copy.some((c) => sub === c || sub.startsWith(`${c}/`));
      if (!covered) {
        ctx.addIssue({
          code: "custom",
          path: ["run", "command"],
          message: `${m[0]} is not in run.copy (a run cannot read the kit)`,
        });
      }
    }
  }
});
export type Kit = z.infer<typeof KitSchema>;

export function loadKit(dir: string): Kit {
  return KitSchema.parse(JSON.parse(readFileSync(join(dir, "kit.json"), "utf8")));
}

export function expandArgv(argv: readonly string[], vars: Record<string, string>): string[] {
  return argv.map((a) =>
    a.replace(/\{([a-z_]+)(?::([^}]+))?\}/g, (whole, name: string, rest?: string) => {
      const v = vars[name];
      if (v === undefined) throw new Error(`unknown placeholder ${whole}`);
      return rest ? join(v, rest) : v;
    }),
  );
}

/** Cell parameters as key=value lines (easy to read from any language). */
export function paramsText(params: Record<string, number | string | boolean>): string {
  return `${Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}
