import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson, sha256Hex } from "../core/canonical.ts";
import type { SignedCommand } from "../core/commands.ts";
import type { LiveEntry } from "../core/live.ts";
import { currentEvent } from "../core/names.ts";
import { Credential } from "./credential.ts";
import type { JoinedSpec, JoinForm } from "./join.ts";

/**
 * Control's store: rigs, the events they report, and command queues. A single control process
 * owns it. Ingest is idempotent: re-sent events (same rig and event id) are ignored.
 */
type Row = Record<string, SQLInputValue>;

const SCHEMA = `
create table if not exists rig (
  id text primary key,
  first_seen text not null,
  last_seen text not null,
  last_cursor integer not null default 0,
  ledger_id text,
  summary text not null default '{}'
);
-- Event ids are unique only within one harness ledger, and a wiped or lost ledger starts again
-- at 1, so events are keyed by (rig, ledger_id, event_id). seq is control's own order.
create table if not exists rig_event (
  seq integer primary key autoincrement,
  rig text not null,
  ledger_id text not null,
  event_id integer not null,
  at text not null,
  actor text not null,
  kind text not null,
  subject text,
  body text not null,
  received_at text not null,
  unique (rig, ledger_id, event_id)
);
create index if not exists rig_event_kind on rig_event (rig, kind);
create table if not exists command (
  id text primary key,
  rig text not null,
  kind text not null,
  signed text not null,
  issued_by text not null,
  issued_at text not null,
  status text not null check (status in ('pending', 'delivered', 'rejected', 'failed', 'expired')),
  outcome text,
  acked_at text
);
create index if not exists command_pending on command (rig, status);
create table if not exists audit (
  id integer primary key autoincrement,
  at text not null,
  actor text not null,
  action text not null,
  body text not null
);
-- Every ledger a rig has reported from; a ledger it has left is never accepted again.
create table if not exists rig_ledger (
  rig text not null,
  ledger_id text not null,
  first_seen text not null,
  superseded_at text,
  primary key (rig, ledger_id)
);
create table if not exists rig_report (
  id integer primary key autoincrement,
  rig text not null,
  kind text not null,
  body text not null,
  at text not null
);
-- Dashboard sign-ins, kept across restarts. Only a hash of each session id is stored, with a
-- fingerprint of the admin token it was made with (a new token ends every session).
create table if not exists ui_session (
  id_hash text primary key,
  token_fp text not null,
  created_at text not null,
  expires_at integer not null
);

-- Full resets (owner only): pause, export, verify the push, wipe, restart. One open per rig.
create table if not exists reset (
  id integer primary key autoincrement,
  rig text not null,
  state text not null,
  requested_by text not null,
  command text,
  export_name text,
  through_event integer,
  detail text,
  created_at text not null,
  updated_at text not null
);
-- The live view: recent live-log lines per rig (harness lines signed; supervisor lines not).
create table if not exists rig_live (
  id integer primary key autoincrement,
  rig text not null,
  log_id text not null,
  seq integer not null,
  at text not null,
  source text not null,
  kind text not null,
  text text not null,
  lane text,
  run text,
  signed integer not null,
  received_at text not null
);
create unique index if not exists rig_live_seq on rig_live (rig, log_id, seq);
-- Champions' patches as each rig's supervisor uploaded them, kept only when they match the
-- sha256 the rig's signed champion_published event names: what an operator downloads.
create table if not exists champion_patch (
  rig text not null,
  run text not null,
  seq integer not null,
  sha256 text not null,
  base_commit text not null,
  patch blob not null,
  received_at text not null,
  primary key (rig, run, seq)
);
-- A model provider the owner set: its type, where it is, and its API key sealed (control's secret
-- box; never stored in clear). models is its own model list, as control last read it (plus any the
-- owner added by name). version moves on every change, so the rigs that use it pick it up.
create table if not exists model_provider (
  name text primary key,
  type text not null,
  base_url text not null,
  key_sealed text not null,
  key_hint text not null,
  version integer not null default 1,
  updated_at text not null,
  models text not null default '[]',
  models_at text,
  models_error text
);
-- The provider and model each rig's agents use. A rig with none keeps its own settings.
create table if not exists rig_model (
  rig text primary key,
  provider text not null,
  model text not null,
  assigned_at text not null
);
-- The model of each of a rig's other agents (planner, teacher pair, combiner, auditor, review
-- panel), when the owner gave one; a role with none follows the workers, or the rig's own settings.
create table if not exists rig_role_model (
  rig text not null,
  role text not null check (role in ('planner', 'teachers', 'combiner', 'auditor', 'panel')),
  provider text not null,
  model text not null,
  effort text,
  assigned_at text not null,
  primary key (rig, role)
);
-- Rigs enrolled through control (thermite rig add, or the API): each token only as its SHA-256.
-- A rig in the rig tokens file needs no row. A retired rig's token stops working.
create table if not exists rig_token (
  rig text primary key,
  token_sha256 text not null,
  created_at text not null,
  created_by text not null,
  rotated_at text,
  retired_at text
);
-- Git access for private repositories (Settings): an SSH deploy key control made (its public
-- half shown, its private half sealed) or an HTTPS token (sealed). Rigs get one only for a
-- campaign assigned to them that names it.
create table if not exists git_access (
  name text primary key,
  kind text not null check (kind in ('ssh', 'token')),
  public_key text,
  fingerprint text,
  secret_sealed text not null,
  hint text not null,
  username text,
  created_at text not null,
  created_by text not null
);
-- Machines control sets rigs up on, over SSH: the key sealed, the host keys the owner trusted
-- (none until then), and what the last read-only check found.
create table if not exists machine (
  name text primary key,
  address text not null,
  port integer not null,
  user text not null,
  key_sealed text not null,
  public_key text not null,
  key_fingerprint text not null,
  host_keys text not null default '[]',
  seen_host_keys text not null default '[]',
  facts text,
  checked_at text,
  check_error text,
  created_at text not null,
  created_by text not null
);
-- Installs on a machine: each one approved by the owner for one recipe's exact script, used
-- once, before it expires; then its outcome.
create table if not exists machine_install (
  id integer primary key,
  machine text not null,
  recipe text not null,
  script_sha text not null,
  approved_by text not null,
  approved_at text not null,
  expires_at text not null,
  started_at text,
  finished_at text,
  ok integer,
  output text
);
-- Kubernetes clusters control sets rigs up on: the kubeconfig sealed, the context, how rigs are
-- placed (namespaces control creates, or slots the cluster's operators made), what the last check
-- found.
create table if not exists cluster (
  name text primary key,
  kubeconfig_sealed text not null,
  context text not null default '',
  placement text not null check (placement in ('created', 'slot')),
  namespace_pattern text not null default 'thermite-{rig}',
  slots text not null default '[]',
  facts text,
  checked_at text,
  check_error text,
  created_at text not null,
  created_by text not null
);
-- Rigs the owner joins themself (join.ts): where, and the join command's hash, expiry and use.
create table if not exists joined_rig (
  rig text primary key,
  form text not null check (form in ('machine', 'namespace')),
  spec text not null,
  join_sha256 text,
  join_expires_at text,
  join_used_at text,
  status text not null,
  created_at text not null,
  created_by text not null
);
-- GPU clouds (RunPod) control reads with the owner's key, sealed: what the last read found.
create table if not exists gpu_cloud (
  name text primary key,
  kind text not null check (kind in ('runpod')),
  key_sealed text not null,
  key_hint text not null,
  facts text,
  checked_at text,
  check_error text,
  created_at text not null,
  created_by text not null
);
-- Rigs the owner retired: they leave the lists and Needs you, and their reports are refused,
-- until brought back. Their records stay.
create table if not exists rig_retired (
  rig text primary key,
  at text not null,
  by text not null
);
-- Rigs control reaches through a public proxy (a RunPod pod): the pod, the tunnel's sealed
-- secrets, and the pod's keys once enrolled (docs/plan/goals/019-rig-only-entry.goal).
create table if not exists tunnel_rig (
  rig text primary key,
  pod text not null,
  url text not null,
  prefix_sealed text not null,
  box_private_sealed text not null,
  box_public text not null,
  code_sealed text not null,
  code_expires_at text not null,
  pod_sign_public text,
  pod_box_public text,
  enrolled_at text,
  last_exchange_at text,
  refused_total integer not null default 0,
  error text,
  created_at text not null,
  created_by text not null
);
-- Test pods control started on a GPU cloud: what was asked, the pod, and what it found.
create table if not exists runpod_test (
  id text primary key,
  cloud text not null,
  active integer not null,
  state text not null,
  created_at text not null,
  created_by text not null
);
-- Rigs control set up on a cluster: where, how, and how it stands.
create table if not exists cluster_rig (
  rig text primary key,
  cluster text not null,
  namespace text not null,
  placement text not null,
  spec text not null,
  status text not null,
  created_at text not null,
  created_by text not null
);
-- Rigs control set up on a machine: where, on which GPUs, with which images, and how it stands.
create table if not exists machine_rig (
  rig text primary key,
  machine text not null,
  gpus text not null default '[]',
  images text not null,
  root integer not null default 0,
  status text not null,
  created_at text not null,
  created_by text not null
);
-- Each step of setting a rig up or managing it, for the rig's history: what, whether it worked.
create table if not exists rig_setup_event (
  id integer primary key,
  rig text not null,
  at text not null,
  step text not null,
  ok integer not null,
  detail text
);
-- Campaigns created on control (the new-campaign page): each version's contract as approved,
-- with its content hash. Runs are assigned from a version.
create table if not exists campaign_version (
  campaign text not null,
  version integer not null,
  contract text not null,
  sha text not null,
  -- Where its runs fetch the project and the kit from (URLs and Git access names, no secrets).
  sources text not null default '{}',
  created_at text not null,
  created_by text not null,
  approved_by text,
  primary key (campaign, version)
);
create index if not exists rig_live_rig on rig_live (rig, id);
create index if not exists rig_live_source on rig_live (rig, source, id);
`;

/**
 * A store written before the 2026-10-15 rename (unit -> rig): its tables and columns are
 * renamed in place, and the old indexes dropped (the schema creates them under the new names).
 */
function renameUnitsToRigs(db: DatabaseSync): void {
  const tables = () =>
    (
      db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
  if (!tables().includes("unit")) return;
  db.exec("begin immediate");
  try {
    for (const name of ["unit", "unit_event", "unit_ledger", "unit_report", "unit_live"]) {
      if (tables().includes(name))
        db.exec(`alter table ${name} rename to ${name.replace(/^unit/, "rig")}`);
    }
    for (const name of tables()) {
      const cols = db.prepare(`pragma table_info(${name})`).all() as { name: string }[];
      if (cols.some((c) => c.name === "unit"))
        db.exec(`alter table ${name} rename column unit to rig`);
      if (cols.some((c) => c.name === "instance"))
        db.exec(`alter table ${name} rename column instance to run`);
    }
    const indexes = db
      .prepare("select name from sqlite_master where type = 'index' and name like 'unit%'")
      .all() as { name: string }[];
    for (const i of indexes) db.exec(`drop index if exists ${i.name}`);
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

export interface IngestReport {
  generated_at?: string | undefined;
  rig: string;
  ledger_id: string;
  cursor: number;
  next: number;
  events: {
    id: number;
    at: string;
    actor: string;
    kind: string;
    subject: string | null;
    body: unknown;
  }[];
  summary: unknown;
}

/**
 * A model provider's kind; "claude" is a Claude subscription (its token from `claude setup-token`),
 * "chatgpt" a ChatGPT subscription (its login from Sign in with ChatGPT, renewed by control).
 */
export type ProviderType = "openai" | "anthropic" | "opencode" | "claude" | "chatgpt";
/** Where a rig's agents run: Pi, OpenCode v2, or Claude Code (the only one a Claude subscription allows). */
export type Harness = "pi" | "opencode" | "claude-code";
/** How hard an agent's model thinks: Claude Code's levels (other providers take up to high). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** A rig's agents other than its workers, each of which may have its own model. */
export type AgentRole = "planner" | "teachers" | "combiner" | "auditor" | "panel";
export const AGENT_ROLES: AgentRole[] = ["planner", "teachers", "combiner", "auditor", "panel"];

/** A model in a provider's list: its id, and its context window when the provider says it. */
export interface ProviderModel {
  id: string;
  context_window?: number | undefined;
  /** Added by the owner by its name (the provider does not list it). */
  added?: boolean | undefined;
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

/** A rig behind a public proxy, as listed: never its sealed secrets. */
export interface TunnelRig {
  rig: string;
  pod: string;
  url: string;
  box_public: string;
  code_expires_at: string;
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
    pod: String(r.pod),
    url: String(r.url),
    prefix_sealed: String(r.prefix_sealed),
    box_private_sealed: String(r.box_private_sealed),
    box_public: String(r.box_public),
    code_sealed: String(r.code_sealed),
    code_expires_at: String(r.code_expires_at),
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
    images: { harness: string; supervisor: string };
  };
  status: string;
  created_at: string;
  created_by: string;
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

/** A rig's name: what the lifecycle drivers accept (a Kubernetes namespace part, a compose name). */
export const RIG_ID = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export class ControlStore {
  readonly db: DatabaseSync;
  private configuredRigs = new Set<string>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal;");
    renameUnitsToRigs(this.db);
    this.db.exec(SCHEMA);
    const cols = (this.db.prepare("pragma table_info(rig)").all() as Row[]).map((r) => r.name);
    if (!cols.includes("pubkey")) this.db.exec("alter table rig add column pubkey text");
    if (!cols.includes("pending_pubkey"))
      this.db.exec("alter table rig add column pending_pubkey text");
    if (!cols.includes("report_at")) this.db.exec("alter table rig add column report_at text");
    migrateModelRoutes(this.db);
    const versionCols = (this.db.prepare("pragma table_info(campaign_version)").all() as Row[]).map(
      (r) => r.name,
    );
    if (!versionCols.includes("sources"))
      this.db.exec("alter table campaign_version add column sources text not null default '{}'");
    const rigModelCols = (this.db.prepare("pragma table_info(rig_model)").all() as Row[]).map(
      (r) => r.name,
    );
    if (!rigModelCols.includes("harness"))
      this.db.exec("alter table rig_model add column harness text not null default 'pi'");
    if (!rigModelCols.includes("effort"))
      this.db.exec("alter table rig_model add column effort text");
    const machineRigCols = (this.db.prepare("pragma table_info(machine_rig)").all() as Row[]).map(
      (r) => r.name,
    );
    if (!machineRigCols.includes("judge_gpus"))
      this.db.exec("alter table machine_rig add column judge_gpus integer");
    if (!cols.includes("supervisor")) {
      this.db.exec("alter table rig add column supervisor text");
      this.db.exec("alter table rig add column supervisor_at text");
    }
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
   * newest `keep` lines of the rig.
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
      if (cut) this.db.prepare("delete from rig_live where rig = ? and id <= ?").run(rig, cut.id);
      return added;
    });
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
    if (this.openReset(rig)) throw new Error(`a reset of ${rig} is already in progress`);
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
           received_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // A harness's own record of a command it applied is authoritative (it is signed with the
      // rig's key); the supervisor's acknowledgement is only the fast path.
      const confirm = this.db.prepare(
        "update command set status = ?, outcome = ?, acked_at = coalesce(acked_at, ?) where id = ? and rig = ?",
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

  /** A rig's events in control's arrival order; `after` is a control `seq`, not an event id. */
  /** The rig's signed record that a champion was published: its sha256 and base commit. */
  publishedChampion(
    rig: string,
    run: string,
    seq: number,
  ): { sha256: string; base_commit: string; repo: string | null } | undefined {
    const r = this.db
      .prepare(
        `select body from rig_event where rig = ? and kind = 'champion_published' and subject = ?
           and json_extract(body, '$.seq') = ? order by seq desc limit 1`,
      )
      .get(rig, run, seq) as { body: string } | undefined;
    if (!r) return undefined;
    const b = JSON.parse(r.body) as { sha256?: string; base_commit?: string; repo?: string };
    return {
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
        `insert or ignore into champion_patch (rig, run, seq, sha256, base_commit, patch, received_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rig, run, seq, pub.sha256, pub.base_commit, patch, new Date().toISOString());
    return "stored";
  }

  championPatch(
    rig: string,
    run: string,
    seq: number,
  ): { patch: Buffer; sha256: string; base_commit: string } | undefined {
    const r = this.db
      .prepare(
        "select patch, sha256, base_commit from champion_patch where rig = ? and run = ? and seq = ?",
      )
      .get(rig, run, seq) as { patch: Uint8Array; sha256: string; base_commit: string } | undefined;
    return r
      ? { patch: Buffer.from(r.patch), sha256: r.sha256, base_commit: r.base_commit }
      : undefined;
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
   * settings.
   */
  assignRigModel(
    rig: string,
    choice: {
      provider: string;
      model: string;
      harness?: Harness | undefined;
      effort?: Effort | undefined;
    } | null,
  ): void {
    if (choice === null) {
      this.db.prepare("delete from rig_model where rig = ?").run(rig);
      return;
    }
    if (!this.provider(choice.provider)) throw new Error(`no model provider ${choice.provider}`);
    this.db
      .prepare(
        `insert into rig_model (rig, provider, model, harness, effort, assigned_at) values (?, ?, ?, ?, ?, ?)
         on conflict (rig) do update set provider = excluded.provider, model = excluded.model,
           harness = excluded.harness, effort = excluded.effort, assigned_at = excluded.assigned_at`,
      )
      .run(
        rig,
        choice.provider,
        choice.model,
        choice.harness ?? "pi",
        choice.effort ?? null,
        new Date().toISOString(),
      );
  }

  /** Gives one of a rig's other agents a model, or (null) has it follow the workers again. */
  assignRoleModel(
    rig: string,
    role: AgentRole,
    choice: { provider: string; model: string; effort?: Effort | undefined } | null,
  ): void {
    if (choice === null) {
      this.db.prepare("delete from rig_role_model where rig = ? and role = ?").run(rig, role);
      return;
    }
    if (!this.provider(choice.provider)) throw new Error(`no model provider ${choice.provider}`);
    this.db
      .prepare(
        `insert into rig_role_model (rig, role, provider, model, effort, assigned_at) values (?, ?, ?, ?, ?, ?)
         on conflict (rig, role) do update set provider = excluded.provider, model = excluded.model,
           effort = excluded.effort, assigned_at = excluded.assigned_at`,
      )
      .run(
        rig,
        role,
        choice.provider,
        choice.model,
        choice.effort ?? null,
        new Date().toISOString(),
      );
  }

  /** A rig's other agents' models, by role (roles with none are absent). */
  roleModels(
    rig: string,
  ): Partial<Record<AgentRole, { provider: string; model: string; effort: Effort | null }>> {
    const rows = this.db
      .prepare("select role, provider, model, effort from rig_role_model where rig = ?")
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
        },
      ]),
    );
  }

  /** Each rig's provider, model, harness and effort. */
  rigModels(): Record<
    string,
    { provider: string; model: string; harness: Harness; effort?: Effort | undefined }
  > {
    const rows = this.db
      .prepare("select rig, provider, model, harness, effort from rig_model")
      .all() as Row[];
    return Object.fromEntries(
      rows.map((r) => [
        String(r.rig),
        {
          provider: String(r.provider),
          model: String(r.model),
          harness:
            r.harness === "opencode" || r.harness === "claude-code"
              ? (r.harness as "opencode" | "claude-code")
              : ("pi" as const),
          ...(EFFORTS.includes(String(r.effort) as Effort)
            ? { effort: String(r.effort) as Effort }
            : {}),
        },
      ]),
    );
  }

  rigModelFor(
    rig: string,
  ):
    | { provider: ModelProvider; model: string; harness: Harness; effort?: Effort | undefined }
    | undefined {
    const c = this.rigModels()[rig];
    const provider = c ? this.provider(c.provider) : undefined;
    return c && provider
      ? { provider, model: c.model, harness: c.harness, effort: c.effort }
      : undefined;
  }

  events(rig: string, after: number, limit: number, ledgerId?: string | null): unknown[] {
    const byLedger = ledgerId ? " and ledger_id = ?" : "";
    return (
      this.db
        .prepare(
          `select seq, ledger_id, event_id, at, actor, kind, subject, body from rig_event
             where rig = ?${byLedger} and seq > ? order by seq limit ?`,
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

  // ---------------------------------------------------------------- rigs behind a proxy
  addTunnelRig(
    t: Omit<
      TunnelRig,
      | "pod_sign_public"
      | "pod_box_public"
      | "enrolled_at"
      | "last_exchange_at"
      | "refused_total"
      | "error"
      | "created_at"
    > & {
      prefix_sealed: string;
      box_private_sealed: string;
      code_sealed: string;
    },
  ): void {
    this.db
      .prepare(
        `insert into tunnel_rig (rig, pod, url, prefix_sealed, box_private_sealed, box_public,
           code_sealed, code_expires_at, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.rig,
        t.pod,
        t.url,
        t.prefix_sealed,
        t.box_private_sealed,
        t.box_public,
        t.code_sealed,
        t.code_expires_at,
        new Date().toISOString(),
        t.created_by,
      );
    this.audit(t.created_by, "tunnel_rig_added", { rig: t.rig, pod: t.pod, url: t.url });
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

  /** Pins the pod's keys; refused once pinned (a second enrollment). */
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

  setClusterRigStatus(rig: string, status: string): void {
    this.db.prepare("update cluster_rig set status = ? where rig = ?").run(status, rig);
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

  /** Stores a campaign version, approved by whoever created it, with where its runs fetch from. */
  putCampaign(c: {
    campaign: string;
    version: number;
    contract: unknown;
    sha: string;
    sources?: CampaignSources | undefined;
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into campaign_version (campaign, version, contract, sha, sources, created_at, created_by, approved_by)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    }));
  }

  /**
   * A run name for a campaign's next run on a rig: the campaign's name and the next number not
   * yet used there (from the rig's reports and from assignments still on their way).
   */
  nextRunName(rig: string, campaign: string): string {
    const base = campaign.slice(0, 58);
    const taken = new Set<string>();
    const created = this.db
      .prepare("select distinct subject from rig_event where rig = ? and kind = 'run_created'")
      .all(rig) as { subject: string | null }[];
    for (const r of created) if (r.subject) taken.add(r.subject);
    const assigned = this.db
      .prepare("select signed from command where rig = ? and kind = 'assign_campaign'")
      .all(rig) as { signed: string }[];
    for (const c of assigned) {
      try {
        const run = (JSON.parse(c.signed) as { envelope?: { payload?: { run?: string } } }).envelope
          ?.payload?.run;
        if (run) taken.add(run);
      } catch {
        // not a command this store wrote
      }
    }
    for (let n = 1; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
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
  listAudit(
    limit = 200,
    filter: { action?: string | undefined; mcp?: boolean | undefined } = {},
  ): { at: string; actor: string; action: string; body: unknown }[] {
    return (
      this.db
        .prepare(
          `select at, actor, action, body from audit
           where (? or action not like 'mcp:%') and instr(action, ?) > 0
           order by id desc limit ?`,
        )
        .all(filter.mcp === false ? 0 : 1, filter.action ?? "", limit) as Row[]
    ).map((r) => ({
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      body: JSON.parse(String(r.body)),
    }));
  }

  command(id: string): { status: string; outcome: unknown } | undefined {
    const r = this.db.prepare("select status, outcome from command where id = ?").get(id) as
      | Row
      | undefined;
    return r
      ? { status: String(r.status), outcome: r.outcome ? JSON.parse(String(r.outcome)) : null }
      : undefined;
  }
}

/** A short fingerprint of a public key, for the dashboard and the audit log. */
export function fingerprint(pubkeyPem: string): string {
  return sha256Hex(pubkeyPem.trim()).slice(0, 16);
}

/**
 * The settings page's first version stored one route per model (model_route, rig_model_route).
 * Each becomes a provider of type openai with that model, and its rigs keep their model.
 */
function migrateModelRoutes(db: DatabaseSync): void {
  const has = (t: string) =>
    db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
  if (!has("model_route")) return;
  const now = new Date().toISOString();
  const routes = db.prepare("select * from model_route").all() as Row[];
  for (const r of routes)
    db.prepare(
      `insert or ignore into model_provider (name, type, base_url, key_sealed, key_hint, version, updated_at, models)
       values (?, 'openai', ?, ?, ?, 1, ?, ?)`,
    ).run(
      String(r.name),
      String(r.base_url),
      String(r.key_sealed),
      String(r.key_hint),
      now,
      JSON.stringify([{ id: String(r.model), added: true }]),
    );
  if (has("rig_model_route")) {
    const given = db.prepare("select * from rig_model_route").all() as Row[];
    for (const g of given) {
      const route = routes.find((r) => r.name === g.route);
      if (route)
        db.prepare(
          "insert or ignore into rig_model (rig, provider, model, assigned_at) values (?, ?, ?, ?)",
        ).run(String(g.rig), String(route.name), String(route.model), now);
    }
    db.exec("drop table rig_model_route");
  }
  db.exec("drop table model_route");
}
