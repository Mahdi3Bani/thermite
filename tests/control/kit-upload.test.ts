import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { kitSummary, unpackKit } from "../../src/control/kits/upload.ts";

const smoke = resolve(import.meta.dirname, "..", "..", "kits", "smoke-cpu");

describe("a kit uploaded on the new-campaign page", () => {
  test("a .tar.gz or a .zip of a kit is unpacked and checked; its cases and scores are listed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-up-"));
    execFileSync("tar", ["-czf", join(dir, "kit.tar.gz"), "-C", smoke, "."]);
    const k = await unpackKit("kit.tar.gz", readFileSync(join(dir, "kit.tar.gz")));
    assert.match(k.id, /^[0-9a-f]{64}$/);
    assert.ok(k.files["kit.json"] && k.files["bench/build.sh"]);
    assert.deepEqual(kitSummary(k.kit), {
      name: "smoke-cpu",
      target: "cpu",
      cells: ["small", "large", "held"],
      metrics: { flops_per_s: { kind: "rate", about: "a rate (FLOP/s)" } },
      verifiers: [],
      // Its kit.json names no MCP server.
      mcp_servers: [],
    });
    // A zip with the kit inside one top folder works too.
    const wrapped = join(dir, "wrapped");
    mkdirSync(join(wrapped, "my-kit"), { recursive: true });
    execFileSync("cp", ["-R", `${smoke}/.`, join(wrapped, "my-kit")]);
    execFileSync("zip", ["-qr", join(dir, "kit.zip"), "my-kit"], { cwd: wrapped });
    const z = await unpackKit("kit.zip", readFileSync(join(dir, "kit.zip")));
    assert.equal(z.kit.name, "smoke-cpu");
  });

  test("no kit.json, a broken one, a link or another format is refused in words", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-up-"));
    const pack = (name: string, files: Record<string, string>, link?: string) => {
      const src = join(dir, `${name}-src`);
      mkdirSync(src, { recursive: true });
      for (const [p, body] of Object.entries(files)) writeFileSync(join(src, p), body);
      if (link) symlinkSync("/etc/passwd", join(src, link));
      execFileSync("tar", ["-czf", join(dir, `${name}.tgz`), "-C", src, "."]);
      return readFileSync(join(dir, `${name}.tgz`));
    };
    await assert.rejects(unpackKit("a.tgz", pack("none", { "README.md": "x" })), /no kit.json/);
    await assert.rejects(unpackKit("b.tgz", pack("bad", { "kit.json": "{" })), /not JSON/);
    await assert.rejects(
      unpackKit("c.tgz", pack("wrong", { "kit.json": '{"schema_version": 1}' })),
      /kit.json: /,
    );
    const ok = readFileSync(join(smoke, "kit.json"), "utf8");
    await assert.rejects(
      unpackKit("d.tgz", pack("link", { "kit.json": ok }, "secret")),
      /is a link/,
    );
    await assert.rejects(unpackKit("e.rar", Buffer.from("x")), /upload a \.tar\.gz/);
    await assert.rejects(
      unpackKit("f.tgz", Buffer.from("not an archive")),
      (err: Error) =>
        /^control could not unpack f\.tgz/.test(err.message) &&
        !err.message.includes("thermite-upload-"),
    );
  });

  test("what a Mac adds to an archive is left out: ._ files, __MACOSX and .DS_Store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-up-"));
    // As `tar` on a Mac packs `kit` when its files carry extended attributes: a `._kit` beside the
    // kit's one top folder, and a `._` file beside each file in it.
    const src = join(dir, "tar-src");
    mkdirSync(join(src, "kit"), { recursive: true });
    execFileSync("cp", ["-R", `${smoke}/.`, join(src, "kit")]);
    for (const p of ["._kit", "kit/._kit.json", "kit/bench/._build.sh", "kit/.DS_Store"])
      writeFileSync(join(src, p), "macOS metadata");
    // COPYFILE_DISABLE: the test makes its own ._ files, on a Mac and elsewhere alike.
    execFileSync("tar", ["-czf", join(dir, "kit.tar.gz"), "-C", src, "._kit", "kit"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const k = await unpackKit("kit.tar.gz", readFileSync(join(dir, "kit.tar.gz")));
    assert.equal(k.kit.name, "smoke-cpu");
    assert.ok(k.files["kit.json"] && k.files["bench/build.sh"]);
    assert.deepEqual(
      Object.keys(k.files).filter((p) => p.includes("._") || p.endsWith(".DS_Store")),
      [],
    );
    // As the Finder's zip packs it: a __MACOSX folder beside the kit's folder.
    const zipped = join(dir, "zip-src");
    mkdirSync(join(zipped, "__MACOSX", "kit"), { recursive: true });
    execFileSync("cp", ["-R", join(src, "kit"), join(zipped, "kit")]);
    writeFileSync(join(zipped, "__MACOSX", "kit", "._kit.json"), "macOS metadata");
    execFileSync("zip", ["-qr", join(dir, "kit.zip"), "kit", "__MACOSX"], { cwd: zipped });
    const z = await unpackKit("kit.zip", readFileSync(join(dir, "kit.zip")));
    assert.equal(z.kit.name, "smoke-cpu");
    assert.ok(!Object.keys(z.files).some((p) => p.startsWith("__MACOSX")));
  });
});
