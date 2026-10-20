import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { CommitSchema, IdSchema, Sha256Schema } from "./contract.ts";

/**
 * Control commands. Control signs every command with its Ed25519 key; the harness verifies
 * with control's public key, mounted read-only at deploy time. The supervisor relays signed
 * commands but cannot create or alter them.
 */

const InboxPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "relative inbox path");

/**
 * Where the supervisor fetches an import before relaying the command: a git repository
 * (https, ssh, git or file URLs) that has the commit, or a file URL for a model. The harness
 * never reads it: it checks the commit or the sha256 of what arrives, as for a file an
 * operator put in the inbox.
 */
const GitSource = z.union([
  z.object({
    git: z
      .string()
      .max(2000)
      .regex(/^(?:https:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[\w.-]+@[\w.-]+:)/, "a git URL"),
    /** Git access control keeps for a private repository, by name; the rig asks control for it. */
    access: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
      .optional(),
  }),
  /** A kit control wrote and keeps itself; the supervisor fetches it from control. */
  z.object({ control: z.string().regex(/^kits\/[a-z0-9][a-z0-9._-]{0,63}$/, "kits/<name>") }),
]);
const FileSource = z.object({
  url: z
    .string()
    .max(4000)
    .regex(/^https?:\/\//, "an http(s) URL"),
});

export const ImportSpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo_bundle"),
    path: InboxPath,
    repo: IdSchema,
    commit: CommitSchema,
    /** When given, the bundle file's sha256 must match as well as the commit. */
    sha256: Sha256Schema.optional(),
    source: GitSource.optional(),
  }),
  z.object({
    kind: z.literal("model"),
    path: InboxPath,
    name: z.string().min(1),
    sha256: Sha256Schema,
    source: FileSource.optional(),
  }),
  z.object({
    kind: z.literal("kit_bundle"),
    path: InboxPath,
    repo: IdSchema,
    commit: CommitSchema,
    sha256: Sha256Schema.optional(),
    source: GitSource.optional(),
  }),
  /**
   * Another rig's champion as a binary patch against a base commit both rigs have (the
   * campaign seed). The harness applies it to the base and accepts it only if the file's sha256
   * and the resulting git tree match: the supervisor transports bytes, it cannot change them.
   */
  z.object({
    kind: z.literal("champion_patch"),
    path: InboxPath,
    repo: IdSchema,
    base_commit: CommitSchema,
    tree: CommitSchema,
    sha256: Sha256Schema,
  }),
]);
export type ImportSpec = z.infer<typeof ImportSpec>;

/**
 * Low-power steering. Strict: a directive cannot carry anything but these fields, so it cannot
 * set a verdict, a contract or text for workers. AVOID, TRY and MANDATE name a direction-registry
 * family; PRIORITY ranks one; LANE_COUNT sets the lanes (up to the contract's count); NOTE is
 * free text for the planner only. The planner sees rationales and notes; workers never do.
 */
export const StructuredDirective = z.strictObject({
  kind: z.enum(["avoid", "try", "mandate", "priority", "lane_count", "note"]),
  /** Direction-registry family id the directive refers to (when applicable). */
  family: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,40}$/)
    .optional(),
  value: z.union([z.string().max(1000), z.number()]).optional(),
  /** Why, with citations; shown to the planner, never to workers. */
  rationale: z.string().min(1).max(2000),
  citations: z.array(z.string().min(1).max(500)).max(20).default([]),
});
export type StructuredDirective = z.infer<typeof StructuredDirective>;

/**
 * One experiment for a run's queue copied from another run (goal 064): what to try, who added it
 * and why, and where it came from. Text only: it never sets a verdict or the contract.
 */
export const QueueSeed = z.strictObject({
  title: z.string().min(1).max(200),
  details: z.string().max(4000).optional(),
  family: z.string().min(1).max(80).optional(),
  why: z.string().max(2000).optional(),
  by: z.string().min(1).max(80),
  state: z.enum(["queued", "proposed"]),
  from: z.object({ run: IdSchema, id: z.string().min(1).max(64) }),
});
export type QueueSeed = z.infer<typeof QueueSeed>;

/**
 * Who an owner's message (message_agent) may go to: everyone working, the planner, the advisors
 * (all of them, the teacher pair, the auditor or the review panel), a lane or a worker's trial.
 */
export const MESSAGE_TARGET =
  /^(all|planner|advisors|teachers|auditor|panel|lane-([1-9]|1[0-6])|trial:t-[0-9a-f]{8,32})$/;

export const CommandPayloads = {
  assign_campaign: z.object({
    run: IdSchema,
    /** The full contract; the harness validates it and checks contract_sha. */
    contract: z.unknown(),
    contract_sha: Sha256Schema,
    /** The starting commit; research campaigns have none. */
    seed: z.object({ repo: IdSchema, commit: CommitSchema }).optional(),
    direction: z.string().min(1).optional(),
    imports: z.array(ImportSpec).default([]),
    /** False: a judge-only run. No worker agents run; the judge still works. */
    agents: z.boolean().optional(),
    /**
     * The run's promotion policy: "auto" (confirmed wins promote, audits still hold surprising
     * ones) or "owner_approval" (every promotion waits for the owner). Unset: the rig's default.
     */
    promotion: z.enum(["auto", "owner_approval"]).optional(),
    /** Experiments another run had not tried, to start this run's queue with, in order. */
    queue: z.array(QueueSeed).max(500).optional(),
  }),
  /**
   * A check of the rig itself, run by its harness: the model route (one tool-calling request),
   * the isolation selftest, or a judge-only smoke campaign on the rig's own target. The result
   * comes back as a rig_check_finished event.
   */
  rig_check: z.object({
    check: z.enum(["model", "isolation", "smoke"]),
    /** Isolation and smoke want an idle rig; force runs them anyway (trials may be killed). */
    force: z.boolean().optional(),
  }),
  pause_run: z.object({ run: IdSchema, reason: z.string().min(1) }),
  resume_run: z.object({ run: IdSchema }),
  /** A directive set; by default it replaces this author's previous set. */
  redirect: z.object({
    run: IdSchema,
    directives: z.array(StructuredDirective).min(1).max(40),
    replace: z.boolean().default(true),
  }),
  reset_workers: z.object({ run: IdSchema, reseed_commit: CommitSchema.optional() }),
  /**
   * The owner's message to the run's agents (owner only). `to`: everyone working (`all`: every
   * lane, and the planner of a hill-climb or goal run), a lane, a running worker's trial, the
   * planner, or the advisors (`advisors`: all of them; `teachers`, `auditor` or `panel`). The
   * judge is code and takes no messages. `keep`, for `all` or a lane only, keeps the message in
   * force: it goes into every new trial's brief until an unkeep_message removes it.
   */
  message_agent: z
    .object({
      run: IdSchema,
      to: z.string().regex(MESSAGE_TARGET),
      text: z.string().min(1).max(4000),
      keep: z.boolean().optional(),
    })
    .refine((p) => !p.keep || p.to === "all" || p.to.startsWith("lane-"), {
      message: "only a message to everyone working (all) or to a lane can be kept in force",
      path: ["keep"],
    }),
  /** The owner ends a message kept in force (owner only): new briefs no longer carry it. */
  unkeep_message: z.object({ run: IdSchema, message: z.number().int().positive() }),
  /**
   * Another rig's champion as a candidate here: this rig's judge screens and confirms it
   * against its own champion. The supervisor stages the file from the results repository.
   */
  propagate: z.object({
    run: IdSchema,
    source_rig: z.string().min(1),
    source_run: IdSchema,
    source_seq: z.number().int().positive(),
    import: ImportSpec,
  }),
  /** A full export (a full reset's) also carries the research archive and the ledger snapshot. */
  export_now: z.object({ full: z.boolean().default(false) }),
  /**
   * Owner-only full reset, after control verified that `export` (an export_now's result) was
   * pushed to the results repository. The harness refuses if research was recorded after it.
   */
  wipe_state: z.object({
    confirm: z.literal("wipe"),
    export: z.string().min(1).max(100),
    through_event: z.number().int().min(0),
  }),
  /**
   * The owner approves a confirmed win waiting for promotion (the rig's promotion policy), or overrides
   * an audit that is pending or blocked. The judge's verdict must still be promotable.
   */
  approve_promotion: z.object({ run: IdSchema, attempt: z.string().min(1).max(64) }),
  /** The rig's own settings from its Edit page (owner only): only the fields that change. */
  rig_settings: z.strictObject({
    judge: z.boolean().optional(),
    workers: z.boolean().optional(),
    lanes: z.number().int().min(1).max(16).optional(),
    planner: z.boolean().optional(),
    auditor: z.boolean().optional(),
    teachers: z.boolean().optional(),
    review: z.boolean().optional(),
    exports: z.boolean().optional(),
    trial_minutes: z.number().int().min(1).max(10_080).optional(),
    max_turns: z.number().int().min(1).max(100_000).nullable().optional(),
    promotion: z.enum(["auto", "owner_approval"]).optional(),
    /** How many of the rig's GPUs are the judge's (a rig configured with its GPU set). */
    judge_gpus: z.number().int().min(1).max(8).nullable().optional(),
  }),
  /**
   * The owner says no to a confirmed win that waits for approval, or to an attempt held for (or
   * blocked by) an audit: it never becomes the champion, and stays in the record as declined.
   */
  decline_promotion: z.object({
    run: IdSchema,
    attempt: z.string().min(1).max(64),
    note: z.string().max(2000).optional(),
  }),
  /** The owner's final acceptance (or rejection) of a goal the review panel passed. */
  accept_review: z.object({
    run: IdSchema,
    review: z.number().int().positive(),
    accept: z.boolean(),
    note: z.string().max(2000).optional(),
  }),
  /** The owner accepts or rejects the harness's "not possible" conclusion for a goal campaign. */
  conclude: z.object({
    run: IdSchema,
    proposal: z.number().int().positive(),
    accept: z.boolean(),
    note: z.string().max(2000).optional(),
  }),
} as const;

export type CommandKind = keyof typeof CommandPayloads;
export const COMMAND_KINDS = Object.keys(CommandPayloads) as CommandKind[];

export const Envelope = z.object({
  v: z.literal(1),
  id: z.uuid(),
  rig: z.string().min(1),
  kind: z.enum(COMMAND_KINDS as [CommandKind, ...CommandKind[]]),
  issued_by: z.string().min(1),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof Envelope>;

export const SignedCommand = z.object({
  envelope: Envelope,
  /** Base64 Ed25519 signature over the canonical JSON of the envelope. */
  signature: z.string().min(1),
});
export type SignedCommand = z.infer<typeof SignedCommand>;

export interface KeyPairPem {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateSigningKeys(): KeyPairPem {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function signEnvelope(envelope: Envelope, privateKeyPem: string): SignedCommand {
  const key = createPrivateKey(privateKeyPem);
  const signature = edSign(null, Buffer.from(canonicalJson(envelope)), key).toString("base64");
  return { envelope, signature };
}

export type VerifyResult =
  | { ok: true; envelope: Envelope; payload: unknown }
  /**
   * `authenticId` is set when the signature and rig binding are valid and only a later check
   * failed (for example expiry), so a replay of an already-applied command can be recognised.
   */
  | { ok: false; reason: string; authenticId?: string };

/** Maximum allowed clock skew between control and the rig. */
const SKEW_MS = 5 * 60_000;

/**
 * Verifies a signed command for this rig: shape, signature, rig binding, validity window
 * and the per-kind payload schema. Replay protection (command ids already seen) is the
 * ledger's job.
 */
export function verifyCommand(
  input: unknown,
  publicKeyPem: string,
  rig: string,
  now: Date = new Date(),
): VerifyResult {
  // A command signed before the 2026-10-15 rename names its "unit" and "instance": its
  // signature is checked over the envelope as it was signed, then it is read under the new names.
  const legacy = legacyEnvelope(input);
  const parsed = SignedCommand.safeParse(legacy ? legacy.normalized : input);
  if (!parsed.success) return { ok: false, reason: "malformed command" };
  const { envelope, signature } = parsed.data;
  const signedForm = legacy ? legacy.signed : envelope;
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "control public key unusable" };
  }
  let valid = false;
  try {
    valid = edVerify(
      null,
      Buffer.from(canonicalJson(signedForm)),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };
  if (envelope.rig !== rig) return { ok: false, reason: `command is for rig ${envelope.rig}` };
  const issued = Date.parse(envelope.issued_at);
  const expires = Date.parse(envelope.expires_at);
  const authenticId = envelope.id;
  if (issued - SKEW_MS > now.getTime()) {
    return { ok: false, reason: "issued in the future", authenticId };
  }
  if (expires < now.getTime()) return { ok: false, reason: "expired", authenticId };
  const payload = CommandPayloads[envelope.kind].safeParse(envelope.payload);
  if (!payload.success) {
    return {
      ok: false,
      reason: `bad payload: ${payload.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      authenticId,
    };
  }
  return { ok: true, envelope, payload: payload.data };
}

const LEGACY_KINDS: Record<string, string> = {
  pause_instance: "pause_run",
  resume_instance: "resume_run",
};
const LEGACY_KEYS: Record<string, string> = {
  instance: "run",
  source_instance: "source_run",
  source_unit: "source_rig",
};

/** An envelope from before the rename: as signed, and read under the new names. */
function legacyEnvelope(input: unknown): { signed: unknown; normalized: unknown } | undefined {
  const cmd = input as { envelope?: Record<string, unknown>; signature?: unknown } | undefined;
  const env = cmd?.envelope;
  if (!env || typeof env !== "object" || "rig" in env || !("unit" in env)) return undefined;
  const { unit, kind, payload, ...rest } = env;
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.fromEntries(
          Object.entries(payload as Record<string, unknown>).map(([k, v]) => [
            LEGACY_KEYS[k] ?? k,
            v,
          ]),
        )
      : payload;
  const k = typeof kind === "string" ? (LEGACY_KINDS[kind] ?? kind) : kind;
  return {
    signed: env,
    normalized: { ...cmd, envelope: { ...rest, rig: unit, kind: k, payload: p } },
  };
}

/** Signs any JSON value (canonical form) with an Ed25519 key. Returns base64. */
export function signJson(value: unknown, privateKeyPem: string): string {
  return edSign(null, Buffer.from(canonicalJson(value)), createPrivateKey(privateKeyPem)).toString(
    "base64",
  );
}

/** Verifies a base64 Ed25519 signature over the canonical JSON of a value. */
export function verifyJson(value: unknown, signature: string, publicKeyPem: string): boolean {
  try {
    return edVerify(
      null,
      Buffer.from(canonicalJson(value)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** The part of a harness snapshot its signature covers. */
export function reportBody(r: {
  rig: string;
  ledger_id: string;
  cursor: number;
  next: number;
  events: unknown[];
  summary: unknown;
  /** When the harness made the report, and its newest event: control refuses stale reports. */
  generated_at: string;
  latest_event: number;
}): unknown {
  return {
    rig: r.rig,
    ledger_id: r.ledger_id,
    cursor: r.cursor,
    next: r.next,
    events: r.events,
    summary: r.summary,
    generated_at: r.generated_at,
    latest_event: r.latest_event,
  };
}
