/**
 * Model downloads in the rig's history: control compares each supervisor report's downloads with
 * the one before, and writes a step when one starts and when it ends (downloaded and checked,
 * refused for a wrong SHA-256, or stopped). The supervisor's report is not signed: these steps say
 * what it reported. Only the harness's import of the file, which checks the SHA-256 again, counts.
 */

export interface ModelFigure {
  name: string;
  path: string;
  sha256: string;
  from: string;
  state: "downloading" | "done" | "refused" | "failed";
  bytes: number;
  total: number | null;
  started_at: string;
  error?: string | undefined;
}

export interface ModelStep {
  step: "model_started" | "model_done" | "model_refused" | "model_failed";
  ok: boolean;
  detail: string;
}

/** A size in plain words: "16.1 GB", "512 MB". */
function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${bytes} bytes`;
}

/** The steps between two reports' downloads (`before` as stored: unchecked). */
export function modelSteps(before: unknown, after: ModelFigure[] | undefined): ModelStep[] {
  const prev = Array.isArray(before) ? (before as Partial<ModelFigure>[]) : [];
  const steps: ModelStep[] = [];
  for (const m of [...(after ?? [])].reverse()) {
    const had = prev.find((p) => p.path === m.path && p.started_at === m.started_at);
    if (!had)
      steps.push({
        step: "model_started",
        ok: true,
        detail: `${m.name} from ${m.from}${m.total !== null ? `, ${size(m.total)}` : ""}`,
      });
    if ((had?.state ?? "downloading") !== "downloading" || m.state === "downloading") continue;
    if (m.state === "done")
      steps.push({ step: "model_done", ok: true, detail: `${m.name}: ${size(m.bytes)}` });
    else
      steps.push({
        step: m.state === "refused" ? "model_refused" : "model_failed",
        ok: false,
        detail: `${m.name}: ${m.error ?? "no reason given"}`.slice(0, 600),
      });
  }
  return steps;
}
