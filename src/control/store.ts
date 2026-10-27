import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Refusal } from "../common/errors.ts";
import {
  EFFORTS,
  type Effort,
  HARNESSES,
  type Harness,
  type ProviderType,
} from "../core/agents.ts";
import { canonicalJson, sha256Hex } from "../core/canonical.ts";
import type { SignedCommand } from "../core/commands.ts";
import { MAX_LANES } from "../core/contract.ts";
import { RIG_ID } from "../core/ids.ts";
import type { LiveEntry } from "../core/live.ts";
import { currentEvent } from "../core/names.ts";
import { PodConfig } from "../core/tunnel.ts";
import {
  MODEL_CALL_EVENT,
  ModelCallBody,
  type ModelPrice,
  type PodSpendRow,
  type UsageRow,
  type UsageScope,
} from "../core/usage.ts";
import type { ReportedBuild } from "../core/version.ts";
import { Credential } from "./credential.ts";
import type { JoinedSpec, JoinForm } from "./join.ts";
import { KnowledgeBase } from "./kb.ts";
import { fingerprint } from "./store/keys.ts";
import type { IngestReport } from "./store/report.ts";
import { migrateStore } from "./store/schema.ts";

/**
 * Control's store: rigs, the events they report, and command queues. A single control process
 * owns it. Ingest is idempotent: re-sent events (same rig and event id) are ignored.
 */
type Row = Record<string, SQLInputValue>;

/** A model_call row as the usage sums read it (goal 075). */
function usageRowOf(r: Row): UsageRow {
  const num = (x: SQLInputValue | undefined) => (x === null || x === undefined ? null : Number(x));
  return {
    rig: String(r.rig),
    run: String(r.run),
    campaign: r.campaign === null ? null : String(r.campaign),
    trial: r.trial === null || r.trial === undefined ? null : String(r.trial),
    agent: String(r.agent),
    harness: String(r.harness),
    provider: r.provider === null ? null : String(r.provider),
    model: String(r.model),
    calls: num(r.calls),
    at: String(r.at),
    tokens_in: Number(r.tokens_in),
    cached_in: num(r.cached_in),
    tokens_out: Number(r.tokens_out),
    reasoning: num(r.reasoning),
    first_token_ms: num(r.first_token_ms),
    call_ms: num(r.call_ms),
  };
}

/** An export a rig sent to control (its files are on disk: exports.ts). */
export interface RigExport {
  rig: string;
  name: string;
  manifest: Record<string, unknown>;
  /** The files the rig sends: each one's size and SHA-256. */
  files: Record<string, { size: number; sha256: string }>;
  /** The files that arrived with their SHA-256. */
  done: string[];
  bytes: number;
  full: boolean;
  from_event: number;
  through_event: number;
  created_at: string;
  complete_at: string | null;
}

function rigExportOf(r: Row): RigExport {
  return {
    rig: String(r.rig),
    name: String(r.name),
    manifest: JSON.parse(String(r.manifest)) as Record<string, unknown>,
    files: JSON.parse(String(r.files)) as RigExport["files"],
    done: JSON.parse(String(r.done)) as string[],
    bytes: Number(r.bytes),
    full: Number(r.full) === 1,
    from_event: Number(r.from_event),
    through_event: Number(r.through_event),
    created_at: String(r.created_at),
    complete_at: r.complete_at === null ? null : String(r.complete_at),
  };
}

export type { IngestReport };
export { EFFORTS, type Effort, HARNESSES, type Harness, type ProviderType };
/** A harness from a form or a row; anything else is Pi, the default. */
export const harnessOf = (v: unknown): Harness => HARNESSES.find((h) => h === v) ?? "pi";
/** Whether the Codex CLI can reach a provider of this type (OpenAI's Responses API only). */
export const codexTakes = (type: ProviderType): boolean => type === "chatgpt" || type === "openai";
/**
 * A rig's agents other than its workers, each of which may have its own model (goal 074): the
 * planner; the teachers' first model (`teachers`), their second (`second_teacher`: a second
 * teacher) and the model that merges two teachers' advice (`merged_by`); the auditor; the review
 * panel.
 */
export type AgentRole =
  | "planner"
  | "teachers"
  | "second_teacher"
  | "merged_by"
  | "auditor"
  | "review_panel";
export const AGENT_ROLES: AgentRole[] = [
  "planner",
  "teachers",
  "second_teacher",
  "merged_by",
  "auditor",
  "review_panel",
];

/** A model in a provider's list: its id, and its context window when the provider says it. */
export interface ProviderModel {
  id: string;
  context_window?: number | undefined;
  /** Added by the owner by its name (the provider does not list it). */
  added?: boolean | undefined;
  /** Its price as the provider's list gives it, per million tokens (goal 075); none: not listed. */
  price?: ModelPrice | undefined;
  /**
   * The most tokens one reply may take, as the provider's list gives it (goal 079): the rig's route
   * carries it as its reply limit. None: none is sent, and the provider's own applies.
   */
  max_output?: number | undefined;
}

/** A model provider as stored: its key only sealed, and a hint of it for the dashboard. */
export interface ModelProvider {
  name: string;
  type: ProviderType;
  base_url: string;
  key_sealed: string;
  key_hint: string;
  version: number;
  updated_at: string;
  models: ProviderModel[];
  models_at: string | null;
  models_error: string | null;
}

function providerOf(r: Row): ModelProvider {
  let models: ProviderModel[] = [];
  try {
    models = JSON.parse(String(r.models ?? "[]")) as ProviderModel[];
  } catch {
    models = [];
  }
  return {
    name: String(r.name),
    type:
      r.type === "anthropic" || r.type === "opencode" || r.type === "claude" || r.type === "chatgpt"
        ? r.type
        : "openai",
    base_url: String(r.base_url),
    key_sealed: String(r.key_sealed),
    key_hint: String(r.key_hint),
    version: Number(r.version),
    updated_at: String(r.updated_at),
    models,
    models_at: r.models_at === null || r.models_at === undefined ? null : String(r.models_at),
    models_error:
      r.models_error === null || r.models_error === undefined ? null : String(r.models_error),
  };
}

/** Where a campaign version's runs fetch from: no secrets, only addresses and access names. */
export interface CampaignSources {
  project?: { url: string; access?: string | undefined; repo: string; commit: string } | undefined;
  kit?: { control: string } | { git: string; access?: string | undefined } | undefined;
  /**
   * The MCP servers the campaign's kit names (goal 068), with the agents that get each one: as
   * control wrote or read them into a kit it keeps, or as the page read them from a kit in a
   * repository (the rig's harness checks them against the kit's kit.json).
   */
  mcp_servers?: unknown;
  /**
   * A copy of a campaign control knew only by an assignment (goal 069): that assignment's
   * starting point, imports and MCP servers, without its run, contract and run options. The
   * copy's runs take them as they are, as Start a run assigns such a campaign again.
   */
  assignment?: Record<string, unknown> | undefined;
}

/**
 * Where a copied campaign came from (goal 069): the campaign, and the version copied, or the
 * assignment copied (its rig and run) for a campaign control knew only by an assignment.
 */
export interface CopiedFrom {
  campaign: string;
  version?: number | undefined;
  rig?: string | undefined;
  run?: string | undefined;
  /** True when the copy's contract names other MCP servers than its source's (a research copy). */
  other_mcp_servers?: true | undefined;
}

/** A decision the owner sent to a rig, and the rig's answer once it came. */
export interface Decision {
  id: string;
  rig: string;
  kind: string;
  run: string;
  attempt?: string | undefined;
  review?: number | undefined;
  proposal?: number | undefined;
  accept?: boolean | undefined;
  issued_at: string;
  /** pending, delivered, rejected, failed or expired. */
  status: string;
  acked_at: string | null;
  outcome: { accepted?: boolean; result?: Record<string, unknown> | null } | null;
}

/** One entry of control's audit log. Its id is the cursor that pages through the log. */
export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  body: unknown;
}

/** Which audit entries a list keeps: `action` those whose action contains it; `mcp` false, no MCP calls. */
export interface AuditFilter {
  action?: string | undefined;
  mcp?: boolean | undefined;
}

/** A machine as listed (never its key). Host keys are known_hosts lines. */
export interface Machine {
  name: string;
  address: string;
  port: number;
  user: string;
  public_key: string;
  key_fingerprint: string;
  /** The host keys the owner trusted; empty until then. */
  host_keys: string[];
  /** The host keys the machine presented when last asked, for the owner to compare. */
  seen_host_keys: string[];
  facts: unknown;
  checked_at: string | null;
  check_error: string | null;
  created_at: string;
}

const machineOf = (r: Row): Machine => ({
  name: String(r.name),
  address: String(r.address),
  port: Number(r.port),
  user: String(r.user),
  public_key: String(r.public_key),
  key_fingerprint: String(r.key_fingerprint),
  host_keys: JSON.parse(String(r.host_keys)) as string[],
  seen_host_keys: JSON.parse(String(r.seen_host_keys)) as string[],
  facts: r.facts ? JSON.parse(String(r.facts)) : null,
  checked_at: r.checked_at === null ? null : String(r.checked_at),
  check_error: r.check_error === null ? null : String(r.check_error),
  created_at: String(r.created_at),
});

/** A cluster as listed (never its kubeconfig). */
export interface Cluster {
  name: string;
  context: string;
  placement: "created" | "slot";
  namespace_pattern: string;
  slots: string[];
  facts: unknown;
  checked_at: string | null;
  check_error: string | null;
  created_at: string;
}

/** A rig the owner joins themself; never the join command itself, only whether one waits. */
export interface JoinedRig {
  rig: string;
  form: JoinForm;
  spec: JoinedSpec;
  join_expires_at: string | null;
  join_used_at: string | null;
  status: string;
  created_at: string;
  created_by: string;
}

const joinedRigOf = (r: Row): JoinedRig => ({
  rig: String(r.rig),
  form: String(r.form) as JoinForm,
  spec: JSON.parse(String(r.spec)) as JoinedSpec,
  join_expires_at: r.join_expires_at === null ? null : String(r.join_expires_at),
  join_used_at: r.join_used_at === null ? null : String(r.join_used_at),
  status: String(r.status),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
});

/** A GPU cloud as listed (never its key). */
export interface GpuCloud {
  name: string;
  kind: "runpod";
  key_hint: string;
  facts: unknown;
  checked_at: string | null;
  check_error: string | null;
  created_at: string;
}

const gpuCloudOf = (r: Row): GpuCloud => ({
  name: String(r.name),
  kind: String(r.kind) as GpuCloud["kind"],
  key_hint: String(r.key_hint),
  facts: r.facts ? JSON.parse(String(r.facts)) : null,
  checked_at: r.checked_at === null ? null : String(r.checked_at),
  check_error: r.check_error === null ? null : String(r.check_error),
  created_at: String(r.created_at),
});

/** A rig in pull mode, as listed: never its sealed secrets. */
export interface TunnelRig {
  rig: string;
  /** The pod and control's address for it, once launched. */
  pod: string | null;
  url: string | null;
  /** The port the pod serves for control. */
  port: number;
  box_public: string;
  /** When the enrollment code expires; null: it does not. */
  code_expires_at: string | null;
  /** The rig's settings, given to the pod at enrollment. */
  config: PodConfig;
  pod_sign_public: string | null;
  pod_box_public: string | null;
  enrolled_at: string | null;
  last_exchange_at: string | null;
  refused_total: number;
  error: string | null;
  created_at: string;
  created_by: string;
}
export interface TunnelSecrets {
  prefix_sealed: string;
  box_private_sealed: string;
  code_sealed: string;
}

const tunnelRigOf = (r: Row): TunnelRig & TunnelSecrets => {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    rig: String(r.rig),
    pod: opt(r.pod),
    url: opt(r.url),
    port: Number(r.port),
    prefix_sealed: String(r.prefix_sealed),
    box_private_sealed: String(r.box_private_sealed),
    box_public: String(r.box_public),
    code_sealed: String(r.code_sealed),
    code_expires_at: opt(r.code_expires_at),
    config: PodConfig.parse(JSON.parse(String(r.config))),
    pod_sign_public: opt(r.pod_sign_public),
    pod_box_public: opt(r.pod_box_public),
    enrolled_at: opt(r.enrolled_at),
    last_exchange_at: opt(r.last_exchange_at),
    refused_total: Number(r.refused_total ?? 0),
    error: opt(r.error),
    created_at: String(r.created_at),
    created_by: String(r.created_by),
  };
};

/** A rig launched on a GPU cloud, as kept: its state is runpod-rigs.ts's RigState. */
export interface StoredRunpodRig {
  rig: string;
  cloud: string;
  pod: string;
  /** Control still follows its pod (false once RunPod no longer has it). */
  active: boolean;
  state: unknown;
  created_at: string;
  created_by: string;
}

const runpodRigOf = (r: Row): StoredRunpodRig => ({
  rig: String(r.rig),
  cloud: String(r.cloud),
  pod: String(r.pod),
  active: Number(r.active) === 1,
  state: JSON.parse(String(r.state)),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
});

/** A test pod as kept: its state is runpod-tests.ts's TestState. */
export interface StoredRunpodTest {
  id: string;
  cloud: string;
  active: boolean;
  state: unknown;
  created_at: string;
  created_by: string;
}

const runpodTestOf = (r: Row): StoredRunpodTest => ({
  id: String(r.id),
  cloud: String(r.cloud),
  active: Number(r.active) === 1,
  state: JSON.parse(String(r.state)),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
});

/** A rig control set up on a cluster; spec holds what it was deployed with (no secrets). */
export interface ClusterRig {
  rig: string;
  cluster: string;
  namespace: string;
  placement: "created" | "slot";
  spec: {
    gpus: number;
    /** With two or more GPUs, how many are the judge's. */
    judgeGpus?: number | undefined;
    gpuMode: "device-plugin" | "dra";
    deviceClass?: string | undefined;
    node?: string | undefined;
    storageClass?: string | undefined;
    storageGi: number;
    /** The rig's CPUs and memory; none: the namespace's defaults. */
    resources?: { cpus: number; memoryGi: number } | undefined;
    images: { harness: string; supervisor: string };
    /** Control's address the rig's supervisor reports to, as last deployed (older rigs: unknown). */
    controlUrl?: string | undefined;
  };
  status: string;
  created_at: string;
  created_by: string;
  /** A change to its GPUs, CPUs or memory that waits while the rig drains; only while draining. */
  pending?: ClusterRigResize | undefined;
}

/** A cluster rig's GPUs, the judge's share of them and its CPUs and memory, as control deploys them. */
export interface ClusterRigSize {
  gpus: number;
  /** With two or more GPUs, how many are the judge's. */
  judgeGpus?: number | undefined;
  /** None: the namespace's defaults. */
  resources?: { cpus: number; memoryGi: number } | undefined;
}

/** A new size that waits for the rig's drain, and who asked for it. */
export interface ClusterRigResize extends ClusterRigSize {
  by: string;
}

const clusterOf = (r: Row): Cluster => ({
  name: String(r.name),
  context: String(r.context),
  placement: String(r.placement) as Cluster["placement"],
  namespace_pattern: String(r.namespace_pattern),
  slots: JSON.parse(String(r.slots)) as string[],
  facts: r.facts ? JSON.parse(String(r.facts)) : null,
  checked_at: r.checked_at === null ? null : String(r.checked_at),
  check_error: r.check_error === null ? null : String(r.check_error),
  created_at: String(r.created_at),
});

const clusterRigOf = (r: Row): ClusterRig => ({
  rig: String(r.rig),
  cluster: String(r.cluster),
  namespace: String(r.namespace),
  placement: String(r.placement) as ClusterRig["placement"],
  spec: JSON.parse(String(r.spec)) as ClusterRig["spec"],
  status: String(r.status),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
  ...(r.pending ? { pending: JSON.parse(String(r.pending)) as ClusterRigResize } : {}),
});

/** A rig control set up on a machine. */
export interface MachineRig {
  rig: string;
  machine: string;
  gpus: number[];
  /** With two or more GPUs: how many (the lowest-numbered) are the judge's; the rest are the agents'. */
  judge_gpus?: number | undefined;
  images: { harness: string; supervisor: string };
  root: boolean;
  /** deploying, running, stopped, failed, removed. */
  status: string;
  created_at: string;
  created_by: string;
}

const machineRigOf = (r: Row): MachineRig => ({
  rig: String(r.rig),
  machine: String(r.machine),
  gpus: JSON.parse(String(r.gpus)) as number[],
  judge_gpus:
    r.judge_gpus === null || r.judge_gpus === undefined ? undefined : Number(r.judge_gpus),
  images: JSON.parse(String(r.images)) as MachineRig["images"],
  root: Number(r.root) === 1,
  status: String(r.status),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
});

/** Git access as listed (never its secret). */
export interface GitAccess {
  name: string;
  kind: "ssh" | "token";
  public_key: string | null;
  fingerprint: string | null;
  hint: string;
  username: string | null;
}

function gitAccessOf(r: Row): GitAccess {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    name: String(r.name),
    kind: r.kind === "token" ? "token" : "ssh",
    public_key: opt(r.public_key),
    fingerprint: opt(r.fingerprint),
    hint: String(r.hint),
    username: opt(r.username),
  };
}

/** A rig enrolled through control. */
export interface EnrolledRig {
  rig: string;
  created_at: string;
  created_by: string;
  rotated_at: string | null;
  retired_at: string | null;
}

function enrolledOf(r: Row): EnrolledRig {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    rig: String(r.rig),
    created_at: String(r.created_at),
    created_by: String(r.created_by),
    rotated_at: opt(r.rotated_at),
    retired_at: opt(r.retired_at),
  };
}

/** The two parts of a rig that report a build. */
export type RigComponent = "harness" | "supervisor";

/** A build a part of a rig reported, and since when control has seen it. */
export interface StoredBuild extends ReportedBuild {
  since: string;
}

/** Why control refuses a rig, since when, and how many of its calls it refused since. */
export interface RigRefusal {
  reason: string;
  since: string;
  /** The rig's calls control refused since the refusal began. */
  calls: number;
  /** When the last of them came; null: none since. */
  last_at: string | null;
}

export { RIG_ID };

/** How many of each open trial's newest live lines control keeps past the rig's window. */
export const OPEN_TRIAL_LINES = 400;

/** How many stuck trials left running control remembers (goal 143); a trial ends in hours. */
const TRIALS_LEFT_MAX = 1000;

export class ControlStore {
  readonly db: DatabaseSync;
  private configuredRigs = new Set<string>();
  private knowledge: KnowledgeBase | undefined;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal;");
    migrateStore(this.db, path);
  }

  /**
   * Thermite's own knowledge base (goal 065), brought up to date with every event reported so
   * far. Its cursor is kept in this store, so it carries on after a restart of control.
   */
  kb(): KnowledgeBase {
    this.knowledge ??= new KnowledgeBase(this.db);
    this.knowledge.catchUp();
    return this.knowledge;
  }

  /**
   * The supervisor's own figures for a rig (unsigned: it reports them about itself). They never
   * make a rig look live: only the harness's signed reports move last_seen.
   */
  setSupervisor(rig: string, stats: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, supervisor, supervisor_at) values (?, ?, ?, ?, ?)
         on conflict (id) do update set supervisor = excluded.supervisor, supervisor_at = excluded.supervisor_at`,
      )
      .run(rig, now, new Date(0).toISOString(), canonicalJson(stats ?? {}), now);
  }

  /**
   * Whether a signed report may be taken: not from a ledger the rig has left, starting no later
   * than the stream control already has (no gap), and no older than the newest report taken.
   */
  reportCheck(
    rig: string,
    r: { ledgerId: string; cursor: number; generatedAt: string },
  ): { ok: true } | { ok: false; reason: string; expectedCursor?: number } {
    const left = this.db
      .prepare(
        "select 1 from rig_ledger where rig = ? and ledger_id = ? and superseded_at is not null",
      )
      .get(rig, r.ledgerId);
    if (left) return { ok: false, reason: "a report from a ledger the rig has left" };
    const u = this.db
      .prepare("select ledger_id, last_cursor, report_at from rig where id = ?")
      .get(rig) as Row | undefined;
    if (!u || u.ledger_id === null || String(u.ledger_id) !== r.ledgerId) {
      // A new ledger starts at the beginning.
      return r.cursor === 0
        ? { ok: true }
        : { ok: false, reason: "a new ledger's events start at 0", expectedCursor: 0 };
    }
    if (r.cursor > Number(u.last_cursor)) {
      return {
        ok: false,
        reason: "a gap in the event stream",
        expectedCursor: Number(u.last_cursor),
      };
    }
    if (u.report_at && r.generatedAt < String(u.report_at)) {
      return { ok: false, reason: "a report older than the newest one taken" };
    }
    return { ok: true };
  }

  supervisor(rig: string): Record<string, unknown> | null {
    const r = this.db.prepare("select supervisor, supervisor_at from rig where id = ?").get(rig) as
      | Row
      | undefined;
    return r?.supervisor
      ? { ...(JSON.parse(String(r.supervisor)) as object), received_at: String(r.supervisor_at) }
      : null;
  }

  /**
   * Stores live-log lines (duplicates by log id and sequence are ignored) and keeps only the
   * newest `keep` lines of the rig, and each open trial's newest OPEN_TRIAL_LINES: a trial that
   * writes many lines can't push out another's (goal 143). The open trials are those the rig's
   * last report lists.
   */
  addLive(
    rig: string,
    logId: string,
    entries: LiveEntry[],
    signed: boolean,
    keep = 20_000,
  ): number {
    const now = new Date().toISOString();
    return this.tx(() => {
      const insert = this.db.prepare(
        `insert or ignore into rig_live (rig, log_id, seq, at, source, kind, text, lane, run, signed, received_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let added = 0;
      for (const e of entries) {
        added += Number(
          insert.run(
            rig,
            logId,
            e.seq,
            e.at,
            e.source,
            e.kind,
            e.text,
            e.lane ?? null,
            e.run ?? null,
            signed ? 1 : 0,
            now,
          ).changes,
        );
      }
      const cut = this.db
        .prepare("select id from rig_live where rig = ? order by id desc limit 1 offset ?")
        .get(rig, keep) as { id: number } | undefined;
      if (!cut) return added;
      // Each open trial's newest lines stay, from the oldest of them on.
      const kept = this.openTrialSources(rig).map((source) => {
        const oldest = this.db
          .prepare(
            "select id from rig_live where rig = ? and source = ? order by id desc limit 1 offset ?",
          )
          .get(rig, source, OPEN_TRIAL_LINES - 1) as { id: number } | undefined;
        return { source, from: oldest?.id ?? 0 };
      });
      this.db
        .prepare(
          `delete from rig_live where rig = ? and id <= ?${kept.map(() => " and not (source = ? and id >= ?)").join("")}`,
        )
        .run(rig, cut.id, ...kept.flatMap((k) => [k.source, k.from]));
      return added;
    });
  }

  /**
   * The owner leaves a stuck trial running (goal 143): its card stays away while it is stuck
   * since the same time. Keeps the newest TRIALS_LEFT_MAX of them.
   */
  leaveTrial(o: { rig: string; trial: string; kind: string; since: string; by: string }): void {
    this.tx(() => {
      this.db
        .prepare(
          `insert into trial_left (rig, trial, kind, since, at, by) values (?, ?, ?, ?, ?, ?)
           on conflict (rig, trial, kind) do update set since = excluded.since, at = excluded.at, by = excluded.by`,
        )
        .run(o.rig, o.trial, o.kind, o.since, new Date().toISOString(), o.by);
      this.db
        .prepare(
          "delete from trial_left where rowid not in (select rowid from trial_left order by at desc limit ?)",
        )
        .run(TRIALS_LEFT_MAX);
    });
  }

  /** Since when the trial was stuck when the owner left it running; null: never left. */
  trialLeft(rig: string, trial: string, kind: string): string | null {
    const r = this.db
      .prepare("select since from trial_left where rig = ? and trial = ? and kind = ?")
      .get(rig, trial, kind) as Row | undefined;
    return r ? String(r.since) : null;
  }

  /** The live sources of the trials the rig's last report lists as open (at most MAX_LANES). */
  private openTrialSources(rig: string): string[] {
    const r = this.db.prepare("select summary from rig where id = ?").get(rig) as Row | undefined;
    if (!r) return [];
    const open = (JSON.parse(String(r.summary)) as { work?: { open?: unknown } }).work?.open;
    if (!Array.isArray(open)) return [];
    return open
      .slice(0, MAX_LANES)
      .flatMap((t) =>
        typeof (t as { trial?: unknown }).trial === "string"
          ? [`trial:${(t as { trial: string }).trial}`]
          : [],
      );
  }

  /** Live lines of a rig after `after` (control's own ids), oldest first; one source if given. */
  live(
    rig: string,
    after: number,
    limit: number,
    source?: string,
  ): (LiveEntry & { id: number; signed: boolean })[] {
    const rows = (
      source
        ? this.db
            .prepare(
              "select * from rig_live where rig = ? and id > ? and source = ? order by id limit ?",
            )
            .all(rig, after, source, limit)
        : this.db
            .prepare("select * from rig_live where rig = ? and id > ? order by id limit ?")
            .all(rig, after, limit)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      seq: Number(r.seq),
      at: String(r.at),
      source: String(r.source),
      kind: String(r.kind) as LiveEntry["kind"],
      text: String(r.text),
      ...(r.lane ? { lane: String(r.lane) } : {}),
      ...(r.run ? { run: String(r.run) } : {}),
      signed: Number(r.signed) === 1,
    }));
  }

  /**
   * One run's live lines after `after`, oldest first: its trials', planner's and judge's lines,
   * plus the judge's and the supervisor's lines that name no run.
   */
  liveRun(
    rig: string,
    run: string,
    after: number,
    limit: number,
    ids?: number[],
  ): (LiveEntry & { id: number; signed: boolean })[] {
    // With ids: only those lines (Live draws again the ones waiting for their event).
    const only = ids?.length ? ` and id in (${ids.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `select * from rig_live where rig = ? and id > ?
           and (run = ? or (run is null and source in ('judge', 'supervisor')))${only}
         order by id limit ?`,
      )
      .all(rig, after, run, ...(ids ?? []), limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      seq: Number(r.seq),
      at: String(r.at),
      source: String(r.source),
      kind: String(r.kind) as LiveEntry["kind"],
      text: String(r.text),
      ...(r.lane ? { lane: String(r.lane) } : {}),
      ...(r.run ? { run: String(r.run) } : {}),
      signed: Number(r.signed) === 1,
    }));
  }

  /**
   * The supervisor's Live lines about a run's reviews (goal 116), oldest first: each line that
   * starts "review N", such as each reviewer's answer, a failed try's error and the outcome. They
   * are unsigned, and kept only while the rig's live log keeps them (its newest 20,000 lines).
   */
  reviewLines(rig: string, run: string): { review: number; at: string; text: string }[] {
    const rows = this.db
      .prepare(
        `select at, text from rig_live where rig = ? and run = ? and source = 'supervisor'
           and text like 'review %' order by id limit 5000`,
      )
      .all(rig, run) as Row[];
    return rows.flatMap((r) => {
      const m = /^review (\d+)\b/.exec(String(r.text));
      return m ? [{ review: Number(m[1]), at: String(r.at), text: String(r.text) }] : [];
    });
  }

  /**
   * The owner's messages to one run, from the rig's signed events on its current ledger: what
   * Live checks the message lines against (a worker's own line can claim anything).
   */
  runMessages(rig: string, run: string): Map<number, { to: string; text: string; keep: boolean }> {
    const rows = this.db
      .prepare(
        `select e.body from rig_event e join rig r on r.id = e.rig and r.ledger_id = e.ledger_id
         where e.rig = ? and e.kind = 'agent_message' and e.subject = ?`,
      )
      .all(rig, run) as { body: string }[];
    const out = new Map<number, { to: string; text: string; keep: boolean }>();
    for (const r of rows) {
      try {
        const b = JSON.parse(r.body) as {
          id?: unknown;
          to?: unknown;
          text?: unknown;
          keep?: unknown;
        };
        if (typeof b.id === "number" && typeof b.text === "string")
          out.set(b.id, { to: String(b.to ?? ""), text: b.text, keep: b.keep === true });
      } catch {
        // not an event this store can read
      }
    }
    return out;
  }

  /**
   * An experiment as the rigs' signed events left it (one rig's current ledger): who added it,
   * and its words after every edit. What a copied experiment is taken from. Undefined when no
   * rig, or more than one, has it.
   */
  experimentRecord(
    run: string,
    id: string,
  ):
    | {
        rig: string;
        by: string;
        title: string;
        details?: string | undefined;
        family?: string | undefined;
        why?: string | undefined;
      }
    | undefined {
    const rows = this.db
      .prepare(
        `select e.rig, e.kind, e.body from rig_event e join rig r on r.id = e.rig and r.ledger_id = e.ledger_id
         where e.subject = ? and e.kind in ('experiment_added', 'experiment_edited')
           and json_extract(e.body, '$.id') = ?
         order by e.rig, e.event_id`,
      )
      .all(run, id) as { rig: string; kind: string; body: string }[];
    if (new Set(rows.filter((r) => r.kind === "experiment_added").map((r) => r.rig)).size !== 1)
      return undefined;
    let x:
      | { rig: string; by: string; title: string; details?: string; family?: string; why?: string }
      | undefined;
    for (const r of rows) {
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(r.body) as Record<string, unknown>;
      } catch {
        continue;
      }
      const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
      if (r.kind === "experiment_added") {
        const by = str("by");
        const title = str("title");
        if (!by || !title) return undefined;
        x = {
          rig: r.rig,
          by,
          title,
          details: str("details"),
          family: str("family"),
          why: str("why"),
        };
      } else if (x)
        for (const k of ["title", "details", "family", "why"] as const) {
          const v = str(k);
          if (v !== undefined) x[k] = v;
        }
    }
    return x;
  }

  /**
   * The campaigns control itself assigned to a rig (signed assign_campaign commands it did not
   * see fail), by run. What a rig may read and be given is decided from these, never from what
   * the rig's own events claim.
   */
  assignedCampaigns(rig: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.db
      .prepare(
        "select signed from command where rig = ? and kind = 'assign_campaign' and status not in ('failed', 'rejected', 'expired') order by issued_at",
      )
      .all(rig) as { signed: string }[]) {
      try {
        const p = (
          JSON.parse(r.signed) as {
            envelope?: { payload?: { run?: unknown; contract?: { campaign?: unknown } } };
          }
        ).envelope?.payload;
        if (typeof p?.run === "string" && typeof p.contract?.campaign === "string")
          out.set(p.run, p.contract.campaign);
      } catch {
        // not a command this store wrote
      }
    }
    return out;
  }

  /** One run's newest live lines, newest last (for the Live page's first view). */
  liveRunTail(
    rig: string,
    run: string,
    limit: number,
  ): (LiveEntry & { id: number; signed: boolean })[] {
    const top = this.db
      .prepare(
        `select id from rig_live where rig = ?
           and (run = ? or (run is null and source in ('judge', 'supervisor')))
         order by id desc limit 1 offset ?`,
      )
      .get(rig, run, limit) as { id: number } | undefined;
    return this.liveRun(rig, run, top?.id ?? 0, limit);
  }

  /** The newest live lines of a rig, newest last (for a page's first view). */
  liveTail(
    rig: string,
    limit: number,
    source?: string,
  ): (LiveEntry & { id: number; signed: boolean })[] {
    const top = this.db
      .prepare(
        source
          ? "select id from rig_live where rig = ? and source = ? order by id desc limit 1 offset ?"
          : "select id from rig_live where rig = ? order by id desc limit 1 offset ?",
      )
      .get(...(source ? [rig, source, limit] : [rig, limit])) as { id: number } | undefined;
    return this.live(rig, top?.id ?? 0, limit, source);
  }

  /** Each live source of a rig with its newest line (sessions to pick from). */
  liveSources(rig: string): {
    source: string;
    lane: string | null;
    run: string | null;
    last_at: string;
    lines: number;
    ended: boolean;
  }[] {
    return (
      this.db
        .prepare(
          `select source, max(lane) as lane, max(run) as run, max(at) as last_at, count(*) as lines,
             max(case when kind = 'status' and text like 'trial ended%' then 1 else 0 end) as ended
           from rig_live where rig = ? group by source order by max(id) desc`,
        )
        .all(rig) as Row[]
    ).map((r) => ({
      source: String(r.source),
      lane: r.lane ? String(r.lane) : null,
      run: r.run ? String(r.run) : null,
      last_at: String(r.last_at),
      lines: Number(r.lines),
      ended: Number(r.ended) === 1,
    }));
  }

  /**
   * Each worker trial's session in a rig's live log: when it started and what it was asked to do
   * (its first status line: "trial on lane-1: family, focus"), what it did last (its newest tool
   * call), and how it ended. Newest first.
   */
  liveTrials(rig: string): {
    source: string;
    lane: string | null;
    run: string | null;
    started_at: string;
    last_at: string;
    intro: string;
    last_tool: string | null;
    last_tool_at: string | null;
    ended: string | null;
  }[] {
    const rows = this.db
      .prepare(
        `select source, max(lane) as lane, max(run) as run, min(at) as started_at, max(at) as last_at,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'status'
             order by x.id limit 1) as intro,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'tool'
             order by x.id desc limit 1) as last_tool,
           (select at from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'tool'
             order by x.id desc limit 1) as last_tool_at,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'status'
             and x.text like 'trial ended%' order by x.id desc limit 1) as ended
         from rig_live l where rig = ? and source like 'trial:%' group by source order by max(id) desc`,
      )
      .all(rig) as Row[];
    return rows.map((r) => ({
      source: String(r.source),
      lane: r.lane ? String(r.lane) : null,
      run: r.run ? String(r.run) : null,
      started_at: String(r.started_at),
      last_at: String(r.last_at),
      intro: r.intro ? String(r.intro) : "",
      last_tool: r.last_tool ? String(r.last_tool) : null,
      last_tool_at: r.last_tool_at ? String(r.last_tool_at) : null,
      ended: r.ended ? String(r.ended) : null,
    }));
  }

  addReport(rig: string, kind: string, body: string): number {
    const r = this.db
      .prepare("insert into rig_report (rig, kind, body, at) values (?, ?, ?, ?)")
      .run(rig, kind, body.slice(0, 200_000), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  reports(
    limit = 20,
    rig?: string,
  ): { id: number; rig: string; kind: string; body: string; at: string }[] {
    const rows = (
      rig
        ? this.db
            .prepare("select * from rig_report where rig = ? order by id desc limit ?")
            .all(rig, limit)
        : this.db.prepare("select * from rig_report order by id desc limit ?").all(limit)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      rig: String(r.rig),
      kind: String(r.kind),
      body: String(r.body),
      at: String(r.at),
    }));
  }

  openReset(rig: string): Row | undefined {
    return this.db
      .prepare(
        "select * from reset where rig = ? and state not in ('done', 'failed', 'cancelled') order by id desc",
      )
      .get(rig) as Row | undefined;
  }

  resets(limit = 20): Row[] {
    return this.db.prepare("select * from reset order by id desc limit ?").all(limit) as Row[];
  }

  createReset(rig: string, by: string): number {
    if (this.openReset(rig)) throw new Refusal(`a reset of ${rig} is already in progress`);
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        "insert into reset (rig, state, requested_by, created_at, updated_at) values (?, 'start', ?, ?, ?)",
      )
      .run(rig, by, now, now);
    this.audit(by, "reset_requested", { rig });
    return Number(r.lastInsertRowid);
  }

  updateReset(
    id: number,
    fields: {
      state: string;
      command?: string;
      export_name?: string;
      through_event?: number;
      detail?: string;
    },
  ): void {
    this.db
      .prepare(
        `update reset set state = ?, command = coalesce(?, command), export_name = coalesce(?, export_name),
           through_event = coalesce(?, through_event), detail = coalesce(?, detail), updated_at = ? where id = ?`,
      )
      .run(
        fields.state,
        fields.command ?? null,
        fields.export_name ?? null,
        fields.through_event ?? null,
        fields.detail ?? null,
        new Date().toISOString(),
        id,
      );
    this.audit("control", "reset_step", { id, ...fields });
  }

  /** The rig's pinned report-signing key, if any. */
  rigKey(rig: string): { pubkey: string | null; pending: string | null } {
    const r = this.db.prepare("select pubkey, pending_pubkey from rig where id = ?").get(rig) as
      | Row
      | undefined;
    return {
      pubkey: r?.pubkey ? String(r.pubkey) : null,
      pending: r?.pending_pubkey ? String(r.pending_pubkey) : null,
    };
  }

  /** Pins a rig's key on first contact (trust on first use, shown on the dashboard). */
  pinKey(rig: string, pubkey: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pubkey = excluded.pubkey, pending_pubkey = null`,
      )
      .run(rig, now, now, pubkey);
    this.audit(`rig:${rig}`, "rig_key_pinned", { fingerprint: fingerprint(pubkey) });
  }

  /** A different key arrived: hold it until the owner accepts it. */
  holdKey(rig: string, pubkey: string): void {
    // A first key held for the owner has no rig row yet; the row does not make the rig live.
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, pending_pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pending_pubkey = excluded.pending_pubkey`,
      )
      .run(rig, new Date().toISOString(), new Date(0).toISOString(), pubkey);
    this.audit(`rig:${rig}`, "rig_key_changed", { fingerprint: fingerprint(pubkey) });
  }

  /** Accepts the held key, but only the one with the fingerprint the owner checked. */
  acceptPendingKey(rig: string, actor: string, fingerprintSeen: string): boolean {
    const { pending } = this.rigKey(rig);
    if (!pending || fingerprint(pending) !== fingerprintSeen) return false;
    this.db
      .prepare("update rig set pubkey = pending_pubkey, pending_pubkey = null where id = ?")
      .run(rig);
    this.audit(actor, "rig_key_accepted", { rig, fingerprint: fingerprint(pending) });
    return true;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  createUiSession(idHash: string, tokenFp: string, expiresAt: number): void {
    const now = Date.now();
    this.db.prepare("delete from ui_session where expires_at <= ?").run(now);
    this.db
      .prepare(
        "insert into ui_session (id_hash, token_fp, created_at, expires_at) values (?, ?, ?, ?)",
      )
      .run(idHash, tokenFp, new Date(now).toISOString(), expiresAt);
  }

  uiSession(idHash: string): { tokenFp: string; expiresAt: number } | undefined {
    const r = this.db
      .prepare("select token_fp, expires_at from ui_session where id_hash = ?")
      .get(idHash) as Row | undefined;
    return r ? { tokenFp: String(r.token_fp), expiresAt: Number(r.expires_at) } : undefined;
  }

  extendUiSession(idHash: string, expiresAt: number): void {
    this.db
      .prepare("update ui_session set expires_at = ? where id_hash = ?")
      .run(expiresAt, idHash);
  }

  deleteUiSession(idHash: string): void {
    this.db.prepare("delete from ui_session where id_hash = ?").run(idHash);
  }

  audit(actor: string, action: string, body: unknown): void {
    this.db
      .prepare("insert into audit (at, actor, action, body) values (?, ?, ?, ?)")
      .run(new Date().toISOString(), actor, action, canonicalJson(body ?? {}));
  }

  /** Stores a rig's report. Returns how many events were new. */
  ingest(report: IngestReport): number {
    const now = new Date().toISOString();
    return this.tx(() => {
      this.db
        .prepare(
          `insert into rig (id, first_seen, last_seen, last_cursor, ledger_id, summary, report_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict (id) do update set last_seen = excluded.last_seen,
             last_cursor = case when rig.ledger_id = excluded.ledger_id
               then max(rig.last_cursor, excluded.last_cursor) else excluded.last_cursor end,
             ledger_id = excluded.ledger_id, summary = excluded.summary,
             report_at = excluded.report_at`,
        )
        .run(
          report.rig,
          now,
          now,
          report.next,
          report.ledger_id,
          canonicalJson(report.summary ?? {}),
          report.generated_at ?? now,
        );
      // Ledger history: a new ledger supersedes the ones before it, for good.
      this.db
        .prepare(
          "update rig_ledger set superseded_at = ? where rig = ? and ledger_id != ? and superseded_at is null",
        )
        .run(now, report.rig, report.ledger_id);
      this.db
        .prepare("insert or ignore into rig_ledger (rig, ledger_id, first_seen) values (?, ?, ?)")
        .run(report.rig, report.ledger_id, now);
      let added = 0;
      const insert = this.db.prepare(
        `insert or ignore into rig_event (rig, ledger_id, event_id, at, actor, kind, subject, body,
           received_at, run) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // A harness's own record of a command it applied is authoritative (it is signed with the
      // rig's key); the supervisor's acknowledgement is only the fast path.
      const confirm = this.db.prepare(
        "update command set status = ?, outcome = ?, acked_at = coalesce(acked_at, ?) where id = ? and rig = ?",
      );
      const usage = this.db.prepare(
        `insert or ignore into model_call (rig, ledger_id, event_id, run, campaign, trial, round,
           agent, harness, provider, model, calls, at, tokens_in, cached_in, tokens_out, reasoning,
           first_token_ms, call_ms)
         values (?, ?, ?, ?, (select json_extract(body, '$.campaign') from rig_event
             where rig = ? and kind in ('run_created', 'instance_created') and subject = ?
             order by seq desc limit 1),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of report.events) {
        if (e.kind === "command" && e.subject) {
          const b = (e.body ?? {}) as { accepted?: boolean };
          confirm.run(
            b.accepted === false ? "failed" : "delivered",
            canonicalJson({ source: "harness", ...(e.body as object) }),
            now,
            e.subject,
            report.rig,
          );
        }
        // A model call's usage (goal 075), as columns the sums read. A body that does not read as
        // one stays an event only.
        const call =
          e.kind === MODEL_CALL_EVENT && e.subject ? ModelCallBody.safeParse(e.body) : null;
        if (call?.success) {
          const u = call.data;
          usage.run(
            report.rig,
            report.ledger_id,
            e.id,
            String(e.subject),
            report.rig,
            String(e.subject),
            u.trial,
            u.round,
            u.agent,
            u.harness,
            u.provider,
            u.model,
            u.calls,
            u.at,
            u.tokens_in,
            u.cached_in,
            u.tokens_out,
            u.reasoning,
            u.first_token_ms,
            u.call_ms,
          );
        }
        added += Number(
          insert.run(
            report.rig,
            report.ledger_id,
            e.id,
            e.at,
            e.actor,
            e.kind,
            e.subject,
            canonicalJson(e.body ?? {}),
            now,
            e.run ?? null,
          ).changes,
        );
      }
      return added;
    });
  }

  /** The rigs that reported, but not the retired ones unless asked for. */
  rigs(opts: { withRetired?: boolean } = {}): {
    id: string;
    last_seen: string;
    last_cursor: number;
    ledger_id: string | null;
    summary: unknown;
  }[] {
    return (
      this.db
        .prepare(`select * from rig where ? or id not in (select rig from rig_retired) order by id`)
        .all(opts.withRetired ? 1 : 0) as Row[]
    ).map((r) => ({
      id: String(r.id),
      last_seen: String(r.last_seen),
      last_cursor: Number(r.last_cursor),
      ledger_id: r.ledger_id === null ? null : String(r.ledger_id),
      summary: JSON.parse(String(r.summary)),
    }));
  }

  /**
   * The rig's signed record that a champion was published: its sha256, base commit and ledger
   * (the newest, should a run of that name have been in an earlier ledger).
   */
  publishedChampion(
    rig: string,
    run: string,
    seq: number,
  ): { sha256: string; base_commit: string; repo: string | null; ledger_id: string } | undefined {
    const r = this.db
      .prepare(
        `select body, ledger_id from rig_event where rig = ? and kind = 'champion_published'
           and subject = ? and json_extract(body, '$.seq') = ? order by seq desc limit 1`,
      )
      .get(rig, run, seq) as { body: string; ledger_id: string } | undefined;
    if (!r) return undefined;
    const b = JSON.parse(r.body) as { sha256?: string; base_commit?: string; repo?: string };
    return {
      ledger_id: r.ledger_id,
      sha256: String(b.sha256 ?? ""),
      base_commit: String(b.base_commit ?? ""),
      repo: b.repo ?? null,
    };
  }

  /**
   * A champion's patch from the rig's supervisor, kept only if it is the one the rig published
   * (the supervisor transports it; it cannot change it).
   */
  putChampionPatch(
    rig: string,
    run: string,
    seq: number,
    patch: Buffer,
  ): "stored" | "not_published" | "mismatch" {
    const pub = this.publishedChampion(rig, run, seq);
    if (!pub) return "not_published";
    if (sha256Hex(patch) !== pub.sha256) return "mismatch";
    this.db
      .prepare(
        `insert or ignore into champion_patch
           (rig, ledger_id, run, seq, sha256, base_commit, patch, received_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rig,
        pub.ledger_id,
        run,
        seq,
        pub.sha256,
        pub.base_commit,
        patch,
        new Date().toISOString(),
      );
    return "stored";
  }

  /** The patch of the champion the rig published last as `seq` of `run`: none until it arrives. */
  championPatch(
    rig: string,
    run: string,
    seq: number,
  ): { patch: Buffer; sha256: string; base_commit: string } | undefined {
    const pub = this.publishedChampion(rig, run, seq);
    const r = this.db
      .prepare(
        `select patch, sha256, base_commit from champion_patch
           where rig = ? and ledger_id = ? and run = ? and seq = ?`,
      )
      .get(rig, pub?.ledger_id ?? "", run, seq) as
      | { patch: Uint8Array; sha256: string; base_commit: string }
      | undefined;
    return r
      ? { patch: Buffer.from(r.patch), sha256: r.sha256, base_commit: r.base_commit }
      : undefined;
  }

  /**
   * Starts an export a rig sends (or finds the one it started): "created", "same" when one by
   * that name has this manifest and these files, "different" when it has others.
   */
  beginRigExport(
    rig: string,
    name: string,
    e: {
      manifest: unknown;
      files: Record<string, { size: number; sha256: string }>;
      full: boolean;
      fromEvent: number;
      throughEvent: number;
    },
  ): "created" | "same" | "different" {
    const manifest = canonicalJson(e.manifest);
    const files = canonicalJson(e.files);
    const had = this.db
      .prepare("select manifest, files from rig_export where rig = ? and name = ?")
      .get(rig, name) as { manifest: string; files: string } | undefined;
    if (had) return had.manifest === manifest && had.files === files ? "same" : "different";
    const bytes = Object.values(e.files).reduce((n, f) => n + f.size, 0);
    this.db
      .prepare(
        `insert into rig_export (rig, name, manifest, files, bytes, full, from_event, through_event, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rig,
        name,
        manifest,
        files,
        bytes,
        e.full ? 1 : 0,
        e.fromEvent,
        e.throughEvent,
        new Date().toISOString(),
      );
    return "created";
  }

  /** One export a rig sent to control, with which files arrived. */
  rigExport(rig: string, name: string): RigExport | undefined {
    const r = this.db
      .prepare("select * from rig_export where rig = ? and name = ?")
      .get(rig, name) as Row | undefined;
    return r ? rigExportOf(r) : undefined;
  }

  /** The exports a rig sent to control, newest first. */
  rigExports(rig: string, limit = 100): RigExport[] {
    return (
      this.db
        .prepare(
          "select * from rig_export where rig = ? order by created_at desc, name desc limit ?",
        )
        .all(rig, limit) as Row[]
    ).map(rigExportOf);
  }

  /** The exports every rig sent to control, newest first (the Exports page, goal 103). */
  allRigExports(limit = 500): RigExport[] {
    return (
      this.db
        .prepare("select * from rig_export order by created_at desc, rig, name desc limit ?")
        .all(limit) as Row[]
    ).map(rigExportOf);
  }

  /** A file of an export arrived with its SHA-256; the export is complete with its last file. */
  rigExportFileDone(rig: string, name: string, path: string): { complete: boolean } {
    return this.tx(() => {
      const e = this.rigExport(rig, name);
      if (!e) throw new Error(`no export ${name} of rig ${rig}`);
      const done = [...new Set([...e.done, path])].sort();
      const complete = Object.keys(e.files).every((p) => done.includes(p));
      this.db
        .prepare(
          "update rig_export set done = ?, complete_at = coalesce(complete_at, ?) where rig = ? and name = ?",
        )
        .run(JSON.stringify(done), complete ? new Date().toISOString() : null, rig, name);
      return { complete };
    });
  }

  /**
   * Creates or changes a model provider. A change without a new key keeps the sealed one; a new
   * provider needs a key. Its version moves on every change, so the rigs that use it pick it up.
   */
  putProvider(p: {
    name: string;
    type: ProviderType;
    base_url: string;
    key?: { sealed: string; hint: string } | undefined;
  }): "created" | "updated" | "needs_key" {
    const old = this.provider(p.name);
    // OpenCode's own free models need no key; every other provider does.
    if (!old && !p.key && p.type !== "opencode") return "needs_key";
    this.db
      .prepare(
        `insert into model_provider (name, type, base_url, key_sealed, key_hint, version, updated_at)
         values (?, ?, ?, ?, ?, 1, ?)
         on conflict (name) do update set type = excluded.type, base_url = excluded.base_url,
           key_sealed = excluded.key_sealed, key_hint = excluded.key_hint,
           version = model_provider.version + 1, updated_at = excluded.updated_at`,
      )
      .run(
        p.name,
        p.type,
        p.base_url,
        p.key?.sealed ?? old?.key_sealed ?? "",
        p.key?.hint ?? old?.key_hint ?? "",
        new Date().toISOString(),
      );
    return old ? "updated" : "created";
  }

  providers(): ModelProvider[] {
    return (this.db.prepare("select * from model_provider order by name").all() as Row[]).map(
      providerOf,
    );
  }

  provider(name: string): ModelProvider | undefined {
    const r = this.db.prepare("select * from model_provider where name = ?").get(name) as
      | Row
      | undefined;
    return r ? providerOf(r) : undefined;
  }

  /**
   * Keeps what the provider listed (and the models the owner added by name), or, when listing
   * failed, its error, keeping the last list so the rigs' models stay choosable.
   */
  setProviderModels(name: string, listed: ProviderModel[] | { error: string }): void {
    const now = new Date().toISOString();
    if ("error" in listed) {
      this.db
        .prepare("update model_provider set models_error = ?, models_at = ? where name = ?")
        .run(listed.error.slice(0, 300), now, name);
      return;
    }
    const added = (this.provider(name)?.models ?? []).filter(
      (m) => m.added && !listed.some((x) => x.id === m.id),
    );
    this.db
      .prepare(
        "update model_provider set models = ?, models_error = null, models_at = ? where name = ?",
      )
      .run(JSON.stringify([...listed, ...added]), now, name);
  }

  /**
   * A provider's sealed key replaced where nothing else changes (a ChatGPT login control renewed):
   * its version stays; the routes' revisions follow the key.
   */
  setProviderKey(name: string, sealed: string): void {
    this.db.prepare("update model_provider set key_sealed = ? where name = ?").run(sealed, name);
  }

  /** A model the provider does not list, added by the owner by its name. */
  addProviderModel(name: string, id: string): void {
    const p = this.provider(name);
    if (!p || p.models.some((m) => m.id === id)) return;
    this.db
      .prepare("update model_provider set models = ? where name = ?")
      .run(JSON.stringify([...p.models, { id, added: true }]), name);
  }

  /** Deletes a provider no rig uses. */
  deleteProvider(name: string): "deleted" | "in_use" | "missing" {
    if (!this.provider(name)) return "missing";
    if (
      this.db.prepare("select 1 from rig_model where provider = ?").get(name) ||
      this.db.prepare("select 1 from rig_role_model where provider = ?").get(name)
    )
      return "in_use";
    this.db.prepare("delete from model_provider where name = ?").run(name);
    return "deleted";
  }

  /**
   * Gives a rig's agents a harness and a provider's model, or (null) returns them to the rig's own
   * settings. `contextCap`: a cap on the model's context window in tokens (goal 070); none when
   * left out, so a model given again without one loses it. `compactAt`: the compaction point, in
   * percent of the window (goal 070); left out, the harness's default.
   */
  assignRigModel(
    rig: string,
    choice: {
      provider: string;
      model: string;
      harness?: Harness | undefined;
      effort?: Effort | undefined;
      contextCap?: number | undefined;
      compactAt?: number | undefined;
    } | null,
  ): void {
    if (choice === null) {
      this.db.prepare("delete from rig_model where rig = ?").run(rig);
      return;
    }
    if (!this.provider(choice.provider)) throw new Error(`no model provider ${choice.provider}`);
    this.db
      .prepare(
        `insert into rig_model (rig, provider, model, harness, effort, context_cap, compact_at, assigned_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (rig) do update set provider = excluded.provider, model = excluded.model,
           harness = excluded.harness, effort = excluded.effort, context_cap = excluded.context_cap,
           compact_at = excluded.compact_at, assigned_at = excluded.assigned_at`,
      )
      .run(
        rig,
        choice.provider,
        choice.model,
        choice.harness ?? "pi",
        choice.effort ?? null,
        choice.contextCap ?? null,
        choice.compactAt ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Gives one of a rig's other agents a model, or (null) has it follow the workers again.
   * `harness`: the harness it runs in (goal 073); left out, what its model needs. `contextCap` and
   * `compactAt`: the agent's own cap on its model's window and its compaction point (goal 070), as
   * for the workers' model; none when left out.
   */
  assignRoleModel(
    rig: string,
    role: AgentRole,
    choice: {
      provider: string;
      model: string;
      effort?: Effort | undefined;
      harness?: Harness | undefined;
      contextCap?: number | undefined;
      compactAt?: number | undefined;
    } | null,
  ): void {
    if (choice === null) {
      this.db.prepare("delete from rig_role_model where rig = ? and role = ?").run(rig, role);
      return;
    }
    if (!this.provider(choice.provider)) throw new Error(`no model provider ${choice.provider}`);
    this.db
      .prepare(
        `insert into rig_role_model (rig, role, provider, model, effort, harness, context_cap, compact_at, assigned_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (rig, role) do update set provider = excluded.provider, model = excluded.model,
           effort = excluded.effort, harness = excluded.harness, context_cap = excluded.context_cap,
           compact_at = excluded.compact_at, assigned_at = excluded.assigned_at`,
      )
      .run(
        rig,
        role,
        choice.provider,
        choice.model,
        choice.effort ?? null,
        choice.harness ?? null,
        choice.contextCap ?? null,
        choice.compactAt ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * A rig's other agents' models, by role (roles with none are absent). `harness`: the one the
   * owner chose (goal 073); null, what the model needs. Each with its own cap and compaction
   * point (goal 070), when set.
   */
  roleModels(rig: string): Partial<
    Record<
      AgentRole,
      {
        provider: string;
        model: string;
        effort: Effort | null;
        harness: Harness | null;
        contextCap?: number | undefined;
        compactAt?: number | undefined;
      }
    >
  > {
    const rows = this.db
      .prepare(
        "select role, provider, model, effort, harness, context_cap, compact_at from rig_role_model where rig = ?",
      )
      .all(rig) as Row[];
    return Object.fromEntries(
      rows.map((r) => [
        String(r.role),
        {
          provider: String(r.provider),
          model: String(r.model),
          effort: EFFORTS.includes(String(r.effort) as Effort)
            ? (String(r.effort) as Effort)
            : null,
          harness: HARNESSES.find((h) => h === r.harness) ?? null,
          ...(Number(r.context_cap) > 0 ? { contextCap: Number(r.context_cap) } : {}),
          ...(Number(r.compact_at) > 0 ? { compactAt: Number(r.compact_at) } : {}),
        },
      ]),
    );
  }

  /** Each rig's provider, model, harness, effort, context window cap and compaction point (goal 070). */
  rigModels(): Record<
    string,
    {
      provider: string;
      model: string;
      harness: Harness;
      effort?: Effort | undefined;
      contextCap?: number | undefined;
      compactAt?: number | undefined;
    }
  > {
    const rows = this.db
      .prepare(
        "select rig, provider, model, harness, effort, context_cap, compact_at from rig_model",
      )
      .all() as Row[];
    return Object.fromEntries(
      rows.map((r) => [
        String(r.rig),
        {
          provider: String(r.provider),
          model: String(r.model),
          harness: harnessOf(r.harness),
          ...(EFFORTS.includes(String(r.effort) as Effort)
            ? { effort: String(r.effort) as Effort }
            : {}),
          ...(Number(r.context_cap) > 0 ? { contextCap: Number(r.context_cap) } : {}),
          ...(Number(r.compact_at) > 0 ? { compactAt: Number(r.compact_at) } : {}),
        },
      ]),
    );
  }

  rigModelFor(rig: string):
    | {
        provider: ModelProvider;
        model: string;
        harness: Harness;
        effort?: Effort | undefined;
        contextCap?: number | undefined;
        compactAt?: number | undefined;
      }
    | undefined {
    const c = this.rigModels()[rig];
    const provider = c ? this.provider(c.provider) : undefined;
    return c && provider
      ? {
          provider,
          model: c.model,
          harness: c.harness,
          effort: c.effort,
          contextCap: c.contextCap,
          compactAt: c.compactAt,
        }
      : undefined;
  }

  /**
   * The model usage records the sums read (goal 075): one run's (on one rig, or on any), one
   * campaign's runs' on every rig, or every record, since a time (ISO; null: all). A rig's records
   * stay after it leaves a ledger, or is retired: the calls were made.
   */
  usageRows(scope: UsageScope, since: string | null): UsageRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (since) {
      where.push("at >= ?");
      args.push(since);
    }
    if (scope.kind === "run") {
      where.push("run = ?");
      args.push(scope.run);
      if (scope.rig) {
        where.push("rig = ?");
        args.push(scope.rig);
      }
    }
    if (scope.kind === "campaign") {
      where.push("campaign = ?");
      args.push(scope.campaign);
    }
    const rows = this.db
      .prepare(
        `select rig, run, campaign, trial, agent, harness, provider, model, calls, at, tokens_in,
           cached_in, tokens_out, reasoning, first_token_ms, call_ms from model_call
         ${where.length ? `where ${where.join(" and ")}` : ""} order by at`,
      )
      .all(...args) as Row[];
    return rows.map(usageRowOf);
  }

  /**
   * A run's model calls in its reviews (goal 116), by the review's number: the review panel's
   * records, whose round the supervisor names "review N".
   */
  reviewUsageRows(rig: string, run: string): Map<number, UsageRow[]> {
    const rows = this.db
      .prepare(
        `select rig, run, campaign, trial, round, agent, harness, provider, model, calls, at,
           tokens_in, cached_in, tokens_out, reasoning, first_token_ms, call_ms from model_call
         where rig = ? and run = ? and round like 'review %' order by at`,
      )
      .all(rig, run) as Row[];
    const out = new Map<number, UsageRow[]>();
    for (const r of rows) {
      const m = /^review (\d+)$/.exec(String(r.round));
      if (!m) continue;
      const n = Number(m[1]);
      out.set(n, [...(out.get(n) ?? []), usageRowOf(r)]);
    }
    return out;
  }

  /**
   * When each round of a run on a rig started, oldest first (goal 075: a run page's calls in each
   * round): the times of its `epoch_started` events, on any of the rig's ledgers.
   */
  roundStarts(rig: string, run: string): string[] {
    return (
      this.db
        .prepare(
          "select at from rig_event where rig = ? and kind = 'epoch_started' and subject = ? order by seq",
        )
        .all(rig, run) as Row[]
    ).map((r) => String(r.at));
  }

  /**
   * A rig's events after a seq. `lean`: without the text a source's and a document's events
   * carry (the knowledge base keeps it), and without the model calls (one for each call: the
   * usage sums read them, from model_call), for readers that build pages from every event.
   */
  events(
    rig: string,
    after: number,
    limit: number,
    ledgerId?: string | null,
    o: { lean?: boolean } = {},
  ): unknown[] {
    const byLedger = ledgerId ? " and ledger_id = ?" : "";
    const body = o.lean
      ? "case when kind in ('source_fetched', 'research_doc', 'context_compacted') then json_remove(body, '$.text') else body end"
      : "body";
    const calls = o.lean ? ` and kind != '${MODEL_CALL_EVENT}'` : "";
    return (
      this.db
        .prepare(
          `select seq, ledger_id, event_id, at, actor, kind, subject, ${body} as body, run from rig_event
             where rig = ?${byLedger}${calls} and seq > ? order by seq limit ?`,
        )
        .all(...(ledgerId ? [rig, ledgerId, after, limit] : [rig, after, limit])) as Row[]
    ).map((r) =>
      // Events a harness reported before the 2026-10-15 rename are read under the new names.
      currentEvent({
        seq: Number(r.seq),
        ledger_id: String(r.ledger_id),
        id: Number(r.event_id),
        at: String(r.at),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: r.subject === null ? null : String(r.subject),
        body: JSON.parse(String(r.body)),
        run: r.run === null ? null : String(r.run),
      }),
    );
  }

  enqueueCommand(signed: SignedCommand): void {
    const e = signed.envelope;
    this.db
      .prepare(
        "insert into command (id, rig, kind, signed, issued_by, issued_at, status) values (?, ?, ?, ?, ?, ?, 'pending')",
      )
      .run(e.id, e.rig, e.kind, canonicalJson(signed), e.issued_by, e.issued_at);
    this.audit(e.issued_by, "command_issued", { id: e.id, rig: e.rig, kind: e.kind });
  }

  /** A rig's pending commands, oldest first. Expired ones are marked expired, not relayed. */
  pendingCommands(rig: string): SignedCommand[] {
    const now = Date.now();
    const out: SignedCommand[] = [];
    for (const r of this.db
      .prepare(
        "select id, signed from command where rig = ? and status = 'pending' order by issued_at",
      )
      .all(rig) as Row[]) {
      const cmd = JSON.parse(String(r.signed)) as SignedCommand;
      if (Date.parse(cmd.envelope.expires_at) < now) {
        this.db
          .prepare(
            "update command set status = 'expired', acked_at = ? where id = ? and status = 'pending'",
          )
          .run(new Date().toISOString(), String(r.id));
        this.audit("control", "command_expired", { id: String(r.id), rig });
        continue;
      }
      out.push(cmd);
    }
    return out;
  }

  /** The owner withdraws a command that has not been delivered. */
  cancelCommand(id: string, actor: string): boolean {
    const r = this.db
      .prepare(
        "update command set status = 'failed', outcome = ?, acked_at = ? where id = ? and status = 'pending'",
      )
      .run(canonicalJson({ cancelled_by: actor }), new Date().toISOString(), id);
    if (Number(r.changes)) this.audit(actor, "command_cancelled", { id });
    return Number(r.changes) > 0;
  }

  ackCommand(
    rig: string,
    id: string,
    status: "delivered" | "rejected" | "failed",
    outcome: unknown,
  ): boolean {
    const r = this.db
      .prepare(
        "update command set status = ?, outcome = ?, acked_at = ? where id = ? and rig = ? and status = 'pending'",
      )
      .run(status, canonicalJson(outcome ?? {}), new Date().toISOString(), id, rig);
    if (Number(r.changes) > 0) this.audit(`rig:${rig}`, "command_acked", { id, status });
    return Number(r.changes) > 0;
  }

  /** Adds Git access; a name is used once (delete it to make another). */
  putGitAccess(g: GitAccess & { secret_sealed: string; by: string }): void {
    this.db
      .prepare(
        `insert into git_access (name, kind, public_key, fingerprint, secret_sealed, hint, username, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.name,
        g.kind,
        g.public_key,
        g.fingerprint,
        g.secret_sealed,
        g.hint,
        g.username,
        new Date().toISOString(),
        g.by,
      );
    this.audit(g.by, "git_access_added", { name: g.name, kind: g.kind, hint: g.hint });
  }

  /** Git access by name, with its sealed secret (for control's own use only). */
  gitAccess(name: string): (GitAccess & { secret_sealed: string }) | undefined {
    const r = this.db.prepare("select * from git_access where name = ?").get(name) as
      | Row
      | undefined;
    return r ? { ...gitAccessOf(r), secret_sealed: String(r.secret_sealed) } : undefined;
  }

  /** Every Git access, without secrets. */
  gitAccessList(): GitAccess[] {
    return (this.db.prepare("select * from git_access order by name").all() as Row[]).map(
      gitAccessOf,
    );
  }

  // ---------------------------------------------------------------- machines (over SSH)
  addMachine(m: {
    name: string;
    address: string;
    port: number;
    user: string;
    key_sealed: string;
    public_key: string;
    key_fingerprint: string;
    seen_host_keys: string[];
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into machine (name, address, port, user, key_sealed, public_key, key_fingerprint, seen_host_keys, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.name,
        m.address,
        m.port,
        m.user,
        m.key_sealed,
        m.public_key,
        m.key_fingerprint,
        JSON.stringify(m.seen_host_keys),
        new Date().toISOString(),
        m.by,
      );
    this.audit(m.by, "machine_added", {
      name: m.name,
      address: m.address,
      port: m.port,
      user: m.user,
      key: m.key_fingerprint,
    });
  }

  machine(name: string): (Machine & { key_sealed: string }) | undefined {
    const r = this.db.prepare("select * from machine where name = ?").get(name) as Row | undefined;
    return r ? { ...machineOf(r), key_sealed: String(r.key_sealed) } : undefined;
  }

  machines(): Machine[] {
    return (this.db.prepare("select * from machine order by name").all() as Row[]).map(machineOf);
  }

  /** The host keys the machine presents now, kept for the owner to compare. */
  seeMachineHostKeys(name: string, lines: string[]): void {
    this.db
      .prepare("update machine set seen_host_keys = ? where name = ?")
      .run(JSON.stringify(lines), name);
  }

  /** The owner trusts the host keys they were shown: from now on only these connect. */
  trustMachineHostKeys(name: string, lines: string[], by: string): void {
    this.db
      .prepare("update machine set host_keys = ? where name = ?")
      .run(JSON.stringify(lines), name);
    this.audit(by, "machine_host_key_trusted", { name, keys: lines.length });
  }

  /** What the last check found, or why it failed (keeping the facts before it). */
  setMachineFacts(name: string, r: { facts: unknown } | { error: string }): void {
    if ("facts" in r)
      this.db
        .prepare("update machine set facts = ?, checked_at = ?, check_error = null where name = ?")
        .run(JSON.stringify(r.facts), new Date().toISOString(), name);
    else
      this.db
        .prepare("update machine set checked_at = ?, check_error = ? where name = ?")
        .run(new Date().toISOString(), r.error, name);
  }

  /** The owner's yes to one install: one recipe's exact script on one machine, used once. */
  approveInstall(i: {
    machine: string;
    recipe: string;
    script_sha: string;
    by: string;
    ttlMs: number;
  }): number {
    const now = Date.now();
    const r = this.db
      .prepare(
        `insert into machine_install (machine, recipe, script_sha, approved_by, approved_at, expires_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.machine,
        i.recipe,
        i.script_sha,
        i.by,
        new Date(now).toISOString(),
        new Date(now + i.ttlMs).toISOString(),
      );
    this.audit(i.by, "machine_install_approved", {
      machine: i.machine,
      recipe: i.recipe,
      script_sha: i.script_sha,
    });
    return Number(r.lastInsertRowid);
  }

  /** Uses an approval: false when it was used already, has expired, or doesn't match. */
  startInstall(id: number, machine: string, recipe: string, scriptSha: string): boolean {
    const r = this.db
      .prepare(
        `update machine_install set started_at = ?
         where id = ? and machine = ? and recipe = ? and script_sha = ? and started_at is null and expires_at > ?`,
      )
      .run(new Date().toISOString(), id, machine, recipe, scriptSha, new Date().toISOString());
    return Number(r.changes) > 0;
  }

  finishInstall(id: number, ok: boolean, output: string): void {
    const r = this.db
      .prepare("update machine_install set finished_at = ?, ok = ?, output = ? where id = ?")
      .run(new Date().toISOString(), ok ? 1 : 0, output.slice(-4000), id);
    if (Number(r.changes)) {
      const row = this.db
        .prepare("select machine, recipe from machine_install where id = ?")
        .get(id) as Row;
      this.audit("control", "machine_install_finished", {
        machine: String(row.machine),
        recipe: String(row.recipe),
        ok,
      });
    }
  }

  /** A machine's installs, newest first. */
  machineInstalls(machine: string): {
    id: number;
    recipe: string;
    approved_by: string;
    approved_at: string;
    started_at: string | null;
    finished_at: string | null;
    ok: boolean | null;
    output: string | null;
  }[] {
    return (
      this.db
        .prepare("select * from machine_install where machine = ? order by id desc limit 20")
        .all(machine) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      recipe: String(r.recipe),
      approved_by: String(r.approved_by),
      approved_at: String(r.approved_at),
      started_at: r.started_at === null ? null : String(r.started_at),
      finished_at: r.finished_at === null ? null : String(r.finished_at),
      ok: r.ok === null ? null : Number(r.ok) === 1,
      output: r.output === null ? null : String(r.output),
    }));
  }

  addMachineRig(r: Omit<MachineRig, "created_at" | "status">): void {
    this.db
      .prepare(
        `insert into machine_rig (rig, machine, gpus, judge_gpus, images, root, status, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, 'deploying', ?, ?)`,
      )
      .run(
        r.rig,
        r.machine,
        JSON.stringify(r.gpus),
        r.judge_gpus ?? null,
        JSON.stringify(r.images),
        r.root ? 1 : 0,
        new Date().toISOString(),
        r.created_by,
      );
    this.audit(r.created_by, "machine_rig_created", {
      rig: r.rig,
      machine: r.machine,
      gpus: r.gpus,
      images: r.images,
    });
  }

  machineRig(rig: string): MachineRig | undefined {
    const r = this.db.prepare("select * from machine_rig where rig = ?").get(rig) as
      | Row
      | undefined;
    return r ? machineRigOf(r) : undefined;
  }

  /** The rigs control set up, on one machine or all, removed ones last. */
  machineRigs(machine?: string): MachineRig[] {
    const rows = (
      machine
        ? this.db.prepare("select * from machine_rig where machine = ? order by rig").all(machine)
        : this.db.prepare("select * from machine_rig order by machine, rig").all()
    ) as Row[];
    return rows.map(machineRigOf);
  }

  setMachineRigStatus(rig: string, status: string): void {
    this.db.prepare("update machine_rig set status = ? where rig = ?").run(status, rig);
  }

  /** The images a rig control set up on a machine runs now, after an update. */
  setMachineRigImages(rig: string, images: MachineRig["images"]): void {
    this.db
      .prepare("update machine_rig set images = ? where rig = ?")
      .run(JSON.stringify(images), rig);
  }

  /** One step of a rig's setup or management, for its history. */
  rigSetupEvent(rig: string, step: string, ok: boolean, detail?: string): void {
    this.db
      .prepare("insert into rig_setup_event (rig, at, step, ok, detail) values (?, ?, ?, ?, ?)")
      .run(rig, new Date().toISOString(), step, ok ? 1 : 0, detail ?? null);
  }

  rigSetupEvents(rig: string): { at: string; step: string; ok: boolean; detail: string | null }[] {
    return (
      this.db.prepare("select * from rig_setup_event where rig = ? order by id").all(rig) as Row[]
    ).map((r) => ({
      at: String(r.at),
      step: String(r.step),
      ok: Number(r.ok) === 1,
      detail: r.detail === null ? null : String(r.detail),
    }));
  }

  // ---------------------------------------------------------------- joined rigs
  addJoinedRig(r: { rig: string; form: JoinForm; spec: JoinedSpec; by: string }): void {
    this.db
      .prepare(
        `insert into joined_rig (rig, form, spec, status, created_at, created_by)
         values (?, ?, ?, 'waiting', ?, ?)`,
      )
      .run(r.rig, r.form, JSON.stringify(r.spec), new Date().toISOString(), r.by);
    this.audit(r.by, "joined_rig_added", { rig: r.rig, form: r.form });
  }

  joinedRig(rig: string): JoinedRig | undefined {
    const r = this.db.prepare("select * from joined_rig where rig = ?").get(rig) as Row | undefined;
    return r ? joinedRigOf(r) : undefined;
  }

  /** A new join command for the rig (its hash); any earlier one stops working. */
  setJoinToken(rig: string, sha256: string, expiresAt: string, by: string): void {
    this.db
      .prepare(
        "update joined_rig set join_sha256 = ?, join_expires_at = ?, join_used_at = null where rig = ?",
      )
      .run(Credential.ofHash(sha256).hex, expiresAt, rig);
    this.audit(by, "join_command_made", { rig, expires_at: expiresAt });
  }

  revokeJoinToken(rig: string, by: string): void {
    this.db
      .prepare(
        "update joined_rig set join_sha256 = null, join_expires_at = null where rig = ? and join_used_at is null",
      )
      .run(rig);
    this.audit(by, "join_command_revoked", { rig });
  }

  /**
   * Uses the rig's join command, once: true when the token is its current one, unused and not
   * expired; it then stops working.
   */
  useJoinToken(rig: string, token: string): boolean {
    const r = this.db
      .prepare(
        "select join_sha256, join_expires_at, join_used_at, status from joined_rig where rig = ?",
      )
      .get(rig) as Row | undefined;
    if (!r || r.join_sha256 === null || r.join_used_at !== null || r.status === "retired")
      return false;
    if (Date.parse(String(r.join_expires_at)) <= Date.now()) return false;
    if (!Credential.ofHash(String(r.join_sha256)).matches(token)) return false;
    const u = this.db
      .prepare(
        "update joined_rig set join_used_at = ? where rig = ? and join_sha256 = ? and join_used_at is null",
      )
      .run(new Date().toISOString(), rig, String(r.join_sha256));
    if (Number(u.changes) !== 1) return false;
    this.audit(`rig:${rig}`, "join_command_used", { rig });
    return true;
  }

  setJoinedRig(rig: string, change: { status?: string; spec?: JoinedSpec }): void {
    const cur = this.joinedRig(rig);
    if (!cur) return;
    this.db
      .prepare("update joined_rig set status = ?, spec = ? where rig = ?")
      .run(change.status ?? cur.status, JSON.stringify(change.spec ?? cur.spec), rig);
  }

  // ---------------------------------------------------------------- GPU clouds (RunPod)
  addGpuCloud(g: {
    name: string;
    kind: GpuCloud["kind"];
    key_sealed: string;
    key_hint: string;
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into gpu_cloud (name, kind, key_sealed, key_hint, created_at, created_by)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(g.name, g.kind, g.key_sealed, g.key_hint, new Date().toISOString(), g.by);
    this.audit(g.by, "gpu_cloud_added", { name: g.name, kind: g.kind, key_hint: g.key_hint });
  }

  gpuCloud(name: string): (GpuCloud & { key_sealed: string }) | undefined {
    const r = this.db.prepare("select * from gpu_cloud where name = ?").get(name) as
      | Row
      | undefined;
    return r ? { ...gpuCloudOf(r), key_sealed: String(r.key_sealed) } : undefined;
  }

  gpuClouds(): GpuCloud[] {
    return (this.db.prepare("select * from gpu_cloud order by name").all() as Row[]).map(
      gpuCloudOf,
    );
  }

  setGpuCloudFacts(name: string, r: { facts: unknown } | { error: string }): void {
    if ("facts" in r)
      this.db
        .prepare(
          "update gpu_cloud set facts = ?, checked_at = ?, check_error = null where name = ?",
        )
        .run(JSON.stringify(r.facts), new Date().toISOString(), name);
    else
      this.db
        .prepare("update gpu_cloud set checked_at = ?, check_error = ? where name = ?")
        .run(new Date().toISOString(), r.error, name);
  }

  replaceGpuCloudKey(name: string, key_sealed: string, key_hint: string, by: string): void {
    this.db
      .prepare("update gpu_cloud set key_sealed = ?, key_hint = ? where name = ?")
      .run(key_sealed, key_hint, name);
    this.audit(by, "gpu_cloud_key_replaced", { name, key_hint });
  }

  deleteGpuCloud(name: string, by: string): boolean {
    const r = this.db.prepare("delete from gpu_cloud where name = ?").run(name);
    if (Number(r.changes)) this.audit(by, "gpu_cloud_deleted", { name });
    return Number(r.changes) > 0;
  }

  // ---------------------------------------------------------------- retired rigs
  /** Retires any rig: it leaves the lists, its reports are refused, a token control made ends. */
  retireAnyRig(rig: string, by: string): void {
    this.db
      .prepare("insert or ignore into rig_retired (rig, at, by) values (?, ?, ?)")
      .run(rig, new Date().toISOString(), by);
    if (this.enrolledRig(rig)) this.retireRig(rig, by);
    this.audit(by, "rig_retired", { rig });
  }

  /** Brings a retired rig back into the lists; a token control made for it stays ended. */
  bringBackRig(rig: string, by: string): boolean {
    const r = this.db.prepare("delete from rig_retired where rig = ?").run(rig);
    if (Number(r.changes)) this.audit(by, "rig_brought_back", { rig });
    return Number(r.changes) > 0;
  }

  rigRetired(rig: string): { at: string; by: string } | undefined {
    const r = this.db.prepare("select at, by from rig_retired where rig = ?").get(rig) as
      | Row
      | undefined;
    return r ? { at: String(r.at), by: String(r.by) } : undefined;
  }

  retiredRigs(): { rig: string; at: string; by: string }[] {
    return (this.db.prepare("select * from rig_retired order by at desc").all() as Row[]).map(
      (r) => ({
        rig: String(r.rig),
        at: String(r.at),
        by: String(r.by),
      }),
    );
  }

  // ---------------------------------------------------------------- builds and refusals
  /** The build a part of the rig last reported, and since when; undefined when it reported none. */
  rigBuild(rig: string, component: RigComponent): StoredBuild | undefined {
    const r = this.db
      .prepare("select * from rig_build where rig = ? and component = ?")
      .get(rig, component) as Row | undefined;
    if (!r) return undefined;
    const num = (v: SQLInputValue | undefined) =>
      v === null || v === undefined ? null : Number(v);
    return {
      version: r.version === null ? null : String(r.version),
      commit: r.commit_sha === null ? null : String(r.commit_sha),
      protocol: num(r.protocol),
      oldest_protocol: num(r.oldest_protocol),
      since: String(r.since),
    };
  }

  /**
   * Records the build a part of the rig reports (null: it reports none). Written only when it
   * changes, so `since` is when control first saw it. True when it changed.
   */
  setRigBuild(rig: string, component: RigComponent, b: ReportedBuild | null): boolean {
    const was = this.rigBuild(rig, component);
    if (!b) {
      if (!was) return false;
      this.db.prepare("delete from rig_build where rig = ? and component = ?").run(rig, component);
      return true;
    }
    if (
      was &&
      was.version === b.version &&
      was.commit === b.commit &&
      was.protocol === b.protocol &&
      was.oldest_protocol === b.oldest_protocol
    )
      return false;
    this.db
      .prepare(
        `insert or replace into rig_build (rig, component, version, commit_sha, protocol,
           oldest_protocol, since) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rig,
        component,
        b.version,
        b.commit,
        b.protocol,
        b.oldest_protocol,
        new Date().toISOString(),
      );
    return true;
  }

  /**
   * Why control refuses the rig now, and since when; how many of its calls control refused since,
   * and when the last one came. Undefined when it does not refuse it.
   */
  rigRefusal(rig: string): RigRefusal | undefined {
    const r = this.db
      .prepare("select reason, since, calls, last_at from rig_refusal where rig = ?")
      .get(rig) as Row | undefined;
    return r
      ? {
          reason: String(r.reason),
          since: String(r.since),
          calls: Number(r.calls ?? 0),
          last_at: r.last_at === null || r.last_at === undefined ? null : String(r.last_at),
        }
      : undefined;
  }

  /** One more of a refused rig's calls, refused: counted, with its time. */
  countRefusedCall(rig: string): void {
    this.db
      .prepare("update rig_refusal set calls = calls + 1, last_at = ? where rig = ?")
      .run(new Date().toISOString(), rig);
  }

  /**
   * Notes the build control runs now, and returns since when control runs it: a build is kept from
   * the first time control ran it, so a restart on the same build keeps its time.
   */
  noteControlBuild(b: { version: string; commit: string | null }): string {
    const last = this.db
      .prepare("select version, commit_sha, since from control_build order by rowid desc limit 1")
      .get() as Row | undefined;
    if (last && String(last.version) === b.version && (last.commit_sha ?? null) === b.commit)
      return String(last.since);
    const since = new Date().toISOString();
    this.db
      .prepare("insert into control_build (version, commit_sha, since) values (?, ?, ?)")
      .run(b.version, b.commit, since);
    return since;
  }

  /** Since when control runs the build it noted last (noteControlBuild); undefined: none noted. */
  controlBuildSince(): string | undefined {
    const r = this.db
      .prepare("select since from control_build order by rowid desc limit 1")
      .get() as Row | undefined;
    return r ? String(r.since) : undefined;
  }

  /** The rigs control refuses now. */
  refusedRigs(): string[] {
    return (this.db.prepare("select rig from rig_refusal order by rig").all() as Row[]).map((r) =>
      String(r.rig),
    );
  }

  /**
   * Refuses the rig for this reason, or (null) ends its refusal. Each new refusal and each end
   * goes to the audit log once, not on every call the rig makes. A refused rig that never sent a
   * report is listed (with no report: offline), so the owner sees why.
   */
  setRigRefusal(rig: string, reason: string | null, detail: Record<string, unknown> = {}): void {
    const was = this.rigRefusal(rig);
    if (reason === null) {
      if (!was) return;
      this.db.prepare("delete from rig_refusal where rig = ?").run(rig);
      this.audit(`rig:${rig}`, "rig_refusal_ended", { was: was.reason, ...detail });
      return;
    }
    if (was?.reason === reason) return;
    const now = new Date().toISOString();
    this.tx(() => {
      this.db
        .prepare("insert or replace into rig_refusal (rig, reason, since) values (?, ?, ?)")
        .run(rig, reason, now);
      this.db
        .prepare("insert or ignore into rig (id, first_seen, last_seen) values (?, ?, ?)")
        .run(rig, now, new Date(0).toISOString());
      this.audit(`rig:${rig}`, "rig_refused", { reason, ...detail });
    });
  }

  // ---------------------------------------------------------------- rigs in pull mode
  /** A rig minted for a pod about to be launched; its pod comes later (attachTunnelPod). */
  addTunnelRig(
    t: Pick<
      TunnelRig,
      "rig" | "port" | "box_public" | "code_expires_at" | "config" | "created_by"
    > & {
      prefix_sealed: string;
      box_private_sealed: string;
      code_sealed: string;
    },
  ): void {
    this.db
      .prepare(
        `insert into tunnel_rig (rig, port, prefix_sealed, box_private_sealed, box_public,
           code_sealed, code_expires_at, config, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.rig,
        t.port,
        t.prefix_sealed,
        t.box_private_sealed,
        t.box_public,
        t.code_sealed,
        t.code_expires_at,
        JSON.stringify(t.config),
        new Date().toISOString(),
        t.created_by,
      );
    this.audit(t.created_by, "tunnel_rig_added", {
      rig: t.rig,
      code_expires_at: t.code_expires_at,
    });
  }

  /** The pod a rig in pull mode runs in, and control's address for it; refused once enrolled. */
  attachTunnelPod(rig: string, pod: string, url: string): boolean {
    const r = this.db
      .prepare("update tunnel_rig set pod = ?, url = ? where rig = ? and enrolled_at is null")
      .run(pod, url, rig);
    if (Number(r.changes)) this.audit("control", "tunnel_rig_pod", { rig, pod, url });
    return Number(r.changes) > 0;
  }

  tunnelRig(rig: string): (TunnelRig & TunnelSecrets) | undefined {
    const r = this.db.prepare("select * from tunnel_rig where rig = ?").get(rig) as Row | undefined;
    return r ? tunnelRigOf(r) : undefined;
  }

  tunnelRigs(): TunnelRig[] {
    return (this.db.prepare("select * from tunnel_rig order by rig").all() as Row[]).map((r) => {
      const {
        prefix_sealed: _p,
        box_private_sealed: _b,
        code_sealed: _c,
        ...rest
      } = tunnelRigOf(r);
      return rest;
    });
  }

  /**
   * Removes a minted rig whose pod was never made (its launch failed): nothing can enroll with
   * its code any more. Refused once it has a pod.
   */
  dropTunnelRig(rig: string, by: string): boolean {
    const r = this.db
      .prepare("delete from tunnel_rig where rig = ? and pod is null and enrolled_at is null")
      .run(rig);
    if (Number(r.changes)) this.audit(by, "tunnel_rig_dropped", { rig });
    return Number(r.changes) > 0;
  }

  /** Pins the pod's keys and spends the code; refused once pinned (a second enrollment). */
  pinTunnelRig(rig: string, sign: string, box: string): boolean {
    const r = this.db
      .prepare(
        `update tunnel_rig set pod_sign_public = ?, pod_box_public = ?, enrolled_at = ?,
           code_sealed = '', error = null
         where rig = ? and enrolled_at is null`,
      )
      .run(sign, box, new Date().toISOString(), rig);
    if (Number(r.changes)) this.audit("control", "tunnel_rig_enrolled", { rig });
    return Number(r.changes) > 0;
  }

  /** After each exchange: when it was, what the pod refused since, and the last error. */
  tunnelExchanged(rig: string, r: { refused?: number; error?: string | null }): void {
    this.db
      .prepare(
        `update tunnel_rig set last_exchange_at = case when ? is null then last_exchange_at else ? end,
           refused_total = refused_total + ?, error = ? where rig = ?`,
      )
      .run(r.error ? null : 1, new Date().toISOString(), r.refused ?? 0, r.error ?? null, rig);
    if (r.refused) this.audit("control", "tunnel_refusals", { rig, refused: r.refused });
  }

  // ---------------------------------------------------------------- test pods on GPU clouds
  addRunpodRig(t: { rig: string; cloud: string; pod: string; state: unknown; by: string }): void {
    this.db
      .prepare(
        "insert into runpod_rig (rig, cloud, pod, active, state, created_at, created_by) values (?, ?, ?, 1, ?, ?, ?)",
      )
      .run(t.rig, t.cloud, t.pod, JSON.stringify(t.state), new Date().toISOString(), t.by);
  }

  saveRunpodRig(rig: string, state: unknown, active: boolean): void {
    const spent = (s: unknown) => {
      const n = (s as { spent_usd?: unknown } | null)?.spent_usd;
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
    };
    this.tx(() => {
      const before = this.runpodRig(rig);
      this.db
        .prepare("update runpod_rig set state = ?, active = ? where rig = ?")
        .run(JSON.stringify(state), active ? 1 : 0, rig);
      // What the pod cost since control last counted it goes to the run its rig runs now.
      if (before) this.notePodSpend(rig, spent(state) - spent(before.state));
    });
  }

  /**
   * A pod's spend since control last counted it (goal 075), for the runs its rig is running now,
   * split evenly when it runs more than one; for no run when it runs none.
   */
  private notePodSpend(rig: string, usd: number): void {
    if (!(usd > 1e-9)) return;
    const runs = this.runningRuns(rig);
    const at = new Date().toISOString();
    const insert = this.db.prepare(
      "insert into pod_spend (rig, run, campaign, at, usd) values (?, ?, ?, ?, ?)",
    );
    if (!runs.length) insert.run(rig, null, null, at, usd);
    for (const r of runs) insert.run(rig, r.run, r.campaign, at, usd / runs.length);
  }

  /** The runs a rig is running now, on its current ledger, from its events. */
  runningRuns(rig: string): { run: string; campaign: string | null }[] {
    const ledger = (
      this.db.prepare("select ledger_id from rig where id = ?").get(rig) as Row | undefined
    )?.ledger_id;
    if (!ledger) return [];
    const runs = new Map<string, { campaign: string | null; running: boolean }>();
    for (const e of this.db
      .prepare(
        `select kind, subject, body from rig_event where rig = ? and ledger_id = ?
           and kind in ('run_created', 'instance_created', 'run_status', 'instance_status')
         order by seq`,
      )
      .all(rig, String(ledger)) as Row[]) {
      let b: Record<string, unknown> = {};
      try {
        b = JSON.parse(String(e.body)) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = String(e.subject);
      if (e.kind === "run_created" || e.kind === "instance_created")
        runs.set(id, {
          campaign: typeof b.campaign === "string" ? b.campaign : null,
          running: true,
        });
      else {
        const r = runs.get(id);
        if (r) r.running = b.status === "running";
      }
    }
    return [...runs.entries()]
      .filter(([, r]) => r.running)
      .map(([run, r]) => ({ run, campaign: r.campaign }));
  }

  /**
   * GPU cloud pods' spend (goal 075): one run's (on one rig, or on any), one campaign's runs', or
   * every pod's, idle time included, since a time (ISO; null: all).
   */
  podSpend(scope: UsageScope, since: string | null): PodSpendRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (since) {
      where.push("at >= ?");
      args.push(since);
    }
    if (scope.kind === "run") {
      where.push("run = ?");
      args.push(scope.run);
      if (scope.rig) {
        where.push("rig = ?");
        args.push(scope.rig);
      }
    }
    if (scope.kind === "campaign") {
      where.push("campaign = ?");
      args.push(scope.campaign);
    }
    return (
      this.db
        .prepare(
          `select rig, run, campaign, at, usd from pod_spend
           ${where.length ? `where ${where.join(" and ")}` : ""} order by id`,
        )
        .all(...args) as Row[]
    ).map((r) => ({
      rig: String(r.rig),
      run: r.run === null ? null : String(r.run),
      campaign: r.campaign === null ? null : String(r.campaign),
      at: String(r.at),
      usd: Number(r.usd),
    }));
  }

  /** The prices the owner set for providers' models (goal 075). */
  modelPrices(): {
    provider: string;
    model: string;
    price: ModelPrice;
    set_by: string;
    set_at: string;
  }[] {
    return (
      this.db.prepare("select * from model_price order by provider, model").all() as Row[]
    ).map((r) => ({
      provider: String(r.provider),
      model: String(r.model),
      price: {
        input: Number(r.input),
        cached_input: r.cached_input === null ? null : Number(r.cached_input),
        output: Number(r.output),
      },
      set_by: String(r.set_by),
      set_at: String(r.set_at),
    }));
  }

  /** Sets (or, with null, removes) the owner's price for a provider's model. */
  setModelPrice(provider: string, model: string, price: ModelPrice | null, by: string): void {
    if (!price) {
      this.db
        .prepare("delete from model_price where provider = ? and model = ?")
        .run(provider, model);
      this.audit(by, "model_price_cleared", { provider, model });
      return;
    }
    this.db
      .prepare(
        `insert into model_price (provider, model, input, cached_input, output, set_by, set_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (provider, model) do update set input = excluded.input,
           cached_input = excluded.cached_input, output = excluded.output,
           set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(
        provider,
        model,
        price.input,
        price.cached_input,
        price.output,
        by,
        new Date().toISOString(),
      );
    this.audit(by, "model_price_set", { provider, model, ...price });
  }

  runpodRig(rig: string): StoredRunpodRig | undefined {
    const r = this.db.prepare("select * from runpod_rig where rig = ?").get(rig) as Row | undefined;
    return r ? runpodRigOf(r) : undefined;
  }

  /** RunPod rigs, newest first: on one cloud, or only those control still follows. */
  runpodRigs(f: { cloud?: string | undefined; active?: boolean } = {}): StoredRunpodRig[] {
    return (
      this.db
        .prepare(
          `select * from runpod_rig where (? is null or cloud = ?) and (? = 0 or active = 1)
           order by created_at desc, rig desc`,
        )
        .all(f.cloud ?? null, f.cloud ?? null, f.active ? 1 : 0) as Row[]
    ).map(runpodRigOf);
  }

  addRunpodTest(t: { id: string; cloud: string; state: unknown; by: string }): void {
    this.db
      .prepare(
        "insert into runpod_test (id, cloud, active, state, created_at, created_by) values (?, ?, 1, ?, ?, ?)",
      )
      .run(t.id, t.cloud, JSON.stringify(t.state), new Date().toISOString(), t.by);
  }

  /** Saves a test's state; `active` is false once its pod is gone. */
  saveRunpodTest(id: string, state: unknown, active: boolean): void {
    this.db
      .prepare("update runpod_test set state = ?, active = ? where id = ?")
      .run(JSON.stringify(state), active ? 1 : 0, id);
  }

  runpodTest(id: string): StoredRunpodTest | undefined {
    const r = this.db.prepare("select * from runpod_test where id = ?").get(id) as Row | undefined;
    return r ? runpodTestOf(r) : undefined;
  }

  /** Newest first; only those whose pod may still exist with `active`. */
  runpodTests(
    f: { cloud?: string | undefined; active?: boolean; limit?: number } = {},
  ): StoredRunpodTest[] {
    return (
      this.db
        .prepare(
          `select * from runpod_test where (? is null or cloud = ?) and (? = 0 or active = 1)
           order by created_at desc, id desc limit ?`,
        )
        .all(f.cloud ?? null, f.cloud ?? null, f.active ? 1 : 0, f.limit ?? 50) as Row[]
    ).map(runpodTestOf);
  }

  // ---------------------------------------------------------------- clusters (Kubernetes)
  addCluster(c: {
    name: string;
    kubeconfig_sealed: string;
    context: string;
    placement: Cluster["placement"];
    namespace_pattern: string;
    slots: string[];
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into cluster (name, kubeconfig_sealed, context, placement, namespace_pattern, slots, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.name,
        c.kubeconfig_sealed,
        c.context,
        c.placement,
        c.namespace_pattern,
        JSON.stringify(c.slots),
        new Date().toISOString(),
        c.by,
      );
    this.audit(c.by, "cluster_added", {
      name: c.name,
      context: c.context,
      placement: c.placement,
      slots: c.slots,
    });
  }

  cluster(name: string): (Cluster & { kubeconfig_sealed: string }) | undefined {
    const r = this.db.prepare("select * from cluster where name = ?").get(name) as Row | undefined;
    return r ? { ...clusterOf(r), kubeconfig_sealed: String(r.kubeconfig_sealed) } : undefined;
  }

  clusters(): Cluster[] {
    return (this.db.prepare("select * from cluster order by name").all() as Row[]).map(clusterOf);
  }

  /** A cluster of pre-made slots: the slots control may use. */
  setClusterSlots(name: string, slots: string[], by: string): void {
    this.db.prepare("update cluster set slots = ? where name = ?").run(JSON.stringify(slots), name);
    this.audit(by, "cluster_slots_set", { name, slots });
  }

  setClusterFacts(name: string, r: { facts: unknown } | { error: string }): void {
    if ("facts" in r)
      this.db
        .prepare("update cluster set facts = ?, checked_at = ?, check_error = null where name = ?")
        .run(JSON.stringify(r.facts), new Date().toISOString(), name);
    else
      this.db
        .prepare("update cluster set checked_at = ?, check_error = ? where name = ?")
        .run(new Date().toISOString(), r.error, name);
  }

  deleteCluster(name: string, by: string): boolean {
    const r = this.db.prepare("delete from cluster where name = ?").run(name);
    if (Number(r.changes)) this.audit(by, "cluster_deleted", { name });
    return Number(r.changes) > 0;
  }

  addClusterRig(r: Omit<ClusterRig, "created_at" | "status">): void {
    this.db
      .prepare(
        `insert into cluster_rig (rig, cluster, namespace, placement, spec, status, created_at, created_by)
         values (?, ?, ?, ?, ?, 'deploying', ?, ?)`,
      )
      .run(
        r.rig,
        r.cluster,
        r.namespace,
        r.placement,
        JSON.stringify(r.spec),
        new Date().toISOString(),
        r.created_by,
      );
    this.audit(r.created_by, "cluster_rig_created", {
      rig: r.rig,
      cluster: r.cluster,
      namespace: r.namespace,
      placement: r.placement,
      gpus: r.spec.gpus,
    });
  }

  clusterRig(rig: string): ClusterRig | undefined {
    const r = this.db.prepare("select * from cluster_rig where rig = ?").get(rig) as
      | Row
      | undefined;
    return r ? clusterRigOf(r) : undefined;
  }

  clusterRigs(cluster?: string): ClusterRig[] {
    const rows = (
      cluster
        ? this.db.prepare("select * from cluster_rig where cluster = ? order by rig").all(cluster)
        : this.db.prepare("select * from cluster_rig order by cluster, rig").all()
    ) as Row[];
    return rows.map(clusterRigOf);
  }

  /** A rig's status there. A change waiting for its drain ends with the drain: kept only while draining. */
  setClusterRigStatus(rig: string, status: string): void {
    this.db
      .prepare(
        "update cluster_rig set status = ?, pending = case when ? = 'draining' then pending else null end where rig = ?",
      )
      .run(status, status, rig);
  }

  /** The change to a rig's GPUs, CPUs or memory that waits for its drain; null: none. */
  setClusterRigPending(rig: string, pending: ClusterRigResize | null): void {
    this.db
      .prepare("update cluster_rig set pending = ? where rig = ?")
      .run(pending ? JSON.stringify(pending) : null, rig);
  }

  /** The GPUs, judge's share and CPUs and memory a rig on a cluster now runs with, after a change. */
  setClusterRigSize(rig: string, size: ClusterRigSize, controlUrl?: string | undefined): void {
    const r = this.clusterRig(rig);
    if (!r) return;
    const spec: ClusterRig["spec"] = {
      ...r.spec,
      gpus: size.gpus,
      judgeGpus: size.judgeGpus,
      resources: size.resources,
      ...(controlUrl ? { controlUrl } : {}),
    };
    this.db.prepare("update cluster_rig set spec = ? where rig = ?").run(JSON.stringify(spec), rig);
  }

  /** The images a rig on a cluster now runs, after an image update. */
  setClusterRigImages(
    rig: string,
    images: ClusterRig["spec"]["images"],
    controlUrl?: string | undefined,
  ): void {
    const r = this.clusterRig(rig);
    if (!r) return;
    this.db
      .prepare("update cluster_rig set spec = ? where rig = ?")
      .run(JSON.stringify({ ...r.spec, images, ...(controlUrl ? { controlUrl } : {}) }), rig);
  }

  deleteMachine(name: string, by: string): boolean {
    const r = this.db.prepare("delete from machine where name = ?").run(name);
    if (Number(r.changes)) this.audit(by, "machine_deleted", { name });
    return Number(r.changes) > 0;
  }

  /** A token replaced in place: same name, so campaigns that name it keep working. */
  replaceGitToken(name: string, secretSealed: string, hint: string, by: string): boolean {
    const r = this.db
      .prepare(
        "update git_access set secret_sealed = ?, hint = ? where name = ? and kind = 'token'",
      )
      .run(secretSealed, hint, name);
    if (Number(r.changes)) this.audit(by, "git_access_token_replaced", { name, hint });
    return Number(r.changes) > 0;
  }

  /** The campaigns whose latest version fetches its project or kit with this Git access. */
  campaignsUsingGitAccess(name: string): string[] {
    const latest = new Map<string, CampaignSources>();
    const rows = this.db
      .prepare("select campaign, sources from campaign_version order by version desc")
      .all() as { campaign: string; sources: string }[];
    for (const r of rows) {
      if (latest.has(r.campaign)) continue;
      try {
        latest.set(r.campaign, JSON.parse(r.sources) as CampaignSources);
      } catch {
        latest.set(r.campaign, {});
      }
    }
    return [...latest]
      .filter(
        ([, s]) =>
          s.project?.access === name ||
          (s.kit !== undefined && "git" in s.kit && s.kit.access === name),
      )
      .map(([c]) => c)
      .sort();
  }

  deleteGitAccess(name: string, by: string): boolean {
    const r = this.db.prepare("delete from git_access where name = ?").run(name);
    if (Number(r.changes)) this.audit(by, "git_access_deleted", { name });
    return Number(r.changes) > 0;
  }

  /**
   * Whether a rig was assigned a campaign that names this Git access in an import: the only
   * rigs control hands it to.
   */
  rigUsesGitAccess(rig: string, name: string): boolean {
    const rows = this.db
      .prepare("select signed from command where rig = ? and kind = 'assign_campaign'")
      .all(rig) as { signed: string }[];
    return rows.some((r) => {
      try {
        const imports = (
          JSON.parse(r.signed) as {
            envelope?: { payload?: { imports?: { source?: { access?: string } }[] } };
          }
        ).envelope?.payload?.imports;
        return (imports ?? []).some((i) => i.source?.access === name);
      } catch {
        return false;
      }
    });
  }

  /** The next version number for a campaign created on control (1 for a new one). */
  nextCampaignVersion(campaign: string): number {
    const r = this.db
      .prepare("select max(version) as v from campaign_version where campaign = ?")
      .get(campaign) as { v: number | null };
    return (r.v ?? 0) + 1;
  }

  /**
   * Stores a campaign version, approved by whoever created it, with where its runs fetch from
   * and, for a copy, where it was copied from.
   */
  putCampaign(c: {
    campaign: string;
    version: number;
    contract: unknown;
    sha: string;
    sources?: CampaignSources | undefined;
    copiedFrom?: CopiedFrom | undefined;
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into campaign_version (campaign, version, contract, sha, sources, created_at, created_by, approved_by, copied_from)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.campaign,
        c.version,
        canonicalJson(c.contract),
        c.sha,
        canonicalJson(c.sources ?? {}),
        new Date().toISOString(),
        c.by,
        c.by,
        c.copiedFrom ? canonicalJson(c.copiedFrom) : null,
      );
    this.audit(c.by, "campaign_version_created", {
      campaign: c.campaign,
      version: c.version,
      sha: c.sha,
    });
  }

  /** Every campaign version created on control, newest first. */
  campaignVersions(campaign?: string): {
    campaign: string;
    version: number;
    contract: unknown;
    sha: string;
    sources: CampaignSources;
    created_at: string;
    created_by: string;
    /** For a copy: where it was copied from; null otherwise. */
    copied_from: CopiedFrom | null;
  }[] {
    const rows = (
      campaign
        ? this.db
            .prepare("select * from campaign_version where campaign = ? order by version desc")
            .all(campaign)
        : this.db.prepare("select * from campaign_version order by created_at desc").all()
    ) as Row[];
    return rows.map((r) => ({
      campaign: String(r.campaign),
      version: Number(r.version),
      contract: JSON.parse(String(r.contract)),
      sha: String(r.sha),
      sources: JSON.parse(String(r.sources ?? "{}")) as CampaignSources,
      created_at: String(r.created_at),
      created_by: String(r.created_by),
      copied_from: r.copied_from ? (JSON.parse(String(r.copied_from)) as CopiedFrom) : null,
    }));
  }

  // ------------------------------------------------ campaign folders and archive (goal 077)

  /** The navigation's folders, by name, each with the campaigns in it (by name). */
  campaignFolders(): {
    id: number;
    name: string;
    created_at: string;
    created_by: string;
    campaigns: string[];
  }[] {
    const inFolder = new Map<number, string[]>();
    for (const r of this.db
      .prepare("select campaign, folder from campaign_in_folder order by campaign")
      .all() as Row[]) {
      const list = inFolder.get(Number(r.folder)) ?? [];
      list.push(String(r.campaign));
      inFolder.set(Number(r.folder), list);
    }
    return (
      this.db.prepare("select * from campaign_folder order by name collate nocase").all() as Row[]
    ).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      created_at: String(r.created_at),
      created_by: String(r.created_by),
      campaigns: inFolder.get(Number(r.id)) ?? [],
    }));
  }

  /** A folder of the navigation by its name, whatever its case. */
  campaignFolder(name: string): { id: number; name: string } | undefined {
    const r = this.db
      .prepare("select id, name from campaign_folder where name = ? collate nocase")
      .get(name) as Row | undefined;
    return r ? { id: Number(r.id), name: String(r.name) } : undefined;
  }

  addCampaignFolder(name: string, by: string): number {
    const r = this.db
      .prepare("insert into campaign_folder (name, created_at, created_by) values (?, ?, ?)")
      .run(name, new Date().toISOString(), by);
    return Number(r.lastInsertRowid);
  }

  renameCampaignFolder(id: number, name: string): void {
    this.db.prepare("update campaign_folder set name = ? where id = ?").run(name, id);
  }

  /** Deletes a folder (campaign-folders.ts deletes only an empty one). */
  deleteCampaignFolder(id: number): void {
    this.db.prepare("delete from campaign_in_folder where folder = ?").run(id);
    this.db.prepare("delete from campaign_folder where id = ?").run(id);
  }

  /** Puts a campaign in a folder of the navigation, or (null) in none. */
  setCampaignFolder(campaign: string, folder: number | null): void {
    if (folder === null)
      this.db.prepare("delete from campaign_in_folder where campaign = ?").run(campaign);
    else
      this.db
        .prepare(
          "insert into campaign_in_folder (campaign, folder) values (?, ?) on conflict (campaign) do update set folder = excluded.folder",
        )
        .run(campaign, folder);
  }

  /** The folder a campaign shows in, or undefined for none. */
  campaignFolderOf(campaign: string): { id: number; name: string } | undefined {
    const r = this.db
      .prepare(
        "select f.id, f.name from campaign_in_folder c join campaign_folder f on f.id = c.folder where c.campaign = ?",
      )
      .get(campaign) as Row | undefined;
    return r ? { id: Number(r.id), name: String(r.name) } : undefined;
  }

  /** Every archived campaign, the newest first. */
  archivedCampaigns(): { campaign: string; at: string; by: string }[] {
    return (
      this.db
        .prepare("select * from campaign_archived order by archived_at desc, campaign")
        .all() as Row[]
    ).map((r) => ({
      campaign: String(r.campaign),
      at: String(r.archived_at),
      by: String(r.archived_by),
    }));
  }

  /** When and by whom a campaign was archived, or undefined when it is not. */
  campaignArchived(campaign: string): { at: string; by: string } | undefined {
    const r = this.db
      .prepare("select archived_at, archived_by from campaign_archived where campaign = ?")
      .get(campaign) as Row | undefined;
    return r ? { at: String(r.archived_at), by: String(r.archived_by) } : undefined;
  }

  /**
   * Archives a campaign. It keeps its folder (the owner, 2026-10-21): the navigation leaves it out
   * while it is archived, and unarchiving brings it back into the same folder.
   */
  archiveCampaign(campaign: string, by: string): { at: string; by: string } {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "insert into campaign_archived (campaign, archived_at, archived_by) values (?, ?, ?) on conflict (campaign) do nothing",
      )
      .run(campaign, at, by);
    return this.campaignArchived(campaign) ?? { at, by };
  }

  unarchiveCampaign(campaign: string): boolean {
    return (
      Number(
        this.db.prepare("delete from campaign_archived where campaign = ?").run(campaign).changes,
      ) > 0
    );
  }

  /**
   * The runs of a campaign that control has sent a rig to start or resume, and that the rig has
   * not taken yet: its pending assign_campaign commands, and pending resume_run commands of its
   * runs. Expired ones are left out. An assignment the rig took in the last ten minutes, whose run
   * it has not reported yet, waits too.
   */
  pendingStarts(campaign: string): { rig: string; run: string; kind: string }[] {
    const now = Date.now();
    const out: { rig: string; run: string; kind: string }[] = [];
    const assigned = new Map<string, Map<string, string>>();
    const since = new Date(now - 10 * 60_000).toISOString();
    for (const r of this.db
      .prepare(
        `select rig, kind, status, signed from command where kind in ('assign_campaign', 'resume_run')
           and (status = 'pending' or (status = 'delivered' and kind = 'assign_campaign' and acked_at > ?))
         order by issued_at`,
      )
      .all(since) as Row[]) {
      let env: {
        expires_at?: string;
        payload?: { run?: unknown; contract?: { campaign?: unknown } };
      };
      try {
        env = (JSON.parse(String(r.signed)) as { envelope?: typeof env }).envelope ?? {};
      } catch {
        continue;
      }
      const rig = String(r.rig);
      const run = typeof env.payload?.run === "string" ? env.payload.run : "";
      if (!run) continue;
      if (r.status === "pending" && Date.parse(env.expires_at ?? "") < now) continue;
      // Taken: it waits only until the rig reports the run.
      if (r.status === "delivered" && this.campaignOfRun(rig, run) !== undefined) continue;
      let of: string | undefined;
      if (r.kind === "assign_campaign") {
        of =
          typeof env.payload?.contract?.campaign === "string"
            ? env.payload.contract.campaign
            : undefined;
      } else {
        if (!assigned.has(rig)) assigned.set(rig, this.assignedCampaigns(rig));
        of = assigned.get(rig)?.get(run) ?? this.campaignOfRun(rig, run);
      }
      if (of === campaign) out.push({ rig, run, kind: String(r.kind) });
    }
    return out;
  }

  /** A run's campaign, from the rig's own run_created event on any of its ledgers. */
  campaignOfRun(rig: string, run: string): string | undefined {
    const r = this.db
      .prepare(
        "select body from rig_event where rig = ? and kind in ('run_created', 'instance_created') and subject = ? order by seq desc limit 1",
      )
      .get(rig, run) as Row | undefined;
    if (!r) return undefined;
    try {
      const c = (JSON.parse(String(r.body)) as { campaign?: unknown }).campaign;
      return typeof c === "string" ? c : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The newest assignment control signed for each campaign, on any rig: what a new run of a
   * campaign assigned over the API, MCP or the CLI starts from. Failed and expired ones are left
   * out.
   */
  latestAssignments(): Map<
    string,
    { id: string; rig: string; run: string; payload: Record<string, unknown>; issued_at: string }
  > {
    const rows = this.db
      .prepare(
        "select id, rig, signed, issued_at from command where kind = 'assign_campaign' and status in ('pending', 'delivered') order by issued_at desc",
      )
      .all() as { id: string; rig: string; signed: string; issued_at: string }[];
    const out = new Map<
      string,
      { id: string; rig: string; run: string; payload: Record<string, unknown>; issued_at: string }
    >();
    for (const r of rows) {
      try {
        const payload = (
          JSON.parse(r.signed) as { envelope?: { payload?: Record<string, unknown> } }
        ).envelope?.payload;
        const campaign = (payload?.contract as { campaign?: unknown } | undefined)?.campaign;
        if (payload && typeof campaign === "string" && !out.has(campaign))
          out.set(campaign, {
            id: r.id,
            rig: r.rig,
            run: String(payload.run ?? ""),
            payload,
            issued_at: r.issued_at,
          });
      } catch {
        // not a command this store wrote
      }
    }
    return out;
  }

  /** Rigs that have a token but have not reported yet still accept commands. */
  knownRig(rig: string): boolean {
    return (
      this.configuredRigs.has(rig) ||
      this.enrolledRig(rig) !== undefined ||
      Boolean(this.tunnelRig(rig)?.enrolled_at)
    );
  }

  /** An enrolled rig's record, if it is enrolled and not retired. */
  enrolledRig(rig: string): EnrolledRig | undefined {
    const r = this.db
      .prepare("select * from rig_token where rig = ? and retired_at is null")
      .get(rig) as Row | undefined;
    return r ? enrolledOf(r) : undefined;
  }

  /** Every rig enrolled through control, retired ones included. */
  enrolledRigs(): EnrolledRig[] {
    return (this.db.prepare("select * from rig_token order by rig").all() as Row[]).map(enrolledOf);
  }

  /** Whether a token is this enrolled rig's current one. */
  rigTokenMatches(rig: string, token: string): boolean {
    const r = this.db
      .prepare("select token_sha256 from rig_token where rig = ? and retired_at is null")
      .get(rig) as { token_sha256: string } | undefined;
    return r ? Credential.ofHash(r.token_sha256).matches(token) : false;
  }

  /** Enrolls a rig with a token's SHA-256. A retired rig may be enrolled again. */
  enrollRig(rig: string, tokenSha256: string, by: string): void {
    if (this.enrolledRig(rig)) throw new Error(`rig ${rig} is already enrolled`);
    this.db
      .prepare(
        `insert into rig_token (rig, token_sha256, created_at, created_by) values (?, ?, ?, ?)
         on conflict(rig) do update set token_sha256 = excluded.token_sha256,
           created_at = excluded.created_at, created_by = excluded.created_by,
           rotated_at = null, retired_at = null`,
      )
      .run(rig, Credential.ofHash(tokenSha256).hex, new Date().toISOString(), by);
    // Enrolled again under a retired name: it is back.
    this.db.prepare("delete from rig_retired where rig = ?").run(rig);
    this.audit(by, "rig_enrolled", { rig });
  }

  /** Gives an enrolled rig a new token; the old one stops working at once. */
  rotateRigToken(rig: string, tokenSha256: string, by: string): void {
    const r = this.db
      .prepare(
        "update rig_token set token_sha256 = ?, rotated_at = ? where rig = ? and retired_at is null",
      )
      .run(Credential.ofHash(tokenSha256).hex, new Date().toISOString(), rig);
    if (Number(r.changes) === 0) throw new Error(`rig ${rig} is not enrolled`);
    this.audit(by, "rig_token_rotated", { rig });
  }

  /** Retires an enrolled rig: its token stops working. Its history stays. */
  retireRig(rig: string, by: string): void {
    const r = this.db
      .prepare("update rig_token set retired_at = ? where rig = ? and retired_at is null")
      .run(new Date().toISOString(), rig);
    if (Number(r.changes) === 0) throw new Error(`rig ${rig} is not enrolled`);
    this.audit(by, "rig_retired", { rig });
  }

  setConfiguredRigs(rigs: readonly string[]): void {
    this.configuredRigs = new Set(rigs);
  }

  /**
   * The newest owner message (message_agent) control sent to one run, and the rig's answer: refused
   * (with why), or not.
   */
  lastMessageToRun(
    rig: string,
    run: string,
    to?: string,
  ): { refused: string | null; issued_at: string } | undefined {
    const rows = this.db
      .prepare(
        "select signed, status, outcome, issued_at from command where rig = ? and kind = 'message_agent' order by issued_at desc limit 30",
      )
      .all(rig) as Row[];
    for (const r of rows) {
      try {
        const payload = (
          JSON.parse(String(r.signed)) as { envelope?: { payload?: { run?: string; to?: string } } }
        ).envelope?.payload;
        if (payload?.run !== run || (to !== undefined && payload.to !== to)) continue;
        const out = r.outcome
          ? (JSON.parse(String(r.outcome)) as {
              accepted?: boolean;
              error?: string;
              result?: { error?: string };
            })
          : null;
        const failed = r.status === "failed" || r.status === "rejected" || out?.accepted === false;
        return {
          refused: failed ? (out?.result?.error ?? out?.error ?? String(r.status)) : null,
          issued_at: String(r.issued_at),
        };
      } catch {
        // not a command this store wrote
      }
    }
    return undefined;
  }

  listCommands(limit = 100): {
    id: string;
    rig: string;
    kind: string;
    issued_by: string;
    issued_at: string;
    status: string;
    acked_at: string | null;
    outcome: unknown;
  }[] {
    return (
      this.db
        .prepare(
          "select id, rig, kind, issued_by, issued_at, status, acked_at, outcome from command order by issued_at desc limit ?",
        )
        .all(limit) as Row[]
    ).map((r) => ({
      id: String(r.id),
      rig: String(r.rig),
      kind: String(r.kind),
      issued_by: String(r.issued_by),
      issued_at: String(r.issued_at),
      status: String(r.status),
      acked_at: r.acked_at === null ? null : String(r.acked_at),
      outcome: r.outcome ? JSON.parse(String(r.outcome)) : null,
    }));
  }

  /**
   * The owner's decisions sent to rigs (promote, decline, accept a review, conclude), newest
   * first, with what each rig answered: so a decision shows as sent the moment it is made, not
   * only once the rig's next report arrives.
   */
  decisions(limit = 200): Decision[] {
    const rows = this.db
      .prepare(
        `select id, rig, kind, signed, issued_at, status, acked_at, outcome from command
         where kind in ('approve_promotion', 'decline_promotion', 'accept_review', 'conclude')
         order by issued_at desc limit ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        payload =
          (JSON.parse(String(r.signed)) as { envelope?: { payload?: Record<string, unknown> } })
            .envelope?.payload ?? {};
      } catch {}
      return {
        id: String(r.id),
        rig: String(r.rig),
        kind: String(r.kind),
        run: typeof payload.run === "string" ? payload.run : "",
        attempt: typeof payload.attempt === "string" ? payload.attempt : undefined,
        review: typeof payload.review === "number" ? payload.review : undefined,
        proposal: typeof payload.proposal === "number" ? payload.proposal : undefined,
        accept: typeof payload.accept === "boolean" ? payload.accept : undefined,
        issued_at: String(r.issued_at),
        status: String(r.status),
        acked_at: r.acked_at === null ? null : String(r.acked_at),
        outcome: r.outcome ? (JSON.parse(String(r.outcome)) as Decision["outcome"]) : null,
      };
    });
  }

  /** The newest audit entries; `action` keeps those whose action contains it, `mcp` MCP reads. */
  listAudit(limit = 200, filter: AuditFilter = {}): AuditEntry[] {
    return this.auditPage(limit, filter).entries;
  }

  /**
   * One page of the audit log, newest first (goal 015). With no cursor, the newest entries;
   * `before` keeps those older than it, `after` those newer. `older` and `newer` are the cursors
   * for the next page each way: give `older` as `before`, `newer` as `after`. Null when no entry
   * that matches is left that way.
   */
  auditPage(
    limit = 200,
    filter: AuditFilter = {},
    cursor: { before?: number | undefined; after?: number | undefined } = {},
  ): { entries: AuditEntry[]; older: number | null; newer: number | null } {
    const match = "(? or action not like 'mcp:%') and instr(action, ?) > 0";
    const args = [filter.mcp === false ? 0 : 1, filter.action ?? ""] as const;
    const { before, after } = cursor;
    const rows = (
      after !== undefined
        ? (
            this.db
              .prepare(
                `select id, at, actor, action, body from audit where ${match} and id > ? order by id limit ?`,
              )
              .all(...args, after, limit) as Row[]
          )
            // The entries just after the cursor, shown newest first like every page.
            .reverse()
        : (this.db
            .prepare(
              `select id, at, actor, action, body from audit where ${match} and id < ? order by id desc limit ?`,
            )
            .all(...args, before ?? Number.MAX_SAFE_INTEGER, limit) as Row[])
    ).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      body: JSON.parse(String(r.body)),
    }));
    const any = (where: string, id: number) =>
      this.db
        .prepare(`select 1 from audit where ${match} and id ${where} ? limit 1`)
        .get(...args, id) !== undefined;
    // The edges of this page; an empty page has them at its cursor.
    const hi = rows[0]?.id ?? (before !== undefined ? Math.max(0, before - 1) : after);
    const lo = rows.at(-1)?.id ?? (after !== undefined ? after + 1 : before);
    return {
      entries: rows,
      older: lo !== undefined && any("<", lo) ? lo : null,
      newer: hi !== undefined && any(">", hi) ? hi : null,
    };
  }

  /** The body of the newest audit entry by this actor with this action, if there is one. */
  lastAudit(actor: string, action: string): unknown {
    const r = this.db
      .prepare("select body from audit where actor = ? and action = ? order by id desc limit 1")
      .get(actor, action) as Row | undefined;
    return r ? JSON.parse(String(r.body)) : undefined;
  }

  command(id: string): { status: string; outcome: unknown } | undefined {
    const r = this.db.prepare("select status, outcome from command where id = ?").get(id) as
      | Row
      | undefined;
    return r
      ? { status: String(r.status), outcome: r.outcome ? JSON.parse(String(r.outcome)) : null }
      : undefined;
  }

  /**
   * One command as the dashboard follows it (goal 080): its state, the rig's answer, its payload
   * and when its signature runs out. A pending command past that time is one the rig never took.
   */
  commandRow(id: string): CommandRow | undefined {
    const r = this.db
      .prepare(
        "select id, rig, kind, signed, issued_by, issued_at, status, outcome, acked_at from command where id = ?",
      )
      .get(id) as Row | undefined;
    return r ? commandRowOf(r) : undefined;
  }

  /** A rig's newest commands of one kind, newest first (a check's row follows its newest one). */
  latestCommands(rig: string, kind: string, limit = 20): CommandRow[] {
    return (
      this.db
        .prepare(
          "select id, rig, kind, signed, issued_by, issued_at, status, outcome, acked_at from command where rig = ? and kind = ? order by issued_at desc limit ?",
        )
        .all(rig, kind, limit) as Row[]
    ).map(commandRowOf);
  }

  /** A rig's rig check events on one ledger, oldest first: a check's row reads only these. */
  rigCheckEvents(
    rig: string,
    ledgerId: string | null,
  ): { at: string; kind: string; body: unknown }[] {
    const byLedger = ledgerId ? " and ledger_id = ?" : "";
    return (
      this.db
        .prepare(
          `select at, kind, body from rig_event where rig = ?${byLedger} and kind in ('rig_check_started', 'rig_check_finished') order by seq`,
        )
        .all(...(ledgerId ? [rig, ledgerId] : [rig])) as Row[]
    ).map((r) => ({ at: String(r.at), kind: String(r.kind), body: JSON.parse(String(r.body)) }));
  }
}

/** A command control issued, as the dashboard follows it. */
export interface CommandRow {
  id: string;
  rig: string;
  kind: string;
  issued_by: string;
  issued_at: string;
  /** When its signature runs out: the rig refuses it after that. */
  expires_at: string;
  status: "pending" | "delivered" | "rejected" | "failed" | "expired";
  acked_at: string | null;
  outcome: unknown;
  payload: Record<string, unknown>;
}

function commandRowOf(r: Row): CommandRow {
  let envelope: { expires_at?: unknown; payload?: unknown } = {};
  try {
    envelope = (JSON.parse(String(r.signed)) as { envelope?: typeof envelope }).envelope ?? {};
  } catch {
    // not a command this store wrote: no payload, and no time it runs out
  }
  const payload = envelope.payload;
  return {
    id: String(r.id),
    rig: String(r.rig),
    kind: String(r.kind),
    issued_by: String(r.issued_by),
    issued_at: String(r.issued_at),
    expires_at: typeof envelope.expires_at === "string" ? envelope.expires_at : String(r.issued_at),
    status: String(r.status) as CommandRow["status"],
    acked_at: r.acked_at === null ? null : String(r.acked_at),
    outcome: r.outcome ? JSON.parse(String(r.outcome)) : null,
    payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {},
  };
}

/** An audit page's cursor from a query string: a whole number of 0 or more, or none. */
export function cursorOf(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export { fingerprint };
