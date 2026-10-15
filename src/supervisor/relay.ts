import { log } from "../common/env.ts";
import type { SignedCommand } from "../core/commands.ts";

/**
 * The supervisor's deterministic relay: report the harness's new events to control, then relay
 * control's pending signed commands to the harness and acknowledge each outcome. It never
 * creates or alters commands; it has no signing key.
 */
export interface RelayConfig {
  rig: string;
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
  /** Events per report page; halved when control refuses a page as too large. */
  pageLimit?: number | undefined;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  f: typeof fetch,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Reply> {
  const res = await f(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

const must = (r: Reply, what: string): Record<string, unknown> => {
  if (r.status < 200 || r.status >= 300)
    throw new Error(`${what} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};

/** A relay round whose reporting failed; its state still carries any progress made. */
export class RelayError extends Error {
  readonly state: RelayState;

  constructor(message: string, state: RelayState) {
    super(message);
    this.state = state;
  }
}

/**
 * One relay round. The cursor advances only when control took the events. Commands are relayed
 * even if reporting failed, each on its own: one command's failure never holds up the others.
 */
export async function relayOnce(cfg: RelayConfig, state: RelayState): Promise<RelayState> {
  const f = cfg.fetchImpl ?? fetch;
  let cursor = state.cursor;
  let ledgerId = state.ledgerId;
  let pageLimit = state.pageLimit ?? 1000;
  let reportError: unknown;
  try {
    for (let pages = 0; pages < 10_000; pages++) {
      let snap = must(
        await call(
          f,
          `${cfg.harnessUrl}/v1/snapshot?cursor=${cursor}&limit=${pageLimit}`,
          cfg.harnessToken,
        ),
        "snapshot",
      ) as { ledger_id: string; next: number; events: unknown[] } & Record<string, unknown>;
      if (ledgerId !== undefined && snap.ledger_id !== ledgerId && cursor !== 0) {
        // The harness ledger was reset or replaced: its events are numbered from 1 again.
        log("supervisor", "harness ledger changed; restarting the cursor", {
          from: ledgerId,
          to: snap.ledger_id,
        });
        cursor = 0;
        snap = must(
          await call(
            f,
            `${cfg.harnessUrl}/v1/snapshot?cursor=0&limit=${pageLimit}`,
            cfg.harnessToken,
          ),
          "snapshot",
        ) as typeof snap;
      }
      ledgerId = snap.ledger_id;
      // A harness signing as another rig is a deployment mistake: say so, never report it on.
      if (typeof snap.rig === "string" && snap.rig !== cfg.rig)
        throw new Error(
          `the harness reports as rig ${snap.rig}, but this supervisor is ${cfg.rig}`,
        );
      if (cfg.controlUrl && cfg.controlToken) {
        // Passed through untouched: the supervisor cannot sign for the harness.
        const r = await call(
          f,
          `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/ingest`,
          cfg.controlToken,
          { method: "POST", body: JSON.stringify(snap) },
        );
        if (r.status === 409 && typeof r.body.expected_cursor === "number") {
          // Control has a different place in the stream (a gap, or a new ledger): go there.
          if (r.body.expected_cursor === cursor) must(r, "ingest");
          cursor = r.body.expected_cursor;
          log("supervisor", "control asked for events from another cursor", {
            cursor,
            reason: r.body.error,
          });
          continue;
        }
        if (r.status === 413 && pageLimit > 10) {
          pageLimit = Math.max(10, Math.floor(pageLimit / 2));
          log("supervisor", "report page too large; halving it", { page: pageLimit });
          continue;
        }
        must(r, "ingest");
      }
      cursor = snap.next;
      if (snap.events.length < pageLimit) break;
    }
  } catch (err) {
    reportError = err;
  }
  if (cfg.controlUrl && cfg.controlToken) {
    const pending = must(
      await call(
        f,
        `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/commands/pending`,
        cfg.controlToken,
      ),
      "pending commands",
    ) as { commands: SignedCommand[] };
    for (const cmd of pending.commands) {
      try {
        if (cfg.stage && (await cfg.stage(cmd)) === "wait") continue;
        const outcome = await call(f, `${cfg.harnessUrl}/v1/commands`, cfg.harnessToken, {
          method: "POST",
          body: JSON.stringify(cmd),
        });
        // Another request is applying it right now: acknowledge on a later round, from the replay.
        if (outcome.body.status === "in_progress") continue;
        const status =
          outcome.status === 403
            ? "rejected"
            : outcome.status >= 300 || outcome.body.accepted === false
              ? "failed"
              : "delivered";
        const reported =
          outcome.status >= 300 && outcome.status !== 403
            ? { http: outcome.status, error: outcome.body.error ?? null }
            : outcome.body;
        await call(
          f,
          `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/commands/${cmd.envelope.id}/ack`,
          cfg.controlToken,
          { method: "POST", body: JSON.stringify({ status, outcome: reported }) },
        );
        log("supervisor", "relayed command", {
          id: cmd.envelope.id,
          kind: cmd.envelope.kind,
          status,
        });
        cfg.onDelivered?.(cmd.envelope.kind, status === "delivered");
      } catch (err) {
        log("supervisor", "command relay error", { id: cmd.envelope.id, error: String(err) });
      }
    }
  }
  const next = { cursor, ledgerId, pageLimit };
  if (reportError) throw new RelayError(String(reportError), next);
  return next;
}
