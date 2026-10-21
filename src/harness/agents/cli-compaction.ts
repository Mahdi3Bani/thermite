import { COMPACT_AT_DEFAULT } from "../../core/compaction.ts";
import type { LiveKind } from "../../core/live.ts";
import type { ModelConfig } from "./model.ts";

/**
 * Compaction in OpenCode v2, the Codex CLI and Claude Code (goal 070). Each compacts its own
 * conversation; Thermite sets the window (the route's, so the owner's cap) and the compaction
 * point in each one's own settings, as far as each one takes them (opencode.ts, codex.ts,
 * claude-code.ts). Where a harness reports a compaction in its event stream, its trial records it
 * as Pi's are recorded, with the conversation as Thermite saw it: the trial's live entries up to
 * that point.
 */

/** A compaction found in a harness's event stream: where it came in its lines, and its tokens. */
export interface FoundCompaction {
  /** How many of the read's live entries came before it. */
  at: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
}

/** A compaction a harness made, as its trial hands it to Thermite. */
export interface CliCompacted {
  number: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
  /** The conversation as Thermite saw it until then: the trial's live entries, as Markdown. */
  markdown: string;
}

export type OnCompacted = (c: CliCompacted) => void;

/** The compaction point in tokens, for a route with a known window; undefined without one. */
export function compactionTokens(m: Pick<ModelConfig, "contextWindow" | "compactAt">) {
  return m.contextWindow > 0
    ? Math.floor((m.contextWindow * (m.compactAt ?? COMPACT_AT_DEFAULT)) / 100)
    : undefined;
}

/** A fence for a block of text: longer than any run of backticks inside it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * A CLI trial's conversation as Thermite sees it (its live entries, in order), and the
 * compactions its harness reports in it.
 */
export class CliCompactions {
  /** Compactions so far in this trial. */
  count = 0;
  private readonly seen: { kind: LiveKind; text: string }[] = [];
  private readonly title: string;
  private readonly harness: string;
  private readonly on: OnCompacted | undefined;

  constructor(o: { title: string; harness: string; on?: OnCompacted | undefined }) {
    this.title = o.title;
    this.harness = o.harness;
    this.on = o.on;
  }

  /** One read's live entries, with the compactions found among them (in order). */
  take(live: { kind: LiveKind; text: string }[], found: FoundCompaction[]): void {
    let from = 0;
    for (const f of found) {
      const at = Math.min(Math.max(f.at, from), live.length);
      this.seen.push(...live.slice(from, at));
      from = at;
      this.count++;
      this.on?.({
        number: this.count,
        tokensBefore: f.tokensBefore,
        tokensAfter: f.tokensAfter,
        markdown: this.markdown(this.count),
      });
    }
    this.seen.push(...live.slice(from));
  }

  /** The conversation so far as Markdown: every line Thermite showed of it, in order. */
  markdown(n: number): string {
    const out = [
      `# ${this.title}: the conversation before compaction ${n}, as Thermite saw it`,
      "",
      `Kept by the harness at ${new Date().toISOString()}. ${this.harness} keeps its own conversation; this is every line of it the live view showed, in order (long ones cut there).`,
    ];
    this.seen.forEach((e, i) => {
      out.push("", `## ${i + 1}. ${e.kind}`, "", fenced(e.text));
    });
    return `${out.join("\n")}\n`;
  }
}
