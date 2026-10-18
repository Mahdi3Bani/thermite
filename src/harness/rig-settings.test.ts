import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { signEnvelope } from "../core/commands.ts";
import { makeJudgeEnv } from "../testing/judge-env.ts";
import { type RigSettings, RigSettingsStore } from "./rig-settings.ts";

const defaults: RigSettings = {
  judge: true,
  workers: true,
  lanes: 2,
  planner: true,
  auditor: true,
  teachers: true,
  review: true,
  exports: true,
  trial_minutes: 20,
  max_turns: null,
  promotion: "owner_approval",
};

describe("the rig's own settings (Edit rig)", () => {
  test("a change is kept across restarts and tells the loops that read it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-settings-")), "rig-settings.json");
    const store = new RigSettingsStore(defaults, file);
    const seen: RigSettings[] = [];
    store.onChange((s) => seen.push(s));
    const now = store.set({ judge: false, lanes: 3, max_turns: 200 });
    assert.equal(now.judge, false);
    assert.equal(now.lanes, 3);
    assert.equal(now.workers, true);
    assert.equal(seen.length, 1);
    // A restart reads what was kept, over the environment's defaults.
    assert.deepEqual(new RigSettingsStore({ ...defaults, lanes: 1 }, file).get(), now);
    // Back to no turn cap.
    assert.equal(store.set({ max_turns: null }).max_turns, null);
  });

  test("only a signed owner command changes them; the rig reports what it runs with", async () => {
    const env = makeJudgeEnv({ promotion: "owner_approval" });
    const r = await env.service.applyCommand(
      env.sign("rig_settings", { workers: false, promotion: "auto" }),
    );
    assert.equal(r.status, "applied");
    assert.equal((r as { accepted: boolean }).accepted, true);
    assert.equal(env.service.settings.get().workers, false);
    assert.equal(env.service.promotion, "auto");
    const report = env.service.snapshot(0, 10) as { summary: { settings: RigSettings } };
    assert.equal(report.summary.settings.workers, false);
    assert.ok(
      env.ledger.db.prepare("select 1 from event where kind = 'rig_settings_changed'").get(),
    );
    // An agent's token can steer, but not change what runs on the rig.
    const agent = signEnvelope(
      {
        v: 1,
        id: "0f9b2c1e-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
        rig: env.service.rig,
        kind: "rig_settings",
        issued_by: "agent:mcp",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload: { judge: false },
      },
      env.keys.privateKeyPem,
    );
    const refused = await env.service.applyCommand(agent);
    assert.equal((refused as { accepted: boolean }).accepted, false);
    assert.equal(env.service.settings.get().judge, true);
    // Unknown fields are refused.
    const odd = (await env.service.applyCommand(env.sign("rig_settings", { gpus: 9 }))) as {
      status: string;
      accepted?: boolean;
    };
    assert.ok(odd.status === "rejected" || odd.accepted === false, JSON.stringify(odd));
  });
});
