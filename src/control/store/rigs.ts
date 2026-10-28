import { canonicalJson } from "../../core/canonical.ts";
import { fingerprint } from "./keys.ts";
import { type Row, StorePart } from "./part.ts";
import type { IngestReport } from "./report.ts";

/**
 * The rigs as they report (goal 125, T6): each rig's row, with its report's cursor, ledger and
 * summary, its report-signing keys and its supervisor's own figures, and the ledgers it has left.
 */

export class ReportedRigs extends StorePart {
  /**
   * The supervisor's own figures for a rig (unsigned: it reports them about itself). They never
   * make a rig look live: only the harness's signed reports move last_seen.
   */
  setSupervisor(rig: string, stats: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, supervisor, supervisor_at) values (?, ?, ?, ?, ?)
         on conflict (id) do update set supervisor = excluded.supervisor, supervisor_at = excluded.supervisor_at`,
      )
      .run(rig, now, new Date(0).toISOString(), canonicalJson(stats ?? {}), now);
  }

  /**
   * Whether a signed report may be taken: not from a ledger the rig has left, starting no later
   * than the stream control already has (no gap), and no older than the newest report taken.
   */
  reportCheck(
    rig: string,
    r: { ledgerId: string; cursor: number; generatedAt: string },
  ): { ok: true } | { ok: false; reason: string; expectedCursor?: number } {
    const left = this.db
      .prepare(
        "select 1 from rig_ledger where rig = ? and ledger_id = ? and superseded_at is not null",
      )
      .get(rig, r.ledgerId);
    if (left) return { ok: false, reason: "a report from a ledger the rig has left" };
    const u = this.db
      .prepare("select ledger_id, last_cursor, report_at from rig where id = ?")
      .get(rig) as Row | undefined;
    if (!u || u.ledger_id === null || String(u.ledger_id) !== r.ledgerId) {
      // A new ledger starts at the beginning.
      return r.cursor === 0
        ? { ok: true }
        : { ok: false, reason: "a new ledger's events start at 0", expectedCursor: 0 };
    }
    if (r.cursor > Number(u.last_cursor)) {
      return {
        ok: false,
        reason: "a gap in the event stream",
        expectedCursor: Number(u.last_cursor),
      };
    }
    if (u.report_at && r.generatedAt < String(u.report_at)) {
      return { ok: false, reason: "a report older than the newest one taken" };
    }
    return { ok: true };
  }

  supervisor(rig: string): Record<string, unknown> | null {
    const r = this.db.prepare("select supervisor, supervisor_at from rig where id = ?").get(rig) as
      | Row
      | undefined;
    return r?.supervisor
      ? { ...(JSON.parse(String(r.supervisor)) as object), received_at: String(r.supervisor_at) }
      : null;
  }

  /** The rig's pinned report-signing key, if any. */
  key(rig: string): { pubkey: string | null; pending: string | null } {
    const r = this.db.prepare("select pubkey, pending_pubkey from rig where id = ?").get(rig) as
      | Row
      | undefined;
    return {
      pubkey: r?.pubkey ? String(r.pubkey) : null,
      pending: r?.pending_pubkey ? String(r.pending_pubkey) : null,
    };
  }

  /** Pins a rig's key on first contact (trust on first use, shown on the dashboard). */
  pinKey(rig: string, pubkey: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pubkey = excluded.pubkey, pending_pubkey = null`,
      )
      .run(rig, now, now, pubkey);
    this.store.auditLog.add(`rig:${rig}`, "rig_key_pinned", { fingerprint: fingerprint(pubkey) });
  }

  /** A different key arrived: hold it until the owner accepts it. */
  holdKey(rig: string, pubkey: string): void {
    // A first key held for the owner has no rig row yet; the row does not make the rig live.
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, pending_pubkey) values (?, ?, ?, ?)
         on conflict (id) do update set pending_pubkey = excluded.pending_pubkey`,
      )
      .run(rig, new Date().toISOString(), new Date(0).toISOString(), pubkey);
    this.store.auditLog.add(`rig:${rig}`, "rig_key_changed", { fingerprint: fingerprint(pubkey) });
  }

  /** Accepts the held key, but only the one with the fingerprint the owner checked. */
  acceptPendingKey(rig: string, actor: string, fingerprintSeen: string): boolean {
    const { pending } = this.key(rig);
    if (!pending || fingerprint(pending) !== fingerprintSeen) return false;
    this.db
      .prepare("update rig set pubkey = pending_pubkey, pending_pubkey = null where id = ?")
      .run(rig);
    this.store.auditLog.add(actor, "rig_key_accepted", { rig, fingerprint: fingerprint(pending) });
    return true;
  }

  /** The rigs that reported, but not the retired ones unless asked for. */
  list(opts: { withRetired?: boolean } = {}): {
    id: string;
    last_seen: string;
    last_cursor: number;
    ledger_id: string | null;
    summary: unknown;
  }[] {
    return (
      this.db
        .prepare(`select * from rig where ? or id not in (select rig from rig_retired) order by id`)
        .all(opts.withRetired ? 1 : 0) as Row[]
    ).map((r) => ({
      id: String(r.id),
      last_seen: String(r.last_seen),
      last_cursor: Number(r.last_cursor),
      ledger_id: r.ledger_id === null ? null : String(r.ledger_id),
      summary: JSON.parse(String(r.summary)),
    }));
  }

  /**
   * A report taken, in one transaction with its events (RigEvents.ingest): the rig's row moves to
   * it, and its ledger joins the rig's ledger history.
   */
  noteReport(report: IngestReport, now: string): void {
    this.db
      .prepare(
        `insert into rig (id, first_seen, last_seen, last_cursor, ledger_id, summary, report_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set last_seen = excluded.last_seen,
           last_cursor = case when rig.ledger_id = excluded.ledger_id
             then max(rig.last_cursor, excluded.last_cursor) else excluded.last_cursor end,
           ledger_id = excluded.ledger_id, summary = excluded.summary,
           report_at = excluded.report_at`,
      )
      .run(
        report.rig,
        now,
        now,
        report.next,
        report.ledger_id,
        canonicalJson(report.summary ?? {}),
        report.generated_at ?? now,
      );
    // Ledger history: a new ledger supersedes the ones before it, for good.
    this.db
      .prepare(
        "update rig_ledger set superseded_at = ? where rig = ? and ledger_id != ? and superseded_at is null",
      )
      .run(now, report.rig, report.ledger_id);
    this.db
      .prepare("insert or ignore into rig_ledger (rig, ledger_id, first_seen) values (?, ?, ?)")
      .run(report.rig, report.ledger_id, now);
  }

  /** A row for a rig that never reported, so it is listed (with no report: offline). */
  addUnreported(rig: string, now: string): void {
    this.db
      .prepare("insert or ignore into rig (id, first_seen, last_seen) values (?, ?, ?)")
      .run(rig, now, new Date(0).toISOString());
  }

  /** The rig's row as reports move it: its current ledger, the cursor after it, its newest report. */
  reportRow(
    rig: string,
  ): { ledger_id: unknown; last_cursor: unknown; report_at: unknown } | undefined {
    return this.db
      .prepare("select ledger_id, last_cursor, report_at from rig where id = ?")
      .get(rig) as { ledger_id: unknown; last_cursor: unknown; report_at: unknown } | undefined;
  }
}
