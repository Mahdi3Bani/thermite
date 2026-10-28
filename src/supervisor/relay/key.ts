import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createUser, fromSeed } from "@nats-io/nkeys";
import { log } from "../../common/env.ts";
import { writeAtomic } from "../../common/fs.ts";
import { isUserKey, userKeyFingerprint } from "../../core/link/users.ts";

/**
 * The rig's own key on the message bus (goal 168): a NATS user key the supervisor makes the first
 * time it starts with the bus, and keeps in its state folder. It signs in with it; control learns
 * the key's public part from the supervisor's regular call, and gives it a user that may do only
 * what a rig may. The seed never leaves this file: it is not logged, and not sent anywhere.
 */

/** The file in the supervisor's state folder that holds the key's seed. A full reset keeps it. */
export const BUS_KEY_FILE = "bus-key.seed";

/** The rig's key: the seed to sign in with, and the public part control registers. */
export interface BusKey {
  seed: Uint8Array;
  publicKey: string;
}

/**
 * The rig's key, from `home`; made there first, with mode 0600, when there is none. A file that
 * does not hold a user key's seed stops the supervisor, with what to do.
 */
export function busKey(home: string): BusKey {
  const path = join(home, BUS_KEY_FILE);
  if (!existsSync(path)) {
    const made = createUser();
    writeAtomic(path, `${new TextDecoder().decode(made.getSeed())}\n`, 0o600);
    log("supervisor", "made the rig's key on the bus", {
      fingerprint: userKeyFingerprint(made.getPublicKey()),
    });
  }
  chmodSync(path, 0o600);
  const seed = new TextEncoder().encode(readFileSync(path, "utf8").trim());
  let publicKey = "";
  try {
    publicKey = fromSeed(seed).getPublicKey();
  } catch {
    publicKey = "";
  }
  if (!isUserKey(publicKey))
    throw new Error(
      `${path} does not hold a NATS user key's seed: delete it, and the supervisor makes a new key at its next start (control records the change)`,
    );
  return { seed, publicKey };
}

/**
 * The rig's key as the supervisor's figures carry it to control, its regular call: the public
 * part alone, never the seed. Without the bus, nothing.
 */
export function busKeyFigure(key: BusKey | undefined): { bus_key?: string } {
  return key ? { bus_key: key.publicKey } : {};
}
