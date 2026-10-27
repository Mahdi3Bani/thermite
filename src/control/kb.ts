import type { DatabaseSync } from "node:sqlite";
import type { BriefingSeed, QueueSeed } from "../core/commands.ts";
import { IdSchema } from "../core/contract.ts";
import type { KbItemWire, KbKind, KbSync } from "../core/kb.ts";
import {
  clip,
  indexEvent,
  type KbFields,
  type KbIndexTarget,
  type KbStored,
  mergeItem,
  metaOf,
  sameItem,
  str,
} from "../core/kb-index.ts";
import { KB_SCHEMA } from "./kb/schema.ts";

/**
 * Thermite's own knowledge base (goal 065): one folder for each campaign, built from what its
 * runs report. Control indexes the rigs' events as they arrive (core/kb-index.ts reads each):
 * the runs, the trials, the agents' field notes and research notes, the documents lanes wrote,
 * the experiments with their results, attempts with their verdicts, sources with their text,
 * claims, findings and reports, each with its run, who wrote it and when. A campaign reads its
 * own folder and, when the owner grants it, other campaigns' folders. Agents only read folders;
 * the folders are written from the rigs' signed events alone.
 */

export type { KbKind } from "../core/kb.ts";

/** The field notes' kinds (journal_note); a research note is a note of kind "note". */
export const JOURNAL_KINDS = ["observation", "decision", "surprise", "question", "lesson"] as const;

export interface KbItem {
  id: number;
  /** Increases on every insert and every update of any item: the rigs' sync cursor. */
  seq: number;
  campaign: string;
  rig: string;
  /** The rig's ledger the item came from (a reset starts a new one; items never mix). */
  ledger: string;
  run: string;
  kind: KbKind;
  /** The item's id in its run (an experiment, an attempt, a claim, a note's number). */
  ref: string;
  title: string;
  body: string;
  /** Who wrote it: a lane, the planner, an advisor, the judge, the owner. */
  by: string;
  url: string | null;
  /** For a note: observation, decision, surprise, question, lesson or note. */
  sub: string | null;
  /** Fields kept apart: an experiment's details, why and direction. */
  meta: Record<string, string>;
  at: string;
  updated_at: string;
}

/** One campaign's folder: its items by kind, its runs, its newest change and its grants. */
export interface KbFolder {
  campaign: string;
  counts: Partial<Record<KbKind, number>>;
  /** Of the notes, how many are field notes (observations, decisions, …), not research notes. */
  journal: number;
  items: number;
  runs: number;
  updated_at: string;
  /** The campaigns granted to read this folder. */
  read_by: string[];
  /** The folders this campaign reads besides its own. */
  reads: string[];
}

type Row = Record<string, unknown>;
/** Events read per transaction while catching up. */
const PAGE = 2000;
/** Items a rig's sync answers at most at once (it asks again while `more` is true). */
export const SYNC_PAGE = 500;
/**
 * The reading's version, and the kinds each reading read anew: a store built by an earlier
 * reading reads those events once more, so the runs before an upgrade have them too. Reading 2
 * added runs, trials, documents and hypotheses; reading 3 keeps an experiment's result and an
 * attempt's verdict in fields, and an experiment's edits (goal 162), so their items are rebuilt.
 */
const READING = "3";
const READ_ANEW: Record<string, string[]> = {
  "2": [
    "run_created",
    "run_status",
    "champion_promoted",
    "trial_started",
    "trial_finished",
    "research_doc",
    "hypothesis_added",
  ],
  "3": [
    "experiment_added",
    "experiment_edited",
    "experiment_finished",
    "experiment_dropped",
    "attempt_recorded",
    "verdict",
  ],
};

export class KnowledgeBase {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(KB_SCHEMA);
  }

  /** Runs fn in one transaction: all of it is kept, or none of it. */
  private tx<T>(fn: () => T): T {
    this.db.exec("begin");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  /** The next n item seqs (returns the last of them). */
  private nextSeq(n = 1): number {
    const r = this.db
      .prepare("update kb_cursor set item_seq = item_seq + ? where id = 1 returning item_seq")
      .get(n) as { item_seq: number };
    return Number(r.item_seq);
  }

  /**
   * Indexes the events control received since the last call. Only a rig's current ledger is
   * read: control calls this after each report it takes, so every ledger is read while it is
   * the rig's, and a ledger the rig has left (a reset) adds nothing more.
   */
  catchUp(): number {
    this.readAgain();
    let total = 0;
    for (;;) {
      const cur = Number(
        (this.db.prepare("select seq from kb_cursor where id = 1").get() as { seq: number }).seq,
      );
      const rows = this.db
        .prepare(
          `select e.seq, e.rig, e.ledger_id, e.at, e.actor, e.kind, e.subject, e.body from rig_event e
           join rig r on r.id = e.rig and r.ledger_id = e.ledger_id
           where e.seq > ? order by e.seq limit ?`,
        )
        .all(cur, PAGE) as Row[];
      if (!rows.length) return total;
      this.tx(() => {
        for (const r of rows) {
          let body: unknown;
          try {
            body = JSON.parse(str(r.body));
          } catch {
            // a body control stored as JSON always parses; anything else is skipped
            continue;
          }
          if (!body || typeof body !== "object") continue;
          this.index(
            { rig: str(r.rig), ledger: str(r.ledger_id) },
            str(r.at),
            str(r.actor),
            str(r.kind),
            str(r.subject),
            body as Row,
          );
        }
        this.db
          .prepare("update kb_cursor set seq = ? where id = 1")
          .run(Number(rows.at(-1)?.seq ?? cur));
      });
      total += rows.length;
      if (rows.length < PAGE) return total;
    }
  }

  /**
   * Once, after an upgrade: the events indexed before READING read again for the kinds of item
   * added since, from each rig's current ledger, as catchUp reads them. A run keeps the folder it
   * was filed in. Nothing is written when the store is already at READING.
   */
  private readAgain(): void {
    const at = (
      this.db.prepare("select value from kb_meta where key = 'reading'").get() as
        | { value: string }
        | undefined
    )?.value;
    if (at === READING) return;
    const through = Number(
      (this.db.prepare("select seq from kb_cursor where id = 1").get() as { seq: number }).seq,
    );
    const anew = Object.entries(READ_ANEW).flatMap(([v, k]) => (v > (at ?? "1") ? k : []));
    const kinds = anew.map(() => "?").join(", ");
    for (let after = 0; ; ) {
      const rows = this.db
        .prepare(
          `select e.seq, e.rig, e.ledger_id, e.at, e.actor, e.kind, e.subject, e.body from rig_event e
           join rig r on r.id = e.rig and r.ledger_id = e.ledger_id
           where e.seq > ? and e.seq <= ? and e.kind in (${kinds}) order by e.seq limit ?`,
        )
        .all(after, through, ...anew, PAGE) as Row[];
      this.tx(() => {
        for (const r of rows) {
          let body: unknown;
          try {
            body = JSON.parse(str(r.body));
          } catch {
            continue; // as in catchUp
          }
          if (!body || typeof body !== "object") continue;
          const src = { rig: str(r.rig), ledger: str(r.ledger_id) };
          indexEvent(this.target(src, { keepRuns: true }), {
            at: str(r.at),
            actor: str(r.actor),
            kind: str(r.kind),
            subject: str(r.subject),
            body: body as Row,
          });
        }
      });
      if (rows.length < PAGE) break;
      after = Number(rows.at(-1)?.seq ?? through);
    }
    this.db
      .prepare(
        "insert into kb_meta (key, value) values ('reading', ?) on conflict(key) do update set value = excluded.value",
      )
      .run(READING);
  }

  /** The campaign of the newest assign_campaign control issued for this run on this rig. */
  private assigned(rig: string, run: string): string | undefined {
    const r = this.db
      .prepare(
        `select json_extract(signed, '$.envelope.payload.contract.campaign') as c from command
         where rig = ? and kind = 'assign_campaign' and status not in ('failed', 'rejected', 'expired')
           and json_extract(signed, '$.envelope.payload.run') = ?
         order by issued_at desc limit 1`,
      )
      .get(rig, run) as { c: unknown } | undefined;
    return typeof r?.c === "string" && r.c ? r.c : undefined;
  }

  /** Whether control assigned a run of this campaign to any rig. */
  private assignedAnywhere(campaign: string): boolean {
    return (
      this.db
        .prepare(
          `select 1 from command where kind = 'assign_campaign'
           and json_extract(signed, '$.envelope.payload.contract.campaign') = ? limit 1`,
        )
        .get(campaign) !== undefined
    );
  }

  private campaignOf(rig: string, ledger: string, run: string): string | undefined {
    return (
      this.db
        .prepare("select campaign from kb_run where rig = ? and ledger = ? and run = ?")
        .get(rig, ledger, run) as { campaign: string } | undefined
    )?.campaign;
  }

  /**
   * Where one rig ledger's events put their items: the folder control files each run in.
   * `keepRuns`: a run filed already stays in its folder (reading old events again).
   */
  private target(
    src: { rig: string; ledger: string },
    o: { keepRuns?: boolean } = {},
  ): KbIndexTarget {
    const { rig, ledger } = src;
    return {
      // Filed under the campaign control assigned this run on this rig. A run control did not
      // assign keeps the campaign its event names, unless control assigned that campaign
      // somewhere: a rig cannot file items into a campaign it was not given.
      runCreated: (run, named) => {
        if (o.keepRuns && this.campaignOf(rig, ledger, run)) return;
        const assigned = this.assigned(rig, run);
        const campaign = assigned ?? (named && !this.assignedAnywhere(named) ? named : "");
        if (campaign)
          this.db
            .prepare(
              "insert into kb_run (rig, ledger, run, campaign) values (?, ?, ?, ?) on conflict(rig, ledger, run) do update set campaign = excluded.campaign",
            )
            .run(rig, ledger, run, campaign);
      },
      item: (run, kind, ref) => {
        const r = this.db
          .prepare(
            "select body, meta from kb_item where rig = ? and ledger = ? and run = ? and kind = ? and ref = ?",
          )
          .get(rig, ledger, run, kind, ref) as { body: string; meta: string } | undefined;
        return r && { body: r.body, meta: metaOf(r.meta) };
      },
      attempt: (ref) => {
        const r = this.db
          .prepare(
            "select run, body, meta from kb_item where rig = ? and ledger = ? and kind = 'attempt' and ref = ?",
          )
          .get(rig, ledger, ref) as { run: string; body: string; meta: string } | undefined;
        return r && { run: r.run, body: r.body, meta: metaOf(r.meta) };
      },
      put: (run, kind, ref, f, at) => this.put(src, run, kind, ref, f, at),
    };
  }

  private put(
    src: { rig: string; ledger: string },
    run: string,
    kind: KbKind,
    ref: string,
    f: KbFields,
    at: string,
  ): void {
    const { rig, ledger } = src;
    const campaign = this.campaignOf(rig, ledger, run);
    if (!campaign || !ref) return;
    const row = this.db
      .prepare(
        "select title, body, by, url, sub, meta from kb_item where rig = ? and ledger = ? and run = ? and kind = ? and ref = ?",
      )
      .get(rig, ledger, run, kind, ref) as Row | undefined;
    const old: KbStored | undefined = row
      ? {
          title: str(row.title),
          body: str(row.body),
          by: str(row.by),
          url: row.url ? str(row.url) : null,
          sub: row.sub ? str(row.sub) : null,
          meta: str(row.meta),
        }
      : undefined;
    const next = mergeItem(ref, old, f);
    // Nothing changed: the item keeps its seq, so no rig syncs it again.
    if (old && sameItem(old, next)) return;
    this.db
      .prepare(
        `insert into kb_item (seq, campaign, rig, ledger, run, kind, ref, title, body, by, url, sub, meta, at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(rig, ledger, run, kind, ref) do update set seq = excluded.seq,
           title = excluded.title, body = excluded.body, by = excluded.by, url = excluded.url,
           sub = excluded.sub, meta = excluded.meta, updated_at = excluded.updated_at`,
      )
      .run(
        this.nextSeq(),
        campaign,
        rig,
        ledger,
        run,
        kind,
        ref,
        next.title,
        next.body,
        next.by,
        next.url,
        next.sub,
        next.meta,
        at,
        at,
      );
  }

  /** One event into the folder of its run's campaign (core/kb-index.ts reads it). */
  private index(
    src: { rig: string; ledger: string },
    at: string,
    actor: string,
    kind: string,
    subject: string,
    b: Row,
  ): void {
    indexEvent(this.target(src), { at, actor, kind, subject, body: b });
  }

  /** Every campaign folder (also one with runs and no items yet), newest change first. */
  folders(): KbFolder[] {
    const rows = this.db
      .prepare(
        `select campaign, kind, count(*) as n, max(updated_at) as at,
           sum(case when kind = 'note' and sub in (${JOURNAL_KINDS.map(() => "?").join(", ")}) then 1 else 0 end) as journal
         from kb_item group by campaign, kind`,
      )
      .all(...JOURNAL_KINDS) as Row[];
    type Sum = Pick<KbFolder, "counts" | "items" | "journal" | "updated_at">;
    const by = new Map<string, Sum>();
    const empty = (): Sum => ({ counts: {}, items: 0, journal: 0, updated_at: "" });
    for (const r of rows) {
      const c = str(r.campaign);
      const f = by.get(c) ?? empty();
      f.counts[str(r.kind) as KbKind] = Number(r.n);
      f.items += Number(r.n);
      f.journal += Number(r.journal);
      if (str(r.at) > f.updated_at) f.updated_at = str(r.at);
      by.set(c, f);
    }
    const runs = new Map<string, number>();
    for (const r of this.db
      .prepare("select campaign, count(*) as n from kb_run group by campaign")
      .all() as Row[]) {
      runs.set(str(r.campaign), Number(r.n));
      if (!by.has(str(r.campaign))) by.set(str(r.campaign), empty());
    }
    return [...by.entries()]
      .map(([campaign, f]) => ({
        campaign,
        ...f,
        runs: runs.get(campaign) ?? 0,
        read_by: this.readBy(campaign),
        reads: this.reads(campaign),
      }))
      .sort(
        (a, b) => b.updated_at.localeCompare(a.updated_at) || a.campaign.localeCompare(b.campaign),
      );
  }

  /** One campaign's folder (empty when nothing of it is indexed yet). */
  folder(campaign: string, all = this.folders()): KbFolder {
    return (
      all.find((f) => f.campaign === campaign) ?? {
        campaign,
        counts: {},
        journal: 0,
        items: 0,
        runs: 0,
        updated_at: "",
        read_by: this.readBy(campaign),
        reads: this.reads(campaign),
      }
    );
  }

  /** The folders a campaign reads besides its own. */
  reads(campaign: string): string[] {
    return (
      this.db
        .prepare("select reads from kb_read where campaign = ? order by granted_at, reads")
        .all(campaign) as Row[]
    ).map((r) => str(r.reads));
  }

  /** The campaign folders a campaign's agents may read: its own first, then those granted. */
  readable(campaign: string): string[] {
    return [campaign, ...this.reads(campaign).filter((f) => f !== campaign)];
  }

  /** The campaigns granted to read this one's folder. */
  readBy(campaign: string): string[] {
    return (
      this.db
        .prepare("select campaign from kb_read where reads = ? order by campaign")
        .all(campaign) as Row[]
    ).map((r) => str(r.campaign));
  }

  /** Every campaign a grant names, on either side: names a copy of a campaign may not take. */
  grantNames(): string[] {
    return (
      this.db
        .prepare("select campaign as name from kb_read union select reads from kb_read order by 1")
        .all() as Row[]
    ).map((r) => str(r.name));
  }

  /**
   * Lets a campaign read another folder. Its runs at work receive the folder's items at their
   * next sync, with seqs given now. False: nothing changed (already granted, or its own folder).
   */
  grant(campaign: string, reads: string, by: string): boolean {
    if (!campaign || !reads || campaign === reads) return false;
    return this.tx(() => {
      const added =
        Number(
          this.db
            .prepare(
              "insert or ignore into kb_read (campaign, reads, granted_by, granted_at) values (?, ?, ?, ?)",
            )
            .run(campaign, reads, by, new Date().toISOString()).changes,
        ) > 0;
      if (!added) return added;
      const n = Number(
        (
          this.db.prepare("select count(*) as n from kb_item where campaign = ?").get(reads) as {
            n: number;
          }
        ).n,
      );
      if (n) {
        const base = this.nextSeq(n) - n;
        this.db
          .prepare(
            `insert into kb_grant_item (campaign, reads, item, seq)
             select ?, ?, id, ? + row_number() over (order by seq) from kb_item where campaign = ?`,
          )
          .run(campaign, reads, base, reads);
      }
      return true;
    });
  }

  /** Ends a grant. False: there was none. */
  revoke(campaign: string, reads: string): boolean {
    return this.tx(() => {
      this.db
        .prepare("delete from kb_grant_item where campaign = ? and reads = ?")
        .run(campaign, reads);
      return (
        Number(
          this.db
            .prepare("delete from kb_read where campaign = ? and reads = ?")
            .run(campaign, reads).changes,
        ) > 0
      );
    });
  }

  /** Every word in the title or text, newest first; within the given folders only. */
  search(
    q: string,
    campaigns: string[],
    o: { kinds?: KbKind[]; limit?: number; sub?: string[] } = {},
  ): KbItem[] {
    if (!campaigns.length) return [];
    const words = q
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[%_\\]/g, ""))
      .filter((w) => w.length > 1)
      .slice(0, 8);
    const where = [
      `campaign in (${campaigns.map(() => "?").join(", ")})`,
      ...(o.kinds?.length ? [`kind in (${o.kinds.map(() => "?").join(", ")})`] : []),
      ...(o.sub?.length ? [`sub in (${o.sub.map(() => "?").join(", ")})`] : []),
      ...words.map(() => "lower(title || ' ' || body) like ?"),
    ].join(" and ");
    const rows = this.db
      .prepare(`select * from kb_item where ${where} order by updated_at desc, seq desc limit ?`)
      .all(
        ...campaigns,
        ...(o.kinds ?? []),
        ...(o.sub ?? []),
        ...words.map((w) => `%${w}%`),
        o.limit ?? 50,
      ) as Row[];
    return rows.map(itemOf);
  }

  /** How many items of each kind one run put in its folder (field notes apart). */
  runCounts(
    rig: string,
    ledger: string,
    run: string,
  ): Partial<Record<KbKind, number>> & { journal: number } {
    const out: Partial<Record<KbKind, number>> & { journal: number } = { journal: 0 };
    for (const r of this.db
      .prepare(
        `select kind, count(*) as n,
           sum(case when kind = 'note' and sub in (${JOURNAL_KINDS.map(() => "?").join(", ")}) then 1 else 0 end) as journal
         from kb_item where rig = ? and ledger = ? and run = ? group by kind`,
      )
      .all(...JOURNAL_KINDS, rig, ledger, run) as Row[]) {
      out[str(r.kind) as KbKind] = Number(r.n);
      out.journal += Number(r.journal);
    }
    return out;
  }

  item(id: number): KbItem | undefined {
    const r = this.db.prepare("select * from kb_item where id = ?").get(id) as Row | undefined;
    return r ? itemOf(r) : undefined;
  }

  /**
   * The item a briefing names by where it came from (campaign, run, kind, ref). Undefined when
   * control has none, or more than one (run names are unique per rig only).
   */
  byOrigin(campaign: string, run: string, kind: string, ref: string): KbItem | undefined {
    const rows = this.db
      .prepare(
        "select * from kb_item where campaign = ? and run = ? and kind = ? and ref = ? limit 2",
      )
      .all(campaign, run, kind, ref) as Row[];
    return rows.length === 1 && rows[0] ? itemOf(rows[0]) : undefined;
  }

  /** An experiment's result in words, with its attempt's verdict when the folder has it. */
  resultOf(x: KbItem): string | null {
    if (x.kind !== "experiment") return null;
    const m = /(?:^|\n)(Result|Dropped): (.*)$/s.exec(x.body);
    if (!m) return null;
    const attempt = /^attempt (\S+)/.exec(m[2] ?? "")?.[1];
    const verdict = attempt
      ? /(?:^|\n)Verdict: (.*)$/.exec(
          str(
            (
              this.db
                .prepare(
                  "select body from kb_item where rig = ? and ledger = ? and kind = 'attempt' and ref = ?",
                )
                .get(x.rig, x.ledger, attempt) as { body?: string } | undefined
            )?.body,
          ),
        )?.[1]
      : undefined;
    return `${m[1] === "Dropped" ? "dropped" : "tried"}: ${m[2]}${verdict ? `, ${verdict.replace(/_/g, " ")}` : ""}`;
  }

  /** Items of the given folders changed after a seq, in seq order. */
  changedAfter(campaigns: string[], after: number, limit = SYNC_PAGE): KbItem[] {
    if (!campaigns.length) return [];
    return (
      this.db
        .prepare(
          `select * from kb_item where campaign in (${campaigns.map(() => "?").join(", ")}) and seq > ? order by seq limit ?`,
        )
        .all(...campaigns, after, limit) as Row[]
    ).map(itemOf);
  }

  /** The campaign of a rig's run in its current ledger, if control has seen the run start. */
  runCampaign(rig: string, run: string): string | undefined {
    const ledger = (
      this.db.prepare("select ledger_id from rig where id = ?").get(rig) as
        | { ledger_id: string | null }
        | undefined
    )?.ledger_id;
    return ledger ? this.campaignOf(rig, ledger, run) : undefined;
  }

  /**
   * What a run's supervisor syncs into the run's knowledge/ folder: the items of the folders its
   * campaign may read, changed after `after`, in seq order, at most SYNC_PAGE at once, without
   * the run's own items (it has them). Undefined: the rig has no such run in its current ledger.
   * A grant's copy of an item comes only to a cursor already past the item's own seq; a run that
   * pages through both may still get an item twice, and keeps the newer.
   */
  sync(rig: string, run: string, after: number, limit = SYNC_PAGE): KbSync | undefined {
    const ledger = (
      this.db.prepare("select ledger_id from rig where id = ?").get(rig) as
        | { ledger_id: string | null }
        | undefined
    )?.ledger_id;
    const campaign = ledger ? this.campaignOf(rig, ledger, run) : undefined;
    if (!ledger || !campaign) return undefined;
    const folders = this.readable(campaign);
    const granted = folders.slice(1);
    const marks = (xs: string[]) => xs.map(() => "?").join(", ");
    const notOwn = "not (i.rig = ? and i.ledger = ? and i.run = ?)";
    const own = [rig, ledger, run];
    const rows = this.db
      .prepare(
        `select i.*, i.seq as s from kb_item i
         where i.campaign in (${marks(folders)}) and i.seq > ? and ${notOwn}
         ${
           granted.length
             ? `union all
         select i.*, g.seq as s from kb_grant_item g join kb_item i on i.id = g.item
         where g.campaign = ? and g.reads in (${marks(granted)}) and g.seq > ? and i.seq <= ?
           and ${notOwn}`
             : ""
         }
         order by s limit ?`,
      )
      .all(
        ...folders,
        after,
        ...own,
        ...(granted.length ? [campaign, ...granted, after, after, ...own] : []),
        limit + 1,
      ) as Row[];
    const page = rows.slice(0, limit);
    const items: KbItemWire[] = page.map((r) => {
      const x = itemOf(r);
      return {
        seq: Number(r.s),
        campaign: x.campaign,
        rig: x.rig,
        run: x.run,
        kind: x.kind,
        ref: x.ref,
        title: x.title,
        body: x.body,
        by: x.by,
        url: x.url,
        sub: x.sub,
        at: x.at,
        updated_at: x.updated_at,
      };
    });
    return {
      campaign,
      folders,
      items,
      next: items.at(-1)?.seq ?? after,
      more: rows.length > limit,
    };
  }
}

function itemOf(r: Row): KbItem {
  let meta: Record<string, string> = {};
  try {
    const m = JSON.parse(str(r.meta) || "{}") as Record<string, unknown>;
    meta = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, str(v)] as const)) as Record<
      string,
      string
    >;
  } catch {
    // meta is written by this module as JSON; anything else reads as none
  }
  return {
    id: Number(r.id),
    seq: Number(r.seq),
    campaign: str(r.campaign),
    rig: str(r.rig),
    ledger: str(r.ledger),
    run: str(r.run),
    kind: str(r.kind) as KbKind,
    ref: str(r.ref),
    title: str(r.title),
    body: str(r.body),
    by: str(r.by),
    url: r.url ? str(r.url) : null,
    sub: r.sub ? str(r.sub) : null,
    meta,
    at: str(r.at),
    updated_at: str(r.updated_at),
  };
}

/** The kinds the owner can pick from past research when starting a run, and where each goes. */
export const PICKABLE: Partial<Record<KbKind, "queue" | "briefing">> = {
  experiment: "queue",
  finding: "briefing",
  claim: "briefing",
  note: "briefing",
  report: "briefing",
};

/**
 * A past experiment the owner picked, for a new run's queue: what it tried, who added it and
 * why, and what it gave in its run. Undefined when its run's name is not an id a seed can carry.
 */
export function queueSeedOf(x: KbItem, result: string | null): QueueSeed | undefined {
  if (x.kind !== "experiment" || !IdSchema.safeParse(x.run).success) return undefined;
  const details = [
    x.meta.details ?? "",
    result ? `In ${x.run} (${x.campaign}) it was ${result}.` : `From ${x.run} (${x.campaign}).`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title: clip(x.title, 200),
    ...(details ? { details: clip(details, 4000) } : {}),
    ...(x.meta.family ? { family: clip(x.meta.family, 80) } : {}),
    ...(x.meta.why ? { why: clip(x.meta.why, 2000) } : {}),
    by: clip(x.by || "copied", 80),
    state: "queued",
    from: { run: x.run, id: clip(x.ref, 64) },
  };
}

/** A past finding, claim, note or report the owner picked, as background for every brief. */
export function briefingSeedOf(x: KbItem): BriefingSeed | undefined {
  if (PICKABLE[x.kind] !== "briefing" || !IdSchema.safeParse(x.run).success) return undefined;
  const text = clip(
    x.kind === "report" || x.body.startsWith(x.title.replace(/…$/, ""))
      ? x.body
      : `${x.title}\n${x.body}`,
    4000,
  ).trim();
  if (!text) return undefined;
  return {
    text,
    from: { campaign: x.campaign, run: x.run, kind: x.kind, ref: x.ref },
  };
}
