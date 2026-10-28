import { createUser, fromSeed } from "@nats-io/nkeys";
import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { writeAtomic } from "../../common/fs.ts";
import { LIVE_RUNS_PER_RIG } from "../../core/link/live.ts";
import { isUserKey, userKeyFingerprint, usersFile } from "../../core/link/users.ts";
import type { SecretBox } from "../secrets.ts";
import type { BusIdentityName, ControlStore } from "../store/index.ts";

/**
 * Who may use the message bus (goal 168). Each rig's supervisor makes its own key and registers
 * its public part on its regular call to control (takeRigBusKey); control keeps it, writes every
 * user with what it may do to the server's users file, and asks the server to reload the file
 * (BusUsers). Control's own two keys are made here on first use and kept sealed in its store.
 */

/** The setting that names the users file control writes for the bus's server. */
export const BUS_USERS_FILE_SETTING = "THERMITE_NATS_USERS_FILE";

/**
 * How often control brings the users file to its store: for a rig retired, a run a rig may now
 * publish the live lines of, or a reload that failed. A look that finds nothing changed writes
 * nothing and asks no reload.
 */
export const BUS_USERS_SYNC_MS = 5_000;

/**
 * The users file's path, from its setting. Control needs one when it runs the bus: the server
 * then knows only the users control writes there. Not set stops control at start.
 */
export function busUsersFile(env: Record<string, string | undefined>): string {
  const file = env[BUS_USERS_FILE_SETTING]?.trim();
  if (!file)
    throw new Error(
      `with THERMITE_NATS_URL set, ${BUS_USERS_FILE_SETTING} names the file control writes the bus's users to, which the server's configuration includes`,
    );
  return file;
}

/** The users file's mode: it holds public keys and permissions, which the server reads. */
const USERS_FILE_MODE = 0o644;

/**
 * Records the key a rig's supervisor registered (checked by the caller with isUserKey). Its first
 * key, and each change, is an entry in the audit log and a step in the rig's history, with the
 * key's fingerprint, in one transaction with the key. What changed: a first key, another key, or
 * nothing.
 */
export function takeRigBusKey(
  store: ControlStore,
  rig: string,
  key: string,
): "new" | "changed" | "same" {
  const before = store.busKeys.rigKey(rig);
  if (before === key) return "same";
  const fingerprint = userKeyFingerprint(key);
  const previous = before === undefined ? undefined : userKeyFingerprint(before);
  store.tx(() => {
    store.busKeys.setRigKey(rig, key);
    if (previous === undefined) {
      store.auditLog.add(`rig:${rig}`, "rig_bus_key_registered", { fingerprint });
      store.rigHistory.add(rig, "bus_key", true, `fingerprint ${fingerprint}`);
    } else {
      store.auditLog.add(`rig:${rig}`, "rig_bus_key_changed", { fingerprint, previous });
      const detail = `fingerprint ${previous} → ${fingerprint}`;
      store.rigHistory.add(rig, "bus_key_changed", true, detail);
    }
  });
  if (previous === undefined) {
    log("control", "a rig's key on the bus registered", { rig, fingerprint });
    return "new";
  }
  log("control", "a rig's key on the bus changed", { rig, fingerprint, previous }, "warn");
  return "changed";
}

/**
 * The rigs that have a user on the bus: each with a registered key, known to control and not
 * retired, with its seal key when it registered one.
 */
export function busRigs(store: ControlStore) {
  return store.busKeys
    .rigKeys()
    .filter((r) => store.enrollments.knownRig(r.rig) && !store.retired.get(r.rig));
}

export interface BusUsersOptions {
  store: ControlStore;
  /** Seals control's own keys in its store. */
  secrets: SecretBox;
  /** The users file the server's configuration includes (THERMITE_NATS_USERS_FILE). */
  file: string;
  /** Asks the server to read the users file again, signed in as control's system user. */
  reload: (systemSeed: Uint8Array) => Promise<void>;
}

/** One of control's own keys: its seed, and the public part the users file names. */
interface Identity {
  seed: Uint8Array;
  publicKey: string;
}

/**
 * The bus's users, as control's store has them: control's own, and one for each rig with a key
 * that is known and not retired. sync writes the users file when what it says changed and has the
 * server reload it, one at a time.
 */
export class BusUsers {
  private readonly o: BusUsersOptions;
  private readonly control: Identity;
  private readonly system: Identity;
  /** The users file as control last wrote it; undefined before its first write. */
  private written: string | undefined;
  /** Whether the server took the file as last written. */
  private reloaded = false;
  /** Whether the last sync failed: a failure is logged in full once, then quietly until one works. */
  private failing = false;
  private last: Promise<void> = Promise.resolve();

  constructor(o: BusUsersOptions) {
    this.o = o;
    this.control = identity(o, "control");
    this.system = identity(o, "system");
  }

  /** The seed control signs in to the bus with. */
  get controlSeed(): Uint8Array {
    return this.control.seed;
  }

  /** The users file's text now: each rig's user with the runs control's run registry gives it. */
  text(): string {
    const { store } = this.o;
    const runs = store.runRegistry.runsByRig(LIVE_RUNS_PER_RIG);
    const rigs = busRigs(store).map((r) => ({
      rig: r.rig,
      key: r.key,
      runs: runs.get(r.rig) ?? [],
    }));
    return usersFile({ control: this.control.publicKey, system: this.system.publicKey, rigs });
  }

  /**
   * Brings the users file to the store: writes it when its text changed, and asks the server to
   * reload it then, or when the last reload failed. Waits for a sync under way first. It never
   * throws: a file not written or a reload that failed is logged, and tried again at the next sync.
   */
  sync(): Promise<void> {
    this.last = this.last.then(() => this.syncNow());
    return this.last;
  }

  private async syncNow(): Promise<void> {
    const where = { file: this.o.file };
    let text: string;
    try {
      text = this.text();
      if (text !== this.written) {
        writeAtomic(this.o.file, text, USERS_FILE_MODE);
        this.written = text;
        this.reloaded = false;
        log("control", "the bus's users written", { ...where, users: usersIn(text) });
      }
    } catch (err) {
      const error = errorText(err);
      const level = this.failing ? "debug" : "error";
      log("control", "the bus's users not written; trying again", { ...where, error }, level);
      this.failing = true;
      return;
    }
    if (this.reloaded) return;
    try {
      await this.o.reload(this.system.seed);
      this.reloaded = true;
      this.failing = false;
      log("control", "the bus's server reloaded its users", { users: usersIn(text) });
    } catch (err) {
      const error = redact(errorText(err)).replace(/\bU[A-Z2-7]{55}\b/g, "U…");
      const what = { error, again_in_s: BUS_USERS_SYNC_MS / 1000 };
      const level = this.failing ? "debug" : "warn";
      log("control", "the bus's server did not reload its users; trying again", what, level);
      this.failing = true;
    }
  }
}

/** How many users a users file names. */
const usersIn = (text: string) => (text.match(/"nkey":/g) ?? []).length;

/**
 * One of control's own keys, from its store; made there first, its seed sealed. Throws, with what
 * to look at, when the seed does not open, as after control's secrets key was replaced.
 */
function identity(o: BusUsersOptions, name: BusIdentityName): Identity {
  const keys = o.store.busKeys;
  if (!keys.identity(name)) {
    const made = createUser();
    const seed = new TextDecoder().decode(made.getSeed());
    keys.addIdentity(name, made.getPublicKey(), o.secrets.seal(seed));
    log("control", "made control's key on the bus", {
      user: name,
      fingerprint: userKeyFingerprint(made.getPublicKey()),
    });
  }
  const kept = keys.identity(name);
  let seed: Uint8Array | undefined;
  try {
    seed = new TextEncoder().encode(o.secrets.open(kept?.sealedSeed ?? ""));
    if (fromSeed(seed).getPublicKey() !== kept?.publicKey) seed = undefined;
  } catch {
    seed = undefined;
  }
  if (!seed || !kept || !isUserKey(kept.publicKey))
    throw new Error(
      `control's ${name} key on the message bus does not open with its secrets key (was THERMITE_CONTROL_SECRETS_KEY_FILE replaced?)`,
    );
  return { seed, publicKey: kept.publicKey };
}
