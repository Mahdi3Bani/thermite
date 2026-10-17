import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { createControlApi } from "../control/api.ts";
import { ControlStore, fingerprint } from "../control/store.ts";
import { generateSigningKeys } from "../core/commands.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "thermite.ts");

describe("thermite rig", () => {
  test("add enrolls a rig and writes its files; token replaces its token; retire shuts it out", async () => {
    const keys = generateSigningKeys();
    const store = new ControlStore(":memory:");
    const api = createControlApi(
      store,
      { admin: "owner-token-abcdef", rigs: {} },
      keys.privateKeyPem,
    );
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-rig-"));
      const ownerFile = join(dir, "owner-token");
      writeFileSync(ownerFile, "owner-token-abcdef\n", { mode: 0o600 });
      const cli = (...args: string[]) =>
        run(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args]);
      const out = join(dir, "rig-gpu-1");
      const added = await cli(
        "rig",
        "add",
        "gpu-1",
        "--control",
        control,
        "--token-file",
        ownerFile,
        "--out",
        out,
      );
      assert.match(added.stdout, new RegExp(`fingerprint ${fingerprint(keys.publicKeyPem)}`));
      const token = readFileSync(join(out, "secrets/control-rig-token"), "utf8").trim();
      // The token is only in its file, never printed.
      assert.ok(!added.stdout.includes(token));
      assert.equal(statSync(join(out, "secrets/control-rig-token")).mode & 0o777, 0o600);
      assert.equal(statSync(join(out, "secrets/harness-supervisor-token")).mode & 0o777, 0o600);
      assert.equal(
        readFileSync(join(out, "keys/control-signing.pub"), "utf8").trim(),
        keys.publicKeyPem.trim(),
      );
      assert.match(
        readFileSync(join(out, "rig.env"), "utf8"),
        /^THERMITE_RIG_ID=gpu-1\nCONTROL_URL=http/,
      );
      assert.ok(store.rigTokenMatches("gpu-1", token));
      // A second add into the same directory is refused before control is asked.
      await assert.rejects(
        cli("rig", "add", "gpu-2", "--control", control, "--token-file", ownerFile, "--out", out),
        /not empty/,
      );
      assert.equal(store.enrolledRig("gpu-2"), undefined);
      const newFile = join(dir, "gpu-1.token");
      await cli(
        "rig",
        "token",
        "gpu-1",
        "--control",
        control,
        "--token-file",
        ownerFile,
        "--out",
        newFile,
      );
      const rotated = readFileSync(newFile, "utf8").trim();
      assert.ok(!store.rigTokenMatches("gpu-1", token));
      assert.ok(store.rigTokenMatches("gpu-1", rotated));
      await cli("rig", "retire", "gpu-1", "--control", control, "--token-file", ownerFile);
      assert.ok(!store.rigTokenMatches("gpu-1", rotated));
    } finally {
      server.close();
    }
  });
});
