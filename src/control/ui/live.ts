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
  o: { showWho: boolean; name: (source: string, lane?: string | null) => string; now?: number },
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
      return row("lv-text", `<div class="lv-said">${esc(e.text)}</div>`);
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
