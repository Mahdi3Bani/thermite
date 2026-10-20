import { KbSync } from "../core/kb.ts";

/**
 * Past research for each running run (goal 065). Control keeps Thermite's knowledge base: a
 * folder for each campaign, and which folders a campaign may read. The supervisor asks control,
 * with its rig's token, for the items of the folders a running run's campaign may read, after the
 * run's cursor, and hands them to its harness with the list of those folders. The harness writes
 * the items into the run's research folder under knowledge/, and removes a folder no longer on
 * the list (a revoked grant). The cursor of each run is kept in the supervisor's state; pages are
 * fetched while control says more wait. Control replays a newly granted folder's items with new
 * seqs, so a grant needs nothing special here. The harness never reaches control itself.
 *
 * Without control (no URL or token), nothing happens.
 */

export interface KbSyncConfig {
  rig: string;
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
  /** The most JSON posted to the harness in one request, in bytes (8 MiB by default). */
  batchBytes?: number | undefined;
}

export interface KbSyncState {
  /** Per run, the last item's seq it was given (control's cursor). */
  cursors: Record<string, number>;
}

export function emptyKbSyncState(): KbSyncState {
  return { cursors: {} };
}

export interface KbSyncResult {
  state: KbSyncState;
  /** Items handed to the harness in this call. */
  items: number;
  /** What went wrong, per run, in words (the other runs went on). */
  errors: string[];
}

export async function syncKnowledgeOnce(
  cfg: KbSyncConfig,
  state: KbSyncState,
): Promise<KbSyncResult> {
  const out: KbSyncResult = { state: { cursors: { ...state.cursors } }, items: 0, errors: [] };
  if (!cfg.controlUrl || !cfg.controlToken) return out;
  const f = cfg.fetchImpl ?? fetch;
  const harness = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${cfg.harnessUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.harnessToken}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`the harness's ${path}: HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  };
  const { runs } = (await harness("GET", "/v1/runs")) as {
    runs: { id: string; status: string }[];
  };
  const maxBytes = cfg.batchBytes ?? 8 * 1024 * 1024;
  for (const run of runs.filter((r) => r.status === "running")) {
    try {
      for (;;) {
        const after = out.state.cursors[run.id] ?? 0;
        const res = await f(
          `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/kb?run=${encodeURIComponent(run.id)}&after=${after}`,
          { headers: { authorization: `Bearer ${cfg.controlToken}` } },
        );
        if (!res.ok) throw new Error(`control's knowledge base: HTTP ${res.status}`);
        const page = KbSync.parse(await res.json());
        // Posted in batches the harness takes in one request each; the cursor moves only when
        // every item of the page reached the harness. Each post says which folders the run may
        // read now, so the harness removes a folder whose grant was revoked: a page with no
        // items is posted too, for that.
        let batch: unknown[] = [];
        let bytes = 0;
        const post = async (always = false) => {
          if (!batch.length && !always) return;
          await harness("POST", "/v1/kb", { run: run.id, items: batch, folders: page.folders });
          out.items += batch.length;
          batch = [];
          bytes = 0;
        };
        for (const item of page.items) {
          const size = JSON.stringify(item).length;
          if (batch.length && bytes + size > maxBytes) await post();
          batch.push(item);
          bytes += size;
        }
        await post(page.items.length === 0);
        out.state.cursors[run.id] = Math.max(after, page.next);
        if (!page.more) break;
        if (page.next <= after)
          throw new Error(`control said more items wait after ${after}, but gave none`);
      }
    } catch (err) {
      out.errors.push(`${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
