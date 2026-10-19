import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "../common/env.ts";
import {
  type AdvisorsConfig,
  type AdvisorTools,
  advisorFetcher,
  auditOne,
  reviewOne,
  teacherRound,
} from "./advisors.ts";

/**
 * The supervisor's advisor loop: the teacher pair reviews each running run on its cadence,
 * the auditor answers open audits, and the review panel answers open reviews. Everything goes
 * through the harness API with the supervisor's token, which cannot write verdicts, champions
 * or contracts. Each run is kept in the supervisor's home, and the figures go to control.
 */

export interface AdviseConfig {
  harnessUrl: string;
  harnessToken: string;
  home: string;
  advisors: AdvisorsConfig;
  fetchImpl?: typeof fetch | undefined;
  /** Retry spacing for an audit or review whose advisor failed. */
  retryMs?: number | undefined;
}

export interface AdviseState {
  lastTeacherAt: Record<string, string>;
  tried: Record<string, string>;
  tries: Record<string, number>;
  spend?: { day: string; usd: number } | undefined;
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

export async function adviseOnce(cfg: AdviseConfig, state: AdviseState): Promise<AdviseState> {
  const f = cfg.fetchImpl ?? fetch;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${cfg.harnessUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.harnessToken}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  };
  const next: AdviseState = structuredClone(state);
  next.tries ??= {};
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
  const fail = (what: string, err: unknown) => {
    s.errors++;
    s.last_error = `${what}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    log("supervisor", "advisor error", { error: s.last_error });
  };

  // The teacher pair, per running run, on its cadence.
  if (cfg.advisors.teachers.length && !overBudget()) {
    const { runs } = (await api("GET", "/v1/runs")) as {
      runs: { id: string; status: string }[];
    };
    for (const inst of runs.filter((i) => i.status === "running")) {
      const last = next.lastTeacherAt[inst.id];
      if (last && now - Date.parse(last) < cfg.advisors.teacher_minutes * 60_000) continue;
      next.lastTeacherAt[inst.id] = new Date().toISOString();
      try {
        const brief = await api("GET", `/v1/brief?run=${encodeURIComponent(inst.id)}`);
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
        let posted: unknown;
        if (run.directives?.length) {
          posted = await api("POST", "/v1/directives", {
            run: inst.id,
            directives: run.directives,
          });
          s.directive_sets++;
          s.directives += run.directives.length;
        } else if (run.error) {
          fail(`teachers for ${inst.id}`, run.error);
        }
        record(`teachers-${inst.id}`, { ...run, posted });
      } catch (err) {
        fail(`teachers for ${inst.id}`, err);
      }
    }
  }

  // The auditor: open audits. An audit can block, never pass; the harness enforces that too.
  if (cfg.advisors.auditor && !overBudget()) {
    const { audits } = (await api("GET", "/v1/audits/pending")) as {
      audits: { attempt: string }[];
    };
    for (const pkg of audits) {
      const key = `audit:${pkg.attempt}`;
      if (!due(key)) continue;
      mark(key);
      try {
        const r = await auditOne({ config: cfg.advisors, pkg, tools });
        count(r);
        if (!r.output) {
          fail(`audit of ${pkg.attempt}`, r.error);
          continue;
        }
        const posted = await api("POST", "/v1/audits", {
          attempt: pkg.attempt,
          ...r.output,
          auditor: cfg.advisors.auditor.name,
        });
        s.audits++;
        record(`audit-${pkg.attempt}`, { decision: r.output, posted });
      } catch (err) {
        fail(`audit of ${pkg.attempt}`, err);
      }
    }
  }

  // The review panel: every panelist reviews blind; the harness needs at least two.
  if (cfg.advisors.panel.length && !overBudget()) {
    const { reviews } = (await api("GET", "/v1/reviews/pending")) as {
      reviews: { id: number }[];
    };
    for (const pkg of reviews) {
      const key = `review:${pkg.id}`;
      if (!due(key)) continue;
      mark(key);
      try {
        const results: { reviewer: string; pass: boolean; reasons: string }[] = [];
        for (const runtime of cfg.advisors.panel) {
          const r = await reviewOne({ runtime, pkg });
          count(r);
          if (r.output) results.push({ reviewer: runtime.name, ...r.output });
        }
        // Every panelist must answer: a crashed dissenter must not lose its veto.
        if (results.length < cfg.advisors.panel.length) {
          fail(
            `review ${pkg.id}`,
            `${results.length} of ${cfg.advisors.panel.length} panelists answered`,
          );
          continue;
        }
        const posted = await api("POST", `/v1/reviews/${pkg.id}`, { results });
        s.reviews++;
        record(`review-${pkg.id}`, { results, posted });
      } catch (err) {
        fail(`review ${pkg.id}`, err);
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
