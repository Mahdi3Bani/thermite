import { type BusView, busState } from "./bus/index.ts";
import type { ControlStore } from "./store/index.ts";
import { currentChampion, rigView } from "./views/index.ts";

/** A label's value as Prometheus's text format takes it. */
const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

/**
 * Prometheus text exposition of control's view. Bounded series only: labelled by rig,
 * campaign, run, verdict or job state, never by attempt or experiment id.
 */
export function metricsText(store: ControlStore, staleAfterMs: number, now = Date.now()): string {
  const lines: string[] = [];
  const help = (name: string, type: string, text: string) =>
    lines.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
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

/**
 * The message bus's series, with the bus on (goal 168): whether control reached its server, each
 * stream's messages and bytes and each consumer's backlog, and the live stream's lines: those
 * control took and refused, and those each rig's supervisor published and dropped. Bounded: by
 * stream, consumer (one for each rig at most), rig, and the fixed reasons for a refusal. Empty
 * with the bus off.
 */
export async function busMetricsText(
  store: ControlStore,
  view: BusView | undefined,
): Promise<string> {
  const state = await busState(store, view);
  if (!state.on) return "";
  const lines: string[] = [];
  const help = (name: string, type: string, text: string) =>
    lines.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
  help("thermite_bus_up", "gauge", "1 when control reached the message bus's server just now");
  lines.push(`thermite_bus_up ${state.reachable ? 1 : 0}`);
  help("thermite_bus_stream_messages", "gauge", "Messages the stream keeps");
  for (const st of state.streams)
    lines.push(`thermite_bus_stream_messages{stream="${label(st.name)}"} ${st.messages}`);
  help("thermite_bus_stream_bytes", "gauge", "Bytes the stream keeps");
  for (const st of state.streams)
    lines.push(`thermite_bus_stream_bytes{stream="${label(st.name)}"} ${st.bytes}`);
  help("thermite_bus_consumer_pending", "gauge", "Messages the consumer has not been handed yet");
  help("thermite_bus_consumer_ack_pending", "gauge", "Messages the consumer was handed, not acked");
  for (const st of state.streams)
    for (const c of st.consumers) {
      const l = `stream="${label(st.name)}",consumer="${label(c.name)}"`;
      lines.push(`thermite_bus_consumer_pending{${l}} ${c.pending}`);
      lines.push(`thermite_bus_consumer_ack_pending{${l}} ${c.ack_pending}`);
    }
  const live = state.live;
  help("thermite_live_lines_taken_total", "counter", "Live lines control added from the bus");
  for (const r of live.rigs)
    lines.push(`thermite_live_lines_taken_total{rig="${label(r.rig)}"} ${r.taken}`);
  help("thermite_live_lines_left_out_total", "counter", "Live lines control left out of a message");
  lines.push(`thermite_live_lines_left_out_total ${live.taken.left_out}`);
  help("thermite_live_messages_refused_total", "counter", "Live messages control refused, by why");
  for (const [why, n] of Object.entries(live.taken.refused))
    lines.push(`thermite_live_messages_refused_total{reason="${label(why)}"} ${n}`);
  help("thermite_live_lines_published_total", "counter", "Live lines a rig's supervisor published");
  help("thermite_live_lines_dropped_total", "counter", "Live lines a rig's supervisor dropped");
  for (const r of live.rigs) {
    if (!r.supervisor) continue;
    lines.push(
      `thermite_live_lines_published_total{rig="${label(r.rig)}"} ${r.supervisor.published}`,
    );
    lines.push(`thermite_live_lines_dropped_total{rig="${label(r.rig)}"} ${r.supervisor.dropped}`);
  }
  return `${lines.join("\n")}\n`;
}
