import type { AdviseState } from "./advise.ts";
import type { UploadState } from "./export-upload.ts";
import type { ExportState } from "./git-export.ts";

/**
 * The daily rig report to control: a short Markdown summary built from the harness's briefs
 * (deterministic, ledger-derived) and the supervisor's own records. No model writes it.
 */
export async function dailyReport(input: {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  exportState: ExportState;
  /** For a rig that sends its exports to control (it has no results repository). */
  uploadState?: UploadState | undefined;
  adviseState: AdviseState;
  fetchImpl?: typeof fetch | undefined;
}): Promise<string> {
  const f = input.fetchImpl ?? fetch;
  const get = async (path: string) => {
    const res = await f(`${input.harnessUrl}${path}`, {
      headers: { authorization: `Bearer ${input.harnessToken}` },
    });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  const { runs } = (await get("/v1/runs")) as {
    runs: { id: string; campaign: string; mode: string; status: string }[];
  };
  const lines = [`# Daily report: ${input.rig}`, "", `Generated ${new Date().toISOString()}.`, ""];
  for (const inst of runs.filter((i) => i.status !== "closed")) {
    const b = (await get(`/v1/brief?run=${encodeURIComponent(inst.id)}`)) as {
      champion: { seq: number };
      families: { id: string; status: string; attempts: number; best_delta: number | null }[];
      evidence: { verdict: string | null; lifecycle: string }[];
      epochs: { n: number; planner_valid: boolean }[];
      directives: unknown[];
      goals?: { id: string; status: string }[];
      budget: { device_hours_used: number; tokens: { in: number; out: number } };
    };
    const verdicts: Record<string, number> = {};
    for (const e of b.evidence) {
      const k = e.verdict ?? e.lifecycle;
      verdicts[k] = (verdicts[k] ?? 0) + 1;
    }
    lines.push(
      `## ${inst.id} (${inst.campaign}, ${inst.mode}, ${inst.status})`,
      "",
      `- Champion: seq ${b.champion.seq}.`,
      `- Recent verdicts (last ${b.evidence.length} attempts): ${
        Object.entries(verdicts)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ") || "none"
      }.`,
      `- Epochs: ${b.epochs.length ? `${b.epochs[0]?.n} so far; planner valid in ${b.epochs.filter((e) => e.planner_valid).length} of the last ${b.epochs.length}` : "none yet"}.`,
      `- Directions: ${b.families.map((x) => `${x.id} (${x.status}, ${x.attempts} attempts)`).join("; ") || "none"}.`,
      `- Directives in force: ${b.directives.length}.`,
      ...(b.goals ? [`- Goals: ${b.goals.map((g) => `${g.id} ${g.status}`).join(", ")}.`] : []),
      `- Device hours used: ${b.budget.device_hours_used.toFixed(2)}; agent tokens: ${b.budget.tokens.in} in, ${b.budget.tokens.out} out.`,
      "",
    );
  }
  const a = input.adviseState.stats;
  const e = input.exportState;
  const u = input.uploadState;
  const error = (u?.lastError ?? e.lastError) || undefined;
  lines.push(
    "## Supervisor",
    "",
    `- Exports: ${e.done.length} committed; ${u ? `${u.uploaded.length ? `last sent to control ${u.lastUploadAt ?? "?"}` : "none sent to control yet"}; ${u.queue.length} waiting to go` : `last push ${e.lastPushAt ?? "never"}`}${error ? `; last error: ${error}` : ""}.`,
    `- Advisors: ${a.teacher_runs} teacher rounds, ${a.directive_sets} directive sets (${a.directives} directives), ${a.audits} audits, ${a.reviews} panel reviews, ${a.errors} errors; $${a.usd.toFixed(2)}.`,
  );
  return lines.join("\n");
}
