import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * Deploy keys control makes for Git access: an ed25519 key pair, the private half in OpenSSH's
 * own format (what git's ssh reads), the public half as an authorized_keys line to paste into a
 * repository's deploy keys. Made with Node's crypto; no ssh-keygen needed on control.
 */

// The armour around a key made at run time; no key is in the source.
const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----"; // public-check: allow (armour only)
const END = "-----END OPENSSH PRIVATE KEY-----"; // public-check: allow (armour only)

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const str = (b: Buffer | string) => {
  const buf = typeof b === "string" ? Buffer.from(b) : b;
  return Buffer.concat([u32(buf.length), buf]);
};

export interface DeployKey {
  /** "ssh-ed25519 AAAA… comment": what the repository host is given. */
  publicKey: string;
  /** The OpenSSH private key file's text (never shown; sealed by control at once). */
  privateKey: string;
  /** SHA256:… as ssh-keygen -lf shows it. */
  fingerprint: string;
}

export function makeDeployKey(comment: string): DeployKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const blob = Buffer.concat([str("ssh-ed25519"), str(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([
    check,
    check,
    str("ssh-ed25519"),
    str(pub),
    str(Buffer.concat([seed, pub])),
    str(comment),
  ]);
  // Padded to the cipher block size (8 for "none") with 1, 2, 3, …
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    str("none"),
    str("none"),
    str(""),
    u32(1),
    str(blob),
    str(priv),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  return {
    publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
    privateKey: `${BEGIN}\n${lines.join("\n")}\n${END}\n`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}
