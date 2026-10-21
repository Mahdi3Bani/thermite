import { COMPACT_AT_DEFAULT } from "../../core/compaction.ts";
import type { AgentRole } from "../store.ts";
import { esc } from "./components.ts";
import { infoLabel } from "./new-campaign.ts";

/**
 * Edit rig's section "2 · The agents" (goals 070, 073 and 074, as the owner approved the revised
 * mockup on 2026-10-21): the agents in two groups, The work (the workers and the planner) and The
 * advisors (the teachers, the auditor and the review panel), each with its job on one line. Every
 * line has a Model, an Effort, a Runs in and a Context cell (the window and the compaction point,
 * changed in a small panel that opens under the cell). The teachers take one model or two; with
 * two, a merged by line joins their suggestions.
 *
 * Every field has a form name, so the form posts without the page's script
 * (/ui/assets/edit-rig.js, edit-rig-client.ts): the workers' `choice`, `effort`, `harness`,
 * `context_workers` and `compact_workers`; every other line's `role_<id>`, `effort_<id>`,
 * `harness_<id>`, `context_<id>` and `compact_<id>`, by the role it sets. The Context panel is a
 * details element, so it opens without the script too. "+ second teacher" and × are links to the
 * page with the second teacher's lines shown or emptied; the script does the same in place.
 */

/** A line of the agents' table: the workers, or the role a line sets. */
export type AgentLineId = "workers" | AgentRole;

/** A model in a line's list, with what the page's script needs to check it. */
export interface AgentModelOption {
  /** "provider|model", each part URI-encoded. */
  value: string;
  label: string;
  provider: string;
  model: string;
  /** Where it runs: claude (a Claude subscription), chatgpt, opencode (OpenCode's own), key. */
  kind: "claude" | "chatgpt" | "opencode" | "key";
  /** Whether Codex can reach its provider (OpenAI's Responses API). */
  codex: boolean;
  /** The context window its provider lists, in tokens; 0: none. */
  window: number;
}
export interface AgentModelGroup {
  label: string;
  options: AgentModelOption[];
}

/** What control keeps for one line now. */
export interface AgentLineNow {
  /** The model's option value; "": none (the line's default). */
  picked: string;
  effort: string | null;
  /** The harness it runs in; null: none chosen. */
  harness: string | null;
  cap: number | null;
  at: number | null;
  /** The model control keeps, when the page shows the line emptied (the second teacher after ×). */
  was?: string | undefined;
}

interface LineSpec {
  id: AgentLineId;
  name: string;
  job: string;
  tip: string;
  /** The model list's empty choice. */
  empty: string;
  /** For sentences: who, whose, and the verb's -s. */
  who: string;
  poss: string;
  s: string;
  kind: "workers" | "planner" | "advisor";
  /** A later line of the Teachers row. */
  sub?: "teacher2" | "merged_by";
}

const LINES: LineSpec[] = [
  {
    id: "workers",
    name: "Workers",
    job: "Change the code, one trial each.",
    tip: "The agents that change the code, one for each lane. They run for many turns, so they use the most of a subscription. With no model here, they use the rig default.",
    empty: "rig default",
    who: "the workers",
    poss: "the workers'",
    s: "",
    kind: "workers",
  },
  {
    id: "planner",
    name: "Planner",
    job: "Picks what each worker tries next.",
    tip: "A few calls in each round. With no model of its own, it uses the workers' model, harness and context.",
    empty: "same as the workers",
    who: "the planner",
    poss: "the planner's",
    s: "s",
    kind: "planner",
  },
  {
    id: "teachers",
    name: "Teachers",
    job: "Read recent trials and suggest next steps.",
    tip: "One or two models. Each reads the recent trials and past research, and suggests next steps, each with a source. Add a second teacher under the first: then a merged-by model joins their suggestions into one set for the planner.",
    empty: "rig default",
    who: "the teacher",
    poss: "the teacher's",
    s: "s",
    kind: "advisor",
  },
  {
    id: "second_teacher",
    name: "",
    job: "",
    tip: "",
    empty: "choose a model",
    who: "teacher 2",
    poss: "teacher 2's",
    s: "s",
    kind: "advisor",
    sub: "teacher2",
  },
  {
    id: "merged_by",
    name: "",
    job: "",
    tip: "",
    empty: "rig default",
    who: "the merged-by model",
    poss: "the merged-by model's",
    s: "s",
    kind: "advisor",
    sub: "merged_by",
  },
  {
    id: "auditor",
    name: "Auditor",
    job: "Checks a win before it is kept.",
    tip: "It looks for a hidden flaw in a win before the win becomes the champion, when the campaign asks for an audit.",
    empty: "rig default",
    who: "the auditor",
    poss: "the auditor's",
    s: "s",
    kind: "advisor",
  },
  {
    id: "review_panel",
    name: "Review panel",
    job: "Scores goals that code can't measure.",
    tip: "Three reviewers, all on this model, score the goals that need judgement. A goal is met only when you accept it. The judge's numbers never come from them.",
    empty: "rig default",
    who: "the review panel",
    poss: "the review panel's",
    s: "s",
    kind: "advisor",
  },
];

/** The harnesses, as Runs in offers them on every line (goal 073). */
const HARNESS_CHOICES: [string, string][] = [
  ["pi", "Pi"],
  ["opencode", "OpenCode v2"],
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
];
const EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "max"];

const AGENT_TIP =
  "Each agent, with its job under its name. The work runs in the rig's harness. The advisors run in the supervisor and never judge: code measures each change and decides.";
const MODEL_TIP =
  "The model of each agent, from Settings › Providers. A subscription's models show as claude-code:…; control gives the rig a subscription's login only while one of its agents uses it. With no model here, an agent uses the rig default.";
const EFFORT_TIP =
  "How long the model thinks before it answers. More effort: better answers, slower, and more of a subscription's window. Providers other than a Claude subscription take up to high.";
const RUNS_TIP =
  "The program that runs the agent: Pi, OpenCode v2, Claude Code or Codex. Each agent can have its own. A Claude subscription runs only in Claude Code, Anthropic's own program. OpenCode's own free models run only in OpenCode. Codex, OpenAI's own program, takes a ChatGPT subscription or an OpenAI-compatible key. The planner with no model of its own runs where the workers run. The advisors run in the supervisor, each in its own folder, with no project to change: they get only Thermite's tools for advisors (past research and the kit's MCP tools).";
const CTX_TIP =
  "Each agent's context window (the most its model reads in one request) and its compaction point (when its conversation is compacted). Press a cell to change them. Empty: the provider's window, and 80%. Bold: set on this rig. These are the rig's defaults: a campaign can set a smaller window and its own point for all its runs.";
const WORK_TIP =
  "The agents that do the research, in the rig's harness. The workers change the code; the planner picks what each worker tries next.";
const ADV_TIP =
  "The agents that advise, in the supervisor. They read the work, then suggest, check or score. They never judge: the judge's code measures each change and decides.";
const MB_TIP =
  "With two teachers, this model joins their suggestions into one set for the planner. Empty: the rig default.";
/** The fields' own tips; the page's script adds what the line's harness does. */
const WINDOW_TIP = "The most the model reads in one request, in tokens.";
const POINT_TIP = "When the conversation is compacted: a percent of the context window.";

/** The form names of a line's fields. */
export const lineFields = (id: AgentLineId) =>
  id === "workers"
    ? {
        model: "choice",
        effort: "effort",
        harness: "harness",
        window: "context_workers",
        point: "compact_workers",
      }
    : {
        model: `role_${id}`,
        effort: `effort_${id}`,
        harness: `harness_${id}`,
        window: `context_${id}`,
        point: `compact_${id}`,
      };

const tokens = (n: number) => n.toLocaleString("en-US");

/** The Context cell's text as the page opens: the window and the point, bold where set here. */
function contextSummary(
  spec: LineSpec,
  now: AgentLineNow,
  window: number,
  workers: string,
): string {
  if (!now.picked) {
    if (spec.kind === "planner")
      return `<span class="muted">as the workers${workers ? `: ${workers}` : ""}</span>`;
    return `<span class="muted">${spec.sub === "teacher2" ? "—" : "rig default"}</span>`;
  }
  const win = now.cap ?? window;
  const w = win ? tokens(win) : "no window";
  const p = now.at ?? COMPACT_AT_DEFAULT;
  return `${now.cap ? `<b>${w}</b>` : w} · ${now.at ? `<b>${p}%</b>` : `${p}%`}`;
}

/** One line's model list. */
function modelOptions(spec: LineSpec, groups: AgentModelGroup[], picked: string): string {
  return `<option value="" data-kind="">${esc(spec.empty)}</option>${groups
    .map(
      (g) =>
        `<optgroup label="${esc(g.label)}">${g.options
          .map(
            (o) =>
              `<option value="${esc(o.value)}" data-kind="${o.kind}" data-provider="${esc(o.provider)}" data-model="${esc(o.model)}" data-window="${o.window}"${o.codex ? ` data-codex="1"` : ""}${o.value === picked ? " selected" : ""}>${esc(o.label)}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("")}`;
}

export interface AgentsTableInput {
  groups: AgentModelGroup[];
  now: Record<AgentLineId, AgentLineNow>;
  /** Whether the second teacher's lines show as the page opens. */
  two: boolean;
  /** The page's own address, for "+ second teacher" and × without the script. */
  href: string;
}

/** The agents' table, with its subscription call-out under it. */
export function agentsTable(o: AgentsTableInput): string {
  const windowOf = (picked: string) =>
    o.groups.flatMap((g) => g.options).find((x) => x.value === picked)?.window ?? 0;
  const w = o.now.workers;
  const wWindow = w.cap ?? windowOf(w.picked);
  const workersSummary = w.picked
    ? `${wWindow ? tokens(wWindow) : "no window"} · ${w.at ?? COMPACT_AT_DEFAULT}%`
    : "";
  const line = (spec: LineSpec) => {
    const now = o.now[spec.id];
    const f = lineFields(spec.id);
    const hidden = spec.sub !== undefined && !o.two;
    const label = esc(spec.poss);
    const model = `<select name="${f.model}" data-role="${spec.id}" data-label="${label} model" aria-label="${label} model"${now.was !== undefined ? ` data-was="${esc(now.was)}"` : ""}>${modelOptions(spec, o.groups, now.picked)}</select>`;
    const first =
      spec.sub !== undefined
        ? `<div class="ag-sp"></div>`
        : `<div class="ag">${infoLabel(spec.name, spec.tip)}<span class="job">${esc(spec.job)}</span></div>`;
    const modelCell =
      spec.sub === "teacher2"
        ? `<div class="t2-m">${model}<a class="btn t2-x" href="${esc(o.href)}?teachers=1#agents" data-t2-x title="Remove the second teacher" aria-label="Remove the second teacher">×</a></div>`
        : spec.sub === "merged_by"
          ? `<div class="mb-m">${infoLabel("merged by", MB_TIP)}${model}</div>`
          : model;
    const effort = `<select name="${f.effort}" data-effort="${spec.id}" data-label="${label} effort" aria-label="${label} effort">${[
      ["", "default"],
      ...EFFORT_CHOICES.map((e) => [e, e]),
    ]
      .map(
        ([v, t]) =>
          `<option value="${v}"${(now.effort ?? "") === v ? " selected" : ""}>${t}</option>`,
      )
      .join("")}</select>`;
    const runs = spec.kind === "workers" ? "run" : "runs";
    const firstRun =
      spec.kind === "workers"
        ? ""
        : `<option value=""${now.harness ? "" : " selected"}>${spec.kind === "planner" ? "as the workers" : spec.sub === "teacher2" ? "—" : "rig default"}</option>`;
    const harness = `<select name="${f.harness}" data-runs-in="${spec.id}" data-label="where ${esc(spec.who)} ${runs}" aria-label="where ${esc(spec.who)} ${runs}">${firstRun}${HARNESS_CHOICES.map(
      ([v, t]) =>
        `<option value="${v}"${(now.harness ?? (spec.kind === "workers" ? "pi" : "")) === v ? " selected" : ""}>${t}</option>`,
    ).join("")}</select>`;
    const ctx = `<details class="ctx-w" data-ctx="${spec.id}"><summary class="ctx-b" title="Press to change the context window and the compaction point" aria-label="${label} context"><span class="ctx-v"><span class="ctx-k">Context: </span><span data-ctx-sum="${spec.id}">${contextSummary(spec, now, windowOf(now.picked), workersSummary)}</span></span><span class="ctx-car" aria-hidden="true"></span></summary>
<div class="ctx-pop" role="group" aria-label="${label} context">
<label class="ctx-f">${infoLabel("Context window", WINDOW_TIP)}<input name="${f.window}" data-cap value="${now.cap ?? ""}" placeholder="${now.picked && windowOf(now.picked) ? esc(tokens(windowOf(now.picked))) : "none"}" inputmode="numeric" autocomplete="off" spellcheck="false"><span class="muted">tokens</span></label>
<label class="ctx-f">${infoLabel("Compact at", POINT_TIP)}<input name="${f.point}" data-at value="${now.at ?? ""}" placeholder="${COMPACT_AT_DEFAULT}" inputmode="numeric" autocomplete="off" spellcheck="false"><span class="muted">%</span></label>
<div class="ctx-msg" data-ctx-msg aria-live="polite"></div>
</div></details>`;
    return `<div class="ln${spec.sub ? " sub" : ""}" data-line="${spec.id}" data-kind="${spec.kind}" data-who="${esc(spec.who)}" data-poss="${esc(spec.poss)}" data-s="${spec.s}"${spec.sub ? ` data-sub="${spec.sub}"` : ""}${hidden ? " hidden" : ""}>${first}${modelCell}${effort}${harness}${ctx}</div><div class="row-say" data-row-say="${spec.id}" hidden></div>`;
  };
  const byId = (id: AgentLineId) => LINES.find((l) => l.id === id) as LineSpec;
  const grp = (name: string, sub: string, tip: string) =>
    `<div class="grp">${infoLabel(name, tip)}<span class="muted small">${esc(sub)}</span></div>`;
  return `<div class="roles" data-agents><div class="hd">${infoLabel("Agent", AGENT_TIP)}</div><div class="hd">${infoLabel("Model", MODEL_TIP)}</div><div class="hd">${infoLabel("Effort", EFFORT_TIP)}</div><div class="hd">${infoLabel("Runs in", RUNS_TIP)}</div><div class="hd">${infoLabel("Context", CTX_TIP)}</div>
${grp("The work", "in the rig's harness", WORK_TIP)}
${line(byId("workers"))}
${line(byId("planner"))}
${grp("The advisors", "in the supervisor; they never judge", ADV_TIP)}
${line(byId("teachers"))}
${line(byId("second_teacher"))}
<div class="ln add" data-t2-addline${o.two || !o.now.teachers.picked ? " hidden" : ""}><div class="ag-sp"></div><div class="t2-add-c"><a class="btn sm ghost" href="${esc(o.href)}?teachers=2#agents" data-t2-add>+ second teacher</a></div></div>
${line(byId("merged_by"))}
${line(byId("auditor"))}
${line(byId("review_panel"))}</div><div class="flag" id="share" hidden></div>`;
}
