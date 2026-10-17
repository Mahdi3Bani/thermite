import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Git access for a private repository: an SSH deploy key or an HTTPS token, as control keeps it
 * (Settings › Providers › Git access). Control's project lookup and a supervisor's fetch both run
 * git through here: the key goes in a 0600 file in a fresh directory that is removed afterwards,
 * a token in a header (never the URL, never argv), and a host's SSH key is pinned on first use
 * in `knownHostsFile` and refused if it changes.
 */
export type GitAuth =
  | { kind: "ssh"; privateKey: string }
  | { kind: "token"; token: string; username?: string | undefined };

export interface GitEnv {
  env: Record<string, string>;
  /** The protocols git may use with this access. */
  protocols: string;
}

/** Runs `fn` with the environment git needs for `auth`, then removes what it wrote. */
export async function withGitAuth<T>(
  auth: GitAuth | undefined,
  knownHostsFile: string | undefined,
  fn: (g: GitEnv) => Promise<T>,
): Promise<T> {
  if (!auth) return fn({ env: {}, protocols: "https:ssh:git" });
  if (auth.kind === "token") {
    const basic = Buffer.from(`${auth.username ?? "x-access-token"}:${auth.token}`).toString(
      "base64",
    );
    return fn({
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
      protocols: "https",
    });
  }
  const dir = mkdtempSync(join(tmpdir(), "thermite-git-"));
  chmodSync(dir, 0o700);
  try {
    const key = join(dir, "key");
    writeFileSync(key, auth.privateKey.endsWith("\n") ? auth.privateKey : `${auth.privateKey}\n`, {
      mode: 0o600,
    });
    const known = knownHostsFile ?? join(dir, "known_hosts");
    mkdirSync(join(known, ".."), { recursive: true });
    const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    return await fn({
      env: {
        GIT_SSH_COMMAND: [
          "ssh",
          "-i",
          q(key),
          "-o IdentitiesOnly=yes",
          "-o BatchMode=yes",
          "-o StrictHostKeyChecking=accept-new",
          `-o UserKnownHostsFile=${q(known)}`,
        ].join(" "),
      },
      protocols: "ssh",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
