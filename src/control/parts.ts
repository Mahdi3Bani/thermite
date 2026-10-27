import type { BuildInfo } from "../core/version.ts";
import { ChatGPTLogins } from "./chatgpt.ts";
import type { KitRepos } from "./kit-repos.ts";
import { RunpodDriver } from "./lifecycle.ts";
import { McpServers } from "./mcp-servers.ts";
import { PlanUsageReader } from "./plan-usage.ts";
import { RunpodRigs } from "./runpod-rigs.ts";
import { RunpodTests } from "./runpod-tests.ts";
import { SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store.ts";
import { ControlTunnels } from "./tunnel.ts";
import { type RigView, rigView } from "./views.ts";

/**
 * What control is made of, built once in createControlApi (goal 125, T5): the dashboard, REST
 * and MCP each call the same operations on it (agent-models.ts, start-run.ts and the like), so
 * each has one set of checks and one set of refusals in words.
 */
export interface ControlParts {
  store: ControlStore;
  /** Control's signing key: every command it sends a rig is signed with it. */
  privateKeyPem: string;
  /** Seals every key and sign-in control stores. */
  secrets: SecretBox;
  /** The kits control keeps (New campaign, Start a run); none: it keeps none. */
  kits?: KitRepos | undefined;
  /** ChatGPT subscriptions' logins: control alone renews them (the dashboard signs them in). */
  chatgpt: ChatGPTLogins;
  /** Subscriptions' usage windows (goal 151), on Providers and over MCP. */
  planUsage: PlanUsageReader;
  /** Test pods on GPU clouds. */
  runpodTests: RunpodTests;
  /** MCP servers for the agents (goal 068). */
  mcpServers: McpServers;
  /** Control's end of the tunnels of rigs in pull mode. */
  tunnels: ControlTunnels;
  /** Rigs the owner launches on RunPod: a stopped pod is started before its run is assigned. */
  runpodRigs: RunpodRigs;
  /** Their stop, start, restart and terminate, beside the driver THERMITE_LIFECYCLE names. */
  runpodDriver: RunpodDriver;
  /** Every rig as control sees it now (views.ts). */
  views(): RigView[];
}

/** What controlParts takes from control's options; tests give their own of each. */
export interface PartsOptions {
  staleAfterMs: number;
  secrets?: SecretBox | undefined;
  kits?: KitRepos | undefined;
  providerFetch?: typeof fetch | undefined;
  cloudFetch?: typeof fetch | undefined;
  runpodTests?: RunpodTests | undefined;
  runpodTestImage?: string | undefined;
  mcpServers?: McpServers | undefined;
  tunnels?: ControlTunnels | undefined;
  runpodRigs?: RunpodRigs | undefined;
  runpodRigImage?: string | undefined;
}

/** Control's parts, made from the store, its key and its options. */
export function controlParts(
  store: ControlStore,
  privateKeyPem: string,
  opts: PartsOptions,
  viewOpts: { staleAfterMs: number; offlineAfterMs?: number | undefined; control: BuildInfo },
): ControlParts {
  const secrets = opts.secrets ?? SecretBox.ephemeral();
  const chatgpt = new ChatGPTLogins(store, secrets, opts.providerFetch);
  const runpodTests =
    opts.runpodTests ??
    new RunpodTests(store, secrets, { fetch: opts.cloudFetch, image: opts.runpodTestImage });
  // MCP servers: made first, so an older control's outside knowledge bases become servers now.
  const mcpServers = opts.mcpServers ?? new McpServers(store, secrets);
  // A rig in pull mode makes the same calls as any rig; control's end of the tunnel brings them
  // in-process, bound to the rig whose signed answer carried them.
  const tunnels = opts.tunnels ?? new ControlTunnels(store, secrets, privateKeyPem);
  const runpodRigs =
    opts.runpodRigs ??
    new RunpodRigs(store, secrets, tunnels, {
      fetch: opts.cloudFetch,
      image: opts.runpodRigImage,
      staleAfterMs: opts.staleAfterMs,
      privateKeyPem,
    });
  return {
    store,
    privateKeyPem,
    secrets,
    kits: opts.kits,
    chatgpt,
    planUsage: new PlanUsageReader(store, (p) => chatgpt.usage(p)),
    runpodTests,
    mcpServers,
    tunnels,
    runpodRigs,
    runpodDriver: new RunpodDriver(runpodRigs),
    views: () =>
      store
        .rigs()
        .map((u) => rigView(store, u.id, viewOpts))
        .filter((v): v is RigView => v !== undefined),
  };
}
