import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * The cryptography of the tunnel between control and a rig that control reaches through a
 * public proxy (a RunPod pod: docs/plan/goals/019-rig-only-entry.goal). The proxy ends TLS, so
 * it could read, change or replay what passes; these keep it to moving bytes.
 *
 * - Control signs every request (Ed25519) over its method, path, rig, pod, time, nonce and body.
 * - The rig signs every answer over the request's nonce, its status and its body.
 * - Bodies both ways are sealed to the other side's X25519 key (an ephemeral key, HKDF-SHA256,
 *   AES-256-GCM), so the proxy never sees a model key, a report or a command in plain text.
 * - Enrollment binds the rig's public keys to a one-time code (HMAC-SHA256).
 */

export const TUNNEL_VERSION = "thermite-tunnel-v1";
/** A request whose time is further than this from the rig's clock is refused. */
export const TUNNEL_SKEW_MS = 60_000;
/** Nonces are remembered at least this long, so a replay inside the window is refused. */
export const TUNNEL_NONCE_MS = 5 * 60_000;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface TunnelKeys {
  /** Ed25519, PEM: signs (the rig's answers, or control's requests). */
  signPrivatePem: string;
  signPublicPem: string;
  /** X25519, PEM: opens what is sealed to this side. */
  boxPrivatePem: string;
  boxPublicPem: string;
}

export function generateTunnelKeys(): TunnelKeys {
  const sign = generateKeyPairSync("ed25519");
  const box = generateKeyPairSync("x25519");
  return {
    signPrivatePem: sign.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    signPublicPem: sign.publicKey.export({ type: "spki", format: "pem" }).toString(),
    boxPrivatePem: box.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    boxPublicPem: box.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** What control signs for each request. */
export interface RequestHead {
  method: string;
  path: string;
  rig: string;
  pod: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** 32 random bytes, hex. */
  nonce: string;
}

const requestText = (h: RequestHead, body: Buffer) =>
  [
    TUNNEL_VERSION,
    "request",
    h.method,
    h.path,
    h.rig,
    h.pod,
    String(h.at),
    h.nonce,
    sha256(body),
  ].join("\n");
const answerText = (nonce: string, status: number, body: Buffer) =>
  [TUNNEL_VERSION, "answer", nonce, String(status), sha256(body)].join("\n");

export const newNonce = () => randomBytes(32).toString("hex");

export function signRequest(h: RequestHead, body: Buffer, signPrivatePem: string): string {
  return edSign(null, Buffer.from(requestText(h, body)), createPrivateKey(signPrivatePem)).toString(
    "base64",
  );
}

export function verifyRequest(
  h: RequestHead,
  body: Buffer,
  signature: string,
  signPublicPem: string,
): boolean {
  try {
    return edVerify(
      null,
      Buffer.from(requestText(h, body)),
      createPublicKey(signPublicPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function signAnswer(nonce: string, status: number, body: Buffer, pem: string): string {
  return edSign(null, Buffer.from(answerText(nonce, status, body)), createPrivateKey(pem)).toString(
    "base64",
  );
}

export function verifyAnswer(
  nonce: string,
  status: number,
  body: Buffer,
  signature: string,
  signPublicPem: string,
): boolean {
  try {
    return edVerify(
      null,
      Buffer.from(answerText(nonce, status, body)),
      createPublicKey(signPublicPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** The raw 32 bytes of an X25519 public key (the last 32 of its SPKI DER). */
const rawX25519 = (pem: string) =>
  createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32);

/**
 * Seals bytes to a recipient's X25519 public key: a fresh key for each message, so only the
 * recipient's private key opens it. Out: ephemeral public (32) | iv (12) | tag (16) | ciphertext.
 */
export function seal(plain: Buffer, recipientBoxPublicPem: string): Buffer {
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: createPublicKey(recipientBoxPublicPem),
  });
  const ephRaw = eph.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.concat([ephRaw, rawX25519(recipientBoxPublicPem)]),
      `${TUNNEL_VERSION} seal`,
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ephRaw, iv, cipher.getAuthTag(), ct]);
}

/** Opens what `seal` made for this key. Throws when it was changed or meant for another key. */
export function open(sealed: Buffer, boxPrivatePem: string): Buffer {
  if (sealed.length < 60) throw new Error("sealed data is too short");
  const priv = createPrivateKey(boxPrivatePem);
  const ownRaw = createPublicKey(priv).export({ type: "spki", format: "der" }).subarray(-32);
  const ephRaw = sealed.subarray(0, 32);
  // SPKI DER of an X25519 public key: a fixed 12-byte prefix, then the 32 raw bytes.
  const ephDer = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), ephRaw]);
  const shared = diffieHellman({
    privateKey: priv,
    publicKey: createPublicKey({ key: ephDer, format: "der", type: "spki" }),
  });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([ephRaw, ownRaw]), `${TUNNEL_VERSION} seal`, 32),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(32, 44));
  decipher.setAuthTag(sealed.subarray(44, 60));
  return Buffer.concat([decipher.update(sealed.subarray(60)), decipher.final()]);
}

/** Binds a rig's public keys to its one-time enrollment code. */
export function enrollmentProof(code: string, signPublicPem: string, boxPublicPem: string): string {
  return createHmac("sha256", code)
    .update(`${TUNNEL_VERSION}\nenroll\n${signPublicPem}\n${boxPublicPem}`)
    .digest("hex");
}

export function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
