import { logDebug } from "../../common/log.ts";
import type { ControlStore, RegisteredRun } from "../store/index.ts";
import { type FoldedRig, type RigCheckView, RigFold } from "./fold/index.ts";
import { eachEvent, type RigRow, readRig, rigInputs, type ViewOptions } from "./rig.ts";
import { ownCopier } from "./sharing.ts";
import type { RigView, RunOnRig } from "./types.ts";

/**
 * The folds control keeps (goal 168): one for each rig, of its current ledger's events, so a view
 * folds only what came since the last one instead of every event again. controlParts makes them
 * once, and rigView reads through them wherever it is called. A rig's new ledger (a full reset)
 * starts a new fold; a rig no longer listed (retired) loses its fold. Control never deletes or
 * rewrites an event it holds (ControlStore.ingest only adds them), so a fold is never built again
 * for its own ledger; code that ever removes a rig's events must drop its fold too. A reader that
 * follows one part of a rig often (rigChecks, runMessages) reads it from the fold, without the
 * rest of the rig's view.
 *
 * A run is read wherever it ran (goal 170), from control's run registry: its rig and its ledger.
 * A run of an earlier ledger, or of a retired rig, is read from a fold of that ledger's events,
 * kept as the rigs' are, for the EARLIER_FOLDS ledgers read last.
 */

/** One kept fold: its ledger, and the newest seq of the rig's events it has seen. */
interface Kept {
  ledger: string | null;
  fold: RigFold;
  seq: number;
}

/** How many folds of earlier ledgers and retired rigs are kept; the one read longest ago goes. */
export const EARLIER_FOLDS = 16;

export class FoldCache {
  private readonly store: ControlStore;
  private readonly kept = new Map<string, Kept>();
  /** The earlier ledgers' and retired rigs' folds, by rig and ledger, the one read last at the end. */
  private readonly earlier = new Map<string, Kept>();

  constructor(store: ControlStore) {
    this.store = store;
  }

  /** A rig's view, read now; undefined for a rig control does not list. */
  view(rig: string, opts: ViewOptions): RigView | undefined {
    const row = this.store.reportedRigs.list().find((x) => x.id === rig);
    if (!row) {
      this.drop(rig);
      return undefined;
    }
    return this.read(row, opts);
  }

  /**
   * What a rig's fold holds now, up to date, without the rest of its view and without a copy: for
   * a reader of one part that reads it often. Undefined for a rig control does not list. The
   * reader never changes what it reads.
   */
  folded(rig: string): FoldedRig | undefined {
    const row = this.store.reportedRigs.list().find((x) => x.id === rig);
    if (!row) {
      this.drop(rig);
      return undefined;
    }
    return this.upToDate(row).state();
  }

  /** Every rig's view, read now. */
  views(opts: ViewOptions): RigView[] {
    const rows = this.store.reportedRigs.list();
    const listed = new Set(rows.map((u) => u.id));
    for (const rig of this.kept.keys()) if (!listed.has(rig)) this.drop(rig);
    return rows.map((u) => this.read(u, opts));
  }

  /** A run's view wherever it ran, read now; undefined for a run no rig created. */
  run(id: string, opts: ViewOptions): RunOnRig | undefined {
    const r = this.store.runRegistry.created(id);
    return r ? this.place([r], opts)[0] : undefined;
  }

  /** The run of this name a rig created, wherever on the rig it ran, read now; or undefined. */
  runOn(rig: string, id: string, opts: ViewOptions): RunOnRig | undefined {
    const r = this.store.runRegistry.createdOn(id, rig);
    return r ? this.place([r], opts)[0] : undefined;
  }

  /** Every run of a campaign a rig created, newest first, earlier ones too, read now. */
  campaignRuns(campaign: string, opts: ViewOptions): RunOnRig[] {
    return this.place(this.store.runRegistry.ofCampaign(campaign), opts);
  }

  /** The folds kept: each rig's ledger and the newest seq of its events seen. */
  held(): { rig: string; ledger: string | null; seq: number }[] {
    return [...this.kept].map(([rig, k]) => ({ rig, ledger: k.ledger, seq: k.seq }));
  }

  /** The earlier ledgers' and retired rigs' folds kept, the one read last at the end. */
  heldEarlier(): { rig: string; ledger: string | null }[] {
    return [...this.earlier].map(([key, k]) => ({
      rig: key.split("\n")[0] ?? "",
      ledger: k.ledger,
    }));
  }

  /** A rig control no longer lists (retired, or never reported): its fold goes. */
  private drop(rig: string): void {
    if (this.kept.delete(rig)) logDebug("control", "a rig's kept fold dropped", { rig });
  }

  private read(row: RigRow, opts: ViewOptions): RigView {
    return readRig(this.upToDate(row).state(), rigInputs(this.store, row, opts));
  }

  /**
   * Each registered run with the view of its rig as of its ledger: the rig's own view for a listed
   * rig's current ledger, else the view of an earlier fold. A rig is read once for all its runs.
   */
  private place(runs: RegisteredRun[], opts: ViewOptions): RunOnRig[] {
    const rows = new Map(this.store.reportedRigs.list({ withRetired: true }).map((u) => [u.id, u]));
    const read = new Map<string, RigView | undefined>();
    const out: RunOnRig[] = [];
    for (const r of runs) {
      const row = rows.get(r.rig);
      if (!row) continue;
      const retired = this.store.retired.get(r.rig) !== undefined;
      const current = !retired && row.ledger_id === r.ledger_id;
      const key = `${r.rig}\n${r.ledger_id}`;
      if (!read.has(key))
        read.set(key, current ? this.view(r.rig, opts) : this.earlierView(row, r.ledger_id, opts));
      const rig = read.get(key);
      const run = rig?.runs.find((x) => x.id === r.run);
      if (rig && run)
        out.push({ rig, run, earlier: retired ? "retired" : current ? null : "reset" });
    }
    return out;
  }

  /**
   * A view of one ledger of a rig that is not the rig's current view: an earlier ledger, or a
   * retired rig's. Its report is the rig's last one for its own ledger, and none for another.
   */
  private earlierView(row: RigRow, ledger: string, opts: ViewOptions): RigView {
    const key = `${row.id}\n${ledger}`;
    const k = this.earlier.get(key) ?? { ledger, fold: new RigFold(), seq: 0 };
    // The one read last goes at the end; past EARLIER_FOLDS, the one read longest ago goes.
    this.earlier.delete(key);
    this.earlier.set(key, k);
    for (const old of this.earlier.keys()) {
      if (this.earlier.size <= EARLIER_FOLDS) break;
      this.earlier.delete(old);
    }
    if (k.seq === 0)
      logDebug("control", "an earlier ledger's events folded", { rig: row.id, ledger });
    const newest = this.store.rigEvents.newestSeq(row.id, k.seq);
    if (newest !== null) this.foldFrom(row.id, k, newest, () => this.earlier.delete(key));
    const own = row.ledger_id === ledger;
    const at = { ...row, ledger_id: ledger, summary: own ? row.summary : {} };
    return readRig(k.fold.state(), rigInputs(this.store, at, opts));
  }

  /** The rig's fold with every event of its current ledger folded. */
  private upToDate(row: RigRow): RigFold {
    const k = this.kept.get(row.id);
    if (k && k.ledger === row.ledger_id) {
      // Most reads find nothing new: a look at the newest seq first costs next to nothing.
      const newest = this.store.rigEvents.newestSeq(row.id, k.seq);
      if (newest !== null) this.foldFrom(row.id, k, newest, () => this.kept.delete(row.id));
      return k.fold;
    }
    // The rig's first read, or its new ledger after a full reset: a new fold, page by page.
    const fresh: Kept = { ledger: row.ledger_id, fold: new RigFold(), seq: 0 };
    this.kept.set(row.id, fresh);
    const started = performance.now();
    this.foldFrom(row.id, fresh, 0, () => this.kept.delete(row.id));
    const ms = Math.round(performance.now() - started);
    logDebug("control", "a rig's events folded for its view", {
      rig: row.id,
      ledger: row.ledger_id,
      ms,
    });
    return fresh.fold;
  }

  /**
   * Folds the rig's events after the kept seq, in the fold's ledger, as rigEvents reads them, and
   * keeps `newest`: the events the read leaves out (another ledger's, model calls) are not looked
   * at again. A fold that fails part way is dropped (`drop`): the next read builds it again, so
   * none folds an event twice.
   */
  private foldFrom(rig: string, k: Kept, newest: number, drop: () => void): void {
    try {
      const last = eachEvent(this.store, rig, k.ledger, k.seq, (e) => k.fold.apply(e));
      k.seq = Math.max(last, newest);
    } catch (err) {
      drop();
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

/** The folds control keeps for the store, or, for a store without them (a test's), new ones. */
const foldsOf = (store: ControlStore) => CACHES.get(store) ?? new FoldCache(store);

const DEFAULT_VIEW: ViewOptions = { staleAfterMs: 180_000 };

/**
 * A rig's view from its events (only the current ledger's, after a reset): through the folds
 * control keeps for the store, or, for a store without them (a test's, a script's), a fold of its
 * own made now.
 */
export function rigView(
  store: ControlStore,
  rig: string,
  opts: ViewOptions = DEFAULT_VIEW,
): RigView | undefined {
  return foldsOf(store).view(rig, opts);
}

/** A run's view wherever it ran (goal 170), as rigView reads a rig's: undefined when none. */
export function findRun(
  store: ControlStore,
  run: string,
  opts: ViewOptions = DEFAULT_VIEW,
): RunOnRig | undefined {
  return foldsOf(store).run(run, opts);
}

/**
 * The run of this name a rig created, wherever on the rig it ran (an earlier ledger too), as
 * findRun reads a run: undefined when the rig created none.
 */
export function findRunOn(
  store: ControlStore,
  rig: string,
  run: string,
  opts: ViewOptions = DEFAULT_VIEW,
): RunOnRig | undefined {
  return foldsOf(store).runOn(rig, run, opts);
}

/** Every run of a campaign a rig created, newest first, earlier ones too, as findRun reads one. */
export function campaignRuns(
  store: ControlStore,
  campaign: string,
  opts: ViewOptions = DEFAULT_VIEW,
): RunOnRig[] {
  return foldsOf(store).campaignRuns(campaign, opts);
}

/**
 * A rig's checks, each one's newest run on its current ledger, from its fold without the rest of
 * its view: what a check's row reads, which the dashboard follows often. None for a rig control
 * does not list.
 */
export function rigChecks(store: ControlStore, rig: string): Record<string, RigCheckView> {
  return ownCopier()(foldsOf(store).folded(rig)?.checks ?? {});
}

/**
 * The owner's messages to one run on a rig's current ledger, by id, from the rig's signed events
 * as its fold holds them, without the rest of its view: what Live checks a run's message lines
 * against each time it draws them (a worker's own line can claim anything).
 */
export function runMessages(
  store: ControlStore,
  rig: string,
  run: string,
): Map<number, { to: string; text: string; keep: boolean }> {
  const r = foldsOf(store)
    .folded(rig)
    ?.runs.find((x) => x.id === run);
  return new Map((r?.messages ?? []).map((m) => [m.id, { to: m.to, text: m.text, keep: m.keep }]));
}
