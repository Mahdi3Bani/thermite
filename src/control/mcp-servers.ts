import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  fetchToken,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { log } from "../common/env.ts";
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
  type McpUse,
  McpUses,
} from "../core/mcp.ts";
import { keyHint, type SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store.ts";

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
 */

export type McpAuth = "oauth" | "key" | "client" | "none";
export const MCP_AUTHS: readonly McpAuth[] = ["oauth", "key", "client", "none"];

/** A server's tool as control keeps it. */
export interface McpTool {
  name: string;
  description: string;
  /** The server says it only reads (its readOnlyHint); otherwise it may write. */
  reads: boolean;
}

export type McpStatus = "ok" | "failing" | "needs_sign_in" | "unchecked";

/** A server as control shows it: never a secret, only its last four characters. */
export interface McpServer {
  name: string;
  url: string;
  auth: McpAuth;
  /** A key's header (Authorization by default). */
  header: string | null;
  /** The client ID: the owner's for "client", the owner's or the registered one for "oauth". */
  client_id: string | null;
  scope: string | null;
  /** The key's value or the client secret, as its last four characters. */
  secret_hint: string | null;
  /** OAuth: control holds a sign-in. */
  signed_in: boolean;
  status: McpStatus;
  last_error: string | null;
  /** The tools as last read; null before the first read. */
  tools: McpTool[] | null;
  tools_at: string | null;
  checked_at: string | null;
  /** Where it came from at an update ("outside_kb": goal 065's outside knowledge base). */
  migrated_from: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

/** What the owner gives to add a server or change one; a secret left out keeps the sealed one. */
export interface McpServerInput {
  name: string;
  url: string;
  auth: McpAuth;
  header?: string | undefined;
  /** The key's value (with its scheme: "Bearer …"), for "key". */
  secret?: string | undefined;
  client_id?: string | undefined;
  /** For "client", and for an "oauth" server that gave Thermite a client of its own. */
  client_secret?: string | undefined;
  scope?: string | undefined;
}

/** The sign-in control keeps for an OAuth or client-credentials server (sealed as one value). */
interface Login {
  access_token: string;
  refresh_token?: string | undefined;
  /** When the access token ends (ms since the epoch); none: it does not say. */
  expires_at?: number | undefined;
  /** OAuth: the client, as registered (or the owner's). */
  client?: OAuthClientInformationMixed | undefined;
  /** OAuth: the authorization server and the resource the sign-in is for. */
  auth_server?: string | undefined;
  resource?: string | undefined;
}

/** Renewed when less than this is left. */
const RENEW_BEFORE_MS = 5 * 60_000;
/** A sign-in started and not finished is forgotten after this long. */
const SIGN_IN_MS = 15 * 60_000;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const DESCRIPTION_MAX = 1000;

const SCHEMA = `
-- MCP servers (goal 068): the server, how it signs Thermite in (its secrets sealed with control's
-- secret box), its state, its last error and its tools as last read.
create table if not exists mcp_server (
  name text primary key,
  url text not null,
  auth text not null,
  header text,
  client_id text,
  scope text,
  secret_sealed text,
  secret_hint text,
  login_sealed text,
  status text not null default 'unchecked',
  last_error text,
  tools text,
  tools_at text,
  checked_at text,
  migrated_from text,
  created_at text not null,
  created_by text not null,
  updated_at text not null
);
-- OAuth sign-ins started and not finished yet: their state (hashed), the PKCE verifier (sealed).
create table if not exists mcp_sign_in (
  state_hash text primary key,
  name text not null,
  verifier_sealed text not null,
  redirect_uri text not null,
  expires_at text not null,
  started_by text not null
);
`;

type Row = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
const orNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : str(v));

/** The servers' table, made when missing: control's checks read it before anything else made it. */
export function ensureMcpTables(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

/** The names of the servers in Settings. */
export function mcpServerNames(db: DatabaseSync): Set<string> {
  ensureMcpTables(db);
  return new Set(
    (db.prepare("select name from mcp_server").all() as Row[]).map((r) => str(r.name)),
  );
}

/**
 * Why an assignment naming these servers can't start, in words, or "" when every server it names
 * is in Settings. A server that fails later never stops a run: only a missing one stops the start.
 */
export function mcpRefusal(db: DatabaseSync, uses: readonly McpUse[] | undefined): string {
  if (!uses?.length) return "";
  const have = mcpServerNames(db);
  const missing = uses.map((u) => u.name).filter((n) => !have.has(n));
  if (!missing.length) return "";
  const list = missing.join(", ");
  return missing.length === 1
    ? `The kit names the MCP server ${list}, and Settings has no server of that name. Add an MCP server named ${list} in Settings › Providers, or take it out of the kit. Then start the campaign again.`
    : `The kit names the MCP servers ${list}, and Settings has none of these names. Add them in Settings › Providers, or take them out of the kit. Then start the campaign again.`;
}

/**
 * The servers a campaign names, from its newest version saved on control (its kit's list, or a
 * research contract's), else its newest assignment. Undefined: control does not know the campaign.
 */
export function campaignMcpServers(store: ControlStore, campaign: string): McpUse[] | undefined {
  const v = store.campaignVersions(campaign)[0];
  if (v) {
    const contract = v.contract as { mode?: string; mcp_servers?: unknown };
    const raw = contract.mode === "research" ? contract.mcp_servers : v.sources.mcp_servers;
    return McpUses.safeParse(raw ?? []).data ?? [];
  }
  const past = store.latestAssignments().get(campaign);
  if (!past) return undefined;
  return McpUses.safeParse(past.payload.mcp_servers ?? []).data ?? [];
}

/** What names a server: each campaign whose newest version or assignment names it, with its kit. */
export function namedBy(store: ControlStore, name: string): { campaign: string; kit: string }[] {
  const campaigns = new Set([
    ...store.campaignVersions().map((v) => v.campaign),
    ...store.latestAssignments().keys(),
  ]);
  const out: { campaign: string; kit: string }[] = [];
  for (const c of [...campaigns].sort()) {
    if (!campaignMcpServers(store, c)?.some((u) => u.name === name)) continue;
    const v = store.campaignVersions(c)[0];
    const contract = (v?.contract ?? store.latestAssignments().get(c)?.payload.contract) as
      | { project?: { kit?: { repo?: string } } }
      | undefined;
    out.push({ campaign: c, kit: contract?.project?.kit?.repo ?? c });
  }
  return out;
}

/** The servers each run control assigned a rig names (its own signed commands, never the rig's reports). */
export function assignedMcpServers(db: DatabaseSync, rig: string): Map<string, McpUse[]> {
  const out = new Map<string, McpUse[]>();
  for (const r of db
    .prepare(
      "select signed from command where rig = ? and kind = 'assign_campaign' and status not in ('failed', 'rejected', 'expired') order by issued_at",
    )
    .all(rig) as { signed: string }[]) {
    try {
      const p = (
        JSON.parse(r.signed) as {
          envelope?: { payload?: { run?: unknown; mcp_servers?: unknown } };
        }
      ).envelope?.payload;
      const uses = McpUses.safeParse(p?.mcp_servers ?? []).data ?? [];
      if (typeof p?.run === "string" && uses.length) out.set(p.run, uses);
    } catch {
      // not a command this store wrote
    }
  }
  return out;
}

/** An error the authorization server gave that only a new sign-in mends. */
const signInEnded = (err: unknown) => {
  const code = (err as { errorCode?: unknown }).errorCode;
  return code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client";
};

/** A server's sign-in as headers for its calls, or why there is none. */
export type SignIn = { headers: Record<string, string> } | { error: string };

/** One page that says how a sign-in went, for the browser tab that comes back to control. */
export interface SignInDone {
  name?: string | undefined;
  error?: string | undefined;
  tools?: number | undefined;
}

export class McpServers {
  private readonly db: DatabaseSync;
  private readonly store: ControlStore;
  private readonly secrets: SecretBox;
  private readonly connect: McpConnect;
  private readonly fetchImpl: typeof fetch;
  /** Renewals in progress, one per server: an OAuth server may rotate its refresh token. */
  private readonly renewing = new Map<string, Promise<SignIn>>();

  constructor(
    store: ControlStore,
    secrets: SecretBox,
    o: { connect?: McpConnect | undefined; fetch?: typeof fetch | undefined } = {},
  ) {
    this.store = store;
    this.db = store.db;
    this.secrets = secrets;
    // The SDK's OAuth helpers tell an error answer by `instanceof Response`, and the HTTP server
    // control runs on replaces the global Response: each answer is made again as one, so an
    // ended sign-in reads as invalid_grant and not as a garbled answer.
    const base = o.fetch ?? fetch;
    this.fetchImpl = async (input, init) => {
      const r = await base(input, init);
      return new Response(r.status === 204 || r.status === 304 ? null : await r.arrayBuffer(), {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    };
    this.connect = o.connect ?? mcpConnect(o.fetch, "thermite-control");
    ensureMcpTables(this.db);
    this.migrateOutsideKb();
  }

  // ------------------------------------------------------------------ reading

  list(): McpServer[] {
    return (this.db.prepare("select * from mcp_server order by name").all() as Row[]).map(viewOf);
  }

  get(name: string): McpServer | undefined {
    const r = this.row(name);
    return r ? viewOf(r) : undefined;
  }

  private row(name: string): Row | undefined {
    return this.db.prepare("select * from mcp_server where name = ?").get(name) as Row | undefined;
  }

  private open(sealed: unknown): string | undefined {
    if (!sealed) return undefined;
    return this.secrets.open(str(sealed));
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
    const old = this.row(name);
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
      ? this.secrets.seal(secretIn)
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
    this.db
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
    if (!this.row(name)) return "missing";
    const named = namedBy(this.store, name);
    if (named.length) return { named_by: named.map((n) => n.kit) };
    this.db.prepare("delete from mcp_sign_in where name = ?").run(name);
    this.db.prepare("delete from mcp_server where name = ?").run(name);
    this.store.audit(by, "mcp_server_deleted", { name });
    return "deleted";
  }

  // ------------------------------------------------------------------ the sign-in, as headers

  private setState(name: string, status: McpStatus, error: string | null): void {
    this.db
      .prepare("update mcp_server set status = ?, last_error = ? where name = ?")
      .run(status, error, name);
  }

  private saveLogin(name: string, login: Login): void {
    this.db
      .prepare("update mcp_server set login_sealed = ? where name = ?")
      .run(this.secrets.seal(JSON.stringify(login)), name);
  }

  private login(r: Row): Login | undefined {
    try {
      const raw = this.open(r.login_sealed);
      return raw ? (JSON.parse(raw) as Login) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The headers a call to the server carries: the key, or the access token (renewed first when
   * less than five minutes are left; a new one from the client ID and secret when it ended), or
   * none. An error in words when there is none to give.
   */
  async headers(name: string): Promise<SignIn> {
    const r = this.row(name);
    if (!r) return { error: "Settings has no server of that name" };
    const auth = str(r.auth) as McpAuth;
    if (auth === "none") return { headers: {} };
    if (auth === "key") {
      try {
        const value = this.open(r.secret_sealed);
        if (!value) return { error: "it has no key: enter it again" };
        return { headers: { [str(r.header) || "Authorization"]: value } };
      } catch {
        return { error: "its key cannot be opened: enter it again" };
      }
    }
    const login = this.login(r);
    const fresh = (l: Login | undefined) =>
      l && (l.expires_at === undefined || l.expires_at - Date.now() > RENEW_BEFORE_MS);
    if (fresh(login)) return { headers: { Authorization: `Bearer ${login?.access_token}` } };
    if (auth === "oauth" && !login) return { error: "it is not signed in yet" };
    if (auth === "oauth" && !login?.refresh_token) {
      if (login && (login.expires_at ?? 0) > Date.now() + 30_000)
        return { headers: { Authorization: `Bearer ${login.access_token}` } };
      this.setState(name, "needs_sign_in", "The sign-in ended. Sign in again.");
      return { error: "its sign-in ended: sign in again" };
    }
    const running = this.renewing.get(name);
    if (running) return running;
    const renewal = (
      auth === "oauth" ? this.refresh(name, r, login as Login) : this.clientToken(name, r)
    ).finally(() => this.renewing.delete(name));
    this.renewing.set(name, renewal);
    return renewal;
  }

  /** A token from the client ID and secret (client credentials), kept until it nearly ends. */
  private async clientToken(name: string, r: Row): Promise<SignIn> {
    let secret: string | undefined;
    try {
      secret = this.open(r.secret_sealed);
    } catch {
      return { error: "its client secret cannot be opened: enter it again" };
    }
    if (!secret) return { error: "it has no client secret: enter it again" };
    try {
      const info = await discoverOAuthServerInfo(str(r.url), { fetchFn: this.fetchImpl });
      const provider = new ClientCredentialsProvider({
        clientId: str(r.client_id),
        clientSecret: secret,
        ...(r.scope ? { scope: str(r.scope) } : {}),
        expectedIssuer: info.authorizationServerMetadata?.issuer ?? info.authorizationServerUrl,
      });
      const tokens = await fetchToken(provider, info.authorizationServerUrl, {
        ...(info.authorizationServerMetadata ? { metadata: info.authorizationServerMetadata } : {}),
        ...(info.resourceMetadata ? { resource: new URL(info.resourceMetadata.resource) } : {}),
        fetchFn: this.fetchImpl,
      });
      this.saveLogin(name, {
        access_token: tokens.access_token,
        ...(tokens.expires_in ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
      });
      return { headers: { Authorization: `Bearer ${tokens.access_token}` } };
    } catch (err) {
      const why = cleanMcpError(err, [secret]);
      this.setState(name, "failing", `Can't get a token with the client ID and secret: ${why}`);
      return { error: `the server gave no token for its client ID and secret: ${why}` };
    }
  }

  /** Renews an OAuth sign-in with its refresh token. One that ended needs a new sign-in. */
  private async refresh(name: string, r: Row, login: Login): Promise<SignIn> {
    const secrets = [login.access_token, login.refresh_token ?? ""];
    try {
      const auth = login.auth_server ?? str(r.url);
      const info = await discoverOAuthServerInfo(str(r.url), { fetchFn: this.fetchImpl });
      const tokens = await refreshAuthorization(auth, {
        ...(info.authorizationServerMetadata ? { metadata: info.authorizationServerMetadata } : {}),
        clientInformation: login.client ?? { client_id: str(r.client_id) },
        refreshToken: login.refresh_token as string,
        ...(login.resource ? { resource: new URL(login.resource) } : {}),
        fetchFn: this.fetchImpl,
      });
      this.saveLogin(name, {
        ...login,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? login.refresh_token,
        expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      });
      return { headers: { Authorization: `Bearer ${tokens.access_token}` } };
    } catch (err) {
      const why = cleanMcpError(err, secrets);
      if (signInEnded(err)) {
        this.setState(name, "needs_sign_in", "The sign-in ended. Sign in again.");
        return { error: "its sign-in ended: sign in again" };
      }
      // The server unreachable for now: the token works until it ends.
      if (login.expires_at && login.expires_at > Date.now() + 30_000)
        return { headers: { Authorization: `Bearer ${login.access_token}` } };
      this.setState(name, "failing", `Can't renew the sign-in: ${why}`);
      return { error: `its sign-in could not be renewed: ${why}` };
    }
  }

  // ------------------------------------------------------------------ OAuth

  /**
   * Starts an OAuth sign-in: finds the server's authorization server, registers Thermite as a
   * client when the server allows it and the owner gave no client ID, and returns the address of
   * the server's sign-in page. The browser comes back to control's callback (redirectUri) with a
   * code; finishSignIn exchanges it. The state and the PKCE verifier are kept for 15 minutes.
   */
  async startSignIn(name: string, redirectUri: string, by: string): Promise<{ url: string }> {
    const r = this.row(name);
    if (!r) throw new Error("Settings has no server of that name.");
    if (str(r.auth) !== "oauth") throw new Error(`${name} does not sign in with OAuth.`);
    const info = await discoverOAuthServerInfo(str(r.url), { fetchFn: this.fetchImpl }).catch(
      (err) => {
        throw new Error(`Can't find the server's sign-in: ${cleanMcpError(err)}`);
      },
    );
    const metadata = info.authorizationServerMetadata;
    let client: OAuthClientInformationMixed;
    const old = this.login(r);
    let secret: string | undefined;
    try {
      secret = this.open(r.secret_sealed);
    } catch {
      throw new Error("Its client secret cannot be opened: enter it again.");
    }
    if (r.client_id)
      client = { client_id: str(r.client_id), ...(secret ? { client_secret: secret } : {}) };
    else if (
      old?.client &&
      old.auth_server === info.authorizationServerUrl &&
      ("redirect_uris" in old.client
        ? (old.client.redirect_uris as string[]).includes(redirectUri)
        : false)
    )
      client = old.client;
    else if (metadata?.registration_endpoint)
      client = await registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: "Thermite",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(r.scope ? { scope: str(r.scope) } : {}),
        },
        fetchFn: this.fetchImpl,
      }).catch((err) => {
        throw new Error(`The server did not register Thermite: ${cleanMcpError(err)}`);
      });
    else
      throw new Error(
        "The server does not register clients by itself. Register Thermite on the server, then give its client ID here.",
      );
    const state = randomBytes(24).toString("base64url");
    const resource = info.resourceMetadata ? new URL(info.resourceMetadata.resource) : undefined;
    const { authorizationUrl, codeVerifier } = await startAuthorization(
      info.authorizationServerUrl,
      {
        ...(metadata ? { metadata } : {}),
        clientInformation: client,
        redirectUrl: redirectUri,
        ...(r.scope ? { scope: str(r.scope) } : {}),
        state,
        ...(resource ? { resource } : {}),
      },
    );
    const now = Date.now();
    this.db
      .prepare("delete from mcp_sign_in where expires_at < ?")
      .run(new Date(now).toISOString());
    this.db
      .prepare(
        "insert into mcp_sign_in (state_hash, name, verifier_sealed, redirect_uri, expires_at, started_by) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        sha256Hex(state),
        name,
        this.secrets.seal(
          JSON.stringify({
            verifier: codeVerifier,
            client,
            auth_server: info.authorizationServerUrl,
            ...(resource ? { resource: resource.href } : {}),
          }),
        ),
        redirectUri,
        new Date(now + SIGN_IN_MS).toISOString(),
        by,
      );
    this.store.audit(by, "mcp_server_sign_in_started", { name });
    return { url: authorizationUrl.href };
  }

  /** The browser came back without a code (the owner said no): the sign-in is forgotten. */
  cancelSignIn(state: string, why: string): string | undefined {
    const h = sha256Hex(state);
    const s = this.db.prepare("select name from mcp_sign_in where state_hash = ?").get(h) as
      | Row
      | undefined;
    if (!s) return undefined;
    this.db.prepare("delete from mcp_sign_in where state_hash = ?").run(h);
    const r = this.row(str(s.name));
    if (r && !r.login_sealed) this.setState(str(s.name), "needs_sign_in", why);
    return str(s.name);
  }

  /**
   * The browser came back with a code: exchanges it for the sign-in (once; a state is used once
   * and only within 15 minutes), seals it, and reads the server's tools with it.
   */
  async finishSignIn(state: string, code: string): Promise<SignInDone> {
    const h = sha256Hex(state);
    const s = this.db.prepare("select * from mcp_sign_in where state_hash = ?").get(h) as
      | Row
      | undefined;
    if (!s) return { error: "This sign-in is not known, or was used already. Start it again." };
    this.db.prepare("delete from mcp_sign_in where state_hash = ?").run(h);
    const name = str(s.name);
    if (Date.parse(str(s.expires_at)) < Date.now())
      return { name, error: "This sign-in took more than 15 minutes. Start it again." };
    const r = this.row(name);
    if (!r || str(r.auth) !== "oauth") return { name, error: "The server is gone from Settings." };
    let pending: {
      verifier: string;
      client: OAuthClientInformationMixed;
      auth_server: string;
      resource?: string;
    };
    try {
      pending = JSON.parse(this.secrets.open(str(s.verifier_sealed)));
    } catch {
      return { name, error: "This sign-in cannot be opened. Start it again." };
    }
    let metadata: AuthorizationServerMetadata | undefined;
    try {
      metadata = (await discoverOAuthServerInfo(str(r.url), { fetchFn: this.fetchImpl }))
        .authorizationServerMetadata;
    } catch {
      metadata = undefined;
    }
    try {
      const tokens = await exchangeAuthorization(pending.auth_server, {
        ...(metadata ? { metadata } : {}),
        clientInformation: pending.client,
        authorizationCode: code,
        codeVerifier: pending.verifier,
        redirectUri: str(s.redirect_uri),
        ...(pending.resource ? { resource: new URL(pending.resource) } : {}),
        fetchFn: this.fetchImpl,
      });
      this.saveLogin(name, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
        client: pending.client,
        auth_server: pending.auth_server,
        resource: pending.resource,
      });
    } catch (err) {
      const why = cleanMcpError(err, [code]);
      this.setState(name, "needs_sign_in", `The sign-in failed: ${why}`);
      return { name, error: `The server did not take the sign-in: ${why}` };
    }
    this.setState(name, "unchecked", null);
    this.store.audit(str(s.started_by), "mcp_server_signed_in", { name });
    const why = await this.check(name);
    return why
      ? { name, error: `Signed in, but ${why}` }
      : { name, tools: this.get(name)?.tools?.length ?? 0 };
  }

  // ------------------------------------------------------------------ the tools

  /**
   * Reads the server's tools with its sign-in and keeps their names, what they do and whether
   * they only read. Null when it worked, else what went wrong, in words. It calls no tool.
   */
  async check(name: string): Promise<string | null> {
    const r = this.row(name);
    if (!r) return "Settings has no server of that name";
    const signIn = await this.headers(name);
    if ("error" in signIn) {
      const now = this.row(name);
      // A sign-in that ended keeps its own state; anything else is a failing server.
      if (str(now?.status) !== "needs_sign_in") this.setState(name, "failing", signIn.error);
      this.db
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
      this.db
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
      this.db
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
    for (const uses of assignedMcpServers(this.db, rig).values())
      for (const u of uses) {
        const set = agents.get(u.name) ?? new Set<AgentKind>();
        for (const a of u.agents) set.add(a);
        agents.set(u.name, set);
      }
    const servers: McpConnection[] = [];
    const unavailable: McpUnavailable[] = [];
    for (const [name, kinds] of [...agents].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const r = this.row(name);
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

  // ------------------------------------------------------------------ the update from goal 065

  /**
   * Goal 065's outside knowledge bases become ordinary MCP servers, once, at the update: each one
   * a server with a key (Authorization: Bearer and its token, kept). Copies of campaign folders
   * stop (the pages already written stay on the server), and the campaigns' grants to search them
   * go: a kit names a server now. The audit says what each became and what stopped.
   */
  private migrateOutsideKb(): void {
    const has = (t: string) =>
      Boolean(
        this.db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t),
      );
    if (!has("outside_kb")) return;
    const rows = this.db.prepare("select * from outside_kb order by name").all() as Row[];
    const copies = has("outside_kb_copy")
      ? (this.db.prepare("select kb, campaign from outside_kb_copy").all() as Row[])
      : [];
    const grants = has("kb_read")
      ? (this.db
          .prepare("select campaign, reads from kb_read where reads like 'outside:%'")
          .all() as Row[])
      : [];
    this.db.exec("begin");
    try {
      for (const k of rows) {
        const old = str(k.name);
        let name =
          old
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "kb";
        if (!/^[a-z0-9]/.test(name)) name = `kb-${name}`;
        name = name.slice(0, 64);
        for (let n = 2; this.row(name); n++) name = `${name.slice(0, 60)}-${n}`;
        let token: string | undefined;
        try {
          token = this.secrets.open(str(k.token_sealed));
        } catch {
          token = undefined;
        }
        const value = token ? `Bearer ${token}` : undefined;
        let tools: McpTool[] | null = null;
        try {
          const names = k.tools ? (JSON.parse(str(k.tools)) as string[]) : null;
          tools = names ? names.map((n) => ({ name: n, description: "", reads: false })) : null;
        } catch {
          tools = null;
        }
        const now = new Date().toISOString();
        this.db
          .prepare(
            `insert into mcp_server (name, url, auth, header, secret_sealed, secret_hint, status, last_error,
               tools, tools_at, migrated_from, created_at, created_by, updated_at)
             values (?, ?, 'key', 'Authorization', ?, ?, ?, ?, ?, ?, 'outside_kb', ?, ?, ?)`,
          )
          .run(
            name,
            str(k.mcp_url),
            value ? this.secrets.seal(value) : null,
            token ? keyHint(token) : null,
            value ? "unchecked" : "failing",
            value ? null : "Its token could not be opened at the update. Enter the key again.",
            tools ? JSON.stringify(tools) : null,
            tools ? orNull(k.checked_at) : null,
            orNull(k.created_at) ?? now,
            orNull(k.created_by) ?? "control",
            now,
          );
        this.store.audit("control", "outside_kb_migrated", {
          outside_kb: old,
          mcp_server: name,
          token: token ? "kept" : "could not be opened",
          copies_stopped: copies.filter((c) => str(c.kb) === old).map((c) => str(c.campaign)),
          grants_removed: grants
            .filter((g) => str(g.reads) === `outside:${old}`)
            .map((g) => str(g.campaign)),
        });
        log("control", "outside knowledge base kept as an MCP server", { from: old, name });
      }
      if (grants.length) {
        if (has("kb_grant_item"))
          this.db.prepare("delete from kb_grant_item where reads like 'outside:%'").run();
        this.db.prepare("delete from kb_read where reads like 'outside:%'").run();
      }
      this.db.exec("drop table if exists outside_kb_copy");
      this.db.exec("drop table outside_kb");
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }
}

function viewOf(r: Row): McpServer {
  let tools: McpTool[] | null = null;
  try {
    tools = r.tools ? (JSON.parse(str(r.tools)) as McpTool[]) : null;
  } catch {
    tools = null;
  }
  return {
    name: str(r.name),
    url: str(r.url),
    auth: str(r.auth) as McpAuth,
    header: orNull(r.header),
    client_id: orNull(r.client_id),
    scope: orNull(r.scope),
    secret_hint: orNull(r.secret_hint),
    signed_in: str(r.auth) === "oauth" && Boolean(r.login_sealed),
    status: (str(r.status) || "unchecked") as McpStatus,
    last_error: orNull(r.last_error),
    tools,
    tools_at: orNull(r.tools_at),
    checked_at: orNull(r.checked_at),
    migrated_from: orNull(r.migrated_from),
    created_at: str(r.created_at),
    created_by: str(r.created_by),
    updated_at: str(r.updated_at),
  };
}
