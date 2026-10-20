import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { log, optionalSecretFromFile, parseListen } from "../common/env.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { buildInfo } from "../core/version.ts";
import { createControlApi } from "./api.ts";
import { Credential } from "./credential.ts";
import { KitRepos } from "./kit-repos.ts";
import { advanceResets, driverFromEnv } from "./lifecycle.ts";
import { OutsideKbs } from "./outside-kb.ts";
import { refreshGpuClouds } from "./runpod.ts";
import { RunpodTests } from "./runpod-tests.ts";
import { SecretBox } from "./secrets.ts";
import { ControlStore } from "./store.ts";
import { ControlTunnels } from "./tunnel.ts";

/** Control service entry point. Generates its signing key on first start. */
async function main(): Promise<void> {
  const env = process.env;
  const dir = env.THERMITE_CONTROL_DIR ?? "/var/lib/thermite-control";
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "control-signing.key");
  const pubPath = join(dir, "control-signing.pub");
  if (!existsSync(keyPath)) {
    const keys = generateSigningKeys();
    writeFileSync(keyPath, keys.privateKeyPem, { mode: 0o600 });
    writeFileSync(pubPath, keys.publicKeyPem, { mode: 0o644 });
    log("control", "generated signing key");
  }
  chmodSync(keyPath, 0o600);
  const privateKeyPem = readFileSync(keyPath, "utf8");
  const publicKeyPem = readFileSync(pubPath, "utf8");
  if (env.THERMITE_CONTROL_PUBKEY_EXPORT) {
    mkdirSync(dirname(env.THERMITE_CONTROL_PUBKEY_EXPORT), { recursive: true });
    writeFileSync(env.THERMITE_CONTROL_PUBKEY_EXPORT, publicKeyPem, { mode: 0o644 });
  }
  // Each credential is the token's SHA-256 (THERMITE_CONTROL_<ROLE>_TOKEN_SHA256), so control's
  // machine holds nothing that signs in, or for local development a token file
  // (THERMITE_CONTROL_<ROLE>_TOKEN_FILE). The owner's is required.
  const credential = (role: string): Credential | undefined => {
    const hash = env[`THERMITE_CONTROL_${role}_TOKEN_SHA256`];
    const file = env[`THERMITE_CONTROL_${role}_TOKEN_FILE`];
    if (hash && file)
      throw new Error(`set THERMITE_CONTROL_${role}_TOKEN_SHA256 or _FILE, not both`);
    if (hash) return Credential.ofHash(hash);
    const token = file ? optionalSecretFromFile(`THERMITE_CONTROL_${role}_TOKEN_FILE`) : undefined;
    return token ? Credential.ofToken(token) : undefined;
  };
  const admin = credential("ADMIN");
  if (!admin) {
    throw new Error(
      "control needs the owner's credential: THERMITE_CONTROL_ADMIN_TOKEN_SHA256 (from `thermite token new`) or THERMITE_CONTROL_ADMIN_TOKEN_FILE",
    );
  }
  const tokens = {
    admin,
    operator: credential("OPERATOR"),
    agent: credential("AGENT"),
    read: credential("READ"),
    // Optional: rigs whose tokens are set in a file ({"<rig>": "<token>"}). Rigs enrolled through
    // control (`thermite rig add`) need no entry and no restart.
    rigs: env.THERMITE_CONTROL_RIG_TOKENS_FILE
      ? (JSON.parse(readFileSync(env.THERMITE_CONTROL_RIG_TOKENS_FILE, "utf8")) as Record<
          string,
          string
        >)
      : {},
  };
  const store = new ControlStore(join(dir, "control.db"));
  const { host, port } = parseListen(env.THERMITE_CONTROL_LISTEN ?? "0.0.0.0:8800");
  // A rig is stale after 3 missed reports (the supervisor reports every 60 s by default).
  const staleAfterMs = Number(env.THERMITE_CONTROL_STALE_SECONDS ?? "180") * 1000;
  // Offline after 15 minutes without a report (never before it is stale).
  const offlineAfterMs = Number(env.THERMITE_CONTROL_OFFLINE_SECONDS ?? "900") * 1000;
  const driver = driverFromEnv(env);
  // The key that seals model routes' API keys: its own file, made on first use. Mount it
  // from a separate secret to keep it off the database's volume.
  const secrets = SecretBox.fromFile(
    env.THERMITE_CONTROL_SECRETS_KEY_FILE ?? join(dir, "secrets.key"),
  );
  // Test pods on GPU clouds, advanced by the loop below.
  const runpodTests = new RunpodTests(store, secrets, {
    image: env.THERMITE_RUNPOD_TEST_IMAGE || undefined,
  });
  // Outside knowledge bases (optional): copies of campaign folders, synced by the loop below.
  const outsideKb = new OutsideKbs(store, store.kb(), secrets);
  // Rigs in pull mode (on RunPod): control connects to each, in the loop below.
  const tunnels = new ControlTunnels(store, secrets, privateKeyPem);
  const server = serve({
    fetch: createControlApi(store, tokens, privateKeyPem, {
      staleAfterMs,
      offlineAfterMs,
      driver,
      // Optional: the owner accepts each rig's first report key (no trust on first use).
      requireKeyAcceptance: env.THERMITE_CONTROL_REQUIRE_KEY_ACCEPT === "1",
      sessionDays: env.THERMITE_CONTROL_SESSION_DAYS
        ? Number(env.THERMITE_CONTROL_SESSION_DAYS)
        : undefined,
      secrets,
      runpodTests,
      outsideKb,
      tunnels,
      // Kits written on the new-campaign page, kept as git repositories in control's state.
      kits: new KitRepos(join(dir, "kits")),
      // How rigs and the machines control sets rigs up on reach control.
      publicUrl: env.THERMITE_CONTROL_PUBLIC_URL || undefined,
      // The images rigs on machines run (none: control can't set rigs up there).
      rigImages:
        env.THERMITE_RIG_HARNESS_IMAGE && env.THERMITE_RIG_SUPERVISOR_IMAGE
          ? {
              harness: env.THERMITE_RIG_HARNESS_IMAGE,
              harnessCuda: env.THERMITE_RIG_HARNESS_CUDA_IMAGE || undefined,
              supervisor: env.THERMITE_RIG_SUPERVISOR_IMAGE,
            }
          : undefined,
    }).fetch,
    hostname: host,
    port,
  });
  log("control", "listening", {
    host,
    port,
    build: buildInfo(),
    rigs: Object.keys(tokens.rigs),
    enrolled: store
      .enrolledRigs()
      .filter((r) => !r.retired_at)
      .map((r) => r.rig),
    lifecycle: driver?.kind ?? null,
  });
  // Full resets advance as their evidence arrives.
  const resets = setInterval(() => {
    advanceResets({ store, privateKeyPem, driver, staleAfterMs }).catch((err) =>
      log("control", "reset step error", { error: String(err) }),
    );
  }, 10_000);
  // Test pods move on as their pods do; every path ends with the pod removed.
  const tests = setInterval(() => {
    runpodTests
      .advance()
      .catch((err) => log("control", "runpod test error", { error: String(err) }));
  }, 15_000);
  // Rigs in pull mode: each rig's next exchange starts as soon as its last one ends (an exchange
  // waits up to 20 s at the pod for the rig's calls), each failing rig after its retry time.
  const pulls = setInterval(() => {
    tunnels.advance().catch((err) => log("control", "pull mode error", { error: String(err) }));
  }, 250);
  // GPU clouds' prices, pods and spend, read again every 15 minutes.
  const clouds = setInterval(() => {
    refreshGpuClouds(store, secrets).catch((err) =>
      log("control", "gpu cloud read error", { error: String(err) }),
    );
  }, 15 * 60_000);
  // Campaign folders copied to outside knowledge bases: their new and changed items, every few
  // minutes (THERMITE_OUTSIDE_KB_SYNC_SECONDS). With no copy switched on, nothing is called.
  // 0 (or anything not a positive number) turns the timer off; Sync now still works.
  const outsideSyncMs = Number(env.THERMITE_OUTSIDE_KB_SYNC_SECONDS ?? "300") * 1000;
  const outsideSync =
    Number.isFinite(outsideSyncMs) && outsideSyncMs > 0
      ? setInterval(() => {
          outsideKb
            .syncAll()
            .catch((err) =>
              log("control", "outside knowledge base sync error", { error: String(err) }),
            );
        }, outsideSyncMs)
      : undefined;
  const stop = () => {
    clearInterval(resets);
    clearInterval(tests);
    clearInterval(pulls);
    clearInterval(clouds);
    clearInterval(outsideSync);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  log("control", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
