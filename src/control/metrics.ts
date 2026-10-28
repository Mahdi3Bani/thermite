import type { ControlStore } from "./store.ts";
import { currentChampion } from "./views/facts.ts";
import { rigView } from "./views.ts";

/**
 * Prometheus text exposition of control's view. Bounded series only: labelled by rig,
 * campaign, run, verdict or job state, never by attempt or experiment id.
 */
export function metricsText(store: ControlStore, staleAfterMs: number, now = Date.now()): string {
  const lines: string[] = [];
  const help = (name: string, type: string, text: string) =>
    lines.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
  const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  const views = store.reportedRigs
    .list()
    .map((u) => rigView(store, u.id, { staleAfterMs, now }))
    .filter((v) => v !== undefined);

  help("thermite_rig_up", "gauge", "1 when the rig reported within the stale window");
  for (const u of views) lines.push(`thermite_rig_up{rig="${label(u.id)}"} ${u.stale ? 0 : 1}`);
  help("thermite_rig_report_age_seconds", "gauge", "Seconds since the rig's last report");
  for (const u of views) {
    lines.push(
      `thermite_rig_report_age_seconds{rig="${label(u.id)}"} ${Math.max(0, (now - Date.parse(u.last_seen)) / 1000).toFixed(0)}`,
    );
  }
  help("thermite_rig_jobs", "gauge", "Judge jobs by state");
  for (const u of views) {
    for (const [state, n] of Object.entries(u.jobs)) {
      lines.push(
        `thermite_rig_jobs{rig="${label(u.id)}",state="${label(state)}"} ${Number(n) || 0}`,
      );
    }
  }
  help("thermite_run_champion_seq", "gauge", "Current champion sequence number");
  help(
    "thermite_run_champion_gain",
    "gauge",
    "Champion's relative gain over the campaign baseline",
  );
  help("thermite_run_attempts", "gauge", "Attempts by verdict (or lifecycle when not judged)");
  for (const u of views) {
    for (const i of u.runs) {
      const l = `rig="${label(u.id)}",run="${label(i.id)}",campaign="${label(i.campaign ?? "")}"`;
      const champ = currentChampion(i);
      lines.push(`thermite_run_champion_seq{${l}} ${champ?.seq ?? 1}`);
      lines.push(`thermite_run_champion_gain{${l}} ${((champ?.cumulative ?? 1) - 1).toFixed(6)}`);
      for (const [verdict, n] of Object.entries(i.verdicts)) {
        lines.push(`thermite_run_attempts{${l},verdict="${label(verdict)}"} ${n}`);
      }
      const ag = i.agents;
      // Only rounds a planner could plan: a research run's are set by its research plan (goal 079).
      const planned = ag.epochs - ag.research_rounds;
      if (planned > 0) {
        lines.push(`thermite_planner_valid_ratio{${l}} ${(ag.planner_valid / planned).toFixed(4)}`);
        lines.push(`thermite_planner_fallback_ratio{${l}} ${(ag.fallbacks / planned).toFixed(4)}`);
      }
      if (ag.attempts) {
        lines.push(`thermite_duplicate_ratio{${l}} ${(ag.duplicates / ag.attempts).toFixed(4)}`);
      }
      lines.push(`thermite_trials_total{${l}} ${ag.trials}`);
      lines.push(`thermite_tokens_total{${l},direction="in"} ${ag.tokens_in}`);
      lines.push(`thermite_tokens_total{${l},direction="out"} ${ag.tokens_out}`);
      if (i.research) {
        for (const k of ["sources", "domains", "verified", "drafts", "hypotheses"]) {
          lines.push(`thermite_research_${k}{${l}} ${Number(i.research[k] ?? 0)}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
