import type { DatabaseSync } from "node:sqlite";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SecretBox } from "../secrets.ts";

/**
 * The servers' table (goal 068): a server as control shows it, the table and the sign-ins started,
 * and the rows with their sealed secrets, which every part of McpServers reads and writes.
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
export interface Login {
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

export type Row = Record<string, unknown>;
export const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
export const orNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : str(v));

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

/** A server's row as control shows it: never a secret, only its last four characters. */
export function viewOf(r: Row): McpServer {
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

/** The servers' rows, and the secret box that seals and opens their secrets. */
export class ServerTable {
  readonly db: DatabaseSync;
  readonly secrets: SecretBox;

  constructor(db: DatabaseSync, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
  }

  /** A server's row, by its name. */
  row(name: string): Row | undefined {
    return this.db.prepare("select * from mcp_server where name = ?").get(name) as Row | undefined;
  }

  /** A sealed secret, opened; undefined when none is sealed. */
  open(sealed: unknown): string | undefined {
    if (!sealed) return undefined;
    return this.secrets.open(str(sealed));
  }

  /** A server's state and its last error. */
  setState(name: string, status: McpStatus, error: string | null): void {
    this.db
      .prepare("update mcp_server set status = ?, last_error = ? where name = ?")
      .run(status, error, name);
  }

  /** A server's sign-in, sealed. */
  saveLogin(name: string, login: Login): void {
    this.db
      .prepare("update mcp_server set login_sealed = ? where name = ?")
      .run(this.secrets.seal(JSON.stringify(login)), name);
  }

  /** A row's sign-in, opened; undefined when it has none, or it can't be opened. */
  login(r: Row): Login | undefined {
    try {
      const raw = this.open(r.login_sealed);
      return raw ? (JSON.parse(raw) as Login) : undefined;
    } catch {
      return undefined;
    }
  }
}
