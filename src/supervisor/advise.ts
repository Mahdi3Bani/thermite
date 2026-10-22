import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "../common/env.ts";
import type { AgentsContext } from "../core/compaction.ts";
import type { NoteInput } from "../core/journal.ts";
import type { LiveKind } from "../core/live.ts";
import type { McpUse } from "../core/mcp.ts";
import { type AdvisorAgent, AGENT_WORDS } from "../core/usage.ts";
import type { McpCaller, McpGateway } from "../harness/mcp-gateway.ts";
import {
  type AdvisorCompaction,
  type AdvisorKeeper,
  type AdvisorMcp,
  type AdvisorsConfig,
  type AdvisorTools,
  type AdvisorUsage,
  advisorFetcher,
  auditOne,
  reviewOne,
  teacherRound,
  withRunContext,
} from "./advisors.ts";
import type { AdvisorCode } from "./code-tools.ts";
import type { PastSearch } from "./past-mcp.ts";

/**
 * The supervisor's advisor loop: the teachers review each running run on their cadence, and at
 * once when the owner has written to it; the auditor answers open audits, and the review panel
 * answers open reviews. Everything goes through the harness API with the supervisor's token,
 * which cannot write verdicts, champions or contracts. Each run is kept in the supervisor's
 * home, the figures go to control, and each step is a line in the live view.
 *
 * The owner's messages reach an advisor in its brief or package (owner_messages). When the
 * advisor has run with them, the supervisor tells the harness which it was given and what it
 * answered, and the harness records the reads and the answers.
 *
 * The teachers, the auditor and the review panel may search the run's past research (the
 * folders its campaign may read in Thermite's knowledge base), read only, through the harness's
 * copy of the run's knowledge/: the same items the workers search. A teacher that may fetch any
 * web page gets no past research at all.
 *
 * They get the MCP servers the run's kit gives the advisors (goal 068): the supervisor makes each
 * call with the sign-in control gave it, and tells the harness when a server fails or comes back,
 * for the run's history. Advisors that may fetch any web page get no MCP server either.
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
  /**
   * The advisors' MCP servers (goal 068): the supervisor's gateway, holding the servers control
   * gave the rig for advisors, and each run's servers as its kit names them (read each round).
   */
  mcp?: { gateway: McpGateway; uses: Map<string, McpUse[]> } | undefined;
}

export interface AdviseState {
  lastTeacherAt: Record<string, string>;
  tried: Record<string, string>;
  tries: Record<string, number>;
  spend?: { day: string; usd: number } | undefined;
  /** Per run, the newest owner's message to the teachers that already started a round. */
  ownerSeen?: Record<string, number> | undefined;
  /** Per run, the newest owner's message already told it waits for the spending limit. */
  limitSaid?: Record<string, number> | undefined;
  /** Runs already told their advisors get no MCP server because they may fetch any page. */
  mcpOffSaid?: Record<string, boolean> | undefined;
  /**
   * Per run, the newest time its queue fell below its target (the harness's queue_low event)
   * that already started a teachers' round (goal 081).
   */
  ideasSeen?: Record<string, number> | undefined;
  /** Runs already told their teachers read no code because they may fetch any page. */
  codeOffSaid?: Record<string, boolean> | undefined;
  /**
   * Each open audit's last error, by its retry key (goal 079): the words its hand-off to the
   * owner gives once its tries are spent.
   */
  auditErrors?: Record<string, string> | undefined;
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

/** One knowledge base's search over MCP, read only; the token is a bearer header, never in the URL. */
function mcpSearch(url: string, token: () => string, tool: string) {
  return async (query: string) => {
    const client = new Client({ name: "thermite-supervisor", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token()}` } },
      }),
    );
    try {
      const r = await client.callTool({ name: tool, arguments: { query } });
      return r.content;
    } finally {
      await client.close();
    }
  };
}

/** The knowledge-base search of the advisors file's own `kb`, read only; none without one. */
export function kbSearchFor(cfg: Pick<AdvisorsConfig, "kb">): AdvisorTools["kbSearch"] {
  const kb = cfg.kb;
  return kb
    ? mcpSearch(kb.mcp_url, () => readFileSync(kb.token_file, "utf8").trim(), kb.tool)
    : undefined;
}

/** A run as the harness lists it, with the owner's messages each advisor role has not read. */
interface RunRow {
  id: string;
  campaign?: string;
  status: string;
  owner_messages_waiting?: { teachers?: number[]; auditor?: number[]; panel?: number[] };
  /** The MCP servers its kit names, with the agents that get each (goal 068). */
  mcp_servers?: McpUse[];
  /** The campaign's own context settings, which its advisors' calls take too (goal 070). */
  agents_context?: AgentsContext | null;
  /**
   * The planner's round left its queue below the target (goal 081): the teachers' round starts
   * at once. Null: the queue is at its target, or none applies.
   */
  queue_low?: { event: number; at: string; round: number; ready: number; target: number } | null;
}

/** A name safe for a file: other characters become dashes. */
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "advisor";

/**
 * Where an advisor's conversation is kept before each compaction (goal 070): the supervisor's
 * home, beside its records of the advisors' rounds (advisors/), under compactions/<run>/. Never
 * the run's research folder, which the run's agents read: an advisor's conversation may hold an
 * outside knowledge base's results or a fetched page. Each compaction is a line in the run's
 * live view.
 */
export function advisorKeeper(
  home: string,
  run: string | undefined,
  say?: ((text: string) => void) | undefined,
): AdvisorKeeper {
  const folder = `compactions/${fileSafe(run ?? "no-run")}`;
  const stem = (advisor: string, call: string) => `${fileSafe(call)}-${fileSafe(advisor)}`;
  const program = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" } as const;
  return {
    keep: (advisor, call, n, markdown) => {
      const dir = join(home, "advisors", folder);
      mkdirSync(dir, { recursive: true });
      const name = `${stem(advisor, call)}-${n}.md`;
      writeFileSync(join(dir, name), markdown);
      return `the supervisor's records, advisors/${folder}/${name}`;
    },
    // Where it will be kept, in the same words, for the summary of the advisor's own program.
    at: (advisor, call) => ({
      dir: `advisors/${folder}`,
      stem: stem(advisor, call),
      readable: false,
      place: "the supervisor's records",
    }),
    done: (c) => {
      const tokens =
        c.tokens_before !== null
          ? ` at about ${c.tokens_before.toLocaleString("en-US")} tokens${c.tokens_after !== null ? `, down to about ${c.tokens_after.toLocaleString("en-US")}` : ""}`
          : "";
      const by = c.harness ? ` by ${program[c.harness]}` : "";
      say?.(
        `advisor ${c.advisor}: its conversation was compacted${by} (compaction ${c.number})${tokens}. It goes on.${c.how === "trimmed" ? " The summary failed, so the bodies of older tool results were left out." : ""}${c.kept ? ` The conversation before it is kept in ${c.kept}.` : " The conversation before it was not kept."}${c.error ? ` (${clip(c.error, 300)})` : ""}`,
      );
      if (c.summary)
        say?.(
          `advisor ${c.advisor}: the summary after compaction ${c.number}:\n\n${clip(c.summary, 4000)}`,
        );
    },
  };
}

/** An owner's message in a brief or package. */
interface OwnerMessage {
  id: number;
  text: string;
  /** In the teachers' brief: read in an earlier round (a standing wish, not to answer again). */
  read?: boolean;
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

/** The newest owner's message to the teachers a run has waiting (0: none). */
const newestForTeachers = (r: RunRow) => Math.max(0, ...(r.owner_messages_waiting?.teachers ?? []));

/** The newest time a run's queue fell below its target, while it still is (0: none, goal 081). */
const lowQueue = (r: RunRow) => r.queue_low?.event ?? 0;

/**
 * Whether the owner has written to the teachers of a running run since its last round, or the
 * run's queue fell below its target since (goal 081): the loop then starts the next round at
 * once instead of waiting out its pause.
 */
export async function teachersCalled(
  cfg: Pick<AdviseConfig, "harnessUrl" | "harnessToken" | "fetchImpl"> & {
    advisors?: Pick<AdvisorsConfig, "max_usd_per_day"> | undefined;
  },
  state: AdviseState,
): Promise<boolean> {
  // At the day's spending limit the teachers do not run, so a message cannot start a round.
  if (overSpendLimit(cfg.advisors, state)) return false;
  const { runs } = (await harnessApi(cfg)("GET", "/v1/runs")) as { runs: RunRow[] };
  return runs.some(
    (r) =>
      r.status === "running" &&
      (newestForTeachers(r) > (state.ownerSeen?.[r.id] ?? 0) ||
        lowQueue(r) > (state.ideasSeen?.[r.id] ?? 0)),
  );
}

/** Whether the advisors have spent the day's limit (UTC), when the owner set one. */
export function overSpendLimit(
  advisors: Pick<AdvisorsConfig, "max_usd_per_day"> | undefined,
  state: AdviseState,
): boolean {
  const limit = advisors?.max_usd_per_day;
  const day = new Date().toISOString().slice(0, 10);
  return limit !== undefined && state.spend?.day === day && state.spend.usd >= limit;
}

export async function adviseOnce(cfg: AdviseConfig, state: AdviseState): Promise<AdviseState> {
  const api = harnessApi(cfg);
  const next: AdviseState = structuredClone(state);
  next.tries ??= {};
  next.ownerSeen ??= {};
  next.ideasSeen ??= {};
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
  // same agent, so private notes and the open web never meet in one injectable context. An
  // outside knowledge base's search goes only to the advisors of the campaigns granted it.
  const domains = cfg.advisors.fetch_domains;
  const fetchUrl = domains.length ? advisorFetcher(cfg.home, domains) : undefined;
  const toolsFor = (): AdvisorTools => ({
    ...(fetchUrl ? { fetchUrl } : {}),
    ...(domains.includes("*") ? {} : { kbSearch: kbSearchFor(cfg.advisors) }),
  });
  // The run's past research, read only: a search of the harness's copy of its knowledge/, for a
  // run whose brief or package says it has some (past_research).
  const pastSearchFor =
    (run: string): PastSearch =>
    (query, o = {}) =>
      api(
        "GET",
        `/v1/knowledge?${new URLSearchParams({
          run,
          q: query.slice(0, 300),
          ...(o.kinds?.length ? { kinds: o.kinds.join(",") } : {}),
          ...(o.limit ? { limit: String(Math.max(1, Math.min(50, Math.floor(o.limit)))) } : {}),
        }).toString()}`,
      );
  // The run's code and evidence for its teachers, read only, through the harness (goal 081): the
  // champion's tree, a file of it, an attempt's diff, and the judge's public findings.
  const codeFor = (run: string): AdvisorCode => {
    const get = (path: string, params: Record<string, string | number | undefined>) =>
      api(
        "GET",
        `${path}?${new URLSearchParams(
          Object.entries({ run, ...params }).flatMap(([k, v]) =>
            v === undefined ? [] : [[k, String(v)] as [string, string]],
          ),
        ).toString()}`,
      );
    return {
      listFiles: (path) => get("/v1/code/files", { path }),
      readFile: (path, offset, limit) => get("/v1/code/file", { path, offset, limit }),
      readDiff: (attempt, offset) => get("/v1/code/diff", { attempt, offset }),
      evidence: (attempt) => get("/v1/evidence", { attempt }),
    };
  };
  // The MCP servers a run's kit gives its advisors (goal 068), from the harness's list of runs
  // (read once a round). The supervisor calls them; advisors that may fetch any page get none,
  // which the run's live view says once.
  let runRows: RunRow[] | undefined;
  const runsNow = async () => {
    runRows ??= ((await api("GET", "/v1/runs")) as { runs: RunRow[] }).runs;
    return runRows;
  };
  // A run's advisors with the campaign's own context settings (goal 070): each runtime's window
  // is the lower of its own and the campaign's, and the campaign's point replaces its own.
  const configFor = async (run: string | undefined): Promise<AdvisorsConfig> => {
    const ctx = run ? (await runsNow()).find((r) => r.id === run)?.agents_context : undefined;
    if (!ctx) return cfg.advisors;
    const a = cfg.advisors;
    return {
      ...a,
      teachers: a.teachers.map((t) => withRunContext(t, ctx)),
      merged_by: a.merged_by ? withRunContext(a.merged_by, ctx) : undefined,
      auditor: a.auditor ? withRunContext(a.auditor, ctx) : undefined,
      review_panel: a.review_panel.map((p) => withRunContext(p, ctx)),
    };
  };
  // Each call's conversation before a compaction, kept with the supervisor's records (goal 070).
  const keeperFor = (run: string | undefined): AdvisorKeeper =>
    advisorKeeper(cfg.home, run, (text) => say(run, "status", text));
  const mcpFor = async (run: string | undefined): Promise<AdvisorMcp | undefined> => {
    const m = cfg.mcp;
    if (!run || !m) return undefined;
    m.uses.set(run, (await runsNow()).find((r) => r.id === run)?.mcp_servers ?? []);
    const servers = m.gateway.given(run, "advisors").map((g) => g.name);
    if (!servers.length) return undefined;
    if (domains.includes("*")) {
      next.mcpOffSaid ??= {};
      if (!next.mcpOffSaid[run]) {
        next.mcpOffSaid[run] = true;
        say(
          run,
          "status",
          `the advisors may fetch any web page (fetch_domains "*"), so they get no MCP server: ${servers.join(", ")}`,
        );
      }
      return undefined;
    }
    const caller: McpCaller = { run, kind: "advisors", source: "supervisor" };
    const { tools } = await m.gateway.tools(caller);
    return {
      servers,
      tools,
      call: (s, t, a) => m.gateway.call(caller, s, t, a),
      serverFor: (s) => m.gateway.serverFor(caller, s),
    };
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
   * An advisor's model usage in a run (goal 075), handed to the harness with its round: the
   * harness records each call in the run's history. A failure is the advisor's error line, and
   * those calls are not recorded; the advisor's work stands.
   */
  const usageOut = async (
    run: string | undefined,
    round: string,
    agent: AdvisorAgent,
    u: AdvisorUsage | undefined,
  ) => {
    if (!run || !u?.calls.length) return;
    const { calls, ...route } = u;
    for (let i = 0; i < calls.length; i += 500) {
      try {
        await api("POST", "/v1/model-calls", {
          run,
          round,
          agent,
          ...route,
          calls: calls.slice(i, i + 500),
        });
      } catch (err) {
        fail(`the model usage of the ${AGENT_WORDS[agent].toLowerCase()} for ${run}`, err, run);
        return;
      }
    }
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

  /**
   * An advisor's experiments and moves for a run's queue, recorded with its role as who made
   * them. A failure is the advisor's error line; the advisor's other work stands.
   */
  const toQueue = async (
    run: string,
    role: "teacher" | "auditor",
    add: {
      title: string;
      details?: string | undefined;
      family?: string | undefined;
      why: string;
      position?: string | undefined;
    }[],
    move: { id: string; position: string | number; why: string }[],
  ): Promise<unknown> => {
    if (!add.length && !move.length) return undefined;
    try {
      // In parts of 20, as the harness takes them: the teachers' portfolio has no count.
      const r = { added: [] as string[], moved: [] as string[], refused: [] as string[] };
      for (let i = 0; i === 0 || i < add.length; i += 20) {
        const part = (await api("POST", "/v1/queue", {
          run,
          role,
          add: add.slice(i, i + 20),
          move: i === 0 ? move : [],
        })) as { added: string[]; moved: string[]; refused: string[] };
        r.added.push(...part.added);
        r.moved.push(...part.moved);
        r.refused.push(...part.refused);
      }
      const who = role === "teacher" ? "the teachers" : "the auditor";
      say(
        run,
        "text",
        [
          r.added.length
            ? `${who} added to the queue: ${add
                .filter(
                  (a) => !r.refused.some((x) => x.startsWith(`add "${a.title.slice(0, 120)}"`)),
                )
                .map((a) => clip(a.title, 120))
                .join("; ")}`
            : "",
          r.moved.length ? `${who} moved ${r.moved.join(", ")}` : "",
          r.refused.length ? `refused: ${r.refused.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join(". "),
      );
      return r;
    } catch (err) {
      fail(`the queue for ${run}`, err, run);
      return undefined;
    }
  };

  /**
   * An advisor's field notes, posted after its work was: the harness records them as written by
   * `<role>:<name>` (each note checked on its own). A failure is the advisor's error line; its
   * review, audit or verdict stands.
   */
  const notesOut = async (
    run: string,
    role: "teachers" | "auditor" | "panel",
    by: string,
    notes: NoteInput[],
  ): Promise<unknown> => {
    if (!notes.length) return undefined;
    try {
      const r = (await api("POST", "/v1/journal", { run, role, by, notes })) as {
        recorded: number[];
        problems: string[];
      };
      if (r.problems.length)
        say(run, "status", `the field notes of ${by}: ${clip(r.problems.join("; "), 400)}`);
      return r;
    } catch (err) {
      fail(`the field notes of ${by} for ${run}`, err, run);
      return undefined;
    }
  };

  // The teachers, per running run, on their cadence, and at once for a new owner's message.
  // At the limit, an owner's message to the teachers waits for the next day: said once.
  if (cfg.advisors.teachers.length && overBudget()) {
    next.limitSaid ??= {};
    const { runs } = (await api("GET", "/v1/runs")) as { runs: RunRow[] };
    for (const inst of runs.filter((i) => i.status === "running")) {
      const newest = newestForTeachers(inst);
      if (newest <= Math.max(next.ownerSeen[inst.id] ?? 0, next.limitSaid[inst.id] ?? 0)) continue;
      next.limitSaid[inst.id] = newest;
      say(
        inst.id,
        "status",
        `the advisors reached the day's spending limit (${limit} USD): the teachers read your message after midnight UTC`,
      );
    }
  }
  if (cfg.advisors.teachers.length && !overBudget()) {
    const { runs } = (await api("GET", "/v1/runs")) as { runs: RunRow[] };
    for (const inst of runs.filter((i) => i.status === "running")) {
      const newest = newestForTeachers(inst);
      const called = newest > (next.ownerSeen[inst.id] ?? 0);
      // The planner's round left the queue below its target (goal 081): ideas are wanted now.
      const low = lowQueue(inst);
      const wanted = low > (next.ideasSeen[inst.id] ?? 0);
      const last = next.lastTeacherAt[inst.id];
      if (
        !called &&
        !wanted &&
        last &&
        now - Date.parse(last) < cfg.advisors.teacher_minutes * 60_000
      )
        continue;
      next.lastTeacherAt[inst.id] = new Date().toISOString();
      // An owner's message starts one round: a round that fails leaves it for the next one.
      if (newest) next.ownerSeen[inst.id] = Math.max(newest, next.ownerSeen[inst.id] ?? 0);
      // So does a queue below its target: the next one waits for a new planner's round.
      if (low) next.ideasSeen[inst.id] = Math.max(low, next.ideasSeen[inst.id] ?? 0);
      const q = inst.queue_low;
      const ideasNow =
        wanted && q
          ? `its queue has ${q.ready} of its target of ${q.target} experiments ready: ideas are wanted now`
          : undefined;
      say(
        inst.id,
        "status",
        called
          ? `the teachers review ${inst.id} now: the owner wrote to them`
          : ideasNow
            ? `the teachers review ${inst.id} now: ${ideasNow}`
            : `the teachers review ${inst.id}`,
      );
      try {
        const brief = (await api("GET", `/v1/brief?run=${encodeURIComponent(inst.id)}`)) as {
          owner_messages?: OwnerMessage[];
          background?: unknown;
          past_research?: unknown;
        };
        // Teachers with an open web fetch get no records of other campaigns: past research and
        // the briefing stay out of their brief (and its tool), as the knowledge-base search does.
        const openFetch = domains.includes("*");
        const closed = <T extends { background?: unknown; past_research?: unknown }>(b: T): T => {
          if (openFetch) {
            delete b.background;
            delete b.past_research;
          }
          return b;
        };
        closed(brief);
        const given = (brief.owner_messages ?? []).filter((m) => !m.read).map((m) => m.id);
        const round = `teachers ${new Date().toISOString()}`;
        // The run's code and evidence, read only (goal 081); none for teachers with an open
        // fetch: the code is private, and private reads never meet the open web in one advisor.
        if (openFetch) {
          next.codeOffSaid ??= {};
          if (!next.codeOffSaid[inst.id]) {
            next.codeOffSaid[inst.id] = true;
            say(
              inst.id,
              "status",
              `the teachers may fetch any web page (fetch_domains "*"), so they read no code, diffs or the judge's full findings: only their brief`,
            );
          }
        }
        const run = await teacherRound({
          // With the campaign's own context settings, when it sets any (goal 070).
          config: await configFor(inst.id),
          run: inst.id,
          brief,
          why: ideasNow,
          keeper: keeperFor(inst.id),
          tools: {
            ...toolsFor(),
            ...(openFetch ? {} : { code: codeFor(inst.id) }),
            // The run's MCP servers for its advisors (none with an open fetch: mcpFor says so).
            mcp: await mcpFor(inst.id),
            // Teachers with an open fetch search no past research either.
            // Only when the run has some: the brief says so in past_research.
            ...(openFetch || !brief.past_research ? {} : { pastSearch: pastSearchFor(inst.id) }),
            brief: async () =>
              closed(
                (await api("GET", `/v1/brief?run=${encodeURIComponent(inst.id)}`)) as {
                  background?: unknown;
                  past_research?: unknown;
                },
              ),
          },
        });
        s.teacher_runs++;
        count({ tokensIn: run.tokens.in, tokensOut: run.tokens.out, usd: run.usd });
        for (const u of run.usage) await usageOut(inst.id, round, u.agent, u);
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
        // Teachers' opportunities the merged by model left out, kept by code (goal 081).
        if (run.kept.length)
          say(inst.id, "status", `the teachers' portfolio: ${run.kept.join("; ")}`);
        // Their portfolio for the run's queue, as experiments, and moves of queued ones, before
        // the rules: a rule may then name the direction of an experiment they just added.
        const queued = await toQueue(inst.id, "teacher", run.experiments, run.moves);
        let posted: unknown;
        if (run.directives?.length) {
          posted = await api("POST", "/v1/directives", {
            run: inst.id,
            directives: run.directives,
          });
          const left = ((posted as { left_out?: { rule: string; why: string }[] } | undefined)
            ?.left_out ?? []) as { rule: string; why: string }[];
          s.directive_sets++;
          s.directives += run.directives.length - left.length;
          say(
            inst.id,
            "text",
            `directives for the planner: ${run.directives
              .map(
                (d) =>
                  `${d.kind}${d.family ? ` ${d.family}` : ""}${d.value !== undefined ? ` ${String(d.value)}` : ""} (why: ${clip(d.rationale, 200)})`,
              )
              .join(
                "; ",
              )}${run.dropped.length ? `. Dropped: ${run.dropped.join("; ")}` : ""}${left.length ? `. Left out by the rig: ${left.map((l) => l.rule).join("; ")}: ${left[0]?.why ?? ""}` : ""}`,
          );
        } else if (run.error) {
          fail(`teachers for ${inst.id}`, run.error, inst.id);
        } else {
          // What the supervisor left out still shows: an opportunity, or a rule it refused.
          say(
            inst.id,
            "status",
            `the teachers set no directives${run.dropped.length ? `. Dropped: ${run.dropped.join("; ")}` : ""}`,
          );
        }
        // Then each teacher's (and the merged by model's) field notes, once the round's work is posted.
        const noted: unknown[] = [];
        for (const j of run.journal) noted.push(await notesOut(inst.id, "teachers", j.by, j.notes));
        record(`teachers-${inst.id}`, { ...run, posted, queued, noted });
      } catch (err) {
        fail(`teachers for ${inst.id}`, err, inst.id);
      }
    }
  }

  // The auditor: open audits. An audit can block, never pass; the harness enforces that too.
  if (cfg.advisors.auditor && !overBudget()) {
    const auditor = cfg.advisors.auditor;
    const { audits } = (await api("GET", "/v1/audits/pending")) as {
      audits: {
        /** The audit's own id: each confirmation of an attempt has an audit of its own. */
        id?: number;
        attempt: string;
        run?: string;
        owner_messages?: OwnerMessage[];
        past_research?: string;
      }[];
    };
    // The owner's messages go to the auditor once, with the first audit that gets them.
    const told = new Set<number>();
    // Each audit's tries are its own, by its id (goal 079): a new audit of the same attempt starts
    // afresh. The markers of audits no longer open go.
    const keyOf = (pkg: { id?: number; attempt: string }) => `audit:${pkg.id ?? pkg.attempt}`;
    const open = new Set(audits.map(keyOf));
    next.auditErrors ??= {};
    const errors = next.auditErrors;
    for (const k of [...Object.keys(next.tried), ...Object.keys(errors)]) {
      if (!k.startsWith("audit:") || open.has(k)) continue;
      delete next.tried[k];
      delete next.tries[k];
      delete errors[k];
    }
    /**
     * An audit whose tries are spent goes to the owner (goal 079), with the last error: hands-off
     * leaves no other step. A hand-off that does not reach the harness is tried again every
     * retryMs, while the audit is still open: an audit never waits with nobody told.
     */
    const toOwner = async (pkg: { attempt: string; run?: string }, key: string) => {
      next.tried[key] = new Date().toISOString();
      try {
        await api("POST", "/v1/audits", {
          attempt: pkg.attempt,
          decision: "needs_owner",
          reasons: `the auditor could not answer after ${MAX_TRIES} tries: ${errors[key] ?? "no detail"}`,
          citations: [],
          auditor: auditor.name,
        });
        say(
          pkg.run,
          "status",
          `audit of ${pkg.attempt}: the auditor could not answer after ${MAX_TRIES} tries, so it waits for the owner`,
        );
      } catch (e) {
        fail(
          `audit of ${pkg.attempt}: handing it to the owner (tried again in ${Math.round(retryMs / 60_000)} minutes)`,
          e,
          pkg.run,
        );
      }
    };
    /** An audit the auditor could not answer: tried again later, or, its last try, the owner's. */
    const failed = async (
      pkg: { attempt: string; run?: string },
      key: string,
      err: unknown,
    ): Promise<void> => {
      fail(`audit of ${pkg.attempt}`, err, pkg.run);
      errors[key] = clip(err instanceof Error ? err.message : String(err), 500);
      if ((next.tries[key] ?? 0) < MAX_TRIES) return;
      await toOwner(pkg, key);
    };
    for (const pkg of audits) {
      const key = keyOf(pkg);
      // Its tries are spent and it is still open: its hand-off to the owner did not reach the
      // harness. It is handed again.
      if ((next.tries[key] ?? 0) >= MAX_TRIES) {
        const t = next.tried[key];
        if (!t || now - Date.parse(t) >= retryMs) await toOwner(pkg, key);
        continue;
      }
      if (!due(key)) continue;
      mark(key);
      const owner = (pkg.owner_messages ?? []).filter((m) => !told.has(m.id));
      try {
        const r = await auditOne({
          // With the campaign's own context settings, when it sets any (goal 070).
          config: await configFor(pkg.run),
          pkg: { ...pkg, owner_messages: owner },
          keeper: keeperFor(pkg.run),
          tools: {
            ...toolsFor(),
            mcp: await mcpFor(pkg.run),
            ...(pkg.run && pkg.past_research ? { pastSearch: pastSearchFor(pkg.run) } : {}),
          },
        });
        count(r);
        await usageOut(pkg.run, `audit ${pkg.attempt}`, "auditor", r.usage);
        if (!r.output) {
          await failed(pkg, key, r.error);
          continue;
        }
        const posted = (await api("POST", "/v1/audits", {
          attempt: pkg.attempt,
          decision: r.output.decision,
          reasons: r.output.reasons,
          citations: r.output.citations,
          auditor: auditor.name,
        })) as { effect?: string };
        s.audits++;
        // Read only with the posted audit: an audit that fails to post gives them again.
        if (pkg.run) {
          await receipts(
            pkg.run,
            "auditor",
            owner.map((m) => m.id),
            r.output.answers.map((a) => ({ ...a, advisor: auditor.name })),
          );
          for (const m of owner) told.add(m.id);
        }
        say(
          pkg.run,
          "text",
          `audit of ${pkg.attempt} (try ${next.tries[key] ?? 1}): ${r.output.decision}${posted?.effect ? `, ${posted.effect}` : ""}. ${clip(r.output.reasons, 400)}`,
        );
        // A doubt the auditor could not settle: a check at the top of the run's queue.
        const check = r.output.check;
        const queued =
          check && pkg.run
            ? await toQueue(
                pkg.run,
                "auditor",
                [{ ...check, family: "check", position: "top" }],
                [],
              )
            : undefined;
        // Its field notes, once the audit is posted.
        const noted = pkg.run
          ? await notesOut(pkg.run, "auditor", auditor.name, r.output.journal)
          : undefined;
        record(`audit-${pkg.attempt}`, {
          decision: r.output,
          posted,
          queued,
          noted,
          ...(r.compactions?.length ? { compactions: r.compactions } : {}),
        });
      } catch (err) {
        await failed(pkg, key, err);
      }
    }
  }

  // The review panel: every reviewer reviews blind; the harness needs at least two.
  if (cfg.advisors.review_panel.length && !overBudget()) {
    const { reviews } = (await api("GET", "/v1/reviews/pending")) as {
      reviews: {
        id: number;
        run?: string;
        goal?: string;
        owner_messages?: OwnerMessage[];
        past_research?: string;
      }[];
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
        const journal: { by: string; notes: NoteInput[] }[] = [];
        const mcp = await mcpFor(pkg.run);
        // With the campaign's own context settings, when it sets any (goal 070).
        const panel = (await configFor(pkg.run)).review_panel;
        const compactions: AdvisorCompaction[] = [];
        for (const runtime of panel) {
          const r = await reviewOne({
            runtime,
            pkg: { ...pkg, owner_messages: owner },
            ...(pkg.run && pkg.past_research ? { pastSearch: pastSearchFor(pkg.run) } : {}),
            ...(mcp ? { mcp } : {}),
            keeper: keeperFor(pkg.run),
          });
          count(r);
          await usageOut(pkg.run, `review ${pkg.id}`, "panel", r.usage);
          compactions.push(...(r.compactions ?? []));
          if (!r.output) continue;
          results.push({ reviewer: runtime.name, pass: r.output.pass, reasons: r.output.reasons });
          for (const a of r.output.answers) answers.push({ ...a, advisor: runtime.name });
          if (r.output.journal.length) journal.push({ by: runtime.name, notes: r.output.journal });
          say(
            pkg.run,
            "text",
            `review ${pkg.id}${pkg.goal ? ` of goal ${pkg.goal}` : ""}, ${runtime.name}: ${r.output.pass ? "pass" : "fail"}. ${clip(r.output.reasons, 300)}`,
          );
        }
        // Every reviewer must answer: a crashed dissenter must not lose its veto. The owner's
        // messages count as read only with the posted review, so a retry gives them again.
        if (results.length < cfg.advisors.review_panel.length) {
          fail(
            `review ${pkg.id}`,
            `${results.length} of ${cfg.advisors.review_panel.length} reviewers of the review panel answered`,
            pkg.run,
          );
          continue;
        }
        const posted = (await api("POST", `/v1/reviews/${pkg.id}`, { results })) as {
          result?: string;
          accepted?: boolean;
        };
        s.reviews++;
        if (pkg.run) {
          await receipts(
            pkg.run,
            "panel",
            owner.map((m) => m.id),
            answers,
          );
          for (const m of owner) told.add(m.id);
        }
        say(
          pkg.run,
          "status",
          `review ${pkg.id}: ${posted?.result !== "review_passed" ? "the review panel did not pass it" : posted.accepted ? "the review panel passed it, and it was accepted (the run does not ask the owner)" : "the review panel passed it; it waits for the owner's acceptance"}`,
        );
        // Each reviewer's field notes, once the review is posted.
        const noted: unknown[] = [];
        if (pkg.run)
          for (const j of journal) noted.push(await notesOut(pkg.run, "panel", j.by, j.notes));
        record(`review-${pkg.id}`, {
          results,
          posted,
          noted,
          ...(compactions.length ? { compactions } : {}),
        });
      } catch (err) {
        fail(`review ${pkg.id}`, err, pkg.run);
      }
    }
  }
  // Old retry markers go after a week (an open audit's are renewed by each try or hand-off; a
  // closed audit's went above).
  for (const [k, t] of Object.entries(next.tried)) {
    if (now - Date.parse(t) > 7 * 24 * 3_600_000) {
      delete next.tried[k];
      delete next.tries[k];
      delete next.auditErrors?.[k];
    }
  }
  return next;
}
