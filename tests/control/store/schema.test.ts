import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { copiesOf } from "../../../src/common/db-copy.ts";
import { ControlStore } from "../../../src/control/store/index.ts";

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
    assert.equal(version(store.db), 10);
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
    assert.equal(version(store.db), 10);
    store.db.close();
    assert.deepEqual(copiesOf(path), []);
  });

  test("a store at version 1 is copied, then gets the table of updates under way (goal 165)", () => {
    const path = fresh();
    const one = new ControlStore(path);
    one.db.exec("drop table rig_update; delete from schema_migrations where version >= 2");
    one.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 10);
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
    assert.equal(version(store.db), 10);
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

  test("a store at version 9 gets the synthesizer's and the final writer's model slots, and keeps every agent's model (goal 166)", () => {
    const path = fresh();
    const nine = new ControlStore(path);
    // The table as version 9 left it: its check takes the roles of goal 074 only.
    nine.db.exec(`drop table rig_role_model;
      create table rig_role_model (
        rig text not null,
        role text not null check (role in ('planner', 'teachers', 'second_teacher', 'merged_by', 'auditor', 'review_panel')),
        provider text not null, model text not null, effort text, assigned_at text not null,
        harness text, context_cap integer, compact_at integer,
        primary key (rig, role));
      insert into rig_role_model values ('rig-a', 'teachers', 'lab', 'wide-model', 'high', '2026-10-27', 'codex', 65536, 70);
      insert into rig_role_model values ('rig-a', 'auditor', 'lab', 'strong-model', null, '2026-10-27', null, null, null);
      delete from schema_migrations where version >= 10`);
    assert.throws(() =>
      nine.db
        .prepare(
          "insert into rig_role_model (rig, role, provider, model, assigned_at) values ('rig-a', 'synthesizer', 'lab', 'm', 'now')",
        )
        .run(),
    );
    nine.db.close();
    const store = new ControlStore(path);
    assert.equal(version(store.db), 10);
    const roles = store.agentModels.byRole("rig-a");
    assert.deepEqual(roles.teachers, {
      provider: "lab",
      model: "wide-model",
      effort: "high",
      harness: "codex",
      contextCap: 65_536,
      compactAt: 70,
    });
    assert.equal(roles.auditor?.model, "strong-model");
    // The two new slots take a model; a role the check does not name is still refused.
    store.modelProviders.put({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: "sealed-for-tests", hint: "…ests" },
    });
    store.agentModels.assignRole("rig-a", "synthesizer", { provider: "lab", model: "wide-model" });
    store.agentModels.assignRole("rig-a", "final_writer", {
      provider: "lab",
      model: "strong-model",
      harness: "pi",
    });
    const after = store.agentModels.byRole("rig-a");
    assert.deepEqual(
      [after.synthesizer?.model, after.final_writer?.model, after.final_writer?.harness],
      ["wide-model", "strong-model", "pi"],
    );
    assert.throws(() =>
      store.db
        .prepare(
          "insert into rig_role_model (rig, role, provider, model, assigned_at) values ('rig-a', 'writer', 'lab', 'm', 'now')",
        )
        .run(),
    );
    store.db.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [9],
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
    store.db.prepare("insert into schema_migrations (version) values (11)").run();
    store.db.close();
    assert.throws(
      () => new ControlStore(path),
      /control store is at schema version 11, newer than this code's 10: .*the copy made then: .*control\.db\.v0\..*\.copy/,
    );
  });
});
