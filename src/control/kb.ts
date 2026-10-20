import type { DatabaseSync } from "node:sqlite";

/**
 * Thermite's own knowledge base (goal 065): one folder for each campaign, built from what its
 * runs report. Control indexes the rigs' events as they arrive: the agents' field notes, the
 * experiments with their results, attempts, sources, claims, findings and reports. A campaign
 * reads its own folder and, when the owner grants it, other campaigns' folders. Agents only read
 * folders; the folders are written from the rigs' signed events alone.
 */

export type KbKind = "note" | "experiment" | "attempt" | "source" | "claim" | "finding" | "report";

export interface KbItem {
  id: number;
  campaign: string;
  rig: string;
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
  at: string;
  updated_at: string;
}

const SCHEMA = `
create table if not exists kb_item (
  id integer primary key autoincrement,
  campaign text not null,
  rig text not null,
  run text not null,
  kind text not null,
  ref text not null,
  title text not null,
  body text not null,
  by text not null,
  url text,
  sub text,
  at text not null,
  updated_at text not null,
  unique (rig, run, kind, ref)
);
create index if not exists kb_item_campaign on kb_item (campaign, kind);
create table if not exists kb_run (
  rig text not null,
  run text not null,
  campaign text not null,
  primary key (rig, run)
);
create table if not exists kb_cursor (
  id integer primary key check (id = 1),
  seq integer not null
);
create table if not exists kb_read (
  campaign text not null,
  reads text not null,
  granted_by text not null,
  granted_at text not null,
  primary key (campaign, reads)
);
`;

type Row = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class KnowledgeBase {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(SCHEMA);
  }

  /** Indexes the events control received since the last call (only rigs' current ledgers). */
  catchUp(): number {
    const cur =
      (
        this.db.prepare("select seq from kb_cursor where id = 1").get() as
          | { seq: number }
          | undefined
      )?.seq ?? 0;
    const rows = this.db
      .prepare(
        `select e.seq, e.rig, e.at, e.actor, e.kind, e.subject, e.body from rig_event e
         join rig r on r.id = e.rig and r.ledger_id = e.ledger_id
         where e.seq > ? order by e.seq limit 5000`,
      )
      .all(cur) as Row[];
    let last = cur;
    for (const r of rows) {
      last = Number(r.seq);
      try {
        this.index(
          str(r.rig),
          str(r.at),
          str(r.actor),
          str(r.kind),
          str(r.subject),
          JSON.parse(str(r.body)),
        );
      } catch {
        // an event body this index can't read: skipped, never fatal
      }
    }
    if (last !== cur)
      this.db
        .prepare(
          "insert into kb_cursor (id, seq) values (1, ?) on conflict(id) do update set seq = excluded.seq",
        )
        .run(last);
    return rows.length;
  }

  private campaignOf(rig: string, run: string): string | undefined {
    return (
      this.db.prepare("select campaign from kb_run where rig = ? and run = ?").get(rig, run) as
        | { campaign: string }
        | undefined
    )?.campaign;
  }

  private put(
    rig: string,
    run: string,
    kind: KbKind,
    ref: string,
    f: { title?: string; body?: string; by?: string; url?: string | null; sub?: string | null },
    at: string,
  ): void {
    const campaign = this.campaignOf(rig, run);
    if (!campaign || !ref) return;
    const old = this.db
      .prepare(
        "select title, body, by, url, sub from kb_item where rig = ? and run = ? and kind = ? and ref = ?",
      )
      .get(rig, run, kind, ref) as Row | undefined;
    const title = clip(f.title ?? str(old?.title), 300);
    const body = clip(f.body ?? str(old?.body), 20_000);
    this.db
      .prepare(
        `insert into kb_item (campaign, rig, run, kind, ref, title, body, by, url, sub, at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(rig, run, kind, ref) do update set title = excluded.title, body = excluded.body,
           by = excluded.by, url = excluded.url, sub = excluded.sub, updated_at = excluded.updated_at`,
      )
      .run(
        campaign,
        rig,
        run,
        kind,
        ref,
        title || ref,
        body,
        f.by ?? (str(old?.by) || "harness"),
        f.url ?? (old?.url ? str(old.url) : null),
        f.sub ?? (old?.sub ? str(old.sub) : null),
        at,
        at,
      );
  }

  /** One event into the folder of its run's campaign. */
  private index(
    rig: string,
    at: string,
    actor: string,
    kind: string,
    subject: string,
    b: Row,
  ): void {
    const run = str(b.run) || subject;
    switch (kind) {
      case "run_created":
        if (str(b.campaign))
          this.db
            .prepare(
              "insert into kb_run (rig, run, campaign) values (?, ?, ?) on conflict(rig, run) do update set campaign = excluded.campaign",
            )
            .run(rig, subject, str(b.campaign));
        return;
      case "journal_note":
        this.put(
          rig,
          run,
          "note",
          str(b.id),
          {
            title: clip(str(b.text), 120),
            body: [
              str(b.text),
              b.about ? `About: ${str((b.about as Row).type)} ${str((b.about as Row).id)}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            by: str(b.by) || actor,
            url: b.source ? str((b.source as Row).url) || null : null,
            sub: str(b.kind) || "note",
          },
          at,
        );
        return;
      case "experiment_added":
        this.put(
          rig,
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
          },
          at,
        );
        return;
      case "experiment_finished":
      case "experiment_dropped": {
        const old = this.db
          .prepare(
            "select body from kb_item where rig = ? and run = ? and kind = 'experiment' and ref = ?",
          )
          .get(rig, run, str(b.id)) as { body: string } | undefined;
        if (!old) return;
        const result =
          kind === "experiment_dropped"
            ? `Dropped: ${str(b.why)}`
            : `Result: ${str(b.attempt) ? `attempt ${str(b.attempt)}` : "no attempt"}${str(b.result) ? ` (${str(b.result)})` : ""}`;
        this.put(
          rig,
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
          rig,
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
          .prepare("select run, body from kb_item where rig = ? and kind = 'attempt' and ref = ?")
          .get(rig, subject) as { run: string; body: string } | undefined;
        const verdict = str(b.verdict);
        if (old && verdict)
          this.put(
            rig,
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
          rig,
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
          rig,
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
          rig,
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
            rig,
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

  /** Every campaign folder: its items by kind, its newest change, and who may read it. */
  folders(): {
    campaign: string;
    counts: Partial<Record<KbKind, number>>;
    items: number;
    updated_at: string;
    read_by: string[];
  }[] {
    const rows = this.db
      .prepare(
        "select campaign, kind, count(*) as n, max(updated_at) as at from kb_item group by campaign, kind",
      )
      .all() as Row[];
    const by = new Map<
      string,
      { counts: Partial<Record<KbKind, number>>; items: number; updated_at: string }
    >();
    for (const r of rows) {
      const c = str(r.campaign);
      const f = by.get(c) ?? { counts: {}, items: 0, updated_at: "" };
      f.counts[str(r.kind) as KbKind] = Number(r.n);
      f.items += Number(r.n);
      if (str(r.at) > f.updated_at) f.updated_at = str(r.at);
      by.set(c, f);
    }
    return [...by.entries()]
      .map(([campaign, f]) => ({ campaign, ...f, read_by: this.readBy(campaign) }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** The folders a campaign reads besides its own (campaigns, or "outside:<name>"). */
  reads(campaign: string): string[] {
    return (
      this.db
        .prepare("select reads from kb_read where campaign = ? order by granted_at")
        .all(campaign) as Row[]
    ).map((r) => str(r.reads));
  }

  /** The campaigns granted to read this one's folder. */
  readBy(campaign: string): string[] {
    return (
      this.db
        .prepare("select campaign from kb_read where reads = ? order by campaign")
        .all(campaign) as Row[]
    ).map((r) => str(r.campaign));
  }

  grant(campaign: string, reads: string, by: string): void {
    if (!campaign || !reads || campaign === reads) return;
    this.db
      .prepare(
        "insert or ignore into kb_read (campaign, reads, granted_by, granted_at) values (?, ?, ?, ?)",
      )
      .run(campaign, reads, by, new Date().toISOString());
  }

  revoke(campaign: string, reads: string): boolean {
    return (
      Number(
        this.db.prepare("delete from kb_read where campaign = ? and reads = ?").run(campaign, reads)
          .changes,
      ) > 0
    );
  }

  /** Every word in the title or text, newest first; within the given folders only. */
  search(q: string, campaigns: string[], o: { kinds?: KbKind[]; limit?: number } = {}): KbItem[] {
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
      ...words.map(() => "lower(title || ' ' || body) like ?"),
    ].join(" and ");
    const rows = this.db
      .prepare(`select * from kb_item where ${where} order by updated_at desc limit ?`)
      .all(...campaigns, ...(o.kinds ?? []), ...words.map((w) => `%${w}%`), o.limit ?? 50) as Row[];
    return rows.map(itemOf);
  }

  /** Items of one run, of one kind, newest first. */
  ofRun(rig: string, run: string, kind: KbKind, limit = 500): KbItem[] {
    return (
      this.db
        .prepare(
          "select * from kb_item where rig = ? and run = ? and kind = ? order by at desc limit ?",
        )
        .all(rig, run, kind, limit) as Row[]
    ).map(itemOf);
  }

  item(id: number): KbItem | undefined {
    const r = this.db.prepare("select * from kb_item where id = ?").get(id) as Row | undefined;
    return r ? itemOf(r) : undefined;
  }

  /** Items of the given folders changed after `after` (an item id is not a time: by updated_at). */
  since(campaigns: string[], after: string, limit = 2000): KbItem[] {
    if (!campaigns.length) return [];
    return (
      this.db
        .prepare(
          `select * from kb_item where campaign in (${campaigns.map(() => "?").join(", ")}) and updated_at > ? order by updated_at limit ?`,
        )
        .all(...campaigns, after, limit) as Row[]
    ).map(itemOf);
  }
}

function itemOf(r: Row): KbItem {
  return {
    id: Number(r.id),
    campaign: str(r.campaign),
    rig: str(r.rig),
    run: str(r.run),
    kind: str(r.kind) as KbKind,
    ref: str(r.ref),
    title: str(r.title),
    body: str(r.body),
    by: str(r.by),
    url: r.url ? str(r.url) : null,
    sub: r.sub ? str(r.sub) : null,
    at: str(r.at),
    updated_at: str(r.updated_at),
  };
}
