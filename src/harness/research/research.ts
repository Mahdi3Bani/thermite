import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../../common/env.ts";
import { canonicalJson } from "../../core/canonical.ts";
import type { ResearchContract } from "../../core/contract.ts";
import { parseDuration } from "../../core/duration.ts";
import { type Ledger, LedgerError } from "../ledger.ts";
import { Fetcher, FetchRefused, htmlToText } from "./fetcher.ts";

/**
 * Research mode's integrity rules, enforced by code (the research form of "agents never judge"):
 *
 * - a claim is verified only when every quote appears verbatim in the archived text of a source
 *   the harness itself fetched, and every number in the claim appears in its quotes; anything
 *   else stays a draft;
 * - a verified claim is corroborated when its quotes come from at least the contract's number of
 *   independent domains;
 * - a finding is a worker's conclusion with a summary and why it matters; it is reported as a
 *   finding only when every claim it cites is verified and every number in it appears in those
 *   claims; anything else stays a draft finding;
 * - sources are deduplicated by URL and by content hash, claims by their text;
 * - reports show worker-written sections as notes, never as findings, and flag numbers in them
 *   that no verified claim supports;
 * - the harness owns the clock (running time only): workers cannot end a campaign.
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

/** Numbers as written (1,200 and 3.5 and 42), for checking claims and sections. */
function numbersIn(s: string): string[] {
  return [...s.matchAll(/\d[\d,.]*\d|\d/g)].map((m) => m[0]);
}

/** A claim's identity for deduplication: its words, case and punctuation folded. */
function claimKey(s: string): string {
  return normalizeQuote(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

export const ClaimInput = z.object({
  text: z.string().min(5).max(4000),
  quotes: z
    .array(z.object({ source: z.string().min(1), quote: z.string().min(20).max(2000) }))
    .min(1)
    .max(10),
  question: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const FindingInput = z.object({
  text: z.string().min(5).max(4000),
  summary: z.string().min(5).max(8000),
  why_it_matters: z.string().min(5).max(8000),
  supporting: z.array(z.string().min(1)).min(1).max(50),
});

export class Research {
  private readonly ledger: Ledger;
  private readonly stateDir: string;
  private readonly fetchers = new Map<string, Fetcher>();
  private readonly allowPrivate: boolean;
  private readonly maxCorpusBytes: number;
  /** Told after each change to a run's research (the research folder follows it). */
  onChange: ((run: string) => void) | undefined;

  constructor(
    ledger: Ledger,
    stateDir: string,
    opts: {
      allowPrivate?: boolean;
      maxCorpusBytes?: number;
      onChange?: ((run: string) => void) | undefined;
    } = {},
  ) {
    this.ledger = ledger;
    this.stateDir = stateDir;
    this.allowPrivate = opts.allowPrivate ?? false;
    // No cap on the corpus unless one is configured (the owner's direction, 2026-10-15).
    this.maxCorpusBytes = opts.maxCorpusBytes ?? Number.POSITIVE_INFINITY;
    this.onChange = opts.onChange;
  }

  /** A change is recorded: the folder follows; a failure there never fails the change. */
  private changed(run: string): void {
    try {
      this.onChange?.(run);
    } catch (err) {
      log("harness", "research folder not updated", { run, error: String(err) });
    }
  }

  /** Workers may act only on a running research campaign. */
  requireRunning(run: string): void {
    const inst = this.ledger.getRun(run);
    if (!inst) throw new LedgerError("not_found", `no run ${run}`);
    if (inst.mode !== "research") throw new LedgerError("invalid", `${run} is not research`);
    if (inst.status !== "running") throw new LedgerError("invalid", `run ${run} is ${inst.status}`);
  }

  private contract(run: string): ResearchContract {
    const inst = this.ledger.getRun(run);
    if (!inst) throw new Error(`no run ${run}`);
    const c = this.ledger.getContract(inst.campaign, inst.version);
    if (c?.mode !== "research") throw new Error(`${run} is not a research campaign`);
    return c;
  }

  private fetcher(run: string): Fetcher {
    let f = this.fetchers.get(run);
    if (!f) {
      const c = this.contract(run);
      f = new Fetcher(
        {
          respectRobots: c.fetch_policy.respect_robots,
          perDomainPerMinute: c.fetch_policy.per_domain_per_minute,
          maxBytes: c.fetch_policy.max_bytes,
          includeDomains: c.scope.include_domains,
          excludeDomains: c.scope.exclude_domains,
          allowPrivate: this.allowPrivate,
        },
        join(this.stateDir, "research", run),
      );
      this.fetchers.set(run, f);
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

  async fetch(run: string, lane: string | null, url: string) {
    // Look up the URL in the form it is stored in (no fragment, normalized by URL).
    let key = url;
    try {
      const u = new URL(url);
      u.hash = "";
      key = u.toString();
    } catch {
      // not a URL: the fetcher refuses it below
    }
    const existing = this.get("select * from source where run = ? and url = ?", run, key);
    if (existing) return this.view(existing, "already archived");
    const used = Number(
      this.get("select coalesce(sum(bytes), 0) as n from source where run = ?", run)?.n,
    );
    if (used >= this.maxCorpusBytes) {
      return { refused: `the corpus is full (${Math.round(used / 1024 ** 2)} MiB archived)` };
    }
    let f: Awaited<ReturnType<Fetcher["fetch"]>>;
    try {
      f = await this.fetcher(run).fetch(url);
    } catch (err) {
      const reason =
        err instanceof FetchRefused
          ? err.message
          : `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      this.ledger.appendEvent(lane ?? "research", "fetch_refused", run, {
        url: url.slice(0, 500),
        reason,
      });
      return { refused: reason };
    }
    const same = this.get("select * from source where run = ? and sha256 = ?", run, f.sha256);
    if (same) return this.view(same, "the same content is already archived under this id", f.links);
    const id = `s-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          `insert into source (id, run, url, final_url, domain, fetched_at, http_status, content_type, bytes, sha256,
             title, raw_path, text_path, fetched_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          run,
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
      this.ledger.appendEvent(lane ?? "research", "source_fetched", run, {
        source: id,
        domain: f.domain,
        status: f.status,
        bytes: f.bytes,
      });
    });
    const row = this.get("select * from source where id = ?", id) as Row;
    this.changed(run);
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

  read(run: string, source: string, offset = 0, length = 6000) {
    const s = this.get("select * from source where run = ? and id = ?", run, source);
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

  /** Case-insensitive plain-text search over the archived texts (no regular expressions). */
  searchCorpus(run: string, text: string) {
    const needle = text.trim().toLowerCase().slice(0, 200);
    if (needle.length < 2) return { matches: [] };
    const out: { source: string; url: string; excerpt: string }[] = [];
    for (const s of this.all("select * from source where run = ? order by fetched_at", run)) {
      const body = this.text(s);
      const at = body.toLowerCase().indexOf(needle);
      if (at >= 0) {
        out.push({
          source: String(s.id),
          url: String(s.url),
          excerpt: body.slice(Math.max(0, at - 200), at + 300),
        });
        if (out.length >= 30) break;
      }
    }
    return { matches: out };
  }

  /** Web search: every query is checked against the contract's search policy and logged. */
  search(run: string, lane: string | null, query: string) {
    const c = this.contract(run);
    const q = query.slice(0, 500);
    const blocked = (c.search_policy?.blocked_patterns ?? []).find((p) =>
      new RegExp(p, "i").test(q),
    );
    const reason = blocked
      ? `blocked by the search policy (${blocked})`
      : "this rig has no web search: fetch URLs from the seeds and the links of archived sources";
    this.ledger.db
      .prepare(
        "insert into research_query (run, lane, query, allowed, reason, created_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(run, lane, q, 0, reason, new Date().toISOString());
    return { results: [], note: reason };
  }

  addClaim(run: string, lane: string | null, input: unknown) {
    const c = ClaimInput.parse(input);
    const key = claimKey(c.text);
    const same = this.all(
      "select id, text, verified from claim where run = ? order by verified desc, created_at",
      run,
    ).find((r) => claimKey(String(r.text)) === key);
    if (same && Number(same.verified) === 1) {
      return {
        claim: String(same.id),
        verified: true,
        problems: [],
        note: "this claim is already recorded and verified",
      };
    }
    const problems: string[] = [];
    for (const q of c.quotes) {
      const s = this.get("select * from source where run = ? and id = ?", run, q.source);
      if (!s) {
        problems.push(`no archived source ${q.source}`);
        continue;
      }
      if (!normalizeQuote(this.text(s)).includes(normalizeQuote(q.quote))) {
        problems.push(`quote not found verbatim in ${q.source}: "${q.quote.slice(0, 80)}"`);
      }
    }
    // A claim may not state numbers its own quotes do not contain.
    const quoted = c.quotes.map((q) => normalizeQuote(q.quote)).join(" ");
    for (const num of numbersIn(c.text)) {
      if (!quoted.includes(num)) problems.push(`the number ${num} is not in the claim's quotes`);
    }
    const id = `c-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const verified = problems.length === 0;
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          "insert into claim (id, run, lane, question, text, quotes, verified, problems, confidence, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          run,
          lane,
          c.question ?? null,
          c.text,
          canonicalJson(c.quotes),
          verified ? 1 : 0,
          canonicalJson(problems),
          c.confidence ?? null,
          new Date().toISOString(),
        );
      this.ledger.appendEvent(lane ?? "research", "claim_added", run, {
        claim: id,
        verified,
        question: c.question ?? null,
      });
    });
    this.changed(run);
    return { claim: id, verified, problems };
  }

  addNote(run: string, lane: string | null, text: string, sources: string[] = []) {
    const r = this.ledger.db
      .prepare("insert into note (run, lane, text, sources, created_at) values (?, ?, ?, ?, ?)")
      .run(
        run,
        lane,
        text.slice(0, 4000),
        canonicalJson(sources.slice(0, 20)),
        new Date().toISOString(),
      );
    this.changed(run);
    return { note: Number(r.lastInsertRowid) };
  }

  proposeHypothesis(run: string, lane: string | null, text: string, supporting: string[] = []) {
    const known = new Set(
      this.all("select id from claim where run = ? and verified = 1", run).map((r) => String(r.id)),
    );
    const ok = supporting.filter((c) => known.has(c));
    const id = `h-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.ledger.db
      .prepare(
        "insert into hypothesis (id, run, lane, text, supporting, created_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(id, run, lane, text.slice(0, 2000), canonicalJson(ok), new Date().toISOString());
    this.changed(run);
    return { hypothesis: id, supporting: ok, ignored: supporting.filter((c) => !known.has(c)) };
  }

  /**
   * A finding: a worker's conclusion, with a summary and why it matters, citing verified claims.
   * Code checks it: every cited claim must be a verified claim of this run, and every number in
   * its text, summary and why must appear in those claims (their text or quotes). Otherwise it
   * is kept as a draft finding, with the problems.
   */
  addFinding(run: string, lane: string | null, input: unknown) {
    const f = FindingInput.parse(input);
    const problems: string[] = [];
    const cited = [...new Set(f.supporting)];
    const claims: Row[] = [];
    for (const id of cited) {
      const cl = this.get("select * from claim where run = ? and id = ?", run, id);
      if (!cl) problems.push(`no claim ${id}`);
      else if (Number(cl.verified) !== 1) problems.push(`claim ${id} is a draft, not verified`);
      else claims.push(cl);
    }
    const known = new Set(
      claims.flatMap((cl) => [
        ...numbersIn(String(cl.text)),
        ...(JSON.parse(String(cl.quotes)) as { quote: string }[]).flatMap((q) =>
          numbersIn(q.quote),
        ),
      ]),
    );
    for (const num of new Set([
      ...numbersIn(f.text),
      ...numbersIn(f.summary),
      ...numbersIn(f.why_it_matters),
    ])) {
      if (!known.has(num)) problems.push(`the number ${num} is not in the claims it cites`);
    }
    const id = `f-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const supported = problems.length === 0;
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          `insert into finding (id, run, lane, text, summary, why_it_matters, supporting, supported, problems, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          run,
          lane,
          f.text,
          f.summary,
          f.why_it_matters,
          canonicalJson(cited),
          supported ? 1 : 0,
          canonicalJson(problems),
          new Date().toISOString(),
        );
      this.ledger.appendEvent(lane ?? "research", "finding_added", run, {
        finding: id,
        supported,
        claims: cited.length,
      });
    });
    this.changed(run);
    return { finding: id, supported, problems };
  }

  updateSection(run: string, by: string | null, name: string, body: string) {
    if (!/^[a-z0-9][a-z0-9 _-]{0,59}$/i.test(name))
      throw new Error("section names are short words");
    this.ledger.db
      .prepare(
        `insert into report_section (run, name, body, updated_by, updated_at) values (?, ?, ?, ?, ?)
         on conflict (run, name) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(run, name, body.slice(0, 20_000), by ?? "worker", new Date().toISOString());
    this.changed(run);
    return { section: name };
  }

  /** Running time (paused time does not count) against the contract's durations. */
  clock(run: string) {
    const c = this.contract(run);
    const created = String(this.get("select created_at from run where id = ?", run)?.created_at);
    let elapsedMs = 0;
    let since: number | null = Date.parse(created);
    for (const e of this.all(
      "select at, body from event where kind in ('run_status', 'instance_status') and subject = ? order by id",
      run,
    )) {
      const status = (JSON.parse(String(e.body)) as { status?: string }).status;
      const at = Date.parse(String(e.at));
      if (status === "running") since ??= at;
      else if (since !== null) {
        elapsedMs += at - since;
        since = null;
      }
    }
    if (since !== null) elapsedMs += Date.now() - since;
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

  /** Distinct domains a verified claim's quotes come from. */
  private claimDomains(run: string, quotesJson: string): number {
    const ids = (JSON.parse(quotesJson) as { source: string }[]).map((q) => q.source);
    const domains = new Set(
      ids.map(
        (id) => this.get("select domain from source where run = ? and id = ?", run, id)?.domain,
      ),
    );
    domains.delete(undefined);
    return domains.size;
  }

  stats(run: string) {
    const c = this.contract(run);
    const n = (sql: string, ...p: (string | number)[]) => Number(this.get(sql, ...p)?.n ?? 0);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const verifiedRows = this.all("select quotes from claim where run = ? and verified = 1", run);
    const corroborated = verifiedRows.filter(
      (r) => this.claimDomains(run, String(r.quotes)) >= c.quality.min_independent_sources,
    ).length;
    const firstVerified = (i: number) =>
      this.get(
        "select min(created_at) as t from claim where run = ? and question = ? and verified = 1",
        run,
        i,
      )?.t;
    return {
      sources: n("select count(*) as n from source where run = ?", run),
      domains: n("select count(distinct domain) as n from source where run = ?", run),
      verified: n("select count(*) as n from claim where run = ? and verified = 1", run),
      corroborated,
      drafts: n("select count(*) as n from claim where run = ? and verified = 0", run),
      hypotheses: n("select count(*) as n from hypothesis where run = ?", run),
      findings: n("select count(*) as n from finding where run = ? and supported = 1", run),
      draft_findings: n("select count(*) as n from finding where run = ? and supported = 0", run),
      questions: c.questions.map((q, i) => ({
        question: q,
        verified: n(
          "select count(*) as n from claim where run = ? and question = ? and verified = 1",
          run,
          i,
        ),
      })),
      // Novelty in the last hour: new sources, newly verified claims, newly covered questions.
      last_hour: {
        sources: n(
          "select count(*) as n from source where run = ? and fetched_at > ?",
          run,
          hourAgo,
        ),
        verified: n(
          "select count(*) as n from claim where run = ? and verified = 1 and created_at > ?",
          run,
          hourAgo,
        ),
        questions_covered: c.questions.filter((_, i) => {
          const t = firstVerified(i);
          return typeof t === "string" && t > hourAgo;
        }).length,
      },
    };
  }

  /**
   * A report version from the ledger: sections, the verified claims with their sources, the
   * hypotheses with their support, the open questions, and numbers in the sections that appear
   * in no archived source and no verified claim (flagged, not hidden).
   */
  report(run: string, kind: "digest" | "final") {
    const c = this.contract(run);
    const stats = this.stats(run);
    const clock = this.clock(run);
    const sources = new Map(
      this.all("select id, url, title, text_path from source where run = ?", run).map((s) => [
        String(s.id),
        s,
      ]),
    );
    const claims = this.all(
      "select * from claim where run = ? and verified = 1 order by created_at",
      run,
    );
    const sections = this.all(
      "select name, body from report_section where run = ? order by name",
      run,
    );
    // A number in a section is supported only by a verified claim (its text or its quotes).
    const supported = new Set(
      claims.flatMap((cl) => [
        ...numbersIn(String(cl.text)),
        ...(JSON.parse(String(cl.quotes)) as { quote: string }[]).flatMap((q) =>
          numbersIn(q.quote),
        ),
      ]),
    );
    const unsupported: string[] = [];
    for (const s of sections) {
      for (const num of numbersIn(String(s.body))) {
        if (!supported.has(num) && !unsupported.includes(num)) unsupported.push(num);
      }
    }
    const min = c.quality.min_independent_sources;
    const corroborated = claims.filter((cl) => this.claimDomains(run, String(cl.quotes)) >= min);
    const single = claims.filter((cl) => this.claimDomains(run, String(cl.quotes)) < min);
    const cite = (cl: Row) => {
      const quotes = JSON.parse(String(cl.quotes)) as { source: string; quote: string }[];
      return `- ${cl.text} ${[...new Set(quotes.map((q) => sources.get(q.source)?.url).filter(Boolean))].map((u) => `[${u}]`).join(" ")}`;
    };
    // Worker-written text cannot make its own headings: a line starting with # is shown as text.
    const fence = (body: string) => body.replace(/^(\s*)#/gm, "$1\\#");
    const byId = new Map(claims.map((cl) => [String(cl.id), cl]));
    const findings = this.all("select * from finding where run = ? order by created_at", run);
    const finding = (f: Row) => {
      const cited = (JSON.parse(String(f.supporting)) as string[])
        .map((id) => byId.get(id))
        .filter((cl): cl is Row => cl !== undefined);
      const strong = cited.filter((cl) => corroborated.includes(cl)).length;
      return [
        `### ${fence(String(f.text)).replace(/\n+/g, " ")}`,
        "",
        fence(String(f.summary)),
        "",
        `Why it matters: ${fence(String(f.why_it_matters))}`,
        "",
        `Supported by ${cited.length} verified claims (${strong} from at least ${min} independent domains):`,
        ...cited.map(cite),
        "",
      ];
    };
    const lines = [
      `# ${c.title}`,
      "",
      `Topic: ${c.topic}`,
      `Report: ${kind}, ${new Date().toISOString()}. Elapsed ${(clock.elapsed_ms / 3_600_000).toFixed(2)} h of at least ${(clock.min_ms / 3_600_000).toFixed(2)} h.`,
      `Corpus: ${stats.sources} sources from ${stats.domains} domains; ${stats.verified} verified claims (${stats.corroborated} from at least ${min} independent domains), ${stats.drafts} drafts; ${stats.findings} findings, ${stats.draft_findings} draft findings.`,
      `Last hour: ${stats.last_hour.sources} new sources, ${stats.last_hour.verified} newly verified claims, ${stats.last_hour.questions_covered} questions newly covered.`,
      "",
      "## Questions",
      ...stats.questions.map((q, i) => `${i + 1}. ${q.question} (${q.verified} verified claims)`),
      "",
      "## Findings",
      ...findings.filter((f) => Number(f.supported) === 1).flatMap(finding),
      "",
      `## Verified claims from at least ${min} independent domains`,
      ...corroborated.map(cite),
      "",
      "## Verified claims from a single domain",
      ...single.map(cite),
      "",
      "## Draft findings (not supported by verified claims)",
      ...findings
        .filter((f) => Number(f.supported) !== 1)
        .map(
          (f) =>
            `- ${fence(String(f.text)).replace(/\n+/g, " ")} (${(JSON.parse(String(f.problems)) as string[]).join("; ")})`,
        ),
      "",
      "## Hypotheses",
      ...this.all("select text, supporting from hypothesis where run = ?", run).map(
        (h) =>
          `- ${h.text} (supported by ${(JSON.parse(String(h.supporting)) as string[]).length} verified claims)`,
      ),
      "",
      "## Open questions",
      ...stats.questions.filter((q) => q.verified === 0).map((q) => `- ${q.question}`),
      "",
      "## Worker sections (not verified; only the findings and claims above are checked)",
      ...sections.flatMap((s) => [`### ${s.name}`, fence(String(s.body)), ""]),
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
        .prepare("insert into report_version (run, kind, body, created_at) values (?, ?, ?, ?)")
        .run(run, kind, body, new Date().toISOString());
      this.ledger.appendEvent(
        "research",
        kind === "final" ? "research_final" : "research_digest",
        run,
        {
          ...stats,
          elapsed_ms: clock.elapsed_ms,
          unsupported_numbers: unsupported.length,
          report: body.slice(0, 60_000),
        },
      );
    });
    this.changed(run);
    return { kind, body };
  }

  lastReportAt(run: string): string | undefined {
    const r = this.get(
      "select created_at from report_version where run = ? order by id desc limit 1",
      run,
    );
    return r ? String(r.created_at) : undefined;
  }

  /**
   * Links from archived sources that are not archived yet: where to go next without search.
   * Site boilerplate (a link found on two or more archived pages of the same site, such as
   * navigation) is left out, links are taken in turn from each source rather than all from one,
   * and links with query strings come last (they are usually actions, not documents).
   */
  frontier(run: string, limit = 40): string[] {
    const have = new Set(
      this.all("select url from source where run = ?", run).map((r) => String(r.url)),
    );
    const perSource: { domain: string; links: string[] }[] = [];
    for (const s of this.all(
      "select raw_path, final_url, sha256, domain from source where run = ? order by fetched_at desc limit 30",
      run,
    )) {
      let hrefs: string[] = [];
      try {
        // Links were saved at fetch time; older archives are parsed once more (linear time).
        const saved = join(String(s.raw_path), "..", `${String(s.sha256)}.links.json`);
        hrefs = existsSync(saved)
          ? (JSON.parse(readFileSync(saved, "utf8")) as string[])
          : htmlToText(readFileSync(String(s.raw_path), "utf8")).links;
      } catch {
        continue;
      }
      const links: string[] = [];
      for (const href of hrefs) {
        try {
          const x = new URL(href, String(s.final_url));
          x.hash = "";
          if (x.protocol.startsWith("http") && !links.includes(x.toString()))
            links.push(x.toString());
        } catch {
          // not a URL
        }
      }
      perSource.push({ domain: String(s.domain), links });
    }
    // Boilerplate: links that more than one archived page of the same site carries.
    const seen = new Map<string, number>();
    for (const p of perSource)
      for (const l of p.links)
        seen.set(`${p.domain} ${l}`, (seen.get(`${p.domain} ${l}`) ?? 0) + 1);
    const candidates = perSource.map((p) =>
      p.links.filter((l) => !have.has(l) && (seen.get(`${p.domain} ${l}`) ?? 0) < 2),
    );
    const plain: string[] = [];
    const query: string[] = [];
    for (let i = 0; plain.length + query.length < limit * 4; i++) {
      let any = false;
      for (const list of candidates) {
        const l = list[i];
        if (l === undefined) continue;
        any = true;
        const bucket = new URL(l).search ? query : plain;
        if (!plain.includes(l) && !query.includes(l)) bucket.push(l);
      }
      if (!any) break;
    }
    return [...plain, ...query].slice(0, limit);
  }
}
