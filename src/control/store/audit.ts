import { canonicalJson } from "../../core/canonical.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Control's audit log (goal 125, T6): who did what, when, read a page at a time.
 */

/** One entry of control's audit log. Its id is the cursor that pages through the log. */
export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  body: unknown;
}

/** Which audit entries a list keeps: `action` those whose action contains it; `mcp` false, no MCP calls. */
export interface AuditFilter {
  action?: string | undefined;
  mcp?: boolean | undefined;
}

/** An audit page's cursor from a query string: a whole number of 0 or more, or none. */
export function cursorOf(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export class AuditLog extends StorePart {
  add(actor: string, action: string, body: unknown): void {
    this.db
      .prepare("insert into audit (at, actor, action, body) values (?, ?, ?, ?)")
      .run(new Date().toISOString(), actor, action, canonicalJson(body ?? {}));
  }

  /** The newest audit entries; `action` keeps those whose action contains it, `mcp` MCP reads. */
  list(limit = 200, filter: AuditFilter = {}): AuditEntry[] {
    return this.page(limit, filter).entries;
  }

  /**
   * One page of the audit log, newest first (goal 015). With no cursor, the newest entries;
   * `before` keeps those older than it, `after` those newer. `older` and `newer` are the cursors
   * for the next page each way: give `older` as `before`, `newer` as `after`. Null when no entry
   * that matches is left that way.
   */
  page(
    limit = 200,
    filter: AuditFilter = {},
    cursor: { before?: number | undefined; after?: number | undefined } = {},
  ): { entries: AuditEntry[]; older: number | null; newer: number | null } {
    const match = "(? or action not like 'mcp:%') and instr(action, ?) > 0";
    const args = [filter.mcp === false ? 0 : 1, filter.action ?? ""] as const;
    const { before, after } = cursor;
    const rows = (
      after !== undefined
        ? (
            this.db
              .prepare(
                `select id, at, actor, action, body from audit where ${match} and id > ? order by id limit ?`,
              )
              .all(...args, after, limit) as Row[]
          )
            // The entries just after the cursor, shown newest first like every page.
            .reverse()
        : (this.db
            .prepare(
              `select id, at, actor, action, body from audit where ${match} and id < ? order by id desc limit ?`,
            )
            .all(...args, before ?? Number.MAX_SAFE_INTEGER, limit) as Row[])
    ).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      body: JSON.parse(String(r.body)),
    }));
    const any = (where: string, id: number) =>
      this.db
        .prepare(`select 1 from audit where ${match} and id ${where} ? limit 1`)
        .get(...args, id) !== undefined;
    // The edges of this page; an empty page has them at its cursor.
    const hi = rows[0]?.id ?? (before !== undefined ? Math.max(0, before - 1) : after);
    const lo = rows.at(-1)?.id ?? (after !== undefined ? after + 1 : before);
    return {
      entries: rows,
      older: lo !== undefined && any("<", lo) ? lo : null,
      newer: hi !== undefined && any(">", hi) ? hi : null,
    };
  }

  /** The body of the newest audit entry by this actor with this action, if there is one. */
  last(actor: string, action: string): unknown {
    const r = this.db
      .prepare("select body from audit where actor = ? and action = ? order by id desc limit 1")
      .get(actor, action) as Row | undefined;
    return r ? JSON.parse(String(r.body)) : undefined;
  }
}
