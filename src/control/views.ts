/**
 * Control's read model: what the dashboard, the API and MCP show. It is computed from the
 * events rigs reported (the harness ledger is the source of truth; control only mirrors it),
 * so it is the same after any restart of control, a supervisor or a harness.
 *
 * Its parts are in views/: the view's types, the fold of a rig's events (fold/, one module for
 * each area of events), the read of a rig's view (rig.ts) with what the rig's report says
 * (report.ts), the folds control keeps up to date as events arrive (cache.ts), and the views
 * made from rigs' views: the leaderboard, the campaigns and a run's directions.
 */

export { FoldCache, keepFolds, rigView } from "./views/cache.ts";
export { type CampaignView, campaignModes, campaignViews, newestRun } from "./views/campaigns.ts";
export { runDirections } from "./views/directions.ts";
export { championsInForce, currentChampion, runCampaign } from "./views/facts.ts";
export { foldCheck, type RigCheckView } from "./views/fold/checks.ts";
export { type LeaderEntry, leaderboard } from "./views/leaderboard.ts";
export {
  OFFLINE_AFTER_MS,
  type ReportingState,
  type RigModelView,
  type RigSettingsView,
  readModelInfo,
  reportingState,
  rigSettingsOf,
} from "./views/report.ts";
export { podStopped, rigEvents } from "./views/rig.ts";
export type {
  AttemptView,
  BaselineView,
  CardView,
  ChampionHeldOutView,
  ChampionStep,
  DirectionView,
  ExperimentView,
  HeldOutView,
  JournalNoteView,
  JudgeJob,
  MessageView,
  RigView,
  RunView,
  SetupView,
  StoredEvent,
} from "./views/types.ts";
