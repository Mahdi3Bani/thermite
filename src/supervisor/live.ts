import { LiveLog } from "../core/live.ts";

/**
 * The live relay: every few seconds, the harness's newest live-log lines (signed by the harness)
 * go to control, with the supervisor's own lines (its advisors; unsigned, and labelled so). The
 * supervisor passes the harness's batch through untouched: it cannot sign for the harness.
 */
export interface LiveRelayConfig {
  unit: string;
  harnessUrl: string;
  harnessToken: string;
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface LiveRelayState {
  logId?: string | undefined;
  cursor: number;
  /** The supervisor's own lines already sent. */
  ownCursor: number;
}

/** The supervisor's own live lines (its advisors), relayed unsigned. */
export const supervisorLive = new LiveLog({ max: 1000 });

export async function relayLiveOnce(
  cfg: LiveRelayConfig,
  state: LiveRelayState,
): Promise<LiveRelayState> {
  const f = cfg.fetchImpl ?? fetch;
  if (!cfg.controlUrl || !cfg.controlToken) return state;
  const get = async (after: number) => {
    const res = await f(`${cfg.harnessUrl}/v1/live?after=${after}&limit=500`, {
      headers: { authorization: `Bearer ${cfg.harnessToken}` },
    });
    if (!res.ok) throw new Error(`live -> ${res.status}`);
    return (await res.json()) as { log_id: string; next: number; entries: unknown[] };
  };
  let cursor = state.cursor;
  let batch = await get(cursor);
  if (state.logId !== undefined && batch.log_id !== state.logId && cursor !== 0) {
    // The controller restarted: its live log started again.
    cursor = 0;
    batch = await get(0);
  }
  const own = supervisorLive.since(state.ownCursor, 200);
  if (!batch.entries.length && !own.entries.length && batch.log_id === state.logId) return state;
  const res = await f(`${cfg.controlUrl}/v1/units/${encodeURIComponent(cfg.unit)}/live`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      batch,
      supervisor: { log_id: supervisorLive.id, entries: own.entries },
    }),
  });
  if (!res.ok)
    throw new Error(`control live -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { logId: batch.log_id, cursor: batch.next, ownCursor: own.next };
}
