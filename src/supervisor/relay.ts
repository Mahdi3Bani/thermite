import { log } from "../common/env.ts";
import type { SignedCommand } from "../core/commands.ts";

/**
 * The supervisor's deterministic relay: report the harness's new events to control, then relay
 * control's pending signed commands to the harness and acknowledge each outcome. It never
 * creates or alters commands; it has no signing key.
 */
export interface RelayConfig {
  unit: string;
  harnessUrl: string;
  harnessToken: string;
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Makes a command's content available first (propagation); "wait" holds it for a later round. */
  stage?: ((cmd: SignedCommand) => Promise<"ready" | "wait">) | undefined;
  /** Told about each relayed command's outcome (a full reset's wipe acts on it). */
  onDelivered?: ((kind: string, accepted: boolean) => void) | undefined;
}

export interface RelayState {
  cursor: number;
  /** The harness ledger the cursor belongs to. A new ledger id means start again at 0. */
  ledgerId?: string | undefined;
}

async function call(
  f: typeof fetch,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await f(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok && res.status !== 403)
    throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return Object.assign(body as object, { __status: res.status });
}

/** One relay round. Returns the new state; the cursor advances only after control accepted the events. */
export async function relayOnce(cfg: RelayConfig, state: RelayState): Promise<RelayState> {
  const f = cfg.fetchImpl ?? fetch;
  let cursor = state.cursor;
  let ledgerId = state.ledgerId;
  for (;;) {
    let snap = (await call(
      f,
      `${cfg.harnessUrl}/v1/snapshot?cursor=${cursor}&limit=1000`,
      cfg.harnessToken,
    )) as {
      ledger_id: string;
      next: number;
      events: unknown[];
      summary: unknown;
      unit_pubkey?: string;
      signature?: string;
    };
    if (ledgerId !== undefined && snap.ledger_id !== ledgerId && cursor !== 0) {
      // The harness ledger was reset or replaced: its events are numbered from 1 again.
      log("supervisor", "harness ledger changed; restarting the cursor", {
        from: ledgerId,
        to: snap.ledger_id,
      });
      cursor = 0;
      snap = (await call(
        f,
        `${cfg.harnessUrl}/v1/snapshot?cursor=0&limit=1000`,
        cfg.harnessToken,
      )) as typeof snap;
    }
    ledgerId = snap.ledger_id;
    if (cfg.controlUrl && cfg.controlToken) {
      await call(
        f,
        `${cfg.controlUrl}/v1/units/${encodeURIComponent(cfg.unit)}/ingest`,
        cfg.controlToken,
        {
          method: "POST",
          body: JSON.stringify({
            unit: cfg.unit,
            ledger_id: snap.ledger_id,
            cursor,
            next: snap.next,
            events: snap.events,
            summary: snap.summary,
            // Passed through untouched: the supervisor cannot sign for the harness.
            unit_pubkey: snap.unit_pubkey,
            signature: snap.signature,
          }),
        },
      );
    }
    cursor = snap.next;
    if (snap.events.length < 1000) break;
  }
  if (cfg.controlUrl && cfg.controlToken) {
    const pending = (await call(
      f,
      `${cfg.controlUrl}/v1/units/${encodeURIComponent(cfg.unit)}/commands/pending`,
      cfg.controlToken,
    )) as { commands: SignedCommand[] };
    for (const cmd of pending.commands) {
      if (cfg.stage && (await cfg.stage(cmd)) === "wait") continue;
      const outcome = (await call(f, `${cfg.harnessUrl}/v1/commands`, cfg.harnessToken, {
        method: "POST",
        body: JSON.stringify(cmd),
      })) as { status?: string; accepted?: boolean; __status: number };
      // Another request is applying it right now: acknowledge on a later round, from the replay.
      if (outcome.status === "in_progress") continue;
      const status =
        outcome.__status === 403 ? "rejected" : outcome.accepted === false ? "failed" : "delivered";
      const { __status: _s, ...clean } = outcome;
      await call(
        f,
        `${cfg.controlUrl}/v1/units/${encodeURIComponent(cfg.unit)}/commands/${cmd.envelope.id}/ack`,
        cfg.controlToken,
        { method: "POST", body: JSON.stringify({ status, outcome: clean }) },
      );
      log("supervisor", "relayed command", {
        id: cmd.envelope.id,
        kind: cmd.envelope.kind,
        status,
      });
      cfg.onDelivered?.(cmd.envelope.kind, status === "delivered");
    }
  }
  return { cursor, ledgerId };
}
