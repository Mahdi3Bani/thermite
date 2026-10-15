import type { Agent } from "@earendil-works/pi-agent-core";
import { type LiveKind, summarizeArgs } from "../../core/live.ts";

/**
 * Links an agent session to control's live view: its turns go to the live log, and the owner's
 * messages (message_agent) come back in as user turns, injected after the current turn. Both are
 * best effort: a failing link never stops the session.
 */
export interface SessionLink {
  live?: ((entries: { kind: LiveKind; text: string }[]) => Promise<unknown>) | undefined;
  messages?: (() => Promise<string[]>) | undefined;
}

type Block = { type?: string; text?: string; thinking?: string };

function textOf(content: unknown, type: "text" | "thinking"): string {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b.type === type)
    .map((b) => (type === "text" ? b.text : b.thinking) ?? "")
    .join("\n")
    .trim();
}

function resultText(result: unknown): string {
  const r = result as { content?: unknown } | undefined;
  const t = textOf(r?.content, "text");
  return t || summarizeArgs(result, 600);
}

export function linkSession(agent: Agent, link: SessionLink): void {
  const send = (kind: LiveKind, text: string) => {
    if (!link.live || !text) return;
    link.live([{ kind, text }]).catch(() => undefined);
  };
  agent.subscribe(async (event) => {
    switch (event.type) {
      case "message_end": {
        const m = event.message as { role?: string; content?: unknown };
        if (m.role !== "assistant") break;
        const thinking = textOf(m.content, "thinking");
        if (thinking) send("thinking", thinking.slice(0, 2000));
        send("text", textOf(m.content, "text"));
        break;
      }
      case "tool_execution_start":
        send("tool", `${event.toolName} ${summarizeArgs(event.args)}`);
        break;
      case "tool_execution_end":
        send(
          "result",
          `${event.toolName}${event.isError ? " failed" : ""}${event.durationMs !== undefined ? ` (${Math.round(event.durationMs)} ms)` : ""}: ${resultText(event.result).slice(0, 1200)}`,
        );
        break;
      case "turn_end": {
        if (!link.messages) break;
        let msgs: string[] = [];
        try {
          msgs = await link.messages();
        } catch {
          break;
        }
        for (const text of msgs) {
          send("message", `Owner: ${text}`);
          agent.steer({
            role: "user",
            content: `A message from the campaign's owner, who is watching this session:\n\n${text}`,
            timestamp: Date.now(),
          });
        }
        break;
      }
    }
  });
}
