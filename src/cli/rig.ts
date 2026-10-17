import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newToken } from "../control/credential.ts";

/** What control answers when it enrolls a rig. */
export interface Enrolled {
  rig: string;
  token: string;
  control_public_key: string;
  control_fingerprint: string;
}

/**
 * The files a new rig starts from, written for the rig's host: its control token, a fresh token
 * its harness and supervisor share, control's public key with its fingerprint, and the rig's
 * name and control's address. No token is printed; each is only in its file, mode 0600.
 */
export function writeRigFiles(dir: string, enrolled: Enrolled, controlUrl: string): string[] {
  if (existsSync(dir) && readdirSync(dir).length)
    throw new Error(`${dir} is not empty; a rig's files are never overwritten`);
  mkdirSync(join(dir, "secrets"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "keys"), { recursive: true });
  const files: [string, string, number][] = [
    ["secrets/control-rig-token", `${enrolled.token}\n`, 0o600],
    ["secrets/harness-supervisor-token", `${newToken().token}\n`, 0o600],
    ["keys/control-signing.pub", enrolled.control_public_key, 0o644],
    ["keys/control-signing.fingerprint", `${enrolled.control_fingerprint}\n`, 0o644],
    [
      "rig.env",
      `THERMITE_RIG_ID=${enrolled.rig}\nCONTROL_URL=${controlUrl.replace(/\/$/, "")}\n`,
      0o644,
    ],
    [
      "README.txt",
      `Rig ${enrolled.rig}, enrolled at ${controlUrl}.

secrets/control-rig-token         the supervisor's token for control (THERMITE_CONTROL_TOKEN_FILE)
secrets/harness-supervisor-token  shared by the harness (THERMITE_SUPERVISOR_TOKEN_FILE) and the
                                  supervisor (THERMITE_HARNESS_TOKEN_FILE)
keys/control-signing.pub          control's public key (the harness's THERMITE_CONTROL_PUBKEY_FILE)
keys/control-signing.fingerprint  compare it with the fingerprint on control's dashboard
rig.env                           the rig's name and control's address

Keep secrets/ private. A lost or leaked token is replaced with \`thermite rig token\`.
`,
      0o644,
    ],
  ];
  for (const [name, text, mode] of files)
    writeFileSync(join(dir, name), text, { mode, flag: "wx" });
  return files.map(([name]) => name);
}
