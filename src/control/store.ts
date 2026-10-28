import type { DatabaseSync } from "node:sqlite";
import { openDatabase, transaction } from "../common/sqlite.ts";
import {
  EFFORTS,
  type Effort,
  HARNESSES,
  type Harness,
  type ProviderType,
} from "../core/agents.ts";
import { RIG_ID } from "../core/ids.ts";
import { CampaignArchive } from "./store/archive.ts";
import { AuditLog } from "./store/audit.ts";
import { Builds } from "./store/builds.ts";
import { BusKeys } from "./store/bus.ts";
import { CampaignVersions } from "./store/campaigns.ts";
import { ChampionPatches } from "./store/champions.ts";
import { Clusters } from "./store/clusters.ts";
import { IssuedCommands } from "./store/commands.ts";
import { Enrollments } from "./store/enrollments.ts";
import { RigEvents } from "./store/events.ts";
import { RigExports } from "./store/exports.ts";
import { CampaignFolders } from "./store/folders.ts";
import { GitAccessStore } from "./store/git-access.ts";
import { GpuClouds } from "./store/gpu-clouds.ts";
import { RigHistory } from "./store/history.ts";
import { JoinedRigs } from "./store/joined.ts";
import { KnowledgeBase } from "./store/kb.ts";
import { fingerprint } from "./store/keys.ts";
import { LiveLines } from "./store/live.ts";
import { Machines } from "./store/machines.ts";
import { McpServerRows } from "./store/mcp-servers.ts";
import { ModelAssignments } from "./store/models.ts";
import { ModelProviders } from "./store/providers.ts";
import { RigRefusals } from "./store/refusals.ts";
import type { IngestReport } from "./store/report.ts";
import { FullResets } from "./store/resets.ts";
import { RetiredRigs } from "./store/retired.ts";
import { RigReports } from "./store/rig-reports.ts";
import { ReportedRigs } from "./store/rigs.ts";
import { RunpodStore } from "./store/runpod.ts";
import { RunRegistry } from "./store/runs.ts";
import { migrateStore } from "./store/schema.ts";
import { UiSessions } from "./store/sessions.ts";
import { TunnelRigs } from "./store/tunnels.ts";
import { RigUpdates } from "./store/updates.ts";
import { UsageRecords } from "./store/usage.ts";

/**
 * Control's store: rigs, the events they report, and command queues. A single control process
 * owns it. Ingest is idempotent: re-sent events (same rig and event id) are ignored.
 *
 * Its tables are kept by sub-stores, one for each domain (goal 125, T6), in store/: each owns its
 * tables' SQL, and no other production code reads or writes them.
 */

export { cursorOf } from "./store/audit.ts";
export type { RigComponent, StoredBuild } from "./store/builds.ts";
export type { CampaignSources, CopiedFrom } from "./store/campaigns.ts";
export type {
  Cluster,
  ClusterRig,
  ClusterRigResize,
  ClusterRigSize,
} from "./store/clusters.ts";
export type { CommandRow, Decision } from "./store/commands.ts";
export type { RigExport } from "./store/exports.ts";
export type { GitAccess } from "./store/git-access.ts";
export type { JoinedRig } from "./store/joined.ts";
export { OPEN_TRIAL_LINES } from "./store/live.ts";
export type { Machine, MachineRig } from "./store/machines.ts";
export { AGENT_ROLES, type AgentRole, codexTakes, harnessOf } from "./store/models.ts";
export type { ModelProvider, ProviderModel } from "./store/providers.ts";
export type { RigRefusal } from "./store/refusals.ts";
export type { StoredRunpodRig, StoredRunpodTest } from "./store/runpod.ts";
export type { TunnelRig } from "./store/tunnels.ts";
export type { IngestReport };
export { EFFORTS, type Effort, fingerprint, HARNESSES, type Harness, type ProviderType, RIG_ID };

export class ControlStore {
  readonly db: DatabaseSync;
  // One sub-store for each domain, each over this database (goal 125, T6).
  /** The rigs as they report: their rows, report-signing keys and supervisors' figures. */
  readonly reportedRigs: ReportedRigs;
  /** The events rigs reported, and ingest, which takes a report. */
  readonly rigEvents: RigEvents;
  readonly liveLines: LiveLines;
  readonly rigReports: RigReports;
  readonly fullResets: FullResets;
  readonly uiSessions: UiSessions;
  readonly auditLog: AuditLog;
  readonly championPatches: ChampionPatches;
  readonly exports: RigExports;
  readonly modelProviders: ModelProviders;
  readonly agentModels: ModelAssignments;
  readonly usage: UsageRecords;
  readonly commands: IssuedCommands;
  readonly runRegistry: RunRegistry;
  readonly gitAccess: GitAccessStore;
  readonly machines: Machines;
  readonly rigHistory: RigHistory;
  readonly joinedRigs: JoinedRigs;
  readonly gpuClouds: GpuClouds;
  readonly retired: RetiredRigs;
  readonly builds: Builds;
  readonly refusals: RigRefusals;
  readonly tunnels: TunnelRigs;
  readonly runpod: RunpodStore;
  readonly clusters: Clusters;
  readonly campaigns: CampaignVersions;
  readonly folders: CampaignFolders;
  readonly archive: CampaignArchive;
  readonly enrollments: Enrollments;
  readonly busKeys: BusKeys;
  readonly rigUpdates: RigUpdates;
  readonly mcpServers: McpServerRows;
  private knowledge: KnowledgeBase | undefined;

  constructor(path: string) {
    this.db = openDatabase(path);
    migrateStore(this.db, path);
    // Each sub-store holds the store and its database, and calls no other while it is built.
    this.reportedRigs = new ReportedRigs(this, this.db);
    this.rigEvents = new RigEvents(this, this.db);
    this.liveLines = new LiveLines(this, this.db);
    this.rigReports = new RigReports(this, this.db);
    this.fullResets = new FullResets(this, this.db);
    this.uiSessions = new UiSessions(this, this.db);
    this.auditLog = new AuditLog(this, this.db);
    this.championPatches = new ChampionPatches(this, this.db);
    this.exports = new RigExports(this, this.db);
    this.modelProviders = new ModelProviders(this, this.db);
    this.agentModels = new ModelAssignments(this, this.db);
    this.usage = new UsageRecords(this, this.db);
    this.commands = new IssuedCommands(this, this.db);
    this.runRegistry = new RunRegistry(this, this.db);
    this.gitAccess = new GitAccessStore(this, this.db);
    this.machines = new Machines(this, this.db);
    this.rigHistory = new RigHistory(this, this.db);
    this.joinedRigs = new JoinedRigs(this, this.db);
    this.gpuClouds = new GpuClouds(this, this.db);
    this.retired = new RetiredRigs(this, this.db);
    this.builds = new Builds(this, this.db);
    this.refusals = new RigRefusals(this, this.db);
    this.tunnels = new TunnelRigs(this, this.db);
    this.runpod = new RunpodStore(this, this.db);
    this.clusters = new Clusters(this, this.db);
    this.campaigns = new CampaignVersions(this, this.db);
    this.folders = new CampaignFolders(this, this.db);
    this.archive = new CampaignArchive(this, this.db);
    this.enrollments = new Enrollments(this, this.db);
    this.busKeys = new BusKeys(this, this.db);
    this.rigUpdates = new RigUpdates(this, this.db);
    this.mcpServers = new McpServerRows(this, this.db);
  }

  /**
   * Runs fn in one transaction: all of it is kept, or none of it. Nested calls become savepoints
   * of the outer one. For writes to more than one sub-store that stand or fall together.
   */
  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  /**
   * Thermite's own knowledge base (goal 065), brought up to date with every event reported so
   * far. Its cursor is kept in this store, so it carries on after a restart of control. It makes
   * its tables on first use.
   */
  kb(): KnowledgeBase {
    this.knowledge ??= new KnowledgeBase(this.db);
    this.knowledge.catchUp();
    return this.knowledge;
  }
}
