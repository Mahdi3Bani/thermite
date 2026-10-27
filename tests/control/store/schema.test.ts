import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { copiesOf } from "../../../src/common/db-copy.ts";
import { ControlStore } from "../../../src/control/store.ts";

const V010 = readFileSync(
  join(import.meta.dirname, "..", "..", "helpers", "data", "control-v0.1.0.sql"),
  "utf8",
);
const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");
const version = (db: DatabaseSync) =>
  (db.prepare("select max(version) as v from schema_migrations").get() as { v: number }).v;

describe("control's store migrations", () => {
  test("a store that v0.1.0 wrote is copied, then migrated, and keeps its data", () => {
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    old.close();

    const store = new ControlStore(path);
    assert.equal(version(store.db), 2);
    const folder = store.db.prepare("select name from campaign_folder").get() as { name: string };
    assert.equal(folder.name, "speed");
    store.db.close();

    const copies = copiesOf(path);
    assert.equal(copies.length, 1);
    assert.equal(copies[0]?.version, 0);
    const copy = new DatabaseSync(copies[0]?.path ?? "", { readOnly: true });
    const tables = copy
      .prepare("select name from sqlite_master where type = 'table' and name = 'schema_migrations'")
      .all();
    assert.deepEqual(tables, [], "the copy is the store as v0.1.0 left it");
    copy.close();

    new ControlStore(path).db.close();
    assert.equal(copiesOf(path).length, 1, "a store at this code's version is not copied again");
  });

  test("a new store is not copied", () => {
    const path = fresh();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 2);
    store.db.close();
    assert.deepEqual(copiesOf(path), []);
  });

  test("a store at version 1 is copied, then gets the table of updates under way (goal 165)", () => {
    const path = fresh();
    const one = new ControlStore(path);
    one.db.exec("drop table rig_update; delete from schema_migrations where version = 2");
    one.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 2);
    assert.ok(store.db.prepare("select 1 from sqlite_master where name = 'rig_update'").get());
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [1],
    );
  });

  test("a store newer than this code is refused, naming the copy to restore", () => {
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    old.close();
    const store = new ControlStore(path);
    store.db.prepare("insert into schema_migrations (version) values (3)").run();
    store.db.close();
    assert.throws(
      () => new ControlStore(path),
      /control store is at schema version 3, newer than this code's 2: .*the copy made then: .*control\.db\.v0\..*\.copy/,
    );
  });
});
