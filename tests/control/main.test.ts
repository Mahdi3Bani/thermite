import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { controlBusUrl } from "../../src/control/bus/index.ts";

/**
 * Control needs its message bus (goal 168, step 4): it keeps every rig's events in the bus's
 * events stream and derives its records from them there, so it does not start without one, and
 * says which setting to give.
 */

const WORDS =
  "control needs its message bus: set THERMITE_NATS_URL to its NATS server, such as nats://nats:4222. Control keeps every rig's events in the bus's EVENTS stream and derives its records from them there, whether a rig reports over the bus or over HTTP";

describe("control and its bus", () => {
  test("the bus's address is required, and a bad one is refused", () => {
    assert.equal(controlBusUrl({ THERMITE_NATS_URL: " nats://nats:4222 " }), "nats://nats:4222");
    for (const env of [{}, { THERMITE_NATS_URL: "" }, { THERMITE_NATS_URL: " " }])
      assert.throws(() => controlBusUrl(env), { message: WORDS });
    assert.throws(
      () => controlBusUrl({ THERMITE_NATS_URL: "http://nats:4222" }),
      /^Error: THERMITE_NATS_URL takes a nats:\/\/ address, such as nats:\/\/nats:4222, not "http:\/\/nats:4222"$/,
    );
  });

  test("control without THERMITE_NATS_URL does not start, and says why", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "thermite-control-")), "state");
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", THERMITE_CONTROL_DIR: dir };
    const r = spawnSync(process.execPath, ["src/control/main.ts"], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 1, r.stderr);
    const lines = `${r.stdout}${r.stderr}`
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { msg: string; error?: string });
    const fatal = lines.find((l) => l.msg === "fatal");
    assert.match(String(fatal?.error), new RegExp(`^Error: ${WORDS.replace(/[.()]/g, "\\$&")}`));
    assert.equal(existsSync(dir), false, "before it makes its state folder");
  });
});
