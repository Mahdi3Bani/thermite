import { type Row, StorePart } from "./part.ts";

/**
 * Git access (goal 125, T6): an SSH key or a token, its secret only sealed.
 */

/** Git access as listed (never its secret). */
export interface GitAccess {
  name: string;
  kind: "ssh" | "token";
  public_key: string | null;
  fingerprint: string | null;
  hint: string;
  username: string | null;
}

function gitAccessOf(r: Row): GitAccess {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    name: String(r.name),
    kind: r.kind === "token" ? "token" : "ssh",
    public_key: opt(r.public_key),
    fingerprint: opt(r.fingerprint),
    hint: String(r.hint),
    username: opt(r.username),
  };
}

export class GitAccessStore extends StorePart {
  /** Adds Git access; a name is used once (delete it to make another). */
  add(g: GitAccess & { secret_sealed: string; by: string }): void {
    this.db
      .prepare(
        `insert into git_access (name, kind, public_key, fingerprint, secret_sealed, hint, username, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.name,
        g.kind,
        g.public_key,
        g.fingerprint,
        g.secret_sealed,
        g.hint,
        g.username,
        new Date().toISOString(),
        g.by,
      );
    this.store.auditLog.add(g.by, "git_access_added", { name: g.name, kind: g.kind, hint: g.hint });
  }

  /** Git access by name, with its sealed secret (for control's own use only). */
  get(name: string): (GitAccess & { secret_sealed: string }) | undefined {
    const r = this.db.prepare("select * from git_access where name = ?").get(name) as
      | Row
      | undefined;
    return r ? { ...gitAccessOf(r), secret_sealed: String(r.secret_sealed) } : undefined;
  }

  /** Every Git access, without secrets. */
  list(): GitAccess[] {
    return (this.db.prepare("select * from git_access order by name").all() as Row[]).map(
      gitAccessOf,
    );
  }

  /** A token replaced in place: same name, so campaigns that name it keep working. */
  replaceToken(name: string, secretSealed: string, hint: string, by: string): boolean {
    const r = this.db
      .prepare(
        "update git_access set secret_sealed = ?, hint = ? where name = ? and kind = 'token'",
      )
      .run(secretSealed, hint, name);
    if (Number(r.changes)) this.store.auditLog.add(by, "git_access_token_replaced", { name, hint });
    return Number(r.changes) > 0;
  }

  delete(name: string, by: string): boolean {
    const r = this.db.prepare("delete from git_access where name = ?").run(name);
    if (Number(r.changes)) this.store.auditLog.add(by, "git_access_deleted", { name });
    return Number(r.changes) > 0;
  }
}
