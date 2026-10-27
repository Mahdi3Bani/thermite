import { sha256Hex } from "../../core/canonical.ts";

/** A short fingerprint of a public key, for the dashboard and the audit log. */
export function fingerprint(pubkeyPem: string): string {
  return sha256Hex(pubkeyPem.trim()).slice(0, 16);
}
