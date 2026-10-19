import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateSigningKeys } from "../core/commands.ts";
import { createControlApi } from "./api.ts";
import { ControlStore } from "./store.ts";

const ADMIN = "admin-token-abcdef";
const RIG_TOKEN = "rig-token-in-the-file-0001";

describe("retiring a rig that is gone", () => {
  test("any rig, even one from the tokens file: out of the lists and Needs you, its reports refused, back on request", async () => {
    const store = new ControlStore(":memory:");
    const api = createControlApi(
      store,
      { admin: ADMIN, rigs: { "rig-a": RIG_TOKEN } },
      generateSigningKeys().privateKeyPem,
      { staleAfterMs: 180_000 },
    );
    // A rig that reported once, long ago: it shows as not reporting.
    store.db
      .prepare(
        "insert into rig (id, first_seen, last_seen, last_cursor, ledger_id, summary, report_at) values (?, ?, ?, 0, null, '{}', ?)",
      )
      .run("rig-a", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
    const login = await api.request("/ui/login", {
      method: "POST",
      body: new URLSearchParams({ token: ADMIN }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = async (path: string) => (await api.request(path, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/rigs/rig-a"))?.[1] ?? "";
    const post = async (path: string, form: Record<string, string>) =>
      decodeURIComponent(
        String(
          (
            await api.request(path, {
              method: "POST",
              body: new URLSearchParams({ csrf, ...form }),
              headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
            })
          ).headers.get("location"),
        ),
      );
    assert.match(await page("/ui"), /rig-a stopped reporting/);
    assert.match(await page("/ui/rigs/rig-a"), /Retire it/);
    assert.match(
      await post("/ui/rigs/rig-a/retire", { confirm: "retire rig-b" }),
      /Type "retire rig-a"/,
    );
    assert.match(
      await post("/ui/rigs/rig-a/retire", { confirm: "retire rig-a" }),
      /rig-a is retired\. If its token is in control's settings, take it out there too\./,
    );
    assert.ok(!(await page("/ui")).includes("rig-a stopped reporting"), "not in Needs you");
    const rigs = await page("/ui/rigs");
    assert.match(rigs, /0 rigs/);
    assert.match(rigs, /<h2>Retired<\/h2><span class="n">1<\/span>/);
    assert.match(await page("/ui/rigs/rig-a"), /Retired .* ago by owner:ui/);
    // Its token still matches the file, but control refuses it while it is retired.
    const refused = await api.request("/v1/rigs/rig-a/commands/pending", {
      headers: { authorization: `Bearer ${RIG_TOKEN}` },
    });
    assert.equal(refused.status, 403);
    assert.ok(store.listAudit(20).some((a) => a.action === "rig_retired"));

    assert.match(await post("/ui/rigs/rig-a/bring-back", {}), /rig-a is back/);
    assert.match(await page("/ui"), /rig-a stopped reporting/);
    const back = await api.request("/v1/rigs/rig-a/commands/pending", {
      headers: { authorization: `Bearer ${RIG_TOKEN}` },
    });
    assert.equal(back.status, 200);

    // The REST API: any rig, with a note for one from the file.
    const r = await api.request("/v1/rigs/rig-a/retire", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.deepEqual(await r.json(), {
      rig: "rig-a",
      retired: true,
      note: "its token is in control's rig tokens file: remove it there too",
    });
    const missing = await api.request("/v1/rigs/nope/retire", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(missing.status, 404);
  });
});
