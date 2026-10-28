import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { copiesOf } from "../../../src/common/db-copy.ts";
import {
  addBusIdentity,
  busIdentity,
  rigBusKey,
  rigBusKeys,
  setRigBusKey,
} from "../../../src/control/store/bus.ts";
import { ControlStore } from "../../../src/control/store.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");

describe("the message bus's keys in control's store", () => {
  test("a store at version 6 is copied, then gets the keys' tables (goal 168)", () => {
    const path = fresh();
    const six = new ControlStore(path);
    six.db.exec("drop table rig_bus_key; drop table bus_identity");
    six.db.exec("delete from schema_migrations where version >= 7");
    six.db.close();
    const store = new ControlStore(path);
    const v = store.db.prepare("select max(version) as v from schema_migrations").get();
    assert.equal(v?.v, 7);
    assert.deepEqual(rigBusKeys(store.db), []);
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [6],
    );
  });

  test("a rig's key is replaced by its next; control's own are kept as first made", () => {
    const store = new ControlStore(":memory:");
    assert.equal(rigBusKey(store.db, "rig-a"), undefined);
    setRigBusKey(store.db, "rig-b", "UB");
    setRigBusKey(store.db, "rig-a", "UA1");
    setRigBusKey(store.db, "rig-a", "UA2");
    assert.equal(rigBusKey(store.db, "rig-a"), "UA2");
    assert.deepEqual(rigBusKeys(store.db), [
      { rig: "rig-a", key: "UA2" },
      { rig: "rig-b", key: "UB" },
    ]);
    addBusIdentity(store.db, "control", "UC1", "s1:first");
    addBusIdentity(store.db, "control", "UC2", "s1:second");
    assert.deepEqual(busIdentity(store.db, "control"), {
      publicKey: "UC1",
      sealedSeed: "s1:first",
    });
    assert.equal(busIdentity(store.db, "system"), undefined);
  });
});
