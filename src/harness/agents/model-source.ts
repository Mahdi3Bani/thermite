import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { EFFORTS, HARNESSES, PROVIDER_TYPES } from "../../core/agents.ts";
import { COMPACT_AT_MAX, COMPACT_AT_MIN } from "../../core/compaction.ts";
import { codexReaches, type ModelConfig, reasoningFromEnv } from "./model.ts";

/** A model route as control hands it to the rig (through its supervisor), key included. */
export const ControlRoute = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    /** The provider's API (the first version's routes had none: OpenAI-compatible). */
    type: z.enum(PROVIDER_TYPES).default("openai"),
    /** The harness the agents run in (the first versions' routes had none: Pi). */
    harness: z.enum(HARNESSES).default("pi"),
    version: z.number().int().min(1),
    base_url: z
      .string()
      .url()
      .max(500)
      .refine((u) => /^https?:\/\//.test(u), "an http or https URL"),
    model: z.string().min(1).max(200),
    context_window: z.number().int().min(0).max(100_000_000),
    /**
     * The compaction point the owner set with the model (goal 070), in percent of the window;
     * left out when none is set (the harness's default applies).
     */
    compact_at: z.number().int().min(COMPACT_AT_MIN).max(COMPACT_AT_MAX).optional(),
    max_tokens: z.number().int().min(0).max(10_000_000),
    reasoning: z.enum(["none", "low", "medium", "high"]).nullable(),
    /** Claude Code's effort level (a Claude subscription's route only). */
    effort: z.enum(EFFORTS).nullable().optional(),
    key_hint: z.string().max(16),
    /** Changes whenever anything about the route does (control's digest of it). */
    revision: z.string().regex(/^[0-9a-f]{8,64}$/),
    /**
     * OpenCode's own free models need none: an empty key. A Claude subscription: its token. A
     * ChatGPT sign-in: a one-hour access token, renewed by control (a new revision each time).
     */
    api_key: z.string().max(4096),
  })
  .refine((r) => (r.type === "claude") === (r.harness === "claude-code"), {
    message: "a Claude subscription runs only in Claude Code, and Claude Code only on one",
  })
  .refine((r) => r.harness !== "codex" || codexReaches(r.type), {
    message:
      "the Codex CLI speaks only OpenAI's Responses API: a ChatGPT sign-in or an OpenAI route",
  });
export type ControlRoute = z.input<typeof ControlRoute>;

/** Which route the agents use, as the rig reports it (never the key). */
export interface ModelInfo {
  source: "control" | "environment" | "none";
  name?: string | undefined;
  version?: number | undefined;
  revision?: string | undefined;
  /** The harness the agents run in. */
  harness?: "pi" | "opencode" | "claude-code" | "codex" | undefined;
  model?: string | undefined;
  base_url?: string | undefined;
  key_hint?: string | undefined;
}

/**
 * Where the agents' model route comes from: the route control set for this rig, kept in a file
 * only root (the harness's controller) reads, or else the rig's own settings (its environment).
 * Every plan and trial takes the route current when it starts.
 */
export class ModelSource {
  private route: ControlRoute | undefined;
  private plannerRoute: ControlRoute | undefined;
  private readonly file: string;
  private readonly fromEnv: ModelConfig | undefined;

  constructor(file: string, fromEnv: ModelConfig | undefined) {
    this.file = file;
    this.fromEnv = fromEnv;
    if (existsSync(file)) {
      try {
        this.route = ControlRoute.parse(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        // A broken file is dropped: the supervisor hands the route again on its next round.
        rmSync(file, { force: true });
      }
    }
    const plannerFile = file.replace(/\.json$/, "-planner.json");
    if (existsSync(plannerFile)) {
      try {
        this.plannerRoute = ControlRoute.parse(JSON.parse(readFileSync(plannerFile, "utf8")));
      } catch {
        rmSync(plannerFile, { force: true });
      }
    }
  }

  current(): ModelConfig | undefined {
    const r = this.route;
    if (!r) return this.fromEnv;
    return this.configOf(r, () => this.route);
  }

  /** The planner's own route, when control gave the planner a model; else the workers'. */
  planner(): ModelConfig | undefined {
    const r = this.plannerRoute;
    return r ? this.configOf(r, () => this.plannerRoute) : undefined;
  }

  /**
   * A route as the agents' configuration. A ChatGPT sign-in's token is renewed under the same
   * route: a call reads the newest one, so a long trial or plan outlives the hour of its first.
   */
  private configOf(r: ControlRoute, now: () => ControlRoute | undefined): ModelConfig {
    const type = r.type ?? "openai";
    return {
      api: type === "openai" ? undefined : type,
      harness:
        r.harness === "opencode" || r.harness === "claude-code" || r.harness === "codex"
          ? r.harness
          : undefined,
      provider: r.name,
      baseUrl: r.base_url.replace(/\/$/, ""),
      model: r.model,
      apiKey: r.api_key,
      contextWindow: r.context_window,
      ...(r.compact_at !== undefined ? { compactAt: r.compact_at } : {}),
      // The model's maximum output from the provider's list; 0: none sent (goal 079).
      maxTokens: r.max_tokens,
      reasoning: reasoningFromEnv(r.reasoning ?? undefined),
      effort: r.effort ?? undefined,
      ...(type === "chatgpt"
        ? {
            keyNow: () => {
              const n = now();
              return n && n.name === r.name && n.type === "chatgpt" ? n.api_key : r.api_key;
            },
          }
        : {}),
    };
  }

  /** The planner's route's revision (none: the planner follows the workers' route). */
  plannerRevision(): string | null {
    return this.plannerRoute?.revision ?? null;
  }

  /** Takes or (null) clears the planner's own route; kept like the workers' route. */
  setPlanner(route: ControlRoute | null): void {
    const file = this.file.replace(/\.json$/, "-planner.json");
    if (!route) {
      rmSync(file, { force: true });
      this.plannerRoute = undefined;
      return;
    }
    const r = ControlRoute.parse(route);
    writeFileSync(`${file}.tmp`, JSON.stringify(r), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.plannerRoute = r;
  }

  info(): ModelInfo {
    const r = this.route;
    if (r)
      return {
        source: "control",
        name: r.name,
        version: r.version,
        revision: r.revision,
        harness: r.harness ?? "pi",
        model: r.model,
        base_url: r.base_url,
        key_hint: r.key_hint,
      };
    return this.fromEnv
      ? {
          source: "environment",
          model: this.fromEnv.model,
          base_url: this.fromEnv.baseUrl,
          harness: this.fromEnv.harness ?? "pi",
        }
      : { source: "none" };
  }

  /** Takes control's route; written 0600 and renamed into place, so a crash leaves the old one. */
  set(route: ControlRoute): void {
    const r = ControlRoute.parse(route);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.route = r;
  }

  /** Back to the rig's own settings. */
  clear(): void {
    rmSync(this.file, { force: true });
    this.route = undefined;
  }
}
