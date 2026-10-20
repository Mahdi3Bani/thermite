import { ago, esc } from "./components.ts";

/**
 * The live view's lines, formatted once here for the page and for its updates (live.json), so a
 * line reads the same whichever brought it. Each line has its time. A tool call reads as what it
 * did (the command, the file), not as its JSON arguments, and its result as exit code, duration
 * and the first line of output; everything else is one click away.
 */

export interface LiveEntry {
  id: number;
  at: string;
  source: string;
  lane?: string | null | undefined;
  kind: string;
  text: string;
  signed?: boolean | undefined;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => s.split("\n").find((l) => l.trim()) ?? "";

/** The time a line happened: HH:MM:SS UTC, with the date and how long ago on hover. */
export function liveTime(at: string, now = Date.now()): string {
  return `<span class="lv-t" title="${esc(at.replace("T", " ").slice(0, 19))} UTC · ${esc(ago(at, now))} ago">${esc(at.slice(11, 19))}</span>`;
}

/** A tool call's name and arguments, from "name {json}" (or "name text"). */
export function parseTool(text: string): {
  name: string;
  args: Record<string, unknown> | null;
  raw: string;
} {
  const sp = text.indexOf(" ");
  const name = sp > 0 ? text.slice(0, sp) : text;
  const raw = sp > 0 ? text.slice(sp + 1) : "";
  try {
    const v = JSON.parse(raw);
    return { name, args: v && typeof v === "object" && !Array.isArray(v) ? v : null, raw };
  } catch {
    return { name, args: null, raw };
  }
}

/** What a tool call did, in a few words, and its full input for the details. */
export function toolSummary(text: string): { name: string; what: string; detail: string } {
  const { name, args, raw } = parseTool(text);
  if (!args) return { name, what: esc(clip(firstLine(raw), 140)), detail: raw };
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const command = str("command") ?? str("cmd") ?? str("script");
  if (command) {
    const lines = command.split("\n").length;
    return {
      name,
      what: `<code class="lv-cmd">$ ${esc(clip(firstLine(command), 160))}</code>${lines > 1 ? ` <span class="muted xs">+${lines - 1} lines</span>` : ""}`,
      detail: command,
    };
  }
  const path = str("path") ?? str("file") ?? str("filePath") ?? str("file_path");
  const content = str("content") ?? str("text");
  if (path && content !== undefined)
    return {
      name,
      what: `writes <code>${esc(path)}</code> <span class="muted xs">${content.split("\n").length} lines</span>`,
      detail: content,
    };
  if (path)
    return { name, what: `<code>${esc(path)}</code>`, detail: JSON.stringify(args, null, 2) };
  const pairs = Object.entries(args)
    .map(([k, v]) => `${k}=${clip(typeof v === "string" ? v : JSON.stringify(v), 60)}`)
    .join(" · ");
  return { name, what: esc(clip(pairs, 160)), detail: JSON.stringify(args, null, 2) };
}

/** A tool result: how long, whether it worked (exit code), and its first line of output. */
export function resultSummary(text: string): { hint: string; detail: string } {
  const m = /^(\S+)( failed)? \((\d+) ms\): ?([\s\S]*)$/.exec(text);
  if (!m) return { hint: "", detail: text };
  const ms = Number(m[3]);
  const took = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
  const body = m[4] ?? "";
  let exit: number | null = null;
  let out = body;
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    if (v && typeof v === "object") {
      if (typeof v.exit === "number") exit = v.exit;
      const parts = [v.stdout, v.stderr, v.output].filter((x) => typeof x === "string" && x.trim());
      out = parts.join("\n");
      if (v.killed) out = `killed: ${String(v.killed)}\n${out}`;
    }
  } catch {
    const e = /^exit (\d+)/.exec(body);
    if (e) exit = Number(e[1]);
  }
  const bad = Boolean(m[2]) || (exit !== null && exit !== 0);
  const first = clip(firstLine(out.replace(/^exit \d+\s*/, "")), 90);
  const hint = `<span class="lv-res ${bad ? "bad" : "muted"}">${took}${exit !== null ? ` · exit ${exit}` : m[2] ? " · failed" : ""}${first ? ` · ${esc(first)}` : ""}</span>`;
  return { hint, detail: out || body };
}

/** Who a line is from, in the interleaved view. */
const whoOf = (e: LiveEntry, name: (source: string, lane?: string | null) => string) =>
  `<span class="lv-who">${esc(name(e.source, e.lane))}${e.source.startsWith("trial:") ? ` <span class="muted">${esc(e.source.slice(6, 16))}</span>` : ""}</span>`;

/**
 * One line as HTML. A tool call opens a row its result joins (data-open); a result that finds
 * no open call stands alone.
 */
export function liveEntryHtml(
  e: LiveEntry,
  o: {
    showWho: boolean;
    name: (source: string, lane?: string | null) => string;
    now?: number;
    /** Agents' text as paragraphs, with **bold** and `code` (the run's Live page). */
    md?: boolean;
  },
): string {
  const t = liveTime(e.at, o.now);
  const who = o.showWho ? whoOf(e, o.name) : "";
  const unsigned =
    !e.signed && e.source !== "supervisor" ? `<span class="lv-unsigned">unsigned</span>` : "";
  const row = (cls: string, body: string) =>
    `<div class="lv-row ${cls}" data-id="${e.id}">${t}<div class="lv-body">${who}${body}${unsigned}</div></div>`;
  switch (e.kind) {
    case "status":
      return row("lv-status", `<span>${esc(e.text)}</span>`);
    case "text":
      return row(
        "lv-text",
        o.md
          ? `<div class="lv-md">${mdLite(e.text)}</div>`
          : `<div class="lv-said">${esc(e.text)}</div>`,
      );
    case "thinking":
      return row(
        "lv-think",
        `<details><summary>Thinking <span class="muted">· ${esc(clip(firstLine(e.text), 120))}</span></summary><pre>${esc(e.text)}</pre></details>`,
      );
    case "tool": {
      const s = toolSummary(e.text);
      return row(
        "lv-tool",
        `<details data-open="1"><summary><span class="lv-name">${esc(s.name)}</span> ${s.what}<span class="lv-hint"></span></summary><pre>${esc(s.detail)}</pre></details>`,
      );
    }
    case "result": {
      const r = resultSummary(e.text);
      return row(
        "lv-tool",
        `<details><summary><span class="lv-name">result</span> ${r.hint}</summary><pre>${esc(r.detail)}</pre></details>`,
      );
    }
    case "message":
      return row(
        "lv-msg",
        `<div class="msg"><div class="who">You</div>${esc(e.text.replace(/^Owner( to [^:]+)?: /, ""))}</div>`,
      );
    default:
      return row("lv-log", `<span>${esc(e.text)}</span>`);
  }
}

/** A result joined to its call: the hint for the call's summary, the output for its details. */
export function resultJoin(e: LiveEntry): { hint: string; body: string } {
  const r = resultSummary(e.text);
  return { hint: r.hint, body: `<pre class="lv-out">${esc(r.detail)}</pre>` };
}

/** Lines in order, each result joined to the call before it. */
export function liveLinesHtml(
  entries: LiveEntry[],
  o: { showWho: boolean; name: (source: string, lane?: string | null) => string; now?: number },
): string {
  const out: string[] = [];
  let open = -1;
  for (const e of entries) {
    if (e.kind === "result" && open >= 0) {
      const j = resultJoin(e);
      out[open] = (out[open] as string)
        .replace('<span class="lv-hint"></span>', `<span class="lv-hint">${j.hint}</span>`)
        .replace("</pre></details>", `</pre>${j.body}</details>`)
        .replace('data-open="1"', "");
      open = -1;
      continue;
    }
    out.push(liveEntryHtml(e, o));
    open = e.kind === "tool" ? out.length - 1 : -1;
  }
  return out.join("");
}

/** An agent's text, escaped, as paragraphs with **bold**, `code` and line breaks. */
export function mdLite(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p>${esc(p)
          .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
          .replace(/`([^`\n]+)`/g, "<code>$1</code>")
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

/** The filters a line belongs to on a run's Live page: its lane, planner, judge, advisors, you. */
export function whoTags(e: LiveEntry): string {
  const tags = new Set<string>();
  const to = /^Owner to ([^:]+): /.exec(e.text)?.[1];
  if (e.kind === "message") {
    tags.add("you");
    if (to) {
      if (/^lane-\d+$/.test(to)) tags.add(to);
      else if (to === "planner") tags.add("planner");
      else if (["advisors", "teachers", "auditor", "panel"].includes(to)) tags.add("advisors");
      else if (to === "all") tags.add("all");
      return [...tags].join(" ");
    }
  }
  if (e.source.startsWith("trial:")) tags.add(e.lane ?? "lanes");
  else if (e.source === "planner") tags.add("planner");
  else if (e.source === "judge") tags.add("judge");
  else if (e.source === "supervisor") tags.add("advisors");
  return [...tags].join(" ");
}

/** Who a line is from on a run's Live page: its lane, the planner, the judge or the advisors. */
export const runSourceName = (source: string, lane?: string | null) =>
  source === "planner"
    ? "planner"
    : source === "judge"
      ? "judge"
      : source === "supervisor"
        ? "advisors"
        : (lane ?? "worker");

const RECIPIENT: Record<string, string> = {
  all: "everyone working",
  planner: "the planner",
  advisors: "all the advisors",
  teachers: "the teachers",
  auditor: "the auditor",
  panel: "the review panel",
};

/**
 * One line on a run's Live page: tagged with the filters it belongs to (data-who) and its source
 * (data-src, so a result joins its own call). A trial's start and end read as dividers, the
 * owner's message as "To …", and a worker receiving it as a read receipt.
 */
export function runEntryHtml(e: LiveEntry, now?: number): string {
  const who = whoTags(e);
  const tag = (html: string) =>
    html.replace(
      /^<div class="lv-row /,
      `<div data-who="${esc(who)}" data-src="${esc(e.source)}" class="lv-row `,
    );
  const lane = e.lane ?? "";
  if (e.kind === "status") {
    const start = /^(?:research )?trial on ([^:]+): ([\s\S]*)$/.exec(e.text);
    if (start)
      return `<div class="lv-div" data-who="${esc(who)}" data-src="${esc(e.source)}" data-id="${e.id}"><span><b>${esc(start[1] ?? lane)}</b> · trial started · ${esc(clip(start[2] ?? "", 180))}</span></div>`;
    const end = /^trial ended:? ?([\s\S]*)$/.exec(e.text);
    if (end)
      return `<div class="lv-div" data-who="${esc(who)}" data-src="${esc(e.source)}" data-id="${e.id}"><span><b>${esc(lane || "trial")}</b> · trial ended${end[1] ? ` · ${esc(clip(end[1], 160))}` : ""}</span></div>`;
  }
  if (e.kind === "message") {
    const to = /^Owner to ([^:]+): ([\s\S]*)$/.exec(e.text);
    if (to)
      return `<div class="lv-row lv-you" data-who="${esc(who)}" data-src="${esc(e.source)}" data-id="${e.id}">${liveTime(e.at, now)}<div class="lv-body"><div class="you"><b>To ${esc(RECIPIENT[to[1] ?? ""] ?? to[1] ?? "")}:</b> ${esc(to[2] ?? "")}</div></div></div>`;
    const read = /^Owner: ([\s\S]*)$/.exec(e.text);
    if (read)
      return `<div class="lv-row lv-read" data-who="${esc(`${who} ${lane}`.trim())}" data-src="${esc(e.source)}" data-id="${e.id}">${liveTime(e.at, now)}<div class="lv-body"><span class="muted">✓ ${esc(runSourceName(e.source, e.lane))} read your message: “${esc(clip(read[1] ?? "", 120))}”</span></div></div>`;
  }
  return tag(liveEntryHtml(e, { showWho: true, name: runSourceName, now, md: true }));
}

/** A run's lines in order, each result joined to its own source's open call. */
export function runLinesHtml(entries: LiveEntry[], now?: number): string {
  const out: string[] = [];
  const open = new Map<string, number>();
  for (const e of entries) {
    const at = open.get(e.source);
    if (e.kind === "result" && at !== undefined) {
      const j = resultJoin(e);
      out[at] = (out[at] as string)
        .replace('<span class="lv-hint"></span>', `<span class="lv-hint">${j.hint}</span>`)
        .replace("</pre></details>", `</pre>${j.body}</details>`)
        .replace('data-open="1"', "");
      open.delete(e.source);
      continue;
    }
    out.push(runEntryHtml(e, now));
    if (e.kind === "tool") open.set(e.source, out.length - 1);
    else open.delete(e.source);
  }
  return out.join("");
}
