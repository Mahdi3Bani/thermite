import { existsSync, readFileSync } from "node:fs";

/** Reads a required environment variable. */
/** Settings renamed on 2026-10-15 (unit -> rig): the old names still work, for a transition. */
const RENAMED: Record<string, string> = {
  THERMITE_RIG_ID: "THERMITE_UNIT_ID",
  THERMITE_CONTROL_RIG_TOKENS_FILE: "THERMITE_CONTROL_UNIT_TOKENS_FILE",
};

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const old = RENAMED[name];
  const v = env[name] || (old ? env[old] : undefined);
  if (!v) throw new Error(`missing environment variable ${name}`);
  if (!env[name] && old) log("env", `${old} is deprecated; set ${name}`);
  return v;
}

/** Reads a secret from the file named by an environment variable, trimmed. */
export function secretFromFile(varName: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = requireEnv(varName, env);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`secret file for ${varName} is empty`);
  return value;
}

export function optionalSecretFromFile(
  varName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = env[varName];
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

/** Parses "host:port" (host may be empty for all interfaces). */
export function parseListen(value: string): { host: string; port: number } {
  const i = value.lastIndexOf(":");
  const host = i > 0 ? value.slice(0, i) : "0.0.0.0";
  const port = Number(value.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`bad listen address ${value}`);
  return { host, port };
}

/** Waits for a file to appear (for keys written by another container at first start). */
export async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.trim()) return text;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * A message with what could be a credential taken out, for logs: a URL's user and password,
 * a bearer token, and keys with a known prefix. Messages are written by Thermite's own code, so
 * this guards against an echoed URL or key, not against anything a message could hold.
 */
export function redact(text: string): string {
  return text
    .replace(/(\/\/)[^/\s@]+@/g, "$1***@")
    .replace(/\b(Bearer\s+)\S+/gi, "$1***")
    .replace(/\b(sk-|rpa_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abp]-)[A-Za-z0-9_-]{6,}/g, "$1***")
    .slice(0, 2000);
}

export function log(component: string, msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), component, msg, ...fields })}\n`,
  );
}
