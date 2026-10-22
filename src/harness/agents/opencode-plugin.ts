import { chmodSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Thermite's plugin for OpenCode v2 (goal 070), loaded from the agent's own OpenCode settings
 * (`~/.config/opencode/plugins/`), where Thermite links it before OpenCode starts. OpenCode 2.0.32
 * loads a plugin as a module whose default export has an `id` and a `setup(ctx)`; this one uses
 * two parts of that API:
 *
 * - the session's `compaction` hook, which runs before each compaction's model request: it keeps
 *   the session's messages since its last compaction (`ctx.session.context`, the earlier
 *   compaction's summary first) as `<n>.json` in its folder, and adds a line to the request's
 *   system parts that tells the summary where Thermite keeps the conversation;
 * - the `session.compaction.ended` event: it writes `<n>.done.json` with the summary, which is
 *   how Thermite's own code learns that the compaction was made (OpenCode's `run --format json`
 *   output does not report it).
 *
 * The folder and the line come in the environment Thermite gives OpenCode
 * (THERMITE_COMPACTION_DROPS, THERMITE_COMPACTION_LINE, with `{n}` for the number). It runs in
 * OpenCode's own process, as the agent's own user, and writes only in that folder; it reaches no
 * network. A compaction of a subagent's session (one with a parent) is OpenCode's own business and
 * is left alone. Whatever fails, the compaction goes on.
 *
 * This module imports nothing of Thermite's: OpenCode loads it alone.
 */

/** The placeholder for the compaction's number in the line. */
const NUMBER = "{n}";

/** The parts of OpenCode 2.0.32's Promise plugin context this plugin uses. */
export interface OpencodePluginContext {
  session: {
    hook(
      name: "compaction",
      callback: (event: OpencodeCompaction) => Promise<void> | void,
    ): Promise<unknown>;
    context(input: { sessionID: string }): Promise<unknown>;
    get(input: { sessionID: string }): Promise<unknown>;
  };
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> };
}

/** The `compaction` hook's event: the request before the summary prompt is added. */
export interface OpencodeCompaction {
  readonly sessionID: string;
  system: { type: string; text: string }[];
  messages: unknown[];
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Writes a file whole or not at all, readable by Thermite's own user. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

/** The next compaction's number: one after the last one seen to end. */
function nextNumber(dir: string): number {
  let last = 0;
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)\.done\.json$/.exec(f);
      if (m) last = Math.max(last, Number(m[1]));
    }
  } catch {
    last = 0;
  }
  return last + 1;
}

/** The plugin, with the environment it reads when OpenCode sets it up. */
export function compactionPlugin(env: NodeJS.ProcessEnv = process.env) {
  return {
    id: "thermite-compaction",
    setup: async (ctx: OpencodePluginContext): Promise<(() => void) | undefined> => {
      const dir = env.THERMITE_COMPACTION_DROPS;
      if (!dir) return undefined;
      const line = env.THERMITE_COMPACTION_LINE ?? "";
      try {
        mkdirSync(dir, { recursive: true, mode: 0o755 });
        chmodSync(dir, 0o755);
      } catch {
        return undefined;
      }
      // The compaction under way in each session, by number.
      const pending = new Map<string, number>();
      await ctx.session.hook("compaction", async (event) => {
        try {
          const id = event.sessionID;
          const info = obj(await ctx.session.get({ sessionID: id }).catch(() => undefined));
          if (typeof info.parentID === "string" && info.parentID) return;
          const n = nextNumber(dir);
          pending.set(id, n);
          let messages: unknown;
          try {
            const got = await ctx.session.context({ sessionID: id });
            messages = Array.isArray(got) ? got : obj(got).data;
          } catch {
            messages = undefined;
          }
          writeAtomic(
            join(dir, `${n}.json`),
            JSON.stringify({
              session: id,
              at: new Date().toISOString(),
              messages: Array.isArray(messages) ? messages : [],
            }),
          );
          if (line && Array.isArray(event.system))
            event.system.push({ type: "text", text: line.split(NUMBER).join(String(n)) });
        } catch {
          // The compaction goes on; Thermite keeps what it saw of the trial instead.
        }
      });
      const stop = new AbortController();
      void (async () => {
        try {
          for await (const raw of ctx.event.subscribe({ signal: stop.signal })) {
            const e = obj(raw);
            const data = obj(e.data);
            const id = typeof data.sessionID === "string" ? data.sessionID : "";
            const n = pending.get(id);
            if (n === undefined) continue;
            if (e.type === "session.compaction.ended") {
              pending.delete(id);
              writeAtomic(
                join(dir, `${n}.done.json`),
                JSON.stringify({
                  session: id,
                  at: new Date().toISOString(),
                  summary: typeof data.text === "string" ? data.text : "",
                }),
              );
            } else if (e.type === "session.compaction.failed") pending.delete(id);
          }
        } catch {
          // The stream ends with OpenCode.
        }
      })();
      return () => stop.abort();
    },
  };
}

export default compactionPlugin();
