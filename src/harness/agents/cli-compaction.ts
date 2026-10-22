import { COMPACT_AT_DEFAULT } from "../../core/compaction.ts";
import type { LiveKind } from "../../core/live.ts";
import { fenced } from "./cli-conversation.ts";
import { SUMMARY_SYSTEM } from "./compaction.ts";
import type { ModelConfig } from "./model.ts";

/**
 * Compaction in OpenCode v2, the Codex CLI and Claude Code (goal 070). Each compacts its own
 * conversation; Thermite sets the window (the route's, so the owner's cap) and the compaction
 * point in each one's own settings, as far as each one takes them (opencode.ts, codex.ts,
 * claude-code.ts).
 *
 * Before each compaction, the whole conversation is kept where the agent can read it and the run
 * keeps it, and the summary names it, with what each program offers: Claude Code's PreCompact
 * hook copies its transcript and adds a line to the compaction's instructions
 * (compaction-hook.ts); OpenCode's compaction hook, in Thermite's plugin, saves the session and
 * adds the line to the compaction's request (opencode-plugin.ts); Codex's compaction prompt,
 * which Thermite sets, names the folder, and its rollout holds the conversation. When the program
 * reports the compaction, Thermite's own code makes that conversation Markdown
 * (cli-conversation.ts) and the harness keeps and records it as Pi's are. Where the program's own
 * conversation cannot be read, the conversation as Thermite saw it is kept instead: the trial's
 * live entries up to that point.
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
  /** The conversation before it, as Markdown: the program's own, else as Thermite saw it. */
  markdown: string;
  /** Whether `markdown` is the program's own conversation (else the live entries). */
  own: boolean;
  /** The summary the program went on from, when Thermite could read it. */
  summary?: string | undefined;
}

export type OnCompacted = (c: CliCompacted) => void;

/** The program's own conversation before compaction `n`, and its summary when known. */
export type OwnConversation = (
  n: number,
) => { markdown: string; summary?: string | undefined } | undefined;

/**
 * Where a CLI agent's conversation is kept before each of its compactions (goal 070), set before
 * the agent starts, so its own summary can name it.
 */
export interface KeptAt {
  /** The folder: its path as the agent sees it, or (`place`) within that place. */
  dir: string;
  /** The file names' stem: the kept file for compaction n is `<dir>/<stem>-<n>.md`. */
  stem: string;
  /** Whether the agent can read the file (a worker can; the planner and the advisors cannot). */
  readable: boolean;
  /** Where `dir` is, in words, when it is not a path the agent sees ("the supervisor's records"). */
  place?: string | undefined;
}

/**
 * A one-prompt call's compactions (a planner call, goal 070): where the conversation is kept,
 * the document's title, and who keeps and records each compaction the call reports.
 */
export interface OnceKeeping {
  keptAt: KeptAt;
  title: string;
  compacted: OnCompacted;
}

/**
 * Takes a one-prompt call's folder back for the controller, to read what the call's program left
 * there (its hook's or plugin's copies, its rollout). Best effort: what cannot be read is kept as
 * Thermite saw it.
 */
export async function reclaim(
  runner: { reclaim?: ((path: string) => Promise<void>) | undefined },
  dir: string,
): Promise<void> {
  if (typeof runner.reclaim === "function") await runner.reclaim(dir).catch(() => undefined);
}

/** The placeholder for the compaction's number, in the line a hook or plugin adds. */
export const NUMBER = "{n}";

/** The kept file of compaction `n` (`{n}`: the placeholder), as the agent sees it. */
export const keptFile = (at: KeptAt, n: number | string): string =>
  `${at.dir.replace(/\/+$/, "")}/${at.stem}-${n}.md`;

/**
 * The line Claude Code's hook and OpenCode's plugin add to a compaction's instructions, with
 * `{n}` for its number: where Thermite keeps the conversation, for the summary to name.
 */
export function keptLine(at: KeptAt): string {
  const file = `${keptFile(at, NUMBER)}${at.place ? ` (${at.place})` : ""}`;
  return at.readable
    ? `Thermite keeps the whole conversation before this compaction in ${file}. Name that file in your summary, and say that the agent can read it there for any detail the summary leaves out.`
    : `Thermite keeps the whole conversation before this compaction in ${file}. Name that file in your summary, as where the conversation is kept.`;
}

/**
 * Codex's compaction prompt (its `compact_prompt`): Thermite's own summary prompt, which Pi's
 * compactions use too, with where the conversation is kept. Codex reads it when it starts, so it
 * cannot know the compaction's number: it names the folder and the file names.
 */
export function codexCompactPrompt(at: KeptAt): string {
  const dir = at.dir.replace(/\/+$/, "");
  return `${SUMMARY_SYSTEM}

Thermite keeps the whole conversation before this point in ${dir}/${at.place ? ` (${at.place})` : ""}, as the newest file named ${at.stem}-<number>.md (the number counts this conversation's compactions from 1). Name that file in your summary${at.readable ? ", and say that the agent can read it there for any detail the summary leaves out" : ", as where the conversation is kept"}.`;
}

/** The compaction point in tokens, for a route with a known window; undefined without one. */
export function compactionTokens(m: Pick<ModelConfig, "contextWindow" | "compactAt">) {
  return m.contextWindow > 0
    ? Math.floor((m.contextWindow * (m.compactAt ?? COMPACT_AT_DEFAULT)) / 100)
    : undefined;
}

/**
 * A CLI trial's conversation as Thermite sees it (its live entries, in order), and the
 * compactions its harness reports in it, each with the program's own conversation when it can be
 * read (`own`).
 */
export class CliCompactions {
  /** Compactions so far in this trial. */
  count = 0;
  private readonly seen: { kind: LiveKind; text: string }[] = [];
  private readonly title: string;
  private readonly harness: string;
  private readonly on: OnCompacted | undefined;
  private readonly own: OwnConversation | undefined;

  constructor(o: {
    title: string;
    harness: string;
    on?: OnCompacted | undefined;
    own?: OwnConversation | undefined;
  }) {
    this.title = o.title;
    this.harness = o.harness;
    this.on = o.on;
    this.own = o.own;
  }

  /** One read's live entries, with the compactions found among them (in order). */
  take(live: { kind: LiveKind; text: string }[], found: FoundCompaction[]): void {
    let from = 0;
    for (const f of found) {
      const at = Math.min(Math.max(f.at, from), live.length);
      this.seen.push(...live.slice(from, at));
      from = at;
      this.count++;
      let own: ReturnType<OwnConversation>;
      try {
        own = this.own?.(this.count);
      } catch {
        own = undefined;
      }
      this.on?.({
        number: this.count,
        tokensBefore: f.tokensBefore,
        tokensAfter: f.tokensAfter,
        markdown: own?.markdown ?? this.markdown(this.count),
        own: own !== undefined,
        ...(own?.summary ? { summary: own.summary } : {}),
      });
    }
    this.seen.push(...live.slice(from));
  }

  /** The conversation so far as Markdown: every line Thermite showed of it, in order. */
  markdown(n: number): string {
    const out = [
      `# ${this.title}: the conversation before compaction ${n}, as Thermite saw it`,
      "",
      `Kept by the harness at ${new Date().toISOString()}. ${this.harness} keeps its own conversation, which Thermite could not read here; this is every line of it the live view showed, in order (long ones cut there).`,
    ];
    this.seen.forEach((e, i) => {
      out.push("", `## ${i + 1}. ${e.kind}`, "", fenced(e.text));
    });
    return `${out.join("\n")}\n`;
  }
}
