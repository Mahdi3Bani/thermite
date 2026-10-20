import type { DatabaseSync } from "node:sqlite";
import type { BriefingSeed, QueueSeed } from "../core/commands.ts";
import { IdSchema } from "../core/contract.ts";
import type { KbItemWire, KbKind, KbSync } from "../core/kb.ts";

/**
 * Thermite's own knowledge base (goal 065): one folder for each campaign, built from what its
 * runs report. Control indexes the rigs' events as they arrive: the agents' field notes, the
 * experiments with their results, attempts, sources, claims, findings and reports. A campaign
 * reads its own folder and, when the owner grants it, other campaigns' folders. Agents only read
 * folders; the folders are written from the rigs' signed events alone.
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

const SCHEMA = `
create table if not exists kb_item (
  id integer primary key autoincrement,
  -- From kb_cursor.item_seq, given again on every update: what a rig's sync reads after.
  seq integer not null,
  campaign text not null,
  rig text not null,
  -- The rig's ledger: after a reset, its new runs' items never mix with the old ones.
  ledger text not null,
  run text not null,
  kind text not null,
  ref text not null,
  title text not null,
  body text not null,
  by text not null,
  url text,
  sub text,
  meta text not null default '{}',
  at text not null,
  updated_at text not null,
  unique (rig, ledger, run, kind, ref)
);
create index if not exists kb_item_campaign on kb_item (campaign, kind);
create index if not exists kb_item_seq on kb_item (campaign, seq);
create table if not exists kb_run (
  rig text not null,
  ledger text not null,
  run text not null,
  campaign text not null,
  primary key (rig, ledger, run)
);
-- seq: the last rig event indexed; item_seq: the last seq given to an item or a grant's copy.
create table if not exists kb_cursor (
  id integer primary key check (id = 1),
  seq integer not null,
  item_seq integer not null
);
insert or ignore into kb_cursor (id, seq, item_seq) values (1, 0, 0);
create table if not exists kb_read (
  campaign text not null,
  reads text not null,
  granted_by text not null,
  granted_at text not null,
  primary key (campaign, reads)
);
-- A grant gives the granted folder's items seqs of their own for the grantee, so a run at work,
-- whose cursor is past those items' seqs, still receives the folder it may now read.
create table if not exists kb_grant_item (
  campaign text not null,
  reads text not null,
  item integer not null,
  seq integer not null,
  primary key (campaign, reads, item)
);
create index if not exists kb_grant_item_seq on kb_grant_item (campaign, seq);
`;

type Row = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Events read per transaction while catching up. */
const PAGE = 2000;
/** Items a rig's sync answers at most at once (it asks again while `more` is true). */
export const SYNC_PAGE = 500;
/** An outside knowledge base in a campaign's grants (goal 065, optional): not a folder here. */
export const isOutside = (folder: string) => folder.startsWith("outside:");

export class KnowledgeBase {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(SCHEMA);
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

  private put(
    src: { rig: string; ledger: string },
    run: string,
    kind: KbKind,
    rawRef: string,
    f: {
      title?: string;
      body?: string;
      by?: string;
      url?: string | null;
      sub?: string | null;
      meta?: Record<string, string>;
    },
    at: string,
  ): void {
    const { rig, ledger } = src;
    const campaign = this.campaignOf(rig, ledger, run);
    const ref = clip(rawRef, 200);
    if (!campaign || !ref) return;
    const old = this.db
      .prepare(
        "select title, body, by, url, sub, meta from kb_item where rig = ? and ledger = ? and run = ? and kind = ? and ref = ?",
      )
      .get(rig, ledger, run, kind, ref) as Row | undefined;
    const next = {
      title: clip(f.title ?? str(old?.title), 300) || ref,
      body: clip(f.body ?? str(old?.body), 20_000),
      by: clip(f.by ?? (str(old?.by) || "harness"), 200),
      url: (() => {
        const u = f.url !== undefined ? f.url : old?.url ? str(old.url) : null;
        return u && u.length <= 2000 ? u : null;
      })(),
      sub: (() => {
        const s = f.sub !== undefined ? f.sub : old?.sub ? str(old.sub) : null;
        return s ? clip(s, 40) : null;
      })(),
      meta: f.meta ? JSON.stringify(f.meta) : str(old?.meta) || "{}",
    };
    // Nothing changed: the item keeps its seq, so no rig syncs it again.
    if (
      old &&
      next.title === str(old.title) &&
      next.body === str(old.body) &&
      next.by === str(old.by) &&
      next.url === (old.url ? str(old.url) : null) &&
      next.sub === (old.sub ? str(old.sub) : null) &&
      next.meta === str(old.meta)
    )
      return;
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

  /** One event into the folder of its run's campaign. */
  private index(
    src: { rig: string; ledger: string },
    at: string,
    actor: string,
    kind: string,
    subject: string,
    b: Row,
  ): void {
    const { rig, ledger } = src;
    const run = str(b.run) || subject;
    switch (kind) {
      case "run_created": {
        // Filed under the campaign control assigned this run on this rig. A run control did not
        // assign keeps the campaign its event names, unless control assigned that campaign
        // somewhere: a rig cannot file items into a campaign it was not given.
        const named = str(b.campaign);
        const assigned = this.assigned(rig, subject);
        const campaign = assigned ?? (named && !this.assignedAnywhere(named) ? named : "");
        if (campaign)
          this.db
            .prepare(
              "insert into kb_run (rig, ledger, run, campaign) values (?, ?, ?, ?) on conflict(rig, ledger, run) do update set campaign = excluded.campaign",
            )
            .run(rig, ledger, subject, campaign);
        return;
      }
      case "journal_note": {
        const about = b.about && typeof b.about === "object" ? (b.about as Row) : undefined;
        this.put(
          src,
          run,
          "note",
          str(b.id),
          {
            title: clip(str(b.text), 120),
            body: [str(b.text), about ? `About: ${str(about.type)} ${str(about.id)}` : ""]
              .filter(Boolean)
              .join("\n"),
            by: str(b.by) || actor,
            url: b.source ? str((b.source as Row).url) || null : null,
            sub: str(b.kind) || "note",
          },
          at,
        );
        return;
      }
      // A research note (goal 065: in any mode), apart from the field notes: its own ref.
      case "research_note": {
        const sources = Array.isArray(b.sources) ? b.sources.map(String) : [];
        this.put(
          src,
          run,
          "note",
          `rn-${str(b.note)}`,
          {
            title: clip(str(b.text), 120),
            body: [str(b.text), sources.length ? `Sources: ${sources.join(", ")}` : ""]
              .filter(Boolean)
              .join("\n"),
            by: str(b.by) || actor,
            url: str(b.url) || null,
            sub: "note",
          },
          at,
        );
        return;
      }
      case "experiment_added":
        this.put(
          src,
          run,
          "experiment",
          str(b.id),
          {
            title: str(b.title),
            body: [
              str(b.details),
              b.why ? `Why: ${str(b.why)}` : "",
              b.family ? `Direction: ${str(b.family)}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            by: str(b.by) || actor,
            meta: { details: str(b.details), why: str(b.why), family: str(b.family) },
          },
          at,
        );
        return;
      case "experiment_finished":
      case "experiment_dropped": {
        const old = this.db
          .prepare(
            "select body from kb_item where rig = ? and ledger = ? and run = ? and kind = 'experiment' and ref = ?",
          )
          .get(rig, ledger, run, clip(str(b.id), 200)) as { body: string } | undefined;
        if (!old) return;
        const result =
          kind === "experiment_dropped"
            ? `Dropped: ${str(b.why)}`
            : `Result: ${str(b.attempt) ? `attempt ${str(b.attempt)}` : "no attempt"}${str(b.result) ? ` (${str(b.result)})` : ""}`;
        this.put(
          src,
          run,
          "experiment",
          str(b.id),
          { body: `${old.body.replace(/\n?(Result|Dropped): .*$/s, "")}\n${result}`.trim() },
          at,
        );
        return;
      }
      case "attempt_recorded":
        this.put(
          src,
          run,
          "attempt",
          subject || str(b.attempt),
          {
            title: str(b.hypothesis) || subject,
            body: [
              str(b.hypothesis),
              str(b.claim) ? `Claim: ${str(b.claim)}` : "",
              Array.isArray(b.known_flaws) && b.known_flaws.length
                ? `Declared flaws: ${b.known_flaws.map(str).join("; ")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
            by: str(b.lane) || actor,
          },
          at,
        );
        return;
      case "verdict": {
        // A verdict names its attempt (the subject); the attempt's item says which run it is in.
        const old = this.db
          .prepare(
            "select run, body from kb_item where rig = ? and ledger = ? and kind = 'attempt' and ref = ?",
          )
          .get(rig, ledger, subject) as { run: string; body: string } | undefined;
        const verdict = str(b.verdict);
        if (old && verdict)
          this.put(
            src,
            old.run,
            "attempt",
            subject,
            {
              body: `${old.body.replace(/\n?Verdict: .*$/s, "")}\nVerdict: ${verdict}${typeof b.delta === "number" ? ` (${b.delta >= 0 ? "+" : ""}${(b.delta * 100).toFixed(2)}%)` : ""}`.trim(),
            },
            at,
          );
        return;
      }
      case "source_fetched":
        this.put(
          src,
          run,
          "source",
          str(b.source),
          {
            title: str(b.title) || str(b.url) || str(b.domain) || str(b.source),
            body: [str(b.url), str(b.domain)].filter(Boolean).join("\n"),
            by: actor,
            url: str(b.url) || null,
          },
          at,
        );
        return;
      case "claim_added":
        this.put(
          src,
          run,
          "claim",
          str(b.claim),
          {
            title: str(b.text) || str(b.quote) || `claim ${str(b.claim)}`,
            body: [
              str(b.text),
              str(b.quote) ? `“${str(b.quote)}”` : "",
              b.verified === true ? "Verified against its source." : "A draft: not verified yet.",
              b.question !== undefined ? `Question ${str(b.question)}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            by: actor,
            sub: b.verified === true ? "verified" : "draft",
          },
          at,
        );
        return;
      case "finding_added":
        this.put(
          src,
          run,
          "finding",
          str(b.finding),
          {
            title: str(b.statement) || str(b.text) || `finding ${str(b.finding)}`,
            body: [
              str(b.statement),
              str(b.summary),
              str(b.why) ? `Why it matters: ${str(b.why)}` : "",
              `${str(b.claims)} supporting claims${b.supported === false ? " (not all verified)" : ""}`,
            ]
              .filter(Boolean)
              .join("\n"),
            by: actor,
          },
          at,
        );
        return;
      case "research_final":
      case "research_digest":
        if (str(b.report))
          this.put(
            src,
            run,
            "report",
            kind === "research_final" ? "final" : "digest",
            {
              title: kind === "research_final" ? "Final report" : "Latest digest",
              body: str(b.report),
              by: "research",
            },
            at,
          );
        return;
    }
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

  /** The folders a campaign reads besides its own (campaigns, or "outside:<name>"). */
  reads(campaign: string): string[] {
    return (
      this.db
        .prepare("select reads from kb_read where campaign = ? order by granted_at, reads")
        .all(campaign) as Row[]
    ).map((r) => str(r.reads));
  }

  /** The campaign folders a campaign's agents may read: its own first, then those granted. */
  readable(campaign: string): string[] {
    return [campaign, ...this.reads(campaign).filter((f) => !isOutside(f) && f !== campaign)];
  }

  /** The campaigns granted to read this one's folder. */
  readBy(campaign: string): string[] {
    return (
      this.db
        .prepare("select campaign from kb_read where reads = ? order by campaign")
        .all(campaign) as Row[]
    ).map((r) => str(r.campaign));
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
      if (!added || isOutside(reads)) return added;
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

  /** Items of the given folders changed after a seq, in seq order (an outside copy's cursor). */
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
