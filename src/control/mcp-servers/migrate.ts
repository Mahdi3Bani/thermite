import { log } from "../../common/env.ts";
import { transaction } from "../../common/sqlite.ts";
import { keyHint } from "../secrets.ts";
import type { ControlStore } from "../store.ts";
import { type McpTool, orNull, type Row, type ServerTable, str } from "./table.ts";

/**
 * Goal 065's outside knowledge bases become ordinary MCP servers, once, at the update: each one
 * a server with a key (Authorization: Bearer and its token, kept). Copies of campaign folders
 * stop (the pages already written stay on the server), and the campaigns' grants to search them
 * go: a kit names a server now. The audit says what each became and what stopped.
 */
export function migrateOutsideKb(table: ServerTable, store: ControlStore): void {
  const has = (t: string) =>
    Boolean(
      table.db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t),
    );
  if (!has("outside_kb")) return;
  const rows = table.db.prepare("select * from outside_kb order by name").all() as Row[];
  const copies = has("outside_kb_copy")
    ? (table.db.prepare("select kb, campaign from outside_kb_copy").all() as Row[])
    : [];
  const grants = has("kb_read")
    ? (table.db
        .prepare("select campaign, reads from kb_read where reads like 'outside:%'")
        .all() as Row[])
    : [];
  transaction(table.db, () => {
    for (const k of rows) {
      const old = str(k.name);
      let name =
        old
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "kb";
      if (!/^[a-z0-9]/.test(name)) name = `kb-${name}`;
      name = name.slice(0, 64);
      for (let n = 2; table.row(name); n++) name = `${name.slice(0, 60)}-${n}`;
      let token: string | undefined;
      try {
        token = table.secrets.open(str(k.token_sealed));
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
      table.db
        .prepare(
          `insert into mcp_server (name, url, auth, header, secret_sealed, secret_hint, status, last_error,
           tools, tools_at, migrated_from, created_at, created_by, updated_at)
         values (?, ?, 'key', 'Authorization', ?, ?, ?, ?, ?, ?, 'outside_kb', ?, ?, ?)`,
        )
        .run(
          name,
          str(k.mcp_url),
          value ? table.secrets.seal(value) : null,
          token ? keyHint(token) : null,
          value ? "unchecked" : "failing",
          value ? null : "Its token could not be opened at the update. Enter the key again.",
          tools ? JSON.stringify(tools) : null,
          tools ? orNull(k.checked_at) : null,
          orNull(k.created_at) ?? now,
          orNull(k.created_by) ?? "control",
          now,
        );
      store.audit("control", "outside_kb_migrated", {
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
        table.db.prepare("delete from kb_grant_item where reads like 'outside:%'").run();
      table.db.prepare("delete from kb_read where reads like 'outside:%'").run();
    }
    table.db.exec("drop table if exists outside_kb_copy");
    table.db.exec("drop table outside_kb");
  });
}
