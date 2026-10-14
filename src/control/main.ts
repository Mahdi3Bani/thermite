import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { log, parseListen, requireEnv, secretFromFile } from "../common/env.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { createControlApi } from "./api.ts";
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
    units: JSON.parse(
      readFileSync(requireEnv("THERMITE_CONTROL_UNIT_TOKENS_FILE"), "utf8"),
    ) as Record<string, string>,
  };
  const store = new ControlStore(join(dir, "control.db"));
  const { host, port } = parseListen(env.THERMITE_CONTROL_LISTEN ?? "0.0.0.0:8800");
  const server = serve({
    fetch: createControlApi(store, tokens, privateKeyPem).fetch,
    hostname: host,
    port,
  });
  log("control", "listening", { host, port, units: Object.keys(tokens.units) });
  const stop = () => {
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
