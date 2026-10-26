import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createControlApi } from "../../src/control/api.ts";
import { ControlStore, fingerprint } from "../../src/control/store.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";

const ADMIN = "admin-token-abcdef";
const tokens = { admin: ADMIN, rigs: { "rig-file": "file-rig-token-abcdef" } };
const owner = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

function setup() {
  const keys = generateSigningKeys();
  const store = new ControlStore(":memory:");
  const control = createControlApi(store, tokens, keys.privateKeyPem);
  const enroll = (rig: string, headers: Record<string, string> = owner) =>
    control.request("/v1/rigs", { method: "POST", headers, body: JSON.stringify({ rig }) });
  const asRig = (rig: string, token: string) =>
    control.request(`/v1/rigs/${rig}/commands/pending`, {
      headers: { authorization: `Bearer ${token}` },
    });
  const post = (path: string) => control.request(path, { method: "POST", headers: owner });
  return { keys, store, control, enroll, asRig, post };
}

describe("rig enrollment through control", () => {
  test("control makes a rig's token, shows it once, and keeps only its hash", async () => {
    const { keys, store, control, enroll, asRig } = setup();
    // Before enrollment the rig is unknown.
    assert.equal((await asRig("gpu-host-1-0", "anything")).status, 401);
    const res = await enroll("gpu-host-1-0");
    assert.equal(res.status, 201);
    const out = (await res.json()) as {
      rig: string;
      token: string;
      control_public_key: string;
      control_fingerprint: string;
    };
    assert.equal(out.rig, "gpu-host-1-0");
    assert.match(out.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(out.control_public_key.trim(), keys.publicKeyPem.trim());
    assert.equal(out.control_fingerprint, fingerprint(keys.publicKeyPem));
    // The new token works at once: no restart, no file.
    assert.equal((await asRig("gpu-host-1-0", out.token)).status, 200);
    assert.equal((await asRig("gpu-host-1-0", "wrong-token")).status, 401);
    assert.ok(store.knownRig("gpu-host-1-0"));
    // Control's database holds the hash, never the token.
    const dump = JSON.stringify(store.db.prepare("select * from rig_token").all());
    assert.ok(!dump.includes(out.token));
    // The rigs list shows it.
    const list = (await (await control.request("/v1/rigs", { headers: owner })).json()) as {
      enrolled: { rig: string; retired_at: string | null }[];
    };
    assert.deepEqual(
      list.enrolled.map((r) => [r.rig, r.retired_at]),
      [["gpu-host-1-0", null]],
    );
    // The owner's credential is required.
    assert.equal((await enroll("other", { "content-type": "application/json" })).status, 401);
  });

  test("names are checked, and a rig is enrolled once", async () => {
    const { enroll } = setup();
    for (const bad of ["A", "x", "-a", "a-", "has space", "a".repeat(41), "a_b"])
      assert.equal((await enroll(bad)).status, 400, bad);
    assert.equal((await enroll("ok-1")).status, 201);
    assert.equal((await enroll("ok-1")).status, 409);
    // A rig from the tokens file keeps its token there.
    const fromFile = await enroll("rig-file");
    assert.equal(fromFile.status, 409);
    assert.match(((await fromFile.json()) as { error: string }).error, /rig tokens file/);
  });

  test("a new token replaces the old one at once; a retired rig is shut out", async () => {
    const { enroll, asRig, post, store } = setup();
    const first = ((await (await enroll("cpu-1")).json()) as { token: string }).token;
    const rotated = await post("/v1/rigs/cpu-1/token");
    assert.equal(rotated.status, 200);
    const second = ((await rotated.json()) as { token: string }).token;
    assert.notEqual(second, first);
    assert.equal((await asRig("cpu-1", first)).status, 401);
    assert.equal((await asRig("cpu-1", second)).status, 200);
    assert.equal((await post("/v1/rigs/cpu-1/retire")).status, 200);
    assert.equal((await asRig("cpu-1", second)).status, 401);
    assert.equal(store.knownRig("cpu-1"), false);
    assert.equal((await post("/v1/rigs/cpu-1/retire")).status, 404);
    assert.equal((await post("/v1/rigs/cpu-1/token")).status, 404);
    // Enrolled again, it gets a fresh token; the old ones stay dead.
    const third = ((await (await enroll("cpu-1")).json()) as { token: string }).token;
    assert.equal((await asRig("cpu-1", second)).status, 401);
    assert.equal((await asRig("cpu-1", third)).status, 200);
    // The file's rigs keep their tokens through the API, but can be retired: control then refuses
    // the file's token until the rig is brought back.
    assert.equal((await post("/v1/rigs/rig-file/token")).status, 409);
    assert.equal((await asRig("rig-file", "file-rig-token-abcdef")).status, 200);
    assert.equal((await post("/v1/rigs/rig-file/retire")).status, 200);
    assert.equal((await asRig("rig-file", "file-rig-token-abcdef")).status, 403);
    assert.equal((await post("/v1/rigs/rig-file/bring-back")).status, 200);
    assert.equal((await asRig("rig-file", "file-rig-token-abcdef")).status, 200);
    // Every change is audited.
    const audit = JSON.stringify(store.db.prepare("select action from audit").all());
    for (const a of ["rig_enrolled", "rig_token_rotated", "rig_retired"])
      assert.ok(audit.includes(a), a);
  });
});
