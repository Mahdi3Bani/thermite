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
  judge_gpus: null,
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

  test("no trial length unless someone sets one: the environment, Edit rig, or a file from before (goal 079)", async () => {
    const { trialMinutesFromEnv } = await import("./rig-settings.ts");
    assert.equal(trialMinutesFromEnv(undefined), null);
    assert.equal(trialMinutesFromEnv(""), null);
    assert.equal(trialMinutesFromEnv("45"), 45);
    assert.throws(() => trialMinutesFromEnv("0"), /THERMITE_TRIAL_MINUTES must be/);
    const none = { ...defaults, trial_minutes: null };
    const dir = mkdtempSync(join(tmpdir(), "thermite-settings-"));
    // A file written before kept every setting, the old 20-minute default too: not a choice.
    const { writeFileSync, readFileSync } = await import("node:fs");
    const old = join(dir, "old.json");
    writeFileSync(old, JSON.stringify({ ...defaults, lanes: 3, trial_minutes: 20 }));
    const s = new RigSettingsStore(none, old).get();
    assert.equal(s.trial_minutes, null, "the old default is dropped");
    assert.equal(s.lanes, 3, "what else it kept stays");
    // From now on, only what someone set is kept, and named.
    const file = join(dir, "rig-settings.json");
    const store = new RigSettingsStore(none, file);
    store.set({ trial_minutes: 20 });
    const kept = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(kept, { set_keys: ["trial_minutes"], trial_minutes: 20 });
    assert.equal(new RigSettingsStore(none, file).get().trial_minutes, 20, "a choice stays");
    // Edit rig's empty field clears it.
    assert.equal(store.set({ trial_minutes: null }).trial_minutes, null);
    assert.equal(new RigSettingsStore(none, file).get().trial_minutes, null);
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
