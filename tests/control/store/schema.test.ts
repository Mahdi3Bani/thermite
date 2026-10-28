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
    assert.equal(version(store.db), 8);
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
    assert.equal(version(store.db), 8);
    store.db.close();
    assert.deepEqual(copiesOf(path), []);
  });

  test("a store at version 1 is copied, then gets the table of updates under way (goal 165)", () => {
    const path = fresh();
    const one = new ControlStore(path);
    one.db.exec("drop table rig_update; delete from schema_migrations where version >= 2");
    one.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 8);
    assert.ok(store.db.prepare("select 1 from sqlite_master where name = 'rig_update'").get());
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [1],
    );
  });

  test("a store at version 3 gets the agents' public names in its usage records (goal 125)", () => {
    const path = fresh();
    const three = new ControlStore(path);
    three.db.exec("delete from schema_migrations where version >= 4");
    const row = three.db.prepare(
      `insert into model_call (rig, ledger_id, event_id, run, agent, harness, model, at, tokens_in,
         tokens_out) values ('rig-a', 'l-1', ?, 'r-1', ?, 'pi', 'm', '2026-10-27T00:00:00Z', 1, 1)`,
    );
    for (const [id, agent] of [
      [1, "combiner"],
      [2, "panel"],
      [3, "workers"],
    ] as const)
      row.run(id, agent);
    three.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 8);
    const agents = store.db.prepare("select agent from model_call order by event_id").all();
    assert.deepEqual(
      agents.map((r) => r.agent),
      ["merged_by", "review_panel", "workers"],
    );
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [3],
    );
  });

  test("a rig's events are read in pages in control's order from an index, with no sort", () => {
    const store = new ControlStore(":memory:");
    // The views' paged read (RigEvents.after, lean, on the rig's ledger).
    const plan = store.db
      .prepare(
        "explain query plan select seq from rig_event where rig = ? and ledger_id = ? and kind != 'model_call' and seq > ? order by seq limit ?",
      )
      .all("rig-a", "l", 0, 5000)
      .map((r) => String(r.detail));
    assert.ok(
      plan.some((d) => d.includes("rig_event_ledger_seq")),
      plan.join("; "),
    );
    assert.ok(!plan.some((d) => d.includes("TEMP B-TREE")), plan.join("; "));
    store.db.close();
  });

  test("a store newer than this code is refused, naming the copy to restore", () => {
    const path = fresh();
    const old = new DatabaseSync(path);
    old.exec(V010);
    old.close();
    const store = new ControlStore(path);
    store.db.prepare("insert into schema_migrations (version) values (9)").run();
    store.db.close();
    assert.throws(
      () => new ControlStore(path),
      /control store is at schema version 9, newer than this code's 8: .*the copy made then: .*control\.db\.v0\..*\.copy/,
    );
  });
});
