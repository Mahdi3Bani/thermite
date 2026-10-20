import { createPublicKey } from "node:crypto";
import { join } from "node:path";

/**
 * The one-container rig image (containers/rig/Containerfile): a rig's harness and supervisor in
 * one container, for hosts that run one container per machine, such as a RunPod pod. The broker
 * runs as root, as always, and also starts the supervisor under its own user, beside the
 * controller and the roles. These are the plain decisions behind that; broker.ts carries them
 * out and the isolation selftest checks them.
 */

type Env = Record<string, string | undefined>;

/** THERMITE_ONE_CONTAINER=1 (the one-container image sets it): the supervisor runs here too. */
export function oneContainer(env: Env): boolean {
  return env.THERMITE_ONE_CONTAINER === "1";
}

/**
 * RunPod's own variables (its API key, the pod's ID and the rest of RUNPOD_*). The image's entry
 * point removes them before anything starts (containers/rig/thermite-rig-start); the broker
 * never passes one on either, to the controller, the supervisor or a role.
 */
export const isRunpodVariable = (name: string): boolean => name.startsWith("RUNPOD_");

/** An environment without RunPod's variables and without unset entries. */
export function withoutRunpod(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isRunpodVariable(k)) out[k] = v;
  return out;
}

/** The supervisor's home in its passwd entry, in both images: ssh finds ~/.ssh there. */
export const SUPERVISOR_PASSWD_HOME = "/var/lib/thermite-supervisor/home";

/** Where the broker records how it started the supervisor: next to its socket, for the selftest. */
export const SUPERVISOR_RECORD = "supervisor.json";

/** The broker's record of the supervisor it starts (SUPERVISOR_RECORD). */
export interface SupervisorRecord {
  uid: number;
  gid: number;
  /** "landlock": it runs in the GPU fence with no card; "none": the kernel has no Landlock. */
  fence: "landlock" | "none";
  /** What its user met opening the GPU's device nodes, started as it is: see supervisorGpu. */
  gpu: string;
  home: string;
  at: string;
}

export interface SupervisorPaths {
  /** Its state (THERMITE_SUPERVISOR_HOME), closed to every other user. */
  home: string;
  /** Its temporary directory: /tmp is closed to it, as to the roles. Emptied at every start. */
  tmp: string;
  /** The harness's inbox: the supervisor writes there, the controller reads. */
  inbox: string;
  /** Its copy of the token it uses on the harness API. Always in its home. */
  tokenFile: string;
}

export function supervisorPaths(env: Env): SupervisorPaths {
  const home = env.THERMITE_SUPERVISOR_HOME ?? "/var/lib/thermite-supervisor";
  return {
    home,
    tmp: join(home, "tmp"),
    inbox: env.THERMITE_INBOX_DIR ?? "/inbox",
    tokenFile: join(home, "harness-token"),
  };
}

/**
 * The supervisor's environment: the broker's own, without RunPod's variables and without the
 * harness's secret files (only root reads those), with its own places and user.
 */
export function supervisorEnv(
  env: Env,
  paths: SupervisorPaths,
  harnessSecretVars: readonly string[],
): Record<string, string> {
  const out = withoutRunpod(env);
  for (const k of harnessSecretVars) delete out[k];
  return {
    ...out,
    HOME: SUPERVISOR_PASSWD_HOME,
    USER: "supervisor",
    TMPDIR: paths.tmp,
    THERMITE_SUPERVISOR_HOME: paths.home,
    THERMITE_INBOX_DIR: paths.inbox,
    THERMITE_HARNESS_TOKEN_FILE: paths.tokenFile,
  };
}

/**
 * How the supervisor's command is started once it runs as its user: with no_new_privs (setpriv),
 * and in the GPU fence with no card (thermite-devfence) where the kernel has Landlock, so neither
 * it nor a program it starts (an advisor's) can open the GPU's device nodes.
 */
export function supervisorArgv(
  command: readonly string[],
  tools: { setpriv: string | undefined; fence: string | undefined },
): string[] {
  if (!tools.setpriv)
    throw new Error("starting the supervisor needs setpriv, which this image lacks");
  return [
    tools.setpriv,
    "--no-new-privs",
    "--",
    ...(tools.fence ? [tools.fence, "--"] : []),
    ...command,
  ];
}

/** Run as the supervisor's user: the device nodes it opened, as JSON. */
export const OPEN_NODES_JS = `const fs=require("node:fs");const opened=[];for(const p of JSON.parse(process.argv[1])){try{fs.closeSync(fs.openSync(p,"r+"));opened.push(p)}catch{}}process.stdout.write(JSON.stringify(opened))`;

/**
 * What the supervisor's user meets opening each GPU device node, started as the supervisor is
 * (`run` takes the probe's command and runs it that way): "refused", "no GPU node", or a failure
 * the selftest reports, "OPENED <nodes>" or "failed: ...".
 */
export function supervisorGpu(
  nodes: string[],
  node: string,
  run: (command: string[]) => { status: number | null; stdout: string; stderr: string },
): string {
  if (!nodes.length) return "no GPU node";
  const r = run([node, "-e", OPEN_NODES_JS, JSON.stringify(nodes)]);
  let opened: unknown;
  try {
    opened = JSON.parse(r.stdout);
  } catch {
    return `failed: exit ${r.status} ${r.stderr.trim().slice(-200)}`;
  }
  if (!Array.isArray(opened)) return `failed: ${r.stdout.slice(0, 200)}`;
  return opened.length ? `OPENED ${opened.join(", ")}` : "refused";
}

/**
 * Control's command-signing public key as the launch gives it (THERMITE_CONTROL_PUBKEY): PEM, or
 * PEM in base64. Returns it as PEM; anything that is not an Ed25519 public key is refused.
 */
export function controlKeyPem(value: string): string {
  const text = value.includes("-----BEGIN")
    ? value
    : Buffer.from(value.trim(), "base64").toString("utf8");
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(text);
  } catch {
    throw new Error("THERMITE_CONTROL_PUBKEY is not a public key in PEM, or PEM in base64");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error(
      `THERMITE_CONTROL_PUBKEY is an ${key.asymmetricKeyType} key; control signs with Ed25519`,
    );
  return key.export({ type: "spki", format: "pem" }).toString();
}

/**
 * When to start a part again after it exited (the controller, or the supervisor): after a second
 * if it had run for more than a minute, otherwise twice as long as the last time, up to 30 s.
 */
export function restartAfter(
  ranMs: number,
  restarts: number,
): { restarts: number; delayMs: number } {
  const next = ranMs > 60_000 ? 0 : restarts + 1;
  return { restarts: next, delayMs: Math.min(30_000, 1000 * 2 ** Math.min(next, 5)) };
}
