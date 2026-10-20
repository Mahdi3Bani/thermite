import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "../common/env.ts";
import type { LiveKind } from "../core/live.ts";
import {
  type AdvisorsConfig,
  type AdvisorTools,
  advisorFetcher,
  auditOne,
  reviewOne,
  teacherRound,
} from "./advisors.ts";

/**
 * The supervisor's advisor loop: the teacher pair reviews each running run on its cadence, and at
 * once when the owner has written to it; the auditor answers open audits, and the review panel
 * answers open reviews. Everything goes through the harness API with the supervisor's token,
 * which cannot write verdicts, champions or contracts. Each run is kept in the supervisor's
 * home, the figures go to control, and each step is a line in the live view.
 *
 * The owner's messages reach an advisor in its brief or package (owner_messages). When the
 * advisor has run with them, the supervisor tells the harness which it was given and what it
 * answered, and the harness records the reads and the answers.
 */

export interface AdviseConfig {
  harnessUrl: string;
  harnessToken: string;
  home: string;
  advisors: AdvisorsConfig;
  fetchImpl?: typeof fetch | undefined;
  /** Retry spacing for an audit or review whose advisor failed. */
  retryMs?: number | undefined;
  /** A line in the live view (the supervisor's own lines, relayed unsigned). */
  live?: ((line: { kind: LiveKind; text: string; run?: string | undefined }) => void) | undefined;
}

export interface AdviseState {
  lastTeacherAt: Record<string, string>;
  tried: Record<string, string>;
  tries: Record<string, number>;
  spend?: { day: string; usd: number } | undefined;
  /** Per run, the newest owner's message to the teacher pair that already started a round. */
  ownerSeen?: Record<string, number> | undefined;
  stats: {
    teacher_runs: number;
    directive_sets: number;
    directives: number;
    audits: number;
    reviews: number;
    errors: number;
    tokens_in: number;
    tokens_out: number;
    usd: number;
    last_error?: string | undefined;
  };
}

/** An audit or review is tried at most this often before it is left to the owner. */
const MAX_TRIES = 5;

export function emptyAdviseState(): AdviseState {
  return {
    lastTeacherAt: {},
    tried: {},
    tries: {},
    stats: {
      teacher_runs: 0,
      directive_sets: 0,
      directives: 0,
      audits: 0,
      reviews: 0,
      errors: 0,
      tokens_in: 0,
      tokens_out: 0,
      usd: 0,
    },
  };
}

function kbTool(cfg: AdvisorsConfig): AdvisorTools["kbSearch"] {
  const kb = cfg.kb;
  if (!kb) return undefined;
  return async (query) => {
    const client = new Client({ name: "thermite-supervisor", version: "1.0.0" });
    const token = readFileSync(kb.token_file, "utf8").trim();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(kb.mcp_url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const r = await client.callTool({ name: kb.tool, arguments: { query } });
      return r.content;
    } finally {
      await client.close();
    }
  };
}

/** A run as the harness lists it, with the owner's messages each advisor role has not read. */
interface RunRow {
  id: string;
  status: string;
  owner_messages_waiting?: { teachers?: number[]; auditor?: number[]; panel?: number[] };
}

/** An owner's message in a brief or package. */
interface OwnerMessage {
  id: number;
  text: string;
  answered?: boolean;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function harnessApi(cfg: Pick<AdviseConfig, "harnessUrl" | "harnessToken" | "fetchImpl">) {
  const f = cfg.fetchImpl ?? fetch;
  return async (method: string, path: string, body?: unknown) => {
    const res = await f(`${cfg.harnessUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.harnessToken}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  };
}

/** The newest owner's message to the teacher pair a run has waiting (0: none). */
const newestForTeachers = (r: RunRow) => Math.max(0, ...(r.owner_messages_waiting?.teachers ?? []));

/**
 * Whether the owner has written to the teacher pair of a running run since its last round: the
 * loop then starts the next round at once instead of waiting out its pause.
 */
export async function teachersCalled(
  cfg: Pick<AdviseConfig, "harnessUrl" | "harnessToken" | "fetchImpl">,
  state: AdviseState,
): Promise<boolean> {
  const { runs } = (await harnessApi(cfg)("GET", "/v1/runs")) as { runs: RunRow[] };
  return runs.some(
    (r) => r.status === "running" && newestForTeachers(r) > (state.ownerSeen?.[r.id] ?? 0),
  );
}

export async function adviseOnce(cfg: AdviseConfig, state: AdviseState): Promise<AdviseState> {
  const api = harnessApi(cfg);
  const next: AdviseState = structuredClone(state);
  next.tries ??= {};
  next.ownerSeen ??= {};
  const s = next.stats;
  const now = Date.now();
  const retryMs = cfg.retryMs ?? 30 * 60_000;
  /** Retried every retryMs, at most MAX_TRIES times (then the owner decides). */
  const due = (key: string) => {
    const t = next.tried[key];
    if ((next.tries[key] ?? 0) >= MAX_TRIES) return false;
    return !t || now - Date.parse(t) >= retryMs;
  };
  const mark = (key: string) => {
    next.tried[key] = new Date().toISOString();
    next.tries[key] = (next.tries[key] ?? 0) + 1;
  };
  // Web fetch only for listed domains; with an open fetch ("*"), no knowledge-base search in the
  // same agent, so private notes and the open web never meet in one injectable context.
  const domains = cfg.advisors.fetch_domains;
  const tools: AdvisorTools = {
    ...(domains.length ? { fetchUrl: advisorFetcher(cfg.home, domains) } : {}),
    ...(domains.includes("*") ? {} : { kbSearch: kbTool(cfg.advisors) }),
  };
  // A daily spending limit for all advisors of the rig, when the owner set one.
  const day = new Date().toISOString().slice(0, 10);
  if (next.spend?.day !== day) next.spend = { day, usd: 0 };
  const spend = next.spend as { day: string; usd: number };
  const limit = cfg.advisors.max_usd_per_day;
  const overBudget = () => limit !== undefined && spend.usd >= limit;
  const count = (r: { tokensIn: number; tokensOut: number; usd: number }) => {
    s.tokens_in += r.tokensIn;
    s.tokens_out += r.tokensOut;
    s.usd += r.usd;
    spend.usd += r.usd;
  };
  const record = (kind: string, data: unknown) => {
    const dir = join(cfg.home, "advisors");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
    );
  };
  const say = (run: string | undefined, kind: LiveKind, text: string) =>
    cfg.live?.({ kind, text, ...(run ? { run } : {}) });
  const fail = (what: string, err: unknown, run?: string) => {
    s.errors++;
    s.last_error = `${what}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    log("supervisor", "advisor error", { error: s.last_error });
    say(run, "status", `${clip(s.last_error, 400)}`);
  };
  /**
   * Tells the harness which of the owner's messages an advisor role was given and what it
   * answered (only answers to messages it was given). A failure here never stops the advisor's
   * own work: the messages then stay waiting and are given again.
   */
  const receipts = async (
    run: string,
    role: "teachers" | "auditor" | "panel",
    given: number[],
    answers: { message: number; text: string; advisor?: string | undefined }[],
  ) => {
    if (!given.length) return;
    try {
      await api("POST", "/v1/advisor-messages", {
        run,
        role,
        read: given,
        answers: answers.filter((a) => given.includes(a.message) && a.text.length > 0),
      });
    } catch (err) {
      fail(`the owner's messages to the ${role} for ${run}`, err, run);
    }
  };

  // The teacher pair, per running run, on its cadence, and at once for a new owner's message.
  if (cfg.advisors.teachers.length && !overBudget()) {
    const { runs } = (await api("GET", "/v1/runs")) as { runs: RunRow[] };
    for (const inst of runs.filter((i) => i.status === "running")) {
      const newest = newestForTeachers(inst);
      const called = newest > (next.ownerSeen[inst.id] ?? 0);
      const last = next.lastTeacherAt[inst.id];
      if (!called && last && now - Date.parse(last) < cfg.advisors.teacher_minutes * 60_000)
        continue;
      next.lastTeacherAt[inst.id] = new Date().toISOString();
      // An owner's message starts one round: a round that fails leaves it for the next one.
      if (newest) next.ownerSeen[inst.id] = Math.max(newest, next.ownerSeen[inst.id] ?? 0);
      say(
        inst.id,
        "status",
        called
          ? `the teacher pair reviews ${inst.id} now: the owner wrote to it`
          : `the teacher pair reviews ${inst.id}`,
      );
      try {
        const brief = (await api("GET", `/v1/brief?run=${encodeURIComponent(inst.id)}`)) as {
          owner_messages?: OwnerMessage[];
        };
        const given = (brief.owner_messages ?? []).filter((m) => !m.answered).map((m) => m.id);
        const run = await teacherRound({
          config: cfg.advisors,
          run: inst.id,
          brief,
          tools: {
            ...tools,
            brief: () => api("GET", `/v1/brief?run=${encodeURIComponent(inst.id)}`),
          },
        });
        s.teacher_runs++;
        count({ tokensIn: run.tokens.in, tokensOut: run.tokens.out, usd: run.usd });
        for (const r of run.reviews) {
          const recs = r.review?.recommendations ?? [];
          say(
            inst.id,
            r.review ? "text" : "status",
            r.review
              ? `teacher ${r.teacher}: ${clip(r.review.summary, 400)}${recs.length ? ` Suggests: ${recs.map((x) => `${x.kind}${x.family ? ` ${x.family}` : ""}`).join(", ")}.` : ""}`
              : `teacher ${r.teacher} gave no review: ${clip(r.error ?? "", 300)}`,
          );
        }
        // The teachers that reviewed had the owner's messages in their brief: they read them.
        if (run.reviews.some((r) => r.review))
          await receipts(inst.id, "teachers", given, run.answers);
        let posted: unknown;
        if (run.directives?.length) {
          posted = await api("POST", "/v1/directives", {
            run: inst.id,
            directives: run.directives,
          });
          s.directive_sets++;
          s.directives += run.directives.length;
          say(
            inst.id,
            "text",
            `directives for the planner: ${run.directives
              .map(
                (d) =>
                  `${d.kind}${d.family ? ` ${d.family}` : ""}${d.value !== undefined ? ` ${String(d.value)}` : ""} (why: ${clip(d.rationale, 200)})`,
              )
              .join("; ")}${run.dropped.length ? `. Dropped: ${run.dropped.join("; ")}` : ""}`,
          );
        } else if (run.error) {
          fail(`teachers for ${inst.id}`, run.error, inst.id);
        } else {
          say(inst.id, "status", "the teacher pair set no directives");
        }
        record(`teachers-${inst.id}`, { ...run, posted });
      } catch (err) {
        fail(`teachers for ${inst.id}`, err, inst.id);
      }
    }
  }

  // The auditor: open audits. An audit can block, never pass; the harness enforces that too.
  if (cfg.advisors.auditor && !overBudget()) {
    const { audits } = (await api("GET", "/v1/audits/pending")) as {
      audits: { attempt: string; run?: string; owner_messages?: OwnerMessage[] }[];
    };
    // The owner's messages go to the auditor once, with the first audit that gets them.
    const told = new Set<number>();
    for (const pkg of audits) {
      const key = `audit:${pkg.attempt}`;
      if (!due(key)) continue;
      mark(key);
      const owner = (pkg.owner_messages ?? []).filter((m) => !told.has(m.id));
      try {
        const r = await auditOne({
          config: cfg.advisors,
          pkg: { ...pkg, owner_messages: owner },
          tools,
        });
        count(r);
        if (!r.output) {
          fail(`audit of ${pkg.attempt}`, r.error, pkg.run);
          continue;
        }
        if (pkg.run) {
          await receipts(
            pkg.run,
            "auditor",
            owner.map((m) => m.id),
            r.output.answers.map((a) => ({ ...a, advisor: cfg.advisors.auditor?.name })),
          );
          for (const m of owner) told.add(m.id);
        }
        const posted = (await api("POST", "/v1/audits", {
          attempt: pkg.attempt,
          decision: r.output.decision,
          reasons: r.output.reasons,
          citations: r.output.citations,
          auditor: cfg.advisors.auditor.name,
        })) as { effect?: string };
        s.audits++;
        say(
          pkg.run,
          "text",
          `audit of ${pkg.attempt} (try ${next.tries[key] ?? 1}): ${r.output.decision}${posted?.effect ? `, ${posted.effect}` : ""}. ${clip(r.output.reasons, 400)}`,
        );
        record(`audit-${pkg.attempt}`, { decision: r.output, posted });
      } catch (err) {
        fail(`audit of ${pkg.attempt}`, err, pkg.run);
      }
    }
  }

  // The review panel: every panelist reviews blind; the harness needs at least two.
  if (cfg.advisors.panel.length && !overBudget()) {
    const { reviews } = (await api("GET", "/v1/reviews/pending")) as {
      reviews: { id: number; run?: string; goal?: string; owner_messages?: OwnerMessage[] }[];
    };
    const told = new Set<number>();
    for (const pkg of reviews) {
      const key = `review:${pkg.id}`;
      if (!due(key)) continue;
      mark(key);
      const owner = (pkg.owner_messages ?? []).filter((m) => !told.has(m.id));
      try {
        const results: { reviewer: string; pass: boolean; reasons: string }[] = [];
        const answers: { message: number; text: string; advisor: string }[] = [];
        for (const runtime of cfg.advisors.panel) {
          const r = await reviewOne({ runtime, pkg: { ...pkg, owner_messages: owner } });
          count(r);
          if (!r.output) continue;
          results.push({ reviewer: runtime.name, pass: r.output.pass, reasons: r.output.reasons });
          for (const a of r.output.answers) answers.push({ ...a, advisor: runtime.name });
          say(
            pkg.run,
            "text",
            `review ${pkg.id}${pkg.goal ? ` of goal ${pkg.goal}` : ""}, ${runtime.name}: ${r.output.pass ? "pass" : "fail"}. ${clip(r.output.reasons, 300)}`,
          );
        }
        if (results.length && pkg.run) {
          await receipts(
            pkg.run,
            "panel",
            owner.map((m) => m.id),
            answers,
          );
          for (const m of owner) told.add(m.id);
        }
        // Every panelist must answer: a crashed dissenter must not lose its veto.
        if (results.length < cfg.advisors.panel.length) {
          fail(
            `review ${pkg.id}`,
            `${results.length} of ${cfg.advisors.panel.length} panelists answered`,
            pkg.run,
          );
          continue;
        }
        const posted = (await api("POST", `/v1/reviews/${pkg.id}`, { results })) as {
          result?: string;
        };
        s.reviews++;
        say(
          pkg.run,
          "status",
          `review ${pkg.id}: ${posted?.result === "review_passed" ? "the panel passed it; it waits for the owner's acceptance" : "the panel did not pass it"}`,
        );
        record(`review-${pkg.id}`, { results, posted });
      } catch (err) {
        fail(`review ${pkg.id}`, err, pkg.run);
      }
    }
  }
  // Old retry markers go after a week.
  for (const [k, t] of Object.entries(next.tried)) {
    if (now - Date.parse(t) > 7 * 24 * 3_600_000) {
      delete next.tried[k];
      delete next.tries[k];
    }
  }
  return next;
}
