import type { Bus } from "../common/bus.ts";
import { log } from "../common/env.ts";
import type { SignedCommand } from "../core/commands.ts";
import {
  REPORT_MAX_BYTES,
  ReportPlace,
  reportFits,
  reportMessageId,
  reportSubject,
} from "../core/link/report.ts";
import { buildHeaders } from "../core/version.ts";

/**
 * The supervisor's deterministic relay: report the harness's new events to control, then relay
 * control's pending signed commands to the harness and acknowledge each outcome. It never
 * creates or alters commands; it has no signing key.
 */

/** What the relay needs of the message bus: a publish by message id that waits for the ack. */
export type ReportBus = Pick<Bus, "publish">;

export interface RelayConfig {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** True: relayOnce leaves commands to relayCommandsOnce, run on its own shorter interval. */
  skipCommands?: boolean | undefined;
  /** Content a command brings: relay it, wait for it, or report that it could not be had. */
  stage?: ((cmd: SignedCommand) => Promise<"ready" | "wait" | { failed: string }>) | undefined;
  /** Told about each relayed command's outcome (a full reset's wipe acts on it). */
  onDelivered?: ((kind: string, accepted: boolean) => void) | undefined;
  /**
   * The pending commands fetched already, by id: control sends each one's content once, and then
   * only its id while it waits, such as for its sources (goal 171).
   */
  held?: Map<string, SignedCommand> | undefined;
  /** Of those, the ones whose sources are still being fetched: control keeps them alive. */
  staging?: Set<string> | undefined;
  /**
   * The ids of the commands whose outcome control has, newest last, DELIVERED_KEPT at most: one
   * the message bus hands again is not delivered twice.
   */
  delivered?: Set<string> | undefined;
  /**
   * Turns for delivering commands, one at a time (oneAtATime): with the message bus, its commands
   * and those of the poll over HTTP never stage or reach the harness at once.
   */
  turn?: Turn | undefined;
  /**
   * The message bus (THERMITE_NATS_URL, goal 168): reports go there instead of to control's ingest
   * route. Its commands come from there too (relay/commands.ts).
   */
  bus?: ReportBus | undefined;
}

export interface RelayState {
  cursor: number;
  /** The harness ledger the cursor belongs to. A new ledger id means start again at 0. */
  ledgerId?: string | undefined;
  /** Events per report page; halved when control refuses a page as too large. */
  pageLimit?: number | undefined;
  /**
   * On the bus: the ledger and cursor at the supervisor's last call to control with its figures.
   * The pages before it have had a whole round to reach control (healCursor).
   */
  atLastCall?: { ledgerId: string; cursor: number } | undefined;
  /**
   * On the bus: going back after a page control refused (healCursor). One page a round is sent
   * until control's answer shows it took it.
   */
  healing?: boolean | undefined;
}

/** Runs one piece of work after the one before it has ended. */
export type Turn = <T>(work: () => Promise<T>) => Promise<T>;

/** A turn for each piece of work, one at a time, in the order asked. */
export function oneAtATime(): Turn {
  let last: Promise<unknown> = Promise.resolve();
  return (work) => {
    const next = last.then(work);
    last = next.catch(() => undefined);
    return next;
  };
}

/** How many delivered commands' ids the supervisor remembers (RelayConfig.delivered). */
const DELIVERED_KEPT = 1000;

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

/** A call to control carries the supervisor's build, so control can compare it with its own. */
function toControl(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...buildHeaders(), ...(init.headers ?? {}) } };
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
 * One relay round. The cursor advances only when control took the events, or, on the bus, when
 * the bus's server has them. Commands are relayed even if reporting failed, each on its own: one
 * command's failure never holds up the others.
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
      ) as {
        ledger_id: string;
        cursor: number;
        next: number;
        events: unknown[];
        generated_at: string;
      } & Record<string, unknown>;
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
      if (cfg.bus) {
        // Passed through untouched, as below. The cursor moves once the server has the page.
        const body = JSON.stringify(snap);
        if (!reportFits(Buffer.byteLength(body))) {
          const n = snap.events.length;
          if (n <= 1)
            throw new Error(`a report of ${n} events is over the bus's ${REPORT_MAX_BYTES} bytes`);
          pageLimit = Math.floor(n / 2);
          log("supervisor", "report page too large for the bus; halving it", { page: pageLimit });
          continue;
        }
        const id = reportMessageId(snap);
        const ack = await cfg.bus.publish(reportSubject(cfg.rig), body, {
          id,
          headers: buildHeaders(),
        });
        if (ack.duplicate) log("supervisor", "the bus had this report already", { id });
      } else if (cfg.controlUrl && cfg.controlToken) {
        // Passed through untouched: the supervisor cannot sign for the harness.
        const r = await call(
          f,
          `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/ingest`,
          cfg.controlToken,
          toControl({ method: "POST", body: JSON.stringify(snap) }),
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
      // Sent again from control's place on the bus: one page a round, until control has it.
      if ((cfg.bus && state.healing) || snap.events.length < pageLimit) break;
    }
  } catch (err) {
    reportError = err;
  }
  if (!cfg.skipCommands) await relayCommandsOnce(cfg);
  const next: RelayState = { cursor, ledgerId, pageLimit };
  if (cfg.bus && state.atLastCall) next.atLastCall = state.atLastCall;
  if (cfg.bus && state.healing) next.healing = true;
  if (reportError) throw new RelayError(String(reportError), next);
  return next;
}

/**
 * On the message bus, the relay state after control's answer to the supervisor's figures, which
 * names control's place in the rig's events (ReportPlace). No answer to a page on the bus comes
 * back, so a page control refused (a key that waits for the owner, a build it refuses, a clock
 * ahead) would leave every later page refused as a gap. When control is behind what the
 * supervisor had sent by its last call, a round ago, in the same ledger (at 0 in a ledger control
 * has none of yet), control is not still reading those pages: it refused one. The supervisor goes
 * back to control's cursor and sends again from there, one page a round, until control has taken
 * what it sent. An answer without a place, from an older control, changes nothing.
 */
export function healCursor(state: RelayState, answer: unknown): RelayState {
  const read = ReportPlace.safeParse((answer as { reports?: unknown } | null)?.reports);
  const ledgerId = state.ledgerId;
  if (!read.success || ledgerId === undefined) return state;
  const theirs = read.data.ledger_id === ledgerId ? read.data.cursor : 0;
  const last = state.atLastCall?.ledgerId === ledgerId ? state.atLastCall.cursor : 0;
  // While it heals, the one page it sent since: one control has not taken by now goes again.
  const due = state.healing ? state.cursor : last;
  if (theirs >= due) {
    if (!state.healing && last === state.cursor) return state;
    return { ...state, atLastCall: { ledgerId, cursor: state.cursor }, healing: false };
  }
  log(
    "supervisor",
    "control is behind this rig's reports on the bus; sending again from its cursor",
    { ledger: ledgerId, from: state.cursor, to: theirs },
    "warn",
  );
  return { ...state, cursor: theirs, atLastCall: { ledgerId, cursor: theirs }, healing: true };
}

/**
 * Control's pending commands for this rig, staged and delivered to the harness, each acked with
 * its outcome. The supervisor runs this every few seconds on its own (a pause should not wait for
 * the next report), or every few minutes with the message bus, for a command that never reached
 * it; relayOnce runs it too unless told to skip it.
 */
export async function relayCommandsOnce(cfg: RelayConfig): Promise<void> {
  const f = cfg.fetchImpl ?? fetch;
  if (!cfg.controlUrl || !cfg.controlToken) return;
  const held = cfg.held ?? new Map<string, SignedCommand>();
  const staging = cfg.staging ?? new Set<string>();
  const list = (ids: Iterable<string>) => encodeURIComponent([...ids].join(","));
  const have = held.size ? `?have=${list(held.keys())}&staging=${list(staging)}` : "";
  const pending = must(
    await call(
      f,
      `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/commands/pending${have}`,
      cfg.controlToken,
      toControl(),
    ),
    "pending commands",
  ) as { commands: SignedCommand[]; held?: string[] };
  // What control still holds pending, oldest first; a control that names none sent all whole.
  const still = new Set(pending.held ?? []);
  for (const id of [...held.keys()]) if (!still.has(id)) held.delete(id);
  for (const cmd of pending.commands) held.set(cmd.envelope.id, cmd);
  for (const id of [...staging]) if (!held.has(id)) staging.delete(id);
  for (const cmd of [...held.values()]) await deliverCommand({ ...cfg, held, staging }, cmd);
}

/**
 * One command, from control's pending list or from the message bus: its content staged, the
 * command delivered to the harness, and the harness's answer acked to control, in its turn. True
 * once control has the outcome: it took the ack, or holds the command pending no more. False while
 * the command waits (its sources still stage, or the harness is applying it) or a call failed: the
 * next round, or the bus, hands it again. Each command on its own: one's failure never holds up
 * the others.
 */
export async function deliverCommand(cfg: RelayConfig, cmd: SignedCommand): Promise<boolean> {
  const turn = cfg.turn ?? ((work) => work());
  return await turn(() => deliverInTurn(cfg, cmd));
}

async function deliverInTurn(cfg: RelayConfig, cmd: SignedCommand): Promise<boolean> {
  const f = cfg.fetchImpl ?? fetch;
  const id = cmd.envelope.id;
  if (cfg.delivered?.has(id)) return true;
  if (!cfg.controlUrl || !cfg.controlToken) return false;
  const ackUrl = `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/commands/${id}/ack`;
  try {
    const staged = cfg.stage ? await cfg.stage(cmd) : "ready";
    if (staged === "wait") {
      cfg.staging?.add(id);
      return false;
    }
    cfg.staging?.delete(id);
    let ack: Reply;
    if (staged !== "ready") {
      // The content never arrived: the harness would only refuse it, without the reason.
      ack = await call(
        f,
        ackUrl,
        cfg.controlToken,
        toControl({
          method: "POST",
          body: JSON.stringify({ status: "failed", outcome: { error: staged.failed } }),
        }),
      );
      log("supervisor", "command not relayed", { id, error: staged.failed });
    } else {
      const outcome = await call(f, `${cfg.harnessUrl}/v1/commands`, cfg.harnessToken, {
        method: "POST",
        body: JSON.stringify(cmd),
      });
      // Another request is applying it right now: acknowledge on a later round, from the replay.
      if (outcome.body.status === "in_progress") return false;
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
      ack = await call(
        f,
        ackUrl,
        cfg.controlToken,
        toControl({ method: "POST", body: JSON.stringify({ status, outcome: reported }) }),
      );
      log("supervisor", "relayed command", { id, kind: cmd.envelope.kind, status });
      cfg.onDelivered?.(cmd.envelope.kind, status === "delivered");
    }
    // A 404: control holds it pending no more (the harness's report came first, or it expired).
    if (ack.status === 404 || (ack.status >= 200 && ack.status < 300)) {
      remember(cfg.delivered, id);
      cfg.held?.delete(id);
      return true;
    }
    const why = { id, status: ack.status, error: ack.body.error ?? null };
    log("supervisor", "control did not take a command's outcome", why, "warn");
    return false;
  } catch (err) {
    log("supervisor", "command relay error", { id, error: String(err) }, "error");
    return false;
  }
}

/** Keeps a delivered command's id, and forgets the oldest past DELIVERED_KEPT. */
function remember(delivered: Set<string> | undefined, id: string): void {
  if (!delivered) return;
  delivered.add(id);
  for (const old of delivered) {
    if (delivered.size <= DELIVERED_KEPT) break;
    delivered.delete(old);
  }
}
