import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorText } from "../../../common/errors.ts";
import { readRunpod } from "../../runpod.ts";
import type { ProviderType } from "../../store.ts";
import type { Dashboard } from "../context.ts";

/** A name as the owner typed it, made to fit the rule: lowercase, with dashes for spaces. */
export const newName = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
export const TYPES: Record<ProviderType, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
  opencode: "OpenCode",
  claude: "Claude subscription",
  chatgpt: "ChatGPT subscription",
};
/** How a provider's models show in the model lists: a subscription's with its program. */
export const modelPrefix = (type: ProviderType) =>
  type === "claude" ? "claude-code:" : type === "chatgpt" ? "chatgpt:" : "";
export const settingsUrl = (k: "ok" | "error", m: string) =>
  `/ui/settings?${k}=${encodeURIComponent(m)}`;
export const machineUrl = (k: "ok" | "error", m: string) => settingsUrl(k, m);
export const usd = (n: number | null) => (n === null ? "–" : `$${n.toFixed(2)}`);

/**
 * What the settings' forms and other pages share: Git access for control's own lookups (a new
 * campaign's too), and a check of a GPU cloud's account (a RunPod launch's too).
 */
export function settingsHelpers(dash: Dashboard) {
  const { opts, store } = dash;
  /** Git access for control's own lookups: the secret unsealed, host keys pinned per access. */
  const accessFor = (name: string | undefined) => {
    if (!name) return undefined;
    const g = store.gitAccess.get(name);
    if (!g) throw new Error(`no Git access named ${name}`);
    const secret = opts.secrets.open(g.secret_sealed);
    return {
      auth:
        g.kind === "ssh"
          ? ({ kind: "ssh", privateKey: secret } as const)
          : ({ kind: "token", token: secret, username: g.username ?? undefined } as const),
      knownHostsFile: join(opts.kits?.dir ?? tmpdir(), "..", "known_hosts", name),
    };
  };

  /** Reads a GPU cloud's account now with its key, and keeps what it found or why it could not. */
  const checkCloudNow = async (name: string): Promise<string | null> => {
    const g = store.gpuClouds.get(name);
    if (!g) return "no such GPU cloud";
    let key: string;
    try {
      key = opts.secrets.open(g.key_sealed);
    } catch {
      store.gpuClouds.setFacts(name, { error: "its key cannot be opened: enter it again" });
      return "its key cannot be opened: enter it again";
    }
    try {
      store.gpuClouds.setFacts(name, { facts: await readRunpod(key, opts.cloudFetch) });
      return null;
    } catch (err) {
      const why = errorText(err);
      store.gpuClouds.setFacts(name, { error: why });
      return why;
    }
  };
  return { accessFor, checkCloudNow };
}
