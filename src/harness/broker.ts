import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { log } from "../common/env.ts";

/**
 * The harness broker: the container's long-running supervisor process (under tini as PID 1).
 * In this version it starts the controller and restarts it with backoff if it exits. Later
 * versions add user separation: starting, killing and freezing lane, builder and run processes
 * under their own users.
 */
const controller = fileURLToPath(new URL("./main.js", import.meta.url));
let child: ChildProcess | undefined;
let stopping = false;
let restarts = 0;

function start(): void {
  const startedAt = Date.now();
  child = spawn(process.execPath, [...process.execArgv, controller], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (stopping) process.exit(code ?? 0);
    const ranMs = Date.now() - startedAt;
    restarts = ranMs > 60_000 ? 0 : restarts + 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(restarts, 5));
    log("broker", "controller exited; restarting", { code, signal, delay_ms: delay });
    setTimeout(start, delay);
  });
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
    if (child?.exitCode === null) child.kill(sig);
    else process.exit(0);
  });
}

log("broker", "starting controller");
start();
