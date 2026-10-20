import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log, redact } from "../common/env.ts";
import type { KbItem, KnowledgeBase } from "./kb.ts";
import { keyHint, type SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store.ts";

/**
 * Outside knowledge bases (goal 065), all optional: a GBrain-style brain, or any MCP server with
 * a search tool. Thermite's own knowledge base (kb.ts) is where the research lives; an outside
 * one has two roles only:
 *
 * - a sync target: control copies a campaign's folder to it, one page per item, through its write
 *   tool, when the owner switches that on for the campaign;
 * - outside context: a campaign the owner grants it ("outside:<name>" in the folder's read list)
 *   gives its advisors the server's search, through the rig's supervisor.
 *
 * The token is sealed with control's secret box. It is never shown again, never logged, never in
 * a URL, a page or the audit; a rig gets it only when it runs or ran a campaign granted to read it.
 * With no outside knowledge base set, nothing here runs.
 */

export const OUTSIDE_KB_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An MCP tool's name (the protocol allows letters, digits and a few marks). */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/;

/** An outside knowledge base as control shows it: its token only as a hint. */
export interface OutsideKb {
  name: string;
  mcp_url: string;
  token_hint: string;
  /** The tool advisors search with (called with { query }). */
  search_tool: string;
  /** The tool control writes pages with (called with { slug, content }); none: no copies. */
  write_tool: string | null;
  /** The tools the server listed at the last check. */
  tools: string[] | null;
  checked_at: string | null;
  check_error: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

/** A campaign folder control copies to an outside knowledge base, and how the last sync went. */
export interface OutsideKbCopy {
  kb: string;
  campaign: string;
  enabled_by: string;
  enabled_at: string;
  /** Where the next sync starts: the seq of the last item written (the index's change counter). */
  cursor: number;
  /** Pages written since the copy was switched on. */
  written: number;
  last_at: string | null;
  last_written: number | null;
  last_error: string | null;
}

/** What a rig's supervisor gets for its advisors: one outside search, for the campaigns granted. */
export interface OutsideKbGrant {
  name: string;
  mcp_url: string;
  token: string;
  tool: string;
  campaigns: string[];
}

/** The grant in a campaign's read list (kb.ts) that names an outside knowledge base. */
export const outsideRead = (name: string) => `outside:${name}`;

const SCHEMA = `
-- Outside knowledge bases (optional): an MCP server, its token sealed (control's secret box), the
-- tool advisors search with and, for copies, the tool control writes pages with.
create table if not exists outside_kb (
  name text primary key,
  mcp_url text not null,
  token_sealed text not null,
  token_hint text not null,
  search_tool text not null,
  write_tool text,
  tools text,
  checked_at text,
  check_error text,
  created_at text not null,
  created_by text not null,
  updated_at text not null
);
-- Campaign folders control copies to an outside knowledge base: who switched it on, where the
-- next sync starts, and how the last one went.
create table if not exists outside_kb_copy (
  kb text not null,
  campaign text not null,
  enabled_by text not null,
  enabled_at text not null,
  cursor integer not null default 0,
  written integer not null default 0,
  last_at text,
  last_written integer,
  last_error text,
  primary key (kb, campaign)
);
`;

/** One MCP connection, as control uses it: the tool list and tool calls. */
export interface McpSession {
  listTools(): Promise<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean | undefined; content?: unknown }>;
  close(): Promise<void>;
}
export type McpConnect = (url: string, token: string) => Promise<McpSession>;

/** Streamable HTTP with the token as a bearer header (never in the URL). */
export function mcpConnect(fetchImpl?: typeof fetch): McpConnect {
  return async (url, token) => {
    const client = new Client({ name: "thermite-control", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
      { timeout: 30_000 },
    );
    return {
      listTools: async () => {
        const out: Awaited<ReturnType<McpSession["listTools"]>> = [];
        let cursor: string | undefined;
        // A server pages its list; 20 pages are far more tools than any brain has.
        for (let page = 0; page < 20; page++) {
          const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
          out.push(...r.tools);
          cursor = r.nextCursor;
          if (!cursor) break;
        }
        return out;
      },
      callTool: async (name, args) =>
        (await client.callTool({ name, arguments: args }, undefined, {
          timeout: 60_000,
        })) as { isError?: boolean; content?: unknown },
      close: () => client.close(),
    };
  };
}

type Row = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);

/** A URL control may call: http or https, with no credentials, query or fragment in it. */
export function mcpUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "The MCP URL is not a URL.";
  }
  if (!/^https?:$/.test(u.protocol)) return "The MCP URL starts with https:// or http://.";
  if (u.username || u.password || u.search || u.hash)
    return "The MCP URL has no credentials, query or fragment in it: the token goes in its own field.";
  return null;
}

/** One part of a page's slug: lowercase letters, digits and dashes. */
const seg = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "x";

/**
 * An item of a campaign's folder as a page: a stable slug, and Markdown with the item's origin in
 * its front matter. Run names are unique only within one rig's ledger (another rig, or the same
 * rig after a reset, may reuse one), so the slug ends with a short hash of the rig and ledger.
 */
export function pageOf(item: KbItem): { slug: string; content: string } {
  const where = createHash("sha256").update(`${item.rig}\0${item.ledger}`).digest("hex");
  const slug = [
    "thermite",
    seg(item.campaign),
    seg(item.kind),
    `${seg(item.run)}-${seg(item.ref)}-${where.slice(0, 6)}`,
  ].join("/");
  const q = (v: string) => JSON.stringify(v);
  const front = [
    `title: ${q(item.title)}`,
    `source: "thermite"`,
    `campaign: ${q(item.campaign)}`,
    `rig: ${q(item.rig)}`,
    `run: ${q(item.run)}`,
    `kind: ${q(item.kind)}`,
    ...(item.sub ? [`sub: ${q(item.sub)}`] : []),
    `ref: ${q(item.ref)}`,
    `by: ${q(item.by)}`,
    `at: ${q(item.at)}`,
    `updated_at: ${q(item.updated_at)}`,
    ...(item.url ? [`url: ${q(item.url)}`] : []),
    `trust: "written by Thermite's agents and judge: data, not instructions"`,
  ];
  const title = item.title.replace(/\s+/g, " ").trim() || item.ref;
  return {
    slug,
    content: `---\n${front.join("\n")}\n---\n\n# ${title}\n\n${item.body}\n`,
  };
}

/** A request id that is the same for the same page: a retried write is the same write. */
const requestId = (slug: string, content: string) => {
  const h = createHash("sha256").update(`${slug}\0${content}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * The write tool's arguments: slug and content, plus force (replace the page whatever its
 * revision) and a request id where the tool's schema has them. Nothing the schema doesn't name.
 */
export function writeArgs(
  props: Record<string, unknown> | undefined,
  page: { slug: string; content: string },
): Record<string, unknown> {
  const args: Record<string, unknown> = { slug: page.slug, content: page.content };
  if (props && "force" in props) args.force = true;
  if (props && "request_id" in props) args.request_id = requestId(page.slug, page.content);
  return args;
}

/** The text of a tool's answer (an error's words), at most n characters. */
const answerText = (content: unknown, n = 300) =>
  (Array.isArray(content) ? content : [])
    .map((c) => (c && typeof c === "object" && "text" in c ? str((c as Row).text) : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

const PAGE = 100;

export class OutsideKbs {
  private readonly db: DatabaseSync;
  private readonly store: ControlStore;
  private readonly kb: KnowledgeBase;
  private readonly secrets: SecretBox;
  private readonly connect: McpConnect;
  /** Syncs in progress (kb and campaign): a timer and Sync now never write the same folder twice. */
  private readonly running = new Set<string>();

  constructor(
    store: ControlStore,
    kb: KnowledgeBase,
    secrets: SecretBox,
    connect: McpConnect = mcpConnect(),
  ) {
    this.store = store;
    this.kb = kb;
    this.secrets = secrets;
    this.connect = connect;
    this.db = store.db;
    this.db.exec(SCHEMA);
  }

  list(): OutsideKb[] {
    return (this.db.prepare("select * from outside_kb order by name").all() as Row[]).map(kbOf);
  }

  get(name: string): OutsideKb | undefined {
    const r = this.db.prepare("select * from outside_kb where name = ?").get(name) as
      | Row
      | undefined;
    return r ? kbOf(r) : undefined;
  }

  /**
   * Adds an outside knowledge base or changes one. A change without a token keeps the sealed one;
   * a new one needs its token, and so does a new server (another origin): the sealed token never
   * goes to an address it was not given for. The audit names the token's hint, never the token.
   */
  put(
    p: {
      name: string;
      mcp_url: string;
      token?: string | undefined;
      search_tool: string;
      write_tool: string | null;
    },
    by: string,
  ): "created" | "changed" | "needs_token" {
    const old = this.get(p.name);
    if (!p.token && (!old || new URL(old.mcp_url).origin !== new URL(p.mcp_url).origin))
      return "needs_token";
    const now = new Date().toISOString();
    const sealed = p.token ? this.secrets.seal(p.token) : undefined;
    const hint = p.token ? keyHint(p.token) : undefined;
    this.db
      .prepare(
        `insert into outside_kb (name, mcp_url, token_sealed, token_hint, search_tool, write_tool,
           created_at, created_by, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (name) do update set mcp_url = excluded.mcp_url,
           token_sealed = coalesce(?, outside_kb.token_sealed),
           token_hint = coalesce(?, outside_kb.token_hint),
           search_tool = excluded.search_tool, write_tool = excluded.write_tool,
           updated_at = excluded.updated_at, tools = null, checked_at = null, check_error = null`,
      )
      .run(
        p.name,
        p.mcp_url,
        sealed ?? "",
        hint ?? "",
        p.search_tool,
        p.write_tool,
        now,
        by,
        now,
        sealed ?? null,
        hint ?? null,
      );
    const r = old ? "changed" : "created";
    this.store.audit(by, r === "created" ? "outside_kb_added" : "outside_kb_changed", {
      name: p.name,
      mcp_url: p.mcp_url,
      search_tool: p.search_tool,
      write_tool: p.write_tool,
      token: p.token ? `${old ? "replaced" : "set"} (${hint})` : "kept",
    });
    return r;
  }

  /** Forgets an outside knowledge base: its token, its copies and every campaign's grant of it. */
  delete(name: string, by: string): boolean {
    if (!this.get(name)) return false;
    for (const c of this.readers(name)) this.kb.revoke(c, outsideRead(name));
    this.db.prepare("delete from outside_kb_copy where kb = ?").run(name);
    this.db.prepare("delete from outside_kb where name = ?").run(name);
    this.store.audit(by, "outside_kb_deleted", { name });
    return true;
  }

  private token(k: OutsideKb): string {
    const r = this.db.prepare("select token_sealed from outside_kb where name = ?").get(k.name) as
      | { token_sealed: string }
      | undefined;
    if (!r) throw new Error("no such outside knowledge base");
    return this.secrets.open(r.token_sealed);
  }

  /** An error's words with the token taken out, whatever the server or a library echoed. */
  private clean(err: unknown, token: string | undefined): string {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    let text = e?.message ?? String(err);
    if (e?.cause?.code) text = `${text} (${e.cause.code})`;
    if (token) text = text.split(token).join("***");
    return redact(text).slice(0, 500);
  }

  /**
   * Reads the server's tool list with the token and says what is missing: the search tool, the
   * write tool, or a write tool that takes no slug and content. Null when all is there.
   */
  async check(name: string): Promise<string | null> {
    const k = this.get(name);
    if (!k) return "no such outside knowledge base";
    const done = (tools: string[] | null, error: string | null) => {
      this.db
        .prepare(
          "update outside_kb set tools = coalesce(?, tools), checked_at = ?, check_error = ? where name = ?",
        )
        .run(tools ? JSON.stringify(tools) : null, new Date().toISOString(), error, name);
      return error;
    };
    let token: string;
    try {
      token = this.token(k);
    } catch {
      return done(null, "its token cannot be opened: enter it again");
    }
    let session: McpSession | undefined;
    try {
      session = await this.connect(k.mcp_url, token);
      const tools = await session.listTools();
      const names = tools.map((t) => t.name).slice(0, 500);
      const missing: string[] = [];
      if (!names.includes(k.search_tool))
        missing.push(`it has no tool "${k.search_tool}" to search`);
      if (k.write_tool) {
        const w = tools.find((t) => t.name === k.write_tool);
        const props = w?.inputSchema?.properties;
        if (!w) missing.push(`it has no tool "${k.write_tool}" to write pages`);
        else if (props && !("slug" in props && "content" in props))
          missing.push(`its tool "${k.write_tool}" takes no slug and content`);
      }
      return done(names, missing.length ? missing.join("; ") : null);
    } catch (err) {
      return done(null, `could not read its tool list: ${this.clean(err, token)}`);
    } finally {
      await session?.close().catch(() => {});
    }
  }

  copies(o: { campaign?: string; kb?: string } = {}): OutsideKbCopy[] {
    const where = [
      ...(o.campaign !== undefined ? ["campaign = ?"] : []),
      ...(o.kb !== undefined ? ["kb = ?"] : []),
    ];
    return (
      this.db
        .prepare(
          `select * from outside_kb_copy${where.length ? ` where ${where.join(" and ")}` : ""} order by kb, campaign`,
        )
        .all(
          ...(o.campaign !== undefined ? [o.campaign] : []),
          ...(o.kb !== undefined ? [o.kb] : []),
        ) as Row[]
    ).map(copyOf);
  }

  /**
   * Switches the copy of a campaign's folder on or off. On needs a write tool. Off forgets the
   * cursor: switched on again, the folder is written once more from its start.
   */
  setCopy(
    name: string,
    campaign: string,
    on: boolean,
    by: string,
  ): "on" | "off" | "no_write_tool" | "missing" {
    const k = this.get(name);
    if (!k || !campaign) return "missing";
    if (!on) {
      this.db
        .prepare("delete from outside_kb_copy where kb = ? and campaign = ?")
        .run(name, campaign);
      this.store.audit(by, "outside_kb_copy_off", { kb: name, campaign });
      return "off";
    }
    if (!k.write_tool) return "no_write_tool";
    this.db
      .prepare(
        "insert or ignore into outside_kb_copy (kb, campaign, enabled_by, enabled_at) values (?, ?, ?, ?)",
      )
      .run(name, campaign, by, new Date().toISOString());
    this.store.audit(by, "outside_kb_copy_on", { kb: name, campaign });
    return "on";
  }

  /** The campaigns granted to read an outside knowledge base. */
  readers(name: string): string[] {
    return this.kb.readBy(outsideRead(name));
  }

  /** Grants a campaign's advisors the outside search, or takes it back. */
  setRead(name: string, campaign: string, on: boolean, by: string): boolean {
    if (!this.get(name) || !campaign) return false;
    if (on) this.kb.grant(campaign, outsideRead(name), by);
    else this.kb.revoke(campaign, outsideRead(name));
    this.store.audit(by, on ? "outside_kb_read_granted" : "outside_kb_read_revoked", {
      kb: name,
      campaign,
    });
    return true;
  }

  /**
   * Writes a campaign folder's new and changed items to the outside knowledge base, one page per
   * item, oldest change first. The cursor moves after each page written, so a failure leaves the
   * rest for the next sync and nothing is written twice for one change. Off without a write tool.
   * A sync the owner asked for (by) is in the audit with what it did.
   */
  async sync(
    name: string,
    campaign: string,
    by?: string,
  ): Promise<{ written: number; error?: string | undefined; off?: string | undefined }> {
    const r = await this.syncOnce(name, campaign);
    if (by)
      this.store.audit(by, "outside_kb_sync_now", {
        kb: name,
        campaign,
        written: r.written,
        ...(r.error ? { error: r.error } : {}),
        ...(r.off ? { off: r.off } : {}),
      });
    return r;
  }

  private async syncOnce(
    name: string,
    campaign: string,
  ): Promise<{ written: number; error?: string | undefined; off?: string | undefined }> {
    const k = this.get(name);
    const copy = this.copies({ kb: name, campaign })[0];
    if (!k || !copy) return { written: 0, off: "the copy is not switched on" };
    if (!k.write_tool) return { written: 0, off: "it has no write tool" };
    const key = `${name}\0${campaign}`;
    if (this.running.has(key)) return { written: 0, off: "a sync of this folder is running" };
    this.running.add(key);
    let written = 0;
    let token: string | undefined;
    let session: McpSession | undefined;
    let error: string | undefined;
    try {
      token = this.token(k);
      // Control's own index first: the folder as of the rigs' latest reports.
      this.kb.catchUp();
      session = await this.connect(k.mcp_url, token);
      const tool = (await session.listTools()).find((t) => t.name === k.write_tool);
      if (!tool) throw new Error(`it has no tool "${k.write_tool}" to write pages`);
      let cursor = copy.cursor;
      const move = this.db.prepare(
        "update outside_kb_copy set cursor = ?, written = written + 1 where kb = ? and campaign = ?",
      );
      for (;;) {
        // The index's seq moves on every insert and update of an item: each change once.
        const batch = this.kb.changedAfter([campaign], cursor, PAGE);
        for (const item of batch) {
          const r = await session.callTool(
            k.write_tool,
            writeArgs(tool.inputSchema?.properties, pageOf(item)),
          );
          if (r.isError)
            throw new Error(
              `it refused the page for ${item.kind} ${item.ref} of ${item.run}: ${answerText(r.content) || "no reason given"}`,
            );
          move.run(item.seq, name, campaign);
          cursor = item.seq;
          written++;
        }
        if (batch.length < PAGE) break;
      }
    } catch (err) {
      error =
        token === undefined && !session
          ? "its token cannot be opened: enter it again"
          : this.clean(err, token);
    } finally {
      await session?.close().catch(() => {});
      this.running.delete(key);
    }
    const before = copy.last_error;
    this.db
      .prepare(
        "update outside_kb_copy set last_at = ?, last_written = ?, last_error = ? where kb = ? and campaign = ?",
      )
      .run(new Date().toISOString(), written, error ?? null, name, campaign);
    // A new error is logged once, not every round it lasts.
    if (error && error !== before)
      log("control", "outside knowledge base sync failed", { kb: name, campaign, error });
    return { written, error };
  }

  /** Every copy switched on, one after another (control's timer). */
  async syncAll(): Promise<void> {
    for (const c of this.copies()) await this.sync(c.kb, c.campaign);
  }

  /** The campaigns a rig runs or was assigned (from its reports and control's commands). */
  campaignsOfRig(rig: string): string[] {
    const out = new Set<string>();
    for (const r of this.db
      .prepare(
        "select distinct json_extract(body, '$.campaign') as c from rig_event where rig = ? and kind = 'run_created'",
      )
      .all(rig) as Row[])
      if (str(r.c)) out.add(str(r.c));
    for (const r of this.db
      .prepare(
        "select signed from command where rig = ? and kind = 'assign_campaign' and status in ('pending', 'delivered')",
      )
      .all(rig) as Row[]) {
      try {
        const c = (
          JSON.parse(str(r.signed)) as {
            envelope?: { payload?: { contract?: { campaign?: unknown } } };
          }
        ).envelope?.payload?.contract?.campaign;
        if (typeof c === "string" && c) out.add(c);
      } catch {
        // not a command this store wrote
      }
    }
    return [...out].sort();
  }

  /**
   * What a rig's supervisor gets for its advisors: each outside knowledge base granted to a
   * campaign the rig runs or ran, with its token, and those campaigns. Any other rig gets nothing.
   */
  forRig(rig: string): OutsideKbGrant[] {
    const kbs = this.list();
    if (!kbs.length) return [];
    const campaigns = this.campaignsOfRig(rig);
    const out: OutsideKbGrant[] = [];
    for (const k of kbs) {
      const readers = new Set(this.readers(k.name));
      const granted = campaigns.filter((c) => readers.has(c));
      if (!granted.length) continue;
      let token: string;
      try {
        token = this.token(k);
      } catch {
        continue;
      }
      out.push({
        name: k.name,
        mcp_url: k.mcp_url,
        token,
        tool: k.search_tool,
        campaigns: granted,
      });
    }
    return out;
  }
}

function kbOf(r: Row): OutsideKb {
  let tools: string[] | null = null;
  try {
    tools = r.tools ? (JSON.parse(str(r.tools)) as string[]) : null;
  } catch {
    tools = null;
  }
  return {
    name: str(r.name),
    mcp_url: str(r.mcp_url),
    token_hint: str(r.token_hint),
    search_tool: str(r.search_tool),
    write_tool: r.write_tool ? str(r.write_tool) : null,
    tools,
    checked_at: r.checked_at ? str(r.checked_at) : null,
    check_error: r.check_error ? str(r.check_error) : null,
    created_at: str(r.created_at),
    created_by: str(r.created_by),
    updated_at: str(r.updated_at),
  };
}

function copyOf(r: Row): OutsideKbCopy {
  return {
    kb: str(r.kb),
    campaign: str(r.campaign),
    enabled_by: str(r.enabled_by),
    enabled_at: str(r.enabled_at),
    cursor: Number(r.cursor ?? 0),
    written: Number(r.written ?? 0),
    last_at: r.last_at ? str(r.last_at) : null,
    last_written:
      r.last_written === null || r.last_written === undefined ? null : Number(r.last_written),
    last_error: r.last_error ? str(r.last_error) : null,
  };
}
