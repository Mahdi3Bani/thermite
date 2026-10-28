import type { Bus, StreamState } from "../../common/bus.ts";
import { errorText } from "../../common/errors.ts";
import type { LiveFigures } from "../../core/api/control/rigs.ts";
import { COMMAND_STREAM } from "../../core/link/commands.ts";
import {
  LIVE_KEPT_BYTES,
  LIVE_KEPT_PER_SUBJECT,
  LIVE_KEPT_SECONDS,
  LIVE_MAX_BYTES,
  LIVE_STREAM,
} from "../../core/link/live.ts";
import { REPORT_STREAM } from "../../core/link/report.ts";
import type { LiveTaken } from "../live/index.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * The message bus's state, for whoever runs control (goal 168): its server, the streams control
 * makes with what each consumer has still to take, and the live stream's figures, from control's
 * side and from each rig's supervisor. REST (`GET /v1/bus`), MCP (`bus_state`) and `/metrics`
 * read it.
 */

/** The streams control makes, in the order the state lists them. */
export const BUS_STREAMS = [REPORT_STREAM, COMMAND_STREAM, LIVE_STREAM] as const;

/** How long a look at the server may take: then the state says the server did not answer. */
export const BUS_STATE_TIMEOUT_MS = 5_000;

/** The bus as control's APIs see it: its server, and what control took from the live stream. */
export interface BusView {
  /** The server's host and port. */
  server: string;
  bus: Pick<Bus, "streams">;
  live: LiveTaken;
}

/** A rig's live lines on the bus: what control took of them, and its supervisor's own counts. */
export interface RigLive {
  rig: string;
  /** Lines control added to the rig's live view from the bus, since control started. */
  taken: number;
  /** The supervisor's figures, since it started; null before its first figures with them. */
  supervisor: (LiveFigures & { at: string | null }) | null;
}

/** The live stream's limits, what control took from it, and each rig's counts. */
export function liveState(store: ControlStore, taken: LiveTaken) {
  const rigs: RigLive[] = [];
  const seen = new Set(taken.rigs.keys());
  for (const r of store.reportedRigs.list()) {
    const sup = store.reportedRigs.supervisor(r.id);
    const live = sup?.live as LiveFigures | undefined;
    if (!live && !seen.has(r.id)) continue;
    seen.delete(r.id);
    const at = typeof sup?.received_at === "string" ? sup.received_at : null;
    rigs.push({
      rig: r.id,
      taken: taken.rigs.get(r.id) ?? 0,
      supervisor: live ? { ...live, at } : null,
    });
  }
  for (const rig of seen) rigs.push({ rig, taken: taken.rigs.get(rig) ?? 0, supervisor: null });
  return {
    kept: {
      seconds: LIVE_KEPT_SECONDS,
      messages_per_subject: LIVE_KEPT_PER_SUBJECT,
      bytes: LIVE_KEPT_BYTES,
      message_bytes: LIVE_MAX_BYTES,
    },
    taken: {
      since: taken.since,
      messages: taken.messages,
      lines: taken.lines,
      left_out: taken.leftOut,
      refused: { ...taken.refused },
    },
    rigs,
  };
}

/** The bus's state now; with the bus off, only that it is off. */
export async function busState(store: ControlStore, view: BusView | undefined) {
  if (!view) return { on: false as const };
  let streams: StreamState[] = [];
  let error: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(
      () => fail(new Error(`no answer within ${BUS_STATE_TIMEOUT_MS / 1000} seconds`)),
      BUS_STATE_TIMEOUT_MS,
    );
  });
  try {
    streams = await Promise.race([view.bus.streams(BUS_STREAMS), late]);
  } catch (err) {
    error = errorText(err);
  } finally {
    clearTimeout(timer);
  }
  return {
    on: true as const,
    server: view.server,
    reachable: error === null,
    error,
    streams,
    live: liveState(store, view.live),
  };
}
