import {
  cleanMcpError,
  headerSecrets,
  type McpConnect,
  type McpSession,
  mcpConnect,
  mcpUrlProblem,
} from "../common/mcp-client.ts";
import { sha256Hex } from "../core/canonical.ts";
import {
  AGENT_KINDS,
  type AgentKind,
  MCP_SERVER_NAME,
  type McpConnection,
  type McpUnavailable,
} from "../core/mcp.ts";
import { assignedMcpServers, namedBy } from "./mcp-servers/campaigns.ts";
import { migrateOutsideKb } from "./mcp-servers/migrate.ts";
import { OAuthSignIns, type SignInDone } from "./mcp-servers/oauth.ts";
import { type SignIn, SignIns } from "./mcp-servers/sign-in.ts";
import {
  ensureMcpTables,
  MCP_AUTHS,
  type McpServer,
  type McpServerInput,
  type McpStatus,
  type McpTool,
  orNull,
  type Row,
  ServerTable,
  str,
  viewOf,
} from "./mcp-servers/table.ts";
import { keyHint, type SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store.ts";

export {
  assignedMcpServers,
  campaignMcpServers,
  mcpRefusal,
  namedBy,
  RESEARCH_AGENT_KINDS,
  researchMcpRefusal,
} from "./mcp-servers/campaigns.ts";
export type { SignInDone } from "./mcp-servers/oauth.ts";
export type { SignIn } from "./mcp-servers/sign-in.ts";
export {
  ensureMcpTables,
  MCP_AUTHS,
  type McpAuth,
  type McpServer,
  type McpServerInput,
  type McpStatus,
  type McpTool,
  mcpServerNames,
} from "./mcp-servers/table.ts";

/**
 * MCP servers (goal 068): tools from outside Thermite for a campaign's agents. The owner adds a
 * server once, in Settings, with how it signs Thermite in:
 *
 * - OAuth: the owner signs in on the server's own page (authorization code with PKCE, the client
 *   registered by itself when the server allows it); control keeps the sign-in and renews it;
 * - a key: a header and its value, sent with every call;
 * - a client ID and secret: control gets a token from the server with them (client credentials);
 * - none: a public server.
 *
 * Every secret is sealed with control's secret box. It is never shown again (only its last four
 * characters), never logged, never in a URL, a page or the audit. Control reads each server's
 * tools (their names, what they do and whether they only read) and keeps the server's state and
 * its last error. A campaign's kit names the servers its agents use; control hands a rig only the
 * servers the runs it assigned that rig name, with their sign-in as headers, kept in memory there.
 *
 * McpServers is their interface. Its parts are in mcp-servers/: table.ts (a server as control shows
 * it, the table and the rows with their sealed secrets), campaigns.ts (which servers campaigns and
 * runs name), sign-in.ts (the sign-in as headers, renewed), oauth.ts (an OAuth sign-in on the
 * server's page) and migrate.ts (goal 065's outside knowledge bases, once, at the update).
 */

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const DESCRIPTION_MAX = 1000;

export class McpServers {
  private readonly table: ServerTable;
  private readonly store: ControlStore;
  private readonly connect: McpConnect;
  /** The sign-in as headers, with the renewals in progress. */
  private readonly signIns: SignIns;
  /** OAuth sign-ins on the servers' own pages. */
  private readonly oauth: OAuthSignIns;

  constructor(
    store: ControlStore,
    secrets: SecretBox,
    o: { connect?: McpConnect | undefined; fetch?: typeof fetch | undefined } = {},
  ) {
    this.store = store;
    this.table = new ServerTable(store.db, secrets);
    // The SDK's OAuth helpers tell an error answer by `instanceof Response`, and the HTTP server
    // control runs on replaces the global Response: each answer is made again as one, so an
    // ended sign-in reads as invalid_grant and not as a garbled answer.
    const base = o.fetch ?? fetch;
    const fetchImpl: typeof fetch = async (input, init) => {
      const r = await base(input, init);
      return new Response(r.status === 204 || r.status === 304 ? null : await r.arrayBuffer(), {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    };
    this.signIns = new SignIns(this.table, fetchImpl);
    this.oauth = new OAuthSignIns(this.table, store, fetchImpl, this);
    this.connect = o.connect ?? mcpConnect(o.fetch, "thermite-control");
    ensureMcpTables(this.table.db);
    migrateOutsideKb(this.table, store);
  }

  // ------------------------------------------------------------------ reading

  list(): McpServer[] {
    return (this.table.db.prepare("select * from mcp_server order by name").all() as Row[]).map(
      viewOf,
    );
  }

  get(name: string): McpServer | undefined {
    const r = this.table.row(name);
    return r ? viewOf(r) : undefined;
  }

  // ------------------------------------------------------------------ adding and changing

  /**
   * Adds a server or changes one. A secret left out keeps the sealed one, except for a new server,
   * another way to sign in, or another address (the sealed secret never goes to an origin it was
   * not given for): those need it again. An OAuth server's sign-in ends when its address changes.
   * The audit names the secret's last four characters, never the secret.
   */
  put(p: McpServerInput, by: string): "created" | "changed" {
    const name = p.name.trim();
    if (!MCP_SERVER_NAME.test(name))
      throw new Error("A server's name is lowercase letters, digits and dashes, such as github.");
    if (!MCP_AUTHS.includes(p.auth)) throw new Error("Sign-in is oauth, key, client or none.");
    const url = p.url.trim();
    const bad = mcpUrlProblem(url);
    if (bad) throw new Error(bad);
    const old = this.table.row(name);
    const sameOrigin = old ? new URL(str(old.url)).origin === new URL(url).origin : false;
    const sameAuth = old ? str(old.auth) === p.auth : false;
    const keep = Boolean(old && sameOrigin && sameAuth);
    const header = p.auth === "key" ? p.header?.trim() || "Authorization" : null;
    if (header !== null && !HEADER_NAME.test(header))
      throw new Error("The header is a header's name, such as Authorization.");
    const secretIn = p.auth === "key" ? p.secret?.trim() : p.client_secret?.trim();
    if (secretIn !== undefined && secretIn.length > 16_384)
      throw new Error("The secret is too long.");
    if (secretIn && /[\r\n]/.test(secretIn)) throw new Error("The secret has a line break.");
    const clientId = p.client_id?.trim() || null;
    if (clientId !== null && clientId.length > 500) throw new Error("The client ID is too long.");
    const scope = p.scope?.trim() || null;
    if (scope !== null && scope.length > 1000) throw new Error("The scopes are too long.");
    if (p.auth === "key" && !secretIn && !keep)
      throw new Error(
        old
          ? "Another address or sign-in needs the key again: paste its value."
          : "Paste the key's value.",
      );
    if (p.auth === "client" && (!clientId || (!secretIn && !keep)))
      throw new Error("Fill in the client ID and its secret.");
    const now = new Date().toISOString();
    const sealed = secretIn
      ? this.table.secrets.seal(secretIn)
      : keep
        ? orNull(old?.secret_sealed)
        : null;
    const hint = secretIn ? keyHint(secretIn) : keep ? orNull(old?.secret_hint) : null;
    // A sign-in stays only for the same server, the same way in and the same client.
    const loginKept =
      keep && (p.auth !== "oauth" || orNull(old?.client_id) === clientId) && !secretIn
        ? orNull(old?.login_sealed)
        : null;
    const status: McpStatus = p.auth === "oauth" && !loginKept ? "needs_sign_in" : "unchecked";
    this.table.db
      .prepare(
        `insert into mcp_server (name, url, auth, header, client_id, scope, secret_sealed, secret_hint,
           login_sealed, status, created_at, created_by, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (name) do update set url = excluded.url, auth = excluded.auth,
           header = excluded.header, client_id = excluded.client_id, scope = excluded.scope,
           secret_sealed = excluded.secret_sealed, secret_hint = excluded.secret_hint,
           login_sealed = excluded.login_sealed, status = excluded.status, last_error = null,
           updated_at = excluded.updated_at`,
      )
      .run(
        name,
        url,
        p.auth,
        header,
        clientId,
        scope,
        sealed,
        hint,
        loginKept,
        status,
        now,
        by,
        now,
      );
    const r = old ? "changed" : "created";
    this.store.audit(by, r === "created" ? "mcp_server_added" : "mcp_server_changed", {
      name,
      url,
      auth: p.auth,
      ...(header ? { header } : {}),
      ...(clientId ? { client_id: clientId } : {}),
      ...(scope ? { scope } : {}),
      secret: secretIn ? `${old ? "replaced" : "set"} (${hint})` : sealed ? "kept" : "none",
    });
    return r;
  }

  /** Forgets a server: its secrets and its sign-in. Refused while a campaign's kit names it. */
  delete(name: string, by: string): "deleted" | "missing" | { named_by: string[] } {
    if (!this.table.row(name)) return "missing";
    const named = namedBy(this.store, name);
    if (named.length) return { named_by: named.map((n) => n.kit) };
    this.table.db.prepare("delete from mcp_sign_in where name = ?").run(name);
    this.table.db.prepare("delete from mcp_server where name = ?").run(name);
    this.store.audit(by, "mcp_server_deleted", { name });
    return "deleted";
  }

  // ------------------------------------------------------------------ the sign-in, as headers

  /** The headers a call to the server carries, or an error in words (sign-in.ts). */
  async headers(name: string): Promise<SignIn> {
    return this.signIns.headers(name);
  }

  // ------------------------------------------------------------------ OAuth (oauth.ts)

  /** Starts an OAuth sign-in: the address of the server's sign-in page. */
  async startSignIn(name: string, redirectUri: string, by: string): Promise<{ url: string }> {
    return this.oauth.startSignIn(name, redirectUri, by);
  }

  /** The browser came back without a code (the owner said no): the sign-in is forgotten. */
  cancelSignIn(state: string, why: string): string | undefined {
    return this.oauth.cancelSignIn(state, why);
  }

  /** The browser came back with a code: the sign-in, sealed, and the server's tools read with it. */
  async finishSignIn(state: string, code: string): Promise<SignInDone> {
    return this.oauth.finishSignIn(state, code);
  }

  // ------------------------------------------------------------------ the tools

  /**
   * Reads the server's tools with its sign-in and keeps their names, what they do and whether
   * they only read. Null when it worked, else what went wrong, in words. It calls no tool.
   */
  async check(name: string): Promise<string | null> {
    const r = this.table.row(name);
    if (!r) return "Settings has no server of that name";
    const signIn = await this.headers(name);
    if ("error" in signIn) {
      const now = this.table.row(name);
      // A sign-in that ended keeps its own state; anything else is a failing server.
      if (str(now?.status) !== "needs_sign_in") this.table.setState(name, "failing", signIn.error);
      this.table.db
        .prepare("update mcp_server set checked_at = ? where name = ?")
        .run(new Date().toISOString(), name);
      return signIn.error;
    }
    const h = signIn.headers;
    let session: McpSession | undefined;
    try {
      session = await this.connect(str(r.url), h);
      const listed = await session.listTools();
      const tools: McpTool[] = listed.map((t) => ({
        name: t.name,
        description: (t.description ?? t.title ?? t.annotations?.title ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, DESCRIPTION_MAX),
        reads: t.annotations?.readOnlyHint === true,
      }));
      const now = new Date().toISOString();
      this.table.db
        .prepare(
          "update mcp_server set status = 'ok', last_error = null, tools = ?, tools_at = ?, checked_at = ? where name = ?",
        )
        .run(JSON.stringify(tools), now, now, name);
      return null;
    } catch (err) {
      const why = cleanMcpError(err, headerSecrets(h));
      const words = /\b401\b|unauthori[sz]ed/i.test(why)
        ? `the server answered 401: check the ${str(r.auth) === "client" ? "client secret" : str(r.auth) === "oauth" ? "sign-in" : "key"}`
        : `can't read its tools: ${why}`;
      this.table.db
        .prepare("update mcp_server set status = ?, last_error = ?, checked_at = ? where name = ?")
        .run(
          str(r.auth) === "oauth" && /\b401\b/.test(why) ? "needs_sign_in" : "failing",
          words,
          new Date().toISOString(),
          name,
        );
      return words;
    } finally {
      await session?.close().catch(() => {});
    }
  }

  // ------------------------------------------------------------------ what a rig gets

  /**
   * What a rig's supervisor gets: each server the runs control assigned the rig name, with its
   * sign-in as headers and the kinds of agent any of those runs gives it to; and the servers they
   * name that can't be given, with why. Any server no run of the rig names is never given.
   */
  async forRig(rig: string): Promise<{ servers: McpConnection[]; unavailable: McpUnavailable[] }> {
    const agents = new Map<string, Set<AgentKind>>();
    for (const uses of assignedMcpServers(this.table.db, rig).values())
      for (const u of uses) {
        const set = agents.get(u.name) ?? new Set<AgentKind>();
        for (const a of u.agents) set.add(a);
        agents.set(u.name, set);
      }
    const servers: McpConnection[] = [];
    const unavailable: McpUnavailable[] = [];
    for (const [name, kinds] of [...agents].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const r = this.table.row(name);
      if (!r) {
        unavailable.push({ name, why: "Settings has no MCP server of that name now" });
        continue;
      }
      const signIn = await this.headers(name);
      if ("error" in signIn) {
        unavailable.push({ name, why: `control can't sign in to it: ${signIn.error}` });
        continue;
      }
      const headers = signIn.headers;
      servers.push({
        name,
        url: str(r.url),
        headers,
        revision: sha256Hex(JSON.stringify([name, str(r.url), headers])).slice(0, 16),
        agents: AGENT_KINDS.filter((k) => kinds.has(k)),
      });
    }
    return { servers, unavailable };
  }
}
