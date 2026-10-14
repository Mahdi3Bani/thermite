import type { ControlStore } from "./store.ts";
import { unitView } from "./views.ts";

/**
 * Prometheus text exposition of control's view. Bounded series only: labelled by unit,
 * campaign, instance, verdict or job state, never by attempt or experiment id.
 */
export function metricsText(store: ControlStore, staleAfterMs: number, now = Date.now()): string {
  const lines: string[] = [];
  const help = (name: string, type: string, text: string) =>
    lines.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
  const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  const views = store
    .units()
    .map((u) => unitView(store, u.id, { staleAfterMs, now }))
    .filter((v) => v !== undefined);

  help("thermite_unit_up", "gauge", "1 when the unit reported within the stale window");
  for (const u of views) lines.push(`thermite_unit_up{unit="${label(u.id)}"} ${u.stale ? 0 : 1}`);
  help("thermite_unit_report_age_seconds", "gauge", "Seconds since the unit's last report");
  for (const u of views) {
    lines.push(
      `thermite_unit_report_age_seconds{unit="${label(u.id)}"} ${Math.max(0, (now - Date.parse(u.last_seen)) / 1000).toFixed(0)}`,
    );
  }
  help("thermite_unit_jobs", "gauge", "Judge jobs by state");
  for (const u of views) {
    for (const [state, n] of Object.entries(u.jobs)) {
      lines.push(`thermite_unit_jobs{unit="${label(u.id)}",state="${label(state)}"} ${n}`);
    }
  }
  help("thermite_instance_champion_seq", "gauge", "Current champion sequence number");
  help(
    "thermite_instance_champion_gain",
    "gauge",
    "Champion's relative gain over the campaign baseline",
  );
  help("thermite_instance_attempts", "gauge", "Attempts by verdict (or lifecycle when not judged)");
  for (const u of views) {
    for (const i of u.instances) {
      const l = `unit="${label(u.id)}",instance="${label(i.id)}",campaign="${label(i.campaign ?? "")}"`;
      const champ = i.champion.filter((c) => !c.reopened).at(-1);
      lines.push(`thermite_instance_champion_seq{${l}} ${champ?.seq ?? 1}`);
      lines.push(
        `thermite_instance_champion_gain{${l}} ${((champ?.cumulative ?? 1) - 1).toFixed(6)}`,
      );
      for (const [verdict, n] of Object.entries(i.verdicts)) {
        lines.push(`thermite_instance_attempts{${l},verdict="${label(verdict)}"} ${n}`);
      }
      const ag = i.agents;
      if (ag.epochs) {
        lines.push(
          `thermite_planner_valid_ratio{${l}} ${(ag.planner_valid / ag.epochs).toFixed(4)}`,
        );
        lines.push(
          `thermite_planner_fallback_ratio{${l}} ${(ag.fallbacks / ag.epochs).toFixed(4)}`,
        );
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
