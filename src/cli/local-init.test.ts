import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { chooseOwner, LOCAL_TOKEN_FILES, localInit } from "./local-init.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "thermite.ts");
const DEV_INIT = join(import.meta.dirname, "..", "..", "scripts", "dev-init.mjs");

/** Every path under `root`, relative, with its type and permission bits. */
function tree(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    const s = statSync(join(root, path));
    out.push(`${s.isDirectory() ? "d" : "f"} ${(s.mode & 0o777).toString(8)} ${path}`);
    if (s.isDirectory()) out.push(...tree(root, path));
  }
  return out;
}

const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-local-")), ".dev");
const secret = (root: string, name: string) =>
  readFileSync(join(root, "secrets", name), "utf8").trim();

describe("thermite local init", () => {
  test("makes every token, folder and the rig tokens map", () => {
    const root = fresh();
    const { made, kept } = localInit(root);
    assert.deepEqual(kept, []);
    assert.ok(made.includes("secrets/control-admin-token"));
    const tokens = LOCAL_TOKEN_FILES.map((name) => secret(root, name));
    for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(new Set(tokens).size, tokens.length, "every token is its own");
    assert.equal(secret(root, "model-api-key"), "local-placeholder");
    assert.deepEqual(JSON.parse(secret(root, "control-rig-tokens.json")), {
      "local-1": secret(root, "control-rig-token"),
      "local-2": secret(root, "control-rig-token-2"),
    });
    const fileMode = 0o644 & ~process.umask();
    assert.equal(statSync(join(root, "secrets/control-admin-token")).mode & 0o777, fileMode);
    // The supervisor fetches into the inbox as another user.
    for (const dir of ["inbox", "inbox/repos", "inbox/models"])
      assert.equal(statSync(join(root, dir)).mode & 0o777, 0o777, dir);
    for (const dir of ["outbox", "advisors"]) assert.ok(statSync(join(root, dir)).isDirectory());
  });

  test("keeps every file that exists and writes the rig tokens map again", () => {
    const root = fresh();
    localInit(root);
    const admin = secret(root, "control-admin-token");
    writeFileSync(join(root, "secrets/control-rig-token"), "changed-by-hand\n");
    writeFileSync(join(root, "secrets/model-api-key"), "sk-real-key\n");
    const again = localInit(root);
    assert.deepEqual(again.made, []);
    assert.equal(again.kept.length, LOCAL_TOKEN_FILES.length + 1);
    assert.equal(secret(root, "control-admin-token"), admin);
    assert.equal(secret(root, "model-api-key"), "sk-real-key");
    assert.equal(JSON.parse(secret(root, "control-rig-tokens.json"))["local-1"], "changed-by-hand");
  });

  test("writes the model key's placeholder whatever other key files the folder has", () => {
    const root = fresh();
    mkdirSync(join(root, "secrets"), { recursive: true });
    // The file name Thermite's first deployment used: no longer read.
    writeFileSync(join(root, "secrets/qwen-api-key"), "sk-old-name");
    localInit(root);
    assert.equal(secret(root, "model-api-key"), "local-placeholder");
  });

  test("makes the same layout as npm run dev:init", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "thermite-devinit-"));
    await run(process.execPath, [DEV_INIT], { cwd: checkout });
    const root = fresh();
    localInit(root);
    assert.deepEqual(tree(root), tree(join(checkout, ".dev")));
  });

  test("chooses the folder's owner only when it runs as root for someone else", () => {
    const user = { uid: 1000, gid: 1000 };
    assert.deepEqual(chooseOwner(0, user), user);
    assert.equal(chooseOwner(0, { uid: 0, gid: 0 }), undefined);
    assert.equal(chooseOwner(1000, user), undefined);
    assert.equal(chooseOwner(undefined, user), undefined);
    assert.equal(chooseOwner(0, undefined), undefined);
  });

  test("gives what it makes, and only that, to the owner", (t) => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const other = process.getgroups?.().find((g) => g !== gid);
    if (uid === undefined || other === undefined) {
      t.skip("needs a second group of this user to give files to");
      return;
    }
    const root = fresh();
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets/control-admin-token"), "kept\n");
    // A new file takes its folder's group on some systems, so compare with what it had.
    const keptGid = statSync(join(root, "secrets/control-admin-token")).gid;
    assert.notEqual(keptGid, other);
    const { made } = localInit(root, { uid, gid: other });
    assert.equal(made.length, 14);
    for (const rel of made) assert.equal(statSync(join(root, rel)).gid, other, rel);
    assert.equal(statSync(join(root, "secrets/control-admin-token")).gid, keptGid);
  });

  test("the command prints what it made, never a token", async () => {
    const root = fresh();
    const cli = (...args: string[]) =>
      run(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args]);
    const first = await cli("local", "init", root);
    assert.match(first.stdout, /^made \.dev\nmade \.dev\/secrets\n/);
    assert.match(first.stdout, /made \.dev\/secrets\/control-admin-token\n/);
    assert.match(first.stdout, /local init: \.dev ready \(17 made, 0 kept\)\n$/);
    for (const name of LOCAL_TOKEN_FILES) assert.ok(!first.stdout.includes(secret(root, name)));
    const second = await cli("local", "init", root);
    assert.equal(second.stdout, "local init: .dev ready (0 made, 9 kept)\n");
    await assert.rejects(cli("local", "init"), (e: { code?: number }) => e.code === 2);
  });
});
