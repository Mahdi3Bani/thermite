import { canonicalJson } from "../../core/canonical.ts";
import { currentEvent } from "../../core/names.ts";
import { MODEL_CALL_EVENT, ModelCallBody } from "../../core/usage.ts";
import { type Row, StorePart } from "./part.ts";
import type { IngestReport } from "./report.ts";

/**
 * The events rigs reported (goal 125, T6): a report taken, with its events, and the events read
 * back, by rig and by run.
 */

export class RigEvents extends StorePart {
  /**
   * The owner's messages to one run, from the rig's signed events on its current ledger: what
   * Live checks the message lines against (a worker's own line can claim anything).
   */
  runMessages(rig: string, run: string): Map<number, { to: string; text: string; keep: boolean }> {
    const rows = this.db
      .prepare(
        `select e.body from rig_event e join rig r on r.id = e.rig and r.ledger_id = e.ledger_id
         where e.rig = ? and e.kind = 'agent_message' and e.subject = ?`,
      )
      .all(rig, run) as { body: string }[];
    const out = new Map<number, { to: string; text: string; keep: boolean }>();
    for (const r of rows) {
      try {
        const b = JSON.parse(r.body) as {
          id?: unknown;
          to?: unknown;
          text?: unknown;
          keep?: unknown;
        };
        if (typeof b.id === "number" && typeof b.text === "string")
          out.set(b.id, { to: String(b.to ?? ""), text: b.text, keep: b.keep === true });
      } catch {
        // not an event this store can read
      }
    }
    return out;
  }

  /**
   * An experiment as the rigs' signed events left it (one rig's current ledger): who added it,
   * and its words after every edit. What a copied experiment is taken from. Undefined when no
   * rig, or more than one, has it.
   */
  experimentRecord(
    run: string,
    id: string,
  ):
    | {
        rig: string;
        by: string;
        title: string;
        details?: string | undefined;
        family?: string | undefined;
        why?: string | undefined;
      }
    | undefined {
    const rows = this.db
      .prepare(
        `select e.rig, e.kind, e.body from rig_event e join rig r on r.id = e.rig and r.ledger_id = e.ledger_id
         where e.subject = ? and e.kind in ('experiment_added', 'experiment_edited')
           and json_extract(e.body, '$.id') = ?
         order by e.rig, e.event_id`,
      )
      .all(run, id) as { rig: string; kind: string; body: string }[];
    if (new Set(rows.filter((r) => r.kind === "experiment_added").map((r) => r.rig)).size !== 1)
      return undefined;
    let x:
      | { rig: string; by: string; title: string; details?: string; family?: string; why?: string }
      | undefined;
    for (const r of rows) {
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(r.body) as Record<string, unknown>;
      } catch {
        continue;
      }
      const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
      if (r.kind === "experiment_added") {
        const by = str("by");
        const title = str("title");
        if (!by || !title) return undefined;
        x = {
          rig: r.rig,
          by,
          title,
          details: str("details"),
          family: str("family"),
          why: str("why"),
        };
      } else if (x)
        for (const k of ["title", "details", "family", "why"] as const) {
          const v = str(k);
          if (v !== undefined) x[k] = v;
        }
    }
    return x;
  }

  /** Stores a rig's report. Returns how many events were new. */
  ingest(report: IngestReport): number {
    const now = new Date().toISOString();
    return this.tx(() => {
      this.store.reportedRigs.noteReport(report, now);
      let added = 0;
      const insert = this.db.prepare(
        `insert or ignore into rig_event (rig, ledger_id, event_id, at, actor, kind, subject, body,
           received_at, run) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of report.events) {
        this.store.runRegistry.registerRunCreated(report.rig, report.ledger_id, e);
        if (e.kind === "command" && e.subject) {
          const b = (e.body ?? {}) as { accepted?: boolean };
          this.store.commands.confirmApplied(
            report.rig,
            e.subject,
            b.accepted === false ? "failed" : "delivered",
            canonicalJson({ source: "harness", ...(e.body as object) }),
            now,
          );
        }
        // A model call's usage (goal 075), as columns the sums read. A body that does not read as
        // one stays an event only.
        const call =
          e.kind === MODEL_CALL_EVENT && e.subject ? ModelCallBody.safeParse(e.body) : null;
        if (call?.success)
          this.store.usage.recordCall(
            report.rig,
            report.ledger_id,
            e.id,
            String(e.subject),
            call.data,
          );
        added += Number(
          insert.run(
            report.rig,
            report.ledger_id,
            e.id,
            e.at,
            e.actor,
            e.kind,
            e.subject,
            canonicalJson(e.body ?? {}),
            now,
            e.run ?? null,
          ).changes,
        );
      }
      return added;
    });
  }

  /**
   * The rig's signed record that a champion was published: its sha256, base commit and ledger
   * (the newest, should a run of that name have been in an earlier ledger).
   */
  publishedChampion(
    rig: string,
    run: string,
    seq: number,
  ): { sha256: string; base_commit: string; repo: string | null; ledger_id: string } | undefined {
    const r = this.db
      .prepare(
        `select body, ledger_id from rig_event where rig = ? and kind = 'champion_published'
           and subject = ? and json_extract(body, '$.seq') = ? order by seq desc limit 1`,
      )
      .get(rig, run, seq) as { body: string; ledger_id: string } | undefined;
    if (!r) return undefined;
    const b = JSON.parse(r.body) as { sha256?: string; base_commit?: string; repo?: string };
    return {
      ledger_id: r.ledger_id,
      sha256: String(b.sha256 ?? ""),
      base_commit: String(b.base_commit ?? ""),
      repo: b.repo ?? null,
    };
  }

  /**
   * When each round of a run on a rig started, oldest first (goal 075: a run page's calls in each
   * round): the times of its `epoch_started` events, on any of the rig's ledgers.
   */
  roundStarts(rig: string, run: string): string[] {
    return (
      this.db
        .prepare(
          "select at from rig_event where rig = ? and kind = 'epoch_started' and subject = ? order by seq",
        )
        .all(rig, run) as Row[]
    ).map((r) => String(r.at));
  }

  /**
   * A rig's events after a seq. `lean`: without the text a source's and a document's events
   * carry (the knowledge base keeps it), and without the model calls (one for each call: the
   * usage sums read them, from model_call), for readers that build pages from every event.
   */
  after(
    rig: string,
    after: number,
    limit: number,
    ledgerId?: string | null,
    o: { lean?: boolean } = {},
  ): unknown[] {
    const byLedger = ledgerId ? " and ledger_id = ?" : "";
    const body = o.lean
      ? "case when kind in ('source_fetched', 'research_doc', 'context_compacted') then json_remove(body, '$.text') else body end"
      : "body";
    const calls = o.lean ? ` and kind != '${MODEL_CALL_EVENT}'` : "";
    return (
      this.db
        .prepare(
          `select seq, ledger_id, event_id, at, actor, kind, subject, ${body} as body, run from rig_event
             where rig = ?${byLedger}${calls} and seq > ? order by seq limit ?`,
        )
        .all(...(ledgerId ? [rig, ledgerId, after, limit] : [rig, after, limit])) as Row[]
    ).map((r) =>
      // Events a harness reported before the 2026-10-15 rename are read under the new names.
      currentEvent({
        seq: Number(r.seq),
        ledger_id: String(r.ledger_id),
        id: Number(r.event_id),
        at: String(r.at),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: r.subject === null ? null : String(r.subject),
        body: JSON.parse(String(r.body)),
        run: r.run === null ? null : String(r.run),
      }),
    );
  }

  /**
   * For a kept view (goal 168): the newest seq of a rig's events after `after`, in any ledger and
   * of any kind; null when the rig reported none since the view last read its events. It reads
   * only the events that came after `after`, of every rig: `+rig` keeps SQLite off the index of a
   * rig's events, which would read all of them.
   */
  newestSeq(rig: string, after: number): number | null {
    const r = this.db
      .prepare("select max(seq) as seq from rig_event where seq > ? and +rig = ?")
      .get(after, rig) as { seq: number | null } | undefined;
    return r?.seq ?? null;
  }

  /** The runs a rig is running now, on its current ledger, from its events. */
  runningRuns(rig: string): { run: string; campaign: string | null }[] {
    const ledger = (
      this.db.prepare("select ledger_id from rig where id = ?").get(rig) as Row | undefined
    )?.ledger_id;
    if (!ledger) return [];
    const runs = new Map<string, { campaign: string | null; running: boolean }>();
    for (const e of this.db
      .prepare(
        `select kind, subject, body from rig_event where rig = ? and ledger_id = ?
           and kind in ('run_created', 'instance_created', 'run_status', 'instance_status')
         order by seq`,
      )
      .all(rig, String(ledger)) as Row[]) {
      let b: Record<string, unknown> = {};
      try {
        b = JSON.parse(String(e.body)) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = String(e.subject);
      if (e.kind === "run_created" || e.kind === "instance_created")
        runs.set(id, {
          campaign: typeof b.campaign === "string" ? b.campaign : null,
          running: true,
        });
      else {
        const r = runs.get(id);
        if (r) r.running = b.status === "running";
      }
    }
    return [...runs.entries()]
      .filter(([, r]) => r.running)
      .map(([run, r]) => ({ run, campaign: r.campaign }));
  }

  /** A run's campaign, from the rig's own run_created event on any of its ledgers. */
  campaignOfRun(rig: string, run: string): string | undefined {
    const r = this.db
      .prepare(
        "select body from rig_event where rig = ? and kind in ('run_created', 'instance_created') and subject = ? order by seq desc limit 1",
      )
      .get(rig, run) as Row | undefined;
    if (!r) return undefined;
    try {
      const c = (JSON.parse(String(r.body)) as { campaign?: unknown }).campaign;
      return typeof c === "string" ? c : undefined;
    } catch {
      return undefined;
    }
  }

  /** A rig's rig check events on one ledger, oldest first: a check's row reads only these. */
  rigChecks(rig: string, ledgerId: string | null): { at: string; kind: string; body: unknown }[] {
    const byLedger = ledgerId ? " and ledger_id = ?" : "";
    return (
      this.db
        .prepare(
          `select at, kind, body from rig_event where rig = ?${byLedger} and kind in ('rig_check_started', 'rig_check_finished') order by seq`,
        )
        .all(...(ledgerId ? [rig, ledgerId] : [rig])) as Row[]
    ).map((r) => ({ at: String(r.at), kind: String(r.kind), body: JSON.parse(String(r.body)) }));
  }
}
