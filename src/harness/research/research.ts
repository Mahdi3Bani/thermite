import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../../common/env.ts";
import { canonicalJson } from "../../core/canonical.ts";
import type { ResearchContract } from "../../core/contract.ts";
import { parseDuration } from "../../core/duration.ts";
import { KB_BODY_MAX } from "../../core/kb-index.ts";
import {
  HYPOTHESES_RULE,
  hypothesisStatusWords,
  LIVE_HYPOTHESES,
  questionLabel,
} from "../../core/research-check.ts";
import { CODE_RESEARCH_TOOLS, moreText, READ_MAX, researchTool } from "../agents/research-tools.ts";
import { type Ledger, LedgerError } from "../ledger.ts";
import type { TaskYield } from "../queue.ts";
import { answersSection } from "./cards.ts";
import {
  checkCited,
  claimNumbers,
  foldText,
  normalizeQuote,
  numbersIn,
  withoutNames,
} from "./checks.ts";
import { Fetcher, FetchRefused, htmlToText, registrableDomain } from "./fetcher.ts";
import { Papers } from "./paper.ts";
import { answerSections, checkLine, researchEnd } from "./review.ts";

/** The research service's operations a hill-climb or goal run takes (its code trials' tools). */
const CODE_OPS = new Set(CODE_RESEARCH_TOOLS.map((n) => researchTool(n)?.op ?? n));

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The start of a fetched page's text that fetch answers with (read_source reads the rest). */
const VIEW_CHARS = 6000;
/** The links a fetch answers with, in characters, beside the text, within OUTPUT_MAX. */
const VIEW_LINKS_CHARS = 5000;
/** One page of search_corpus: at most this many matches, and this many characters of them. */
const SEARCH_PAGE = 30;
const SEARCH_CHARS = 11_000;
/** The run's newest notes a new note may not repeat (goal 117). */
export const NOTE_REPEATS = 200;
/** The hypotheses a worker's brief lists: those that need a verdict, and the pool's newest. */
const BRIEF_REQUIRED = 30;
const BRIEF_POOL = 10;

/**
 * Research mode's integrity rules, enforced by code (the research form of "agents never judge"):
 *
 * - a claim is verified only when every quote appears verbatim in the archived text of a source
 *   the harness itself fetched, and every number in the claim appears in its quotes; anything
 *   else stays a draft;
 * - a verified claim is corroborated when its quotes come from at least the contract's number of
 *   independent domains: registrable domains, so docs.example.com and blog.example.com are one;
 * - a finding is a worker's conclusion with a summary and why it matters; it is reported as a
 *   finding only when every claim it cites is verified and every number in it appears in those
 *   claims; anything else stays a draft finding;
 * - sources are deduplicated by URL and by content hash, claims by their text;
 * - reports show worker-written sections as notes, never as findings, and flag numbers in them
 *   that no verified claim supports;
 * - the harness owns the clock (running time only): workers cannot end a campaign.
 */

type Row = Record<string, unknown>;

export { normalizeQuote };

/** A label at a line's start that numbers a question or a claim: "Question 0:", "Claim c-005:". */
const LABEL = /^[*_]*(?:question|claim)\s*#?\s*[\w.-]*\d[\w-]*\s*[:.)\]]/i;

/**
 * The heading or label of a claim's text that a number comes from, if it comes from one: a
 * Markdown heading line ("# Claim c-verify-005") or a label at a line's start ("Question 0:").
 * Such a number counts like any other (the check is the same); the problem only says where it is.
 */
function headingWith(text: string, num: string): string | undefined {
  for (const line of text.split("\n")) {
    const t = line.trim();
    const head = /^#{1,6}\s/.test(t) ? t : LABEL.exec(t)?.[0];
    if (head && numbersIn(head).includes(num)) return head;
  }
  return undefined;
}

/** A URL as the archive stores it (parsed, without its fragment); undefined when it is not one. */
export function archiveUrl(s: string): string | undefined {
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/** A URL loosely, to name what a source could be: no scheme, no "www.", no fragment or end slash. */
const looseUrl = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");

/** A quote as a claim keeps it: its source's id, and what the worker cited when that was not it. */
interface ClaimQuote {
  source: string;
  quote: string;
  resolved_from?: string;
}

/** The most draft reasons a `claim_added` event carries (the claim's record keeps them all). */
const EVENT_PROBLEMS = 20;

/** A claim's identity for deduplication: its words, case and punctuation folded. */
const claimKey = foldText;

export const ClaimInput = z.object({
  text: z.string().min(5).max(4000),
  quotes: z
    .array(z.object({ source: z.string().min(1), quote: z.string().min(20).max(2000) }))
    .min(1)
    .max(10),
  question: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/** A hypothesis's longest text: a longer one is cut to it. */
const HYPOTHESIS_MAX = 2000;

const ClaimIds = z.array(z.string().max(500)).max(50);

export const HypothesisInput = z.object({
  text: z.string(),
  question: z.number().int().nullable().optional(),
  supporting: ClaimIds.default([]),
});

export const HypothesisRevision = z.object({
  id: z.string().min(1).max(200),
  text: z.string().optional(),
  question: z.number().int().nullable().optional(),
  supporting: ClaimIds.optional(),
});

/** Why a hypothesis is refused as a repeat of a live one: which, and what to do instead. */
function repeatsWords(twin: Row): string {
  const id = String(twin.id);
  return String(twin.status) === "author"
    ? `this hypothesis repeats ${id}, one of the author's: the review panel gives it a verdict already. Record claims for or against it instead of proposing it again`
    : `this hypothesis repeats ${id}${twin.lane ? ` (proposed by ${String(twin.lane)})` : ""}: change that one with revise_hypothesis (id ${id}), its words, its question or its supporting claims, instead of proposing it again`;
}

export const FindingInput = z.object({
  text: z.string().min(5).max(4000),
  summary: z.string().min(5).max(8000),
  why_it_matters: z.string().min(5).max(8000),
  supporting: z.array(z.string().min(1)).min(1).max(50),
});

/**
 * A research run's starting hypotheses (goal 078): those of its campaign's brief, recorded as the
 * run's first hypotheses when the run is made, each whole, with no supporting claim yet and no
 * lane. Each is a hypothesis_added event by `by` (who assigned the run), so the campaign's folder
 * in the knowledge base holds them too. Returns their ids.
 */
export function startingHypotheses(
  ledger: Ledger,
  run: string,
  texts: string[],
  by: string,
): string[] {
  return ledger.tx(() =>
    texts.map((text) => {
      const id = `h-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const now = new Date().toISOString();
      ledger.db
        .prepare(
          "insert into hypothesis (id, run, lane, text, supporting, status, created_at, updated_at) values (?, ?, ?, ?, ?, 'author', ?, ?)",
        )
        .run(id, run, null, text, canonicalJson([]), now, now);
      ledger.appendEvent(by, "hypothesis_added", run, {
        hypothesis: id,
        lane: null,
        text,
        supporting: [],
        from: "brief",
        question: null,
        status: "author",
      });
      return id;
    }),
  );
}

/** The statuses a hypothesis may be given by command (goal 117): promoted, back to the pool, retired. */
export const HYPOTHESIS_STATUS_CHANGES = ["promoted", "pool", "retired"] as const;
export type HypothesisStatusChange = (typeof HYPOTHESIS_STATUS_CHANGES)[number];

/** A change of a hypothesis's status, as the owner's command and the planner give it. */
export const HypothesisStatusInput = z.strictObject({
  id: z.string().trim().min(1).max(64),
  status: z.enum(HYPOTHESIS_STATUS_CHANGES),
  reason: z.string().trim().min(1).max(2000),
});
export type HypothesisStatusInput = z.infer<typeof HypothesisStatusInput>;

/** The event of a hypothesis whose status was changed by command or by the planner. */
export const HYPOTHESIS_STATUS = "hypothesis_status";

/**
 * Changes a hypothesis's status (goal 117): the owner's `hypothesis_status` command and the
 * planner's promotions and retirements both come here. A pool hypothesis may be promoted (it then
 * needs a verdict from the review panel, as the author's do) or retired; a promoted one may go
 * back to the pool or be retired; a retired one may go back to the pool or be promoted, unless
 * its words now repeat a live hypothesis of the run. Refused in words: an unknown hypothesis, one
 * of the author's (the campaign's brief sets those), and a merged one. The same status again
 * changes nothing and records nothing. Each change is the event `hypothesis_status`, with who
 * changed it and why. Who may do what beyond this (the planner's bounds) is the caller's.
 */
export function setHypothesisStatus(
  ledger: Ledger,
  run: string,
  input: unknown,
  by: string,
): {
  hypothesis: string;
  status: HypothesisStatusChange;
  from: string;
  changed: boolean;
  note?: string;
} {
  const p = HypothesisStatusInput.safeParse(input);
  if (!p.success)
    throw new LedgerError(
      "invalid",
      `a status change is {"id", "status": "promoted", "pool" or "retired", "reason"}: ${p.error.issues[0]?.path.join(".") || "it"} ${p.error.issues[0]?.message ?? "is not valid"}`,
    );
  const { id, status, reason } = p.data;
  const h = ledger.db.prepare("select * from hypothesis where run = ? and id = ?").get(run, id) as
    | Row
    | undefined;
  if (!h) throw new LedgerError("not_found", `no hypothesis ${id} in run ${run}`);
  const from = String(h.status);
  if (from === "author")
    throw new LedgerError(
      "invalid",
      `hypothesis ${id} is one of the author's: it needs a verdict already, and only the campaign's brief changes it`,
    );
  if (from === "merged")
    throw new LedgerError(
      "invalid",
      `hypothesis ${id} was merged into ${String(h.merged_into)}: change ${String(h.merged_into)} instead`,
    );
  if (from === status)
    return {
      hypothesis: id,
      status,
      from,
      changed: false,
      note: `hypothesis ${id} is ${hypothesisStatusWords(status)} already: nothing changed`,
    };
  // A retired hypothesis comes back only when no live one repeats it meanwhile.
  if (from === "retired") {
    const key = foldText(String(h.text));
    const twin = (
      ledger.db
        .prepare(
          `select id, status, text from hypothesis where run = ? and id != ? and status in (${LIVE_HYPOTHESES.map(() => "?").join(", ")}) order by created_at, rowid`,
        )
        .all(run, id, ...LIVE_HYPOTHESES) as Row[]
    ).find((t) => foldText(String(t.text)) === key);
    if (twin)
      throw new LedgerError(
        "invalid",
        `hypothesis ${id}'s words repeat ${String(twin.id)} (${hypothesisStatusWords(String(twin.status))}): change ${String(twin.id)} instead`,
      );
  }
  const now = new Date().toISOString();
  ledger.tx(() => {
    ledger.db
      .prepare("update hypothesis set status = ?, updated_at = ? where id = ?")
      .run(status, now, id);
    ledger.appendEvent(by, HYPOTHESIS_STATUS, run, {
      hypothesis: id,
      status,
      from,
      by,
      reason,
      question: h.question === null ? null : Number(h.question),
      text: String(h.text),
    });
  });
  return { hypothesis: id, status, from, changed: true };
}

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

  /**
   * Workers may act only on a running run. A research run takes every operation; a hill-climb or
   * goal run records sources, claims and notes (goal 065), and the rest belongs to research runs.
   */
  requireRunning(run: string, op?: string | undefined): void {
    const inst = this.ledger.getRun(run);
    if (!inst) throw new LedgerError("not_found", `no run ${run}`);
    if (inst.status !== "running") throw new LedgerError("invalid", `run ${run} is ${inst.status}`);
    if (inst.mode !== "research" && (op === undefined || !CODE_OPS.has(op)))
      throw new LedgerError(
        "invalid",
        `a ${inst.mode.replace(/_/g, "-")} run records sources, claims and notes only (${CODE_RESEARCH_TOOLS.join(", ")}); the rest belongs to research runs`,
      );
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
      // A research contract's fetch policy and scope; another run's are the policy's defaults
      // (robots.txt respected, a polite rate per domain, a size bound per page), no scope.
      const inst = this.ledger.getRun(run);
      const c = inst ? this.ledger.getContract(inst.campaign, inst.version) : undefined;
      const policy =
        c?.mode === "research"
          ? c.fetch_policy
          : { respect_robots: true, per_domain_per_minute: 6, max_bytes: 5_000_000 };
      const scope = c?.mode === "research" ? c.scope : { include_domains: [], exclude_domains: [] };
      f = new Fetcher(
        {
          respectRobots: policy.respect_robots,
          perDomainPerMinute: policy.per_domain_per_minute,
          maxBytes: policy.max_bytes,
          includeDomains: scope.include_domains,
          excludeDomains: scope.exclude_domains,
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
    // Look up the URL in the form it is stored in (no fragment, normalized by URL); not a URL:
    // the fetcher refuses it below.
    const key = archiveUrl(url) ?? url;
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
      // Its address, its title and the text that was read (cut to an item's length), so the
      // campaign's folder in the knowledge base holds the source itself, from events alone.
      this.ledger.appendEvent(lane ?? "research", "source_fetched", run, {
        source: id,
        domain: f.domain,
        status: f.status,
        bytes: f.bytes,
        url: clip(f.url, 2000),
        title: f.title ? clip(f.title, 500) : null,
        text: clip(f.text, KB_BODY_MAX),
      });
    });
    const row = this.get("select * from source where id = ?", id) as Row;
    this.changed(run);
    return this.view(row, undefined, f.links);
  }

  /**
   * A fetched page as its worker sees it: the start of its text, with where to read on when there
   * is more, and the links found on it, as many as fit beside the text (goal 117: nothing is cut
   * without a word; the links left out are said, and the frontier keeps them).
   */
  private view(source: Row, note?: string, links: string[] = []) {
    const text = this.text(source);
    const id = String(source.id);
    const shown: string[] = [];
    let size = 0;
    for (const l of links.slice(0, 60)) {
      if (size + l.length + 3 > VIEW_LINKS_CHARS) break;
      shown.push(l);
      size += l.length + 3;
    }
    const part = text.slice(0, VIEW_CHARS);
    return {
      source: id,
      url: String(source.url),
      title: source.title === null ? null : String(source.title),
      status: Number(source.http_status),
      ...(note ? { note } : {}),
      chars: text.length,
      offset: 0,
      text: part,
      ...moreText({ source: id }, part.length, text.length),
      links: shown,
      ...(links.length > shown.length
        ? {
            links_not_shown: links.length - shown.length,
            links_note: `${links.length - shown.length} more of the page's links are not shown, to fit this answer`,
          }
        : {}),
    };
  }

  /**
   * Part of an archived source's text, from an offset: at most READ_MAX characters, so that the
   * answer fits a tool's answer whole, with `next_offset` and where to read on when more is left.
   */
  read(run: string, source: string, offset = 0, length = VIEW_CHARS) {
    const s = this.get("select * from source where run = ? and id = ?", run, source);
    if (!s) throw new LedgerError("not_found", `no source ${source} in this run`);
    const text = this.text(s);
    const from = Math.max(0, Math.min(text.length, Math.trunc(Number(offset) || 0)));
    const asked = Math.trunc(Number(length) || VIEW_CHARS);
    const part = text.slice(from, from + Math.max(1, Math.min(asked, READ_MAX)));
    return {
      source,
      url: String(s.url),
      chars: text.length,
      offset: from,
      text: part,
      ...moreText({ source }, from + part.length, text.length),
      ...(asked > READ_MAX ? { note: `a read gives at most ${READ_MAX} characters` } : {}),
      ...(from >= text.length && text.length > 0
        ? { note: `offset ${from} is at the end: the text has ${text.length} characters` }
        : {}),
    };
  }

  /**
   * Case-insensitive plain-text search over the archived texts (no regular expressions), a page
   * at a time: up to 30 matches, and fewer when their excerpts would not fit a tool's answer;
   * `next_skip` gives the next page (goal 117: a page that stops says so).
   */
  searchCorpus(run: string, text: string, skip = 0) {
    const needle = text.trim().toLowerCase().slice(0, 200);
    if (needle.length < 2) return { matches: [] };
    const from = Math.max(0, Math.trunc(Number(skip) || 0));
    const out: { source: string; url: string; excerpt: string }[] = [];
    let seen = 0;
    let size = 0;
    let more = false;
    for (const s of this.all("select * from source where run = ? order by fetched_at", run)) {
      const body = this.text(s);
      const at = body.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      if (seen++ < from) continue;
      const m = {
        source: String(s.id),
        url: String(s.url),
        excerpt: body.slice(Math.max(0, at - 200), at + 300),
      };
      const len = JSON.stringify(m).length;
      if (out.length >= SEARCH_PAGE || (out.length > 0 && size + len > SEARCH_CHARS)) {
        more = true;
        break;
      }
      out.push(m);
      size += len;
    }
    return {
      matches: out,
      ...(from ? { skip: from } : {}),
      ...(more
        ? {
            next_skip: from + out.length,
            more: `more sources match: search_corpus again with skip ${from + out.length} for the next page`,
          }
        : {}),
    };
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

  /**
   * The archived source a quote cites. A quote names it by the id fetch returned. A URL it was
   * archived from (as fetched, or as its redirects ended; compared as the archive stores URLs) or
   * its file name in the research folder (`sources/s-….txt`) names it too, when it names exactly
   * one: the quote is then checked against that source, and the claim records what was cited.
   * Anything else is a problem that says what the source could be. The check itself is the same.
   */
  private resolveSource(
    run: string,
    cited: string,
  ): { row: Row; from?: string | undefined } | { problem: string } {
    const byId = (id: string) => this.get("select * from source where run = ? and id = ?", run, id);
    const said = clip(cited, 200);
    const s = cited.trim();
    const exact = byId(s);
    if (exact) return { row: exact, from: s === cited ? undefined : cited };
    const file = /^(?:.*\/)?(s-[0-9a-f]+)\.(?:txt|md)$/.exec(s)?.[1];
    if (file) {
      const row = byId(file);
      return row
        ? { row, from: cited }
        : {
            problem: `no archived source ${said}: the research folder has no sources/${file}.txt; cite the s-… id that fetch returned`,
          };
    }
    const url = /^https?:\/\//i.test(s) ? archiveUrl(s) : undefined;
    if (url) {
      const rows = this.all(
        "select id from source where run = ? and (url = ? or final_url = ?) order by fetched_at",
        run,
        url,
        url,
      );
      if (rows.length === 1) return { row: byId(String(rows[0]?.id)) as Row, from: cited };
      if (rows.length > 1)
        return {
          problem: `no archived source ${said}: that URL is archived as ${rows.length} sources (${rows.map((r) => String(r.id)).join(", ")}); cite the id of the one the quote is from`,
        };
    }
    // Not archived as written. A URL archived in another form (http for https, without its
    // scheme or "www.", with an end slash) is named, never taken.
    const loose = looseUrl(s);
    const near: { id: string; at: string }[] = [];
    for (const r of this.all(
      "select id, url, final_url from source where run = ? order by fetched_at",
      run,
    )) {
      const at = [r.url, r.final_url].find((u) => u !== null && looseUrl(String(u)) === loose);
      if (at !== undefined) near.push({ id: String(r.id), at: String(at) });
      if (near.length === 3) break;
    }
    if (near.length)
      return {
        problem: `no archived source ${said}: that URL is not archived as written, but ${near.map((r) => `${r.id} is archived from ${clip(r.at, 200)}`).join(", and ")}; cite ${near.length === 1 ? "that id" : "the id of the page the quote is from"} if it is the same page`,
      };
    return {
      problem: url
        ? `no archived source ${said}: no source was archived from that URL; fetch it first, then cite the s-… id that fetch returns`
        : `no archived source ${said}: a quote's source is the s-… id that fetch returned`,
    };
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
    const quotes: ClaimQuote[] = [];
    const resolved: { cited: string; source: string }[] = [];
    for (const q of c.quotes) {
      const s = this.resolveSource(run, q.source);
      if ("problem" in s) {
        problems.push(s.problem);
        quotes.push({ source: q.source, quote: q.quote });
        continue;
      }
      const id = String(s.row.id);
      quotes.push({
        source: id,
        quote: q.quote,
        ...(s.from === undefined ? {} : { resolved_from: s.from }),
      });
      if (s.from !== undefined) resolved.push({ cited: s.from, source: id });
      if (!normalizeQuote(this.text(s.row)).includes(normalizeQuote(q.quote))) {
        problems.push(`quote not found verbatim in ${id}: "${q.quote.slice(0, 80)}"`);
      }
    }
    // A claim may not state numbers its own quotes do not contain. One from a heading or a label
    // ("Question 0:", "# Claim …") counts the same; the problem says where it comes from.
    // Whole numbers, not parts of them: a claim's 5 is not in a quote's 2025. A name's digits
    // (sm_50) are not stated numbers; a heading or label in the claim's text still is.
    const plain = (n: string) => n.replace(/,/g, "");
    const quoted = new Set(c.quotes.flatMap((q) => numbersIn(normalizeQuote(q.quote))).map(plain));
    for (const num of numbersIn(withoutNames(c.text))) {
      if (quoted.has(plain(num))) continue;
      const head = headingWith(c.text, num);
      problems.push(
        head
          ? `the number ${num} is not in the claim's quotes: it comes from the heading "${clip(head, 80)}". Give a question's number in "question", not in the claim's text, and leave headings and labels out of the text`
          : `the number ${num} is not in the claim's quotes`,
      );
    }
    const verified = problems.length === 0;
    // Each URL or file name taken as a source's id, so the worker cites the id next time.
    const how = resolved.length ? { resolved } : {};
    // The same claim with the same quotes, refused before: answered again, not recorded again, so
    // a worker that resubmits it in a loop learns what to change and fills no records.
    if (!verified) {
      const same = canonicalJson(quotes);
      const before = this.all(
        "select id, text, quotes from claim where run = ? and verified = 0 order by created_at",
        run,
      ).find((r) => claimKey(String(r.text)) === key && String(r.quotes) === same);
      if (before)
        return {
          claim: String(before.id),
          verified: false,
          problems,
          ...how,
          note: "this same claim, with the same quotes, was refused before for the same reasons: read_source the passage and copy its words exactly into the quote, or record what you learned as a note (add_note) instead",
        };
    }
    const id = `c-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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
          canonicalJson(quotes),
          verified ? 1 : 0,
          canonicalJson(problems),
          c.confidence ?? null,
          new Date().toISOString(),
        );
      // The claim's words and its first quote, bounded: the record of what the source says. Its
      // quotes' sources, and why a draft is one, so the owner sees it as the worker did.
      this.ledger.appendEvent(lane ?? "research", "claim_added", run, {
        claim: id,
        verified,
        question: c.question ?? null,
        text: clip(c.text, 500),
        quote: clip(c.quotes[0]?.quote ?? "", 500),
        sources: quotes.map((q) => clip(q.source, 200)),
        problems: problems.slice(0, EVENT_PROBLEMS).map((p) => clip(p, 300)),
        ...(problems.length > EVENT_PROBLEMS
          ? { more_problems: problems.length - EVENT_PROBLEMS }
          : {}),
      });
    });
    this.changed(run);
    return { claim: id, verified, problems, ...how };
  }

  /**
   * A research note, with the sources it relies on. It is its own record (the research folder's
   * notes/ and the report read it) and one `research_note` event with its text, so the knowledge
   * base has it too. Field notes are another record (journal.ts).
   *
   * A note that repeats one of the run's last NOTE_REPEATS notes word for word, once folded
   * (foldText), is refused in words (goal 117): one trial once wrote the same two words thousands
   * of times.
   */
  addNote(
    run: string,
    lane: string | null,
    text: string,
    sources: string[] = [],
    trial?: string | undefined,
  ) {
    const body = text.trim().slice(0, 4000);
    if (!body) throw new LedgerError("invalid", "a note needs its text");
    const key = foldText(body);
    const same = this.all(
      "select id, lane, created_at, text from note where run = ? order by id desc limit ?",
      run,
      NOTE_REPEATS,
    ).find((n) => foldText(String(n.text)) === key);
    if (same)
      throw new LedgerError(
        "invalid",
        `this note repeats note ${String(same.id)} (by ${String(same.lane ?? "research")}, ${String(same.created_at)}) word for word: it is not recorded again. Record what is new, or go on with the work`,
      );
    const cited = sources.slice(0, 20);
    const first = cited.length
      ? this.get("select url from source where run = ? and id = ?", run, cited[0] as string)
      : undefined;
    const id = this.ledger.tx(() => {
      const r = this.ledger.db
        .prepare("insert into note (run, lane, text, sources, created_at) values (?, ?, ?, ?, ?)")
        .run(run, lane, body, canonicalJson(cited), new Date().toISOString());
      const id = Number(r.lastInsertRowid);
      this.ledger.appendEvent(lane ?? "research", "research_note", run, {
        note: id,
        by: lane ?? "research",
        text: body,
        sources: cited,
        ...(first ? { url: String(first.url) } : {}),
        ...(trial ? { trial } : {}),
      });
      return id;
    });
    this.changed(run);
    return { note: id };
  }

  /** A question's index as a hypothesis takes it: one of the contract's, or a refusal in words. */
  private questionOf(run: string, q: number | null | undefined): number | null {
    if (q === undefined || q === null) return null;
    const n = this.contract(run).questions.length;
    if (!Number.isInteger(q) || q < 0 || q >= n)
      throw new LedgerError(
        "invalid",
        `no question ${q}: "question" is the index of one of the campaign's ${n} questions, from 0 to ${n - 1}`,
      );
    return q;
  }

  /** The run's live hypothesis (the author's, the pool's or promoted) whose words these repeat. */
  private twinOf(run: string, text: string, except?: string | undefined): Row | undefined {
    const key = foldText(text);
    return this.all(
      `select id, lane, status, text from hypothesis where run = ? and status in (${LIVE_HYPOTHESES.map(() => "?").join(", ")}) order by created_at, rowid`,
      run,
      ...LIVE_HYPOTHESES,
    ).find((h) => String(h.id) !== except && foldText(String(h.text)) === key);
  }

  /** The verified claims of the run among these ids, and the rest. */
  private verifiedAmong(run: string, ids: string[]): { ok: string[]; ignored: string[] } {
    const known = new Set(
      this.all("select id from claim where run = ? and verified = 1", run).map((r) => String(r.id)),
    );
    const unique = [...new Set(ids)];
    return { ok: unique.filter((c) => known.has(c)), ignored: unique.filter((c) => !known.has(c)) };
  }

  /**
   * A worker's hypothesis for the run's pool (goal 117): its text, the question it is about (an
   * index of the contract's questions, or none: the whole run) and the verified claims behind it
   * (others are ignored, and said). Refused in words: an empty text, a question the run does not
   * have, and words that repeat a live hypothesis of the run once folded (the author's, the
   * pool's or a promoted one), naming it, so the worker revises it instead. Only the author's and
   * promoted hypotheses need a verdict from the review panel; the report lists the pool's.
   */
  proposeHypothesis(run: string, lane: string | null, input: unknown) {
    const p = HypothesisInput.safeParse(input);
    if (!p.success)
      throw new LedgerError(
        "invalid",
        `a hypothesis is {"text", "question"?: the index of a campaign question, from 0, "supporting"?: verified claim ids}: ${p.error.issues[0]?.path.join(".") || "it"} ${p.error.issues[0]?.message ?? "is not valid"}`,
      );
    const text = p.data.text.trim().slice(0, HYPOTHESIS_MAX);
    if (!text) throw new LedgerError("invalid", "a hypothesis needs its text");
    const question = this.questionOf(run, p.data.question);
    const twin = this.twinOf(run, text);
    if (twin) throw new LedgerError("invalid", repeatsWords(twin));
    const { ok, ignored } = this.verifiedAmong(run, p.data.supporting);
    const id = `h-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          "insert into hypothesis (id, run, lane, question, text, supporting, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 'pool', ?, ?)",
        )
        .run(id, run, lane, question, text, canonicalJson(ok), now, now);
      // So the campaign's folder in the knowledge base holds the run's hypotheses too.
      this.ledger.appendEvent(lane ?? "research", "hypothesis_added", run, {
        hypothesis: id,
        lane: lane ?? null,
        text,
        supporting: ok,
        question,
        status: "pool",
      });
    });
    this.changed(run);
    return {
      hypothesis: id,
      status: "pool",
      question,
      supporting: ok,
      ignored,
      note: "in the run's pool: only the author's hypotheses and promoted ones need a verdict from the review panel; change this one with revise_hypothesis",
    };
  }

  /**
   * A worker changes a pool hypothesis (goal 117): its text, its question (null: the whole run)
   * or its supporting claims (verified claims of the run; the list replaces the old one). The
   * author's hypotheses change only with the brief, and a merged or retired one not at all: each
   * is refused in words. A revision whose words repeat another live hypothesis merges this one
   * into it: status `merged`, `merged_into` the other, and the work goes on there.
   */
  reviseHypothesis(run: string, lane: string | null, input: unknown) {
    const p = HypothesisRevision.safeParse(input);
    if (!p.success)
      throw new LedgerError(
        "invalid",
        `a revision is {"id", "text"?, "question"?: the index of a campaign question from 0, or null, "supporting"?: verified claim ids}: ${p.error.issues[0]?.path.join(".") || "it"} ${p.error.issues[0]?.message ?? "is not valid"}`,
      );
    const r = p.data;
    const h = this.get("select * from hypothesis where run = ? and id = ?", run, r.id.trim());
    if (!h) throw new LedgerError("not_found", `no hypothesis ${r.id} in this run`);
    const id = String(h.id);
    const status = String(h.status);
    if (status === "author")
      throw new LedgerError(
        "invalid",
        `hypothesis ${id} is one of the author's: only the campaign's brief changes it. Record claims for or against it, or propose a hypothesis of your own`,
      );
    if (status === "merged")
      throw new LedgerError(
        "invalid",
        `hypothesis ${id} was merged into ${String(h.merged_into)}: revise ${String(h.merged_into)} instead`,
      );
    if (status === "retired") throw new LedgerError("invalid", `hypothesis ${id} is retired`);
    if (r.text === undefined && r.question === undefined && r.supporting === undefined)
      throw new LedgerError(
        "invalid",
        "a revision needs what changes: text, question or supporting (or more than one)",
      );
    const text = r.text === undefined ? String(h.text) : r.text.trim().slice(0, HYPOTHESIS_MAX);
    if (!text) throw new LedgerError("invalid", "a hypothesis needs its text");
    const question =
      r.question === undefined
        ? h.question === null
          ? null
          : Number(h.question)
        : this.questionOf(run, r.question);
    let supporting = JSON.parse(String(h.supporting)) as string[];
    let ignored: string[] = [];
    if (r.supporting !== undefined) {
      const v = this.verifiedAmong(run, r.supporting);
      if (r.supporting.length && !v.ok.length)
        throw new LedgerError(
          "invalid",
          `none of ${v.ignored.join(", ")} is a verified claim of this run: the supporting claims stay as they were`,
        );
      supporting = v.ok;
      ignored = v.ignored;
    }
    const twin = r.text === undefined ? undefined : this.twinOf(run, text, id);
    const now = new Date().toISOString();
    const by = lane ?? "research";
    if (twin) {
      const into = String(twin.id);
      this.ledger.tx(() => {
        this.ledger.db
          .prepare(
            "update hypothesis set text = ?, question = ?, supporting = ?, status = 'merged', merged_into = ?, updated_at = ? where id = ?",
          )
          .run(text, question, canonicalJson(supporting), into, now, id);
        this.ledger.appendEvent(by, "hypothesis_merged", run, {
          hypothesis: id,
          into,
          lane: lane ?? null,
          text,
          question,
          supporting,
        });
      });
      this.changed(run);
      return {
        hypothesis: id,
        status: "merged",
        merged_into: into,
        note: `its new words repeat ${into}, so it is merged into ${into}: work on ${into} from now on`,
      };
    }
    const same =
      text === String(h.text) &&
      question === (h.question === null ? null : Number(h.question)) &&
      canonicalJson(supporting) === String(h.supporting);
    if (same)
      return { hypothesis: id, status, question, supporting, ignored, note: "nothing changed" };
    this.ledger.tx(() => {
      this.ledger.db
        .prepare(
          "update hypothesis set text = ?, question = ?, supporting = ?, updated_at = ? where id = ?",
        )
        .run(text, question, canonicalJson(supporting), now, id);
      this.ledger.appendEvent(by, "hypothesis_revised", run, {
        hypothesis: id,
        lane: lane ?? null,
        text,
        question,
        supporting,
        status,
      });
    });
    this.changed(run);
    return { hypothesis: id, status, text, question, supporting, ignored };
  }

  /**
   * Promotes, returns or retires a hypothesis (goal 117), as setHypothesisStatus does; the folder
   * follows. The planner's promotions and retirements come here, as the owner's command does.
   */
  hypothesisStatus(run: string, input: unknown, by: string) {
    const r = setHypothesisStatus(this.ledger, run, input, by);
    if (r.changed) this.changed(run);
    return r;
  }

  /**
   * A finding: a worker's conclusion, with a summary and why it matters, citing verified claims.
   * Code checks it: every cited claim must be a verified claim of this run, and every number in
   * its text, summary and why must appear in those claims (their text or quotes). Otherwise it
   * is kept as a draft finding, with the problems.
   */
  addFinding(run: string, lane: string | null, input: unknown) {
    const f = FindingInput.parse(input);
    const cited = [...new Set(f.supporting)];
    // The check a review panel's answer shares (checks.ts).
    const { problems } = checkCited(this.ledger, run, cited, [f.text, f.summary, f.why_it_matters]);
    const supported = problems.length === 0;
    // The same statement again: a supported one is kept once, and a draft refused for the same
    // reasons is answered again, not recorded again, so a worker that resends it in a loop learns
    // what to change and fills no records.
    const key = claimKey(f.text);
    const reasons = canonicalJson(problems);
    const before = this.all(
      "select id, text, supported, problems from finding where run = ? order by created_at",
      run,
    ).find(
      (r) =>
        claimKey(String(r.text)) === key &&
        (Number(r.supported) === 1 || (!supported && String(r.problems) === reasons)),
    );
    if (before)
      return Number(before.supported) === 1
        ? {
            finding: String(before.id),
            supported: true,
            problems: [],
            note: "this finding is already recorded, supported: record a finding only for a new conclusion",
          }
        : {
            finding: String(before.id),
            supported: false,
            problems,
            note: "this same finding was refused before for the same reasons: cite only verified claims, use only numbers those claims contain, or record what you learned as a note (add_note) instead",
          };
    const id = `f-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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
      // The finding's statement, summary and why it matters, bounded.
      this.ledger.appendEvent(lane ?? "research", "finding_added", run, {
        finding: id,
        supported,
        claims: cited.length,
        statement: clip(f.text, 1000),
        summary: clip(f.summary, 1000),
        why: clip(f.why_it_matters, 500),
      });
    });
    this.changed(run);
    return { finding: id, supported, problems };
  }

  /**
   * The hypotheses as a research worker's brief shows them (goal 117): what needs a verdict and
   * what does not, those that need one (the author's first, then promoted ones) each with its
   * question, and the newest of the pool; the folder lists them all.
   */
  hypothesesBrief(run: string): string {
    const rows = this.all(
      "select id, status, question, text from hypothesis where run = ? order by created_at, rowid",
      run,
    );
    const where = (h: Row) =>
      h.question === null ? "the whole run" : questionLabel(Number(h.question));
    const line = (h: Row, n: number) =>
      `- ${String(h.id)} (${hypothesisStatusWords(String(h.status))}; ${where(h)}): ${clip(String(h.text).replace(/\s+/g, " ").trim(), n)}`;
    const required = [
      ...rows.filter((h) => h.status === "author"),
      ...rows.filter((h) => h.status === "promoted"),
    ];
    const pool = rows.filter((h) => h.status === "pool");
    return [
      "# Hypotheses",
      HYPOTHESES_RULE,
      ...(required.length
        ? [
            "They need a verdict:",
            ...required.slice(0, BRIEF_REQUIRED).map((h) => line(h, 400)),
            ...(required.length > BRIEF_REQUIRED
              ? [`… and ${required.length - BRIEF_REQUIRED} more in INDEX.md`]
              : []),
          ]
        : ["None needs a verdict: the brief has no hypotheses, and none was promoted."]),
      ...(pool.length
        ? [
            `The pool has ${pool.length}${pool.length > BRIEF_POOL ? `; the newest ${BRIEF_POOL}` : ""}:`,
            ...pool.slice(-BRIEF_POOL).map((h) => line(h, 200)),
          ]
        : ["The pool is empty."]),
      "Every hypothesis, with its status and question: INDEX.md and hypotheses/ in the research folder.",
    ].join("\n");
  }

  /**
   * What a research trial added (goal 117), from the records its lane wrote between the trial's
   * start and now (a lane runs one trial at a time): its verified claims, by question, and how
   * many brought a registrable domain its question's claims had not cited before; the registrable
   * domains new to the run among the pages it fetched; its supported findings. Cards come later in
   * goal 117: their changes are 0 for now. Undefined for a trial the ledger does not have.
   */
  trialYield(run: string, trial: string, until = new Date().toISOString()): TaskYield | undefined {
    const t = this.get("select lane, started_at from trial where id = ? and run = ?", trial, run);
    if (!t) return undefined;
    const lane = String(t.lane);
    const since = String(t.started_at);
    const domainOf = new Map(
      this.all("select id, domain from source where run = ?", run).map((s) => [
        String(s.id),
        registrableDomain(String(s.domain)),
      ]),
    );
    const domainsOf = (quotes: unknown) =>
      new Set(
        (JSON.parse(String(quotes)) as { source: string }[]).flatMap((q) => {
          const d = domainOf.get(q.source);
          return d ? [d] : [];
        }),
      );
    // What each question's verified claims cited before the trial started.
    const seen = new Map<number, Set<string>>();
    for (const c of this.all(
      "select question, quotes from claim where run = ? and verified = 1 and question is not null and created_at < ?",
      run,
      since,
    )) {
      const q = Number(c.question);
      seen.set(q, new Set([...(seen.get(q) ?? []), ...domainsOf(c.quotes)]));
    }
    const by = new Map<number, { verified_claims: number; new_domain_claims: number }>();
    let total = 0;
    let none = 0;
    for (const c of this.all(
      "select question, quotes from claim where run = ? and lane = ? and verified = 1 and created_at >= ? and created_at <= ? order by created_at, rowid",
      run,
      lane,
      since,
      until,
    )) {
      total++;
      if (c.question === null) {
        none++;
        continue;
      }
      const q = Number(c.question);
      const had = seen.get(q) ?? new Set<string>();
      const ds = domainsOf(c.quotes);
      const fresh = [...ds].some((d) => !had.has(d));
      seen.set(q, new Set([...had, ...ds]));
      const row = by.get(q) ?? { verified_claims: 0, new_domain_claims: 0 };
      row.verified_claims++;
      if (fresh) row.new_domain_claims++;
      by.set(q, row);
    }
    const before = new Set(
      this.all("select domain from source where run = ? and fetched_at < ?", run, since).map((s) =>
        registrableDomain(String(s.domain)),
      ),
    );
    const fresh = [
      ...new Set(
        this.all(
          "select domain from source where run = ? and fetched_by = ? and fetched_at >= ? and fetched_at <= ? order by fetched_at",
          run,
          lane,
          since,
          until,
        )
          .map((s) => registrableDomain(String(s.domain)))
          .filter((d) => !before.has(d)),
      ),
    ];
    const findings = Number(
      this.get(
        "select count(*) as n from finding where run = ? and lane = ? and supported = 1 and created_at >= ? and created_at <= ?",
        run,
        lane,
        since,
        until,
      )?.n ?? 0,
    );
    return {
      verified_claims: total,
      by_question: [...by.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([question, r]) => ({ question, ...r })),
      no_question: none,
      new_domains: fresh.length,
      domains: fresh.slice(0, 20),
      findings,
      card_changes: 0,
    };
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

  /**
   * Running time against the contract's durations. Paused time does not count, and neither does
   * time the agents could not run (goal 079): while they were stopped (no credits, a refused key,
   * a failing model check) or waited for the provider's rate limit. The minimum is a floor, never
   * a stop: after it, a run ends when the review panel finds every question answered (goal 112),
   * at its maximum, or when the owner closes it.
   */
  /** The run's clock; with `now`, as it stood then (running time up to that moment). */
  clock(run: string, now = Date.now()) {
    const c = this.contract(run);
    const created = String(this.get("select created_at from run where id = ?", run)?.created_at);
    const running: [number, number][] = [];
    let since: number | null = Date.parse(created);
    for (const e of this.all(
      "select at, body from event where kind in ('run_status', 'instance_status') and subject = ? order by id",
      run,
    )) {
      const status = (JSON.parse(String(e.body)) as { status?: string }).status;
      const at = Date.parse(String(e.at));
      if (at > now) break;
      if (status === "running") since ??= at;
      else if (since !== null) {
        running.push([since, at]);
        since = null;
      }
    }
    if (since !== null) running.push([since, now]);
    const blocked = this.agentsBlocked(run, now);
    let elapsedMs = 0;
    let waitedMs = 0;
    for (const [a, b] of running) {
      let lost = 0;
      for (const [x, y] of blocked) lost += Math.max(0, Math.min(b, y) - Math.max(a, x));
      elapsedMs += b - a - lost;
      waitedMs += lost;
    }
    const minMs = parseDuration(c.min_duration as string);
    const maxMs = c.max_duration ? parseDuration(c.max_duration) : null;
    return {
      started_at: created,
      elapsed_ms: elapsedMs,
      /** Running time the agents could not work: not counted (goal 079). */
      waited_ms: waitedMs,
      min_ms: minMs,
      max_ms: maxMs,
      done: maxMs !== null && elapsedMs >= maxMs,
    };
  }

  /**
   * When the run's agents could not run (goal 079), merged and in order: from each agents_stopped
   * to the agents_resumed after it (or now), each wait for the provider's rate limit until the
   * time it named, and each wait for the run's MCP servers (goal 068) from its start to its end.
   */
  private agentsBlocked(run: string, now: number): [number, number][] {
    const spans: [number, number][] = [];
    let stoppedAt: number | null = null;
    for (const e of this.all(
      "select kind, at, body from event where kind in ('agents_stopped', 'agents_resumed', 'agents_wait_for_limit', 'mcp_servers_wait') and subject = ? order by id",
      run,
    )) {
      const at = Date.parse(String(e.at));
      if (e.kind === "agents_stopped") stoppedAt ??= at;
      else if (e.kind === "agents_resumed") {
        if (stoppedAt !== null) spans.push([stoppedAt, at]);
        stoppedAt = null;
      } else if (e.kind === "mcp_servers_wait") {
        const since = Date.parse(String((JSON.parse(String(e.body)) as { since?: string }).since));
        if (!Number.isNaN(since) && since < at) spans.push([since, at]);
      } else {
        const until = Date.parse(String((JSON.parse(String(e.body)) as { until?: string }).until));
        if (!Number.isNaN(until) && until > at) spans.push([at, Math.min(until, now)]);
      }
    }
    if (stoppedAt !== null) spans.push([stoppedAt, now]);
    spans.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const s of spans) {
      const last = merged.at(-1);
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    return merged;
  }

  /**
   * Distinct registrable domains a verified claim's quotes come from (goal 117): a source keeps
   * the host it was fetched from, and docs.example.com and blog.example.com count as one.
   */
  private claimDomains(run: string, quotesJson: string): number {
    const ids = (JSON.parse(quotesJson) as { source: string }[]).map((q) => q.source);
    const domains = new Set<string>();
    for (const id of ids) {
      const d = this.get("select domain from source where run = ? and id = ?", run, id)?.domain;
      if (d !== undefined && d !== null) domains.add(registrableDomain(String(d)));
    }
    return domains.size;
  }

  /** The run's distinct registrable domains (goal 117). */
  private domains(run: string): number {
    return new Set(
      this.all("select distinct domain from source where run = ?", run).map((r) =>
        registrableDomain(String(r.domain)),
      ),
    ).size;
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
      domains: this.domains(run),
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
   * A report version from the ledger: each question's answer card first (goal 117), then
   * sections, the verified claims with their sources, the hypotheses with their support, the
   * open questions, and numbers in the sections that appear in no archived source and no verified
   * claim (flagged, not hidden).
   *
   * A final report of a run that ended (goals 112 and 117: its questions answered, or stopped by
   * the progress rule) starts with its research paper, when code accepted one; the review panel's
   * decisions and the corpus follow it, as an appendix. Without a paper it says why: `noPaper`,
   * or what the records show.
   */
  report(run: string, kind: "digest" | "final", opts: { noPaper?: string | undefined } = {}) {
    const c = this.contract(run);
    const papers = new Papers(this.ledger, () => c);
    const paper = kind === "final" ? papers.accepted(run) : undefined;
    const noPaper =
      kind === "final" && !paper && researchEnd(this.ledger, run)
        ? (opts.noPaper ??
          (papers.requested(run)
            ? "the run ended before the final writer's paper passed the harness's checks"
            : "the run ended before a final writer was asked for one"))
        : undefined;
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
    const supported = claimNumbers(claims);
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
      // Where the check that every question is answered stands (goal 112).
      ...(kind === "digest" ? [checkLine(this.ledger, run, c, clock)] : []),
      "",
      // Why an answered run has no research paper (goal 112).
      ...(noPaper ? [`Research paper: none, ${noPaper}.`, ""] : []),
      // Each question's answer card first (goal 117), for people: "Question 1".
      ...answersSection(this.ledger, run, c, fence),
      // The review panel's answers and verdicts (goal 112): one block, after the paper.
      ...(kind === "final" ? answerSections(this.ledger, run, c, fence) : []),
      "## Questions",
      // A question may have several lines (goal 078): its further lines stay under it.
      // Numbered from 1, with the index a claim's `question` takes: workers read REPORT.md too.
      ...stats.questions.map(
        (q, i) =>
          `- ${questionLabel(i)}: ${q.question.replace(/\n/g, "\n  ")} (${q.verified} verified claims)`,
      ),
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
      // Those that need a verdict first: the author's, then promoted ones; then the pool and the
      // rest, each with its status and question (goal 117).
      "## Hypotheses",
      ...this.all(
        "select id, text, supporting, status, question, merged_into from hypothesis where run = ? order by case status when 'author' then 0 when 'promoted' then 1 when 'pool' then 2 else 3 end, created_at, rowid",
        run,
      ).map(
        (h) =>
          `- ${fence(String(h.text)).replace(/\n+/g, " ")} (${String(h.id)}, ${hypothesisStatusWords(String(h.status), h.merged_into === null ? null : String(h.merged_into))}; ${h.question === null ? "the whole run" : questionLabel(Number(h.question))}; supported by ${(JSON.parse(String(h.supporting)) as string[]).length} verified claims)`,
      ),
      "",
      "## Open questions",
      ...stats.questions.flatMap((q, i) =>
        q.verified === 0 ? [`- ${questionLabel(i)}: ${q.question.replace(/\n/g, "\n  ")}`] : [],
      ),
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
    // The paper first, whole, with its appendices; then the rest as supplementary material.
    const body = paper
      ? [
          String(paper.paper).replace(/\s+$/, ""),
          "",
          "---",
          "",
          `# Supplementary material: the review panel's decisions and the corpus of ${c.title}`,
          ...lines.slice(1),
        ].join("\n")
      : lines.join("\n");
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
          // So the run's page can say when the answer check starts (goal 112).
          min_ms: clock.min_ms,
          max_ms: clock.max_ms,
          min_verified_claims: c.min_verified_claims ?? null,
          // A final report: whether it starts with a research paper, or why not (goal 112).
          ...(kind === "final" ? { paper: paper !== undefined } : {}),
          ...(noPaper ? { no_paper: noPaper } : {}),
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
