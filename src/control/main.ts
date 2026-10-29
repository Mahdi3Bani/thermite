import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { buildInfo } from "../common/build-info.ts";
import { busHost, busUrl, natsBus, reloadBus } from "../common/bus.ts";
import { log, optionalSecretFromFile, parseListen } from "../common/env.ts";
import { writeAtomic } from "../common/fs.ts";
import { startLogging } from "../common/log.ts";
import { readNumber } from "../common/settings.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { createControlApi } from "./api/index.ts";
import {
  BUS_CA_EXPORT_SETTING,
  BUS_USERS_FILE,
  BUS_USERS_SYNC_MS,
  BusTls,
  BusUsers,
  busConfigDir,
  busPublicUrl,
  CONFIG_WRITE_MS,
  ConfigWriter,
  ConfigWritten,
} from "./bus/index.ts";
import { Credential } from "./credential.ts";
import { mountDashboard } from "./dashboard/index.ts";
import { EventsMirror } from "./events/index.ts";
import { followReports } from "./ingest.ts";
import { sendCommandsOn } from "./issue/index.ts";
import { KitRepos } from "./kits/index.ts";
import { advanceResets, driverFromEnv } from "./lifecycle.ts";
import { followLive, LiveTaken } from "./live/index.ts";
import { controlParts } from "./parts.ts";
import { checkQuietRigs, checkRigPlace } from "./rigs/index.ts";
import { refreshGpuClouds } from "./runpod/index.ts";
import { SecretBox } from "./secrets.ts";
import { CONTROL_NUMBERS } from "./settings.ts";
import { ControlStore } from "./store/index.ts";

/** Control service entry point. Generates its signing key on first start. */
async function main(): Promise<void> {
  const env = process.env;
  startLogging("control", env);
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
  const staleAfterMs = readNumber(env, CONTROL_NUMBERS.staleSeconds) * 1000;
  // Offline after 15 minutes without a report (never before it is stale).
  const offlineAfterMs = readNumber(env, CONTROL_NUMBERS.offlineSeconds) * 1000;
  const driver = driverFromEnv(env);
  // Optional: the owner accepts each rig's first report key (no trust on first use).
  const requireKeyAcceptance = env.THERMITE_CONTROL_REQUIRE_KEY_ACCEPT === "1";
  // The message bus (goal 168): with THERMITE_NATS_URL, rigs' reports and live lines arrive
  // there too, and commands leave there too.
  const natsUrl = busUrl(env);
  // How rigs and the machines control sets rigs up on reach control.
  const publicUrl = env.THERMITE_CONTROL_PUBLIC_URL || undefined;
  // The bus as the rigs control sets up reach it (none: they keep to HTTP), and its TLS: control's
  // own authority, kept beside its signing key, and the server's certificate for the names control
  // and those rigs reach it by, written to the folder the server reads (bus/tls.ts).
  const rigBusUrl = natsUrl ? busPublicUrl(env, publicUrl) : undefined;
  const busDir = natsUrl ? busConfigDir(env) : undefined;
  const busTls =
    natsUrl && busDir
      ? new BusTls({
          stateDir: dir,
          configDir: busDir,
          names: [busHost(natsUrl), ...(rigBusUrl ? [busHost(rigBusUrl)] : [])],
        })
      : undefined;
  // The rigs beside control in compose read the authority's certificate from control's volume.
  const caExport = env[BUS_CA_EXPORT_SETTING];
  if (busTls && caExport) writeAtomic(caExport, busTls.caCert, 0o644);
  const trust = busTls ? { ca: busTls.caCert } : undefined;
  // The key that seals model routes' API keys: its own file, made on first use. Mount it
  // from a separate secret to keep it off the database's volume.
  const secrets = SecretBox.fromFile(
    env.THERMITE_CONTROL_SECRETS_KEY_FILE ?? join(dir, "secrets.key"),
  );
  // Who may use the bus: control's own users and each rig's that registered its key, written to
  // the server's users file, which the server reloads on control's request (bus/users.ts).
  const busUsers =
    natsUrl && busDir && busTls
      ? new BusUsers({
          store,
          secrets,
          file: join(busDir, BUS_USERS_FILE),
          tls: busTls,
          reload: (seed) => reloadBus(natsUrl, seed, trust),
        })
      : undefined;
  // Control's connection to the bus, signed in as its own user; the mirror of its events table
  // there; and what it took from the live stream and wrote to the config bucket, which the bus's
  // state shows.
  const bus =
    natsUrl && busUsers
      ? natsBus(natsUrl, "control", { seed: busUsers.controlSeed, trust })
      : undefined;
  const eventsMirror = bus ? new EventsMirror({ store, bus }) : undefined;
  const liveTaken = new LiveTaken();
  const configWritten = new ConfigWritten();
  // What the dashboard, REST, MCP and the loops below share, made once here (parts.ts): the test
  // pods on GPU clouds, the agents' MCP servers (goal 068), the rigs in pull mode and the rigs the
  // owner launches on RunPod among them, and the bus.
  const parts = controlParts(
    store,
    privateKeyPem,
    {
      staleAfterMs,
      secrets,
      runpodTestImage: env.THERMITE_RUNPOD_TEST_IMAGE || undefined,
      runpodRigImage: env.THERMITE_RUNPOD_RIG_IMAGE || undefined,
      // Kits written on the new-campaign page, kept as git repositories in control's state.
      kits: new KitRepos(join(dir, "kits")),
      publicUrl,
      // The images rigs on machines run (none: control can't set rigs up there).
      rigImages:
        env.THERMITE_RIG_HARNESS_IMAGE && env.THERMITE_RIG_SUPERVISOR_IMAGE
          ? {
              harness: env.THERMITE_RIG_HARNESS_IMAGE,
              harnessCuda: env.THERMITE_RIG_HARNESS_CUDA_IMAGE || undefined,
              supervisor: env.THERMITE_RIG_SUPERVISOR_IMAGE,
            }
          : undefined,
      rigBus: rigBusUrl && busTls ? { url: rigBusUrl, ca: busTls.caCert } : undefined,
      bus:
        bus && natsUrl && eventsMirror
          ? {
              server: new URL(natsUrl).host,
              bus,
              events: eventsMirror,
              live: liveTaken,
              config: configWritten,
            }
          : undefined,
    },
    { staleAfterMs, offlineAfterMs, control: buildInfo() },
  );
  const { runpodTests, tunnels, runpodRigs } = parts;
  // Each rig's config, written to the config bucket when it changes (bus/config.ts).
  const busConfig = bus ? new ConfigWriter({ parts, bus, figures: configWritten }) : undefined;
  const server = serve({
    fetch: createControlApi(store, tokens, privateKeyPem, {
      staleAfterMs,
      offlineAfterMs,
      driver,
      requireKeyAcceptance,
      sessionDays: readNumber(env, CONTROL_NUMBERS.sessionDays),
      parts,
      // The dashboard's pages.
      pages: mountDashboard,
      // Exports from rigs without a results repository, kept in control's state.
      exportsDir: join(dir, "exports"),
      // Who may use the message bus: a rig's new key gets its user there, and a new seal key its
      // config.
      busUsers,
      busConfig,
    }).fetch,
    hostname: host,
    port,
  });
  log("control", "listening", {
    host,
    port,
    build: buildInfo(),
    rigs: Object.keys(tokens.rigs),
    enrolled: store.enrollments
      .rigs()
      .filter((r) => !r.retired_at)
      .map((r) => r.rig),
    lifecycle: driver?.kind ?? null,
    bus: natsUrl ? new URL(natsUrl).host : null,
    bus_for_rigs: rigBusUrl ? new URL(rigBusUrl).host : null,
  });
  // Reports from the bus, folded through the ingest route's checks as they arrive; the events
  // table, mirrored to the events stream, from the stream's last row to the table's end at start
  // and then as reports arrive, by HTTP or by the bus; live lines, folded into the live view as
  // they arrive; each command control issues, published to its rig's subject as well as kept in
  // the store; and each rig's config, written when it changes. The users file is written first,
  // so that the server can start, and kept up to date after.
  let usersSync: NodeJS.Timeout | undefined;
  let configWrite: NodeJS.Timeout | undefined;
  if (bus && busUsers && busConfig && eventsMirror) {
    void busUsers.sync();
    usersSync = setInterval(() => void busUsers.sync(), BUS_USERS_SYNC_MS);
    void eventsMirror.start();
    void busConfig.start().then(() => busConfig.write());
    configWrite = setInterval(() => void busConfig.write(), CONFIG_WRITE_MS);
    followReports(bus, { store, control: buildInfo(), requireKeyAcceptance }).catch((err) =>
      log("control", "reports from the bus stopped", { error: String(err) }, "error"),
    );
    followLive(bus, { store, taken: liveTaken }).catch((err) =>
      log("control", "live lines from the bus stopped", { error: String(err) }, "error"),
    );
    sendCommandsOn(store, bus).catch((err) =>
      log("control", "commands stream not made", { error: String(err) }, "error"),
    );
  }
  // Full resets advance as their evidence arrives.
  const resets = setInterval(() => {
    advanceResets({ store, privateKeyPem, driver, staleAfterMs }).catch((err) =>
      log("control", "reset step error", { error: String(err) }, "error"),
    );
  }, 10_000);
  // Test pods move on as their pods do; every path ends with the pod removed.
  const tests = setInterval(() => {
    runpodTests
      .advance()
      .catch((err) => log("control", "runpod test error", { error: String(err) }, "error"));
  }, 15_000);
  // Rigs in pull mode: each rig's next exchange starts as soon as its last one ends (an exchange
  // waits up to 20 s at the pod for the rig's calls), each failing rig after its retry time.
  const pulls = setInterval(() => {
    tunnels
      .advance()
      .catch((err) => log("control", "pull mode error", { error: String(err) }, "error"));
  }, 250);
  // Rigs on RunPod: each pod's status, price and spend; the owner's limits, where set; the stop,
  // start, restart or terminate under way. At start too: a limit a pod passed while control was
  // away stops it at once (goal 165).
  const followPods = () =>
    runpodRigs
      .advance()
      .catch((err) => log("control", "runpod rig error", { error: String(err) }, "error"));
  void followPods();
  const launched = setInterval(followPods, 30_000);
  // Rigs control set up that stopped reporting: their containers checked once when they turn
  // stale, and once more when they turn offline (rigs/watch.ts).
  let watching = false;
  const quiet = setInterval(() => {
    if (watching) return;
    watching = true;
    checkQuietRigs({
      store,
      // Where a quiet rig runs is checked as its page's Check again does.
      check: (rig, by) => checkRigPlace(parts, rig, by),
      staleAfterMs,
      offlineAfterMs,
    })
      .catch((err) => log("control", "quiet rig check error", { error: String(err) }, "error"))
      .finally(() => {
        watching = false;
      });
  }, 60_000);
  // GPU clouds' prices, pods and spend, read again every 15 minutes.
  const clouds = setInterval(() => {
    refreshGpuClouds(store, secrets).catch((err) =>
      log("control", "gpu cloud read error", { error: String(err) }, "error"),
    );
  }, 15 * 60_000);
  const stop = () => {
    clearInterval(resets);
    clearInterval(tests);
    clearInterval(pulls);
    clearInterval(launched);
    clearInterval(quiet);
    clearInterval(clouds);
    clearInterval(usersSync);
    clearInterval(configWrite);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  log("control", "fatal", { error: err instanceof Error ? err.stack : String(err) }, "error");
  process.exit(1);
});
