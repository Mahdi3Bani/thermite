import { randomBytes } from "node:crypto";
import type { LiveLog } from "../../core/live.ts";
import type { ModelConfig } from "../agents/model.ts";
import { logStall, stallWords } from "../agents/model-stall.ts";
import type { McpCaller } from "../mcp-gateway.ts";
import type { ProviderErrorAnswer } from "../model-forward.ts";

/**
 * What the model proxy and the MCP gateway take from the service besides trials' tokens: the
 * credentials the harness mints for a check, a plan or a planner's MCP calls, and what the model
 * proxy saw of a provider: its error answers, and calls broken off because their stream went
 * silent.
 */

/** The credentials the service mints for the model proxy and the MCP gateway (it holds one). */
export class ProxyCredentials {
  /**
   * Credentials the model proxy takes besides trials' tokens: one per check or planner call, with
   * the route it reaches when that is not the workers' (a planner's own model, goal 073).
   */
  private proxyTokens = new Map<string, { until: number; model?: ModelConfig | undefined }>();

  /**
   * A credential for the model proxy that lasts `ms` (a model check or a plan in OpenCode or
   * Codex). `model`: the route its calls reach; none, the workers' route at the time of each call.
   */
  mintProxyToken(model: ModelConfig | undefined, ms: number): string {
    const now = Date.now();
    for (const [t, v] of this.proxyTokens) if (v.until < now) this.proxyTokens.delete(t);
    const token = `proxy.${randomBytes(24).toString("hex")}`;
    this.proxyTokens.set(token, { until: now + ms, ...(model ? { model } : {}) });
    return token;
  }

  proxyTokenValid(token: string): boolean {
    const v = this.proxyTokens.get(token);
    return v !== undefined && v.until >= Date.now();
  }

  /** The route a minted credential reaches, when it was minted for one; else undefined. */
  proxyTokenModel(token: string): ModelConfig | undefined {
    const v = this.proxyTokens.get(token);
    return v && v.until >= Date.now() ? v.model : undefined;
  }

  /** Credentials the MCP gateway takes besides trials' tokens: the planner's, one per plan. */
  private mcpTokens = new Map<string, { caller: McpCaller; until: number }>();

  /** A credential for the MCP gateway, bound to one run and kind of agent, that lasts `ms`. */
  mintMcpToken(caller: McpCaller, ms: number): string {
    const now = Date.now();
    for (const [t, v] of this.mcpTokens) if (v.until < now) this.mcpTokens.delete(t);
    const token = `mcp.${randomBytes(24).toString("hex")}`;
    this.mcpTokens.set(token, { caller, until: now + ms });
    return token;
  }

  /** Who a gateway credential is for, while it lasts. */
  mcpTokenCaller(token: string): McpCaller | undefined {
    const v = this.mcpTokens.get(token);
    return v && v.until >= Date.now() ? v.caller : undefined;
  }
}

/** The newest error answer the model proxy saw for each trial (or "proxy"): goal 079. */
export class ProviderAnswers {
  private readonly providerAnswers = new Map<string, ProviderErrorAnswer & { at: number }>();

  /** The model proxy saw a provider's error answer for a trial (or a check or a plan). */
  noteProviderAnswer(who: string, a: ProviderErrorAnswer, now: number): void {
    this.providerAnswers.delete(who);
    this.providerAnswers.set(who, { ...a, at: now });
    // The newest few hundred: a trial reads its own soon after its program stops.
    for (const k of this.providerAnswers.keys()) {
      if (this.providerAnswers.size <= 256) break;
      this.providerAnswers.delete(k);
    }
  }

  /** The newest error answer the proxy saw for a trial, if it came at or after `since` (ms). */
  providerAnswerSince(who: string, since: number): ProviderErrorAnswer | undefined {
    const a = this.providerAnswers.get(who);
    return a && a.at >= since ? { status: a.status, headers: a.headers, body: a.body } : undefined;
  }
}

/**
 * The model proxy broke a call off because its stream went silent (goal 079): the log says so,
 * and a trial's Live. The trial's program then sees a broken connection or a 504, and the
 * proxy's answer for it (noteProviderAnswer) makes it the provider's `server` error.
 */
export function noteModelStall(
  live: LiveLog,
  trial: { id: string; run: string; lane: string } | undefined,
  ms: number,
): void {
  logStall(ms, trial ? { trial: trial.id, run: trial.run, via: "model proxy" } : {});
  if (trial)
    live.append({
      source: `trial:${trial.id}`,
      kind: "status",
      text: `${stallWords(ms)}: retried. The harness broke the call off; the trial goes on in the same session.`,
      lane: trial.lane,
      run: trial.run,
    });
}
