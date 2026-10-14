import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../core/canonical.ts";
import type { ResearchContract } from "../../core/contract.ts";
import { parseDuration } from "../../core/duration.ts";
import type { Ledger } from "../ledger.ts";
import { Fetcher, FetchRefused, htmlToText } from "./fetcher.ts";

/**
 * Research mode's integrity rules, enforced by code (the research form of "agents never judge"):
 *
 * - a claim is verified only when every quote appears verbatim in the archived text of a source
 *   the harness itself fetched; anything else stays a draft;
 * - sources are deduplicated by URL and by content hash;
 * - reports show verified claims as findings, drafts never, and flag numbers that appear in no
 *   source or claim;
 * - the harness owns the clock: workers cannot end a campaign.
 */

type Row = Record<string, unknown>;

/** Whitespace folded, typographic quotes and dashes made plain: "verbatim" up to layout. */
export function normalizeQuote(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const ClaimInput = z.object({
  text: z.string().min(5).max(4000),
  quotes: z
    .array(z.object({ source: z.string().min(1), quote: z.string().min(8).max(2000) }))
    .min(1)
    .max(10),
  question: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export class Research {
  private readonly ledger: Ledger;
  private readonly stateDir: string;
  private readonly fetchers = new Map<string, Fetcher>();
  private readonly allowPrivate: boolean;

  constructor(ledger: Ledger, stateDir: string, opts: { allowPrivate?: boolean } = {}) {
    this.ledger = ledger;
    this.stateDir = stateDir;
    this.allowPrivate = opts.allowPrivate ?? false;
  }

  private contract(instance: string): ResearchContract {
    const inst = this.ledger.getInstance(instance);
    if (!inst) throw new Error(`no instance ${instance}`);
    const c = this.ledger.getContract(inst.campaign, inst.version);
    if (c?.mode !== "research") throw new Error(`${instance} is not a research campaign`);
    return c;
  }

  private fetcher(instance: string): Fetcher {
    let f = this.fetchers.get(instance);
    if (!f) {
      const c = this.contract(instance);
      f = new Fetcher(
        {
          respectRobots: c.fetch_policy.respect_robots,
          perDomainPerMinute: c.fetch_policy.per_domain_per_minute,
          maxBytes: c.fetch_policy.max_bytes,
          includeDomains: c.scope.include_domains,
          excludeDomains: c.scope.exclude_domains,
          allowPrivate: this.allowPrivate,
        },
        join(this.stateDir, "research", instance),
      );
      this.fetchers.set(instance, f);
    }
    return f;
  }

  private all(sql: string, ...p: (string | number | null)[]): Row[] {
    return this.ledger.db.prepare(sql).all(...p) as Row[];
  }

  private get(sql: string, ...p: (string | number | null)[]): Row | undefined {
    return this.ledger.db.prepare(sql).get(...p) as Row | undefined;
  }

  private text(source: Row): string {
    return readFileSync(String(source.text_path), "utf8");
  }

  async fetch(instance: string, lane: string | null, url: string) {
    const existing = this.get("select * from source where instance = ? and url = ?", instance, url);
    if (existing) return this.view(existing, "already archived");
    let f: Awaited<ReturnType<Fetcher["fetch"]>>;
    try {
      f = await this.fetcher(instance).fetch(url);
    } catch (err) {
      const reason =
        err instanceof FetchRefused
          ? err.message
          : `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      this.ledger.appendEvent(lane ?? "research", "fetch_refused", instance, {
        url: url.slice(0, 500),
        reason,
      });
      return { refused: reason };
    }
    const same = this.get(
      "select * from source where instance = ? and sha256 = ?",
      instance,
      f.sha256,
    );
    if (same) return this.view(same, "the same content is already archived under this id", f.links);
    const id = `s-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          `insert into source (id, instance, url, final_url, domain, fetched_at, http_status, content_type, bytes, sha256,
             title, raw_path, text_path, fetched_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          instance,
          f.url,
          f.finalUrl,
          f.domain,
          new Date().toISOString(),
          f.status,
          f.contentType,
          f.bytes,
          f.sha256,
          f.title,
          f.rawPath,
          f.textPath,
          lane ?? "research",
        );
      this.ledger.appendEvent(lane ?? "research", "source_fetched", instance, {
        source: id,
        domain: f.domain,
        status: f.status,
        bytes: f.bytes,
      });
    });
    const row = this.get("select * from source where id = ?", id) as Row;
    return this.view(row, undefined, f.links);
  }

  private view(source: Row, note?: string, links: string[] = []) {
    const text = this.text(source);
    return {
      source: String(source.id),
      url: String(source.url),
      title: source.title === null ? null : String(source.title),
      status: Number(source.http_status),
      ...(note ? { note } : {}),
      chars: text.length,
      text: text.slice(0, 6000),
      links: links.slice(0, 60),
    };
  }

  read(instance: string, source: string, offset = 0, length = 6000) {
    const s = this.get("select * from source where instance = ? and id = ?", instance, source);
    if (!s) throw new Error(`no source ${source}`);
    const text = this.text(s);
    return {
      source,
      url: String(s.url),
      chars: text.length,
      offset,
      text: text.slice(offset, offset + Math.min(length, 20_000)),
    };
  }

  searchCorpus(instance: string, pattern: string) {
    const re = new RegExp(pattern, "i");
    const out: { source: string; url: string; excerpt: string }[] = [];
    for (const s of this.all(
      "select * from source where instance = ? order by fetched_at",
      instance,
    )) {
      const text = this.text(s);
      const m = re.exec(text);
      if (m) {
        out.push({
          source: String(s.id),
          url: String(s.url),
          excerpt: text.slice(Math.max(0, m.index - 200), m.index + 300),
        });
        if (out.length >= 30) break;
      }
    }
    return { matches: out };
  }

  /** Web search: every query is checked against the contract's search policy and logged. */
  search(instance: string, lane: string | null, query: string) {
    const c = this.contract(instance);
    const blocked = (c.search_policy?.blocked_patterns ?? []).find((p) =>
      new RegExp(p, "i").test(query),
    );
    const reason = blocked
      ? `blocked by the search policy (${blocked})`
      : "no search provider is configured for this unit (an owner decision, D27): fetch URLs from the seeds and the links of archived sources";
    this.ledger.db
      .prepare(
        "insert into research_query (instance, lane, query, allowed, reason, created_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(instance, lane, query.slice(0, 500), 0, reason, new Date().toISOString());
    return { results: [], note: reason };
  }

  addClaim(instance: string, lane: string | null, input: unknown) {
    const c = ClaimInput.parse(input);
    const problems: string[] = [];
    for (const q of c.quotes) {
      const s = this.get("select * from source where instance = ? and id = ?", instance, q.source);
      if (!s) {
        problems.push(`no archived source ${q.source}`);
        continue;
      }
      if (!normalizeQuote(this.text(s)).includes(normalizeQuote(q.quote))) {
        problems.push(`quote not found verbatim in ${q.source}: "${q.quote.slice(0, 80)}"`);
      }
    }
    const id = `c-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const verified = problems.length === 0;
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          "insert into claim (id, instance, lane, question, text, quotes, verified, problems, confidence, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          instance,
          lane,
          c.question ?? null,
          c.text,
          canonicalJson(c.quotes),
          verified ? 1 : 0,
          canonicalJson(problems),
          c.confidence ?? null,
          new Date().toISOString(),
        );
      this.ledger.appendEvent(lane ?? "research", "claim_added", instance, {
        claim: id,
        verified,
        question: c.question ?? null,
      });
    });
    return { claim: id, verified, problems };
  }

  addNote(instance: string, lane: string | null, text: string, sources: string[] = []) {
    const r = this.ledger.db
      .prepare(
        "insert into note (instance, lane, text, sources, created_at) values (?, ?, ?, ?, ?)",
      )
      .run(
        instance,
        lane,
        text.slice(0, 4000),
        canonicalJson(sources.slice(0, 20)),
        new Date().toISOString(),
      );
    return { note: Number(r.lastInsertRowid) };
  }

  proposeHypothesis(
    instance: string,
    lane: string | null,
    text: string,
    supporting: string[] = [],
  ) {
    const known = new Set(
      this.all("select id from claim where instance = ? and verified = 1", instance).map((r) =>
        String(r.id),
      ),
    );
    const ok = supporting.filter((c) => known.has(c));
    const id = `h-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.ledger.db
      .prepare(
        "insert into hypothesis (id, instance, lane, text, supporting, created_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(id, instance, lane, text.slice(0, 2000), canonicalJson(ok), new Date().toISOString());
    return { hypothesis: id, supporting: ok, ignored: supporting.filter((c) => !known.has(c)) };
  }

  updateSection(instance: string, by: string, name: string, body: string) {
    if (!/^[a-z0-9][a-z0-9 _-]{0,59}$/i.test(name))
      throw new Error("section names are short words");
    this.ledger.db
      .prepare(
        `insert into report_section (instance, name, body, updated_by, updated_at) values (?, ?, ?, ?, ?)
         on conflict (instance, name) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(instance, name, body.slice(0, 20_000), by, new Date().toISOString());
    return { section: name };
  }

  /** Elapsed time against the contract's durations. */
  clock(instance: string) {
    const c = this.contract(instance);
    const created = String(
      this.get("select created_at from instance where id = ?", instance)?.created_at,
    );
    const elapsedMs = Date.now() - Date.parse(created);
    const minMs = parseDuration(c.min_duration as string);
    const maxMs = c.max_duration ? parseDuration(c.max_duration) : minMs;
    return {
      started_at: created,
      elapsed_ms: elapsedMs,
      min_ms: minMs,
      max_ms: maxMs,
      done: elapsedMs >= maxMs,
    };
  }

  stats(instance: string) {
    const c = this.contract(instance);
    const n = (sql: string, ...p: (string | number)[]) => Number(this.get(sql, ...p)?.n ?? 0);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    return {
      sources: n("select count(*) as n from source where instance = ?", instance),
      domains: n("select count(distinct domain) as n from source where instance = ?", instance),
      verified: n("select count(*) as n from claim where instance = ? and verified = 1", instance),
      drafts: n("select count(*) as n from claim where instance = ? and verified = 0", instance),
      hypotheses: n("select count(*) as n from hypothesis where instance = ?", instance),
      questions: c.questions.map((q, i) => ({
        question: q,
        verified: n(
          "select count(*) as n from claim where instance = ? and question = ? and verified = 1",
          instance,
          i,
        ),
      })),
      last_hour: {
        sources: n(
          "select count(*) as n from source where instance = ? and fetched_at > ?",
          instance,
          hourAgo,
        ),
        verified: n(
          "select count(*) as n from claim where instance = ? and verified = 1 and created_at > ?",
          instance,
          hourAgo,
        ),
      },
    };
  }

  /**
   * A report version from the ledger: sections, the verified claims with their sources, the
   * hypotheses with their support, the open questions, and numbers in the sections that appear
   * in no archived source and no verified claim (flagged, not hidden).
   */
  report(instance: string, kind: "digest" | "final") {
    const c = this.contract(instance);
    const stats = this.stats(instance);
    const clock = this.clock(instance);
    const sources = new Map(
      this.all("select id, url, title, text_path from source where instance = ?", instance).map(
        (s) => [String(s.id), s],
      ),
    );
    const claims = this.all(
      "select * from claim where instance = ? and verified = 1 order by created_at",
      instance,
    );
    const sections = this.all(
      "select name, body from report_section where instance = ? order by name",
      instance,
    );
    const evidence = [
      ...claims.map((cl) => `${cl.text} ${cl.quotes}`),
      ...[...sources.values()].map((s) => this.text(s)),
    ].join("\n");
    const unsupported: string[] = [];
    for (const s of sections) {
      for (const m of String(s.body).matchAll(/\b\d[\d,.]*\d\b|\b\d\b/g)) {
        if (!evidence.includes(m[0]) && !unsupported.includes(m[0])) unsupported.push(m[0]);
      }
    }
    const lines = [
      `# ${c.title}`,
      "",
      `Topic: ${c.topic}`,
      `Report: ${kind}, ${new Date().toISOString()}. Elapsed ${(clock.elapsed_ms / 3_600_000).toFixed(2)} h of at least ${(clock.min_ms / 3_600_000).toFixed(2)} h.`,
      `Corpus: ${stats.sources} sources from ${stats.domains} domains; ${stats.verified} verified claims, ${stats.drafts} drafts (drafts are not findings).`,
      "",
      "## Questions",
      ...stats.questions.map((q, i) => `${i + 1}. ${q.question} (${q.verified} verified claims)`),
      "",
      ...sections.flatMap((s) => [`## ${s.name}`, String(s.body), ""]),
      "## Verified claims",
      ...claims.map((cl) => {
        const quotes = JSON.parse(String(cl.quotes)) as { source: string; quote: string }[];
        return `- ${cl.text} ${[...new Set(quotes.map((q) => sources.get(q.source)?.url).filter(Boolean))].map((u) => `[${u}]`).join(" ")}`;
      }),
      "",
      "## Hypotheses",
      ...this.all("select text, supporting from hypothesis where instance = ?", instance).map(
        (h) =>
          `- ${h.text} (supported by ${(JSON.parse(String(h.supporting)) as string[]).length} verified claims)`,
      ),
      "",
      "## Open questions",
      ...stats.questions.filter((q) => q.verified === 0).map((q) => `- ${q.question}`),
      ...(unsupported.length
        ? [
            "",
            "## Numbers without a source",
            `These appear in the sections but in no archived source or verified claim: ${unsupported.join(", ")}`,
          ]
        : []),
    ];
    const body = lines.join("\n");
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          "insert into report_version (instance, kind, body, created_at) values (?, ?, ?, ?)",
        )
        .run(instance, kind, body, new Date().toISOString());
      this.ledger.appendEvent(
        "research",
        kind === "final" ? "research_final" : "research_digest",
        instance,
        {
          ...stats,
          elapsed_ms: clock.elapsed_ms,
          unsupported_numbers: unsupported.length,
          report: body.slice(0, 60_000),
        },
      );
    });
    return { kind, body };
  }

  lastReportAt(instance: string): string | undefined {
    const r = this.get(
      "select created_at from report_version where instance = ? order by id desc limit 1",
      instance,
    );
    return r ? String(r.created_at) : undefined;
  }

  /** Links from archived sources that are not archived yet: where to go next without search. */
  frontier(instance: string, limit = 40): string[] {
    const have = new Set(
      this.all("select url from source where instance = ?", instance).map((r) => String(r.url)),
    );
    const out: string[] = [];
    for (const s of this.all(
      "select raw_path, final_url from source where instance = ? order by fetched_at desc limit 30",
      instance,
    )) {
      let raw = "";
      try {
        raw = readFileSync(String(s.raw_path), "utf8");
      } catch {
        continue;
      }
      for (const href of htmlToText(raw).links) {
        let u: string;
        try {
          const x = new URL(href, String(s.final_url));
          x.hash = "";
          if (!x.protocol.startsWith("http")) continue;
          u = x.toString();
        } catch {
          continue;
        }
        if (!have.has(u) && !out.includes(u)) out.push(u);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
