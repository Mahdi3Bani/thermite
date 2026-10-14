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

export const ImportSpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo_bundle"),
    path: InboxPath,
    repo: IdSchema,
    commit: CommitSchema,
    /** When given, the bundle file's sha256 must match as well as the commit. */
    sha256: Sha256Schema.optional(),
  }),
  z.object({
    kind: z.literal("model"),
    path: InboxPath,
    name: z.string().min(1),
    sha256: Sha256Schema,
  }),
  z.object({
    kind: z.literal("kit_bundle"),
    path: InboxPath,
    repo: IdSchema,
    commit: CommitSchema,
    sha256: Sha256Schema.optional(),
  }),
  /**
   * Another unit's champion as a binary patch against a base commit both units have (the
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

export const CommandPayloads = {
  assign_campaign: z.object({
    instance: IdSchema,
    /** The full contract; the harness validates it and checks contract_sha. */
    contract: z.unknown(),
    contract_sha: Sha256Schema,
    /** The starting commit; research campaigns have none. */
    seed: z.object({ repo: IdSchema, commit: CommitSchema }).optional(),
    direction: z.string().min(1).optional(),
    imports: z.array(ImportSpec).default([]),
  }),
  pause_instance: z.object({ instance: IdSchema, reason: z.string().min(1) }),
  resume_instance: z.object({ instance: IdSchema }),
  /** A directive set; by default it replaces this author's previous set. */
  redirect: z.object({
    instance: IdSchema,
    directives: z.array(StructuredDirective).min(1).max(40),
    replace: z.boolean().default(true),
  }),
  reset_workers: z.object({ instance: IdSchema, reseed_commit: CommitSchema.optional() }),
  /**
   * Another unit's champion as a candidate here: this unit's judge screens and confirms it
   * against its own champion. The supervisor stages the file from the results repository.
   */
  propagate: z.object({
    instance: IdSchema,
    source_unit: z.string().min(1),
    source_instance: IdSchema,
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
   * The owner approves a confirmed win waiting for promotion (promotion policy D8), or overrides
   * an audit that is pending or blocked. The judge's verdict must still be promotable.
   */
  approve_promotion: z.object({ instance: IdSchema, attempt: z.string().min(1).max(64) }),
  /** The owner's final acceptance (or rejection) of a goal the review panel passed. */
  accept_review: z.object({
    instance: IdSchema,
    review: z.number().int().positive(),
    accept: z.boolean(),
    note: z.string().max(2000).optional(),
  }),
  /** The owner accepts or rejects the harness's "not possible" conclusion for a goal campaign. */
  conclude: z.object({
    instance: IdSchema,
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
  unit: z.string().min(1),
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
   * `authenticId` is set when the signature and unit binding are valid and only a later check
   * failed (for example expiry), so a replay of an already-applied command can be recognised.
   */
  | { ok: false; reason: string; authenticId?: string };

/** Maximum allowed clock skew between control and the unit. */
const SKEW_MS = 5 * 60_000;

/**
 * Verifies a signed command for this unit: shape, signature, unit binding, validity window
 * and the per-kind payload schema. Replay protection (command ids already seen) is the
 * ledger's job.
 */
export function verifyCommand(
  input: unknown,
  publicKeyPem: string,
  unit: string,
  now: Date = new Date(),
): VerifyResult {
  const parsed = SignedCommand.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "malformed command" };
  const { envelope, signature } = parsed.data;
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
      Buffer.from(canonicalJson(envelope)),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };
  if (envelope.unit !== unit) return { ok: false, reason: `command is for unit ${envelope.unit}` };
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
  unit: string;
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
    unit: r.unit,
    ledger_id: r.ledger_id,
    cursor: r.cursor,
    next: r.next,
    events: r.events,
    summary: r.summary,
    generated_at: r.generated_at,
    latest_event: r.latest_event,
  };
}
