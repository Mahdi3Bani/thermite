import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAccount, createUser } from "@nats-io/nkeys";
import { commandConsumerConfig } from "../../../src/core/link/commands.ts";
import {
  BUS_ACCOUNT,
  isUserKey,
  reloadSubject,
  rigInboxPrefix,
  rigPermissions,
  SYSTEM_ACCOUNT,
  userKeyFingerprint,
  usersFile,
} from "../../../src/core/link/users.ts";

const user = () => createUser().getPublicKey();

/** A users file's accounts and system account, read back from its JSON values. */
function readUsers(text: string) {
  const accounts = /^accounts: (\{[\s\S]*?\n\})$/m.exec(text)?.[1];
  const system = /^system_account: (.*)$/m.exec(text)?.[1];
  assert.ok(accounts && system, "the file has its accounts and its system account");
  return {
    accounts: JSON.parse(accounts) as Record<
      string,
      { jetstream?: string; users: { nkey: string; permissions?: unknown }[] }
    >,
    system: JSON.parse(system) as string,
  };
}

describe("who may do what on the message bus", () => {
  test("a user key is an nkey's public part that starts with U, its checksum right", () => {
    const key = user();
    assert.equal(isUserKey(key), true);
    const seed = new TextDecoder().decode(createUser().getSeed());
    for (const bad of [
      "",
      key.toLowerCase(),
      key.slice(0, -1),
      `${key}A`,
      // Its last character changed: the checksum no longer matches.
      `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`,
      createAccount().getPublicKey(),
      seed,
      "U".padEnd(56, "1"),
    ])
      assert.equal(isUserKey(bad), false, bad);
  });

  test("a key's fingerprint is short and is not the key", () => {
    const key = user();
    const fp = userKeyFingerprint(key);
    assert.match(fp, /^[0-9a-f]{16}$/);
    assert.equal(fp, userKeyFingerprint(key));
    assert.notEqual(fp, userKeyFingerprint(user()));
    assert.ok(!key.includes(fp));
  });

  test("a rig may publish its own reports and take its own commands, and nothing else", () => {
    assert.deepEqual(rigPermissions("rig-a"), {
      publish: {
        allow: [
          "thermite.rig.rig-a.report",
          "$JS.API.CONSUMER.CREATE.COMMANDS.rig-rig-a-commands.thermite.rig.rig-a.cmd",
          "$JS.API.CONSUMER.INFO.COMMANDS.rig-rig-a-commands",
          "$JS.API.CONSUMER.MSG.NEXT.COMMANDS.rig-rig-a-commands",
          "$JS.ACK.COMMANDS.rig-rig-a-commands.>",
        ],
      },
      subscribe: { allow: ["_INBOX.rig.rig-a.>"] },
    });
    // The consumer it may make is the one the supervisor follows its commands with.
    const c = commandConsumerConfig("rig-a");
    const create = rigPermissions("rig-a").publish.allow[1] ?? "";
    assert.ok(create.endsWith(`.${c.durable_name}.${c.filter_subject}`));
    assert.equal(rigInboxPrefix("rig-a"), "_INBOX.rig.rig-a");
    // Nothing of one rig's is in another's: no subject of rig-a's is open to rig-b.
    const b = JSON.stringify(rigPermissions("rig-b"));
    assert.ok(!b.includes("rig-a"));
    assert.ok(!b.includes("*"), "no wildcard but the end of its own subjects");
    for (const bad of ["rig.a", "rig-a.>", "*", "", "Rig-A"])
      assert.throws(() => rigPermissions(bad), /not a rig's name/, bad);
  });

  test("the users file: control may do everything, each rig its own, and a system user reloads", () => {
    const keys = { control: user(), system: user(), a: user(), b: user() };
    const text = usersFile({
      control: keys.control,
      system: keys.system,
      rigs: [
        { rig: "rig-b", key: keys.b },
        { rig: "rig-a", key: keys.a },
      ],
    });
    assert.match(text, /^# The message bus's users, written by Thermite's control/);
    const { accounts, system } = readUsers(text);
    assert.equal(system, SYSTEM_ACCOUNT);
    assert.deepEqual(Object.keys(accounts), [BUS_ACCOUNT, SYSTEM_ACCOUNT]);
    assert.equal(accounts[BUS_ACCOUNT]?.jetstream, "enabled");
    assert.deepEqual(accounts[BUS_ACCOUNT]?.users, [
      { nkey: keys.control },
      { nkey: keys.a, permissions: rigPermissions("rig-a") },
      { nkey: keys.b, permissions: rigPermissions("rig-b") },
    ]);
    assert.deepEqual(accounts[SYSTEM_ACCOUNT]?.users, [
      {
        nkey: keys.system,
        permissions: {
          publish: { allow: ["$SYS.REQ.SERVER.*.RELOAD"] },
          subscribe: { allow: ["_INBOX.>"] },
        },
      },
    ]);
    assert.equal(reloadSubject("NABC"), "$SYS.REQ.SERVER.NABC.RELOAD");
    // With no rig: control's users alone.
    const none = readUsers(usersFile({ control: keys.control, system: keys.system, rigs: [] }));
    assert.deepEqual(none.accounts[BUS_ACCOUNT]?.users, [{ nkey: keys.control }]);
  });

  test("a key that is not a user key never reaches the file", () => {
    const good = { control: user(), system: user(), rigs: [] };
    for (const bad of [
      { ...good, control: "UNOTAKEY" },
      { ...good, system: createAccount().getPublicKey() },
      { ...good, rigs: [{ rig: "rig-a", key: "U" }] },
    ])
      assert.throws(() => usersFile(bad), /^Error: not a NATS user key for the bus's users file$/);
    assert.throws(
      () => usersFile({ ...good, rigs: [{ rig: "rig.a", key: user() }] }),
      /not a rig's name/,
    );
  });
});
