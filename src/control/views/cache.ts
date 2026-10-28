import { logDebug } from "../../common/log.ts";
import { newestEventSeq } from "../store/events.ts";
import type { ControlStore } from "../store.ts";
import { RigFold } from "./fold/index.ts";
import { eachEvent, type RigRow, readRig, rigInputs, type ViewOptions } from "./rig.ts";
import type { RigView } from "./types.ts";

/**
 * The folds control keeps (goal 168): one for each rig, of its current ledger's events, so a view
 * folds only what came since the last one instead of every event again. controlParts makes them
 * once, and rigView reads through them wherever it is called. A rig's new ledger (a full reset)
 * starts a new fold; a rig no longer listed (retired) loses its fold. Control never deletes or
 * rewrites an event it holds (ControlStore.ingest only adds them), so a fold is never built again
 * for its own ledger; code that ever removes a rig's events must drop its fold too.
 */

/** One rig's kept fold: its ledger, and the newest seq of the rig's events it has seen. */
interface Kept {
  ledger: string | null;
  fold: RigFold;
  seq: number;
}

export class FoldCache {
  private readonly store: ControlStore;
  private readonly kept = new Map<string, Kept>();

  constructor(store: ControlStore) {
    this.store = store;
  }

  /** A rig's view, read now; undefined for a rig control does not list. */
  view(rig: string, opts: ViewOptions): RigView | undefined {
    const row = this.store.rigs().find((x) => x.id === rig);
    if (!row) {
      this.drop(rig);
      return undefined;
    }
    return this.read(row, opts);
  }

  /** Every rig's view, read now. */
  views(opts: ViewOptions): RigView[] {
    const rows = this.store.rigs();
    const listed = new Set(rows.map((u) => u.id));
    for (const rig of this.kept.keys()) if (!listed.has(rig)) this.drop(rig);
    return rows.map((u) => this.read(u, opts));
  }

  /** The folds kept: each rig's ledger and the newest seq of its events seen. */
  held(): { rig: string; ledger: string | null; seq: number }[] {
    return [...this.kept].map(([rig, k]) => ({ rig, ledger: k.ledger, seq: k.seq }));
  }

  /** A rig control no longer lists (retired, or never reported): its fold goes. */
  private drop(rig: string): void {
    if (this.kept.delete(rig)) logDebug("control", "a rig's kept fold dropped", { rig });
  }

  private read(row: RigRow, opts: ViewOptions): RigView {
    return readRig(this.upToDate(row).state(), rigInputs(this.store, row, opts));
  }

  /** The rig's fold with every event of its current ledger folded. */
  private upToDate(row: RigRow): RigFold {
    const k = this.kept.get(row.id);
    if (k && k.ledger === row.ledger_id) {
      // Most reads find nothing new: a look at the newest seq first costs next to nothing.
      const newest = newestEventSeq(this.store.db, row.id, k.seq);
      if (newest !== null) this.foldFrom(row, k, newest);
      return k.fold;
    }
    // The rig's first read, or its new ledger after a full reset: a new fold, page by page.
    const fresh: Kept = { ledger: row.ledger_id, fold: new RigFold(), seq: 0 };
    this.kept.set(row.id, fresh);
    const started = performance.now();
    this.foldFrom(row, fresh, 0);
    const ms = Math.round(performance.now() - started);
    logDebug("control", "a rig's events folded for its view", {
      rig: row.id,
      ledger: row.ledger_id,
      ms,
    });
    return fresh.fold;
  }

  /**
   * Folds the rig's events after the kept seq, as rigEvents reads them, and keeps `newest`: the
   * events the read leaves out (another ledger's, model calls) are not looked at again. A fold
   * that fails part way is dropped: the next read builds it again, so none folds an event twice.
   */
  private foldFrom(row: RigRow, k: Kept, newest: number): void {
    try {
      const last = eachEvent(this.store, row.id, row.ledger_id, k.seq, (e) => k.fold.apply(e));
      k.seq = Math.max(last, newest);
    } catch (err) {
      this.kept.delete(row.id);
      throw err;
    }
  }
}

/** Each store's kept folds: one control process, one set. */
const CACHES = new WeakMap<ControlStore, FoldCache>();

/** The folds control keeps for `store`, made at the first call (controlParts makes them). */
export function keepFolds(store: ControlStore): FoldCache {
  let c = CACHES.get(store);
  if (!c) {
    c = new FoldCache(store);
    CACHES.set(store, c);
  }
  return c;
}

/**
 * A rig's view from its events (only the current ledger's, after a reset): through the folds
 * control keeps for the store, or, for a store without them (a test's, a script's), a fold of its
 * own made now.
 */
export function rigView(
  store: ControlStore,
  rig: string,
  opts: ViewOptions = { staleAfterMs: 180_000 },
): RigView | undefined {
  return (CACHES.get(store) ?? new FoldCache(store)).view(rig, opts);
}
