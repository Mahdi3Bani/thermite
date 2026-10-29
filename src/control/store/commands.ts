import { canonicalJson } from "../../core/canonical.ts";
import type { SignedCommand } from "../../core/commands.ts";
import { type McpUse, McpUses } from "../../core/mcp.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * The commands control signed for rigs (goal 125, T6): queued, delivered, answered or expired,
 * and what they say.
 */

/** A decision the owner sent to a rig, and the rig's answer once it came. */
export interface Decision {
  id: string;
  rig: string;
  kind: string;
  run: string;
  attempt?: string | undefined;
  review?: number | undefined;
  proposal?: number | undefined;
  accept?: boolean | undefined;
  issued_at: string;
  /** pending, delivered, rejected, failed or expired. */
  status: string;
  acked_at: string | null;
  outcome: { accepted?: boolean; result?: Record<string, unknown> | null } | null;
}

/** A command control issued, as the dashboard follows it. */
export interface CommandRow {
  id: string;
  rig: string;
  kind: string;
  issued_by: string;
  issued_at: string;
  /** When its signature runs out: the rig refuses it after that. */
  expires_at: string;
  status: "pending" | "delivered" | "rejected" | "failed" | "expired";
  acked_at: string | null;
  outcome: unknown;
  payload: Record<string, unknown>;
}

function commandRowOf(r: Row): CommandRow {
  let envelope: { expires_at?: unknown; payload?: unknown } = {};
  try {
    envelope = (JSON.parse(String(r.signed)) as { envelope?: typeof envelope }).envelope ?? {};
  } catch {
    // not a command this store wrote: no payload, and no time it runs out
  }
  const payload = envelope.payload;
  return {
    id: String(r.id),
    rig: String(r.rig),
    kind: String(r.kind),
    issued_by: String(r.issued_by),
    issued_at: String(r.issued_at),
    expires_at: typeof envelope.expires_at === "string" ? envelope.expires_at : String(r.issued_at),
    status: String(r.status) as CommandRow["status"],
    acked_at: r.acked_at === null ? null : String(r.acked_at),
    outcome: r.outcome ? JSON.parse(String(r.outcome)) : null,
    payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {},
  };
}

export class IssuedCommands extends StorePart {
  enqueue(signed: SignedCommand): void {
    const e = signed.envelope;
    this.db
      .prepare(
        "insert into command (id, rig, kind, signed, issued_by, issued_at, status) values (?, ?, ?, ?, ?, ?, 'pending')",
      )
      .run(e.id, e.rig, e.kind, canonicalJson(signed), e.issued_by, e.issued_at);
    this.store.runRegistry.registerAssignment(e);
    this.store.auditLog.add(e.issued_by, "command_issued", { id: e.id, rig: e.rig, kind: e.kind });
  }

  /** A rig's pending commands, oldest first. Expired ones are marked expired, not relayed. */
  pending(rig: string): SignedCommand[] {
    const now = Date.now();
    const out: SignedCommand[] = [];
    for (const r of this.db
      .prepare(
        "select id, signed from command where rig = ? and status = 'pending' order by issued_at",
      )
      .all(rig) as Row[]) {
      const cmd = JSON.parse(String(r.signed)) as SignedCommand;
      if (Date.parse(cmd.envelope.expires_at) < now) {
        this.db
          .prepare(
            "update command set status = 'expired', acked_at = ? where id = ? and status = 'pending'",
          )
          .run(new Date().toISOString(), String(r.id));
        this.store.auditLog.add("control", "command_expired", { id: String(r.id), rig });
        continue;
      }
      out.push(cmd);
    }
    return out;
  }

  /**
   * A harness's own record of a command it applied, from the rig's report: authoritative (it is
   * signed with the rig's key); the supervisor's acknowledgement is only the fast path.
   */
  confirmApplied(
    rig: string,
    id: string,
    status: "delivered" | "failed",
    outcome: string,
    at: string,
  ): void {
    this.db
      .prepare(
        "update command set status = ?, outcome = ?, acked_at = coalesce(acked_at, ?) where id = ? and rig = ?",
      )
      .run(status, outcome, at, id, rig);
  }

  /** A pending command signed again with a later expiry, while its sources still stage. */
  renew(id: string, signed: string): void {
    this.db
      .prepare("update command set signed = ? where id = ? and status = 'pending'")
      .run(signed, id);
  }

  /** The owner withdraws a command that has not been delivered. */
  cancel(id: string, actor: string): boolean {
    const r = this.db
      .prepare(
        "update command set status = 'failed', outcome = ?, acked_at = ? where id = ? and status = 'pending'",
      )
      .run(canonicalJson({ cancelled_by: actor }), new Date().toISOString(), id);
    if (Number(r.changes)) this.store.auditLog.add(actor, "command_cancelled", { id });
    return Number(r.changes) > 0;
  }

  ack(
    rig: string,
    id: string,
    status: "delivered" | "rejected" | "failed",
    outcome: unknown,
  ): boolean {
    const r = this.db
      .prepare(
        "update command set status = ?, outcome = ?, acked_at = ? where id = ? and rig = ? and status = 'pending'",
      )
      .run(status, canonicalJson(outcome ?? {}), new Date().toISOString(), id, rig);
    if (Number(r.changes) > 0)
      this.store.auditLog.add(`rig:${rig}`, "command_acked", { id, status });
    return Number(r.changes) > 0;
  }

  /**
   * Whether a rig was assigned a campaign that names this Git access in an import: the only
   * rigs control hands it to.
   */
  rigUsesGitAccess(rig: string, name: string): boolean {
    const rows = this.db
      .prepare("select signed from command where rig = ? and kind = 'assign_campaign'")
      .all(rig) as { signed: string }[];
    return rows.some((r) => {
      try {
        const imports = (
          JSON.parse(r.signed) as {
            envelope?: { payload?: { imports?: { source?: { access?: string } }[] } };
          }
        ).envelope?.payload?.imports;
        return (imports ?? []).some((i) => i.source?.access === name);
      } catch {
        return false;
      }
    });
  }

  /**
   * The runs of a campaign that control has sent a rig to start or resume, and that the rig has
   * not taken yet: its pending assign_campaign commands, and pending resume_run commands of its
   * runs. Expired ones are left out. An assignment the rig took in the last ten minutes, whose run
   * it has not reported yet, waits too.
   */
  pendingStarts(campaign: string): { rig: string; run: string; kind: string }[] {
    const now = Date.now();
    const out: { rig: string; run: string; kind: string }[] = [];
    const assigned = new Map<string, Map<string, string>>();
    const since = new Date(now - 10 * 60_000).toISOString();
    for (const r of this.db
      .prepare(
        `select rig, kind, status, signed from command where kind in ('assign_campaign', 'resume_run')
           and (status = 'pending' or (status = 'delivered' and kind = 'assign_campaign' and acked_at > ?))
         order by issued_at`,
      )
      .all(since) as Row[]) {
      let env: {
        expires_at?: string;
        payload?: { run?: unknown; contract?: { campaign?: unknown } };
      };
      try {
        env = (JSON.parse(String(r.signed)) as { envelope?: typeof env }).envelope ?? {};
      } catch {
        continue;
      }
      const rig = String(r.rig);
      const run = typeof env.payload?.run === "string" ? env.payload.run : "";
      if (!run) continue;
      if (r.status === "pending" && Date.parse(env.expires_at ?? "") < now) continue;
      // Taken: it waits only until the rig reports the run.
      if (r.status === "delivered" && this.store.runRegistry.campaignOf(run, rig) !== undefined)
        continue;
      let of: string | undefined;
      if (r.kind === "assign_campaign") {
        of =
          typeof env.payload?.contract?.campaign === "string"
            ? env.payload.contract.campaign
            : undefined;
      } else {
        if (!assigned.has(rig)) assigned.set(rig, this.store.runRegistry.assignedCampaigns(rig));
        of = assigned.get(rig)?.get(run) ?? this.store.runRegistry.campaignOf(run, rig);
      }
      if (of === campaign) out.push({ rig, run, kind: String(r.kind) });
    }
    return out;
  }

  /**
   * The newest assignment control signed for each campaign, on any rig: what a new run of a
   * campaign assigned over the API, MCP or the CLI starts from. Failed and expired ones are left
   * out.
   */
  latestAssignments(): Map<
    string,
    { id: string; rig: string; run: string; payload: Record<string, unknown>; issued_at: string }
  > {
    const rows = this.db
      .prepare(
        "select id, rig, signed, issued_at from command where kind = 'assign_campaign' and status in ('pending', 'delivered') order by issued_at desc",
      )
      .all() as { id: string; rig: string; signed: string; issued_at: string }[];
    const out = new Map<
      string,
      { id: string; rig: string; run: string; payload: Record<string, unknown>; issued_at: string }
    >();
    for (const r of rows) {
      try {
        const payload = (
          JSON.parse(r.signed) as { envelope?: { payload?: Record<string, unknown> } }
        ).envelope?.payload;
        const campaign = (payload?.contract as { campaign?: unknown } | undefined)?.campaign;
        if (payload && typeof campaign === "string" && !out.has(campaign))
          out.set(campaign, {
            id: r.id,
            rig: r.rig,
            run: String(payload.run ?? ""),
            payload,
            issued_at: r.issued_at,
          });
      } catch {
        // not a command this store wrote
      }
    }
    return out;
  }

  /**
   * The newest owner message (message_agent) control sent to one run, and the rig's answer: refused
   * (with why), or not.
   */
  lastMessageToRun(
    rig: string,
    run: string,
    to?: string,
  ): { refused: string | null; issued_at: string } | undefined {
    const rows = this.db
      .prepare(
        "select signed, status, outcome, issued_at from command where rig = ? and kind = 'message_agent' order by issued_at desc limit 30",
      )
      .all(rig) as Row[];
    for (const r of rows) {
      try {
        const payload = (
          JSON.parse(String(r.signed)) as { envelope?: { payload?: { run?: string; to?: string } } }
        ).envelope?.payload;
        if (payload?.run !== run || (to !== undefined && payload.to !== to)) continue;
        const out = r.outcome
          ? (JSON.parse(String(r.outcome)) as {
              accepted?: boolean;
              error?: string;
              result?: { error?: string };
            })
          : null;
        const failed = r.status === "failed" || r.status === "rejected" || out?.accepted === false;
        return {
          refused: failed ? (out?.result?.error ?? out?.error ?? String(r.status)) : null,
          issued_at: String(r.issued_at),
        };
      } catch {
        // not a command this store wrote
      }
    }
    return undefined;
  }

  list(limit = 100): {
    id: string;
    rig: string;
    kind: string;
    issued_by: string;
    issued_at: string;
    status: string;
    acked_at: string | null;
    outcome: unknown;
  }[] {
    return (
      this.db
        .prepare(
          "select id, rig, kind, issued_by, issued_at, status, acked_at, outcome from command order by issued_at desc limit ?",
        )
        .all(limit) as Row[]
    ).map((r) => ({
      id: String(r.id),
      rig: String(r.rig),
      kind: String(r.kind),
      issued_by: String(r.issued_by),
      issued_at: String(r.issued_at),
      status: String(r.status),
      acked_at: r.acked_at === null ? null : String(r.acked_at),
      outcome: r.outcome ? JSON.parse(String(r.outcome)) : null,
    }));
  }

  /**
   * The owner's decisions sent to rigs (promote, decline, accept a review, conclude), newest
   * first, with what each rig answered: so a decision shows as sent the moment it is made, not
   * only once the rig's next report arrives.
   */
  decisions(limit = 200): Decision[] {
    const rows = this.db
      .prepare(
        `select id, rig, kind, signed, issued_at, status, acked_at, outcome from command
         where kind in ('approve_promotion', 'decline_promotion', 'accept_review', 'conclude')
         order by issued_at desc limit ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        payload =
          (JSON.parse(String(r.signed)) as { envelope?: { payload?: Record<string, unknown> } })
            .envelope?.payload ?? {};
      } catch {}
      return {
        id: String(r.id),
        rig: String(r.rig),
        kind: String(r.kind),
        run: typeof payload.run === "string" ? payload.run : "",
        attempt: typeof payload.attempt === "string" ? payload.attempt : undefined,
        review: typeof payload.review === "number" ? payload.review : undefined,
        proposal: typeof payload.proposal === "number" ? payload.proposal : undefined,
        accept: typeof payload.accept === "boolean" ? payload.accept : undefined,
        issued_at: String(r.issued_at),
        status: String(r.status),
        acked_at: r.acked_at === null ? null : String(r.acked_at),
        outcome: r.outcome ? (JSON.parse(String(r.outcome)) as Decision["outcome"]) : null,
      };
    });
  }

  get(id: string): { status: string; outcome: unknown } | undefined {
    const r = this.db.prepare("select status, outcome from command where id = ?").get(id) as
      | Row
      | undefined;
    return r
      ? { status: String(r.status), outcome: r.outcome ? JSON.parse(String(r.outcome)) : null }
      : undefined;
  }

  /**
   * One command as the dashboard follows it (goal 080): its state, the rig's answer, its payload
   * and when its signature runs out. A pending command past that time is one the rig never took.
   */
  row(id: string): CommandRow | undefined {
    const r = this.db
      .prepare(
        "select id, rig, kind, signed, issued_by, issued_at, status, outcome, acked_at from command where id = ?",
      )
      .get(id) as Row | undefined;
    return r ? commandRowOf(r) : undefined;
  }

  /** A rig's newest commands of one kind, newest first (a check's row follows its newest one). */
  latest(rig: string, kind: string, limit = 20): CommandRow[] {
    return (
      this.db
        .prepare(
          "select id, rig, kind, signed, issued_by, issued_at, status, outcome, acked_at from command where rig = ? and kind = ? order by issued_at desc limit ?",
        )
        .all(rig, kind, limit) as Row[]
    ).map(commandRowOf);
  }

  /**
   * The MCP servers each run control assigned a rig names (its own signed commands, never the rig's
   * reports), by run.
   */
  assignedMcpServers(rig: string): Map<string, McpUse[]> {
    const out = new Map<string, McpUse[]>();
    for (const r of this.db
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
}
