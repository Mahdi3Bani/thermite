import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { type ModelConfig, reasoningFromEnv } from "./model.ts";

/** A model route as control hands it to the rig (through its supervisor), key included. */
export const ControlRoute = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  version: z.number().int().min(1),
  base_url: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https?:\/\//.test(u), "an http or https URL"),
  model: z.string().min(1).max(200),
  context_window: z.number().int().min(0).max(100_000_000),
  max_tokens: z.number().int().min(0).max(10_000_000),
  reasoning: z.enum(["none", "low", "medium", "high"]).nullable(),
  key_hint: z.string().max(16),
  /** Changes whenever anything about the route does (control's digest of it). */
  revision: z.string().regex(/^[0-9a-f]{8,64}$/),
  api_key: z.string().min(1).max(4096),
});
export type ControlRoute = z.infer<typeof ControlRoute>;

/** Which route the agents use, as the rig reports it (never the key). */
export interface ModelInfo {
  source: "control" | "environment" | "none";
  name?: string | undefined;
  version?: number | undefined;
  revision?: string | undefined;
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
  }

  current(): ModelConfig | undefined {
    const r = this.route;
    if (!r) return this.fromEnv;
    return {
      baseUrl: r.base_url.replace(/\/$/, ""),
      model: r.model,
      apiKey: r.api_key,
      contextWindow: r.context_window,
      maxTokens: r.max_tokens || 8192,
      reasoning: reasoningFromEnv(r.reasoning ?? undefined),
    };
  }

  info(): ModelInfo {
    const r = this.route;
    if (r)
      return {
        source: "control",
        name: r.name,
        version: r.version,
        revision: r.revision,
        model: r.model,
        base_url: r.base_url,
        key_hint: r.key_hint,
      };
    return this.fromEnv
      ? { source: "environment", model: this.fromEnv.model, base_url: this.fromEnv.baseUrl }
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
