import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import {
  log,
  optionalSecretFromFile,
  parseListen,
  requireEnv,
  secretFromFile,
} from "../common/env.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { createControlApi } from "./api.ts";
import { advanceResets, driverFromEnv } from "./lifecycle.ts";
import { ControlStore } from "./store.ts";

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
  const tokens = {
    admin: secretFromFile("THERMITE_CONTROL_ADMIN_TOKEN_FILE"),
    read: optionalSecretFromFile("THERMITE_CONTROL_READ_TOKEN_FILE"),
    agent: optionalSecretFromFile("THERMITE_CONTROL_AGENT_TOKEN_FILE"),
    // One token per rig ({"<rig>": "<token>"}).
    rigs: JSON.parse(
      readFileSync(requireEnv("THERMITE_CONTROL_RIG_TOKENS_FILE"), "utf8"),
    ) as Record<string, string>,
  };
  // Each credential is distinct: the owner's, an agent's and a reader's must never coincide.
  const given = [tokens.admin, tokens.agent, tokens.read].filter((t): t is string => Boolean(t));
  if (new Set(given).size !== given.length)
    throw new Error("the admin, agent and read tokens must all be different");
  const store = new ControlStore(join(dir, "control.db"));
  const { host, port } = parseListen(env.THERMITE_CONTROL_LISTEN ?? "0.0.0.0:8800");
  // A rig is stale after 3 missed reports (the supervisor reports every 60 s by default).
  const staleAfterMs = Number(env.THERMITE_CONTROL_STALE_SECONDS ?? "180") * 1000;
  const driver = driverFromEnv(env);
  const server = serve({
    fetch: createControlApi(store, tokens, privateKeyPem, {
      staleAfterMs,
      driver,
      // The owner accepts each rig's first report key (no trust on first use).
      requireKeyAcceptance: env.THERMITE_CONTROL_REQUIRE_KEY_ACCEPT === "1",
      sessionDays: env.THERMITE_CONTROL_SESSION_DAYS
        ? Number(env.THERMITE_CONTROL_SESSION_DAYS)
        : undefined,
    }).fetch,
    hostname: host,
    port,
  });
  log("control", "listening", {
    host,
    port,
    rigs: Object.keys(tokens.rigs),
    lifecycle: driver?.kind ?? null,
  });
  // Full resets advance as their evidence arrives.
  const resets = setInterval(() => {
    advanceResets({ store, privateKeyPem, driver, staleAfterMs }).catch((err) =>
      log("control", "reset step error", { error: String(err) }),
    );
  }, 10_000);
  const stop = () => {
    clearInterval(resets);
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
