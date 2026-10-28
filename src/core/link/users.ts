import { fromPublic } from "@nats-io/nkeys";
import { sha256Hex } from "../canonical.ts";
import { RIG_ID } from "../ids.ts";
import { COMMAND_STREAM, commandConsumerName, commandSubject } from "./commands.ts";
import { reportSubject } from "./report.ts";

/**
 * Who may do what on the message bus (goal 168): only control and the rigs' supervisors hold a
 * credential, each a NATS user key (an nkey) that the part made itself. The server knows a user by
 * the key's public part alone; its seed, the secret, never leaves the part that made it. Control
 * writes every user, with what it may do, to the server's users file (usersFile), and asks the
 * server to read it again (reloadSubject): a rig's supervisor registers its key on its regular call
 * to control, and has a user once control has written it.
 */

/** The account every stream is in, with control's user and each rig's. */
export const BUS_ACCOUNT = "THERMITE";
/** The server's own account: control's second user, which only asks the server to reload. */
export const SYSTEM_ACCOUNT = "SYS";

/** A user key's public part: 56 characters of base32, starting with U. */
const USER_KEY = /^U[A-Z2-7]{55}$/;

/** What a user key is, in words, for a refusal. */
export const USER_KEY_WORDS =
  "a NATS user key's public part: 56 characters of A-Z and 2-7, starting with U";

/** Whether `key` is a NATS user key's public part, its checksum right. */
export function isUserKey(key: string): boolean {
  if (!USER_KEY.test(key)) return false;
  try {
    fromPublic(key);
    return true;
  } catch {
    return false;
  }
}

/** What logs, the audit log and a rig's history show of a user key: never the key itself. */
export function userKeyFingerprint(key: string): string {
  return sha256Hex(key).slice(0, 16);
}

/**
 * The start of every subject a rig's supervisor takes replies on: the server's acks of its
 * reports, its answers about the rig's consumer, and the rig's commands. Its user may subscribe
 * there and nowhere else.
 */
export function rigInboxPrefix(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for an inbox: ${rig}`);
  return `_INBOX.rig.${rig}`;
}

/** What a user may publish to and subscribe to: these subjects, and nothing else. */
export interface Permissions {
  publish: { allow: string[] };
  subscribe: { allow: string[] };
}

/** The JetStream API's subjects: the server answers a request on these. */
const API = "$JS.API";

/**
 * What a rig's user may do: publish its own reports; make, read and take from its own consumer of
 * the commands stream, and ack what it took. The server checks that a consumer it makes takes the
 * rig's own commands alone: the subject names the consumer's filter.
 */
export function rigPermissions(rig: string): Permissions {
  const consumer = `${COMMAND_STREAM}.${commandConsumerName(rig)}`;
  return {
    publish: {
      allow: [
        reportSubject(rig),
        `${API}.CONSUMER.CREATE.${consumer}.${commandSubject(rig)}`,
        `${API}.CONSUMER.INFO.${consumer}`,
        `${API}.CONSUMER.MSG.NEXT.${consumer}`,
        `$JS.ACK.${consumer}.>`,
      ],
    },
    subscribe: { allow: [`${rigInboxPrefix(rig)}.>`] },
  };
}

/** The subject control's system user asks the server with this id to reload its configuration. */
export function reloadSubject(serverId: string): string {
  return `$SYS.REQ.SERVER.${serverId}.RELOAD`;
}

/** What control's system user may do: ask for a reload, and read the answer. */
const SYSTEM_PERMISSIONS: Permissions = {
  publish: { allow: [reloadSubject("*")] },
  subscribe: { allow: ["_INBOX.>"] },
};

/** The users the server knows: control's two keys, and each rig's that has one registered. */
export interface BusUserKeys {
  control: string;
  system: string;
  rigs: readonly { rig: string; key: string }[];
}

/**
 * The server's users file, which its configuration includes: control's user, which may do
 * everything in the account; a user for each rig, which may do only what rigPermissions gives it;
 * and control's system user. A rig with no key has no user. The values are JSON, which the
 * server's configuration reads. Throws on a key or a rig's name that is not one.
 */
export function usersFile(u: BusUserKeys): string {
  for (const key of [u.control, u.system, ...u.rigs.map((r) => r.key)])
    if (!isUserKey(key)) throw new Error("not a NATS user key for the bus's users file");
  const rigs = [...u.rigs].sort((a, b) => (a.rig < b.rig ? -1 : a.rig > b.rig ? 1 : 0));
  const accounts = {
    [BUS_ACCOUNT]: {
      jetstream: "enabled",
      users: [
        { nkey: u.control },
        ...rigs.map((r) => ({ nkey: r.key, permissions: rigPermissions(r.rig) })),
      ],
    },
    [SYSTEM_ACCOUNT]: { users: [{ nkey: u.system, permissions: SYSTEM_PERMISSIONS }] },
  };
  return [
    "# The message bus's users, written by Thermite's control: control's own, and one for each rig",
    "# whose supervisor registered its key. Control writes it whole when one changes, and asks the",
    "# server to reload it. Edits here are lost.",
    `accounts: ${JSON.stringify(accounts, null, 2)}`,
    `system_account: ${JSON.stringify(SYSTEM_ACCOUNT)}`,
    "",
  ].join("\n");
}
