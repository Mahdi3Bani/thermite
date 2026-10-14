import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { diskUsage, listProcesses, runSupervised } from "./process.ts";
import { insideRoot, LocalRunner } from "./runner.ts";

const node = process.execPath;
const scratch = () => mkdtempSync(join(tmpdir(), "thermite-proc-"));

describe("supervised processes", () => {
  test("wall time is measured outside the child and output is captured", async () => {
    const r = await runSupervised({
      argv: [node, "-e", "setTimeout(() => console.log('done'), 200)"],
      cwd: scratch(),
      env: {},
      timeoutMs: 10_000,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.killedFor, null);
    assert.ok(r.wallMs >= 190, `wall ${r.wallMs}`);
    assert.match(r.stdout, /done/);
  });

  test("a run past its time limit is killed", async () => {
    const r = await runSupervised({
      argv: [node, "-e", "setInterval(() => {}, 1000)"],
      cwd: scratch(),
      env: {},
      timeoutMs: 300,
    });
    assert.equal(r.killedFor, "timeout");
    assert.ok(r.wallMs < 5000);
  });

  test("a run over its memory limit is killed", async () => {
    const r = await runSupervised({
      argv: [
        node,
        "-e",
        "const keep = []; setInterval(() => keep.push(Buffer.alloc(32 << 20, 1)), 20)",
      ],
      cwd: scratch(),
      env: {},
      timeoutMs: 20_000,
      rssLimitBytes: 200 << 20,
    });
    assert.equal(r.killedFor, "memory");
    assert.ok(r.peakRssBytes > 200 << 20);
  });

  test("a run that fills its directory is killed for disk", async () => {
    const dir = scratch();
    const r = await runSupervised({
      argv: [
        node,
        "-e",
        "const fs = require('fs'); const b = Buffer.alloc(1 << 20, 7); setInterval(() => fs.appendFileSync('fill.bin', b), 5)",
      ],
      cwd: dir,
      env: {},
      timeoutMs: 20_000,
      disk: { path: dir, limitBytes: 16 << 20 },
    });
    assert.equal(r.killedFor, "disk");
  });

  test("nothing a run started outlives it", async () => {
    const r = await runSupervised({
      argv: [
        node,
        "-e",
        "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref(); console.log(process.pid)",
      ],
      cwd: scratch(),
      env: {},
      timeoutMs: 10_000,
    });
    assert.equal(r.exitCode, 0);
    const pgid = Number(r.stdout.trim());
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(
      listProcesses().filter((p) => p.pgid === pgid),
      [],
    );
  });

  test("the disk walk is capped in depth and entries", () => {
    const root = scratch();
    let p = root;
    for (let i = 0; i < 40; i++) {
      p = join(p, "d");
      mkdirSync(p);
    }
    assert.equal(diskUsage(root, 1000, 16).truncated, true);
    assert.equal(diskUsage(root, 10, 128).truncated, true);
    assert.equal(diskUsage(root).truncated, false);
  });

  test("the local runner refuses paths outside scratch, including through symlinks", async () => {
    const root = scratch();
    mkdirSync(join(root, "ok"));
    symlinkSync("/etc", join(root, "escape"));
    const runner = new LocalRunner(root);
    assert.ok(insideRoot(root, join(root, "ok")));
    assert.throws(() => insideRoot(root, join(root, "escape")), /outside scratch/);
    await assert.rejects(
      runner.run({ role: "run", argv: ["true"], cwd: "/tmp", timeoutMs: 1000 }),
      /outside scratch/,
    );
    await assert.rejects(runner.remove(join(root, "escape")), /outside scratch/);
  });
});
